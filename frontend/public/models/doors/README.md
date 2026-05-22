Generated Blender `.glb` door assets go in this folder.

Expected files:

- `scg-door-wpc-riga-80200.glb`
- `scg-door-hdf-6mv1-80200.glb`
- `scg-door-upvc-white-70200.glb`
- `scg-door-fg-teak-90200.glb`
- `scg-door-mel-walnut-80200.glb`
- `scg-door-ps-beech-90200.glb`

Generate them from the repo root with Blender installed:

```powershell
blender --background --python tools\blender\export_scg_door_assets.py -- --out frontend\public\models\doors
```
