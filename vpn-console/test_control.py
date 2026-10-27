import json
from contextlib import closing
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import subprocess
import base64
import sqlite3
from urllib.parse import urlsplit, parse_qs
import control

class ControlTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.config = self.root / 'server.json'
        self.original = {'inbounds':[{'listen':'127.0.0.1','port':39443,'protocol':'vless',
            'settings':{'clients':[{'id':'11111111-1111-4111-8111-111111111111','email':'signal-windows'}]},
            'streamSettings':{'network':'xhttp','xhttpSettings':{'path':'/'+'a'*48}}}],
            'outbounds':[{'sendThrough':'177.3.212.182'}]}
        for protocol, port, letter in [('trojan',39444,'b'),('vmess',39445,'c')]:
            self.original['inbounds'].append({'listen':'127.0.0.1','port':port,'protocol':protocol,
                'settings':{'clients':[]},'streamSettings':{'network':'xhttp','security':'none',
                'xhttpSettings':{'path':'/'+letter*48,'mode':'auto'}}})
        self.config.write_text(json.dumps(self.original))
        self.controller = control.Controller(self.config, self.root / 'state', self.save)
    def save(self, candidate):
        self.config.write_text(json.dumps(candidate))
    def tearDown(self):
        self.temp.cleanup()
    def test_profile_lifecycle_and_tls_enforcement(self):
        created = self.controller.run({'op':'create','name':'Телефон','device':'android'})['profile']
        self.assertIn('security=tls', created['uri'])
        stream = created['clientConfig']['outbounds'][0]['streamSettings']
        self.assertEqual(stream['tlsSettings']['minVersion'], '1.3')
        self.assertFalse(stream['tlsSettings']['allowInsecure'])
        self.assertEqual(created['configuration'], 'packet-up')
        self.assertEqual(created['fingerprint'], 'chrome')
        self.assertEqual(created['protocol'], 'vless')
        self.assertEqual(len(json.loads(self.config.read_text())['inbounds'][0]['settings']['clients']),2)
        self.controller.run({'op':'revoke','id':created['id']})
        self.assertEqual(json.loads(self.config.read_text()), self.original)
        with self.assertRaises(ValueError):
            self.controller.run({'op':'get','id':created['id']})
    def test_no_metadata_commit_if_apply_fails(self):
        def fail(candidate):
            raise RuntimeError('test failure')
        self.controller.apply = fail
        with self.assertRaises(RuntimeError):
            self.controller.run({'op':'create','name':'Never committed','device':'other'})
        self.assertEqual(len(self.controller.run({'op':'list'})['profiles']),1)
    def test_input_does_not_become_shell_or_path(self):
        for request in [{'op':'exec','command':'anything'}, {'op':'get','id':'../../etc/passwd'},
                        {'op':'create','name':'a\ncommand','device':'windows'},
                        {'op':'create','name':'x','device':'root'}]:
            with self.assertRaises(ValueError): self.controller.run(request)

    def test_migration_preserves_legacy_profiles_and_revocations(self):
        state = self.root / 'legacy'
        state.mkdir()
        with closing(sqlite3.connect(state / 'profiles.sqlite')) as db, db:
            db.execute('CREATE TABLE profiles(id TEXT PRIMARY KEY,name TEXT NOT NULL,device TEXT NOT NULL,client_id TEXT UNIQUE NOT NULL,created_at TEXT NOT NULL,revoked_at TEXT)')
            db.execute('INSERT INTO profiles VALUES(?,?,?,?,?,?)', ('22222222-2222-4222-8222-222222222222','Старый Windows','windows',self.original['inbounds'][0]['settings']['clients'][0]['id'],'2026-01-01',None))
            db.execute('INSERT INTO profiles VALUES(?,?,?,?,?,?)', ('33333333-3333-4333-8333-333333333333','Отключённый','android','44444444-4444-4444-8444-444444444444','2026-01-01','2026-02-01'))
        migrated = control.Controller(self.config, state, self.save)
        rows = migrated.run({'op':'list'})['profiles']
        self.assertEqual(len(rows), 2)
        self.assertEqual({row['name'] for row in rows}, {'Старый Windows','Отключённый'})
        self.assertEqual({row['configuration'] for row in rows}, {'packet-up'})
        self.assertEqual({row['fingerprint'] for row in rows}, {'chrome'})
        self.assertEqual({row['protocol'] for row in rows}, {'vless'})
        self.assertFalse(next(row for row in rows if row['name']=='Отключённый')['active'])
        # Repeating startup is idempotent and must not re-import existing clients.
        control.Controller(self.config, state, self.save)
        self.assertEqual(len(migrated.run({'op':'list'})['profiles']), 2)

    def test_modes_fingerprints_are_exported_with_tls_enforced(self):
        for mode in ('auto','packet-up','stream-up'):
            profile = self.controller.run({'op':'create','name':mode,'device':'windows','configuration':mode,'fingerprint':'firefox'})['profile']
            stream = profile['clientConfig']['outbounds'][0]['streamSettings']
            query = parse_qs(urlsplit(profile['uri']).query)
            self.assertEqual(stream['xhttpSettings']['mode'], mode)
            self.assertEqual(stream['tlsSettings']['fingerprint'], 'firefox')
            self.assertEqual(stream['tlsSettings']['minVersion'], '1.3')
            self.assertEqual(query['mode'], [mode])
            self.assertEqual(query['fp'], ['firefox'])
            self.assertEqual(query['security'], ['tls'])
            self.assertEqual(self.controller.run({'op':'get','id':profile['id']})['profile'],profile)
        for field, value in [('configuration','none'),('configuration',[]),('fingerprint','random'),('fingerprint',{})]:
            with self.assertRaises(ValueError):
                self.controller.run({'op':'create','name':'invalid','device':'other',field:value})

    def test_pool_membership_rotation_and_link_revocation(self):
        first = self.controller.run({'op':'create','name':'Первый','device':'android','configuration':'auto'})['profile']
        second = self.controller.run({'op':'create','name':'Второй','device':'windows','configuration':'stream-up','fingerprint':'firefox'})['profile']
        pool = self.controller.run({'op':'pool-create','name':'Два режима','profileIds':[second['id'],first['id']]})['pool']
        token = pool['subscriptionUrl'].rsplit('/',1)[1]
        before = self.config.read_bytes()
        subscription = self.controller.run({'op':'subscription','token':token})['subscription']
        self.assertEqual(base64.b64decode(subscription).decode().splitlines(),[second['uri'],first['uri']])
        self.assertEqual(pool['activeProfilesCount'],2)
        self.assertEqual(self.controller.run({'op':'pool-get','id':pool['id']})['pool'],pool)
        self.assertEqual(self.controller.run({'op':'pool-list'})['pools'],[pool])
        rotated = self.controller.run({'op':'pool-rotate','id':pool['id']})['pool']
        new_token = rotated['subscriptionUrl'].rsplit('/',1)[1]
        self.assertNotEqual(token,new_token)
        self.assertIsNone(self.controller.run({'op':'subscription','token':token})['subscription'])
        self.assertEqual(self.controller.run({'op':'subscription','token':new_token})['subscription'],subscription)
        self.controller.run({'op':'pool-revoke','id':pool['id']})
        self.assertIsNone(self.controller.run({'op':'subscription','token':new_token})['subscription'])
        revoked = self.controller.run({'op':'pool-get','id':pool['id']})['pool']
        self.assertFalse(revoked['active'])
        self.assertIsNone(revoked['subscriptionUrl'])
        self.assertEqual(self.config.read_bytes(), before)
        self.assertTrue(self.controller.run({'op':'get','id':first['id']})['profile']['active'])
        with self.assertRaises(ValueError): self.controller.run({'op':'pool-rotate','id':pool['id']})

    def test_subscription_filters_revoked_members_and_pool_validations(self):
        profile = self.controller.run({'op':'create','name':'В пуле','device':'other'})['profile']
        for ids in ([],[profile['id'],profile['id']],['../../etc/passwd'],[{}],['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa']):
            with self.assertRaises(ValueError): self.controller.run({'op':'pool-create','name':'Пул','profileIds':ids})
        pool = self.controller.run({'op':'pool-create','name':'Пул','profileIds':[profile['id']]})['pool']
        token = pool['subscriptionUrl'].rsplit('/',1)[1]
        self.controller.run({'op':'revoke','id':profile['id']})
        self.assertIsNone(self.controller.run({'op':'subscription','token':token})['subscription'])
        self.assertIsNone(self.controller.run({'op':'subscription','token':'invalid'})['subscription'])
        self.assertEqual(self.controller.run({'op':'pool-get','id':pool['id']})['pool']['activeProfilesCount'],0)
        with self.assertRaises(ValueError): self.controller.run({'op':'pool-create','name':'Пул','profileIds':[profile['id']]})

    def test_distinct_protocols_mixed_pool_and_scoped_revocation(self):
        profiles = []
        for protocol in ('vless','trojan','vmess'):
            profile = self.controller.run({'op':'create','name':protocol,'device':'windows','protocol':protocol,
                'configuration':'stream-up','fingerprint':'firefox'})['profile']
            profiles.append(profile)
            self.assertEqual(profile['protocol'], protocol)
            uri = urlsplit(profile['uri'])
            self.assertEqual(uri.scheme, protocol)
            self.assertEqual(parse_qs(uri.query)['mode'], ['stream-up'])
            self.assertEqual(parse_qs(uri.query)['security'], ['tls'])
            outbound = profile['clientConfig']['outbounds'][0]
            self.assertEqual(outbound['protocol'], protocol)
            self.assertEqual(outbound['streamSettings']['tlsSettings']['minVersion'], '1.3')
            self.assertFalse(outbound['streamSettings']['tlsSettings']['allowInsecure'])
            inbound = next(item for item in json.loads(self.config.read_text())['inbounds'] if item['protocol']==protocol)
            field = 'password' if protocol == 'trojan' else 'id'
            self.assertIn(uri.username, [client[field] for client in inbound['settings']['clients']])
            if protocol == 'trojan':
                self.assertEqual(len(uri.username),43)
                self.assertEqual(outbound['settings']['servers'][0]['password'],uri.username)
            if protocol == 'vmess':
                self.assertEqual(outbound['settings']['vnext'][0]['users'][0]['security'],'auto')
        pool = self.controller.run({'op':'pool-create','name':'Смешанный','profileIds':[profile['id'] for profile in profiles]})['pool']
        token = pool['subscriptionUrl'].rsplit('/',1)[1]
        self.assertEqual(base64.b64decode(self.controller.run({'op':'subscription','token':token})['subscription']).decode().splitlines(),[profile['uri'] for profile in profiles])
        self.controller.run({'op':'revoke','id':profiles[1]['id']})
        listed = self.controller.run({'op':'list'})['profiles']
        self.assertEqual(sum(profile['active'] for profile in listed),3)
        self.assertFalse(next(profile for profile in listed if profile['id']==profiles[1]['id'])['active'])
        self.assertEqual(base64.b64decode(self.controller.run({'op':'subscription','token':token})['subscription']).decode().splitlines(),[profiles[0]['uri'],profiles[2]['uri']])
        for profile in (profiles[0],profiles[2]):
            self.controller.run({'op':'revoke','id':profile['id']})
        self.assertEqual(json.loads(self.config.read_text()),self.original)

    def test_unknown_protocol_cannot_create_or_change_config(self):
        for protocol in ('socks','',[],None):
            with self.assertRaises(ValueError):
                self.controller.run({'op':'create','name':'Bad','device':'windows','protocol':protocol})
        self.assertEqual(json.loads(self.config.read_text()),self.original)
        self.assertEqual(len(self.controller.run({'op':'list'})['profiles']),1)

    def test_reality_profile_is_direct_vision_not_xhttp(self):
        candidate=json.loads(self.config.read_text())
        candidate['inbounds'].append({'listen':'127.0.0.1','port':39446,'protocol':'vless',
            'settings':{'clients':[]},'streamSettings':{'network':'tcp','security':'reality'}})
        self.config.write_text(json.dumps(candidate))
        metadata=self.root/'reality.json'
        metadata.write_text(json.dumps({'publicKey':'A'*43,'shortId':'abcd1234','serverName':'www.microsoft.com'}))
        with patch.object(control.advanced,'REALITY',metadata):
            profile=self.controller.run({'op':'create','name':'Мобильный','device':'android','protocol':'vless-reality'})['profile']
            query=parse_qs(urlsplit(profile['uri']).query)
            self.assertEqual(query['security'],['reality'])
            self.assertEqual(query['flow'],['xtls-rprx-vision'])
            self.assertEqual(urlsplit(profile['uri']).hostname,'177.3.212.182')
            self.assertNotIn('xhttp',profile['uri'])
            stream=profile['clientConfig']['outbounds'][0]['streamSettings']
            self.assertEqual(stream['security'],'reality')
            self.assertEqual(stream['sockopt']['tcpKeepAliveIdle'],30)
            self.controller.run({'op':'revoke','id':profile['id']})
        self.assertEqual(self.controller.run({'op':'list'})['profiles'][-1]['protocol'],'vless')

    def test_awg31_native_export_and_mixed_bundle_scope(self):
        metadata=self.root/'awg.json'
        metadata.write_text(json.dumps({'publicKey':base64.b64encode(b's'*32).decode(),
            'obfuscation':{'S1':128,'S2':64,'S3':16,'S4':16,'HeaderProtectionKey':base64.b64encode(b'h'*32).decode()}}))
        active=set()
        def restore(extra):active.add(('amneziawg',extra['publicKey']))
        def remove(extra):active.discard(('amneziawg',extra['publicKey']))
        keys=[base64.b64encode(letter*32).decode() for letter in (b'a',b'b',b'c')]
        with patch.object(control.advanced,'META',metadata),patch.object(control.advanced,'available',return_value=True),\
             patch.object(control.advanced,'awg_active',side_effect=lambda:active.copy()),\
             patch.object(control.advanced,'restore_awg',side_effect=restore),patch.object(control.advanced,'remove_awg',side_effect=remove),\
             patch.object(control.advanced,'tool',side_effect=keys):
            profile=self.controller.run({'op':'create','name':'AWG','device':'android','protocol':'amneziawg'})['profile']
            self.assertIsNone(profile['uri'])
            self.assertIn('HeaderProtectionKey =',profile['configText'])
            self.assertIn('MTU = 1280',profile['configText'])
            self.assertIn('PersistentKeepalive = 25',profile['configText'])
            original=self.controller.run({'op':'list'})['profiles'][-1]
            pool=self.controller.run({'op':'pool-create','name':'Разные форматы','profileIds':[original['id'],profile['id']]})['pool']
            self.assertTrue(pool['hasNativeProfiles'])
            self.assertIn('/manage/pool/',pool['qrUrl'])
            token=pool['qrUrl'].rsplit('/',1)[1]
            subscription=base64.b64decode(self.controller.run({'op':'subscription','token':token})['subscription']).decode()
            self.assertNotIn('PrivateKey',subscription)
            self.assertNotIn(keys[0],json.dumps(self.controller.run({'op':'bundle','token':token})))
            self.assertIsNone(self.controller.run({'op':'bundle-profile','token':token,'id':'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'})['bundle-profile'])
            self.assertEqual(self.controller.run({'op':'bundle-profile','token':token,'id':profile['id']})['bundle-profile']['configText'],profile['configText'])
            self.controller.run({'op':'revoke','id':profile['id']})
            self.assertFalse(active)
            self.assertIsNone(self.controller.run({'op':'bundle-profile','token':token,'id':profile['id']})['bundle-profile'])

    def test_duplicate_credential_across_protocols_is_not_silently_imported(self):
        candidate = json.loads(self.config.read_text())
        candidate['inbounds'][1]['settings']['clients'] = [{'password':candidate['inbounds'][0]['settings']['clients'][0]['id']}]
        self.config.write_text(json.dumps(candidate))
        with self.assertRaises(RuntimeError):
            control.Controller(self.config,self.root/'state',self.save)

    def test_revoked_history_keeps_helper_response_bounded(self):
        import uuid
        with self.controller.connection() as db:
            for index in range(400):
                db.execute('INSERT INTO profiles(id,name,device,client_id,created_at,revoked_at) VALUES(?,?,?,?,?,?)',
                    (str(uuid.uuid4()),'😀'*48,'other',str(uuid.uuid4()),str(index).zfill(8),'revoked'))
        listed = self.controller.run({'op':'list'})
        self.assertEqual(len(listed['profiles']),101)
        self.assertEqual(sum(profile['active'] for profile in listed['profiles']),1)
        self.assertLess(len(json.dumps(listed,ensure_ascii=False).encode()),128*1024)

    def test_pool_limit_is_bounded_and_revoked_link_frees_capacity(self):
        profile = self.controller.run({'op':'list'})['profiles'][0]
        pools = [self.controller.run({'op':'pool-create','name':str(number),'profileIds':[profile['id']]})['pool'] for number in range(20)]
        with self.assertRaises(ValueError): self.controller.run({'op':'pool-create','name':'21','profileIds':[profile['id']]})
        self.controller.run({'op':'pool-revoke','id':pools[0]['id']})
        self.assertTrue(self.controller.run({'op':'pool-create','name':'21','profileIds':[profile['id']]})['pool']['active'])

if __name__ == '__main__':
    unittest.main()
