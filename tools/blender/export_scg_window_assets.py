import argparse
from pathlib import Path

import bpy


WINDOWS = [
    ("scg-win-vin-slide-120110.glb", "#e8edf0", "#7dd3fc", "sliding"),
    ("scg-win-vin-case-80110.glb", "#f1f5f7", "#93c5fd", "casement"),
    ("scg-win-alu-blk-fix-12060.glb", "#1f2933", "#67e8f9", "fixed"),
    ("scg-win-upvc-awn-8060.glb", "#f8fafc", "#bae6fd", "awning"),
]


def hex_to_rgba(value, alpha=1):
    value = value.lstrip("#")
    return tuple(int(value[i : i + 2], 16) / 255 for i in (0, 2, 4)) + (alpha,)


def make_mat(name, color, alpha=1, roughness=0.42):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = hex_to_rgba(color, alpha)
    bsdf.inputs["Roughness"].default_value = roughness
    if alpha < 1:
        bsdf.inputs["Alpha"].default_value = alpha
        mat.blend_method = "BLEND"
        mat.use_screen_refraction = True
    return mat


def cube(name, loc, scale, mat):
    bpy.ops.mesh.primitive_cube_add(size=1, location=loc)
    obj = bpy.context.object
    obj.name = name
    obj.dimensions = scale
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    obj.data.materials.append(mat)
    return obj


def add_window(filename, frame_hex, glass_hex, style, out_dir):
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete()

    frame_mat = make_mat("window_frame", frame_hex, 1, 0.35)
    glass_mat = make_mat("blue_tinted_glass", glass_hex, 0.42, 0.08)

    width = 1.2
    height = 1.1
    depth = 0.08
    rail = 0.06

    cube("left_frame", (-width / 2, height / 2, 0), (rail, height, depth), frame_mat)
    cube("right_frame", (width / 2, height / 2, 0), (rail, height, depth), frame_mat)
    cube("top_frame", (0, height, 0), (width, rail, depth), frame_mat)
    cube("bottom_frame", (0, 0, 0), (width, rail, depth), frame_mat)
    cube("glass", (0, height / 2, 0), (width - rail * 2, height - rail * 2, 0.012), glass_mat)

    if style == "sliding":
        cube("center_interlock", (0, height / 2, depth / 2 + 0.01), (rail * 0.75, height - rail * 1.4, rail * 0.7), frame_mat)
        cube("track_top", (0, height - rail * 1.2, depth / 2 + 0.018), (width - rail, rail * 0.35, rail * 0.5), frame_mat)
        cube("track_bottom", (0, rail * 1.2, depth / 2 + 0.018), (width - rail, rail * 0.35, rail * 0.5), frame_mat)
    elif style == "casement":
        cube("side_hinge", (-width / 2 + rail * 1.6, height / 2, depth / 2 + 0.018), (rail * 0.35, height - rail * 1.8, rail * 0.5), frame_mat)
        cube("handle", (width / 2 - rail * 2, height / 2, depth / 2 + 0.05), (rail * 0.35, rail * 2.5, rail * 0.35), frame_mat)
    elif style == "awning":
        cube("top_hinge", (0, height - rail * 1.6, depth / 2 + 0.018), (width - rail * 1.6, rail * 0.35, rail * 0.5), frame_mat)
        cube("bottom_handle", (0, rail * 2.2, depth / 2 + 0.05), (rail * 2.8, rail * 0.35, rail * 0.35), frame_mat)

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

    for item in WINDOWS:
        add_window(*item, out_dir)


if __name__ == "__main__":
    main()
