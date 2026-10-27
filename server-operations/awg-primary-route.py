"""One narrowly scoped route for the local AWG UDP listener."""
import json
import subprocess
import sys

IP='/usr/sbin/ip'
TABLE='12377'
PRIORITY=12377
ROUTE=['-4','route','add','table',TABLE,'default','via','10.0.0.1','dev','ens3','src','177.3.212.182','onlink']
RULE=['-4','rule','add','priority',str(PRIORITY),'iif','lo','ipproto','udp','sport','443','lookup',TABLE]


def run(args,check=True):
    result=subprocess.run([IP,*args],capture_output=True,text=True,timeout=10)
    if check and result.returncode:raise RuntimeError('Cannot apply the scoped AWG route')
    return result


def inspect():
    rules=json.loads(run(['-4','-j','rule','show']).stdout)
    selected=[r for r in rules if r.get('priority')==PRIORITY]
    for rule in selected:
        if not (rule.get('iif')=='lo' and rule.get('ipproto')=='udp' and str(rule.get('sport'))=='443'
                and str(rule.get('table'))==TABLE):
            raise RuntimeError('The route priority is already used by another rule')
    result=run(['-4','-j','route','show','table',TABLE],False)
    routes=json.loads(result.stdout) if result.returncode==0 else []
    for route in routes:
        if not (route.get('dst')=='default' and route.get('gateway')=='10.0.0.1'
                and route.get('dev')=='ens3' and route.get('prefsrc')=='177.3.212.182'):
            raise RuntimeError('The route table is already used by another route')
    if len(selected)>1 or len(routes)>1:raise RuntimeError('Duplicate scoped routes require inspection')
    return bool(selected),bool(routes)


def main():
    rule_exists,route_exists=inspect()
    if sys.argv[1]=='apply':
        if not route_exists:run(ROUTE)
        if not rule_exists:run(RULE)
        result=run(['-4','route','get','1.1.1.1','ipproto','udp','sport','443'])
        if 'src 177.3.212.182' not in result.stdout:raise RuntimeError('AWG route did not select primary IP')
    elif sys.argv[1]=='remove':
        if rule_exists:run([*RULE[:2],'del',*RULE[3:]])
        if route_exists:run([*ROUTE[:2],'del',*ROUTE[3:]])
    else:raise RuntimeError('Unknown action')


if __name__=='__main__':main()
