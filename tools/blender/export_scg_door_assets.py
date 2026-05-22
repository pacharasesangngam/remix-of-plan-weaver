import argparse
from pathlib import Path

import bpy


DOORS = [
    ("scg-door-wpc-riga-80200.glb", "#b6783f", "#d39a5c", "#7c4a24", "groove"),
    ("scg-door-hdf-6mv1-80200.glb", "#e8e3d8", "#f4efe6", "#b9aa98", "panel"),
    ("scg-door-upvc-white-70200.glb", "#f0f4f5", "#ffffff", "#c7d1d4", "flat"),
    ("scg-door-fg-teak-90200.glb", "#8f552d", "#b8743c", "#5f351d", "panel"),
    ("scg-door-mel-walnut-80200.glb", "#6f432a", "#8b5a3c", "#4f2f1e", "modern"),
    ("scg-door-ps-beech-90200.glb", "#c69258", "#e0b37a", "#8a5f36", "groove"),
]


def hex_to_rgba(value):
    value = value.lstrip("#")
    return tuple(int(value[i : i + 2], 16) / 255 for i in (0, 2, 4)) + (1,)


def make_mat(name, color, roughness=0.55):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = hex_to_rgba(color)
    bsdf.inputs["Roughness"].default_value = roughness
    return mat


def cube(name, loc, scale, mat):
    bpy.ops.mesh.primitive_cube_add(size=1, location=loc)
    obj = bpy.context.object
    obj.name = name
    obj.dimensions = scale
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    obj.data.materials.append(mat)
    return obj


def add_door(filename, door_hex, panel_hex, frame_hex, style, out_dir):
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete()

    door_mat = make_mat("door_finish", door_hex)
    panel_mat = make_mat("door_panel", panel_hex)
    frame_mat = make_mat("door_frame", frame_hex)
    metal_mat = make_mat("dark_bronze_hardware", "#4b2a17", 0.3)

    width = 0.9
    height = 2.1
    depth = 0.08
    frame = 0.08

    cube("slab", (0, height / 2, 0), (width, height, depth), door_mat)
    cube("frame_left", (-width / 2 - frame / 2, height / 2, 0), (frame, height + frame, depth * 1.35), frame_mat)
    cube("frame_right", (width / 2 + frame / 2, height / 2, 0), (frame, height + frame, depth * 1.35), frame_mat)
    cube("frame_top", (0, height + frame / 2, 0), (width + frame * 2, frame, depth * 1.35), frame_mat)
    cube("threshold", (0, frame / 2, 0), (width + frame * 2.2, frame, depth * 1.5), frame_mat)

    if style != "flat":
        cube("upper_panel", (0, height * 0.64, depth / 2 + 0.006), (width * 0.58, height * 0.32, 0.014), panel_mat)
        cube("lower_panel", (0, height * 0.29, depth / 2 + 0.006), (width * 0.58, height * 0.22, 0.014), panel_mat)

    if style in {"groove", "modern"}:
        for x in (-0.22, 0, 0.22):
            cube("vertical_groove", (x * width, height * 0.5, depth / 2 + 0.014), (0.018, height * 0.72, 0.012), frame_mat)

    bpy.ops.mesh.primitive_uv_sphere_add(segments=24, ring_count=12, radius=0.04, location=(width * 0.36, height * 0.5, depth / 2 + 0.045))
    knob = bpy.context.object
    knob.name = "knob"
    knob.data.materials.append(metal_mat)

    for obj in bpy.context.scene.objects:
        obj.select_set(True)
    bpy.ops.export_scene.gltf(
        filepath=str(out_dir / filename),
        export_format="GLB",
        use_selection=True,
        export_apply=True,
    )


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    for item in DOORS:
        add_door(*item, out_dir)


if __name__ == "__main__":
    main()
