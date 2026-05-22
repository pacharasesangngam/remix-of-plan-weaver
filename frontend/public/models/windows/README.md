Generated Blender `.glb` window assets go in this folder.

Expected files:

- `scg-win-vin-slide-120110.glb`
- `scg-win-vin-case-80110.glb`
- `scg-win-alu-blk-fix-12060.glb`
- `scg-win-upvc-awn-8060.glb`

Generate them from the repo root with Blender installed:

```powershell
blender --background --python tools\blender\export_scg_window_assets.py -- --out frontend\public\models\windows
```
