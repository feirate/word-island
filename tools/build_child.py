"""Create Word Island's original child protagonist with the existing Blender.

Blender Z-up / front -Y exports as glTF Y-up / front +Z. No downloaded assets.
The fox guide, existing companions and environment files are left untouched.
"""
from __future__ import annotations
import argparse
import json
import math
import sys
from pathlib import Path

import bpy
from mathutils import Vector

sys.path.insert(0,str(Path(__file__).resolve().parent))
import build_world as w

SKIN='#E8B993'
HAIR='#5D4638'
SHIRT='#F4EAD5'
GREEN='#7B9775'
INK='#3B3E35'


def sphere(name,point,radii,color,parent=None,segments=18):
    return w.ball(name,point,radii,color,parent,segments)


def fused(name,parts,color,parent,voxel=.035):
    shape=w.fuse([sphere(name+' mass',point,radii,color) for point,radii in parts],name,color,voxel)
    return w.parent_keep(shape,parent)


def face_front(x,z):
    return -.015-.34*math.sqrt(max(.05,1-(x/.43)**2-((z-1.55)/.43)**2))


def child():
    root=w.group('ChildExplorer',role='hero',assetId='child',characterName='小探险家')
    body=w.group('ChildBreathingBody',root,role='body')
    # Feet and lower legs remain fixed while the chest breathes.
    for side in [-1,1]:
        sphere('grounded rounded shoe',(side*.165,-.085,.105),(.15,.225,.105),'#6C7D62',root)
        w.box('cream shoe sole',(side*.165,-.085,.035),(.28,.405,.07),'#F0DDAC',root,.035)
        sphere('short sock',(side*.165,.0,.235),(.103,.108,.10),SHIRT,root)
        sphere('child lower leg',(side*.165,.015,.385),(.099,.109,.205),SKIN,root)
    # The T-shirt has a continuous torso/sleeve silhouette rather than floating parts.
    fused('soft T shirt',[
        ((0,.015,.91),(.29,.205,.30)),
        ((0,.018,1.075),(.255,.185,.13)),
        ((-.295,.015,1.005),(.135,.165,.18)),
        ((.295,.015,1.005),(.135,.165,.18)),
    ],SHIRT,body,.031)
    sphere('short human neck',(0,.0,1.205),(.105,.115,.125),SKIN,body)
    fused('green short overalls',[
        ((0,.015,.665),(.305,.21,.19)),
        ((-.155,.015,.57),(.15,.19,.15)),
        ((.155,.015,.57),(.15,.19,.15)),
    ],GREEN,body,.032)
    w.box('overall bib',(0,-.197,.935),(.38,.075,.36),GREEN,body,.075)
    w.box('overall front pocket',(0,-.245,.865),(.19,.03,.13),'#96AA86',body,.03)
    for side in [-1,1]:
        w.tube('overall shoulder strap',[
            (side*.15,.17,1.145),(side*.165,-.015,1.175),
            (side*.16,-.17,1.115),(side*.15,-.244,1.035),
        ],[.028,.03,.029,.026],GREEN,body,10)
        sphere('overall wooden button',(side*.15,-.28,1.03),(.032,.014,.032),'#D7AD60',body,14)
        arm=sphere('rounded forearm',(side*.382,-.015,.805),(.093,.104,.19),SKIN,body)
        arm.rotation_euler[1]=side*.12
        sphere('soft mitten hand',(side*.402,-.04,.645),(.10,.112,.12),SKIN,body)
    # An attached orange backpack helps distinguish the protagonist in the room.
    pack=w.group('ChildBackpack',body)
    w.box('orange backpack',(0,.285,.89),(.46,.245,.49),'#CF9561',pack,.13)
    w.box('backpack flap',(0,.315,1.13),(.49,.27,.145),'#E0B77E',pack,.065)
    w.box('backpack front pocket',(0,.434,.825),(.27,.075,.205),'#E0B77E',pack,.05)
    w.box('backpack buckle',(0,.478,.92),(.075,.022,.085),'#E9CE88',pack,.014)
    for side in [-1,1]:
        w.tube('orange backpack strap',[
            (side*.235,.27,1.105),(side*.285,.16,1.18),
            (side*.295,-.02,1.185),(side*.285,-.19,1.10),
            (side*.27,-.235,.95),(side*.285,-.20,.80),
            (side*.30,-.06,.75),(side*.27,.13,.77),(side*.20,.22,.80),
        ],[.026,.027,.027,.027,.027,.027,.026,.026,.025],'#CF9561',body,10)
    # One linked head includes the ears, face, hair, eyes and smile.
    head=w.group('ChildLinkedHead',body,(0,0,1.24),role='head')
    sphere('round child face',(0,-.015,1.55),(.43,.34,.43),SKIN,head,24)
    for side in [-1,1]:
        sphere('human ear',(side*.425,.015,1.53),(.075,.085,.115),SKIN,head,18)
        sphere('ear inner',(side*.438,-.061,1.53),(.034,.017,.060),'#D69F85',head,16)
        x=side*.155
        sphere('glossy child eye',(x,face_front(x,1.56)-.011,1.56),(.043,.026,.061),INK,head,18)
        sphere('child eye highlight',(x-.010,face_front(x,1.56)-.034,1.582),(.011,.008,.014),'paper',head,12)
        cheek_x=side*.255
        sphere('warm cheek',(cheek_x,face_front(cheek_x,1.43)-.006,1.43),(.05,.018,.027),'#D99B87',head,16)
        brow=[(x-side*.055,face_front(x-side*.055,1.665)-.011,1.665),
              (x,face_front(x,1.68)-.011,1.68),
              (x+side*.05,face_front(x+side*.05,1.667)-.011,1.667)]
        w.tube('gentle eyebrow',brow,[.012,.014,.010],HAIR,head,8)
    sphere('small human button nose',(0,face_front(0,1.46)-.025,1.46),(.045,.049,.044),'#DEAA86',head,18)
    smile=[(-.083,face_front(-.083,1.375)-.01,1.375),
           (-.045,face_front(-.045,1.354)-.01,1.354),
           (0,face_front(0,1.347)-.01,1.347),
           (.045,face_front(.045,1.354)-.01,1.354),
           (.083,face_front(.083,1.375)-.01,1.375)]
    w.tube('little friendly smile',smile,[.007,.009,.009,.009,.007],'#915E49',head,8)
    fused('continuous short brown hair',[
        ((0,.05,1.755),(.44,.335,.275)),
        ((0,.135,1.64),(.415,.25,.31)),
        ((-.235,-.235,1.79),(.17,.12,.15)),
        ((-.06,-.285,1.79),(.17,.105,.16)),
        ((.13,-.265,1.81),(.17,.11,.14)),
        ((.29,-.19,1.79),(.12,.12,.14)),
    ],HAIR,head,.030)
    # A tiny sculpted crown lock belongs to the same head, not a detached decoration.
    tuft=sphere('short crown lock',(-.08,.035,1.98),(.13,.11,.075),HAIR,head,18)
    tuft.rotation_euler[1]=-.3
    return root,body,head


def batch_materials():
    bins={}
    for obj in list(bpy.context.scene.objects):
        if obj.type!='MESH':continue
        ancestor=obj.parent
        while ancestor and ancestor.get('role') not in ['hero','body','head']:ancestor=ancestor.parent
        bins.setdefault((ancestor.name,obj.data.materials[0].name),[]).append(obj)
    for (parent_name,_),objects in bins.items():
        parent=bpy.data.objects[parent_name]
        for obj in objects:
            bpy.context.view_layer.objects.active=obj
            for mod in list(obj.modifiers):bpy.ops.object.modifier_apply(modifier=mod.name)
            matrix=obj.matrix_world.copy();obj.parent=parent;obj.matrix_world=matrix
        if len(objects)>1:
            bpy.ops.object.select_all(action='DESELECT')
            for obj in objects:obj.select_set(True)
            bpy.context.view_layer.objects.active=objects[0]
            bpy.ops.object.join();objects[0].name=parent_name+'_'+objects[0].data.materials[0].name


def animate(root,body,head):
    scene=bpy.context.scene;scene.render.fps=24;scene.frame_start=1;scene.frame_end=96
    for frame,breathe,pitch,yaw in [(1,1,0,-.018),(25,1.008,.018,.018),(49,1,0,-.018),(73,1.008,-.014,.018),(96,1,0,-.018)]:
        body.scale=(1,1,breathe);body.keyframe_insert(data_path='scale',frame=frame)
        head.rotation_euler=(pitch,0,yaw);head.keyframe_insert(data_path='rotation_euler',frame=frame)
    for obj in [body,head]:
        if obj.animation_data and obj.animation_data.action:obj.animation_data.action.name='child_idle_'+obj.name
    scene.frame_set(1)


def build_scene(output_dir):
    w.reset();root,body,head=child();batch_materials();animate(root,body,head)
    w.setup_render('hero');bpy.ops.file.pack_all()
    bpy.ops.wm.save_as_mainfile(filepath=str(output_dir/'child.blend'),compress=True)
    bpy.ops.export_scene.gltf(filepath=str(output_dir/'child.glb'),export_format='GLB',export_apply=True,export_cameras=False,export_lights=False,export_extras=True,export_yup=True,export_animations=True,export_animation_mode='SCENE',export_anim_scene_split_object=False,export_frame_range=True)
    points=[obj.matrix_world@Vector(corner) for obj in bpy.context.scene.objects if obj.type=='MESH' for corner in obj.bound_box]
    low=[min(p[i] for p in points) for i in range(3)];high=[max(p[i] for p in points) for i in range(3)]
    report={'asset':'child','bytes':(output_dir/'child.glb').stat().st_size,'blenderBounds':{'min':low,'max':high},'meshes':sum(obj.type=='MESH' for obj in bpy.context.scene.objects)}
    (output_dir/'child-report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
    print('WORD_ISLAND_CHILD_COMPLETE',json.dumps(report),flush=True)
    return {'title':'词遇岛小探险家','camera':[3,2.7,4.8],'target':[0,1,0]}


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--output',type=Path,required=True)
    args=parser.parse_args(sys.argv[sys.argv.index('--')+1:]);output=args.output.resolve();output.mkdir(parents=True,exist_ok=True)
    build_scene(output)


if __name__=='__main__':main()
