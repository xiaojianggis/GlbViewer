// Tecplot data file reader.
// Supports ASCII (.dat/.plt/.tec) and binary PLT (#!TDV1xx, tested against TDV112 layout).
// Returns a dataset: { title, variables, zones[], warnings[] }
// zone: { name, zoneType, I, J, K, nodes, cells, npe, data[], location[], conn, cellStride, solutionTime }

const NPE = { FELINESEG: 2, FETRIANGLE: 3, FEQUADRILATERAL: 4, FETETRAHEDRON: 4, FEBRICK: 8 };
const OLD_ET = {
  LINESEG: 'FELINESEG', TRIANGLE: 'FETRIANGLE', QUADRILATERAL: 'FEQUADRILATERAL',
  TETRAHEDRON: 'FETETRAHEDRON', BRICK: 'FEBRICK',
};
const RECORDS = new Set(['TITLE', 'VARIABLES', 'ZONE', 'TEXT', 'GEOMETRY', 'DATASETAUXDATA',
  'VARAUXDATA', 'CUSTOMLABELS', 'FILETYPE']);

export function isTecplotBinary(buffer) {
  const u8 = new Uint8Array(buffer, 0, Math.min(8, buffer.byteLength));
  return String.fromCharCode(...u8).startsWith('#!TDV');
}

export function looksLikeTecplotAscii(text) {
  const head = text.slice(0, 4000).toUpperCase();
  return /(^|\n)\s*(TITLE|VARIABLES|ZONE)\s*=?/.test(head) && head.includes('ZONE');
}

export function parseTecplot(buffer) {
  if (isTecplotBinary(buffer)) return parseBinary(buffer);
  const text = new TextDecoder().decode(new Uint8Array(buffer));
  return parseAscii(text);
}

/* ------------------------------------------------------------------ ASCII */

const isWs = (c) => c === 32 || c === 9 || c === 10 || c === 13 || c === 44;

class Scanner {
  constructor(s) { this.s = s; this.i = 0; this.n = s.length; }
  skipWs() {
    const s = this.s; let i = this.i;
    while (i < this.n) {
      const c = s.charCodeAt(i);
      if (isWs(c)) { i++; continue; }
      if (c === 35) { while (i < this.n && s.charCodeAt(i) !== 10) i++; continue; } // # comment
      break;
    }
    this.i = i;
  }
  eof() { this.skipWs(); return this.i >= this.n; }
  peek() { this.skipWs(); return this.s[this.i]; }
  isNumStart() { const c = this.peek(); return c !== undefined && /[0-9+\-.]/.test(c); }
  word() {
    this.skipWs();
    const s = this.s, st = this.i; let i = st;
    while (i < this.n && !/[\s,=()"']/.test(s[i])) i++;
    this.i = i;
    return s.slice(st, i);
  }
  peekWord() { const save = this.i; const w = this.word(); this.i = save; return w; }
  expect(ch) { this.skipWs(); if (this.s[this.i] === ch) { this.i++; return true; } return false; }
  quoted() {
    this.skipWs();
    const q = this.s[this.i++]; const st = this.i;
    const e = this.s.indexOf(q, st);
    this.i = e < 0 ? this.n : e + 1;
    return this.s.slice(st, e < 0 ? this.n : e);
  }
  value() {
    this.skipWs();
    const c = this.s[this.i];
    if (c === '"' || c === "'") return this.quoted();
    if (c === '(' || c === '[') {
      const open = c, close = c === '(' ? ')' : ']';
      let depth = 0; const st = this.i;
      while (this.i < this.n) {
        const ch = this.s[this.i++];
        if (ch === open) depth++;
        else if (ch === close && --depth === 0) break;
      }
      return this.s.slice(st, this.i);
    }
    return this.word();
  }
  skipLine() { const e = this.s.indexOf('\n', this.i); this.i = e < 0 ? this.n : e + 1; }
  // Reads `count` numbers into out[offset + k]. Handles Tecplot repeat syntax "n*value".
  readNumbers(out, offset, count) {
    const s = this.s, n = this.n; let i = this.i, k = 0;
    while (k < count) {
      while (i < n) {
        const c = s.charCodeAt(i);
        if (isWs(c)) i++;
        else if (c === 35) { while (i < n && s.charCodeAt(i) !== 10) i++; }
        else break;
      }
      if (i >= n) throw new Error(`File ended after ${k} of ${count} expected values.`);
      const st = i;
      while (i < n && !isWs(s.charCodeAt(i))) i++;
      let tok = s.slice(st, i);
      let rep = 1;
      const star = tok.indexOf('*');
      if (star > 0) { rep = parseInt(tok.slice(0, star), 10); tok = tok.slice(star + 1); }
      let v = +tok;
      if (v !== v) { // NaN: try Fortran exponent or report a structural problem
        const t2 = tok.replace(/[dD]/, 'e');
        v = +t2;
        if (v !== v && /^[A-Za-z]/.test(tok) && !/^nan$/i.test(tok)) {
          throw new Error(`Expected a number but found "${tok.slice(0, 30)}" after ${k} of ${count} values. The zone header may not match its data.`);
        }
      }
      for (let r = 0; r < rep && k < count; r++, k++) out[offset + k] = v;
    }
    this.i = i;
  }
}

function parseIndexList(str) {
  const out = [];
  for (const part of str.split(/[,\s]+/).filter(Boolean)) {
    const m = part.match(/^(\d+)(?:-(\d+))?$/);
    if (!m) continue;
    const a = +m[1], b = m[2] ? +m[2] : a;
    for (let x = a; x <= b; x++) out.push(x);
  }
  return out;
}

function parseAssignments(v) {
  const out = [];
  const re = /\[([^\]]*)\]\s*(?:=\s*([A-Za-z0-9_.\-]+))?/g;
  let m;
  while ((m = re.exec(v))) out.push({ idx: parseIndexList(m[1]), val: m[2] ?? null });
  return out;
}

function parseAscii(text) {
  const sc = new Scanner(text);
  const ds = { title: '', variables: [], zones: [], warnings: [], format: 'Tecplot ASCII' };

  while (!sc.eof()) {
    const c = sc.peek();
    if (c === '"' || c === "'") { sc.quoted(); continue; }
    if (sc.isNumStart()) throw new Error('Found numeric data before any ZONE record.');
    const w = sc.word().toUpperCase();
    switch (w) {
      case 'TITLE': sc.expect('='); ds.title = sc.value(); break;
      case 'FILETYPE': sc.expect('='); sc.value(); break;
      case 'VARIABLES': {
        sc.expect('=');
        for (;;) {
          const ch = sc.peek();
          if (ch === undefined) break;
          if (ch === '"' || ch === "'") { ds.variables.push(sc.quoted()); continue; }
          if (/[0-9+\-.]/.test(ch)) break;
          const pw = sc.peekWord().toUpperCase();
          if (RECORDS.has(pw) || pw === '') break;
          ds.variables.push(sc.word());
        }
        break;
      }
      case 'ZONE': readAsciiZone(sc, ds); break;
      case 'DATASETAUXDATA': sc.word(); sc.expect('='); sc.value(); break;
      case 'VARAUXDATA': sc.word(); sc.word(); sc.expect('='); sc.value(); break;
      case 'CUSTOMLABELS':
        while (/["']/.test(sc.peek() ?? '')) sc.quoted();
        break;
      case 'TEXT': case 'GEOMETRY': {
        sc.skipLine();
        // skip any following numeric data lines (geometry coordinates)
        while (!sc.eof() && sc.isNumStart()) sc.skipLine();
        ds.warnings.push(`${w} records are ignored.`);
        break;
      }
      default:
        ds.warnings.push(`Unknown record "${w.slice(0, 20)}" skipped.`);
        sc.skipLine();
    }
  }
  if (!ds.zones.length) throw new Error('No zones found in Tecplot file.');
  return ds;
}

function readAsciiZone(sc, ds) {
  const z = {
    name: `Zone ${ds.zones.length + 1}`, I: 1, J: 1, K: 1, N: 0, E: 0,
    zoneType: null, packing: 'POINT', fe: false, et: null,
    varLocation: null, varShare: [], passive: [], connShare: null, solutionTime: null,
  };
  for (;;) {
    if (sc.eof() || sc.isNumStart()) break;
    const ch = sc.peek();
    if (ch === '"' || ch === "'") { sc.quoted(); continue; }
    const save = sc.i;
    const key = sc.word().toUpperCase();
    if (RECORDS.has(key)) { sc.i = save; break; }
    if (key === 'AUXDATA') { sc.word(); sc.expect('='); sc.value(); continue; }
    if (!sc.expect('=')) { if (!key) sc.i++; continue; }
    const v = sc.value();
    const uv = typeof v === 'string' ? v.toUpperCase() : v;
    switch (key) {
      case 'T': z.name = v; break;
      case 'I': z.I = parseInt(v, 10); break;
      case 'J': z.J = parseInt(v, 10); break;
      case 'K': z.K = parseInt(v, 10); break;
      case 'N': case 'NODES': z.N = parseInt(v, 10); z.fe = true; break;
      case 'E': case 'ELEMENTS': z.E = parseInt(v, 10); z.fe = true; break;
      case 'F': case 'DATAPACKING':
        if (uv.startsWith('FE')) z.fe = true;
        z.packing = uv.endsWith('BLOCK') ? 'BLOCK' : 'POINT';
        break;
      case 'ET': z.et = OLD_ET[uv] ?? uv; z.fe = true; break;
      case 'ZONETYPE': z.zoneType = uv; break;
      case 'VARLOCATION': z.varLocation = v; break;
      case 'VARSHARELIST': z.varShare = parseAssignments(v); break;
      case 'PASSIVEVARLIST': z.passive = parseIndexList(v.replace(/[()[\]]/g, '')); break;
      case 'CONNECTIVITYSHAREZONE': z.connShare = parseInt(v, 10); break;
      case 'SOLUTIONTIME': z.solutionTime = parseFloat(v); break;
      case 'FACENEIGHBORCONNECTIONS':
        if (parseInt(v, 10) > 0) ds.warnings.push('Face neighbor connections are not supported and may break parsing.');
        break;
      default: break; // STRANDID, DT, C, PARENTZONE, etc.
    }
  }

  // If VARIABLES was omitted, infer the count from the first data line.
  if (!ds.variables.length) {
    const lineEnd = sc.s.indexOf('\n', sc.i);
    const line = sc.s.slice(sc.i, lineEnd < 0 ? sc.n : lineEnd).trim();
    const count = line.split(/[\s,]+/).filter(Boolean).length || 2;
    for (let v = 0; v < count; v++) ds.variables.push(`V${v + 1}`);
  }
  const nv = ds.variables.length;

  let zoneType = z.zoneType;
  if (!zoneType) zoneType = z.fe ? (z.et ?? 'FEQUADRILATERAL') : 'ORDERED';
  if (zoneType === 'FEPOLYGON' || zoneType === 'FEPOLYHEDRON') {
    throw new Error(`${zoneType} zones are not supported yet (zone "${z.name}").`);
  }
  const ordered = zoneType === 'ORDERED';
  const nodes = ordered ? z.I * z.J * z.K : z.N;
  const cells = ordered
    ? Math.max(z.I - 1, 1) * Math.max(z.J - 1, 1) * Math.max(z.K - 1, 1)
    : z.E;

  // variable locations
  const location = new Array(nv).fill('NODAL');
  if (z.varLocation) {
    if (z.varLocation.includes('[')) {
      for (const a of parseAssignments(z.varLocation)) {
        for (const idx of a.idx) if (idx >= 1 && idx <= nv) location[idx - 1] = (a.val ?? 'NODAL').toUpperCase();
      }
    } else {
      z.varLocation.replace(/[()]/g, '').split(/[\s,]+/).filter(Boolean)
        .forEach((t, idx) => { if (idx < nv) location[idx] = t.toUpperCase(); });
    }
  }

  const data = new Array(nv).fill(null);
  const shared = new Array(nv).fill(-1);
  for (const a of z.varShare) {
    const src = a.val ? parseInt(a.val, 10) - 1 : ds.zones.length - 1;
    for (const idx of a.idx) if (idx >= 1 && idx <= nv) shared[idx - 1] = src;
  }
  const passive = new Set(z.passive.map((x) => x - 1));
  const active = [];
  for (let v = 0; v < nv; v++) {
    if (shared[v] >= 0) {
      const srcZone = ds.zones[shared[v]];
      if (!srcZone) throw new Error(`Zone "${z.name}" shares from missing zone ${shared[v] + 1}.`);
      data[v] = srcZone.data[v];
      location[v] = srcZone.location[v];
    } else if (passive.has(v)) {
      data[v] = new Float32Array(location[v] === 'CELLCENTERED' ? cells : nodes);
    } else active.push(v);
  }

  if (z.packing === 'POINT') {
    const na = active.length;
    const tmp = new Float32Array(nodes * na);
    sc.readNumbers(tmp, 0, nodes * na);
    for (let a = 0; a < na; a++) {
      const arr = new Float32Array(nodes);
      for (let p = 0; p < nodes; p++) arr[p] = tmp[p * na + a];
      data[active[a]] = arr;
    }
  } else {
    for (const v of active) {
      const count = location[v] === 'CELLCENTERED' ? cells : nodes;
      const arr = new Float32Array(count);
      sc.readNumbers(arr, 0, count);
      data[v] = arr;
    }
  }

  let conn = null;
  const npe = NPE[zoneType] ?? 0;
  if (!ordered) {
    if (z.connShare) {
      conn = ds.zones[z.connShare - 1]?.conn ?? null;
    } else {
      const raw = new Float64Array(cells * npe);
      sc.readNumbers(raw, 0, cells * npe);
      conn = new Uint32Array(raw.length);
      for (let k = 0; k < raw.length; k++) conn[k] = raw[k] - 1;
    }
  }

  ds.zones.push({
    name: z.name, zoneType, I: z.I, J: z.J, K: z.K, nodes, cells, npe, data, location, conn,
    cellStride: ordered ? [Math.max(z.I - 1, 1), Math.max(z.I - 1, 1) * Math.max(z.J - 1, 1)] : null,
    solutionTime: z.solutionTime,
  });
}

/* ----------------------------------------------------------------- BINARY */

const BIN_ZONE_TYPES = ['ORDERED', 'FELINESEG', 'FETRIANGLE', 'FEQUADRILATERAL', 'FETETRAHEDRON',
  'FEBRICK', 'FEPOLYGON', 'FEPOLYHEDRON'];

function parseBinary(buffer) {
  const dv = new DataView(buffer);
  const magic = String.fromCharCode(...new Uint8Array(buffer, 0, 8));
  const ver = parseInt(magic.slice(5), 10);
  if (ver >= 190) throw new Error(`This is a Tecplot SZL file (${magic}). Export it as binary PLT or ASCII from Tecplot.`);
  let p = 8;
  const i32 = () => { const v = dv.getInt32(p, true); p += 4; return v; };
  const f32 = () => { const v = dv.getFloat32(p, true); p += 4; return v; };
  const f64 = () => { const v = dv.getFloat64(p, true); p += 8; return v; };
  const str = () => { let s = ''; for (;;) { const c = i32(); if (c === 0) break; s += String.fromCharCode(c); } return s; };

  const ds = { title: '', variables: [], zones: [], warnings: [], format: `Tecplot binary (${magic.slice(2)})` };
  if (ver < 112) ds.warnings.push(`Binary version ${ver} is read with the TDV112 layout and may not load correctly.`);
  if (i32() !== 1) throw new Error('Big-endian Tecplot binary files are not supported.');
  if (ver >= 111) i32(); // file type (full / grid / solution)
  ds.title = str();
  const nv = i32();
  for (let v = 0; v < nv; v++) ds.variables.push(str());

  const headers = [];
  for (;;) {
    if (p + 4 > buffer.byteLength) throw new Error('Unexpected end of file in header section.');
    const marker = f32();
    if (marker === 357.0) break;
    if (marker === 299.0) {
      const h = { name: str() };
      if (ver >= 107) { i32(); /* parent */ h.strand = i32(); h.solutionTime = f64(); }
      i32(); // zone color (unused)
      h.zoneType = BIN_ZONE_TYPES[i32()] ?? 'ORDERED';
      h.packing = ver < 112 ? (i32() === 1 ? 'POINT' : 'BLOCK') : 'BLOCK';
      h.location = new Array(nv).fill('NODAL');
      if (i32() === 1) for (let v = 0; v < nv; v++) h.location[v] = i32() === 1 ? 'CELLCENTERED' : 'NODAL';
      h.rawFaceNbrs = i32();
      h.miscNbrs = i32();
      if (h.miscNbrs !== 0) { i32(); if (h.zoneType !== 'ORDERED') i32(); }
      if (h.zoneType === 'ORDERED') { h.I = i32(); h.J = i32(); h.K = i32(); }
      else {
        if (h.zoneType === 'FEPOLYGON' || h.zoneType === 'FEPOLYHEDRON') {
          throw new Error(`${h.zoneType} zones are not supported yet (zone "${h.name}").`);
        }
        h.N = i32(); h.E = i32(); i32(); i32(); i32();
      }
      while (i32() === 1) { str(); i32(); str(); } // zone aux data
      headers.push(h);
    } else if (marker === 799.0) { str(); i32(); str(); }
    else if (marker === 899.0) { i32(); str(); i32(); str(); }
    else if (marker === 599.0) { const n = i32(); for (let k = 0; k < n; k++) str(); }
    else if (marker === 699.0) { str(); }
    else if (marker === 399.0 || marker === 499.0) {
      throw new Error('Binary files containing geometry or text records are not supported. Remove them before exporting.');
    } else throw new Error(`Unrecognised header marker ${marker} at byte ${p - 4}.`);
  }

  for (const h of headers) {
    if (f32() !== 299.0) throw new Error(`Missing zone data marker for zone "${h.name}".`);
    const fmt = []; for (let v = 0; v < nv; v++) fmt.push(i32());
    const passive = new Array(nv).fill(0);
    if (i32() !== 0) for (let v = 0; v < nv; v++) passive[v] = i32();
    const share = new Array(nv).fill(-1);
    if (i32() !== 0) for (let v = 0; v < nv; v++) share[v] = i32();
    const connShare = i32();
    for (let v = 0; v < nv; v++) if (!passive[v] && share[v] === -1) { f64(); f64(); }

    const ordered = h.zoneType === 'ORDERED';
    const nodes = ordered ? h.I * h.J * h.K : h.N;
    // Binary ordered cell-centred data is padded: stride I, I*J
    let cells, cellStride = null;
    if (ordered) {
      const dims = [h.I, h.J, h.K];
      const nd = dims.filter((d) => d > 1).length;
      cells = nd === 3 ? h.I * h.J * (h.K - 1) : nd === 2 ? (h.J > 1 ? h.I * (h.J - 1) : h.I * (h.K - 1)) : Math.max(nodes - 1, 1);
      cellStride = [h.I, h.I * h.J];
    } else cells = h.E;

    const data = new Array(nv).fill(null);
    const readArr = (count, f) => {
      const out = new Float32Array(count);
      if (f === 1) {
        if (p % 4 === 0) out.set(new Float32Array(buffer, p, count));
        else for (let k = 0; k < count; k++) out[k] = dv.getFloat32(p + k * 4, true);
        p += count * 4;
      } else if (f === 2) { for (let k = 0; k < count; k++) out[k] = dv.getFloat64(p + k * 8, true); p += count * 8; }
      else if (f === 3) { for (let k = 0; k < count; k++) out[k] = dv.getInt32(p + k * 4, true); p += count * 4; }
      else if (f === 4) { for (let k = 0; k < count; k++) out[k] = dv.getInt16(p + k * 2, true); p += count * 2; }
      else if (f === 5) { for (let k = 0; k < count; k++) out[k] = dv.getUint8(p + k); p += count; }
      else if (f === 6) { for (let k = 0; k < count; k++) out[k] = (dv.getUint8(p + (k >> 3)) >> (k & 7)) & 1; p += Math.ceil(count / 8); }
      else throw new Error(`Unknown data format ${f}.`);
      return out;
    };

    const active = [];
    for (let v = 0; v < nv; v++) {
      if (share[v] !== -1) { data[v] = ds.zones[share[v]]?.data[v]; h.location[v] = ds.zones[share[v]]?.location[v] ?? h.location[v]; }
      else if (passive[v]) data[v] = new Float32Array(h.location[v] === 'CELLCENTERED' ? cells : nodes);
      else active.push(v);
    }
    if (h.packing === 'POINT') {
      for (const v of active) data[v] = new Float32Array(nodes);
      for (let n = 0; n < nodes; n++) for (const v of active) data[v][n] = readArr(1, fmt[v])[0];
    } else {
      for (const v of active) data[v] = readArr(h.location[v] === 'CELLCENTERED' ? cells : nodes, fmt[v]);
    }

    let conn = null;
    const npe = NPE[h.zoneType] ?? 0;
    if (!ordered) {
      if (connShare !== -1) conn = ds.zones[connShare]?.conn ?? null;
      else {
        const count = h.E * npe;
        conn = new Uint32Array(count);
        for (let k = 0; k < count; k++) conn[k] = dv.getInt32(p + k * 4, true);
        p += count * 4;
        if (h.rawFaceNbrs || h.miscNbrs) {
          ds.warnings.push('Face neighbour data present; only the first zone with it is guaranteed to load.');
        }
      }
    }
    ds.zones.push({
      name: h.name, zoneType: h.zoneType, I: h.I ?? 1, J: h.J ?? 1, K: h.K ?? 1,
      nodes, cells, npe, data, location: h.location, conn, cellStride, solutionTime: h.solutionTime ?? null,
    });
  }
  return ds;
}
