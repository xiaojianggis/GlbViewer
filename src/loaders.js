import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { MTLLoader } from 'three/examples/jsm/loaders/MTLLoader.js';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader.js';
import { ThreeMFLoader } from 'three/examples/jsm/loaders/3MFLoader.js';
import { ColladaLoader } from 'three/examples/jsm/loaders/ColladaLoader.js';
import { TDSLoader } from 'three/examples/jsm/loaders/TDSLoader.js';
import { USDZLoader } from 'three/examples/jsm/loaders/USDZLoader.js';
import { VRMLLoader } from 'three/examples/jsm/loaders/VRMLLoader.js';
import { VTKLoader } from 'three/examples/jsm/loaders/VTKLoader.js';
import { XYZLoader } from 'three/examples/jsm/loaders/XYZLoader.js';
import { PCDLoader } from 'three/examples/jsm/loaders/PCDLoader.js';
import { AMFLoader } from 'three/examples/jsm/loaders/AMFLoader.js';
import { unzipSync } from 'three/examples/jsm/libs/fflate.module.js';
import { parseTecplot, looksLikeTecplotAscii, isTecplotBinary } from './formats/tecplot.js';
import { buildTecplot, guessCoordinateVars, computeTecplotOrigin } from './formats/tecplotMesh.js';
import { parseLAS } from './formats/las.js';

export const MODEL_EXTS = {
  glb: 'glTF binary', gltf: 'glTF', obj: 'Wavefront OBJ', fbx: 'FBX', stl: 'STL', ply: 'PLY',
  '3mf': '3MF', dae: 'Collada', '3ds': '3DS', usdz: 'USDZ', wrl: 'VRML', vrml: 'VRML',
  vtk: 'VTK', vtp: 'VTK PolyData', xyz: 'XYZ points', pcd: 'PCD point cloud', amf: 'AMF',
  off: 'OFF', plt: 'Tecplot', tec: 'Tecplot', dat: 'Tecplot', szplt: 'Tecplot SZL', las: 'LAS point cloud',
  laz: 'LAZ point cloud', zip: 'ZIP archive',
};
// Formats that are conventionally Z-up
export const Z_UP = new Set(['plt', 'tec', 'dat', 'las', 'xyz', 'pcd', 'stl', 'ply', 'off', 'vtk', 'vtp', '3mf', 'amf']);

export const ext = (name) => (name.split('?')[0].split('#')[0].match(/\.([^./\\]+)$/)?.[1] ?? '').toLowerCase();
const base = (name) => decodeURIComponent(name).split(/[\\/]/).pop().toLowerCase();

const defaultMaterial = () => new THREE.MeshStandardMaterial({ color: 0xb8c2cc, roughness: 0.6, metalness: 0.05, side: THREE.DoubleSide });
const pointsMaterial = (vc) => new THREE.PointsMaterial({ size: 2, sizeAttenuation: false, vertexColors: vc, color: vc ? 0xffffff : 0x3b6e8f });

let draco, ktx2;
function gltfLoader(manager, renderer) {
  const l = new GLTFLoader(manager);
  draco ??= new DRACOLoader().setDecoderPath('./decoders/draco/');
  l.setDRACOLoader(draco);
  if (renderer) {
    ktx2 ??= new KTX2Loader().setTranscoderPath('./decoders/basis/').detectSupport(renderer);
    l.setKTX2Loader(ktx2);
  }
  l.setMeshoptDecoder(MeshoptDecoder);
  return l;
}

/** Expand zip archives into File objects. */
async function expandZips(files) {
  const out = [];
  for (const f of files) {
    if (ext(f.name) !== 'zip') { out.push(f); continue; }
    const entries = unzipSync(new Uint8Array(await f.arrayBuffer()));
    for (const [path, bytes] of Object.entries(entries)) {
      if (path.endsWith('/') || path.includes('__MACOSX')) continue;
      out.push(new File([bytes], path.split('/').pop(), { lastModified: Date.now() }));
      out[out.length - 1].relPath = path;
    }
  }
  return out;
}

function geometryObject(geom, name, asPoints = !geom.index) {
  if (asPoints) {
    const p = new THREE.Points(geom, pointsMaterial(!!geom.attributes.color));
    p.name = name;
    return p;
  }
  if (!geom.attributes.normal) geom.computeVertexNormals();
  const mat = defaultMaterial();
  if (geom.attributes.color) { mat.vertexColors = true; mat.color.set(0xffffff); }
  const m = new THREE.Mesh(geom, mat);
  m.name = name;
  return m;
}

function parseOFF(text) {
  const tok = text.replace(/#.*$/gm, '').split(/\s+/).filter(Boolean);
  let i = 0;
  if (/OFF$/i.test(tok[0])) i++;
  const nv = +tok[i++], nf = +tok[i++]; i++;
  const pos = new Float32Array(nv * 3);
  for (let v = 0; v < nv * 3; v++) pos[v] = +tok[i++];
  const idx = [];
  for (let f = 0; f < nf; f++) {
    const n = +tok[i++]; const poly = [];
    for (let k = 0; k < n; k++) poly.push(+tok[i++]);
    for (let k = 1; k < n - 1; k++) idx.push(poly[0], poly[k], poly[k + 1]);
    // skip optional per-face colour values until next face line
    while (i < tok.length && f < nf - 1 && tok[i].includes('.')) i++;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  if (idx.length) g.setIndex(idx);
  return g;
}

/** Read PLY header to discover extra per-vertex scalar properties. */
function plyScalarProps(buffer) {
  const head = new TextDecoder().decode(new Uint8Array(buffer, 0, Math.min(buffer.byteLength, 8192)));
  const end = head.indexOf('end_header');
  if (end < 0) return [];
  const lines = head.slice(0, end).split(/\r?\n/);
  const std = new Set(['x', 'y', 'z', 'nx', 'ny', 'nz', 'red', 'green', 'blue', 'alpha', 'r', 'g', 'b',
    's', 't', 'u', 'v', 'texture_u', 'texture_v', 'diffuse_red', 'diffuse_green', 'diffuse_blue']);
  const props = []; let inVertex = false;
  for (const l of lines) {
    const p = l.trim().split(/\s+/);
    if (p[0] === 'element') inVertex = p[1] === 'vertex';
    else if (p[0] === 'property' && inVertex && p[1] !== 'list' && !std.has(p[2])) props.push(p[2]);
  }
  return props;
}

function fieldFromAttributes(object, names, extra = []) {
  const parts = [];
  object.traverse((o) => {
    if (!(o.isMesh || o.isPoints)) return;
    const g = o.geometry;
    const arrays = names.map((n) => g.attributes[n]?.array);
    extra.forEach((fn) => arrays.push(fn(g)));
    parts.push({ object: o, kind: o.isMesh ? 'mesh' : 'points', nodal: (v) => arrays[v] });
  });
  return parts;
}

const heightOf = (axis) => (g) => {
  const p = g.attributes.position.array; const out = new Float32Array(p.length / 3);
  for (let k = 0; k < out.length; k++) out[k] = p[k * 3 + axis];
  return out;
};

/**
 * Load a set of files dropped together. Model files become items; other files
 * (textures, .bin, .mtl) are made available to the loaders by name.
 */
export async function loadFiles(fileList, ctx) {
  const files = await expandZips([...fileList]);
  const byName = new Map(files.map((f) => [base(f.relPath ?? f.name), f]));
  const urls = new Map();
  const urlFor = (f) => { if (!urls.has(f)) urls.set(f, URL.createObjectURL(f)); return urls.get(f); };

  const manager = new THREE.LoadingManager();
  manager.setURLModifier((url) => {
    if (/^(blob:|data:)/.test(url)) return url;
    const f = byName.get(base(url));
    return f ? urlFor(f) : url;
  });

  const primaries = files.filter((f) => MODEL_EXTS[ext(f.name)] && !(ext(f.name) === 'dat' && files.length > 1 && hasOtherModel(files)));
  if (!primaries.length) throw new Error('No supported 3D files found. Supported: ' + Object.keys(MODEL_EXTS).filter((e) => e !== 'zip').join(', '));

  const items = [];
  for (const f of primaries) {
    try {
      items.push(await loadOne(f, manager, ctx, urlFor, byName));
    } catch (err) {
      console.error(err);
      items.push({ name: f.name, error: err.message || String(err) });
    }
  }
  return items;
}
const hasOtherModel = (files) => files.some((f) => ['gltf', 'obj'].includes(ext(f.name)));

export async function loadURL(url, ctx, nameOverride) {
  const name = nameOverride ?? decodeURIComponent(url.split('?')[0].split('/').pop() || 'model');
  const e = ext(name);
  if (e === 'gltf') {
    const gltf = await gltfLoader(undefined, ctx.renderer).loadAsync(url);
    return [{ name, format: 'glTF', ext: e, object: gltf.scene, animations: gltf.animations }];
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed (${res.status} ${res.statusText}).`);
  const blob = await res.blob();
  return loadFiles([new File([blob], name)], ctx);
}

async function loadOne(file, manager, ctx, urlFor, byName) {
  const e = ext(file.name);
  const name = file.name;
  const buf = () => file.arrayBuffer();
  const txt = () => file.text();
  const item = { name, ext: e, format: MODEL_EXTS[e], animations: [], warnings: [] };

  switch (e) {
    case 'glb': case 'gltf': {
      const l = gltfLoader(manager, ctx.renderer);
      const gltf = e === 'glb' ? await l.parseAsync(await buf(), '') : await l.parseAsync(await txt(), '');
      item.object = gltf.scene; item.animations = gltf.animations;
      const ext_ = gltf.parser?.json?.extensionsUsed;
      if (ext_?.length) item.info = { Extensions: ext_.join(', ') };
      break;
    }
    case 'obj': {
      const text = await txt();
      const l = new OBJLoader(manager);
      const mtlName = text.match(/^mtllib\s+(.+)$/m)?.[1]?.trim();
      const mtlFile = (mtlName && byName.get(base(mtlName))) || [...byName.values()].find((f) => ext(f.name) === 'mtl');
      if (mtlFile) {
        const mtl = new MTLLoader(manager).parse(await mtlFile.text(), '');
        mtl.preload(); l.setMaterials(mtl);
      } else if (mtlName) item.warnings.push(`Material file "${mtlName}" was not provided; drop it together with the OBJ to see materials.`);
      item.object = l.parse(text);
      if (!mtlFile) item.object.traverse((o) => { if (o.isMesh) o.material = defaultMaterial(); });
      break;
    }
    case 'fbx': {
      item.object = new FBXLoader(manager).parse(await buf(), '');
      item.animations = item.object.animations ?? [];
      break;
    }
    case 'stl': {
      const g = new STLLoader(manager).parse(await buf());
      item.object = geometryObject(g, name, false);
      if (g.hasColors) { item.object.material.vertexColors = true; item.object.material.color.set(0xffffff); }
      break;
    }
    case 'ply': {
      const b = await buf();
      const props = plyScalarProps(b);
      const l = new PLYLoader(manager);
      if (props.length) l.setCustomPropertyNameMapping(Object.fromEntries(props.map((p) => [p, [p]])));
      const g = l.parse(b);
      item.object = geometryObject(g, name);
      item.field = {
        variables: [...props, 'Height (Z)'],
        defaultVar: props.length ? 0 : -1,
        hasRGB: !!g.attributes.color,
        parts: fieldFromAttributes(item.object, props, [heightOf(2)]),
      };
      if (item.field.hasRGB) { item.field.parts.forEach((p) => { p.rgb = g.attributes.color.array; }); item.field.defaultVar = props.length ? 0 : -2; }
      break;
    }
    case '3mf': item.object = new ThreeMFLoader(manager).parse(await buf()); break;
    case 'amf': item.object = new AMFLoader(manager).parse(await buf()); break;
    case 'dae': {
      const c = new ColladaLoader(manager).parse(await txt(), '');
      item.object = c.scene; item.animations = c.scene.animations ?? [];
      break;
    }
    case '3ds': item.object = new TDSLoader(manager).parse(await buf(), ''); break;
    case 'usdz': item.object = new USDZLoader(manager).parse(await buf()); break;
    case 'wrl': case 'vrml': item.object = new VRMLLoader(manager).parse(await txt(), ''); break;
    case 'vtk': case 'vtp': {
      const g = new VTKLoader(manager).parse(await buf());
      item.object = geometryObject(g, name);
      item.field = { variables: ['Height (Z)'], defaultVar: -1, parts: fieldFromAttributes(item.object, [], [heightOf(2)]) };
      break;
    }
    case 'xyz': {
      const g = new XYZLoader(manager).parse(await txt());
      item.object = new THREE.Points(g, pointsMaterial(!!g.attributes.color));
      item.field = { variables: ['Height (Z)'], defaultVar: g.attributes.color ? -2 : 0, hasRGB: !!g.attributes.color,
        parts: fieldFromAttributes(item.object, [], [heightOf(2)]) };
      if (g.attributes.color) item.field.parts[0].rgb = g.attributes.color.array;
      break;
    }
    case 'pcd': {
      item.object = new PCDLoader(manager).parse(await buf());
      item.object.material.sizeAttenuation = false; item.object.material.size = 2;
      const hasRGB = !!item.object.geometry.attributes.color;
      item.field = { variables: ['Height (Z)', ...(item.object.geometry.attributes.intensity ? ['Intensity'] : [])], defaultVar: hasRGB ? -2 : 0, hasRGB,
        parts: fieldFromAttributes(item.object, [], [heightOf(2), (g) => g.attributes.intensity?.array]) };
      if (hasRGB) item.field.parts[0].rgb = item.object.geometry.attributes.color.array;
      break;
    }
    case 'off': item.object = geometryObject(parseOFF(await txt()), name); break;
    case 'las': {
      const r = parseLAS(await buf(), ctx.getOrigin());
      ctx.setOrigin(r.origin);
      Object.assign(item, { object: r.object, field: r.field, origin: r.origin, info: r.info });
      item.warnings.push(...r.warnings);
      break;
    }
    case 'laz': throw new Error('LAZ (compressed) point clouds are not supported yet. Decompress to .las first (laszip, PDAL or CloudCompare).');
    case 'szplt': throw new Error('Tecplot SZL (.szplt) files are not supported. In Tecplot use File → Write Data File and choose binary PLT or ASCII.');
    case 'plt': case 'tec': case 'dat': {
      const b = await buf();
      if (e === 'dat' && !isTecplotBinary(b) && !looksLikeTecplotAscii(new TextDecoder().decode(new Uint8Array(b, 0, Math.min(b.byteLength, 4000))))) {
        throw new Error('This .dat file does not look like a Tecplot file.');
      }
      const ds = parseTecplot(b);
      const map = guessCoordinateVars(ds.variables);
      let origin = ctx.getOrigin();
      if (!origin) {
        const c = computeTecplotOrigin(ds, map);
        origin = Math.hypot(...c) > 1e4 ? c : [0, 0, 0];
        ctx.setOrigin(origin);
      }
      const built = buildTecplot(ds, map, origin);
      item.object = built.group;
      item.origin = origin;
      item.format = ds.format;
      item.warnings.push(...ds.warnings);
      const coordSet = new Set([map.x, map.y, map.z]);
      const firstScalar = ds.variables.findIndex((_, i) => !coordSet.has(i));
      item.field = {
        variables: ds.variables, defaultVar: firstScalar >= 0 ? firstScalar : (map.z >= 0 ? map.z : -1), parts: built.parts,
        mapping: map,
        rebuild: (m) => buildTecplot(ds, m, origin),
      };
      const totalNodes = ds.zones.reduce((s, z) => s + z.nodes, 0);
      item.info = { Zones: ds.zones.length, Variables: ds.variables.length, Nodes: totalNodes.toLocaleString(),
        'Zone types': [...new Set(ds.zones.map((z) => z.zoneType))].join(', ') };
      if (ds.title) item.info.Title = ds.title;
      break;
    }
    default: throw new Error(`Unsupported format .${e}`);
  }
  if (!item.object) throw new Error('The file loaded but contained no geometry.');
  return item;
}
