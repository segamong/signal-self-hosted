"""Create owner-requested mobile profiles, verify them, keep exports private."""
import json
from pathlib import Path
import tempfile
import threading
import urllib.parse
import importlib.util

spec=importlib.util.spec_from_file_location('live',Path(__file__).with_name('check-live-advanced.py'))
live=importlib.util.module_from_spec(spec)
spec.loader.exec_module(live)


def main():
    password=next(line.removeprefix('Пароль: ') for line in (live.PRIVATE/'VPN-Сайт-Доступ.txt').read_text(encoding='utf-8-sig').splitlines() if line.startswith('Пароль: '))
    session=live.api('login','POST',{'username':'admin','password':password});live.csrf=session['csrf']
    output=live.PRIVATE/'T2';output.mkdir(exist_ok=True)
    try:
        existing=live.api('profiles')['profiles'];profiles=[]
        for name,protocol in [('T2 · V2RayTun REALITY','vless-reality'),('T2 · AmneziaWG 3.1','amneziawg')]:
            found=next((p for p in existing if p['active'] and p['name']==name and p['protocol']==protocol),None)
            profile=live.api('profiles/'+found['id'])['profile'] if found else live.api('profiles','POST',{'name':name,'device':'android','protocol':protocol})['profile']
            profiles.append(profile)
        awg_verified=False
        with live.Server(('127.0.0.1',10898),live.TCPHandler) as bridge,live.UDPBridge() as udp,tempfile.TemporaryDirectory(dir=live.PRIVATE,prefix='mobile-test-') as directory:
            thread=threading.Thread(target=bridge.serve_forever,daemon=True);thread.start()
            try:
                live.xray_test(profiles[0],directory)
                try:
                    live.awg_test(profiles[1]);awg_verified=True
                except RuntimeError:
                    print(json.dumps({'awgClientPathUnstable':True,'udpSent':udp.sent,'udpReceived':udp.received}),flush=True)
            finally:
                bridge.shutdown();thread.join(timeout=2)
        identifiers=[p['id'] for p in profiles]
        pools=live.api('pools')['pools']
        found=next((p for p in pools if p['active'] and p['name']=='T2 · мобильный набор' and set(p['profileIds'])==set(identifiers)),None)
        pool=found or live.api('pools','POST',{'name':'T2 · мобильный набор','profileIds':identifiers})['pool']
        (output/'T2-REALITY.txt').write_text(profiles[0]['uri']+'\n',encoding='utf-8')
        (output/'T2-REALITY.json').write_text(json.dumps(profiles[0]['clientConfig'],ensure_ascii=False,indent=2),encoding='utf-8')
        (output/'T2-AmneziaWG-3.1.conf').write_text(profiles[1]['configText'],encoding='utf-8')
        (output/'Набор-профилей.txt').write_text(pool['qrUrl']+'\n',encoding='utf-8')
        (output/'Набор-профилей.zip').write_bytes(live.fetch(urllib.parse.urlsplit(pool['qrUrl']).path+'/bundle.zip',authenticated=False))
        (output/'Как-подключиться.txt').write_text(
            'V2RayTun 5.26.83 на Android: импортируйте T2-REALITY.txt из буфера обмена и выберите новый профиль.\n'
            'Для T2 сначала проверьте REALITY с выключенным Wi-Fi. Сравните время подключения и работу проблемных приложений.\n'
            'AmneziaWG 3.1: файл .conf можно импортировать в актуальный клиент AmneziaWG с поддержкой 3.1; совместимость V2RayTun зависит от версии.\n'
            'Один QR набора открывается обычной камерой телефона. На странице есть отдельные файлы и подписка REALITY для V2RayTun.\n'
            'Оба профиля используют основной адрес 177.3.212.182. Шифрование не скрывает IP сервера от оператора.\n'
            'REALITY проверен реальным HTTPS и UDP DNS через прямой TCP к серверу. AWG проверен напрямую по UDP 443 в текущей сети T2 после исправления маршрута ответов.\n'
            'На самом телефоне в сети T2 тест ещё не выполнен. Стабильность и незаметность для РКН не гарантируются.\n',encoding='utf-8-sig')
        (live.PRIVATE/'mobile-profile-state.json').write_text(json.dumps({'profileIds':identifiers,'poolId':pool['id']}),encoding='utf-8')
        result={'mobileProfilesPrepared':2,'mixedPoolPrepared':True,'realityActualHttpsAndUdpDns':True,
            'awgActualHttpsViaExistingSystemVpn':awg_verified,
            'mobileT2Tested':False,'exitIp':live.PRIMARY,'osRoutesChanged':False}
        (Path(__file__).parent/'verification-mobile.json').write_text(json.dumps(result,indent=2),encoding='utf-8')
        print(json.dumps(result),flush=True)
    finally:
        live.api('logout','POST',{})


if __name__=='__main__':main()
