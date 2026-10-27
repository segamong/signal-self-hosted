"""Compare the phone's documented core against current core; no profile changes."""
import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import threading

spec=importlib.util.spec_from_file_location('live',Path(__file__).with_name('check-live-advanced.py'))
live=importlib.util.module_from_spec(spec);spec.loader.exec_module(live)
password=next(line.removeprefix('Пароль: ') for line in (live.PRIVATE/'VPN-Сайт-Доступ.txt').read_text(encoding='utf-8-sig').splitlines() if line.startswith('Пароль: '))
live.csrf=live.api('login','POST',{'username':'admin','password':password})['csrf']
results=[]
try:
    row=next(p for p in live.api('profiles')['profiles'] if p['active'] and p['name']=='T2 · V2RayTun REALITY')
    profile=live.api('profiles/'+row['id'])['profile']
    with live.Server(('127.0.0.1',10898),live.TCPHandler) as bridge,tempfile.TemporaryDirectory(dir=live.PRIVATE,prefix='compat-qa-') as directory:
        thread=threading.Thread(target=bridge.serve_forever,daemon=True);thread.start()
        try:
            for version in ['26.6.27','26.9.9']:
                for fingerprint in ['chrome','firefox']:
                    live.XRAY=live.ROOT/'server-operations/vendor'/('xray-'+version)/'xray.exe'
                    trial=copy.deepcopy(profile);trial['clientConfig']['outbounds'][0]['streamSettings']['realitySettings']['fingerprint']=fingerprint
                    result={'core':version,'fingerprint':fingerprint}
                    try:live.xray_test(trial,directory);result['tcpAndUdp']=True
                    except RuntimeError as error:result.update(tcpAndUdp=False,reason=str(error))
                    results.append(result);print(json.dumps(result),flush=True)
        finally:bridge.shutdown();thread.join(timeout=2)
finally:
    live.api('logout','POST',{})
    (Path(__file__).parent/'verification-mobile-compat.json').write_text(json.dumps(results,indent=2),encoding='utf-8')
