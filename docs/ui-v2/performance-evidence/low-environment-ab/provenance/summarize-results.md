# Archived diagnostic source

This is the verbatim source used for the isolated experiment, archived for review. It is not a portable project entry point. Original UTF-8 source SHA-256: `edba6c6c6050dc1b6f37bbb3e128a673d8c4e12572fd6c8369c132dc37b390e0`.

```python
"""Summarize the exact four owned fixed-camera diagnostic reports, preserving failures."""
import hashlib,json,pathlib,statistics
ROOT=pathlib.Path('/workspace/shared/precinct-low-environment-validation-qa/20261015T223417Z/native-results')
ORDER=['retain-1','omit-1','omit-2','retain-2']
def digest(p):return hashlib.sha256(p.read_bytes()).hexdigest()
rows=[]
for label in ORDER:
 paths=list(ROOT.glob(label+'-*/native-launch-report.json'))
 if len(paths)!=1: raise RuntimeError('Expected one completed report for '+label)
 path=paths[0];n=json.loads(path.read_text());p=path.parent/'measurement/performance-report.json';r=json.loads(p.read_text());m=r['report']
 assert n['status']=='complete-diagnostic' and not n['errors'] and not n['cleanupErrors'] and n['nativeTmpRemoved']
 assert r['evaluation']['complete'] and not r['errors'] and not r['blockedRequests']
 assert m['production'] and m['hiddenFrames']==0 and m['demandFrames']==0 and m['visibilityInterruptions']==0
 assert m['scene']['environmentMapActive']==label.startswith('retain')
 fixed=r['fixedCamera'];ini=fixed['initial'];fields=['tier','continuous','visible','cameraPosition','cameraQuaternion','calls','triangles','drawingBuffer','dpr','sceneAsset','production']
 assert all(all(o['state'][k]==ini[k] for k in fields) for o in fixed['observations'])
 processes={}
 for sample in n['hostSamples']:
  for proc in sample['ownedProcesses']:
   key=(proc['pid'],proc['startTicks']);entry=processes.setdefault(key,{'first':sample['monotonic'],'firstTicks':proc['ticks'],'name':proc['name'],'peakRss':0})
   entry.update(last=sample['monotonic'],lastTicks=proc['ticks'],peakRss=max(entry['peakRss'],proc['rssBytes']))
 top=[]
 for (pid,start),v in processes.items():
  wall=v['last']-v['first'];cpu=(v['lastTicks']-v['firstTicks'])/100
  if wall>0:top.append({'pid':pid,'name':v['name'],'observedWallSeconds':wall,'cpuSeconds':cpu,'averagePercentOfOneCore':100*cpu/wall,'peakRssMiB':v['peakRss']/1024**2})
 top.sort(key=lambda p:p['cpuSeconds'],reverse=True)
 rows.append({'sample':label,'reportDirectory':path.parent.name,'rawMeasurementSha256':digest(p),'rawLaunchSha256':digest(path),'status':r['status'],'overallExit':n['runnerExit'],'coldEntryPassed':r['readiness']['initialReady'],'timingPassed':r['evaluation']['timingPassed'],'durationMs':m['durationMs'],'frames':m['framesRendered'],'fps':m['averageRenderedFps'],'frameMs':m['frameIntervalMs'],'cpuCallbackAndSubmissionMs':m['cpuFrameAndRenderSubmissionMs'],'longTaskMs':m['longTaskMs'],'drawCalls':m['drawCalls'],'triangles':m['triangles'],'drawingBufferPixels':m['drawingBufferPixels'],'dpr':m['dpr'],'loadedArtifactFingerprint':r['loadedArtifactFingerprint'],'fixedCamera':{k:ini[k] for k in fields},'environmentMapActive':m['scene']['environmentMapActive'],'programs':m['renderer']['programs'],'geometries':m['renderer']['geometries'],'textures':m['renderer']['textures'],'renderer':m['renderer']['renderer'],'browser':r['browserVersion'],'ownedProcessCpu':top[:4],'cleanShutdown':True})
for key in ['loadedArtifactFingerprint','fixedCamera','renderer','browser']:
 assert all(r[key]==rows[0][key] for r in rows),key
aggregate={}
for condition in ('retain','omit'):
 selected=[r for r in rows if r['sample'].startswith(condition)]
 aggregate[condition]={'fpsRange':[min(r['fps'] for r in selected),max(r['fps'] for r in selected)],'medianRunFps':statistics.median(r['fps'] for r in selected),'medianRunP95Ms':statistics.median(r['frameMs']['p95'] for r in selected)}
out={'schema':'arena.environment-lighting-ab.v1','runOrder':ORDER,'theme':'Office default; not Studio','scope':'Courtyard fixed interior, Low, reduced motion, 60 s common warmup and >=60 s timed interval; no navigation/capture/video during timing','baseCommit':'8eedd7564570c41def9892e4c1ddd4099b090872','candidateManifestSha256':'aba878b8b40d693c38a8c4f6eeac8e9d08e25209e7ff02cbad191f1bdffd173b','samples':rows,'aggregate':aggregate,'medianFpsRatioOmitToRetain':aggregate['omit']['medianRunFps']/aggregate['retain']['medianRunFps'],'acceptance':'All original cold-entry and frame-pacing failures remain failures. No M5, navigation, audio, input latency or general visual acceptance is inferred.','hostMetricCaveat':'Per-process /proc USER_HZ=100 ticks sampled once/second over its observed lifetime including setup/warmup; subprocess roles were not collected. CPU callback timer does not measure whole frame or GPU execution; actual GPU milliseconds unavailable. No unowned process attribution.'}
(ROOT/'SUMMARY.json').write_text(json.dumps(out,indent=2)+'\n')
print(json.dumps({'aggregate':aggregate,'ratio':out['medianFpsRatioOmitToRetain'],'output':str(ROOT/'SUMMARY.json')},indent=2))
```
