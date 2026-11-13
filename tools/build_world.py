"""Build Word Island's original miniature assets inside Blender 4.5 LTS.

Usage:
  Blender --background --python tools/build_world.py -- --output assets/models
Coordinates: Blender Z-up / front -Y; glTF Y-up / front +Z.
No external textures, downloaded characters, or paid asset services are used.
"""
from __future__ import annotations

import argparse
import json
import math
import random
import sys
from pathlib import Path

import bpy
from mathutils import Vector


COLORS = {
    'cream': '#F7EDD6', 'wall': '#E8DCC3', 'trim': '#FAF3E5',
    'wood': '#AA7952', 'woodLight': '#C79865', 'woodDark': '#72543E',
    'floor': '#D2AD7E', 'floorAlt': '#DDB98D', 'green': '#527D62',
    'mint': '#8FAF85', 'grass': '#91B480', 'grassLight': '#B1C797',
    'leaf': '#61895D', 'leafDark': '#426A51', 'gold': '#E8BC68',
    'orange': '#D99B58', 'orangeLight': '#E9B46F', 'rust': '#BA7551',
    'pink': '#D99E99', 'ink': '#343C37', 'blue': '#A6CDD4',
    'water': '#78B5BC', 'stone': '#B3B7A6', 'red': '#AD675A',
    'paper': '#FAF5E8', 'milk': '#CDDDE1', 'bunny': '#F1E6D1',
}
MATERIALS = {}
RNG = random.Random(2047)


def linear_hex(value):
    vals = [int(value[i:i + 2], 16) / 255 for i in (1, 3, 5)]
    return tuple(v / 12.92 if v <= .04045 else ((v + .055) / 1.055) ** 2.4 for v in vals) + (1,)


def mat(key):
    if key in MATERIALS:
        return MATERIALS[key]
    m = bpy.data.materials.new('WI_' + key)
    m.use_nodes = True
    color = linear_hex(COLORS.get(key, key))
    m.diffuse_color = color
    bsdf = m.node_tree.nodes.get('Principled BSDF')
    bsdf.inputs['Base Color'].default_value = color
    bsdf.inputs['Roughness'].default_value = .73 if key != 'ink' else .38
    MATERIALS[key] = m
    return m


def parent_keep(obj, parent):
    if parent:
        obj.parent = parent
        obj.matrix_parent_inverse = parent.matrix_world.inverted()
    return obj


def group(name, parent=None, location=(0, 0, 0), **extras):
    obj = bpy.data.objects.new(name, None)
    bpy.context.collection.objects.link(obj)
    obj.location = location
    for key, value in extras.items():
        obj[key] = value
    bpy.context.view_layer.update()
    parent_keep(obj, parent)
    return obj


def finish(obj, name, color, parent=None, smooth=False):
    obj.name = name
    obj.data.materials.append(mat(color))
    if smooth:
        for p in obj.data.polygons:
            p.use_smooth = True
    return parent_keep(obj, parent)


def box(name, loc, scale, color, parent=None, bevel=.06, rotation=None):
    bpy.ops.mesh.primitive_cube_add(size=1, location=loc)
    obj = bpy.context.object
    obj.dimensions = scale
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    if bevel:
        mod = obj.modifiers.new('soft crafted edges', 'BEVEL')
        mod.width = min(bevel, min(scale) * .38)
        mod.segments = 3
        obj.modifiers.new('weighted face normals', 'WEIGHTED_NORMAL')
    if rotation:
        obj.rotation_euler = rotation
    return finish(obj, name, color, parent)


def ball(name, loc, scale, color, parent=None, segments=24):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=segments, ring_count=16, radius=1, location=loc)
    obj = bpy.context.object
    obj.scale = scale
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    return finish(obj, name, color, parent, True)


def cylinder(name, loc, radius, depth, color, parent=None, radius2=None, vertices=32):
    bpy.ops.mesh.primitive_cone_add(vertices=vertices, radius1=radius, radius2=radius if radius2 is None else radius2, depth=depth, location=loc)
    obj = bpy.context.object
    mod = obj.modifiers.new('rounded rim', 'BEVEL')
    mod.width = min(.035, depth * .18, radius * .12)
    mod.segments = 2
    obj.modifiers.new('weighted normals', 'WEIGHTED_NORMAL')
    return finish(obj, name, color, parent)


def rod(name, a, b, radius, color, parent=None):
    midpoint = (Vector(a) + Vector(b)) / 2
    obj = cylinder(name, midpoint, radius, (Vector(b) - Vector(a)).length, color)
    obj.rotation_euler = (Vector(b) - Vector(a)).to_track_quat('Z', 'Y').to_euler()
    return parent_keep(obj, parent)


def mesh(name, vertices, faces, color, parent=None, bevel=0):
    data = bpy.data.meshes.new(name)
    data.from_pydata(vertices, [], faces)
    data.update()
    obj = bpy.data.objects.new(name, data)
    bpy.context.collection.objects.link(obj)
    if bevel:
        mod = obj.modifiers.new('soft edge', 'BEVEL')
        mod.width, mod.segments = bevel, 3
        obj.modifiers.new('weighted normals', 'WEIGHTED_NORMAL')
    return finish(obj, name, color, parent)


def tube(name, points, radii, color, parent=None, segments=14):
    """Closed, continuously tapering tube, used for leaves, tails and handles."""
    verts = []
    for i, (point, radius) in enumerate(zip(points, radii)):
        tangent = Vector(points[min(i + 1, len(points) - 1)]) - Vector(points[max(0, i - 1)])
        tangent.normalize()
        side = tangent.cross(Vector((0, 0, 1)))
        if side.length < .1:
            side = tangent.cross(Vector((0, 1, 0)))
        side.normalize()
        up = tangent.cross(side).normalized()
        for s in range(segments):
            angle = 2 * math.pi * s / segments
            v = Vector(point) + radius * (side * math.cos(angle) + up * math.sin(angle))
            verts.append(tuple(v))
    faces = []
    for i in range(len(points) - 1):
        for s in range(segments):
            n = (s + 1) % segments
            faces.append((i * segments + s, i * segments + n, (i + 1) * segments + n, (i + 1) * segments + s))
    faces.append(tuple(reversed(range(segments))))
    faces.append(tuple((len(points) - 1) * segments + s for s in range(segments)))
    obj = mesh(name, verts, faces, color, parent)
    for p in obj.data.polygons:
        p.use_smooth = True
    return obj


def fuse(parts, name, color, voxel=.045):
    """Fuse intersecting organic masses into a single coherent surface."""
    bpy.ops.object.select_all(action='DESELECT')
    for obj in parts:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = parts[0]
    bpy.ops.object.join()
    obj = parts[0]
    obj.name = name
    obj.data.materials.clear()
    obj.data.materials.append(mat(color))
    remesh = obj.modifiers.new('continuous character surface', 'REMESH')
    remesh.mode = 'VOXEL'
    remesh.voxel_size = voxel
    remesh.use_smooth_shade = True
    bpy.ops.object.modifier_apply(modifier=remesh.name)
    smooth = obj.modifiers.new('soft silhouette', 'SMOOTH')
    smooth.factor, smooth.iterations = .65, 4
    bpy.ops.object.modifier_apply(modifier=smooth.name)
    decimate = obj.modifiers.new('mobile mesh', 'DECIMATE')
    decimate.ratio = .6
    bpy.ops.object.modifier_apply(modifier=decimate.name)
    for p in obj.data.polygons:
        p.use_smooth = True
    return obj


def flower(x, y, parent, color='cream', z=.05):
    rod('flower stem', (x, y, z), (x, y, z + .27), .018, 'green', parent)
    for i in range(5):
        angle = i * math.tau / 5
        ball('petal', (x + math.cos(angle) * .075, y + math.sin(angle) * .075, z + .29), (.075, .05, .035), color, parent, 12)
    ball('pollen', (x, y, z + .31), (.048, .048, .025), 'gold', parent, 12)


def plant(x, y, z, parent, size=1):
    cylinder('terracotta plant pot', (x, y, z + .18 * size), .23 * size, .36 * size, 'rust', parent, radius2=.29 * size)
    cylinder('pot lip', (x, y, z + .36 * size), .30 * size, .07 * size, 'rust', parent)
    cylinder('soil', (x, y, z + .37 * size), .24 * size, .02 * size, 'woodDark', parent)
    for i in range(5):
        a = math.tau * i / 5 + .5
        tip = (x + math.cos(a) * .34 * size, y + math.sin(a) * .34 * size, z + (.72 + i % 2 * .11) * size)
        leaf = ball('plant leaf', tip, (.10 * size, .18 * size, .25 * size), 'leaf' if i % 2 else 'green', parent, 16)
        leaf.rotation_euler = (.3 * math.sin(a), .5 * math.cos(a), a)
        rod('leaf stem', (x, y, z + .38 * size), tip, .025 * size, 'green', parent)


def tree(x, y, size, parent, seed):
    rod('tree trunk', (x, y, .0), (x + .08, y, 1.85 * size), .19 * size, 'wood', parent)
    for i, (dx, dy, z, s) in enumerate([(-.35, .0, 1.55, .79), (.32, .05, 1.95, .86), (-.12, -.10, 2.40, .74)]):
        leaf = ball('sculpted canopy', (x + dx * size, y + dy * size, z * size), (s * size, .69 * size, .75 * size), 'leafDark' if i == 0 else 'leaf', parent, 20)
        leaf.rotation_euler[2] = seed * .3 + i
    for i in range(3):
        ball('tree fruit', (x + (i - 1) * .36 * size, y - .55 * size, (1.8 + i % 2 * .35) * size), (.10 * size,) * 3, 'gold', parent, 12)


def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.context.preferences.filepaths.save_version = 0
    MATERIALS.clear()
    RNG.seed(2047)


def build_home():
    root = group('Home', role='environment', assetId='home')
    box('rounded foundation', (0, 0, -.29), (10.2, 7.25, .55), 'cream', root, .28)
    box('timber foundation edge', (0, 0, -.055), (9.9, 7.0, .14), 'woodLight', root, .09)
    for i in range(16):
        box('floorboard', (-4.65 + i * .62, 0, .035), (.60, 6.85, .09), 'floor' if i % 3 else 'floorAlt', root, .015)
    # Real gaps in the back wall for the window and the door.
    box('back lower wall', (-1.4, 3.35, .57), (6.9, .20, 1.14), 'wall', root, .03)
    box('back upper wall', (-1.4, 3.35, 3.14), (6.9, .20, 1.02), 'wall', root, .03)
    box('back left jamb', (-3.98, 3.35, 1.91), (1.74, .20, 1.54), 'wall', root, .03)
    box('back window right', (.85, 3.35, 1.91), (2.4, .20, 1.54), 'wall', root, .03)
    box('door right jamb', (4.2, 3.35, 1.82), (1.3, .20, 3.64), 'wall', root, .03)
    box('door lintel', (2.85, 3.35, 3.10), (1.4, .20, 1.08), 'wall', root, .03)
    box('left wall', (-4.94, .0, 1.82), (.20, 6.9, 3.64), 'wall', root, .03)
    box('back top trim', (0, 3.35, 3.67), (10.1, .31, .13), 'trim', root, .03)
    box('left top trim', (-4.94, 0, 3.67), (.31, 6.9, .13), 'trim', root, .03)
    box('left skirting', (-4.80, 0, .15), (.10, 6.8, .21), 'trim', root, .025)
    # Window glazing and timber frame.
    box('window glass', (-1.75, 3.34, 1.91), (2.65, .055, 1.55), 'blue', root, .02)
    for x in [-3.10, -.40, -1.75]:
        box('window vertical frame', (x, 3.17, 1.91), (.095, .21, 1.7), 'trim', root, .02)
    for z in [1.08, 1.91, 2.74]:
        box('window horizontal frame', (-1.75, 3.17, z), (2.8, .21, .095), 'trim', root, .02)
    box('deep window sill', (-1.75, 3.10, 1.05), (3.0, .48, .16), 'woodLight', root, .04)
    # Door and readable handle, grouped for actual raycasting.
    door = group('DepartureDoor', root, interactionId='home.door', interactionLabel='出发冒险')
    box('door leaf', (2.85, 3.31, 1.28), (1.38, .14, 2.49), 'green', door, .11)
    for x in [2.1, 3.6]:
        box('door frame', (x, 3.20, 1.29), (.12, .24, 2.62), 'trim', door, .025)
    box('door frame top', (2.85, 3.20, 2.58), (1.62, .24, .14), 'trim', door, .025)
    box('door inset', (2.85, 3.21, 1.66), (.92, .045, .87), 'mint', door, .08)
    ball('door knob', (3.30, 3.14, 1.13), (.075, .075, .075), 'gold', door, 16)
    box('welcome mat', (2.85, 2.55, .105), (1.7, .75, .05), 'rust', root, .10)
    # Open bookcase.
    shelf = group('Bookshelf', root, interactionId='home.bookshelf', interactionLabel='选择教材')
    box('shelf back', (-3.65, 2.33, 1.27), (1.6, .10, 2.40), 'wood', shelf, .04)
    for x in [-4.48, -2.82]:
        box('shelf upright', (x, 2.06, 1.27), (.14, .62, 2.53), 'woodLight', shelf, .03)
    for z in [.12, .87, 1.62, 2.52]:
        box('shelf board', (-3.65, 2.05, z), (1.8, .67, .13), 'woodLight', shelf, .03)
    for row, z in enumerate([.22, .97, 1.72]):
        for i in range(5):
            x = -4.28 + .255 * i
            h = [.48, .56, .42, .58, .50][(i + row) % 5]
            color = ['green', 'red', 'cream', 'blue', 'gold'][(i + row) % 5]
            book = box('colored textbook spine', (x, 1.99, z + h / 2), (.19, .40, h), color, shelf, .02)
            book.rotation_euler[1] = .06 if i == 3 else 0
            box('book spine band', (x, 1.778, z + h * .72), (.14, .018, .035), 'paper', shelf, .004)
    # Seven-space clue board, stationary and interactive.
    board = group('ClueBoard', root, interactionId='home.clues', interactionLabel='查看伙伴线索')
    box('clue board frame', (.85, 3.13, 2.22), (2.15, .14, 1.20), 'woodDark', board, .10)
    box('clue board cork', (.85, 3.02, 2.22), (1.97, .045, 1.03), 'woodLight', board, .05)
    for i in range(7):
        row, col = (0, i) if i < 4 else (1, i - 4)
        x = .15 + col * .46 + (0 if row == 0 else .23)
        z = 2.48 - row * .50
        box('clue note slot', (x, 2.98, z), (.34, .02, .34), 'paper', board, .025, (0, .04 * (i % 3 - 1), 0))
        ball('note pin', (x, 2.945, z + .11), (.025, .025, .025), 'red' if i % 2 else 'green', board, 12)
    # Cozy bed and blanket.
    bed = group('CozyBed', root)
    for x in [-4.1, -2.55]:
        for y in [-2.2, -.10]:
            cylinder('bed leg', (x, y, .26), .09, .45, 'wood', bed)
    box('bed frame', (-3.33, -1.15, .39), (1.90, 2.45, .26), 'woodLight', bed, .10)
    box('headboard', (-3.33, .11, .80), (1.95, .15, 1.03), 'woodLight', bed, .12)
    box('mattress', (-3.33, -1.15, .63), (1.78, 2.26, .32), 'cream', bed, .16)
    box('quilt', (-3.33, -1.61, .81), (1.79, 1.38, .16), 'green', bed, .12)
    for x in [-3.82, -3.32, -2.82]:
        box('quilt stitch', (x, -1.61, .895), (.026, 1.18, .012), 'mint', bed, .004)
    box('pillow', (-3.33, -.38, .84), (1.26, .60, .20), 'paper', bed, .20)
    rug = cylinder('round woven rug', (.25, -.55, .095), 1.63, .035, 'rust', root, vertices=64)
    rug.scale.y = .85
    ring = cylinder('rug inner weave', (.25, -.55, .116), 1.36, .013, 'orangeLight', root, vertices=64)
    ring.scale.y = .85
    # Bunny's dedicated, empty arrival cushion.
    cushion = group('CompanionPlace', root, interactionId='home.bunny', interactionLabel='伙伴的小角落')
    cylinder('companion floor cushion', (2.6, -1.30, .15), .78, .20, 'mint', cushion, vertices=48)
    cylinder('cushion top', (2.6, -1.30, .27), .69, .08, 'cream', cushion, vertices=48)
    bowl = cylinder('companion bowl', (3.60, -1.68, .22), .32, .30, 'rust', root, radius2=.37)
    cylinder('bowl inside', (3.60, -1.68, .377), .29, .016, 'woodDark', root)
    # Small writing desk at the back.
    for x in [-1.22, .02]:
        for y in [1.42, 2.12]:
            rod('desk leg', (x, y, .08), (x, y, .95), .055, 'wood', root)
    box('little desk', (-.60, 1.78, 1.0), (1.53, 1.02, .14), 'woodLight', root, .08)
    box('open journal left', (-.8, 1.65, 1.09), (.42, .52, .04), 'paper', root, .015, (0, .06, -.05))
    box('open journal right', (-.39, 1.65, 1.09), (.42, .52, .04), 'paper', root, .015, (0, -.06, .05))
    cylinder('lamp base', (-.98, 2.03, 1.09), .17, .06, 'green', root)
    rod('lamp stem', (-.98, 2.03, 1.12), (-.98, 2.03, 1.52), .035, 'woodDark', root)
    cylinder('lamp shade', (-.98, 2.03, 1.60), .27, .25, 'gold', root, radius2=.17)
    plant(4.15, 2.45, .08, root, 1.20)
    plant(-4.0, -2.85, .08, root, .65)
    # A framed mountain picture on the left wall.
    box('picture frame', (-4.78, .0, 2.44), (.12, 1.25, .92), 'woodDark', root, .04)
    box('picture canvas', (-4.70, .0, 2.44), (.03, 1.10, .77), 'blue', root, .01)
    ball('picture sun', (-4.67, -.31, 2.61), (.02, .10, .10), 'gold', root, 16)
    return root


def island(parent):
    n = 40
    radii = [4.62 + .15 * math.sin(i * 2.4) + .09 * math.cos(i * 4) for i in range(n)]
    verts = []
    for z, factor in [(-.55, .93), (-.12, 1), (.0, 1)]:
        for i, r in enumerate(radii):
            angle = i * math.tau / n
            verts.append((math.cos(angle) * r * factor, math.sin(angle) * r * .86 * factor, z))
    faces = []
    for row in range(2):
        for i in range(n):
            j = (i + 1) % n
            faces.append((row*n+i, row*n+j, (row+1)*n+j, (row+1)*n+i))
    faces.extend([tuple(reversed(range(n))), tuple(2*n+i for i in range(n))])
    mesh('soft island earth', verts, faces, 'woodLight', parent, .08)
    top = cylinder('island meadow', (0, 0, .025), 4.60, .06, 'grass', parent, vertices=64)
    top.scale.y = .86


def tent(x, y, parent):
    w, d, h = 1.20, 1.02, 1.85
    # Solid fabric roof slopes and back wall, with an open front entrance.
    verts = [(x-w,y-d,.05),(x,y-d,h),(x+w,y-d,.05),(x-w,y+d,.05),(x,y+d,h),(x+w,y+d,.05)]
    obj = mesh('canvas tent', verts, [(0,3,4,1),(1,4,5,2),(3,5,4)], 'gold', parent)
    sol = obj.modifiers.new('canvas thickness', 'SOLIDIFY'); sol.thickness=.045
    box('tent groundsheet', (x,y,.07), (2*w,2*d,.08), 'woodDark', parent, .04)
    for yy in [y-d,y+d]:
        rod('tent ridge pole', (x-w-.08,yy,.02),(x,yy,h+.08), .04,'wood',parent)
        rod('tent ridge pole', (x+w+.08,yy,.02),(x,yy,h+.08), .04,'wood',parent)
    rod('tent top ridge', (x,y-d-.15,h+.03),(x,y+d+.15,h+.03),.035,'woodDark',parent)
    box('tent rolled blanket',(x,y-.25,.19),(1.15,.59,.25),'green',parent,.12)
    for dx in [-1.45,1.45]:
        rod('guy rope',(x+(w if dx>0 else -w),y-d,.60),(x+dx,y-d-.50,.08),.013,'cream',parent)
        rod('tent peg',(x+dx,y-d-.50,.0),(x+dx,y-d-.50,.17),.025,'woodDark',parent)


def crate(x, y, parent):
    root = group('FoodCrate', parent, interactionId='camp.crate', interactionLabel='听音找食物')
    box('crate bottom',(x,y,.18),(1.72,1.10,.20),'wood',root,.045)
    for i in range(3):
        z=.31+i*.17
        for yy in [y-.57,y+.57]:box('crate horizontal slat',(x,yy,z),(1.78,.11,.13),'woodLight',root,.02)
        for xx in [x-.86,x+.86]:box('crate side slat',(xx,y,z),(.11,1.12,.13),'woodLight',root,.02)
    for xx in [x-.79,x+.79]:
        for yy in [y-.49,y+.49]:box('crate corner',(xx,yy,.45),(.12,.13,.67),'wood',root,.02)
    # Milk carton, bowl of rice, and chicken leg, recognizable at scene scale.
    box('milk carton',(x-.45,y+.04,.87),(.40,.40,.72),'paper',root,.025)
    box('milk blue band',(x-.45,y-.171,.84),(.34,.025,.25),'milk',root,.008)
    mesh('milk folded top',[(x-.65,y-.16,1.23),(x-.25,y-.16,1.23),(x-.45,y-.16,1.43),(x-.65,y+.24,1.23),(x-.25,y+.24,1.23),(x-.45,y+.24,1.43)],[(0,1,2),(5,4,3),(0,3,4,1),(0,2,5,3),(1,4,5,2)],'milk',root)
    cylinder('rice bowl',(x+.26,y-.10,.77),.27,.26,'cream',root,radius2=.34)
    ball('rice mound',(x+.26,y-.10,.96),(.29,.29,.13),'paper',root)
    for i in range(9):
        a=i*2.4
        ball('rice grain',(x+.26+math.sin(a)*.19,y-.10+math.cos(a)*.19,1.04),(.022,.047,.018),'cream',root,12)
    meat=ball('chicken leg',(x+.61,y+.19,1.02),(.22,.16,.28),'orange',root)
    meat.rotation_euler[1]=-.7
    rod('chicken bone',(x+.72,y+.19,1.19),(x+.91,y+.19,1.38),.045,'paper',root)
    for dx in [-.04,.04]:ball('chicken bone cap',(x+.91+dx,y+.19,1.38),(.06,.055,.065),'paper',root,12)
    return root


def chest(x, y, parent):
    root=group('ClueChest',parent,interactionId='camp.chest',interactionLabel='领取今日线索')
    box('chest base',(x,y,.32),(1.35,.90,.58),'wood',root,.12)
    for xx in [x-.42,x+.42]:box('chest metal strap',(xx,y,.33),(.10,.94,.59),'gold',root,.025)
    hinge=group('ChestLid',root,(x,y+.43,.61),motionRole='lid')
    box('chest lid',(x,y,.65),(1.39,.94,.22),'woodLight',hinge,.10)
    for xx in [x-.42,x+.42]:box('lid metal strap',(xx,y,.75),(.11,.91,.045),'gold',hinge,.02)
    box('chest lock',(x,y-.50,.51),(.20,.06,.25),'gold',root,.04)
    ball('lock keyhole',(x,y-.54,.53),(.03,.014,.04),'woodDark',root,12)
    return root


def build_camp():
    root=group('Camp',role='environment',assetId='camp')
    island(root)
    tent(-2.1,1.50,root)
    tree(-3.30,2.1,1.10,root,1)
    tree(3.10,2.45,1.05,root,3)
    tree(3.75,1.03,.72,root,2)
    # A small pond and an actual plank footbridge.
    pond=cylinder('pond water',(1.38,2.42,.075),1.12,.035,'water',root,vertices=48)
    pond.scale.y=.61
    for i in range(6):
        box('bridge plank',(1.36+(i-2.5)*.22,2.40,.17),(.205,.80,.09),'woodLight',root,.022)
    for yy in [2.03,2.78]:
        rod('bridge rail',(0.66,yy,.22),(2.1,yy,.22),.045,'wood',root)
    for i in range(9):
        y=-3.25+i*.55
        x=.10+math.sin(i*.65)*.40
        stone=ball('path stepping stone',(x,y,.075),(.38,.26,.07),'stone',root,16)
        stone.rotation_euler.z=i*.3
    crate(-2.50,-.9,root)
    sign=group('WordSign',root,interactionId='camp.sign',interactionLabel='拼词告示牌')
    box('sign post',(.40,.80,.61),(.15,.16,1.23),'wood',sign,.03)
    box('sign board',(.40,.80,1.23),(1.32,.15,.72),'woodLight',sign,.08)
    box('sign green face',(.40,.701,1.23),(1.15,.035,.55),'green',sign,.04)
    for i in range(3):box('sign word tile',(.04+i*.36,.668,1.23),(.25,.025,.29),'cream',sign,.025)
    post=group('VoiceMailbox',root,interactionId='camp.mailbox',interactionLabel='听原音与跟读')
    cylinder('mailbox post',(2.8,.20,.53),.095,1.05,'wood',post)
    box('mailbox body',(2.8,.20,1.13),(.72,.66,.57),'red',post,.18)
    box('mailbox opening',(2.8,-.147,1.13),(.42,.025,.075),'woodDark',post,.02)
    box('mailbox flag',(3.19,.20,1.45),(.04,.39,.20),'gold',post,.025)
    rod('mailbox flag rod',(3.19,.20,1.06),(3.19,.20,1.51),.023,'woodDark',post)
    chest(1.60,-1.80,root)
    # Compact log stool, basket, stones and low wildflowers.
    cylinder('log stool',(-.85,-1.30,.25),.30,.48,'wood',root)
    cylinder('stool cut surface',(-.85,-1.30,.50),.29,.035,'woodLight',root)
    for i in range(13):
        angle=math.tau*i/13
        r=3.5+RNG.random()*.65
        x,y=math.cos(angle)*r,math.sin(angle)*r*.76
        if x<-2 and y>1:continue
        flower(x,y,root,'cream' if i%3 else 'gold',.06)
    for x,y,s in [(-3.5,-1.7,.3),(3.3,-1.9,.35),(2.4,3.0,.26),(-1.0,3.1,.21)]:
        ball('smooth river stone',(x,y,.10),(.5*s,.8*s,.5*s),'stone',root,16)
    for x,y in [(-3.3,-2.2),(-3.45,-2.1),(2.85,-2.3),(3.0,-2.2)]:
        tube('meadow leaf',[(x,y,.04),(x+.03,y,.27),(x+.1,y,.42)],[.04,.035,.002],'leaf',root,10)
    return root


def ear(name, loc, height, width, color, parent, tilt=0):
    x,y,z=loc
    # Rounded triangular solid ear, rather than a flat triangle or cone.
    points=[(x-width*.5,y,z),(x+width*.5,y,z),(x+width*.25,y+.045,z+height*.48),(x,y+.035,z+height),(x-width*.25,y+.045,z+height*.48)]
    thickness=.14
    verts=[(px,py-thickness*.5,pz) for px,py,pz in points]+[(px,py+thickness*.5,pz) for px,py,pz in points]
    faces=[tuple(reversed(range(5))),tuple(range(5,10))]+[(i,(i+1)%5,(i+1)%5+5,i+5) for i in range(5)]
    obj=mesh(name,verts,faces,color,parent,.05)
    return obj


def face_details(head, bunny=False):
    eye_y=-.367 if bunny else -.372
    eye_z=1.11 if bunny else 1.34
    x=.17 if bunny else .223
    for sign in [-1,1]:
        ball('left eye' if sign<0 else 'right eye',(sign*x,eye_y,eye_z),(.038,.032,.060 if bunny else .055),'ink',head,16)
        ball('eye catchlight',(sign*x-.009,eye_y-.026,eye_z+.020),(.010,.009,.013),'paper',head,12)
        ball('soft cheek',(sign*(x+.075),eye_y+.006,eye_z-.10),(.058,.018,.032),'pink',head,16)
    nose_z=.98 if bunny else 1.20
    ball('little nose',(0,-.464 if bunny else -.570,nose_z),(.048,.032,.034),'pink' if bunny else 'ink',head,16)
    for sign in [-1,1]:
        tube('smile',[(0,-.450 if bunny else -.546,nose_z-.025),(sign*.035,-.446 if bunny else -.540,nose_z-.055),(sign*.070,-.438 if bunny else -.520,nose_z-.045)],[.009,.009,.007],'woodDark',head,10)


def animate_idle(root, body, head, ears, name):
    scene=bpy.context.scene
    scene.render.fps=24
    scene.frame_start,scene.frame_end=1,96
    for f,breathe,pitch,yaw in [(1,1,0,-.025),(25,1.018,.025,.025),(49,1,0,-.025),(73,1.018,-.018,.025),(96,1,0,-.025)]:
        body.scale=(1,1,breathe)
        body.keyframe_insert(data_path='scale',frame=f)
        head.rotation_euler=(pitch,0,yaw)
        head.keyframe_insert(data_path='rotation_euler',frame=f)
        for i,e in enumerate(ears):
            e.rotation_euler[1]=(.018 if i==0 else -.018)*math.sin((f-1)/95*math.tau)
            e.keyframe_insert(data_path='rotation_euler',frame=f)
    scene.frame_set(1)
    for obj in [body,head,*ears]:
        if obj.animation_data and obj.animation_data.action:
            obj.animation_data.action.name=name+'_'+obj.name


def build_hero():
    root=group('YayaExplorer',role='hero',assetId='hero',characterName='芽芽')
    body=group('HeroBody',root,role='body')
    parts=[ball('body mass',(0,.035,.65),(.34,.28,.49),'orange'),ball('neck mass',(0,0,1.03),(.26,.24,.26),'orange')]
    for s in [-1,1]:
        parts.append(ball('hip mass',(s*.20,.035,.37),(.20,.23,.26),'orange'))
        parts.append(ball('arm mass',(s*.34,-.02,.69),(.15,.17,.30),'orange'))
    torso=fuse(parts,'Fox continuous torso','orange',.036)
    parent_keep(torso,body)
    # Feet stay on the ground while the chest breathes.
    for s in [-1,1]:
        ball('fox boot',(s*.19,-.13,.12),(.17,.24,.12),'woodDark',root)
        ball('fox paw',(s*.37,-.12,.49),(.12,.13,.13),'woodDark',body)
    ball('cream belly',(0,-.235,.63),(.23,.052,.30),'cream',body)
    head=group('HeroHead',body,(0,0,1.12),role='head')
    parts=[ball('head mass',(0,.0,1.36),(.49,.36,.40),'orangeLight'),ball('left cheek mass',(-.25,-.18,1.24),(.27,.25,.23),'orangeLight'),ball('right cheek mass',(.25,-.18,1.24),(.27,.25,.23),'orangeLight')]
    shape=fuse(parts,'Fox continuous head','orangeLight',.027)
    parent_keep(shape,head)
    muzzle=fuse([ball('muzzle mass',(0,-.345,1.19),(.25,.23,.17),'cream'),ball('left muzzle cheek',(-.20,-.29,1.22),(.22,.15,.17),'cream'),ball('right muzzle cheek',(.20,-.29,1.22),(.22,.15,.17),'cream')],'Fox sculpted cream muzzle','cream',.022)
    parent_keep(muzzle,head)
    ears=[]
    for s in [-1,1]:
        pivot=group('HeroEarLeft' if s<0 else 'HeroEarRight',head,(s*.33,.03,1.55),role='ear')
        ear('orange ear',(s*.33,.03,1.54),.48,.29,'orangeLight',pivot)
        ear('inner ear',(s*.33,-.055,1.61),.31,.16,'rust',pivot)
        ears.append(pivot)
    face_details(head)
    # Scarf ring, tied triangular front and small knot.
    bpy.ops.mesh.primitive_torus_add(major_radius=.255,minor_radius=.055,major_segments=32,minor_segments=10,location=(0,0,1.055))
    finish(bpy.context.object,'green scarf collar','green',body,True)
    mesh('scarf front', [(-.18,-.264,1.06),(.18,-.264,1.06),(0,-.32,.73),(-.18,-.295,1.06),(.18,-.295,1.06),(0,-.35,.73)],[(0,1,2),(5,4,3),(0,3,4,1),(1,4,5,2),(2,5,3,0)],'green',body,.012)
    ball('scarf knot',(.18,-.19,1.07),(.075,.06,.075),'mint',body,16)
    pack=group('ExplorerBackpack',body)
    box('backpack body',(0,.34,.72),(.53,.26,.59),'green',pack,.15)
    box('backpack top flap',(0,.40,1.02),(.57,.30,.19),'mint',pack,.08)
    box('backpack pocket',(0,.495,.64),(.33,.09,.25),'mint',pack,.05)
    box('backpack buckle',(0,.552,.73),(.10,.025,.11),'gold',pack,.015)
    for s in [-1,1]:
        tube('shoulder strap',[(s*.19,.25,1.0),(s*.24,-.05,.99),(s*.22,-.26,.77),(s*.23,-.15,.45)],[.038,.038,.037,.033],'woodDark',body,10)
    tail=group('HeroTail',body,(.29,.19,.43),role='tail')
    tube('fox sweeping tail',[(.26,.16,.40),(.52,.32,.41),(.78,.35,.57),(.87,.29,.82),(.84,.20,1.00)],[.12,.20,.24,.20,.10],'orange',tail,18)
    tube('cream tail tip',[(.87,.29,.82),(.84,.20,1.00),(.76,.10,1.13)],[.20,.12,.003],'cream',tail,18)
    animate_idle(root,body,head,ears,'hero_idle')
    return root


def build_bunny():
    root=group('TuantuanBunny',role='companion',assetId='bunny',characterName='团团')
    body=group('BunnyBody',root,role='body')
    parts=[ball('body mass',(0,.06,.50),(.40,.31,.44),'bunny'),ball('shoulder mass',(0,.03,.76),(.32,.28,.28),'bunny')]
    for s in [-1,1]:
        parts.append(ball('haunch',(s*.25,.09,.31),(.22,.25,.25),'bunny'))
        parts.append(ball('arm',(s*.31,-.04,.55),(.13,.17,.23),'bunny'))
    torso=fuse(parts,'Bunny continuous torso','bunny',.033)
    parent_keep(torso,body)
    for s in [-1,1]:
        ball('bunny foot',(s*.23,-.20,.11),(.19,.27,.11),'cream',root)
    ball('bunny tail',(0,.38,.34),(.17,.16,.17),'paper',body)
    ball('bunny belly',(0,-.258,.49),(.25,.045,.26),'paper',body)
    head=group('BunnyHead',body,(0,0,.87),role='head')
    shape=fuse([ball('head',(0,-.015,1.03),(.43,.34,.36),'bunny'),ball('cheek left',(-.22,-.15,.94),(.24,.24,.20),'bunny'),ball('cheek right',(.22,-.15,.94),(.24,.24,.20),'bunny')],'Bunny continuous head','bunny',.026)
    parent_keep(shape,head)
    ball('bunny muzzle',(0,-.333,.96),(.20,.13,.13),'paper',head)
    ears=[]
    for s in [-1,1]:
        pivot=group('BunnyEarLeft' if s<0 else 'BunnyEarRight',head,(s*.20,.005,1.26),role='ear')
        e=ball('long bunny ear',(s*.22,.025,1.62),(.125,.105,.43),'bunny',pivot)
        e.rotation_euler[1]=s*.14
        inner=ball('pink ear center',(s*.22,-.067,1.64),(.068,.028,.31),'pink',pivot)
        inner.rotation_euler[1]=s*.14
        ears.append(pivot)
    face_details(head,True)
    bpy.ops.mesh.primitive_torus_add(major_radius=.265,minor_radius=.035,major_segments=32,minor_segments=10,location=(0,0,.785))
    finish(bpy.context.object,'little green neckerchief','green',body,True)
    mesh('bunny scarf tail',[(-.12,-.27,.80),(.12,-.27,.80),(0,-.32,.57),(-.12,-.30,.80),(.12,-.30,.80),(0,-.35,.57)],[(0,1,2),(5,4,3),(0,3,4,1),(1,4,5,2),(2,5,3,0)],'green',body,.01)
    animate_idle(root,body,head,ears,'bunny_idle')
    return root


def merge_static(root):
    """Batch same-material scenery while preserving each interactive object root."""
    bins={}
    for obj in list(bpy.context.scene.objects):
        if obj.type!='MESH':continue
        ancestor=obj.parent
        semantic=root
        while ancestor:
            if ancestor.get('interactionId') or ancestor.get('motionRole'):
                semantic=ancestor;break
            ancestor=ancestor.parent
        key=(semantic.name,obj.data.materials[0].name)
        bins.setdefault(key,[]).append(obj)
    for (semantic, material),objects in bins.items():
        if len(objects)<2:continue
        # Bake bevels and solidify before joining so each object keeps its shape.
        for obj in objects:
            bpy.context.view_layer.objects.active=obj
            for mod in list(obj.modifiers):bpy.ops.object.modifier_apply(modifier=mod.name)
        bpy.ops.object.select_all(action='DESELECT')
        for obj in objects:obj.select_set(True)
        bpy.context.view_layer.objects.active=objects[0]
        bpy.ops.object.join()
        objects[0].name=semantic+'_'+material


def setup_render(asset):
    scene=bpy.context.scene
    scene.render.engine='CYCLES'
    scene.cycles.samples=24
    scene.cycles.use_denoising=True
    scene.render.resolution_x=1100
    scene.render.resolution_y=850
    scene.render.resolution_percentage=100
    if scene.world is None:
        scene.world=bpy.data.worlds.new('Word Island preview world')
    scene.world.color=(.5,.5,.5)
    scene.world.use_nodes=True
    scene.world.node_tree.nodes['Background'].inputs[0].default_value=linear_hex('#EAE7DC')
    scene.world.node_tree.nodes['Background'].inputs[1].default_value=.7
    bpy.ops.object.light_add(type='AREA',location=(-4,-5,8))
    key=bpy.context.object;key.name='Preview softbox';key.data.energy=1100;key.data.shape='DISK';key.data.size=6
    key.rotation_euler=(Vector((0,0,1))-key.location).to_track_quat('-Z','Y').to_euler()
    bpy.ops.object.light_add(type='AREA',location=(5,3,6))
    fill=bpy.context.object;fill.data.energy=650;fill.data.size=5
    fill.rotation_euler=(Vector((0,0,1))-fill.location).to_track_quat('-Z','Y').to_euler()
    actor=asset in ['hero','bunny']
    bpy.ops.object.camera_add(location=(3,-5,2.8) if actor else (9,-11,9))
    camera=bpy.context.object;camera.name='Preview camera';camera.data.type='ORTHO';camera.data.ortho_scale=3.2 if actor else 13.7
    target=Vector((0,0,1.0) if actor else (0,0,.8))
    camera.rotation_euler=(target-camera.location).to_track_quat('-Z','Y').to_euler()
    scene.camera=camera
    scene.view_settings.view_transform='AgX'


BUILDERS={'home':build_home,'camp':build_camp,'hero':build_hero,'bunny':build_bunny}


def export_asset(asset, output, render=False):
    reset()
    root=BUILDERS[asset]()
    if asset in ['home','camp']:merge_static(root)
    setup_render(asset)
    bpy.ops.file.pack_all()
    bpy.ops.wm.save_as_mainfile(filepath=str(output/(asset+'.blend')),compress=True)
    bpy.ops.export_scene.gltf(filepath=str(output/(asset+'.glb')),export_format='GLB',export_apply=True,export_cameras=False,export_lights=False,export_extras=True,export_yup=True,export_animations=asset in ['hero','bunny'],export_animation_mode='SCENE',export_anim_scene_split_object=False,export_frame_range=True)
    if render:
        bpy.context.scene.render.image_settings.file_format='PNG'
        bpy.context.scene.render.filepath=str(output/(asset+'-preview.png'))
        bpy.ops.render.render(write_still=True)
    return {'asset':asset,'meshes':sum(o.type=='MESH' for o in bpy.context.scene.objects),'vertices':sum(len(o.data.vertices) for o in bpy.context.scene.objects if o.type=='MESH'),'bytes':(output/(asset+'.glb')).stat().st_size}


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--output',type=Path,required=True)
    parser.add_argument('--asset',choices=list(BUILDERS),action='append')
    parser.add_argument('--render',action='store_true')
    args=parser.parse_args(sys.argv[sys.argv.index('--')+1:])
    output=args.output.resolve();output.mkdir(parents=True,exist_ok=True)
    results=[export_asset(asset,output,args.render) for asset in (args.asset or BUILDERS)]
    (output/'asset-report.json').write_text(json.dumps(results,ensure_ascii=False,indent=2))
    print('WORD_ISLAND_ASSETS_COMPLETE',json.dumps(results),flush=True)


if __name__=='__main__':main()
