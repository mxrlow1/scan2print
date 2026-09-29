// Scan2Print — main UI / viewer. Heavy geometry work is delegated to js/worker.js.
import * as THREE from '../vendor/three/build/three.module.js';
import { OrbitControls } from '../vendor/three/addons/controls/OrbitControls.js';
import * as ops from './meshops.js';
import { WorkerClient } from './worker-client.js';
import { makeSampleScan } from './sample.js';

export const APP_VERSION = '1.0.0';
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const DEG = Math.PI / 180;

// Print axes (X right, Y back, Z up) expressed in three.js world space (Y up).
const AXIS = { x: new THREE.Vector3(1, 0, 0), y: new THREE.Vector3(0, 0, -1), z: new THREE.Vector3(0, 1, 0) };
const UNIT_MM = { mm: 1, cm: 10, m: 1000, in: 25.4 };
const UNIT_NAME = { mm: 'millimetres', cm: 'centimetres', m: 'metres', in: 'inches' };
const MAX_UNDO = 20, UNDO_BUDGET = 400 * 1024 * 1024;

const worker = new WorkerClient(new URL('./worker.js', import.meta.url));

// ---------------------------------------------------------------- state
const state = {
  mesh: null, stats: null, name: '', base: 'scan', ext: '',
  unit: 'mm', detectedUnit: 'mm', unitPref: 'auto',
  undo: [], redo: [], tab: null, picking: false,
  preview: new THREE.Matrix4(), rot: { x: 0, y: 0, z: 0 },
  cut: { axis: 'z', pos: 0.1, ta: 0, tb: 0, keepPositive: true, min: 0, max: 1, n: new THREE.Vector3(0, 1, 0) },
  exportFile: null, exportFormat: 'stl', autodrop: true, plate: 256,
};

// ---------------------------------------------------------------- viewer
const canvas = $('#canvas');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.localClippingEnabled = true;
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0f1115);
const camera = new THREE.PerspectiveCamera(40, 1, 0.5, 20000);
camera.position.set(220, 200, 280);
scene.add(camera);
scene.add(new THREE.HemisphereLight(0xdfe8ff, 0x302a26, 1.5));
const headLight = new THREE.DirectionalLight(0xffffff, 2.0);
headLight.position.set(0.4, 0.8, 0.2);
headLight.target.position.set(0, 0, -1);
camera.add(headLight, headLight.target);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true; controls.dampingFactor = 0.14; controls.screenSpacePanning = true;
controls.minDistance = 2; controls.maxDistance = 6000;
controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };

let needsRender = true;
const requestRender = () => { needsRender = true; };
controls.addEventListener('change', requestRender);
// Keep the model framed (after edits / when the bottom sheet resizes the viewport) until the user moves the camera.
let autoFrame = true;
controls.addEventListener('start', () => { autoFrame = false; });
renderer.setAnimationLoop(() => {
  const moved = controls.update();
  if (moved || needsRender) { renderer.render(scene, camera); needsRender = false; }
});
new ResizeObserver(() => {
  const r = $('#viewport').getBoundingClientRect();
  if (!r.width || !r.height) return;
  renderer.setSize(r.width, r.height, false);
  camera.aspect = r.width / r.height; camera.updateProjectionMatrix(); requestRender();
  if (autoFrame) fitView();
}).observe($('#viewport'));

// build plate
const plate = new THREE.Group(); scene.add(plate);
function buildPlate(size) {
  plate.clear();
  const base = new THREE.Mesh(new THREE.PlaneGeometry(size, size), new THREE.MeshBasicMaterial({ color: 0x141820 }));
  base.rotation.x = -Math.PI / 2; base.position.y = -0.2; plate.add(base);
  const grid = new THREE.GridHelper(size, Math.round(size / 10), 0x3a4252, 0x232833);
  grid.position.y = -0.1; plate.add(grid);
  const h = size / 2, pts = [[-h, -h], [h, -h], [h, h], [-h, h], [-h, -h]].map(([x, z]) => new THREE.Vector3(x, 0, z));
  plate.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: 0x3dd6b5, transparent: true, opacity: 0.5 })));
  const axis = (dir, color) => plate.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(-h, 0.1, h), new THREE.Vector3(-h, 0.1, h).addScaledVector(dir, 30)]), new THREE.LineBasicMaterial({ color })));
  axis(AXIS.x, 0xff6b6b); axis(AXIS.y, 0x6bff8a); axis(AXIS.z, 0x6b9bff);
  requestRender();
}
buildPlate(state.plate);

// model
const material = new THREE.MeshStandardMaterial({ color: 0xc9ced8, roughness: 0.62, metalness: 0.04, side: THREE.DoubleSide,
  polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
material.onBeforeCompile = (sh) => {
  sh.fragmentShader = sh.fragmentShader.replace('#include <dithering_fragment>',
    '#include <dithering_fragment>\n if (!gl_FrontFacing) gl_FragColor.rgb = gl_FragColor.rgb * vec3(0.95, 0.4, 0.36) + vec3(0.08, 0.0, 0.0);');
};
const wireMaterial = new THREE.MeshBasicMaterial({ color: 0x5b8cff, wireframe: true, transparent: true, opacity: 0.35 });
const modelMesh = new THREE.Mesh(new THREE.BufferGeometry(), material);
const wireMesh = new THREE.Mesh(modelMesh.geometry, wireMaterial);
modelMesh.matrixAutoUpdate = false; wireMesh.matrixAutoUpdate = false;
wireMesh.visible = false; modelMesh.visible = false;
scene.add(modelMesh, wireMesh);
const bbox = new THREE.Box3();
const bboxHelper = new THREE.Box3Helper(bbox, 0x3dd6b5);
bboxHelper.material.transparent = true; bboxHelper.material.opacity = 0.7;
bboxHelper.visible = false; scene.add(bboxHelper);

// cut plane gizmo
const cutPlane = new THREE.Plane();
const cutGizmo = new THREE.Group();
const cutQuad = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ color: 0x5b8cff, transparent: true, opacity: 0.18, side: THREE.DoubleSide, depthWrite: false }));
const cutEdge = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.PlaneGeometry(1, 1)), new THREE.LineBasicMaterial({ color: 0x8fb0ff }));
cutGizmo.add(cutQuad, cutEdge); cutGizmo.visible = false; scene.add(cutGizmo);
// "ghost" of the part that the cut will remove
const ghostPlane = new THREE.Plane();
const ghostMesh = new THREE.Mesh(modelMesh.geometry, new THREE.MeshBasicMaterial({ color: 0xff6b6b, transparent: true, opacity: 0.16, depthWrite: false, side: THREE.DoubleSide, clippingPlanes: [ghostPlane] }));
ghostMesh.matrixAutoUpdate = false; ghostMesh.visible = false; ghostMesh.renderOrder = 2; scene.add(ghostMesh);

function displayMesh(mesh) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(mesh.positions, 3));
  g.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
  g.computeVertexNormals();
  g.computeBoundingBox(); g.computeBoundingSphere();
  const old = modelMesh.geometry;
  modelMesh.geometry = g; wireMesh.geometry = g; ghostMesh.geometry = g;
  old.dispose();
  modelMesh.visible = true;
  wireMesh.visible = $('#chk-wire').checked;
  state.preview.identity(); applyPreviewMatrix();
  $('#empty').classList.add('hidden');
  updateBBox(); updateCutRange(); requestRender();
}

function applyPreviewMatrix() {
  modelMesh.matrix.copy(state.preview); wireMesh.matrix.copy(state.preview);
  modelMesh.matrixWorldNeedsUpdate = true; wireMesh.matrixWorldNeedsUpdate = true;
  updateBBox(); requestRender();
}

function updateBBox() {
  if (!state.mesh) return;
  bbox.copy(modelMesh.geometry.boundingBox).applyMatrix4(state.preview);
  bboxHelper.visible = $('#chk-bbox').checked;
  const d = printDims();
  $('#dims').innerHTML = `<b>X</b> ${d.x.toFixed(1)} · <b>Y</b> ${d.y.toFixed(1)} · <b>Z</b> ${d.z.toFixed(1)} mm`;
  $('#dims').classList.remove('hidden');
  for (const a of ['x', 'y', 'z']) if (document.activeElement !== $('#in-' + a)) $('#in-' + a).value = d[a].toFixed(1);
  const over = Math.max(d.x, d.y) > state.plate || d.z > state.plate;
  $('#dims').style.borderColor = over ? 'var(--warn)' : '';
}
const printDims = () => { const s = bbox.getSize(new THREE.Vector3()); return { x: s.x, y: s.z, z: s.y }; };
const meshCenter = () => bbox.getCenter(new THREE.Vector3());

let lastViewDir = new THREE.Vector3(0.9, 0.75, 1.25);
function fitView(dir) {
  if (!dir) dir = lastViewDir.clone(); else lastViewDir = dir.clone();
  autoFrame = true;
  const box = state.mesh ? bbox.clone() : new THREE.Box3(new THREE.Vector3(-60, 0, -60), new THREE.Vector3(60, 60, 60));
  const c = box.getCenter(new THREE.Vector3());
  const r = Math.max(box.getSize(new THREE.Vector3()).length() / 2, 5);
  const fov = camera.fov * DEG;
  const fovMin = Math.min(fov, 2 * Math.atan(Math.tan(fov / 2) * camera.aspect));
  const dist = (r / Math.sin(fovMin / 2)) * 0.9;
  camera.position.copy(c).addScaledVector(dir.normalize(), dist);
  camera.near = Math.max(0.1, dist / 500); camera.far = dist * 50; camera.updateProjectionMatrix();
  controls.target.copy(c); controls.update(); requestRender();
}

// ---------------------------------------------------------------- UI helpers
let toastTimer;
function toast(msg, isError = false, ms = 3200) {
  const t = $('#toast');
  t.textContent = msg; t.classList.toggle('error', isError); t.classList.remove('hidden');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.add('hidden'), isError ? 6000 : ms);
}
function showBusy(label) { $('#busy-label').textContent = label; $('#busy-bar').style.width = '3%'; $('#busy').classList.remove('hidden'); }
function setProgress(p, label) { $('#busy-bar').style.width = Math.max(3, Math.min(100, p * 100)).toFixed(0) + '%'; if (label) $('#busy-label').textContent = label; }
function hideBusy() { $('#busy').classList.add('hidden'); }
$('#busy-cancel').onclick = () => worker.cancel();
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
const fmtInt = (n) => n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e4 ? (n / 1e3).toFixed(0) + 'k' : String(n);
const fmtBytes = (b) => b > 1048576 ? (b / 1048576).toFixed(1) + ' MB' : (b / 1024).toFixed(0) + ' KB';

async function runOp(op, args, label) {
  showBusy(label);
  try {
    return await worker.run(op, args, { onProgress: setProgress });
  } catch (e) {
    toast(e.cancelled ? 'Cancelled' : e.message, !e.cancelled);
    throw e;
  } finally { hideBusy(); }
}

// ---------------------------------------------------------------- history
const meshBytes = (e) => e.mesh.positions.byteLength + e.mesh.indices.byteLength;
const snapshot = (label) => ({ mesh: state.mesh, stats: state.stats, unit: state.unit, label });
function restore(e) {
  state.mesh = e.mesh; state.stats = e.stats; state.unit = e.unit;
  resetPreview(false); displayMesh(e.mesh); updateHealth(); invalidateExport(); updateHistoryButtons(); syncUnitSeg();
}
function updateHistoryButtons() {
  $('#btn-undo').disabled = !state.undo.length; $('#btn-redo').disabled = !state.redo.length;
  $('#btn-undo').title = state.undo.length ? 'Undo ' + state.undo[state.undo.length - 1].label : 'Undo';
}
function pushUndo(entry) {
  state.undo.push(entry);
  while (state.undo.length > MAX_UNDO || (state.undo.length > 2 && state.undo.reduce((s, e) => s + meshBytes(e), 0) > UNDO_BUDGET)) state.undo.shift();
}
function undo() {
  if (!state.undo.length || isBusy()) return;
  const e = state.undo.pop(); state.redo.push(snapshot(e.label)); restore(e); toast('Undid ' + e.label, false, 1400);
}
function redo() {
  if (!state.redo.length || isBusy()) return;
  const e = state.redo.pop(); state.undo.push(snapshot(e.label)); restore(e); toast('Redid ' + e.label, false, 1400);
}
const isBusy = () => !$('#busy').classList.contains('hidden');
$('#btn-undo').onclick = undo; $('#btn-redo').onclick = redo;
window.addEventListener('keydown', (e) => {
  if (e.target.matches('input[type=text],input[type=number]')) return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); }
});

/** Make `mesh` the current model (undoable). stats: topology stats from the worker, or null to keep/refresh geometry-only stats. */
function commit(mesh, label, stats = null, { drop = state.autodrop, fresh = false } = {}) {
  if (drop) mesh = ops.dropToPlate(mesh);
  if (fresh) { state.undo = []; state.redo = []; }
  else if (state.mesh) { pushUndo(snapshot(label)); state.redo = []; }
  state.mesh = mesh;
  if (stats) state.stats = stats;
  else if (state.stats) state.stats = { ...state.stats, ...ops.volumeArea(mesh) };
  resetPreview(false);
  displayMesh(mesh); updateHealth(); invalidateExport(); updateHistoryButtons(); setTabsEnabled(true);
  if (autoFrame) fitView();
}

function updateHealth() {
  const s = state.stats;
  const h = $('#health');
  if (!s) { h.classList.add('hidden'); return; }
  h.classList.remove('hidden');
  const issues = [];
  if (s.holes) issues.push(`${s.holes} hole${s.holes > 1 ? 's' : ''}`);
  if (s.shells > 1) issues.push(`${s.shells} pieces`);
  if (s.nonManifoldEdges) issues.push(`${s.nonManifoldEdges} bad edges`);
  h.innerHTML = `${fmtInt(s.tris)} ▲ · ` + (s.watertight && s.shells === 1 ? '<span class="good">Watertight ✓</span>'
    : s.watertight ? `<span class="good">Watertight ✓</span> · <span class="bad">${s.shells} pieces</span>` : `<span class="bad">${issues.join(' · ') || 'open mesh'}</span>`);
  const cell = (label, val, ok) => `<div class="${ok ? 'ok' : 'warn'}"><b>${val}</b>${label}</div>`;
  $('#health-detail').innerHTML = [
    cell('triangles', fmtInt(s.tris), true), cell('pieces', s.shells, s.shells === 1), cell('holes', s.holes, !s.holes),
    cell('open edges', fmtInt(s.boundaryEdges), !s.boundaryEdges), cell('non-manifold', s.nonManifoldEdges, !s.nonManifoldEdges),
    cell(s.watertight ? 'cm³ volume' : 'cm³ (approx.)', (Math.abs(s.volume) / 1000).toFixed(1), s.watertight),
  ].join('');
  const tris = s.tris, ratio = +$('#rng-simplify').value / 100;
  $('#simplify-note').textContent = `≈ ${fmtInt(Math.round(tris * ratio))} triangles (now ${fmtInt(tris)}). Big phone scans print fine at 100–300k.`;
}

// ---------------------------------------------------------------- tabs / sheet
const sheet = $('#sheet');
function openTab(tab) {
  if (state.tab === tab && sheet.classList.contains('open') && !window.matchMedia('(min-width: 900px)').matches) tab = null;
  state.tab = tab;
  sheet.classList.toggle('open', !!tab);
  $$('#tabbar button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  $$('.panel').forEach((p) => p.classList.toggle('active', p.dataset.panel === tab));
  if (tab !== 'size') resetPreview(true);
  if (tab !== 'size') stopPicking();
  updateCutPreview();
  sheet.scrollTop = 0;
}
$$('#tabbar button').forEach((b) => (b.onclick = () => openTab(b.dataset.tab)));
function setTabsEnabled(on) { $$('#tabbar button').forEach((b) => { if (!['open', 'view'].includes(b.dataset.tab)) b.disabled = !on; }); }
setTabsEnabled(false);

function seg(id, onChange) {
  const el = $(id);
  el.addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    el.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
    onChange(b.dataset.v);
  });
  return (v) => el.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x.dataset.v === v));
}
function slider(id, fmt, onInput) {
  const r = $(id), out = $(id.replace('rng', 'out'));
  const upd = () => { out.textContent = fmt(+r.value); onInput?.(+r.value); };
  r.addEventListener('input', upd); upd();
  return r;
}

// ---------------------------------------------------------------- import
const MESH_EXTS = ['glb', 'gltf', 'obj', 'stl', 'ply'];
const extOf = (name) => (name.split('.').pop() || '').toLowerCase();
$('#file-input').addEventListener('change', (e) => { const f = e.target.files; if (f && f.length) openFiles(f); e.target.value = ''; });
$('#btn-sample').onclick = $('#btn-sample-empty').onclick = () => loadSample();

async function openFiles(fileList) {
  let files = [...fileList];
  try {
    const zips = files.filter((f) => extOf(f.name) === 'zip');
    for (const z of zips) {
      showBusy('Unzipping…'); await nextFrame();
      const { unzipSync } = await import('../vendor/three/addons/libs/fflate.module.js');
      const entries = unzipSync(new Uint8Array(await z.arrayBuffer()));
      for (const [path, data] of Object.entries(entries)) {
        if (path.endsWith('/') || path.includes('__MACOSX') || path.split('/').pop().startsWith('.')) continue;
        files.push(new File([data], path.split('/').pop()));
      }
      hideBusy();
    }
    files = files.filter((f) => extOf(f.name) !== 'zip');
    const main = MESH_EXTS.map((x) => files.find((f) => extOf(f.name) === x)).find(Boolean);
    if (!main) throw new Error('No OBJ, GLB, GLTF, PLY or STL file found. ' + (files[0] ? `(“${files[0].name}” is not supported)` : ''));
    const ext = extOf(main.name);
    showBusy(`Reading ${main.name}…`); await nextFrame();
    let res;
    if (ext === 'glb' || ext === 'gltf') {
      const raw = await parseGLTF(main, files);
      res = await worker.run('weld', raw, { onProgress: setProgress, transfer: [raw.positions.buffer, raw.indices.buffer] });
    } else {
      const buffer = await main.arrayBuffer();
      res = await worker.run('parse', { buffer, ext }, { onProgress: setProgress, transfer: [buffer] });
    }
    hideBusy();
    importMesh(res.mesh, res.stats, main.name, ext);
  } catch (e) {
    hideBusy();
    if (!e.cancelled) toast('Could not open: ' + e.message, true); else toast('Cancelled');
    console.error(e);
  }
}

function importMesh(mesh, stats, name, ext) {
  const bb = ops.computeBBox(mesh.positions);
  const maxDim = Math.max(bb.max[0] - bb.min[0], bb.max[1] - bb.min[1], bb.max[2] - bb.min[2]);
  state.detectedUnit = ext === 'glb' || ext === 'gltf' || maxDim < 3 ? 'm' : 'mm';
  state.unit = state.unitPref === 'auto' ? state.detectedUnit : state.unitPref;
  const k = UNIT_MM[state.unit];
  if (k !== 1) mesh = ops.transformMesh(mesh, new THREE.Matrix4().makeScale(k, k, k).elements);
  state.name = name; state.ext = ext;
  state.base = name.replace(/\.[^.]+$/, '').replace(/[^\w\-]+/g, '_').slice(0, 60) || 'scan';
  $('#filename').textContent = name; $('#filename').title = name;
  $('#in-filename').value = state.base + '_print';
  state.cut.pos = 0.1; $('#rng-cut-pos').value = 100;
  commit(mesh, 'Import', { ...stats, ...ops.volumeArea(mesh) }, { drop: true, fresh: true });
  syncUnitSeg();
  fitView();
  const d = printDims();
  toast(`Loaded ${fmtInt(stats.tris)} triangles · read as ${UNIT_NAME[state.unit]} → ${d.x.toFixed(0)}×${d.y.toFixed(0)}×${d.z.toFixed(0)} mm`, false, 4500);
  if (!state.tab || state.tab === 'open') openTab(window.matchMedia('(min-width: 900px)').matches ? 'repair' : null);
}

function stripGltfJson(json) {
  // Printing only needs geometry: drop textures/materials so huge scan textures are never decoded on the phone.
  delete json.images; delete json.textures; delete json.samplers;
  if (json.materials) json.materials = json.materials.map(() => ({}));
  for (const k of ['extensionsUsed', 'extensionsRequired']) if (json[k]) json[k] = json[k].filter((e) => !/texture|materials_/i.test(e));
  return json;
}
function stripGlb(buffer) {
  const dv = new DataView(buffer);
  if (dv.getUint32(0, true) !== 0x46546c67 || dv.getUint32(16, true) !== 0x4e4f534a) return buffer;
  const jsonLen = dv.getUint32(12, true);
  const json = stripGltfJson(JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 20, jsonLen))));
  const enc = new TextEncoder().encode(JSON.stringify(json));
  const padLen = (enc.length + 3) & ~3;
  const rest = new Uint8Array(buffer, 20 + jsonLen);
  const out = new Uint8Array(20 + padLen + rest.length);
  const o = new DataView(out.buffer);
  o.setUint32(0, 0x46546c67, true); o.setUint32(4, 2, true); o.setUint32(8, out.length, true);
  o.setUint32(12, padLen, true); o.setUint32(16, 0x4e4f534a, true);
  out.fill(0x20, 20, 20 + padLen); out.set(enc, 20); out.set(rest, 20 + padLen);
  return out.buffer;
}

async function parseGLTF(main, files) {
  const [{ GLTFLoader }, { DRACOLoader }, { MeshoptDecoder }] = await Promise.all([
    import('../vendor/three/addons/loaders/GLTFLoader.js'), import('../vendor/three/addons/loaders/DRACOLoader.js'),
    import('../vendor/three/addons/libs/meshopt_decoder.module.js')]);
  const urls = {};
  for (const f of files) if (f !== main) urls[f.name] = URL.createObjectURL(f);
  const manager = new THREE.LoadingManager();
  manager.setURLModifier((url) => {
    const base = decodeURIComponent(url.split(/[\\/]/).pop().split('?')[0]);
    return urls[base] || url;
  });
  const loader = new GLTFLoader(manager);
  const draco = new DRACOLoader(manager).setDecoderPath(new URL('../vendor/three/addons/libs/draco/gltf/', import.meta.url).href);
  loader.setDRACOLoader(draco); loader.setMeshoptDecoder(MeshoptDecoder);
  let data;
  if (extOf(main.name) === 'glb') data = stripGlb(await main.arrayBuffer());
  else data = JSON.stringify(stripGltfJson(JSON.parse(await main.text())));
  try {
    const gltf = await new Promise((res, rej) => loader.parse(data, '', res, rej));
    return collectMeshes(gltf.scene);
  } finally { Object.values(urls).forEach(URL.revokeObjectURL); draco.dispose(); }
}

function collectMeshes(root) {
  const pos = [], idx = []; let base = 0, total = 0, totalIdx = 0;
  root.updateMatrixWorld(true);
  root.traverse((o) => {
    if (!o.isMesh || !o.geometry?.attributes?.position) return;
    const g = o.geometry, p = g.attributes.position, n = p.count, m = o.matrixWorld;
    const arr = new Float32Array(n * 3), v = new THREE.Vector3();
    for (let i = 0; i < n; i++) { v.fromBufferAttribute(p, i).applyMatrix4(m); arr[i * 3] = v.x; arr[i * 3 + 1] = v.y; arr[i * 3 + 2] = v.z; }
    const src = g.index ? g.index.array : null, cnt = src ? src.length : n, ia = new Uint32Array(cnt);
    const flip = m.determinant() < 0;
    for (let i = 0; i < cnt; i += 3) {
      const a = (src ? src[i] : i) + base, b = (src ? src[i + 1] : i + 1) + base, c = (src ? src[i + 2] : i + 2) + base;
      ia[i] = a; ia[i + 1] = flip ? c : b; ia[i + 2] = flip ? b : c;
    }
    pos.push(arr); idx.push(ia); base += n; total += arr.length; totalIdx += cnt;
  });
  if (!total) throw new Error('No triangle meshes in this file.');
  const P = new Float32Array(total), I = new Uint32Array(totalIdx);
  let k = 0; for (const a of pos) { P.set(a, k); k += a.length; }
  k = 0; for (const a of idx) { I.set(a, k); k += a.length; }
  return { positions: P, indices: I };
}

async function loadSample() {
  try {
    const raw = makeSampleScan();
    const res = await runOp('weld', raw, 'Preparing sample…');
    importMesh(res.mesh, res.stats, 'sample-scan.obj', 'obj');
  } catch (e) { console.error(e); }
}

// drag & drop (desktop/tablet)
window.addEventListener('dragover', (e) => { e.preventDefault(); $('#drop-hint').classList.remove('hidden'); });
window.addEventListener('dragleave', (e) => { if (!e.relatedTarget) $('#drop-hint').classList.add('hidden'); });
window.addEventListener('drop', (e) => { e.preventDefault(); $('#drop-hint').classList.add('hidden'); if (e.dataTransfer?.files?.length) openFiles(e.dataTransfer.files); });

// units
const syncUnitSegFn = seg('#seg-units', (v) => {
  state.unitPref = v;
  if (!state.mesh) return;
  const target = v === 'auto' ? state.detectedUnit : v;
  if (target === state.unit) return;
  const k = UNIT_MM[target] / UNIT_MM[state.unit];
  const m = scaleAbout(k, k, k);
  const prevUnit = state.unit;
  commit(ops.transformMesh(state.mesh, m.elements), 'Units');
  state.undo[state.undo.length - 1].unit = prevUnit;
  state.unit = target; fitView();
  toast(`Now reading the file as ${UNIT_NAME[target]}`);
});
function syncUnitSeg() {
  $('#units-note').innerHTML = state.mesh ? `Current model is read as <b>${UNIT_NAME[state.unit]}</b> (auto-detected: ${UNIT_NAME[state.detectedUnit]}). Tap a unit to re-scale it.` : $('#units-note').innerHTML;
}
$('#chk-autodrop').onchange = (e) => { state.autodrop = e.target.checked; if (state.autodrop && state.mesh) commit(state.mesh, 'Drop to plate'); };

// ---------------------------------------------------------------- transforms (main thread; cheap)
function scaleAbout(sx, sy, sz, c = meshCenter()) {
  return new THREE.Matrix4().makeTranslation(c.x, c.y, c.z).multiply(new THREE.Matrix4().makeScale(sx, sy, sz)).multiply(new THREE.Matrix4().makeTranslation(-c.x, -c.y, -c.z));
}
function rotateAbout(q, c = meshCenter()) {
  return new THREE.Matrix4().makeTranslation(c.x, c.y, c.z).multiply(new THREE.Matrix4().makeRotationFromQuaternion(q)).multiply(new THREE.Matrix4().makeTranslation(-c.x, -c.y, -c.z));
}
function applyMatrix(m, label, opts) {
  if (!state.mesh) return;
  resetPreview(false);
  commit(ops.transformMesh(state.mesh, m.elements), label, null, opts);
}

let lastSizeAxis = 'z';
for (const a of ['x', 'y', 'z']) {
  const inp = $('#in-' + a);
  inp.addEventListener('focus', () => inp.select());
  inp.addEventListener('input', () => {
    lastSizeAxis = a;
    if (!$('#chk-uniform').checked || !state.mesh) return;
    const d = printDims(), v = parseFloat(inp.value);
    if (!(v > 0) || !(d[a] > 0)) return;
    const k = v / d[a];
    for (const b of ['x', 'y', 'z']) if (b !== a) $('#in-' + b).value = (d[b] * k).toFixed(1);
  });
  inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { inp.blur(); applySize(); } });
}
function applySize() {
  if (!state.mesh) return;
  const d = printDims();
  const want = { x: parseFloat($('#in-x').value), y: parseFloat($('#in-y').value), z: parseFloat($('#in-z').value) };
  if ($('#chk-uniform').checked) {
    const a = lastSizeAxis;
    if (!(want[a] > 0)) return toast('Enter a size in mm', true);
    const k = want[a] / d[a];
    applyMatrix(scaleAbout(k, k, k), `Set ${a.toUpperCase()} = ${want[a]} mm`);
  } else {
    const k = {}; for (const a of ['x', 'y', 'z']) k[a] = want[a] > 0 && d[a] > 0 ? want[a] / d[a] : 1;
    applyMatrix(scaleAbout(k.x, k.z, k.y), 'Resize'); // print Y is world Z
  }
}
$('#btn-size-apply').onclick = applySize;
$('#btn-scale-apply').onclick = () => { const p = parseFloat($('#in-scale').value); if (p > 0) { applyMatrix(scaleAbout(p / 100, p / 100, p / 100), `Scale ${p}%`); $('#in-scale').value = 100; } };
$$('[data-scale]').forEach((b) => (b.onclick = () => { const k = +b.dataset.scale / 100; applyMatrix(scaleAbout(k, k, k), `Scale ${b.dataset.scale}%`); }));
$$('[data-rot]').forEach((b) => (b.onclick = () => {
  const [a, deg] = b.dataset.rot.split(',');
  applyMatrix(rotateAbout(new THREE.Quaternion().setFromAxisAngle(AXIS[a], +deg * DEG)), `Rotate ${a.toUpperCase()} ${deg}°`);
}));
$$('[data-mirror]').forEach((b) => (b.onclick = () => {
  const a = b.dataset.mirror, s = { x: [-1, 1, 1], y: [1, 1, -1], z: [1, -1, 1] }[a];
  applyMatrix(scaleAbout(...s), `Mirror ${a.toUpperCase()}`);
}));
$('#btn-drop').onclick = () => state.mesh && commit(state.mesh, 'Drop to plate', null, { drop: true });

// free rotate preview
function rotationQuat() {
  const q = new THREE.Quaternion();
  q.multiply(new THREE.Quaternion().setFromAxisAngle(AXIS.z, state.rot.z * DEG));
  q.multiply(new THREE.Quaternion().setFromAxisAngle(AXIS.y, state.rot.y * DEG));
  q.multiply(new THREE.Quaternion().setFromAxisAngle(AXIS.x, state.rot.x * DEG));
  return q;
}
let rotCenter = null;
for (const a of ['x', 'y', 'z']) {
  slider('#rng-r' + a, (v) => v + '°', (v) => {
    state.rot[a] = v;
    if (!state.mesh) return;
    if (!rotCenter) rotCenter = new THREE.Box3().copy(modelMesh.geometry.boundingBox).getCenter(new THREE.Vector3());
    state.preview.copy(rotateAbout(rotationQuat(), rotCenter)); applyPreviewMatrix();
  });
}
function resetPreview(rerender = true) {
  state.rot = { x: 0, y: 0, z: 0 }; rotCenter = null;
  for (const a of ['x', 'y', 'z']) { $('#rng-r' + a).value = 0; $('#out-r' + a).textContent = '0°'; }
  if (!state.preview.equals(new THREE.Matrix4())) { state.preview.identity(); if (rerender) applyPreviewMatrix(); }
}
$('#btn-rot-apply').onclick = () => {
  if (!state.mesh || state.preview.equals(new THREE.Matrix4())) return;
  const m = state.preview.clone();
  applyMatrix(m, `Rotate ${state.rot.x}/${state.rot.y}/${state.rot.z}°`);
};
$('#btn-rot-reset').onclick = () => resetPreview(true);

// lay flat
function startPicking() { if (!state.mesh) return; state.picking = true; $('#pick-hint').classList.remove('hidden'); $('#btn-layflat').classList.add('on'); if (!window.matchMedia('(min-width: 900px)').matches) { sheet.classList.remove('open'); } }
function stopPicking() { state.picking = false; $('#pick-hint').classList.add('hidden'); $('#btn-layflat').classList.remove('on'); }
$('#btn-layflat').onclick = () => (state.picking ? stopPicking() : startPicking());
$('#pick-cancel').onclick = () => { stopPicking(); openTab('size'); };

const raycaster = new THREE.Raycaster();
function pickAt(clientX, clientY) {
  const r = canvas.getBoundingClientRect();
  const ndc = new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  return raycaster.intersectObject(modelMesh, false)[0] || null;
}
/** Area-weighted average normal of faces near the tapped point that face roughly the same way (robust on noisy scans). */
export function regionNormal(mesh, point, n0, radius) {
  const P = mesh.positions, I = mesh.indices, r2 = radius * radius, cosMax = Math.cos(35 * DEG);
  let sx = 0, sy = 0, sz = 0;
  for (let t = 0; t < I.length; t += 3) {
    const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
    const cx = (P[a] + P[b] + P[c]) / 3 - point.x, cy = (P[a + 1] + P[b + 1] + P[c + 1]) / 3 - point.y, cz = (P[a + 2] + P[b + 2] + P[c + 2]) / 3 - point.z;
    if (cx * cx + cy * cy + cz * cz > r2) continue;
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2], vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz); if (!l) continue;
    if ((nx * n0.x + ny * n0.y + nz * n0.z) / l < cosMax) continue;
    sx += nx; sy += ny; sz += nz;
  }
  const v = new THREE.Vector3(sx, sy, sz);
  return v.lengthSq() ? v.normalize() : n0.clone();
}
function layFlatAt(hit) {
  const diag = modelMesh.geometry.boundingBox.getSize(new THREE.Vector3()).length();
  const n = regionNormal(state.mesh, hit.point, hit.face.normal.clone().normalize(), diag * 0.04);
  const q = new THREE.Quaternion().setFromUnitVectors(n, new THREE.Vector3(0, -1, 0));
  stopPicking();
  applyMatrix(rotateAbout(q), 'Lay flat', { drop: true });
  toast('Laid flat on the selected face');
  if (!window.matchMedia('(min-width: 900px)').matches) openTab('size');
}

// canvas taps: lay-flat picking + double-tap to reset view
let down = null, lastTap = { t: 0, x: 0, y: 0 };
canvas.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY, t: performance.now(), id: e.pointerId, multi: !e.isPrimary }; });
canvas.addEventListener('pointerup', (e) => {
  if (!down || !e.isPrimary) return;
  const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y), dt = performance.now() - down.t;
  down = null;
  if (moved > 8 || dt > 600) return;
  if (state.picking && state.mesh) {
    const hit = pickAt(e.clientX, e.clientY);
    if (hit) layFlatAt(hit); else toast('Tap on the model surface');
    return;
  }
  const now = performance.now();
  if (now - lastTap.t < 320 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 30) { fitView(); lastTap.t = 0; }
  else lastTap = { t: now, x: e.clientX, y: e.clientY };
});
document.addEventListener('gesturestart', (e) => e.preventDefault()); // stop iOS page zoom

// ---------------------------------------------------------------- cut
function cutNormal() {
  const c = state.cut, base = AXIS[c.axis].clone();
  const perp = { z: [AXIS.x, AXIS.y], y: [AXIS.x, AXIS.z], x: [AXIS.y, AXIS.z] }[c.axis];
  return base.applyAxisAngle(perp[0], c.ta * DEG).applyAxisAngle(perp[1], c.tb * DEG).normalize();
}
function updateCutRange() {
  if (!state.mesh) return;
  const n = cutNormal(), P = state.mesh.positions;
  let mn = Infinity, mx = -Infinity;
  for (let i = 0; i < P.length; i += 3) { const d = n.x * P[i] + n.y * P[i + 1] + n.z * P[i + 2]; if (d < mn) mn = d; if (d > mx) mx = d; }
  Object.assign(state.cut, { n, min: mn, max: mx });
  updateCutPreview();
}
const cutOffset = () => state.cut.min + state.cut.pos * (state.cut.max - state.cut.min);
function updateCutPreview() {
  const active = state.tab === 'cut' && !!state.mesh;
  cutGizmo.visible = active; ghostMesh.visible = active;
  const planes = active ? [cutPlane] : [];
  if (material.clippingPlanes?.length !== planes.length) { material.clippingPlanes = planes; wireMaterial.clippingPlanes = planes; material.needsUpdate = true; wireMaterial.needsUpdate = true; }
  if (active) {
    const { n } = state.cut, off = cutOffset();
    if (state.cut.keepPositive) cutPlane.set(n, -off); else cutPlane.set(n.clone().negate(), off);
    ghostPlane.copy(cutPlane).negate();
    const c = meshCenter(), size = Math.max(bbox.getSize(new THREE.Vector3()).length() * 0.8, 10);
    cutGizmo.position.copy(c).addScaledVector(n, off - n.dot(c));
    cutGizmo.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
    cutGizmo.scale.set(size, size, 1);
    $('#out-cut-pos').textContent = (off - state.cut.min).toFixed(1) + ' mm';
    const names = { z: ['top', 'bottom'], y: ['back', 'front'], x: ['right', 'left'] }[state.cut.axis];
    $('#cut-keep-label').textContent = `(keeping ${state.cut.keepPositive ? names[0] : names[1]})`;
  }
  requestRender();
}
seg('#seg-cut-axis', (v) => { state.cut.axis = v; updateCutRange(); });
slider('#rng-cut-pos', (v) => (v / 10).toFixed(1) + '%', (v) => { state.cut.pos = v / 1000; updateCutPreview(); });
slider('#rng-cut-ta', (v) => v + '°', (v) => { state.cut.ta = v; updateCutRange(); });
slider('#rng-cut-tb', (v) => v + '°', (v) => { state.cut.tb = v; updateCutRange(); });
$$('[data-nudge]').forEach((b) => (b.onclick = () => {
  const span = state.cut.max - state.cut.min || 1;
  state.cut.pos = Math.min(1, Math.max(0, state.cut.pos + +b.dataset.nudge / span));
  $('#rng-cut-pos').value = Math.round(state.cut.pos * 1000); updateCutPreview();
}));
$('#btn-cut-flip').onclick = () => { state.cut.keepPositive = !state.cut.keepPositive; updateCutPreview(); };

async function doCut(normalArr, offset, label) {
  const res = await runOp('cut', { mesh: state.mesh, normal: normalArr, offset, cap: $('#chk-cap').checked }, label + '…');
  commit(res.mesh, label, res.stats);
  return res;
}
$('#btn-cut').onclick = async () => {
  if (!state.mesh) return;
  const n = state.cut.n, off = cutOffset();
  // worker keeps n·p < offset
  const [nn, oo] = state.cut.keepPositive ? [[-n.x, -n.y, -n.z], -off] : [[n.x, n.y, n.z], off];
  try {
    const r = await doCut(nn, oo, 'Cut');
    toast(`Cut done${r.info.loops ? ` · capped ${r.info.loops} opening${r.info.loops > 1 ? 's' : ''}` : ''}`);
  } catch {}
};
$('#btn-flatten').onclick = async () => {
  if (!state.mesh) return;
  const h = parseFloat($('#in-flatten').value);
  if (!(h > 0)) return toast('Enter how many mm to slice off', true);
  const minY = bbox.min.y;
  try { await doCut([0, -1, 0], -(minY + h), `Flatten ${h} mm`); toast(`Bottom flattened (${h} mm removed)`); } catch {}
};

// ---------------------------------------------------------------- repair (worker)
let piecesMode = 'largest';
seg('#seg-pieces', (v) => { piecesMode = v; $('#row-pieces-pct').classList.toggle('hidden', v === 'largest'); });
$('#row-pieces-pct').classList.add('hidden');
slider('#rng-pieces', (v) => v + '%');
const holeEdges = (v) => (v >= 100 ? 0 : Math.round(3 * Math.pow(1.075, v)));
slider('#rng-holes', (v) => (v >= 100 ? 'All' : '≤' + holeEdges(v) + ' edges'));
slider('#rng-smooth-it', (v) => String(v));
slider('#rng-smooth-l', (v) => (v / 100).toFixed(2));
slider('#rng-simplify', (v) => v + '%', () => updateHealth());

$('#btn-pieces').onclick = async () => {
  if (!state.mesh) return;
  try {
    const r = await runOp('removeSmall', { mesh: state.mesh, mode: piecesMode, percent: +$('#rng-pieces').value }, 'Removing pieces…');
    if (!r.info.removedShells) return toast('No loose pieces to remove');
    commit(r.mesh, 'Remove pieces', r.stats);
    toast(`Removed ${r.info.removedShells} piece${r.info.removedShells > 1 ? 's' : ''} (${fmtInt(r.info.removedTris)} triangles)`);
  } catch {}
};
$('#btn-holes').onclick = async () => {
  if (!state.mesh) return;
  if (state.stats && !state.stats.holes) return toast('No holes found — mesh is closed');
  try {
    const r = await runOp('fillHoles', { mesh: state.mesh, maxEdges: holeEdges(+$('#rng-holes').value) }, 'Filling holes…');
    if (!r.info.filled) return toast(r.info.skipped ? `All ${r.info.skipped} holes are larger than the limit` : 'No fillable holes found');
    commit(r.mesh, 'Fill holes', r.stats);
    toast(`Filled ${r.info.filled} hole${r.info.filled > 1 ? 's' : ''}${r.info.skipped ? ` · skipped ${r.info.skipped} larger` : ''}`);
  } catch {}
};
$('#btn-repair').onclick = async () => {
  if (!state.mesh) return;
  try {
    const r = await runOp('repair', { mesh: state.mesh }, 'Fixing mesh…');
    if (!r.info.removedFaces && r.stats.tris === state.stats.tris) return toast('No non-manifold edges or duplicate faces found');
    commit(r.mesh, 'Fix edges', r.stats);
    toast(`Rebuilt ${r.info.removedFaces} faces around bad edges${r.stats.nonManifoldEdges ? ` · ${r.stats.nonManifoldEdges} remain` : ''}`);
  } catch {}
};
$('#btn-smooth').onclick = async () => {
  if (!state.mesh) return;
  try {
    const r = await runOp('smooth', { mesh: state.mesh, iterations: +$('#rng-smooth-it').value, lambda: +$('#rng-smooth-l').value / 100, keepBoundary: $('#chk-smooth-border').checked }, 'Smoothing…');
    commit(r.mesh, 'Smooth', r.stats);
    toast(`Smoothed (${r.info.iterations} passes)`);
  } catch {}
};
$('#btn-simplify').onclick = async () => {
  if (!state.mesh) return;
  try {
    const r = await runOp('simplify', { mesh: state.mesh, ratio: +$('#rng-simplify').value / 100 }, 'Simplifying…');
    commit(r.mesh, 'Simplify', r.stats);
    toast(`Simplified ${fmtInt(r.info.before)} → ${fmtInt(r.info.after)} triangles`);
  } catch {}
};

// ---------------------------------------------------------------- export
const MIME = { stl: 'model/stl', obj: 'model/obj', '3mf': 'model/3mf' };
seg('#seg-format', (v) => { state.exportFormat = v; invalidateExport(); });
$('#in-filename').addEventListener('input', invalidateExport);
function invalidateExport() { state.exportFile = null; $('#export-ready').classList.add('hidden'); $('#btn-export').classList.remove('hidden'); }
$('#btn-export').onclick = async () => {
  if (!state.mesh) return;
  const fmt = state.exportFormat;
  const name = ($('#in-filename').value.trim() || 'scan').replace(/[^\w\-. ]+/g, '_').replace(/\.(stl|obj|3mf)$/i, '') + '.' + fmt;
  try {
    const r = await runOp('export', { mesh: state.mesh, format: fmt, name: name.replace(/\.\w+$/, '') }, `Writing ${fmt.toUpperCase()}…`);
    state.exportFile = new File([r.bytes], name, { type: MIME[fmt] });
    const s = state.stats;
    $('#export-info').innerHTML = `<b>${name}</b> · ${fmtBytes(r.bytes.byteLength)} · ${fmtInt(s.tris)} triangles · ${s.watertight ? '✓ watertight' : '⚠ not watertight (' + (s.holes || 0) + ' holes) — slicers usually still cope'}`;
    $('#export-ready').classList.remove('hidden'); $('#btn-export').classList.add('hidden');
    $('#btn-share').classList.toggle('hidden', !shareableFile(state.exportFile));
  } catch {}
};
function shareableFile(f) {
  if (!navigator.canShare) return null;
  const candidates = [f, new File([f], f.name, { type: 'application/octet-stream' })];
  for (const c of candidates) { try { if (navigator.canShare({ files: [c] })) return c; } catch {} }
  return null;
}
$('#btn-share').onclick = async () => {
  const f = state.exportFile && shareableFile(state.exportFile);
  if (!f) return downloadFile();
  try { await navigator.share({ files: [f], title: f.name }); }
  catch (e) { if (e.name !== 'AbortError') { toast('Sharing failed, downloading instead'); downloadFile(); } }
};
$('#btn-download').onclick = () => downloadFile();
function downloadFile() {
  const f = state.exportFile; if (!f) return;
  const url = URL.createObjectURL(f);
  const a = document.createElement('a');
  a.href = url; a.download = f.name; a.rel = 'noopener';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  toast('Downloading ' + f.name);
}

// ---------------------------------------------------------------- view
$('#chk-wire').onchange = (e) => { wireMesh.visible = e.target.checked && !!state.mesh; requestRender(); };
$('#chk-bbox').onchange = (e) => { bboxHelper.visible = e.target.checked && !!state.mesh; requestRender(); };
$('#chk-grid').onchange = (e) => { plate.visible = e.target.checked; requestRender(); };
seg('#seg-plate', (v) => { state.plate = +v; buildPlate(state.plate); updateBBox(); });
$('#btn-view-reset').onclick = () => fitView();
$('#btn-view-top').onclick = () => fitView(new THREE.Vector3(0, 1, 0.0001));
$('#btn-view-front').onclick = () => fitView(new THREE.Vector3(0, 0.05, 1));
$('#version-note').textContent = `Scan2Print ${APP_VERSION} · three.js r${THREE.REVISION}`;

// ---------------------------------------------------------------- help
const help = $('#help');
const openHelp = () => (help.showModal ? help.showModal() : help.setAttribute('open', ''));
$('#btn-help').onclick = openHelp; $('#btn-help-empty').onclick = openHelp;
$('#help-close').onclick = () => (help.close ? help.close() : help.removeAttribute('open'));

// ---------------------------------------------------------------- PWA: service worker + share target
if ('serviceWorker' in navigator && location.protocol !== 'file:' && !new URLSearchParams(location.search).has('nosw')) {
  navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW registration failed', e));
}
async function checkSharedFiles() {
  if (!new URLSearchParams(location.search).has('shared') || !('caches' in window)) return;
  history.replaceState(null, '', location.pathname);
  const cache = await caches.open('scan2print-share');
  const keys = await cache.keys();
  const files = [];
  for (const k of keys) {
    const r = await cache.match(k);
    files.push(new File([await r.blob()], decodeURIComponent(r.headers.get('x-filename') || 'shared.stl')));
    await cache.delete(k);
  }
  if (files.length) openFiles(files); else toast('Nothing was shared', true);
}
checkSharedFiles();
if ('launchQueue' in window) {
  // Desktop/ChromeOS "Open with Scan2Print" (manifest file_handlers)
  window.launchQueue.setConsumer(async (params) => {
    if (!params.files?.length) return;
    openFiles(await Promise.all(params.files.map((h) => h.getFile())));
  });
}

if (window.matchMedia('(min-width: 900px)').matches) openTab('open');
fitView();

// test / debugging hook
window.S2P = { state, openFiles, loadSample, commit, undo, redo, fitView, ops, openTab, pickAt, layFlatAt, worker, THREE, camera, controls, modelMesh, requestRender };
