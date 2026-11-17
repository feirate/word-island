"""Original Word Island companions; run in the existing Blender 4.5 LTS.

Blender Z-up/front -Y becomes glTF Y-up/front +Z. No downloads or textures.
Each editable asset owns one coordinated idle clip; UI interactions stay in JS.
"""
from __future__ import annotations
import argparse
import json
import math
import sys
from pathlib import Path

import bpy
from mathutils import Vector

sys.path.insert(0, str(Path(__file__).resolve().parent))
import build_world as w

NAMES = {'squirrel':'栗栗','cat':'米米','dog':'豆豆','hedgehog':'刺刺','turtle':'慢慢','raccoon':'圈圈','fox':'橙橙'}
PALE='#F5E7CF'
INK='#343A36'
PINK='#D5A09B'

def sphere(name, point, radius, color, parent=None):
    return w.ball(name,point,radius,color,parent,20)

def fused(name, parts, color, parent, voxel=.036):
    obj=w.fuse([sphere(name+' mass',p,r,color) for p,r in parts],name,color,voxel)
    w.parent_keep(obj,parent)
    return obj

def actor(asset, color, head_z=1.05):
    root=w.group(asset.title()+'Companion',role='companion',assetId=asset,characterName=NAMES[asset])
    body=w.group('BreathingBody',root,role='body')
    fused('rounded connected body',[((0,.035,.51),(.36,.29,.43)),((0,.015,.79),(.29,.25,.25)),
        ((-.23,.04,.32),(.19,.22,.22)),((.23,.04,.32),(.19,.22,.22)),
        ((-.29,-.045,.54),(.12,.14,.24)),((.29,-.045,.54),(.12,.14,.24))],color,body,.04)
    for s in [-1,1]:sphere('grounded foot',(s*.22,-.14,.105),(.17,.23,.105),color,root)
    sphere('soft cream belly',(0,-.17,.50),(.23,.12,.25),PALE,body)
    head=w.group('LinkedHead',body,(0,0,.87),role='head')
    fused('rounded connected face',[((0,-.025,head_z),(.43,.32,.35)),((-.20,-.14,head_z-.10),(.23,.20,.20)),((.20,-.14,head_z-.10),(.23,.20,.20))],color,head,.031)
    return root,body,head

def face(head,z=1.08,spread=.17,y=-.333,nose_y=-.47,nose_color=INK,cheeks=True):
    for s in [-1,1]:
        sphere('glossy eye',(s*spread,y,z),(.044,.033,.064),INK,head)
        sphere('eye glint',(s*spread-.011,y-.026,z+.025),(.012,.009,.015),'paper',head)
        if cheeks:sphere('blushing cheek',(s*(spread+.08),y+.025,z-.105),(.055,.022,.031),PINK,head)
    sphere('little button nose',(0,nose_y,z-.12),(.043,.033,.032),nose_color,head)
    for s in [-1,1]:
        w.tube('gentle smile',[(0,nose_y+.014,z-.15),(s*.035,nose_y+.025,z-.18),(s*.072,nose_y+.045,z-.165)],[.009,.009,.006],INK,head,8)

def round_ears(head,color,z=1.32,size=.13):
    for s in [-1,1]:
        sphere('rounded ear',(s*.30,.015,z),(.14,.10,size),color,head)
        sphere('inner ear',(s*.30,-.074,z+.006),(.077,.026,size*.58),PINK,head)

def triangle_ears(head,color,z=1.28,height=.30):
    for s in [-1,1]:
        w.ear('soft triangular ear',(s*.28,.015,z),height,.27,color,head)
        w.ear('pink ear inset',(s*.28,-.071,z+.055),height*.57,.14,PINK,head)

def tail(body,name,points,radii,color,tip=None):
    pivot=w.group(name,body,points[0],role='tail')
    smooth_points=[];smooth_radii=[]
    for i in range(len(points)-1):
        p=[Vector(points[max(0,i-1)]),Vector(points[i]),Vector(points[i+1]),Vector(points[min(len(points)-1,i+2)])]
        rr=[radii[max(0,i-1)],radii[i],radii[i+1],radii[min(len(radii)-1,i+2)]]
        for j in range(6):
            t=j/6
            smooth_points.append(tuple(.5*((2*p[1])+(-p[0]+p[2])*t+(2*p[0]-5*p[1]+4*p[2]-p[3])*t*t+(-p[0]+3*p[1]-3*p[2]+p[3])*t*t*t)))
            smooth_radii.append(max(.003,.5*(2*rr[1]+(-rr[0]+rr[2])*t+(2*rr[0]-5*rr[1]+4*rr[2]-rr[3])*t*t+(-rr[0]+3*rr[1]-3*rr[2]+rr[3])*t*t*t)))
    smooth_points.append(points[-1]);smooth_radii.append(radii[-1])
    if tip:
        split=len(smooth_points)-7
        w.tube(name+' continuous shape',smooth_points[:split+1],smooth_radii[:split+1],color,pivot,14)
        w.tube(name+' cream tip',smooth_points[split:],smooth_radii[split:],tip,pivot,14)
    else:w.tube(name+' continuous shape',smooth_points,smooth_radii,color,pivot,14)
    return pivot

def scarf(body,color,center=.83):
    bpy.ops.mesh.primitive_torus_add(major_radius=.255,minor_radius=.038,major_segments=24,minor_segments=8,location=(0,0,center))
    w.finish(bpy.context.object,'soft neckerchief collar',color,body,True)
    w.mesh('neckerchief fold',[(-.11,-.26,center),(.11,-.26,center),(0,-.31,center-.20),(-.11,-.29,center),(.11,-.29,center),(0,-.34,center-.20)],[(0,1,2),(5,4,3),(0,3,4,1),(1,4,5,2),(2,5,3,0)],color,body,.012)

def squirrel():
    color='#B88555'
    root,body,head=actor('squirrel',color)
    triangle_ears(head,color,1.27,.25)
    sphere('cream muzzle',(0,-.327,.97),(.19,.14,.13),PALE,head)
    face(head,z=1.10)
    pivot=w.group('PlushCurlTail',body,(.25,.22,.35),role='tail')
    fused('continuous plush squirrel tail',[
        ((.34,.29,.40),(.18,.18,.20)),((.59,.37,.58),(.24,.24,.27)),
        ((.66,.39,.87),(.28,.25,.29)),((.54,.37,1.14),(.28,.24,.27)),
        ((.30,.34,1.28),(.23,.21,.21)),((.14,.32,1.18),(.12,.16,.14))],color,pivot,.035)
    # The acorn and clasping hands belong to the breathing torso.
    sphere('acorn nut',(0,-.37,.51),(.15,.12,.19),'woodLight',body)
    sphere('acorn cap',(0,-.37,.65),(.17,.13,.075),'woodDark',body)
    w.rod('acorn stalk',(0,-.37,.67),(.03,-.36,.75),.026,'woodDark',body)
    for s in [-1,1]:sphere('holding paw',(s*.16,-.39,.54),(.10,.09,.09),color,body)
    return root,body,head

def cat():
    color='#B9B6A8'
    root,body,head=actor('cat',color)
    triangle_ears(head,color,1.28,.31)
    sphere('white muzzle',(0,-.325,.97),(.21,.13,.13),PALE,head)
    face(head,z=1.10,nose_color=PINK)
    for x in [-.14,0,.14]:
        stripe=[]
        for z in [1.34,1.30,1.25,1.20]:
            xx=x*(.85+(z-1.20))
            yy=-.025-.32*math.sqrt(max(.03,1-(xx/.43)**2-((z-1.05)/.35)**2))-.003
            stripe.append((xx,yy,z))
        w.tube('forehead tabby stripe',stripe,[.014,.014,.013,.008],'#7F8178',head,8)
    tail(body,'CuriousCatTail',[(.24,.18,.30),(.48,.28,.33),(.62,.24,.54),(.66,.16,.83),(.59,.11,1.01)],[.085,.095,.09,.075,.025],color)
    scarf(body,'#88AAA1')
    return root,body,head

def dog():
    color='#D7B079'
    root,body,head=actor('dog',color)
    for s in [-1,1]:
        ear=sphere('floppy puppy ear',(s*.36,-.015,1.10),(.15,.13,.30),'#AD8158',head)
        ear.rotation_euler[1]=s*.27
    sphere('pale puppy muzzle',(0,-.345,.97),(.23,.17,.15),PALE,head)
    face(head,z=1.12,nose_y=-.53)
    tail(body,'WaggingPuppyTail',[(.19,.20,.36),(.43,.38,.44),(.56,.45,.63),(.58,.40,.80)],[.10,.11,.085,.02],color)
    scarf(body,'#BD8B56')
    return root,body,head

def hedgehog():
    color='#B08A64'
    root,body,head=actor('hedgehog',color,.99)
    # Broad back mantle plus rounded low-poly spines, merged by material below.
    sphere('spine mantle',(0,.17,.67),(.45,.34,.50),'#826447',body)
    for row,latitude in enumerate([-.35,.05,.45,.85,1.15]):
        for j in range(8):
            azimuth=.15+j*(math.pi-.30)/7
            center=Vector((.45*math.cos(azimuth)*math.cos(latitude),.17+.34*math.sin(azimuth)*math.cos(latitude),.67+.50*math.sin(latitude)))
            normal=Vector((center.x/.45**2,(center.y-.17)/.34**2,(center.z-.67)/.50**2)).normalized()
            tip=center+normal*(.10+.02*((j+row)%2))
            bpy.ops.mesh.primitive_cone_add(vertices=8,radius1=.057,radius2=.017,depth=(tip-center).length,location=(center+tip)/2)
            spine=bpy.context.object
            spine.rotation_euler=normal.to_track_quat('Z','Y').to_euler()
            w.finish(spine,'soft blunt spine','#826447',body,True)
    sphere('cream face',(0,-.19,1.0),(.37,.25,.29),PALE,head)
    round_ears(head,color,1.20,.085)
    sphere('little pointed muzzle',(0,-.395,.92),(.17,.15,.105),PALE,head)
    face(head,z=1.04,spread=.15,y=-.407,nose_y=-.55)
    return root,body,head

def turtle():
    color='#8EA67C'
    root=w.group('GentleTurtle',role='companion',assetId='turtle',characterName=NAMES['turtle'])
    body=w.group('BreathingBody',root,role='body')
    sphere('soft turtle torso',(0,.03,.31),(.40,.38,.23),color,body)
    for x,y in [(-.33,-.25),(.33,-.25),(-.34,.32),(.34,.32)]:
        foot=sphere('turtle flipper',(x,y,.105),(.20,.18,.105),color,root)
        foot.rotation_euler[2]=-.3 if x<0 else .3
    shell=sphere('rounded shell',(0,.17,.51),(.46,.44,.36),'#71895D',body)
    # Raised plate seams follow the actual shell; no texture or billboard detail.
    for axis in [-1,1]:
        points=[(axis*.20,yy,.51+.36*math.sqrt(max(.03,1-(.20/.46)**2-((yy-.17)/.44)**2))+.009) for yy in [-.18,-.02,.17,.36,.52]]
        w.tube('shell plate seam',points,[.014]*5,'#B5BF8C',body,8)
    for yy in [-.06,.30]:
        points=[(xx,yy,.51+.36*math.sqrt(max(.05,1-(xx/.46)**2-((yy-.17)/.44)**2))+.009) for xx in [-.37,-.23,0,.23,.37]]
        w.tube('shell cross seam',points,[.014]*5,'#B5BF8C',body,8)
    head=w.group('LinkedHead',body,(0,-.25,.59),role='head')
    sphere('turtle neck',(0,-.29,.54),(.20,.24,.25),color,head)
    sphere('round turtle head',(0,-.36,.77),(.32,.28,.29),color,head)
    sphere('turtle chin',(0,-.49,.66),(.23,.16,.12),'#C9CE9C',head)
    face(head,z=.82,spread=.145,y=-.598,nose_y=-.66,cheeks=True)
    tail(body,'TinyTurtleTail',[(0,.46,.25),(0,.67,.21),(0,.72,.20)],[.09,.045,.003],color)
    return root,body,head

def raccoon():
    color='#A6AAA2'
    root,body,head=actor('raccoon',color)
    round_ears(head,color,1.34,.15)
    sphere('cream raccoon muzzle',(0,-.35,.97),(.22,.15,.14),PALE,head)
    for s in [-1,1]:
        mask=sphere('raccoon eye mask',(s*.19,-.313,1.115),(.175,.058,.12),'#5E645E',head)
        mask.rotation_euler[1]=s*.15
    face(head,z=1.12,y=-.376,spread=.18,nose_y=-.51,cheeks=False)
    points=[(.24,.17,.31),(.47,.30,.35),(.67,.35,.48),(.79,.31,.68),(.79,.22,.85),(.72,.15,.96)]
    radii=[.12,.15,.16,.15,.12,.018]
    pivot=tail(body,'RingedRaccoonTail',points,radii,color)
    shape=next(obj for obj in pivot.children if obj.type=='MESH')
    shape.data.materials.append(w.mat('#61675F'))
    # One continuous mesh; alternating material bands share the same rings.
    for polygon in shape.data.polygons:
        if len(polygon.vertices)==4:polygon.material_index=(polygon.index//14//6)%2
    return root,body,head

def fox():
    color='#E2B37E'
    root,body,head=actor('fox',color,1.08)
    triangle_ears(head,color,1.30,.37)
    fused('cream fox cheeks',[((0,-.33,.99),(.20,.19,.14)),((-.21,-.25,1.00),(.20,.14,.17)),((.21,-.25,1.00),(.20,.14,.17))],PALE,head,.025)
    face(head,z=1.12,spread=.20,y=-.346,nose_y=-.55)
    tail(body,'CreamTippedFoxTail',[(.22,.18,.31),(.46,.33,.36),(.72,.35,.49),(.88,.27,.74),(.86,.17,.98),(.72,.12,1.14)],[.12,.20,.24,.23,.17,.005],color,PALE)
    scarf(body,'#8BB3BB')
    return root,body,head

BUILDERS={name:globals()[name] for name in NAMES}

def animate(root,body,head):
    scene=bpy.context.scene
    scene.render.fps=24
    scene.frame_start,scene.frame_end=1,96
    tails=[o for o in bpy.context.scene.objects if o.get('role')=='tail']
    for frame,breathe,pitch,yaw in [(1,1,0,-.022),(25,1.012,.022,.022),(49,1,0,-.022),(73,1.012,-.016,.022),(96,1,0,-.022)]:
        body.scale=(1,1,breathe);body.keyframe_insert(data_path='scale',frame=frame)
        head.rotation_euler=(pitch,0,yaw);head.keyframe_insert(data_path='rotation_euler',frame=frame)
        for item in tails:
            item.rotation_euler[2]=.025*math.sin((frame-1)/95*math.tau)
            item.keyframe_insert(data_path='rotation_euler',frame=frame)
    for obj in [body,head,*tails]:
        if obj.animation_data and obj.animation_data.action:obj.animation_data.action.name=root['assetId']+'_idle_'+obj.name
    scene.frame_set(1)

def batch_materials(root):
    """Join only same-material static meshes beneath the same animated control."""
    bins={}
    for obj in list(bpy.context.scene.objects):
        if obj.type!='MESH':continue
        ancestor=obj.parent
        while ancestor and ancestor.get('role') not in ['body','head','tail','companion']:ancestor=ancestor.parent
        bins.setdefault((ancestor.name,obj.data.materials[0].name),[]).append(obj)
    for (parent_name,material),objects in bins.items():
        parent=bpy.data.objects[parent_name]
        for obj in objects:
            bpy.context.view_layer.objects.active=obj
            for modifier in list(obj.modifiers):bpy.ops.object.modifier_apply(modifier=modifier.name)
            matrix=obj.matrix_world.copy();obj.parent=parent;obj.matrix_world=matrix
        if len(objects)>1:
            bpy.ops.object.select_all(action='DESELECT')
            for obj in objects:obj.select_set(True)
            bpy.context.view_layer.objects.active=objects[0]
            bpy.ops.object.join();objects[0].name=parent_name+'_'+material

def build(asset,output):
    w.reset()
    root,body,head=BUILDERS[asset]()
    batch_materials(root)
    animate(root,body,head)
    w.setup_render('bunny')
    bpy.ops.file.pack_all()
    bpy.ops.wm.save_as_mainfile(filepath=str(output/(asset+'.blend')),compress=True)
    bpy.ops.export_scene.gltf(filepath=str(output/(asset+'.glb')),export_format='GLB',export_apply=True,export_cameras=False,export_lights=False,export_extras=True,export_yup=True,export_animations=True,export_animation_mode='SCENE',export_anim_scene_split_object=False,export_frame_range=True)
    points=[obj.matrix_world@Vector(corner) for obj in bpy.context.scene.objects if obj.type=='MESH' for corner in obj.bound_box]
    low=[min(p[i] for p in points) for i in range(3)];high=[max(p[i] for p in points) for i in range(3)]
    return {'id':asset,'name':NAMES[asset],'bytes':(output/(asset+'.glb')).stat().st_size,'blenderBounds':{'min':low,'max':high},'meshes':sum(o.type=='MESH' for o in bpy.context.scene.objects)}

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--output',type=Path,required=True)
    parser.add_argument('--asset',choices=list(NAMES),action='append')
    args=parser.parse_args(sys.argv[sys.argv.index('--')+1:])
    output=args.output.resolve();output.mkdir(parents=True,exist_ok=True)
    results=[build(asset,output) for asset in (args.asset or NAMES)]
    report=output/'asset-report.json'
    previous=json.loads(report.read_text()) if report.exists() else []
    merged={item['id']:item for item in [*previous,*results]}
    report.write_text(json.dumps(list(merged.values()),ensure_ascii=False,indent=2))
    print('WORD_ISLAND_COMPANIONS_COMPLETE',json.dumps(results,ensure_ascii=False),flush=True)

if __name__=='__main__':main()
