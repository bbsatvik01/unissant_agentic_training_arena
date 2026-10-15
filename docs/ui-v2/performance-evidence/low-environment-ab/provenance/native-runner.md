# Archived diagnostic source

This is the verbatim source used for the isolated experiment, archived for review. It is not a portable project entry point. Original UTF-8 source SHA-256: `d3f507bc1aa153c40e03ad0ba2d65b39ae980b359fc6dd3ea695efc8360f254a`.

```python
"""Owned native production render diagnostic; no installation, external service or user profile."""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import uuid

HERE=Path(__file__).resolve().parent
NODE=Path('/workspace/shared/unissant_agentic_training_arena/web/node_modules/node/bin/node')
ORIGIN='http://127.0.0.1:4187'
MAX_LOG=4*1024*1024

def sha(path): return hashlib.sha256(path.read_bytes()).hexdigest()
def checked_list(root, inventory):
    for line in inventory.read_text().splitlines():
        digest,rel=line.split('  ',1)
        path=(root/rel).resolve()
        if not path.is_relative_to(root) or sha(path)!=digest:
            raise RuntimeError('Source/build integrity failure: '+rel)

def cpu_sample(roots):
    rows={}
    for entry in Path('/proc').iterdir():
        if not entry.name.isdigit(): continue
        try:
            raw=(entry/'stat').read_text(); end=raw.rfind(')'); fields=raw[end+2:].split()
            rows[int(entry.name)]={'pid':int(entry.name),'name':raw[raw.find('(')+1:end],
                'ppid':int(fields[1]),'session':int(fields[3]),'state':fields[0],
                'ticks':int(fields[11])+int(fields[12]),'startTicks':int(fields[19]),
                'rssBytes':int(fields[21])*os.sysconf('SC_PAGE_SIZE')}
        except (FileNotFoundError,ProcessLookupError,PermissionError,ValueError,IndexError): continue
    owned=set(roots)
    while True:
        next_owned=owned|{pid for pid,row in rows.items() if row['ppid'] in owned or row['session'] in roots}
        if next_owned==owned:break
        owned=next_owned
    out={'monotonic':time.monotonic(),'ownedProcesses':[rows[p] for p in sorted(owned) if p in rows]}
    for key,path in [('cpu','/proc/stat'),('load','/proc/loadavg'),('cpuQuota','/sys/fs/cgroup/cpu.max'),('cgroupCpu','/sys/fs/cgroup/cpu.stat')]:
        try:out[key]=Path(path).read_text().splitlines()[:1 if key in ('cpu','load') else 10]
        except (FileNotFoundError,PermissionError):out[key]=None
    return out

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--approved-native-run',action='store_true',required=True)
    parser.add_argument('--sample',choices=['retain-1','omit-1','omit-2','retain-2'],required=True)
    args=parser.parse_args()
    if sha(HERE/'reviewed-build.json')!='b7f7dcf810626204fbe1063cf5aa63dc9e754eda1e1a99a1134cf3685f103a1d':raise RuntimeError('Reviewed config changed')
    config=json.loads((HERE/'reviewed-build.json').read_text())
    qa=Path(config['qa']).resolve()
    if not str(qa).startswith('/workspace/shared/precinct-low-environment-validation-qa/'):
        raise RuntimeError('Unexpected isolated attempt root')
    expected=config['packageManifestSha256']
    if (qa/'gate-passed.package-sha256').read_text().strip()!=expected:
        raise RuntimeError('Exact focused gate is absent')
    for rel,key in [('candidate-sources.sha256','sourceInventorySha256'),('production-build.sha256','buildInventorySha256'),('test-inputs.sha256','testInputInventorySha256'),('build-inputs.sha256','buildInputInventorySha256')]:
        if sha(qa/rel)!=config[key]:raise RuntimeError('Reviewed inventory changed: '+rel)
        checked_list(qa,qa/rel)
    if subprocess.check_output([str(NODE),'--version'],text=True,timeout=10).strip()!='v24.21.0':
        raise RuntimeError('Pinned Node mismatch')
    attempt=qa/'native-results'/(args.sample+'-'+datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')+'-'+uuid.uuid4().hex[:6])
    attempt.mkdir(parents=True,exist_ok=False)
    report={'status':'running','sample':args.sample,'reviewedBuild':config,'namespace':'own cloud native Terminal',
        'runtime':str(NODE),'browserExecutable':'/usr/bin/chromium','readyLimitSeconds':45,'runnerLimitSeconds':480,
        'runnerExit':None,'previewExit':None,'errors':[],'cleanupErrors':[],'hostSamples':[],
        'hostSampleCaveat':'Owned process timing and system CPU counters only; no arguments/environment. One sample per second, outside browser JS. Foreign GUI browser attribution is not established.'}
    children=[];streams=[];native_tmp=None;started=time.monotonic();last_sample=0
    opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
    def interrupt(_sig,_frame):raise KeyboardInterrupt('Owned benchmark interrupted')
    original={s:signal.signal(s,interrupt) for s in (signal.SIGINT,signal.SIGTERM)}
    def update():
        nonlocal last_sample
        for name,_child in children:
            path=attempt/(name+'.log')
            if path.exists() and path.stat().st_size>MAX_LOG:raise RuntimeError('Bounded log exceeded: '+name)
        if time.monotonic()-last_sample>=1 and len(report['hostSamples'])<600:
            report['hostSamples'].append(cpu_sample([c.pid for _,c in children]));last_sample=time.monotonic()
    def launch(argv,env,name):
        stream=(attempt/(name+'.log')).open('wb');streams.append(stream)
        child=subprocess.Popen(argv,cwd=qa/'web',env=env,stdin=subprocess.DEVNULL,stdout=stream,stderr=subprocess.STDOUT,start_new_session=True)
        children.append((name,child));report[name+'Pid']=child.pid;report[name+'Argv']=argv
        return child
    try:
        native_tmp=tempfile.TemporaryDirectory(prefix='arena-perf-',dir='/tmp')
        for name in ('home','cache','config'):(attempt/name).mkdir()
        env={'PATH':'/usr/bin:/bin','LANG':'C.UTF-8','HOME':str(attempt/'home'),'TMPDIR':native_tmp.name,
            'XDG_CACHE_HOME':str(attempt/'cache'),'XDG_CONFIG_HOME':str(attempt/'config'),'NODE_OPTIONS':'--max-old-space-size=4096'}
        report['nativeTmp']=native_tmp.name
        preview=launch([str(NODE),'--max-old-space-size=4096',str(qa/'web/node_modules/vite/bin/vite.js'),'preview','--host','127.0.0.1','--port','4187','--strictPort'],env,'preview')
        deadline=time.monotonic()+45
        while True:
            update()
            if preview.poll() is not None:raise RuntimeError('Owned preview exited; occupied ports are never reused')
            # Only probe after this owned server advertises its exact strict port.
            # An unrelated listener cannot satisfy readiness while our child starts.
            if ORIGIN+'/' in (attempt/'preview.log').read_text():
                try:
                    with opener.open(ORIGIN+'/',timeout=1) as response:
                        if response.status==200:break
                except (urllib.error.URLError,TimeoutError):pass
            if time.monotonic()>=deadline:raise TimeoutError('Owned preview readiness exceeded 45 s')
            time.sleep(.2)
        condition=args.sample.split('-')[0]
        argv=[str(NODE),'--max-old-space-size=4096',str(qa/'web/tools/precinct-performance.ts'),'--software','--url='+ORIGIN+'/',
            '--scene=courtyard','--tier=low','--camera=third','--viewport=1440x900','--dpr=1','--seconds=60','--warmup=60',
            '--slow-start-diagnostic','--protocol=fixed-camera','--low-environment='+condition,'--out='+str(attempt/'measurement')]
        runner=launch(argv,{**env,'ARENA_CHROMIUM_PATH':'/usr/bin/chromium'},'runner')
        deadline=time.monotonic()+480
        while runner.poll() is None:
            update()
            if preview.poll() is not None:raise RuntimeError('Owned preview exited during measurement')
            if time.monotonic()>=deadline:raise TimeoutError('Bounded production setup/measurement exceeded 480 s')
            time.sleep(.2)
        report['runnerExit']=runner.returncode
        result_path=attempt/'measurement/performance-report.json'
        if result_path.stat().st_size>16*1024*1024:raise RuntimeError('Report exceeds bounded 16 MiB')
        result=json.loads(result_path.read_text());report['measurementReportSha256']=sha(result_path)
        report['measurementStatus']=result.get('status');report['evaluation']=result.get('evaluation')
        allowed={('completed',0),('steady-state-completed-cold-start-failed',1)}
        if (result.get('status'),runner.returncode) not in allowed or result.get('errors') or result.get('blockedRequests') or result.get('evaluation',{}).get('complete') is not True:
            raise RuntimeError('Production diagnostic failed or was incomplete; preserve original failure')
        report['status']='complete-diagnostic'
        report['measuredFramePacingPassed']=result['evaluation']['timingPassed']
    except (Exception,KeyboardInterrupt) as failure:
        report['status']='failed';report['errors'].append(type(failure).__name__+': '+str(failure))
    finally:
        for name,child in reversed(children):
            try:
                try:os.killpg(child.pid,signal.SIGTERM)
                except ProcessLookupError:pass
                try:child.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    try:os.killpg(child.pid,signal.SIGKILL)
                    except ProcessLookupError:pass
                    child.wait(timeout=2)
                try:os.killpg(child.pid,signal.SIGKILL)
                except ProcessLookupError:pass
                report[name+'Exit']=child.returncode
            except Exception as error:report['cleanupErrors'].append(name+': '+str(error))
        for stream in streams:stream.close()
        if native_tmp is not None:
            try:native_tmp.cleanup();report['nativeTmpRemoved']=True
            except Exception as error:report['cleanupErrors'].append('Owned temp: '+str(error))
        for s,handler in original.items():signal.signal(s,handler)
        if report['cleanupErrors']:report['status']='failed'
        report['elapsedSeconds']=time.monotonic()-started
        destination=attempt/'native-launch-report.json';destination.write_text(json.dumps(report,indent=2)+'\n')
        print(str(destination),flush=True)
    # A valid warmed diagnostic with failed cold gate or timing remains a nonzero overall result.
    return 0 if report['status']=='complete-diagnostic' and report.get('runnerExit')==0 and report.get('measuredFramePacingPassed') is True else 1

if __name__=='__main__':sys.exit(main())
```
