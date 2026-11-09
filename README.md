# GlbViewer

A browser-based viewer for 3D models, point clouds and simulation output. Everything runs on the
client: files are read locally and never uploaded, so `dist/` can be hosted on any static host
(GitHub Pages, Netlify, S3, a university web space).

## Supported formats

| Kind | Extensions |
| --- | --- |
| Models | `.glb` `.gltf` (Draco, Meshopt, KTX2 textures) · `.obj` + `.mtl` · `.fbx` · `.dae` · `.3ds` · `.usdz` · `.wrl` · `.3mf` · `.amf` · `.stl` · `.off` |
| Simulation | Tecplot `.plt` (ASCII and binary TDV112), `.dat`, `.tec` · VTK `.vtk` `.vtp` |
| Point clouds | `.las` (uncompressed, formats 0–10) · `.ply` · `.pcd` · `.xyz` |
| Bundles | `.zip` containing any of the above, or a dropped folder (for glTF/OBJ with textures) |

Not supported yet: `.laz` (decompress to `.las`), Tecplot `.szplt`, Tecplot polyhedral zones.

## Features

- Drag and drop files or folders, open from a URL, or link straight to a file with `?url=https://…/model.glb`
- **Color by variable** for Tecplot, PLY scalar properties, LAS (elevation, intensity, classification, RGB) and point heights,
  with Viridis / Turbo / Inferno / Cool–warm / Jet / Terrain colormaps, banding, custom range and a
  **UTCI thermal-stress class** colormap that is selected automatically for variables named `UTCI…`
- **Probe**: click a surface to read its coordinates (in the file's original coordinate system) and the interpolated value
- **Measure**: click two points for distance and Δx/Δy/Δz
- Section cut along any axis, wireframe, flat shading, "true colors" (unlit) mode, Y-up / Z-up toggle
- Per-file and per-part visibility, glTF/FBX animation playback, file statistics, PNG export
- Large georeferenced coordinates (UTM etc.) are shifted to a local origin automatically to avoid float precision jitter

### Tecplot notes

- ORDERED zones (1-D lines, 2-D surfaces, 3-D blocks shown as their outer faces) and FE zones
  (line, triangle, quad, tetrahedron, brick; volume zones show boundary faces only)
- POINT and BLOCK packing, `VARLOCATION` cell-centred variables (averaged to nodes), `VARSHARELIST`,
  `CONNECTIVITYSHAREZONE`, `PASSIVEVARLIST`, `n*value` repeats, Fortran `D` exponents
- X/Y/Z are detected by name; change them under **Color by → Coordinate variables** if detection is wrong

## Develop

```bash
npm install
npm run dev      # rebuilds on save, serves http://localhost:5173
npm run build    # writes the static site to dist/
```

Open `dist/` through a web server rather than double-clicking `index.html` (browsers block module
scripts from `file://`). Quick option: `python3 -m http.server -d dist 8000`.

## Deploy

GitHub Pages serves the committed `docs/` folder from `main`. To publish changes, run
`npm run build`, replace `docs/` with the contents of `dist/` (including an empty
`.nojekyll` file), and commit and push the updated files. Repository **Settings → Pages**
uses **Deploy from a branch**, branch **main**, folder **/docs**.

Live site: https://xiaojianggis.github.io/GlbViewer/

You can also upload the contents of `dist/` to any static host.

## Layout

```
src/
  main.js              viewer, UI, probe/measure/section cut
  loaders.js           format detection and three.js loaders
  colormaps.js         colormaps and the UTCI class scale
  formats/tecplot.js   Tecplot ASCII + binary reader
  formats/tecplotMesh.js  zones → three.js meshes, cell→node averaging, boundary extraction
  formats/las.js       LAS point reader
samples/               synthetic demo data (regenerate with `npm run samples`)
dist/                  built site (generated)
```

The sample files are synthetic and illustrative only, not simulation results.
