import * as THREE from 'three';

// Turns a parsed Tecplot dataset into three.js objects plus a scalar "field"
// the viewer can colour by.

const COORD_PATTERNS = [
  [/^\s*(x|coordinatex|points?:0|x[\s_[(].*|x-coordinate.*)$/i],
  [/^\s*(y|coordinatey|points?:1|y[\s_[(].*|y-coordinate.*)$/i],
  [/^\s*(z|coordinatez|points?:2|z[\s_[(].*|z-coordinate.*)$/i],
];

export function guessCoordinateVars(variables) {
  const find = (re) => variables.findIndex((n) => re.test(n));
  let x = find(COORD_PATTERNS[0][0]);
  let y = find(COORD_PATTERNS[1][0]);
  let z = find(COORD_PATTERNS[2][0]);
  if (x < 0 || y < 0) { x = 0; y = Math.min(1, variables.length - 1); }
  if (z < 0 && variables.length >= 3 && x === 0 && y === 1) {
    // only treat the 3rd column as Z if nothing else looks like a coordinate and the
    // file has more than 3 variables (a 2-D field file would be X, Y, value).
    z = variables.length > 3 ? 2 : -1;
  }
  return { x, y, z };
}

function cellToNode(zone, arr) {
  const out = new Float32Array(zone.nodes);
  const cnt = new Uint16Array(zone.nodes);
  if (zone.zoneType === 'ORDERED') {
    const { I, J, K } = zone;
    const [s0, s1] = zone.cellStride;
    const ni = Math.max(I - 1, 1), nj = Math.max(J - 1, 1), nk = Math.max(K - 1, 1);
    const di = I > 1 ? 1 : 0, dj = J > 1 ? 1 : 0, dk = K > 1 ? 1 : 0;
    for (let k = 0; k < nk; k++) for (let j = 0; j < nj; j++) for (let i = 0; i < ni; i++) {
      const v = arr[i + j * s0 + k * s1];
      for (let c = 0; c < 8; c++) {
        const ii = i + (c & 1) * di, jj = j + ((c >> 1) & 1) * dj, kk = k + ((c >> 2) & 1) * dk;
        const n = ii + jj * I + kk * I * J;
        out[n] += v; cnt[n]++;
      }
    }
  } else {
    const { conn, npe } = zone;
    for (let e = 0; e < zone.cells; e++) {
      const v = arr[e];
      for (let l = 0; l < npe; l++) { const n = conn[e * npe + l]; out[n] += v; cnt[n]++; }
    }
  }
  for (let n = 0; n < out.length; n++) out[n] = cnt[n] ? out[n] / cnt[n] : NaN;
  return out;
}

const TET_FACES = [[0, 1, 2], [0, 1, 3], [1, 2, 3], [0, 2, 3]];
const BRICK_FACES = [[0, 1, 2, 3], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]];

function triNormalDot(pos, a, b, c, px, py, pz) {
  const ax = pos[a * 3], ay = pos[a * 3 + 1], az = pos[a * 3 + 2];
  const ux = pos[b * 3] - ax, uy = pos[b * 3 + 1] - ay, uz = pos[b * 3 + 2] - az;
  const vx = pos[c * 3] - ax, vy = pos[c * 3 + 1] - ay, vz = pos[c * 3 + 2] - az;
  const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  return nx * (px - ax) + ny * (py - ay) + nz * (pz - az);
}

function pushPoly(idx, poly, flip) {
  for (let t = 1; t < poly.length - 1; t++) {
    if (flip) idx.push(poly[0], poly[t + 1], poly[t]);
    else idx.push(poly[0], poly[t], poly[t + 1]);
  }
}

function buildIndices(zone, pos) {
  const { zoneType } = zone;
  const idx = [];
  if (zoneType === 'ORDERED') {
    const dims = [zone.I, zone.J, zone.K];
    const strides = [1, zone.I, zone.I * zone.J];
    const axes = [0, 1, 2].filter((a) => dims[a] > 1);
    if (axes.length === 0) return { kind: 'points' };
    if (axes.length === 1) {
      const a = axes[0];
      for (let u = 0; u < dims[a] - 1; u++) idx.push(u * strides[a], (u + 1) * strides[a]);
      return { kind: 'lines', idx };
    }
    const quadGrid = (a, b, base, inward) => {
      const sa = strides[a], sb = strides[b];
      for (let v = 0; v < dims[b] - 1; v++) for (let u = 0; u < dims[a] - 1; u++) {
        const n0 = base + u * sa + v * sb;
        const quad = [n0, n0 + sa, n0 + sa + sb, n0 + sb];
        let flip = false;
        if (inward !== 0) {
          const q = n0 + inward;
          flip = triNormalDot(pos, quad[0], quad[1], quad[3], pos[q * 3], pos[q * 3 + 1], pos[q * 3 + 2]) > 0;
        }
        pushPoly(idx, quad, flip);
      }
    };
    if (axes.length === 2) { quadGrid(axes[0], axes[1], 0, 0); return { kind: 'mesh', idx, volume: false }; }
    for (let c = 0; c < 3; c++) {
      const [a, b] = [0, 1, 2].filter((x) => x !== c);
      quadGrid(a, b, 0, strides[c]);
      quadGrid(a, b, (dims[c] - 1) * strides[c], -strides[c]);
    }
    return { kind: 'mesh', idx, volume: true };
  }

  const { conn, npe, cells } = zone;
  if (zoneType === 'FELINESEG') {
    for (let e = 0; e < cells; e++) idx.push(conn[e * 2], conn[e * 2 + 1]);
    return { kind: 'lines', idx };
  }
  if (zoneType === 'FETRIANGLE') {
    for (let e = 0; e < cells * 3; e++) idx.push(conn[e]);
    return { kind: 'mesh', idx, volume: false };
  }
  if (zoneType === 'FEQUADRILATERAL') {
    for (let e = 0; e < cells; e++) {
      const a = conn[e * 4], b = conn[e * 4 + 1], c = conn[e * 4 + 2], d = conn[e * 4 + 3];
      if (a !== b && b !== c && a !== c) idx.push(a, b, c);
      if (c !== d && a !== d && a !== c) idx.push(a, c, d);
    }
    return { kind: 'mesh', idx, volume: false };
  }
  // volume elements: keep only boundary faces (faces used by exactly one element)
  const faces = zoneType === 'FETETRAHEDRON' ? TET_FACES : BRICK_FACES;
  const map = new Map();
  const uniq = [];
  for (let e = 0; e < cells; e++) {
    const base = e * npe;
    for (const f of faces) {
      uniq.length = 0;
      for (const l of f) { const n = conn[base + l]; if (!uniq.includes(n)) uniq.push(n); }
      if (uniq.length < 3) continue;
      const key = uniq.slice().sort((x, y) => x - y).join(',');
      if (map.has(key)) map.delete(key);
      else map.set(key, [e, uniq.slice()]);
    }
  }
  for (const [e, poly] of map.values()) {
    let cx = 0, cy = 0, cz = 0;
    for (let l = 0; l < npe; l++) { const n = conn[e * npe + l]; cx += pos[n * 3]; cy += pos[n * 3 + 1]; cz += pos[n * 3 + 2]; }
    cx /= npe; cy /= npe; cz /= npe;
    pushPoly(idx, poly, triNormalDot(pos, poly[0], poly[1], poly[2], cx, cy, cz) > 0);
  }
  return { kind: 'mesh', idx, volume: true };
}

export function computeTecplotOrigin(ds, map) {
  const z0 = ds.zones[0];
  const c = [map.x, map.y, map.z].map((v) => {
    if (v < 0) return 0;
    const arr = z0.data[v]; let lo = Infinity, hi = -Infinity;
    for (let k = 0; k < arr.length; k++) { const a = arr[k]; if (a < lo) lo = a; if (a > hi) hi = a; }
    return Number.isFinite(lo) ? (lo + hi) / 2 : 0;
  });
  return c;
}

/**
 * Build three objects for each zone.
 * @returns {{ group: THREE.Group, parts: Array }}
 */
export function buildTecplot(ds, map, origin) {
  const group = new THREE.Group();
  group.name = ds.title || 'Tecplot';
  const parts = [];
  const cache = new Map(); // zone -> var -> nodal Float32Array

  ds.zones.forEach((zone, zi) => {
    const nodal = (v) => {
      let zc = cache.get(zi);
      if (!zc) { zc = new Map(); cache.set(zi, zc); }
      if (!zc.has(v)) {
        const arr = zone.data[v];
        zc.set(v, zone.location[v] === 'CELLCENTERED' ? cellToNode(zone, arr) : arr);
      }
      return zc.get(v);
    };
    const X = nodal(map.x), Y = nodal(map.y), Z = map.z >= 0 ? nodal(map.z) : null;
    const pos = new Float32Array(zone.nodes * 3);
    for (let n = 0; n < zone.nodes; n++) {
      pos[n * 3] = X[n] - origin[0];
      pos[n * 3 + 1] = Y[n] - origin[1];
      pos[n * 3 + 2] = Z ? Z[n] - origin[2] : 0;
    }
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const built = buildIndices(zone, pos);
    let obj;
    if (built.kind === 'points') {
      obj = new THREE.Points(geom, new THREE.PointsMaterial({ size: 2, sizeAttenuation: false, vertexColors: true }));
    } else if (built.kind === 'lines') {
      geom.setIndex(built.idx);
      obj = new THREE.LineSegments(geom, new THREE.LineBasicMaterial({ vertexColors: true }));
    } else {
      geom.setIndex(zone.nodes > 65535 ? new THREE.Uint32BufferAttribute(built.idx, 1) : built.idx);
      geom.computeVertexNormals();
      obj = new THREE.Mesh(geom, new THREE.MeshStandardMaterial({
        color: 0xffffff, side: THREE.DoubleSide, flatShading: built.volume, roughness: 0.75, metalness: 0,
      }));
    }
    obj.name = zone.name;
    obj.userData.zoneType = zone.zoneType;
    group.add(obj);
    parts.push({ object: obj, kind: built.kind, nodal });
  });
  return { group, parts };
}
