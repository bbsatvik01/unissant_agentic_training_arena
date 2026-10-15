#!/usr/bin/env python3
"""Original Northstar Investigation Training Precinct. Run with Blender --background --python.
Authoring: meters, +Z up, +Y north. Runtime glTF: meters, +Y up, -Z north.
No network assets, texture downloads, or external image dependencies.
"""
import bpy, math, json, os, random, time, sys
from mathutils import Vector
from pathlib import Path
random.seed(42)
ROOT=Path(__file__).resolve().parent
OUT=ROOT.parent/'web'/'public'/'world'
OUT.mkdir(parents=True,exist_ok=True)
START=time.time()
bpy.ops.object.select_all(action='SELECT'); bpy.ops.object.delete(use_global=False)
for datablocks in (bpy.data.meshes,bpy.data.curves,bpy.data.materials,bpy.data.cameras,bpy.data.lights):
    for block in list(datablocks):
        if block.users==0: datablocks.remove(block)
scene=bpy.context.scene
scene.unit_settings.system='METRIC'; scene.unit_settings.scale_length=1
scene.render.engine='CYCLES'
scene.cycles.samples=24
scene.cycles.use_denoising=True
scene.render.resolution_x=1440; scene.render.resolution_y=900; scene.render.resolution_percentage=100
scene.render.image_settings.file_format='PNG'
scene.view_settings.view_transform='AgX'
scene.render.film_transparent=False
scene.world.use_nodes=True
scene.world.node_tree.nodes['Background'].inputs['Color'].default_value=(0.65,0.74,0.85,1)
scene.world.node_tree.nodes['Background'].inputs['Strength'].default_value=0.42
M={}; COLLIDERS=[]; ROOMS=[]; DOORS=[]; HOTSPOTS=[]; LIGHTS=[]

def mat(name,hexv,rough=.6,metal=0,alpha=1,emission=0):
    c=tuple(int(hexv[i:i+2],16)/255 for i in (0,2,4))
    # Input values are sRGB design colors, convert to linear for predictable export.
    c=tuple(v/12.92 if v<=.04045 else ((v+.055)/1.055)**2.4 for v in c)
    m=bpy.data.materials.new(name); m.diffuse_color=(*c,alpha); m.use_nodes=True
    p=m.node_tree.nodes.get('Principled BSDF'); p.inputs['Base Color'].default_value=(*c,alpha)
    p.inputs['Roughness'].default_value=rough; p.inputs['Metallic'].default_value=metal
    p.inputs['Alpha'].default_value=alpha
    if alpha<1:
        m.surface_render_method='DITHERED'; m.use_transparency_overlap=False
    if emission:
        p.inputs['Emission Color'].default_value=(*c,1); p.inputs['Emission Strength'].default_value=emission
    M[name]=m; return m
mat('Warm limestone','D8D3C9',.78)
mat('Warm white plaster','E7E4DC',.9)
mat('White acoustic ceiling','E2E1DB',.95)
mat('Honed terrazzo','B8B6AF',.68)
mat('Terrazzo border','7B817D',.72)
mat('Blue grey carpet','555F65',.98)
mat('Carpet stitch','667178',1)
mat('Deep petrol','284754',.62)
mat('Oak natural','A67D50',.58)
mat('Oak light grain','BA9268',.64)
mat('Oak dark grain','8F6944',.6)
mat('Walnut detail','5B473A',.62)
mat('Powder coated charcoal','29353A',.58,.12)
mat('Brushed brass','AF9766',.38,.75)
mat('Brushed steel','87918F',.34,.72)
mat('Warm ivory upholstery','C0BAAD',.94)
mat('Petrol upholstery','375764',.95)
mat('Black rubber','1C2225',.92)
mat('Paper ivory','E5E3D9',.88)
mat('Paper blue','7E99A7',.8)
mat('Screen glass','12252F',.3)
mat('Screen teal','72B3B5',.55,emission=.55)
mat('Screen muted white','D7E4E3',.65,emission=.3)
mat('Fixture diffuser','FFF0D3',.5,emission=3.0)
mat('Glazing','B8D1CF',.18,alpha=.16)
mat('Observation glazing','34545B',.21,alpha=.52)
mat('Leaf sage','415E49',.92)
mat('Leaf olive','6B7756',.92)
mat('Soil','39352D',1)
mat('Asphalt','565A5A',.98)
mat('Sidewalk','C1BBAF',.9)
mat('Muted red brick','8B6253',.95)
mat('DC limestone','C6BCA8',.92)
mat('Exterior glass','547077',.32)
mat('Road marking','C9C6B5',.9)
mat('Archive red','8C5E54',.8)
mat('Archive sand','B0A38B',.85)
mat('Archive slate','55707D',.85)

def runtime(v): return [round(v[0],4),round(v[2],4),round(-v[1],4)]
def bounds_rt(lo,hi):
    return {'min':[round(lo[0],4),round(lo[2],4),round(-hi[1],4)],'max':[round(hi[0],4),round(hi[2],4),round(-lo[1],4)]}
def collision(name,loc,size,kind='furniture'):
    lo=[loc[i]-size[i]/2 for i in range(3)]; hi=[loc[i]+size[i]/2 for i in range(3)]
    COLLIDERS.append({'id':name,'kind':kind,'bounds':bounds_rt(lo,hi)})
def box(name,loc,size,material,bevel=0,collide=False):
    sx,sy,sz=[v/2 for v in size]
    verts=[(-sx,-sy,-sz),(sx,-sy,-sz),(sx,sy,-sz),(-sx,sy,-sz),(-sx,-sy,sz),(sx,-sy,sz),(sx,sy,sz),(-sx,sy,sz)]
    faces=[(0,3,2,1),(4,5,6,7),(0,1,5,4),(1,2,6,5),(2,3,7,6),(3,0,4,7)]
    me=bpy.data.meshes.new(name);me.from_pydata(verts,[],faces);me.update()
    ob=bpy.data.objects.new(name,me);bpy.context.collection.objects.link(ob);ob.location=loc;me.materials.append(M[material])
    if bevel:
        mod=ob.modifiers.new('Crafted edge','BEVEL');mod.width=bevel;mod.segments=2
        ob.modifiers.new('Weighted corner normals','WEIGHTED_NORMAL')
    if collide:collision(name,loc,size,collide if isinstance(collide,str) else 'furniture')
    return ob

def cyl(name,loc,radius,depth,material,vertices=16,rotation=None):
    verts=[(radius*math.cos(i*2*math.pi/vertices),radius*math.sin(i*2*math.pi/vertices),z) for z in (-depth/2,depth/2) for i in range(vertices)]
    faces=[tuple(reversed(range(vertices))),tuple(range(vertices,vertices*2))]
    faces.extend((i,(i+1)%vertices,(i+1)%vertices+vertices,i+vertices) for i in range(vertices))
    me=bpy.data.meshes.new(name);me.from_pydata(verts,[],faces);me.update()
    ob=bpy.data.objects.new(name,me);bpy.context.collection.objects.link(ob);ob.location=loc
    if rotation:ob.rotation_euler=rotation
    me.materials.append(M[material]);return ob

def cone(name,loc,r1,r2,depth,material,vertices=20):
    verts=[(r*math.cos(i*2*math.pi/vertices),r*math.sin(i*2*math.pi/vertices),z) for r,z in ((r1,-depth/2),(r2,depth/2)) for i in range(vertices)]
    faces=[tuple(reversed(range(vertices))),tuple(range(vertices,vertices*2))]
    faces.extend((i,(i+1)%vertices,(i+1)%vertices+vertices,i+vertices) for i in range(vertices))
    me=bpy.data.meshes.new(name);me.from_pydata(verts,[],faces);me.update()
    ob=bpy.data.objects.new(name,me);bpy.context.collection.objects.link(ob);ob.location=loc;me.materials.append(M[material]);return ob

def sphere(name,loc,scale,material):
    segments=12;rings=6
    verts=[(math.sin(math.pi*j/rings)*math.cos(2*math.pi*i/segments)*scale[0],math.sin(math.pi*j/rings)*math.sin(2*math.pi*i/segments)*scale[1],math.cos(math.pi*j/rings)*scale[2]) for j in range(1,rings) for i in range(segments)]
    verts.extend([(0,0,scale[2]),(0,0,-scale[2])]);top=len(verts)-2;bottom=len(verts)-1
    faces=[]
    for i in range(segments):faces.append((top,i,(i+1)%segments));faces.append((bottom,(rings-2)*segments+(i+1)%segments,(rings-2)*segments+i))
    for j in range(rings-2):
        for i in range(segments):faces.append((j*segments+i,(j+1)*segments+i,(j+1)*segments+(i+1)%segments,j*segments+(i+1)%segments))
    me=bpy.data.meshes.new(name);me.from_pydata(verts,[],faces);me.update()
    ob=bpy.data.objects.new(name,me);bpy.context.collection.objects.link(ob);ob.location=loc;me.materials.append(M[material])
    for p in me.polygons:p.use_smooth=True
    return ob

def line(name,a,b,radius,material,vertices=8):
    d=Vector(b)-Vector(a); ob=cyl(name,(Vector(a)+Vector(b))/2,radius,d.length,material,vertices)
    ob.rotation_euler=d.to_track_quat('Z','Y').to_euler(); return ob
FONT=os.environ.get('ARENA_DEJAVU_FONT','/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf')
font=bpy.data.fonts.load(FONT) if os.path.isfile(FONT) else None

def text(name,body,loc,size=.18,material='Paper ivory',rot=(math.pi/2,0,0),align='LEFT'):
    cu=bpy.data.curves.new(name,'FONT');cu.body=body;cu.size=size;cu.extrude=.0007;cu.bevel_depth=0;cu.align_x=align;cu.space_character=1.05;cu.resolution_u=4
    if font:cu.font=font
    ob=bpy.data.objects.new(name,cu);bpy.context.collection.objects.link(ob);ob.location=loc;ob.rotation_euler=rot;cu.materials.append(M[material]);return ob

def panel_text(name,body,x,y,z,w=2.4,h=.5,sz=.15):
    box(name+' plaque',(x,y,z),(w,.055,h),'Deep petrol',.015)
    text(name+' typography',body,(x-w/2+.16,y-.031,z-.05),sz)

def wall(name,loc,size):
    box(name,loc,size,'Warm white plaster',.012,'wall')
    # toe-kick, all sides retained on source, understated brass-free perimeter.
    if size[0]>.5:box(name+' skirting',(loc[0],loc[1]-.015,.065),(size[0],size[1]+.028,.13),'Terrazzo border',.008)
    else:box(name+' skirting',(loc[0],loc[1],.065),(size[0]+.028,size[1],.13),'Terrazzo border',.008)

def doorway_wall(side,ystart,yend,door_y,room_id,label,number):
    x=side*2.4; opening=2.05; dh=2.5; thickness=.18; height=3.5
    for a,b in ((ystart,door_y-opening/2),(door_y+opening/2,yend)):
        if b>a:wall(room_id+' corridor wall',(x,(a+b)/2,height/2),(thickness,b-a,height))
    wall(room_id+' lintel',(x,door_y,(dh+height)/2),(thickness,opening,height-dh))
    for y in (door_y-opening/2,door_y+opening/2):box(room_id+' oak jamb',(x,y,dh/2),(.26,.09,dh),'Oak natural',.012)
    box(room_id+' oak head',(x,door_y,dh),(.26,opening+.09,.09),'Oak natural',.012)
    # Open pocket door parked into room, never across portal.
    box(room_id+' parked door',(x+side*.22,door_y+opening/2+.49,1.21),(.065,.92,2.4),'Oak natural',.02)
    box(room_id+' vision glass',(x+side*.258,door_y+opening/2+.49,1.65),(.009,.45,.85),'Observation glazing',.008)
    # Sign on corridor side; text points into corridor.
    p_y=door_y-1.62
    box(room_id+' room sign',(x-side*.12,p_y,1.57),(.04,.78,.44),'Deep petrol',.012)
    rot=(math.pi/2,0,math.pi/2 if side<0 else -math.pi/2)
    tx=x-side*.145; ty=p_y+(.31 if side>0 else -.31)
    text(room_id+' sign number',number,(tx,ty,1.66),.12,rot=rot)
    text(room_id+' sign label',label,(tx,ty,1.48),.075,rot=rot)
    DOORS.append({'id':room_id+'_door','connects':['corridor',room_id],'center':runtime((x,door_y,1.25)),'width':opening,'height':dh,'axis':'z','clearance':.2,'walkCenter':runtime((x,door_y,0))})
    return x,door_y

def room(id,label,x0,x1,y0,y1,anchor,description):
    ROOMS.append({'id':id,'name':label,'bounds':bounds_rt((x0,y0,0),(x1,y1,3.5)),'anchor':runtime(anchor),'description':description})

def hotspot(id,room_id,label,loc,look_at,kind='room'):
    HOTSPOTS.append({'id':id,'roomId':room_id,'label':label,'position':runtime(loc),'lookAt':runtime(look_at),'kind':kind,'activationRadius':2.5})

def area(name,loc,power,size=3,color=(1,.9,.76),target=None):
    data=bpy.data.lights.new(name,'AREA');data.energy=power;data.shape='DISK';data.size=size;data.color=color
    ob=bpy.data.objects.new(name,data);bpy.context.collection.objects.link(ob);ob.location=loc
    if target:ob.rotation_euler=(Vector(target)-ob.location).to_track_quat('-Z','Y').to_euler()
    return ob

def fixture(x,y,length=1.8,axis='x'):
    sx,sy=(length,.23) if axis=='x' else (.23,length)
    box('Suspended linear light housing',(x,y,3.24),(sx+.08,sy+.08,.09),'Powder coated charcoal',.018)
    box('Opal linear light diffuser',(x,y,3.185),(sx,sy,.022),'Fixture diffuser',.008)
    for dx,dy in ((sx*.38,sy*.38),(-sx*.38,-sy*.38)):
        line('Light suspension cable',(x+dx,y+dy,3.29),(x+dx,y+dy,3.52),.005,'Powder coated charcoal')
    area('Architectural ceiling light',(x,y,3.12),145,max(length,1.6))
    LIGHTS.append({'position':runtime((x,y,3.05)),'color':'#fff0d5','intensity':2.0,'range':8})

def plant(x,y,scale=1):
    cone('Stone planter',(x,y,.29*scale),.26*scale,.32*scale,.58*scale,'Terrazzo border')
    cyl('Visible pot soil',(x,y,.58*scale),.28*scale,.02*scale,'Soil')
    for i in range(9):
        ang=i*2.4; h=(.7+.12*(i%4))*scale
        end=(x+math.cos(ang)*.28*scale,y+math.sin(ang)*.28*scale,.55*scale+h)
        line('Plant stem',(x,y,.55*scale),end,.012*scale,'Leaf sage')
        leaf=sphere('Sculpted leaf',end,(.12*scale,.035*scale,.3*scale),'Leaf sage' if i%2 else 'Leaf olive');leaf.rotation_euler=(.3,ang/4,ang)
    collision('planter', (x,y,.5*scale),(.68*scale,.68*scale,scale),'furniture')

def chair(x,y,angle=0,material='Petrol upholstery',office=True):
    collision('chair',(x,y,.55),(.74,.74,1.1),'furniture')
    # local y positive is the back; rotate all components around seat.
    before=set(bpy.data.objects)
    box('Chair seat',(x,y,.47),(.5,.49,.1),material,.045)
    box('Chair upholstered back',(x,y+.22,.83),(.49,.095,.54),material,.045)
    if office:
        cyl('Chair gas lift',(x,y,.24),.035,.39,'Brushed steel',12)
        for i in range(5):
            a=2*math.pi*i/5; px=x+math.cos(a)*.29;py=y+math.sin(a)*.29
            line('Chair five star base',(x,y,.14),(px,py,.08),.018,'Powder coated charcoal')
            sphere('Chair caster',(px,py,.055),(.045,.045,.04),'Black rubber')
        for xx in (x-.29,x+.29):
            line('Chair arm support',(xx,y,.48),(xx,y,.68),.014,'Powder coated charcoal')
            box('Chair armrest',(xx,y,.69),(.05,.28,.045),'Black rubber',.018)
    else:
        for dx in (-.21,.21):
            for dy in (-.18,.18):line('Chair leg',(x+dx,y+dy,.05),(x+dx,y+dy,.47),.018,'Powder coated charcoal')
    for ob in set(bpy.data.objects)-before:
        xx,yy=ob.location.x-x,ob.location.y-y
        ob.location.x=x+xx*math.cos(angle)-yy*math.sin(angle);ob.location.y=y+xx*math.sin(angle)+yy*math.cos(angle);ob.rotation_euler.z+=angle

def monitor(x,y,z=1.02,angle=0,title='CASE WORKSPACE'):
    before=set(bpy.data.objects)
    box('Monitor weighted base',(x,y,z-.235),(.31,.2,.025),'Powder coated charcoal',.015)
    box('Monitor support',(x,y+.025,z-.12),(.05,.05,.22),'Brushed steel',.008)
    box('Monitor slim bezel',(x,y,z+.1),(.66,.045,.4),'Powder coated charcoal',.015)
    box('Monitor glass',(x,y-.026,z+.1),(.624,.008,.36),'Screen glass',.004)
    text('Monitor heading',title,(x-.28,y-.032,z+.2),.028,'Screen muted white')
    box('Screen left navigation',(x-.245,y-.032,z+.06),(.07,.004,.19),'Deep petrol')
    for row in range(4):box('Screen data row',(x+.055,y-.033,z+.105-row*.045),(.4,.003,.014),'Screen teal' if row==0 else 'Paper blue')
    box('Keyboard',(x,y-.36,z-.222),(.43,.14,.025),'Powder coated charcoal',.01)
    for r in range(3):box('Keyboard key row',(x,y-.4+r*.04,z-.207),(.38,.01,.003),'Terrazzo border')
    sphere('Mouse',(x+.34,y-.36,z-.215),(.037,.06,.017),'Powder coated charcoal')
    for ob in set(bpy.data.objects)-before:
        xx,yy=ob.location.x-x,ob.location.y-y
        ob.location.x=x+xx*math.cos(angle)-yy*math.sin(angle);ob.location.y=y+xx*math.sin(angle)+yy*math.cos(angle);ob.rotation_euler.z+=angle

def desk(x,y,w=1.7,d=.82,screen=True,seat=True,title='CASE WORKSPACE'):
    box('Oak workstation top',(x,y,.76),(w,d,.065),'Oak natural',.025)
    for xx in (x-w/2+.1,x+w/2-.1):
        box('Desk steel leg',(xx,y,.37),(.055,d-.12,.72),'Powder coated charcoal',.015)
        box('Desk foot',(xx,y,.045),(.065,d-.02,.045),'Powder coated charcoal',.015)
    box('Desk cable tray',(x,y+.22,.67),(w-.22,.12,.08),'Powder coated charcoal',.01)
    box('Pedestal',(x+w*.32,y+.02,.36),(.37,.59,.66),'Warm white plaster',.015)
    for h in (.2,.42,.62):box('Pedestal handle',(x+w*.32,y-.287,h),(.18,.018,.012),'Brushed steel',.004)
    if screen:monitor(x-.16,y+.14,title=title)
    box('Notebook',(x+w*.29,y-.22,.805),(.23,.29,.02),'Paper blue',.006)
    box('Notebook pages',(x+w*.29,y-.223,.817),(.21,.27,.008),'Paper ivory')
    if seat:chair(x,y-.86,math.pi)
    collision('workstation',(x,y,.5),(w,d,1.0))

def sofa(x,y,w=2.3,rot=0):
    before=set(bpy.data.objects)
    box('Lobby sofa base',(x,y,.29),(w,.82,.35),'Petrol upholstery',.07)
    box('Lobby sofa seat',(x,y-.05,.52),(w-.22,.67,.16),'Petrol upholstery',.055)
    box('Lobby sofa back',(x,y+.32,.77),(w,.18,.66),'Petrol upholstery',.06)
    for xx in (x-w/2+.05,x+w/2-.05):box('Lobby sofa arm',(xx,y,.63),(.17,.82,.44),'Petrol upholstery',.05)
    for xx in (x-w/2+.2,x+w/2-.2):
        for yy in (y-.26,y+.26):cyl('Sofa foot',(xx,yy,.1),.027,.16,'Brushed brass',8)
    for ob in set(bpy.data.objects)-before:
        xx,yy=ob.location.x-x,ob.location.y-y
        ob.location.x=x+xx*math.cos(rot)-yy*math.sin(rot);ob.location.y=y+xx*math.sin(rot)+yy*math.cos(rot);ob.rotation_euler.z+=rot
    collision('lobby sofa',(x,y,.5),(w if abs(rot)<.1 else .9,.9 if abs(rot)<.1 else w,1))

def cabinet(x,y,w=2.4,h=1.15):
    box('Archive cabinet',(x,y,h/2),(w,.48,h),'Oak natural',.025,True)
    for n in range(max(2,int(w/.5))):
        xx=x-w/2+(n+.5)*(w/max(2,int(w/.5)))
        box('Cabinet face',(xx,y-.25,h/2),(w/max(2,int(w/.5))-.015,.025,h-.07),'Oak light grain',.012)
        box('Cabinet brass pull',(xx,y-.274,h*.66),(.12,.02,.016),'Brushed brass',.006)

def wall_display(x,y,z,w=2.8,h=1.5,title='OPERATIONS'):
    box(title+' frame',(x,y,z),(w+.1,.08,h+.1),'Powder coated charcoal',.025)
    box(title+' screen',(x,y-.047,z),(w,.012,h),'Screen glass',.008)
    text(title+' title',title,(x-w/2+.15,y-.058,z+h/2-.27),.13,'Screen muted white')
    for i in range(5):
        box('Display chart bar',(x-w*.24+i*w*.115,y-.058,z-.12),(w*.06,.005,.2+i*.105),'Screen teal')
    text('Display subtitle','TRAIN  /  INVESTIGATE  /  REFLECT',(x-w/2+.15,y-.059,z-h/2+.14),.061,'Paper blue')

# Structural envelope. Single continuous, level walking plane.
box('Foundation',(0,18,-.16),(28,36,.3),'Warm limestone')
box('Lobby terrazzo',(0,5,-.005),(27.8,9.9,.035),'Honed terrazzo')
box('Corridor terrazzo',(0,22.85,-.005),(4.7,25.9,.035),'Honed terrazzo')
for x in (-2.18,2.18):box('Corridor guiding stone inlay',(x,22.9,.017),(.045,25.7,.006),'Terrazzo border')
for x0,x1,y0,y1 in [(-13.8,-2.5,10,19),(-13.8,-2.5,19,26),(-13.8,-2.5,26,35.8),(2.5,13.8,10,16),(2.5,13.8,16,20),(2.5,13.8,20,26),(2.5,13.8,26,32),(2.5,13.8,32,35.8)]:
    box('Room carpet field',((x0+x1)/2,(y0+y1)/2,.001),(x1-x0,y1-y0,.04),'Blue grey carpet')
    # Fine carpet tile joint lines, directional and quiet.
    for yy in range(math.ceil(y0),math.floor(y1)+1):box('Carpet tile seam',((x0+x1)/2,yy,.022),(x1-x0,.007,.002),'Carpet stitch')
wall('West exterior',(-14,18,1.75),(.22,36,3.5))
wall('East exterior',(14,18,1.75),(.22,36,3.5))
wall('North exterior',(0,36,1.75),(28,.22,3.5))
# South glazing floor to head, double central entrance, mullion rhythm.
for a,b in [(-14,-1.8),(1.8,14)]:
    box('Front limestone sill',((a+b)/2,0,.16),(b-a,.22,.32),'Warm limestone',.018,'wall')
    box('Front transom',((a+b)/2,0,3.3),(b-a,.22,.4),'Warm limestone',.018,'wall')
    box('Front glazing',((a+b)/2,0,1.75),(b-a,.025,2.9),'Glazing')
    collision('front glass',((a+b)/2,0,1.75),(b-a,.04,2.9),'wall')
    for i in range(6):
        xx=a+(b-a)*i/5
        box('Front vertical mullion',(xx,-.005,1.75),(.055,.1,3.1),'Powder coated charcoal',.006)
box('Entrance canopy',(0,-.9,3.3),(5.1,2.3,.2),'Warm limestone',.03)
# Two glass entrance leaves visibly open to outside; navigation boundary remains building-specific.
for side in (-1,1):
    x=side*1.78
    box('Entry open glass leaf',(x,-.85,1.45),(.027,1.7,2.8),'Glazing')
    for y in (-.04,-1.66):box('Entry door stile',(x,y,1.45),(.055,.055,2.86),'Powder coated charcoal',.007)
    line('Entry pull handle',(x-side*.08,-.53,1.0),(x-side*.08,-.53,1.5),.018,'Brushed brass')
# Ceiling with discreet panel seams.
box('Acoustic ceiling',(0,18,3.61),(28,36,.18),'White acoustic ceiling')
for x in range(-12,14,2):box('Ceiling fine reveal',(x,18,3.512),(.018,36,.009),'Terrazzo border')
for y in range(0,37,3):box('Ceiling cross reveal',(0,y,3.512),(28,.018,.009),'Terrazzo border')
# Lobby back walls with open central passage.
wall('Lobby west back wall',(-8.2,10,1.75),(11.6,.18,3.5))
wall('Lobby east back wall',(8.2,10,1.75),(11.6,.18,3.5))
box('Corridor entrance oak header',(0,10,3.0),(4.8,.32,1.0),'Oak natural',.018)
for x in (-2.35,2.35):box('Corridor portal oak liner',(x,10,1.3),(.14,.35,2.6),'Oak natural',.012)
text('Corridor entry direction','INVESTIGATIONS  /  LEARNING',(0,9.82,2.95),.18,'Paper ivory',align='CENTER')
# Side room partition walls and doors.
for y in (19,26):wall('West room partition',(-8.2,y,1.75),(11.6,.18,3.5))
for y in (20,26,32):wall('East room partition',(8.2,y,1.75),(11.6,.18,3.5))
# Interview/observation separating wall with large one-way glazing opening.
wall('Observation partition west',(3.7,16,1.75),(2.6,.16,3.5))
wall('Observation partition east',(12.55,16,1.75),(2.9,.16,3.5))
wall('Observation sill',(8.05,16,.48),(6.1,.16,.96))
wall('Observation lintel',(8.05,16,3.14),(6.1,.16,.72))
box('Observation glazing',(8.05,16,1.87),(6.1,.025,1.78),'Observation glazing')
collision('observation glass',(8.05,16,1.87),(6.1,.035,1.78),'wall')
for xx in (5,11.1):box('Observation vertical frame',(xx,16,1.87),(.055,.1,1.88),'Powder coated charcoal')
for zz in (.97,2.77):box('Observation horizontal frame',(8.05,16,zz),(6.16,.1,.055),'Powder coated charcoal')
for args in [(-1,10,19,13.1,'open_office','OPEN OFFICE','01'),(-1,19,26,22,'dossier','DOSSIER DESK','02'),(-1,26,36,29,'briefing','BRIEFING','03'),(1,10,16,12.5,'interview','INTERVIEW','04'),(1,16,20,18,'observation','OBSERVATION','05'),(1,20,26,23,'debrief','DEBRIEF / REPLAY','06'),(1,26,32,28.8,'coach_lab','COACH LAB','07'),(1,32,36,33.9,'records','ARCHIVE','08')]:doorway_wall(*args)
print('MODELED structure',len(scene.objects),round(time.time()-START),flush=True)
# Reception oak slat feature: deep restrained material palette.
box('Reception feature wall',(-8.15,9.84,1.8),(9.5,.12,3.3),'Deep petrol',.02)
for i in range(45):box('Oak acoustic reception batten',(-12.65+i*.2,9.75,1.81),(.055,.1,3.25),'Oak natural',.008)
box('Reception sign backing',(-8.1,9.65,2.28),(6.8,.055,1.05),'Deep petrol',.02)
text('Primary precinct name','NORTHSTAR',(-11.1,9.615,2.38),.49,'Paper ivory')
text('Primary precinct subline','INVESTIGATION TRAINING DIVISION',(-11.06,9.61,2.08),.145,'Paper ivory')
# Desk is offset left, leaving the entry-to-corridor sightline unobstructed.
box('Reception service counter',(-8,7.3,.54),(6.1,1.1,1.08),'Warm limestone',.045,True)
box('Reception oak fascia',(-8,6.734,.55),(5.96,.035,.89),'Oak natural',.008)
for xx in [(-10.8+i*.19) for i in range(31)]:box('Reception fine grain',(xx,6.711,.55),(.013,.008,.87),'Oak dark grain')
box('Reception countertop',(-8,7.3,1.12),(6.3,1.24,.085),'Warm limestone',.025)
box('Reception accessible writing shelf',(-4.56,7.3,.78),(.85,1.15,.06),'Oak natural',.02,True)
text('Reception front label','RECEPTION',(-9.9,6.699,.62),.22,'Paper ivory')
monitor(-8.65,7.53,1.37,title='VISITOR SERVICES')
chair(-8.6,8.25,0)
plant(-12.6,8,1.15);plant(-3.4,8.3,.85)
# Lobby lounge with genuine circulation room.
sofa(-10.7,3.6,2.5,0)
sofa(-7.2,3.5,1.55,-math.pi/2)
collision('lobby coffee table',(-10,2.1,.26),(1.3,1.3,.52),'furniture')
cyl('Round lobby coffee table',(-10,2.1,.45),.65,.07,'Oak natural',40)
cone('Coffee table pedestal',(-10,2.1,.23),.28,.16,.43,'Powder coated charcoal')
box('Lobby journal',(-9.95,2.12,.495),(.3,.23,.02),'Paper ivory',.004)
plant(-12.5,1.3,.9)
# Board wall: mission board, local DC wayfinding map and case cards, fully original typography.
box('Case board feature wall',(8.15,9.82,1.8),(9.5,.12,3.3),'Deep petrol',.02)
text('Case board title','TODAY’S FIELDWORK',(3.9,9.735,2.83),.29,'Paper ivory')
text('Case board subtitle','SELECT A CASE  /  BUILD YOUR JUDGMENT',(3.92,9.73,2.49),.107,'Paper blue')
for i,(title_,sub) in enumerate([('01  INITIAL INQUIRY','Observe • verify • document'),('02  WITNESS ACCOUNT','Listen • probe • corroborate'),('03  CASE SYNTHESIS','Connect • decide • debrief')]):
    xx=5.03+i*2.8
    box('Mission card panel',(xx,9.71,1.58),(2.48,.055,1.4),'Warm white plaster',.018)
    box('Mission card upper band',(xx,9.673,2.13),(2.48,.008,.3),'Oak natural')
    text('Mission card title',title_,(xx-1.12,9.662,2.09),.105,'Powder coated charcoal')
    text('Mission card summary',sub,(xx-1.12,9.661,1.83),.079,'Powder coated charcoal')
    # Abstract dossier sheets and connecting map lines, no faces or copyrighted graphic assets.
    for j in range(3):
        box('Mission abstract paper',(xx-.75+j*.72,9.661,1.38),(.51,.008,.58),'Paper ivory' if j%2 else 'Paper blue',.002)
        for k in range(4):box('Mission paper text line',(xx-.75+j*.72,9.651,1.54-k*.08),(.37,.004,.013),'Terrazzo border')
    text('Mission status','READY TO EXPLORE',(xx-1.1,9.65,1.02),.068,'Deep petrol')
cabinet(8.2,9.25,8.5,.64)
plant(12.75,7.5,1.1)
sofa(10.6,3.7,2.35,0)
collision('east lounge table',(10.5,2.2,.26),(1.12,1.12,.52),'furniture')
cyl('East lounge table',(10.5,2.2,.45),.56,.07,'Oak natural',32)
cone('East lounge table pedestal',(10.5,2.2,.22),.24,.15,.43,'Powder coated charcoal')
# Freestanding entrance orientation column placed away from circulation.
box('Orientation monolith',(4.8,3.6,.94),(.76,.32,1.88),'Deep petrol',.025,True)
text('Orientation top','WELCOME',(4.49,3.432,1.56),.12)
for i,label in enumerate(['01  CASE BOARD','02  YOUR DESK','03  BRIEFING','04  INTERVIEW']):text('Orientation row',label,(4.49,3.43,1.29-i*.19),.065)
text('Orientation caption','LEARN BY DOING',(4.49,3.429,.35),.06,'Paper blue')
print('MODELED lobby',len(scene.objects),round(time.time()-START),flush=True)
# Open office: four workstations, meeting island and long storage.
for xx in (-11.1,-7.6):
    for yy in (14.9,17.45):desk(xx,yy,title='INVESTIGATION WORKSPACE')
# Central collaboration table leaves route from door through southeast quarter.
box('Open office collaboration tabletop',(-6.7,11.65,.76),(2.9,1.05,.07),'Warm limestone',.045,True)
for xx in (-7.7,-5.7):box('Collaboration table leg',(xx,11.65,.38),(.1,.72,.72),'Oak natural',.018)
for xx in (-7.6,-6.3):chair(xx,10.75,math.pi,office=False)
cabinet(-11.7,18.55,3.3,1.15)
plant(-12.8,11.4,.9)
wall_display(-8.1,18.8,2.17,3.2,1.3,'TEAM OPERATIONS')
# Personal dossier room: substantial individual workstation and lounge, career timeline shelves.
desk(-8.8,23.7,2.5,1.05,title='PERSONAL DOSSIER')
chair(-8.7,21.5,math.pi,office=False,material='Warm ivory upholstery')
box('Dossier secondary sideboard',(-11.5,23.7,.39),(1.0,2.25,.78),'Oak natural',.025,True)
cabinet(-8.1,25.5,7.3,1.0)
box('Personal dossier wall panel',(-8.1,25.76,2.15),(7.5,.12,1.75),'Deep petrol',.015)
text('Dossier room heading','YOUR INVESTIGATOR PROFILE',(-11.4,25.69,2.7),.23)
for i,t in enumerate(['JUDGMENT','EVIDENCE','COMMUNICATION']):
    text('Dossier skill',t,(-11.4+i*2.35,25.685,2.24),.1,'Paper blue')
    for j in range(5):box('Dossier progress segment',(-11.2+i*2.35+j*.32,25.676,1.91),(.23,.008,.08),'Screen teal' if j<3+i%2 else 'Terrazzo border')
sofa(-12.45,21.5,1.5,math.pi/2);plant(-4,24.7,1)
# Briefing room: long conference table, ten seats, high legibility wall display.
box('Briefing conference top',(-8.2,30.75,.76),(5.5,1.65,.08),'Oak natural',.065,True)
for xx in (-9.8,-6.6):box('Conference trestle',(xx,30.75,.38),(.24,1.1,.72),'Powder coated charcoal',.025)
for i in range(4):
    xx=-10.3+i*1.4
    chair(xx,29.45,math.pi,office=False);chair(xx,32.05,0,office=False)
    box('Briefing notepad',(xx,30.2,.815),(.25,.3,.02),'Paper ivory',.004)
chair(-11.7,30.75,math.pi/2,office=False);chair(-4.7,30.75,-math.pi/2,office=False)
wall_display(-8.2,35.72,2.15,5.3,2.0,'BRIEFING / OBJECTIVES')
cabinet(-8.2,35.35,7.8,.65)
plant(-12.8,34.5,1.1)
# Interview table and two chairs, neutral and respectful room design.
box('Interview table',(8.7,13.2,.76),(2.45,1.05,.075),'Oak natural',.045,True)
for xx in (7.8,9.6):box('Interview table leg',(xx,13.2,.37),(.12,.7,.7),'Powder coated charcoal',.02)
chair(8.65,12.22,math.pi,office=False,material='Warm ivory upholstery')
chair(8.65,14.18,0,office=False,material='Warm ivory upholstery')
box('Interview notepad',(8.35,12.95,.812),(.26,.3,.012),'Paper ivory',.003)
cyl('Interview water carafe',(9.2,13.22,.91),.06,.25,'Glazing',20)
for xx in (8.9,9.5):cyl('Interview water glass',(xx,13.14,.855),.039,.11,'Glazing',16)
box('Interview acoustic panel',(13.78,13.1,1.8),(.12,3.8,1.65),'Warm ivory upholstery',.03)
panel_text('Interview sign','INTERVIEW  /  01',8.5,10.14,2.65,3.3,.55,.19)
# Discreet recording indicator and camera housing, no invasive fantasy machinery.
box('Interview camera housing',(12.6,10.2,2.9),(.22,.16,.12),'Warm white plaster',.03)
sphere('Interview camera lens',(12.6,10.105,2.9),(.04,.012,.04),'Screen glass')
# Observation bench faces glazing to south; desk behind chairs.
box('Observation worktop',(8.1,16.65,.78),(6.8,.6,.065),'Oak natural',.025,True)
for xx in (5.2,11):box('Observation support',(xx,16.65,.39),(.075,.5,.74),'Powder coated charcoal',.015)
for xx in (6.2,8.1,10):chair(xx,17.5,0)
monitor(11,16.75,1.02,math.pi,title='LIVE OBSERVATION')
cabinet(10.5,19.55,4.8,.95)
text('Observation instruction','OBSERVE  /  NOTE  /  REFLECT',(5.2,19.84,2.53),.19,'Deep petrol')
# Debrief and replay: screen, soft seating and review workstation.
wall_display(8.1,25.75,2.15,4.8,1.9,'DEBRIEF / REPLAY')
cabinet(8.1,25.33,6.8,.67)
sofa(7,22.65,2.7,math.pi)
sofa(11.2,23.3,1.8,-math.pi/2)
box('Debrief coffee table',(8.2,23.9,.45),(1.5,.7,.07),'Oak natural',.045,True)
for xx in (7.65,8.75):line('Debrief coffee table leg',(xx,23.9,.05),(xx,23.9,.42),.025,'Powder coated charcoal')
desk(11.75,21.6,1.6,.78,title='REPLAY TIMELINE')
plant(4.1,24.6,.95)
# Coach Lab: active learning console and instructor area in a shared generous room.
for xx in (7.1,10.4):desk(xx,30.45,2,.85,title='COACH LAB / SANDBOX')
wall_display(8.9,31.76,2.2,3.6,1.4,'COACH LAB')
desk(11.8,27.8,1.85,.85,title='INSTRUCTOR CONSOLE')
box('Instructor low divider',(10.2,27.35,.65),(.08,2.1,1.3),'Warm ivory upholstery',.03,True)
box('Lab collaboration table',(6.0,27.4,.76),(1.8,.9,.06),'Warm limestone',.025,True)
for xx in (5.35,6.65):box('Lab table leg',(xx,27.4,.38),(.065,.65,.72),'Powder coated charcoal',.015)
chair(6,26.55,math.pi,office=False)
plant(4.1,30.8,.9)
# Records / archive: shelving, carefully labeled cases, trophies and compact retrieval desk.
for xx in (5.1,8.2,11.3):
    collision('archive bookcase',(xx,35.4,1.45),(2.75,.76,2.8),'furniture')
    box('Archive bookcase back',(xx,35.74,1.45),(2.65,.07,2.8),'Oak dark grain',.012)
    for sx in (-1.34,1.34):box('Archive bookcase side',(xx+sx,35.4,1.45),(.055,.7,2.8),'Oak natural',.012)
    for zz in (.13,.76,1.39,2.02,2.65):box('Archive shelf',(xx,35.4,zz),(2.7,.7,.055),'Oak natural',.01)
    for row in range(4):
        for j in range(5):
            bx=xx-1.1+j*.47;bz=.17+row*.63
            box('Labeled records box',(bx,35.35,bz+.23),(.4,.53,.46),['Archive sand','Archive slate','Archive red'][(row+j)%3],.012)
            box('Records label',(bx,35.074,bz+.26),(.23,.009,.08),'Paper ivory',.003)
            text('Records code',f'{row+1:02d}-{j+1:02d}',(bx-.08,35.066,bz+.24),.04,'Powder coated charcoal')
# Trophy vitrine against west portion north wall of corridor, inset does not block passage.
collision('recognition display',(0,35.55,1.8),(3.8,.65,3.15),'furniture')
box('Recognition panel',(0,35.8,1.8),(3.8,.1,3.15),'Deep petrol',.018)
text('Recognition heading','THE PRACTICE OF JUDGMENT',(-1.65,35.735,2.95),.135)
text('Recognition subtitle','PROGRESS, EARNED THROUGH EXPERIENCE',(-1.64,35.733,2.67),.073,'Paper blue')
for i in range(3):
    xx=-1.13+i*1.13
    box('Recognition shelf',(xx,35.48,1.65),(.88,.5,.06),'Oak natural',.015)
    box('Award stone base',(xx,35.47,1.74),(.29,.22,.12),'Warm limestone',.015)
    cone('Award sculptural form',(xx,35.47,1.99),.11,.04,.38,'Brushed brass',5)
    text('Award caption',['OBSERVE','UNDERSTAND','ACT'][i],(xx-.35,35.731,1.25),.09,'Paper ivory')
# Hallway curated original graphics along sightline, without clutter.
for y,caption in [(15.5,'CURIOSITY'),(24.6,'PERSPECTIVE'),(31.2,'INTEGRITY')]:
    # Slim ceiling wayfinding marker centered, comfortable 2.75m headroom.
    box('Hall suspended wayfinding',(0,y,2.95),(2.25,.07,.35),'Deep petrol',.015)
    text('Hall wayfinding text',caption,(-.93,y-.041,2.9),.135)
# Flat original city map art on lobby east side, facing west.
box('DC map frame',(13.78,5.1,1.9),(.1,3.3,1.8),'Oak natural',.02)
box('DC map paper',(13.72,5.1,1.9),(.015,3.1,1.6),'Paper ivory')
for i in range(9):box('DC abstract street grid',(13.705,3.8+i*.32,1.9),(.008,.014,1.25),'Paper blue')
for i in range(5):box('DC abstract street grid',(13.704,5.1,1.35+i*.25),(.009,2.8,.014),'Paper blue')
text('DC map caption','WASHINGTON, DC',(13.692,6.3,1.25),.1,'Deep petrol',rot=(math.pi/2,0,-math.pi/2))
print('MODELED interiors',len(scene.objects),round(time.time()-START),flush=True)
# Lighting, scaled office fixture arrangement.
for x in (-9,-4.7,0,5,10):
    for y in (2.7,7.2):fixture(x,y,2.2)
for y in (12,17,22,27,32,34.7):fixture(0,y,1.6,axis='y')
for x in (-10.4,-5.5):
    for y in (12.5,16.8,21.2,24,28.5,33.4):fixture(x,y,1.8)
for x in (6.1,11):
    for y in (12.5,18,22.3,24.3,28.5,30.5,34):fixture(x,y,1.6)
# Front daylight fill, warmer interior illumination.
area('South window daylight',(0,-2,2.8),1100,11,(.78,.87,1),(0,9,1.4))
area('Lobby soft daylight left',(-9,1,3),280,5,(.85,.9,1),(-9,7,1.1))
area('Lobby soft daylight right',(9,1,3),280,5,(.85,.9,1),(9,7,1.1))
sun=bpy.data.lights.new('Morning Washington sun','SUN');sun.energy=1.5;sun.angle=.13
sunob=bpy.data.objects.new('Morning Washington sun',sun);bpy.context.collection.objects.link(sunob);sunob.rotation_euler=(math.radians(28),math.radians(-20),math.radians(-25))
# Original DC-inspired exterior. A visual setting, not a claimed exact address or geographic replica.
box('South civic sidewalk',(0,-3.2,-.06),(40,6.4,.12),'Sidewalk')
for x in range(-20,21,2):box('Sidewalk score',(x,-3.2,.006),(.018,6.4,.008),'Terrazzo border')
box('Roadway',(0,-10,-.12),(70,7,.12),'Asphalt')
box('Far sidewalk',(0,-15,-.06),(70,3,.12),'Sidewalk')
for x in range(-32,33,5):box('Road lane marking',(x,-10,.006),(2.5,.08,.007),'Road marking')
for x in range(-3,4):box('Pedestrian crosswalk',(x*.7,-7.3,.007),(.36,1.8,.008),'Road marking')
# Modest row houses and civic facade across the road.
for i,x in enumerate((-21,-15,-9,9,15,21)):
    h=8.4+(i%3)*.45
    box('DC brick rowhouse',(x,-21,h/2),(5.6,8,h),'Muted red brick' if i%2 else 'DC limestone',.035)
    box('Rowhouse cornice',(x,-16.95,h-.13),(5.9,.32,.22),'DC limestone',.018)
    for zz in (1.55,4.25,6.9):
        for xx in (x-1.6,x,x+1.6):
            box('Rowhouse window surround',(xx,-16.95,zz),(1.11,.16,1.64),'DC limestone',.012)
            box('Rowhouse window',(xx,-16.845,zz),(.9,.025,1.42),'Exterior glass')
            box('Rowhouse window center rail',(xx,-16.82,zz),(.93,.035,.045),'Paper ivory')
            box('Rowhouse sill',(xx,-16.75,zz-.81),(1.2,.3,.1),'DC limestone')
    box('Rowhouse entry',(x,-16.81,.95),(1.05,.04,1.9),'Powder coated charcoal',.012)
    for zz in (.06,.15,.24):box('Rowhouse stoop',(x,-16.5-zz*2,zz),(1.7,1.15,.1),'DC limestone')
box('Civic limestone hall',(0,-23,5),(10,10,10),'DC limestone',.035)
for x in (-3.75,-1.25,1.25,3.75):
    cyl('Civic column',(x,-17.7,4),.27,6.3,'DC limestone',20)
    cyl('Civic column base',(x,-17.7,.85),.39,.22,'DC limestone',20)
    cyl('Civic capital',(x,-17.7,7.2),.39,.22,'DC limestone',20)
    for z in (2.7,5.6):box('Civic window',(x,-17.95,z),(1.2,.04,1.9),'Exterior glass')
box('Civic entablature',(0,-17.6,7.65),(10.4,.7,.65),'DC limestone',.02)
# Civic roof pediment as an original custom triangular prism.
verts=[(-5.2,-18,8),(5.2,-18,8),(0,-18,10.1),(-5.2,-17.2,8),(5.2,-17.2,8),(0,-17.2,10.1)]
mesh=bpy.data.meshes.new('Civic pediment mesh');mesh.from_pydata(verts,[],[(0,1,2),(5,4,3),(0,3,4,1),(1,4,5,2),(2,5,3,0)]);mesh.update()
ob=bpy.data.objects.new('Civic pediment',mesh);bpy.context.collection.objects.link(ob);ob.data.materials.append(M['DC limestone'])
for x in (-12,12):
    cyl('DC streetlamp pole',(x,-4.9,1.9),.045,3.8,'Powder coated charcoal',12)
    sphere('DC streetlamp globe',(x,-4.9,3.9),(.18,.18,.23),'Paper ivory')
    for zz in (.1,.24):cyl('Streetlamp base',(x,-4.9,zz),.12,.1,'Powder coated charcoal',12)
for x in (-18,-6,6,18):
    cyl('Street tree trunk',(x,-14.1,1.4),.14,2.8,'Walnut detail',12)
    for dx,dy,zz in [(-.5,0,3),(.5,.2,3.2),(0,-.3,3.9)]:sphere('Street tree canopy',(x+dx,-14.1+dy,zz),(1.05,.9,1.2),'Leaf olive' if x%3 else 'Leaf sage')
print('MODELED streetscape',len(scene.objects),round(time.time()-START),flush=True)
# Metadata: authoritative navigation and interactions, independent of render object merging.
room('lobby','Reception & Arrival',-13.8,13.8,.2,9.9,(0,3.3,0),'Warm civic arrival, reception and calm waiting areas.')
room('board_wall','Case Board',3.4,13.7,6.3,9.85,(8.2,7.4,0),'Three original training case panels and scenario selection.')
room('corridor','Investigation Hall',-2.28,2.28,10.1,35.65,(0,20,0),'Wide level spine joining every training room.')
room('open_office','Open Office',-13.8,-2.5,10.1,18.9,(-5.4,13.1,0),'Collaborative desks, case preparation and team operations.')
room('dossier','Personal Dossier',-13.8,-2.5,19.1,25.9,(-5.2,22,0),'Individual workspace and progress profile.')
room('briefing','Briefing Room',-13.8,-2.5,26.1,35.8,(-5.2,28,0),'Ten-seat briefing and objectives wall.')
room('interview','Interview Room',2.5,13.8,10.1,15.9,(5.7,12.5,0),'Neutral interview setting with recording fixture and adjacent observation glazing.')
room('observation','Observation Room',2.5,13.8,16.1,19.9,(4.8,18,0),'Live observation bench behind tinted viewing glass.')
room('debrief','Debrief & Replay',2.5,13.8,20.1,25.9,(5,22,0),'Soft-seated review and a dedicated replay workstation.')
room('coach_lab','Coach Lab & Instructor',2.5,13.8,26.1,31.9,(4.3,28.8,0),'Training consoles, experimentation and an instructor workstation.')
room('records','Records & Archive',2.5,13.8,32.1,35.8,(7.9,33.3,0),'Labeled records shelving and career archive access.')
hotspot('reception','lobby','Reception',(-6.2,5.7,1.65),(-8,7.3,1.2),'service')
hotspot('case_board','board_wall','Choose a case',(8.1,7.35,1.65),(8.1,9.7,1.85),'scenario')
hotspot('open_office','open_office','Team operations',(-5.6,14.4,1.65),(-8.4,16,1.0))
hotspot('personal_dossier','dossier','Your dossier',(-7.35,21.7,1.65),(-8.8,23.7,1),'profile')
hotspot('briefing','briefing','Start briefing',(-5,28.2,1.65),(-8.2,35.7,2.1),'briefing')
hotspot('interview','interview','Enter interview',(6.3,12.1,1.65),(8.7,13.2,1.1),'scenario')
hotspot('observation','observation','Observe interview',(8.1,18.5,1.65),(8.1,16,1.8),'observe')
hotspot('debrief_replay','debrief','Review a session',(5.3,22.4,1.65),(8.1,25.7,2.1),'replay')
hotspot('coach_lab','coach_lab','Open Coach Lab',(5.2,29.6,1.65),(7.1,30.45,1.1),'coach')
hotspot('instructor','coach_lab','Instructor controls',(10.9,26.55,1.65),(11.8,27.8,1.1),'instructor')
hotspot('archive','records','Browse records',(8.2,33.4,1.65),(8.2,35.4,1.7),'archive')
hotspot('trophies','corridor','View milestones',(0,33.8,1.65),(0,35.8,2.0),'progress')
# Eye-level architectural review cameras.
def camera(name,pos,target,lens=22):
    data=bpy.data.cameras.new(name);ob=bpy.data.objects.new(name,data);bpy.context.collection.objects.link(ob);ob.location=pos;ob.rotation_euler=(Vector(target)-ob.location).to_track_quat('-Z','Y').to_euler();data.lens=lens;data.clip_start=.05;data.clip_end=250;return ob
cam_lobby=camera('Lobby eye-level review',(1.7,1.4,1.68),(-2,8.8,1.75),20)
cam_corridor=camera('Corridor eye-level review',(-.62,10.8,1.68),(.15,28,1.72),21)
scene.camera=cam_lobby
# Keep an editable, semantic Blender source before runtime batching.
bpy.ops.file.pack_all()
bpy.ops.wm.save_as_mainfile(filepath=str(ROOT/'northstar-precinct.blend'),compress=True)
print('SOURCE_SAVED',flush=True)
# Render before optimizing; all light helpers exist in source only.
if '--skip-renders' not in sys.argv:
    for cam,name in [(cam_lobby,'lobby-preview.png'),(cam_corridor,'corridor-preview.png')]:
        scene.camera=cam;scene.render.filepath=str(ROOT/name)
        bpy.ops.render.render(write_still=True)
        print('RENDER_SAVED',name,flush=True)
# Snapshot evaluated meshes in one dependency-graph pass and batch by material.
# This avoids thousands of operator/dependency-graph updates.
# Flatten submillimeter text depth and simplify tiny bevels for the runtime mesh.
for ob in scene.objects:
    if ob.type=='FONT':
        ob.data.extrude=0
        ob.data.bevel_depth=0
        ob.data.resolution_u=2
    for mod in ob.modifiers:
        if mod.type=='BEVEL' and mod.width<.03:mod.segments=1
bpy.context.view_layer.update()
deps=bpy.context.evaluated_depsgraph_get()
groups={};originals=[]
for ob in list(scene.objects):
    if ob.type not in {'MESH','FONT','CURVE'} or not len(ob.data.materials):continue
    ev=ob.evaluated_get(deps);me=ev.to_mesh()
    if not me:continue
    material=ob.data.materials[0];g=groups.setdefault(material.name,{'material':material,'vertices':[],'faces':[],'smooth':[]})
    offset=len(g['vertices']);matrix=ob.matrix_world
    g['vertices'].extend(tuple(matrix@v.co) for v in me.vertices)
    g['faces'].extend(tuple(offset+i for i in p.vertices) for p in me.polygons)
    g['smooth'].extend(p.use_smooth for p in me.polygons)
    ev.to_mesh_clear();originals.append(ob)
for ob in originals:bpy.data.objects.remove(ob,do_unlink=True)
for name,g in groups.items():
    me=bpy.data.meshes.new('Runtime '+name);me.from_pydata(g['vertices'],[],g['faces']);me.update();me.materials.append(g['material'])
    ob=bpy.data.objects.new('Precinct | '+name,me);bpy.context.collection.objects.link(ob)
    for p,smooth in zip(me.polygons,g['smooth']):p.use_smooth=smooth
bpy.ops.object.select_all(action='DESELECT')
for ob in scene.objects:
    if ob.type=='MESH':ob.select_set(True)
mesh_count=sum(o.type=='MESH' for o in scene.objects)
triangles=sum(sum(len(p.vertices)-2 for p in o.data.polygons) for o in scene.objects if o.type=='MESH')
bpy.ops.export_scene.gltf(filepath=str(OUT/'precinct.glb'),export_format='GLB',use_selection=True,export_yup=True,export_apply=True,export_lights=False,export_cameras=False,export_materials='EXPORT',export_extras=False,export_texcoords=False,export_normals=True,export_tangents=False,export_animations=False)
size=(OUT/'precinct.glb').stat().st_size
manifest={
 'schemaVersion':1,'id':'northstar-investigation-precinct','title':'Northstar Investigation Training Precinct',
 'asset':'precinct.glb','sourceFile':'assets-src/northstar-precinct.blend',
 'provenance':{'author':'Original procedural environment authored for the training arena','license':'Original environment geometry and scene design may be used, modified and distributed commercially by the commissioning user. DejaVu Sans lettering uses its permissive font license; see ASSET_PROVENANCE.md.','externalImageTextures':False,'fictionalSetting':True,'realAgencyBranding':False},
 'coordinates':{'units':'meters','runtimeUp':'+Y','runtimeNorth':'-Z','blenderToRuntime':'[x,y,z] -> [x,z,-y]','footprintMeters':[28,36],'floorY':0.02,'ceilingY':3.5},
 'spawn':{'position':[0,1.65,-2.4],'lookAt':[0,1.65,-10],'yaw':0},
 'player':{'eyeHeight':1.65,'capsuleRadius':.28,'walkSpeed':2.0,'sprintSpeed':3.2,'stepHeight':.15},
 'walkBounds':{'min':[-13.72,0,-35.74],'max':[13.72,3.45,-.28]},
 'rooms':ROOMS,'doors':DOORS,'hotspots':HOTSPOTS,'colliders':COLLIDERS,
 'navigation':{'type':'level-floor-with-aabb-obstacles','mainSpine':[[0,0,-y] for y in [2.4,8.5,12.5,18,22,23,28.8,29,33.9,34.5]],'portals':DOORS,'minimumDoorClearWidth':2.05,'corridorClearWidth':4.6,'note':'Door leaves are parked clear of portals. Furniture colliders are conservative AABBs. Clamp walking to walkBounds; floors/ceilings do not need collision testing.'},
 'lighting':{'recommendation':'Use one shadowed directional key plus hemisphere fill. Emissive fixture geometry is included. Fixture positions support optional nearby point lights; enable only a few at once.','ambientSky':'#dbe5ed','ambientGround':'#a29c8e','ambientIntensity':2.0,'keyColor':'#fff1db','keyIntensity':2.2,'keyPosition':[9,16,5],'fixturePositions':LIGHTS,'toneMapping':'ACESFilmic or AgX','exposure':1.0,'disableShadowCastingMaterials':['White acoustic ceiling']},
 'performance':{'triangles':triangles,'meshMaterialGroups':mesh_count,'fileBytes':size,'textures':0,'animations':0,'runtimeLights':0},
 'reviewCameras':[{'id':'lobby','position':runtime(cam_lobby.location),'target':runtime((-2,8.8,1.75))},{'id':'corridor','position':runtime(cam_corridor.location),'target':runtime((.15,28,1.72))}],
 'version':'1.0.0'
}
import sys
sys.path.insert(0,str(ROOT))
from manifest_tools import finalize_manifest
manifest=finalize_manifest(manifest)
(OUT/'precinct-manifest.json').write_text(json.dumps(manifest,indent=2))
print('COMPLETE',json.dumps(manifest['performance']),'elapsed',round(time.time()-START),flush=True)
