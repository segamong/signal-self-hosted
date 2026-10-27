"""Fixed host routing for one isolated AWG interface; existing rules are preserved."""
import json
import re
import socket
from pathlib import Path
import sqlite3
import subprocess
import sys
import time

INTERFACE='awg-signal'
PRIVATE=['0.0.0.0/8','10.0.0.0/8','100.64.0.0/10','127.0.0.0/8','169.254.0.0/16',
         '172.16.0.0/12','192.168.0.0/16','224.0.0.0/4','240.0.0.0/4']


def command(args,check=True):
    result=subprocess.run(args,capture_output=True,timeout=15)
    if check and result.returncode:
        diagnostic=re.sub(r'[A-Za-z0-9+/]{40,}={0,2}','<key-redacted>',result.stderr.decode(errors='replace'))
        print(diagnostic,flush=True)
        raise RuntimeError('Fixed AWG setup command failed')
    return result


def rules():
    result=[]
    for target in PRIVATE:
        result += [('/usr/sbin/iptables','filter',['FORWARD','-i',INTERFACE,'-d',target,'-j','REJECT']),
                   ('/usr/sbin/iptables','filter',['INPUT','-i',INTERFACE,'-d',target,'-j','REJECT'])]
    result += [('/usr/sbin/iptables','filter',['FORWARD','-i',INTERFACE,'-o','ens3','-j','ACCEPT']),
        ('/usr/sbin/iptables','filter',['FORWARD','-o',INTERFACE,'-m','conntrack','--ctstate','ESTABLISHED,RELATED','-j','ACCEPT']),
        ('/usr/sbin/iptables','nat',['POSTROUTING','-s','10.89.0.0/24','-o','ens3','-j','SNAT','--to-source','177.3.212.182']),
        # The host's preferred source is its secondary IP. Pin only the new
        # AWG listener's UDP replies to the same primary IP used by clients.
        ('/usr/sbin/iptables','nat',['POSTROUTING','-o','ens3','-p','udp','--sport','443','!','-s','177.3.212.182','-j','SNAT','--to-source','177.3.212.182']),
        ('/usr/sbin/iptables','filter',['INPUT','!','-i','lo','-p','udp','--dport','443','!','-d','177.3.212.182','-j','DROP']),
        ('/usr/sbin/ip6tables','filter',['FORWARD','-i',INTERFACE,'-j','REJECT','--reject-with','icmp6-adm-prohibited']),
        ('/usr/sbin/ip6tables','filter',['INPUT','-i',INTERFACE,'-d','fc00::/7','-j','REJECT']),
        ('/usr/sbin/ip6tables','filter',['INPUT','!','-i','lo','-p','udp','--dport','443','-j','DROP'])]
    return result


def apply_rules(remove=False):
    # Insert accepts first, then private-address denials above them.
    sequence=rules() if remove else list(reversed(rules()))
    for binary,table,rule in sequence:
        tagged=[*rule,'-m','comment','--comment','signal-awg-private-network']
        exists=command([binary,'-w','10','-t',table,'-C',*tagged],False).returncode==0
        if remove and exists:
            command([binary,'-w','10','-t',table,'-D',*tagged])
        elif not remove and not exists:
            command([binary,'-w','10','-t',table,'-I',tagged[0],'1',*tagged[1:]])


if sys.argv[1]=='stop':
    apply_rules(True)
else:
    socket_file=Path('/var/run/amneziawg/awg-signal.sock')
    for attempt in range(50):
        try:
            with socket.socket(socket.AF_UNIX,socket.SOCK_STREAM) as ready:
                ready.settimeout(.3)
                ready.connect(str(socket_file))
                ready.sendall(b'get=1\n\n')
                if b'errno=0' in ready.recv(65536):
                    break
        except OSError:
            pass
        time.sleep(.1)
    else:
        raise RuntimeError('AWG control socket not ready')
    if socket_file.stat().st_mode & 0o077 or socket_file.stat().st_uid != 0:
        raise RuntimeError('AWG control socket is not private')
    command(['/opt/signal-awg/awg','setconf',INTERFACE,'/etc/signal-awg/server.conf'])
    command(['/usr/sbin/ip','address','replace','10.89.0.1/24','dev',INTERFACE])
    command(['/usr/sbin/ip','-6','address','replace','fd89:7369:676e::1/64','dev',INTERFACE])
    command(['/usr/sbin/ip','link','set','dev',INTERFACE,'mtu','1280','up'])
    apply_rules()
    database=Path('/var/lib/signal-vpn-control/profiles.sqlite')
    if database.exists():
        import importlib.util
        module=importlib.util.spec_from_file_location('advanced','/opt/signal-vpn-web/advanced.py')
        if module and module.loader and Path(module.origin).is_file():
            api=importlib.util.module_from_spec(module)
            module.loader.exec_module(api)
            with sqlite3.connect(database) as db:
                columns={row[1] for row in db.execute('PRAGMA table_info(profiles)')}
                if 'extra' in columns:
                    for extra, in db.execute("SELECT extra FROM profiles WHERE protocol='amneziawg' AND revoked_at IS NULL"):
                        api.restore_awg(json.loads(extra))
