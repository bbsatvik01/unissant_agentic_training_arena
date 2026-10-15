"""Normalize authoring metadata into the lightweight runtime interface."""
import json, math
from pathlib import Path

def finalize_manifest(m):
    counts={}
    for c in m['colliders']:
        if 'bounds' in c:c.update(c.pop('bounds'))
        base=c['id'].lower().replace(' ','-')
        counts[base]=counts.get(base,0)+1
        c['id']=base+'-'+str(counts[base])
    for h in m['hotspots']:
        if 'roomId' in h:h['room']=h.pop('roomId')
        if 'activationRadius' in h:h['radius']=h.pop('activationRadius')
    for h in m['hotspots']:
        if h['id']=='personal_dossier':h['position']=[-7.35,1.65,-21.7]
        if h['id']=='instructor':h['position']=[10.9,1.65,-26.55]
    nav=[]
    def node(id,pos):
        n={'id':id,'position':pos,'neighbors':[]};nav.append(n);return n
    def link(a,b):a['neighbors'].append(b['id']);b['neighbors'].append(a['id'])
    front=node('arrival',[0,0,-2.4]);lobby=node('lobby-center',[0,0,-7.9]);link(front,lobby)
    prev=lobby
    for d in sorted(m['doors'],key=lambda d:-d['walkCenter'][2]):
        z=d['walkCenter'][2];spine=node(d['id']+'-hall',[0,0,z]);link(prev,spine);prev=spine
        door=node(d['id'],d['walkCenter']);link(spine,door)
        room=next(r for r in m['rooms'] if r['id']==d['connects'][1])
        anchor=node(room['id']+'-anchor',room['anchor']);link(door,anchor)
    end=node('recognition',[0,0,-34.35]);link(prev,end)
    board=node('board-wall-anchor',[8.1,0,-7.35]);link(lobby,board)
    approach=node('reception-approach',[-3.3,0,-5.7]);link(lobby,approach)
    rec=node('reception-anchor',[-6.2,0,-5.7]);link(approach,rec)
    m['navigationNodes']=nav
    m['navigation']['nodes']=nav
    m['navigation']['portals']=m['doors']
    m['schemaVersion']=2
    return m

if __name__=='__main__':
    p=Path(__file__).resolve().parent.parent/'web/public/world/precinct-manifest.json'
    m=finalize_manifest(json.loads(p.read_text()));p.write_text(json.dumps(m,indent=2))
