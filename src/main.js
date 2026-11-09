import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { loadFiles, loadURL, Z_UP } from './loaders.js';
import { COLORMAPS, buildLUT, lutTexture, lutToCss, lutColorLinear, UTCI_CLASSES } from './colormaps.js';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const stage = $('#stage');

/* ------------------------------------------------------------ renderer */
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, logarithmicDepthBuffer: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.NeutralToneMapping;
renderer.localClippingEnabled = true;
renderer.setClearColor(0x000000, 0);
stage.prepend(renderer.domElement);

const scene = new THREE.Scene();
const world = new THREE.Group(); world.name = 'world'; scene.add(world);
const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 1000);
camera.position.set(4, 3, 5);
scene.add(camera);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true; controls.dampingFactor = 0.12; controls.screenSpacePanning = true;

const pmrem = new THREE.PMREMGenerator(renderer);
const envMap = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environment = envMap;
const hemi = new THREE.HemisphereLight(0xffffff, 0x8899a6, 0.6); scene.add(hemi);
const sun = new THREE.DirectionalLight(0xffffff, 1.4); sun.position.set(0.5, 1, 0.8); camera.add(sun);

const grid = new THREE.GridHelper(10, 20, 0x7d8d99, 0xaab6be);
grid.material.transparent = true; grid.material.opacity = 0.55; grid.material.depthWrite = false;
scene.add(grid);

/* axis gizmo, drawn in the corner */
const gizmoScene = new THREE.Scene();
const gizmoCam = new THREE.OrthographicCamera(-1.6, 1.6, 1.6, -1.6, 0.1, 10);
const gizmo = new THREE.Group(); gizmoScene.add(gizmo);
[['X', 0xd1495b, [1, 0, 0]], ['Y', 0x3f9b4f, [0, 1, 0]], ['Z', 0x2f6fbf, [0, 0, 1]]].forEach(([label, color, dir]) => {
  const v = new THREE.Vector3(...dir);
  gizmo.add(new THREE.ArrowHelper(v, new THREE.Vector3(), 1, color, 0.28, 0.16));
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d'); g.fillStyle = '#' + color.toString(16).padStart(6, '0');
  g.beginPath(); g.arc(32, 32, 26, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#fff'; g.font = '600 34px system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(label, 32, 34);
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false }));
  s.position.copy(v).multiplyScalar(1.32); s.scale.setScalar(0.5); gizmo.add(s);
});

/* ------------------------------------------------------------ state */
const S = {
  items: [], activeId: null, nextId: 1, origin: null, upAxis: null,
  wire: false, flat: false, unlit: false, env: true, light: 1, pointSize: 2, showGrid: true, showAxes: true,
  clip: { on: false, axis: 'y', pos: 0.5, flip: false }, tool: 'probe',
  bounds: new THREE.Box3(), radius: 1,
};
const clipPlane = new THREE.Plane(new THREE.Vector3(0, -1, 0), 0);
const clock = new THREE.Clock();
const loaderCtx = { renderer, getOrigin: () => S.origin, setOrigin: (o) => { S.origin ??= o; } };
const activeItem = () => S.items.find((i) => i.id === S.activeId);

/* ------------------------------------------------------------ sizing + loop */
function resize() {
  const w = stage.clientWidth, h = stage.clientHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / Math.max(h, 1); camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(stage);
resize();

const _v = new THREE.Vector3();
function loop() {
  requestAnimationFrame(loop);
  const dt = clock.getDelta();
  S.items.forEach((it) => it.mixer?.update(dt * (it.speed ?? 1)));
  controls.update();
  renderer.setScissorTest(false);
  renderer.render(scene, camera);
  if (S.showAxes && S.items.length) {
    gizmo.quaternion.copy(world.quaternion);
    gizmoCam.position.copy(_v.copy(camera.position).sub(controls.target).normalize().multiplyScalar(4));
    gizmoCam.up.copy(camera.up); gizmoCam.lookAt(0, 0, 0);
    const size = 96, pr = 1;
    renderer.autoClear = false;
    renderer.setViewport(8 * pr, 8 * pr, size, size);
    renderer.setScissor(8 * pr, 8 * pr, size, size); renderer.setScissorTest(true);
    renderer.clearDepth();
    renderer.render(gizmoScene, gizmoCam);
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, stage.clientWidth, stage.clientHeight);
    renderer.autoClear = true;
  }
  updateTags();
}

/* ------------------------------------------------------------ helpers */
let toastTimer;
function toast(msg, err = false, ms = 3600) {
  const t = $('#toast'); t.textContent = msg; t.classList.toggle('err', err); t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}
const fmt = (v) => {
  if (!Number.isFinite(v)) return '–';
  const a = Math.abs(v);
  if (a !== 0 && (a >= 1e6 || a < 1e-3)) return v.toExponential(2);
  return (+v.toPrecision(a >= 1000 ? 6 : 4)).toLocaleString(undefined, { maximumFractionDigits: 4 });
};
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const forMaterials = (obj, fn) => obj.traverse((o) => {
  if (!o.material) return;
  (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => fn(m, o));
});

function disposeObject(obj) {
  obj.traverse((o) => {
    o.geometry?.dispose();
    if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => {
      for (const k in m) if (m[k]?.isTexture) m[k].dispose();
      m.dispose();
    });
  });
}

/* ------------------------------------------------------------ loading */
async function openFiles(files, label) {
  if (!files.length) return;
  setLoading(`Reading ${label ?? (files.length === 1 ? files[0].name : files.length + ' files')}…`);
  try {
    addItems(await loadFiles(files, loaderCtx));
  } catch (e) { console.error(e); toast(e.message, true, 6000); }
  setLoading(null);
}
async function openURL(url, name) {
  setLoading(`Downloading ${name ?? decodeURIComponent(url.split('/').pop().split('?')[0])}…`);
  try {
    addItems(await loadURL(url, loaderCtx, name));
  } catch (e) {
    console.error(e);
    toast(/fetch|network/i.test(e.message) ? 'Could not download that file. The server may block cross-origin requests.' : e.message, true, 6000);
  }
  setLoading(null);
}
function setLoading(text) {
  $('#loading').hidden = !text;
  if (text) $('#loadingText').textContent = text;
}

function addItems(results) {
  const ok = results.filter((r) => !r.error);
  results.filter((r) => r.error).forEach((r) => {
    S.items.push({ id: S.nextId++, name: r.name, error: r.error });
    toast(`${r.name}: ${r.error}`, true, 7000);
  });
  if (S.upAxis === null && ok.length) setUpAxis(Z_UP.has(ok[0].ext) ? 'Z' : 'Y', false);
  for (const r of ok) {
    const it = { ...r, id: S.nextId++, visible: true, speed: 1 };
    it.root = new THREE.Group(); it.root.name = it.name; it.root.userData.itemId = it.id;
    it.root.add(it.object);
    world.add(it.root);
    if (it.animations?.length) {
      it.mixer = new THREE.AnimationMixer(it.object);
      it.clipIndex = 0;
      it.action = it.mixer.clipAction(it.animations[0]); it.action.play();
      it.playing = true;
    }
    if (it.field) initField(it);
    applyDisplay(it);
    it.stats = computeStats(it.object);
    S.items.push(it);
    S.activeId = it.id;
    it.warnings?.forEach((w) => console.warn(`${it.name}: ${w}`));
  }
  if (ok.length) { refreshBounds(); fitView('iso'); }
  renderUI();
}

function removeItem(id) {
  const it = S.items.find((i) => i.id === id);
  if (!it) return;
  if (it.root) { world.remove(it.root); disposeObject(it.root); it.lutTex?.dispose(); }
  S.items = S.items.filter((i) => i !== it);
  if (S.activeId === id) S.activeId = S.items.filter((i) => !i.error).at(-1)?.id ?? null;
  if (!S.items.some((i) => i.root)) { S.origin = null; S.upAxis = null; }
  clearProbe(); clearMeasure();
  refreshBounds();
  renderUI();
}

function computeStats(obj) {
  const s = { meshes: 0, vertices: 0, triangles: 0, points: 0, lines: 0, materials: new Set(), textures: new Set() };
  obj.traverse((o) => {
    const g = o.geometry;
    if (!g?.attributes?.position) return;
    const n = g.attributes.position.count;
    if (o.isMesh) { s.meshes++; s.vertices += n; s.triangles += (g.index ? g.index.count : n) / 3; }
    else if (o.isPoints) s.points += n;
    else if (o.isLine) s.lines += (g.index ? g.index.count : n) / 2;
  });
  forMaterials(obj, (m) => { s.materials.add(m); for (const k in m) if (m[k]?.isTexture) s.textures.add(m[k]); });
  return s;
}

/* ------------------------------------------------------------ fields / colour */
function initField(it) {
  const name = it.field.variables[it.field.defaultVar] ?? '';
  it.fs = { v: it.field.defaultVar, cmap: /utci/i.test(name) ? 'utci' : 'viridis', bands: 0, invert: false, auto: true, min: 0, max: 1, ranges: {} };
  applyField(it);
}

function dataRange(it, v) {
  if (it.fs.ranges[v]) return it.fs.ranges[v];
  let lo = Infinity, hi = -Infinity;
  for (const p of it.field.parts) {
    const a = p.nodal(v); if (!a) continue;
    for (let k = 0; k < a.length; k++) { const x = a[k]; if (x < lo) lo = x; if (x > hi) hi = x; }
  }
  if (!Number.isFinite(lo)) { lo = 0; hi = 1; }
  if (lo === hi) { lo -= 0.5; hi += 0.5; }
  return (it.fs.ranges[v] = [lo, hi]);
}

const SOLID_MESH = 0xb8c2cc, SOLID_POINTS = 0x3b6e8f;

function applyField(it) {
  const { field, fs } = it;
  it.lutTex?.dispose(); it.lutTex = null; it.lut = null;
  if (fs.v >= 0) {
    if (fs.auto) [fs.min, fs.max] = dataRange(it, fs.v);
    it.lut = buildLUT(fs);
    it.lutTex = lutTexture(it.lut, fs.bands > 0 || fs.cmap === 'utci');
  }
  const span = fs.max - fs.min || 1;
  for (const p of field.parts) {
    const o = p.object, g = o.geometry, m = o.material;
    const n = g.attributes.position.count;
    m.map = null; m.emissiveMap = null; m.emissive?.set(0x000000); m.toneMapped = true;
    if (fs.v === -1) {
      m.vertexColors = false; m.color.set(p.kind === 'mesh' ? SOLID_MESH : SOLID_POINTS);
    } else if (fs.v === -2 && p.rgb) {
      g.setAttribute('color', new THREE.BufferAttribute(p.rgb, 3));
      m.vertexColors = true; m.color.set(0xffffff);
    } else if (fs.v >= 0) {
      const a = p.nodal(fs.v);
      if (p.kind === 'mesh') {
        const uv = new Float32Array(n * 2);
        for (let k = 0; k < n; k++) {
          let t = (a[k] - fs.min) / span; t = t !== t ? 0 : Math.min(1, Math.max(0, t));
          uv[k * 2] = (0.5 + t * 255) / 256; uv[k * 2 + 1] = 0.5;
        }
        g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
        m.vertexColors = false;
        if (S.unlit && m.emissive) { m.color.set(0x000000); m.emissive.set(0xffffff); m.emissiveMap = it.lutTex; m.toneMapped = false; }
        else { m.color.set(0xffffff); m.map = it.lutTex; }
      } else {
        const col = new Float32Array(n * 3);
        for (let k = 0; k < n; k++) lutColorLinear(it.lut, (a[k] - fs.min) / span, col, k * 3);
        g.setAttribute('color', new THREE.BufferAttribute(col, 3));
        m.vertexColors = true; m.color.set(0xffffff);
      }
    }
    m.needsUpdate = true;
  }
  renderLegend();
}

function renderLegend() {
  const it = activeItem();
  const lg = $('#legend');
  if (!it?.field || it.fs.v < 0 || !it.visible) { lg.hidden = true; return; }
  const { fs } = it;
  lg.hidden = false;
  $('#legendTitle').textContent = it.field.variables[fs.v];
  $('#legendBar').style.background = `linear-gradient(90deg, ${lutToCss(it.lut)})`;
  const ticks = $('#legendTicks');
  let vals;
  if (fs.cmap === 'utci') vals = [fs.min, ...UTCI_CLASSES.map((c) => c.max).filter((x) => x > fs.min && x < fs.max), fs.max];
  else vals = [0, 0.25, 0.5, 0.75, 1].map((t) => fs.min + t * (fs.max - fs.min));
  if (vals.length > 7) vals = [vals[0], ...vals.slice(1, -1).filter((_, i) => i % 2 === 0), vals.at(-1)];
  ticks.innerHTML = vals.map((v) => `<span style="left:${((v - fs.min) / (fs.max - fs.min) * 100).toFixed(2)}%">${fmt(v)}</span>`).join('');
  lg.querySelector('.legend-classes')?.remove();
  if (fs.cmap === 'utci') {
    const present = UTCI_CLASSES.filter((c, i) => c.max > fs.min && (i === 0 || UTCI_CLASSES[i - 1].max < fs.max));
    const div = document.createElement('div'); div.className = 'legend-classes';
    div.innerHTML = present.reverse().map((c) => `<i style="background:${c.color}"></i><span>${c.label}</span>`).join('');
    lg.append(div);
  }
}

/* ------------------------------------------------------------ display */
function applyDisplay(it) {
  forMaterials(it.root, (m, o) => {
    if ('wireframe' in m && o.isMesh) m.wireframe = S.wire;
    if ('flatShading' in m && o.isMesh) {
      if (m.userData.flat0 === undefined) m.userData.flat0 = m.flatShading;
      m.flatShading = S.flat || m.userData.flat0;
    }
    if (m.isPointsMaterial) { m.size = S.pointSize; m.sizeAttenuation = false; }
    m.clippingPlanes = S.clip.on ? [clipPlane] : null;
    if ('envMapIntensity' in m) m.envMapIntensity = S.env ? S.light : 0;
    m.needsUpdate = true;
  });
}
const applyDisplayAll = () => S.items.forEach((it) => it.root && applyDisplay(it));

function setUpAxis(axis, refit = true) {
  S.upAxis = axis;
  world.rotation.set(axis === 'Z' ? -Math.PI / 2 : 0, 0, 0);
  world.updateMatrixWorld(true);
  $$('[data-up]').forEach((b) => b.setAttribute('aria-pressed', b.dataset.up === axis));
  if (refit) { refreshBounds(); fitView('iso'); }
}

function refreshBounds() {
  world.updateMatrixWorld(true);
  S.bounds.makeEmpty();
  S.items.forEach((it) => { if (it.root && it.visible) S.bounds.expandByObject(it.root); });
  const has = !S.bounds.isEmpty();
  const size = has ? S.bounds.getSize(new THREE.Vector3()) : new THREE.Vector3(10, 10, 10);
  const center = has ? S.bounds.getCenter(new THREE.Vector3()) : new THREE.Vector3();
  S.radius = Math.max(size.length() / 2, 1e-6);
  // grid: a round size slightly bigger than the footprint
  const span = Math.max(size.x, size.z, 1e-6) * 1.3;
  const step = 10 ** Math.floor(Math.log10(span / 10));
  const gsize = Math.ceil(span / step / 10) * 10 * step;
  grid.scale.setScalar(gsize / 10);
  grid.position.set(center.x, has ? S.bounds.min.y : 0, center.z);
  grid.visible = S.showGrid && has;
  updateClip();
}

function fitView(view = 'iso', box = S.bounds) {
  if (box.isEmpty()) return;
  const center = box.getCenter(new THREE.Vector3());
  const radius = Math.max(box.getSize(new THREE.Vector3()).length() / 2, 1e-6);
  const dist = radius / Math.sin(THREE.MathUtils.degToRad(camera.fov / 2)) * 1.05;
  const dirs = { iso: [1, 0.75, 1.25], top: [0, 1, 0.0001], front: [0, 0.0001, 1], side: [1, 0.0001, 0] };
  let dir;
  if (view === 'fit') dir = camera.position.clone().sub(controls.target).normalize();
  else dir = new THREE.Vector3(...dirs[view]).normalize();
  camera.position.copy(center).addScaledVector(dir, dist);
  camera.near = dist / 1e4; camera.far = dist * 100; camera.updateProjectionMatrix();
  controls.target.copy(center);
  controls.update();
}

function updateClip() {
  const { axis, pos, flip, on } = S.clip;
  const i = { x: 0, y: 1, z: 2 }[axis];
  const b = S.bounds.isEmpty() ? null : S.bounds;
  const lo = b ? b.min.getComponent(i) : -1, hi = b ? b.max.getComponent(i) : 1;
  const at = lo + (hi - lo) * pos;
  const n = new THREE.Vector3(); n.setComponent(i, flip ? 1 : -1);
  clipPlane.normal.copy(n); clipPlane.constant = flip ? -at : at;
  $$('[data-clip]').forEach((btn) => btn.setAttribute('aria-pressed', btn.dataset.clip === axis));
  void on;
}

/* ------------------------------------------------------------ probe + measure */
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
let probe = null; // { point, html }
const measure = { pts: [], line: null };

function pick(ev) {
  const r = renderer.domElement.getBoundingClientRect();
  pointer.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
  raycaster.setFromCamera(pointer, camera);
  raycaster.params.Points.threshold = S.radius / 400;
  raycaster.params.Line.threshold = S.radius / 400;
  const targets = S.items.filter((i) => i.root && i.visible).map((i) => i.root);
  const hits = raycaster.intersectObjects(targets, true).filter((h) => h.object.visible && passesClip(h.point));
  return hits[0] ?? null;
}
const passesClip = (p) => !S.clip.on || clipPlane.distanceToPoint(p) >= 0;

function itemOf(obj) {
  while (obj && obj.userData.itemId === undefined) obj = obj.parent;
  return S.items.find((i) => i.id === obj?.userData.itemId);
}

const _tri = new THREE.Triangle(), _bary = new THREE.Vector3(), _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3();
function valueAt(it, hit) {
  if (!it.field || it.fs.v < 0) return null;
  const part = it.field.parts.find((p) => p.object === hit.object);
  if (!part) return null;
  const arr = part.nodal(it.fs.v);
  if (hit.face) {
    const pos = hit.object.geometry.attributes.position;
    const { a, b, c } = hit.face;
    _tri.set(_a.fromBufferAttribute(pos, a), _b.fromBufferAttribute(pos, b), _c.fromBufferAttribute(pos, c));
    _tri.getBarycoord(hit.object.worldToLocal(hit.point.clone()), _bary);
    return arr[a] * _bary.x + arr[b] * _bary.y + arr[c] * _bary.z;
  }
  if (hit.index !== undefined) return arr[hit.index];
  return null;
}

function doProbe(hit) {
  const it = itemOf(hit.object);
  const local = it.root.worldToLocal(hit.point.clone());
  const o = it.origin ?? [0, 0, 0];
  const xyz = [local.x + o[0], local.y + o[1], local.z + o[2]];
  let html = `<b>${esc(hit.object.name || it.name)}</b><br>X ${fmt(xyz[0])} &nbsp; Y ${fmt(xyz[1])} &nbsp; Z ${fmt(xyz[2])}`;
  const val = valueAt(it, hit);
  if (val !== null && val !== undefined) html += `<br><span class="v">${esc(it.field.variables[it.fs.v])} = <b>${fmt(val)}</b></span>`;
  probe = { point: hit.point.clone() };
  $('#probeTag').innerHTML = html;
}
function clearProbe() { probe = null; $('#probeTag').hidden = true; }

function doMeasure(hit) {
  if (measure.pts.length >= 2) clearMeasure();
  measure.pts.push(hit.point.clone());
  if (measure.line) { scene.remove(measure.line); measure.line.geometry.dispose(); }
  const g = new THREE.BufferGeometry().setFromPoints(measure.pts.length === 1 ? [measure.pts[0], measure.pts[0]] : measure.pts);
  measure.line = new THREE.Line(g, new THREE.LineBasicMaterial({ color: 0x15222c, depthTest: false }));
  measure.line.renderOrder = 999;
  scene.add(measure.line);
  if (measure.pts.length === 2) {
    const [p, q] = measure.pts;
    const d = p.distanceTo(q);
    const dv = world.worldToLocal(q.clone()).sub(world.worldToLocal(p.clone()));
    $('#measureTag').innerHTML = `${fmt(d)}<span style="font-weight:400;color:var(--muted)"> &nbsp;Δx ${fmt(Math.abs(dv.x))} · Δy ${fmt(Math.abs(dv.y))} · Δz ${fmt(Math.abs(dv.z))}</span>`;
  } else $('#measureTag').innerHTML = 'Click a second point';
}
function clearMeasure() {
  measure.pts = [];
  if (measure.line) { scene.remove(measure.line); measure.line.geometry.dispose(); measure.line = null; }
  $('#measureTag').hidden = true;
}

function placeTag(el, p) {
  _v.copy(p).project(camera);
  const visible = _v.z < 1 && _v.z > -1;
  el.hidden = !visible;
  if (visible) {
    el.style.left = `${(_v.x * 0.5 + 0.5) * stage.clientWidth}px`;
    el.style.top = `${(-_v.y * 0.5 + 0.5) * stage.clientHeight}px`;
  }
}
function updateTags() {
  if (probe) placeTag($('#probeTag'), probe.point);
  if (measure.pts.length) placeTag($('#measureTag'), measure.pts.length === 2 ? measure.pts[0].clone().lerp(measure.pts[1], 0.5) : measure.pts[0]);
}

let down = null;
renderer.domElement.addEventListener('pointerdown', (e) => { down = [e.clientX, e.clientY, e.button]; });
renderer.domElement.addEventListener('pointerup', (e) => {
  if (!down || down[2] !== 0 || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 4) { down = null; return; }
  down = null;
  const hit = pick(e);
  if (S.tool === 'measure') { if (hit) doMeasure(hit); }
  else if (hit) doProbe(hit); else clearProbe();
});
renderer.domElement.addEventListener('dblclick', (e) => {
  const hit = pick(e);
  if (hit) { controls.target.copy(hit.point); controls.update(); }
});

/* ------------------------------------------------------------ UI */
const ICON_EYE = '<svg viewBox="0 0 16 16"><path d="M1 8s2.6-5 7-5 7 5 7 5-2.6 5-7 5-7-5-7-5z"/><circle cx="8" cy="8" r="2.2"/></svg>';
const ICON_X = '<svg viewBox="0 0 16 16"><path d="M4 4l8 8M12 4l-8 8"/></svg>';

function renderUI() {
  const has = S.items.some((i) => i.root);
  $('#empty').hidden = has;
  $('#tools').hidden = !has;
  $('#shotBtn').disabled = !has;
  $('#clearBtn').disabled = !S.items.length;
  $('#filesEmpty').hidden = S.items.length > 0;
  renderFiles(); renderColorPanel(); renderAnim(); renderInfo(); renderLegend();
}

function renderFiles() {
  const ul = $('#fileList');
  ul.innerHTML = '';
  for (const it of S.items) {
    const li = document.createElement('li');
    li.className = 'file' + (it.id === S.activeId ? ' active' : '') + (it.error ? ' error' : '');
    const row = document.createElement('div'); row.className = 'file-row';
    row.innerHTML = it.error
      ? `<span style="width:24px"></span><span class="file-name" title="${esc(it.name)}">${esc(it.name)}</span><span class="file-fmt">Failed</span>`
      : `<button class="eye" aria-pressed="${it.visible}" aria-label="Show or hide ${esc(it.name)}">${ICON_EYE}</button>
         <span class="file-name" title="${esc(it.name)}">${esc(it.name)}</span><span class="file-fmt">${esc(it.format ?? '')}</span>`;
    const x = document.createElement('button'); x.className = 'x'; x.innerHTML = ICON_X; x.setAttribute('aria-label', `Remove ${it.name}`);
    x.onclick = (e) => { e.stopPropagation(); removeItem(it.id); };
    row.append(x);
    row.onclick = (e) => {
      if (e.target.closest('.eye')) {
        it.visible = !it.visible; it.root.visible = it.visible; refreshBounds(); renderUI(); return;
      }
      if (it.error) return;
      if (S.activeId === it.id) { const b = new THREE.Box3().setFromObject(it.root); fitView('fit', b); }
      S.activeId = it.id; renderUI();
    };
    li.append(row);
    if (it.error) {
      const d = document.createElement('div'); d.className = 'file-err'; d.textContent = it.error; li.append(d);
    } else {
      const nodes = [];
      it.object.traverse((o) => { if ((o.isMesh || o.isPoints || o.isLine) && o !== it.object) nodes.push(o); });
      if (nodes.length > 1) {
        const tb = document.createElement('button'); tb.className = 'tree-toggle';
        tb.textContent = it.treeOpen ? `Hide parts (${nodes.length})` : `Show parts (${nodes.length})`;
        tb.onclick = () => { it.treeOpen = !it.treeOpen; renderFiles(); };
        li.append(tb);
        if (it.treeOpen) {
          const tree = document.createElement('ul'); tree.className = 'tree';
          nodes.slice(0, 400).forEach((o, k) => {
            const n = document.createElement('li');
            n.innerHTML = `<button class="eye" aria-pressed="${o.visible}" aria-label="Show or hide part">${ICON_EYE}</button><span title="${esc(o.name)}">${esc(o.name || `${o.type} ${k + 1}`)}</span>`;
            n.querySelector('.eye').onclick = (e) => { o.visible = !o.visible; e.currentTarget.setAttribute('aria-pressed', o.visible); };
            tree.append(n);
          });
          if (nodes.length > 400) tree.insertAdjacentHTML('beforeend', `<li><span>…and ${nodes.length - 400} more</span></li>`);
          li.append(tree);
        }
      }
    }
    ul.append(li);
  }
}

function fillSelect(sel, opts, value) {
  sel.innerHTML = opts.map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join('');
  sel.value = String(value);
}

function renderColorPanel() {
  const it = activeItem();
  const sec = $('#colorSec');
  sec.hidden = !it?.field;
  if (!it?.field) return;
  const { field, fs } = it;
  const opts = [[-1, 'Solid color'], ...(field.hasRGB ? [[-2, 'Colors from file']] : []), ...field.variables.map((n, i) => [i, n])];
  fillSelect($('#varSel'), opts, fs.v);
  $('#fieldCtrls').hidden = fs.v < 0;
  fillSelect($('#cmapSel'), COLORMAPS.map((c) => [c.id, c.label]), fs.cmap);
  $('#minIn').value = +fs.min.toPrecision(6); $('#maxIn').value = +fs.max.toPrecision(6);
  $('#autoRange').checked = fs.auto;
  $('#invertCm').checked = fs.invert; $('#invertCm').disabled = fs.cmap === 'utci';
  $('#bandsIn').value = fs.bands; $('#bandsIn').disabled = fs.cmap === 'utci';
  $('#bandsOut').textContent = fs.bands ? `${fs.bands}` : 'smooth';
  $('#mapDetails').hidden = !field.mapping;
  if (field.mapping) {
    const v = field.variables.map((n, i) => [i, n]);
    fillSelect($('#mapX'), v, field.mapping.x);
    fillSelect($('#mapY'), v, field.mapping.y);
    fillSelect($('#mapZ'), [[-1, 'None (flat)'], ...v], field.mapping.z);
  }
}

function renderAnim() {
  const it = activeItem();
  $('#animSec').hidden = !it?.animations?.length;
  if (!it?.animations?.length) return;
  fillSelect($('#clipSel'), it.animations.map((a, i) => [i, a.name || `Clip ${i + 1}`]), it.clipIndex);
  $('#playBtn').textContent = it.playing ? 'Pause' : 'Play';
  $('#speedIn').value = it.speed;
}

function renderInfo() {
  const it = activeItem();
  $('#infoSec').hidden = !it || it.error;
  if (!it || it.error) return;
  const s = it.stats;
  const size = new THREE.Box3().setFromObject(it.object).getSize(new THREE.Vector3());
  const rows = [['Format', it.format]];
  if (s.meshes) rows.push(['Meshes', s.meshes.toLocaleString()], ['Triangles', Math.round(s.triangles).toLocaleString()], ['Vertices', s.vertices.toLocaleString()]);
  if (s.points) rows.push(['Points', s.points.toLocaleString()]);
  if (s.lines) rows.push(['Line segments', Math.round(s.lines).toLocaleString()]);
  if (s.materials.size) rows.push(['Materials', s.materials.size]);
  if (s.textures.size) rows.push(['Textures', s.textures.size]);
  rows.push(['Size', `${fmt(size.x)} × ${fmt(size.y)} × ${fmt(size.z)}`]);
  if (it.origin && it.origin.some((v) => v !== 0)) rows.push(['Shifted by', it.origin.map((v) => fmt(v)).join(', ')]);
  if (it.animations?.length) rows.push(['Animations', it.animations.length]);
  for (const [k, v] of Object.entries(it.info ?? {})) rows.push([k, v]);
  $('#infoList').innerHTML = rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('');
  $('#warnList').innerHTML = (it.warnings ?? []).map((w) => `<li>${esc(w)}</li>`).join('');
}

/* field controls */
const withField = (fn) => () => { const it = activeItem(); if (it?.field) { fn(it); applyField(it); renderColorPanel(); } };
$('#varSel').onchange = withField((it) => {
  it.fs.v = +$('#varSel').value; it.fs.auto = true;
  const name = it.field.variables[it.fs.v] ?? '';
  if (/utci/i.test(name)) it.fs.cmap = 'utci'; else if (it.fs.cmap === 'utci') it.fs.cmap = 'viridis';
});
$('#cmapSel').onchange = withField((it) => { it.fs.cmap = $('#cmapSel').value; });
$('#autoRange').onchange = withField((it) => { it.fs.auto = $('#autoRange').checked; });
$('#invertCm').onchange = withField((it) => { it.fs.invert = $('#invertCm').checked; });
$('#bandsIn').oninput = withField((it) => { it.fs.bands = +$('#bandsIn').value; });
const rangeChange = withField((it) => {
  const lo = parseFloat($('#minIn').value), hi = parseFloat($('#maxIn').value);
  if (Number.isFinite(lo) && Number.isFinite(hi) && hi > lo) { it.fs.min = lo; it.fs.max = hi; it.fs.auto = false; }
});
$('#minIn').onchange = rangeChange; $('#maxIn').onchange = rangeChange;
['#mapX', '#mapY', '#mapZ'].forEach((id) => {
  $(id).onchange = () => {
    const it = activeItem(); if (!it?.field?.rebuild) return;
    const m = { x: +$('#mapX').value, y: +$('#mapY').value, z: +$('#mapZ').value };
    const built = it.field.rebuild(m);
    it.root.remove(it.object); disposeObject(it.object);
    it.object = built.group; it.root.add(it.object);
    it.field.parts = built.parts; it.field.mapping = m;
    applyField(it); applyDisplay(it); it.stats = computeStats(it.object);
    refreshBounds(); fitView('fit'); renderUI();
  };
});

/* display controls */
$$('[data-up]').forEach((b) => { b.onclick = () => setUpAxis(b.dataset.up); });
$$('[data-bg]').forEach((b) => {
  b.onclick = () => {
    stage.dataset.bg = b.dataset.bg;
    $$('[data-bg]').forEach((x) => x.setAttribute('aria-pressed', x === b));
    grid.material.color.set(b.dataset.bg === 'dark' ? 0x50606c : 0xaab6be);
  };
});
$('[data-bg=sky]').setAttribute('aria-pressed', 'true');
$('#gridChk').onchange = (e) => { S.showGrid = e.target.checked; grid.visible = S.showGrid && !S.bounds.isEmpty(); };
$('#axesChk').onchange = (e) => { S.showAxes = e.target.checked; };
$('#wireChk').onchange = (e) => { S.wire = e.target.checked; applyDisplayAll(); };
$('#flatChk').onchange = (e) => { S.flat = e.target.checked; applyDisplayAll(); };
$('#envChk').onchange = (e) => { S.env = e.target.checked; scene.environment = S.env ? envMap : null; applyDisplayAll(); };
$('#unlitChk').onchange = (e) => { S.unlit = e.target.checked; S.items.forEach((it) => it.field && applyField(it)); };
$('#lightIn').oninput = (e) => {
  S.light = +e.target.value; sun.intensity = 1.4 * S.light; hemi.intensity = 0.6 * S.light; applyDisplayAll();
};
$('#ptIn').oninput = (e) => { S.pointSize = +e.target.value; $('#ptOut').textContent = `${S.pointSize} px`; applyDisplayAll(); };
$('#clipChk').onchange = (e) => { S.clip.on = e.target.checked; updateClip(); applyDisplayAll(); };
$('#clipFlip').onchange = (e) => { S.clip.flip = e.target.checked; updateClip(); };
$('#clipPos').oninput = (e) => {
  S.clip.pos = +e.target.value;
  if (!S.clip.on) { S.clip.on = true; $('#clipChk').checked = true; applyDisplayAll(); }
  updateClip();
};
$$('[data-clip]').forEach((b) => { b.onclick = () => { S.clip.axis = b.dataset.clip; updateClip(); }; });
updateClip();

/* animation */
$('#clipSel').onchange = () => {
  const it = activeItem(); if (!it?.mixer) return;
  it.action.stop(); it.clipIndex = +$('#clipSel').value;
  it.action = it.mixer.clipAction(it.animations[it.clipIndex]); it.action.play(); it.action.paused = !it.playing;
};
$('#playBtn').onclick = () => {
  const it = activeItem(); if (!it?.mixer) return;
  it.playing = !it.playing; it.action.paused = !it.playing; renderAnim();
};
$('#speedIn').oninput = (e) => { const it = activeItem(); if (it) it.speed = +e.target.value; };

/* view tools */
$$('[data-view]').forEach((b) => { b.onclick = () => fitView(b.dataset.view); });
function setTool(t) {
  S.tool = t;
  $('#probeBtn').setAttribute('aria-pressed', t === 'probe');
  $('#measureBtn').setAttribute('aria-pressed', t === 'measure');
  clearProbe(); clearMeasure();
  if (t === 'measure') { toast('Click two points on the model to measure.'); }
}
$('#probeBtn').onclick = () => setTool('probe');
$('#measureBtn').onclick = () => setTool(S.tool === 'measure' ? 'probe' : 'measure');

/* top bar */
const fileInput = $('#fileInput');
$('#openBtn').onclick = () => fileInput.click();
$('#emptyOpen').onclick = () => fileInput.click();
fileInput.onchange = () => { openFiles([...fileInput.files]); fileInput.value = ''; };
$('#clearBtn').onclick = () => { [...S.items].forEach((i) => removeItem(i.id)); };
$('#shotBtn').onclick = () => {
  renderer.render(scene, camera);
  renderer.domElement.toBlob((blob) => {
    // composite the stage background so the PNG is not transparent
    const img = new Image(); const url = URL.createObjectURL(blob);
    img.onload = () => {
      const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
      const g = c.getContext('2d');
      const bg = stage.dataset.bg;
      if (bg === 'white') g.fillStyle = '#fff';
      else if (bg === 'dark') g.fillStyle = '#1a242c';
      else { const gr = g.createLinearGradient(0, 0, 0, c.height); gr.addColorStop(0, '#b9c9d5'); gr.addColorStop(0.52, '#dde5ea'); gr.addColorStop(1, '#f4f5f4'); g.fillStyle = gr; }
      g.fillRect(0, 0, c.width, c.height); g.drawImage(img, 0, 0);
      const a = document.createElement('a');
      a.download = `${(activeItem()?.name ?? 'view').replace(/\.[^.]+$/, '')}.png`;
      a.href = c.toDataURL('image/png'); a.click(); URL.revokeObjectURL(url);
    };
    img.src = url;
  });
};
const dlg = $('#urlDialog');
$('#urlBtn').onclick = () => { dlg.showModal(); $('#urlIn').focus(); };
$('#urlExample').onclick = (e) => {
  e.preventDefault();
  $('#urlIn').value = 'https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Assets/main/Models/DamagedHelmet/glTF-Binary/DamagedHelmet.glb';
};
dlg.addEventListener('close', () => { if (dlg.returnValue === 'ok' && $('#urlIn').value) openURL($('#urlIn').value.trim()); });
$$('[data-sample]').forEach((b) => { b.onclick = () => openURL(new URL(b.dataset.sample, location.href).href, b.dataset.name); });

$('#panelToggle').onclick = () => {
  const open = document.body.classList.toggle('panel-open');
  $('#panelToggle').setAttribute('aria-expanded', open);
};

/* drag and drop, including folders */
let dragDepth = 0;
const hasFiles = (e) => [...(e.dataTransfer?.types ?? [])].includes('Files');
window.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth++; $('#drop').hidden = false; });
window.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $('#drop').hidden = true; });
window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
window.addEventListener('drop', async (e) => {
  e.preventDefault(); dragDepth = 0; $('#drop').hidden = true;
  const entries = [...e.dataTransfer.items].map((i) => i.webkitGetAsEntry?.()).filter(Boolean);
  const files = entries.length ? (await Promise.all(entries.map(readEntry))).flat() : [...e.dataTransfer.files];
  openFiles(files);
});
function readEntry(entry) {
  return new Promise((resolve) => {
    if (entry.isFile) entry.file((f) => resolve([f]), () => resolve([]));
    else if (entry.isDirectory) {
      const reader = entry.createReader(); const all = [];
      const next = () => reader.readEntries(async (batch) => {
        if (!batch.length) resolve((await Promise.all(all.map(readEntry))).flat());
        else { all.push(...batch); next(); }
      }, () => resolve([]));
      next();
    } else resolve([]);
  });
}

/* keyboard */
window.addEventListener('keydown', (e) => {
  if (e.target.closest('input, select, textarea, dialog')) return;
  if (e.key === 'f' || e.key === 'F') fitView('fit');
  else if (e.key === 'w') { $('#wireChk').click(); }
  else if (e.key === 'g') { $('#gridChk').click(); }
  else if (e.key === 'm') setTool(S.tool === 'measure' ? 'probe' : 'measure');
  else if (e.key === 'Escape') { clearProbe(); clearMeasure(); }
});

/* ?url= deep link */
const qs = new URLSearchParams(location.search).get('url');
if (qs) openURL(qs);
renderUI();
loop();

// for debugging from the console
window.glbviewer = { S, scene, camera, renderer, openURL };
