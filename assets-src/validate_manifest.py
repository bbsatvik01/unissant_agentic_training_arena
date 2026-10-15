"""Check collider IDs, navigable graph, paths and GLB size/triangle budget."""
import hashlib,json,math,struct
from pathlib import Path
source_root=Path(__file__).resolve().parent
root=source_root.parent/'web/public/world'
m=json.loads((root/'precinct-manifest.json').read_text())
assert m['asset']=='precinct.glb','Manifest must name the runtime file loaded by the app: precinct.glb'
assert not m.get('assetPending',False),'Manifest is an unfinished preview'
assert m['coordinates']['units']=='meters'
assert m['coordinates']['runtimeUp']=='+Y' and m['coordinates']['runtimeNorth']=='-Z'
ids=[c['id'] for c in m['colliders']]
assert len(ids)==len(set(ids)),'Duplicate collider IDs'
nodes={n['id']:n for n in m['navigationNodes']};errors=[]
for a in nodes.values():
    for bid in a['neighbors']:
        assert bid in nodes and a['id'] in nodes[bid]['neighbors'],'Broken reciprocal graph edge'
        b=nodes[bid]
        if a['id']>bid:continue
        p,q=a['position'],b['position'];steps=max(1,int(math.dist(p,q)/.06))
        for i in range(steps+1):
            t=i/steps;x=p[0]+(q[0]-p[0])*t;z=p[2]+(q[2]-p[2])*t
            hit=None
            for c in m['colliders']:
                lo,hi=c['min'],c['max']
                if hi[1]<.2 or lo[1]>1.8:continue
                if lo[0]-.28<x<hi[0]+.28 and lo[2]-.28<z<hi[2]+.28:hit=c['id'];break
            if hit:errors.append((a['id'],bid,hit));break
assert not errors,f'Blocked navigation links: {errors}'
for h in m['hotspots']:
    x,_,z=h['position']
    for c in m['colliders']:
        lo,hi=c['min'],c['max']
        if hi[1]<.2 or lo[1]>1.8:continue
        assert not (lo[0]-.28<x<hi[0]+.28 and lo[2]-.28<z<hi[2]+.28),f'Hotspot {h["id"]} overlaps {c["id"]}'

for f in m['colliders']:
    if f['kind']!='furniture':continue
    for w in m['colliders']:
        if w['kind']!='wall':continue
        assert not all(f['min'][i]<w['max'][i] and f['max'][i]>w['min'][i] for i in range(3)),f'Furniture {f["id"]} overlaps wall {w["id"]}'
seen={'arrival'};todo=['arrival']
while todo:
    for nxt in nodes[todo.pop()]['neighbors']:
        if nxt not in seen:seen.add(nxt);todo.append(nxt)
assert len(seen)==len(nodes),'Disconnected navigation graph'
b=(root/m['asset']).read_bytes();assert b[:4]==b'glTF'
assert struct.unpack_from('<I',b,4)[0]==2,'Expected glTF 2.0'
assert struct.unpack_from('<I',b,8)[0]==len(b),'Invalid GLB length'
n,t=struct.unpack_from('<II',b,12);g=json.loads(b[20:20+n]);tris=sum(g['accessors'][p['indices']]['count']//3 for mesh in g['meshes'] for p in mesh['primitives'])
assert len(b)<25_000_000,'Runtime file exceeds 25 MB'
assert tris<150_000,'Runtime geometry exceeds 150k triangle target'
assert m['performance']['triangles']==tris,'Manifest triangle count is stale'
assert m['performance']['fileBytes']==len(b),'Manifest byte count is stale'
assert m['performance']['meshMaterialGroups']==len(g['meshes']),'Manifest material group count is stale'
assert not g.get('images',[]) and not g.get('textures',[]),'Unexpected image texture dependency'
assert all('uri' not in buffer for buffer in g['buffers']),'GLB must be self-contained'
source_bytes=(source_root/'northstar-precinct.blend').stat().st_size
assert source_bytes<25_000_000,'Editable Blender source exceeds 25 MB'

report={'passed':True,'colliders':len(ids),'hotspots':len(m['hotspots']),'navigationNodes':len(nodes),'rooms':len(m['rooms']),'triangles':tris,'meshMaterialGroups':len(g['meshes']),'runtimeAsset':m['asset'],'runtimeBytes':len(b),'runtimeSha256':hashlib.sha256(b).hexdigest(),'sourceBytes':source_bytes,'allNavigationLinksClearAtCapsuleRadius':.28,'allNodesReachable':True}
(source_root/'validation-report.json').write_text(json.dumps(report,indent=2));print(json.dumps(report,indent=2))
