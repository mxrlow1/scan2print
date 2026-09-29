// Scan2Print worker: parsing, welding and all heavy mesh operations run here so the UI stays responsive.
import * as ops from './meshops.js';
import { exportSTL, exportOBJ, export3MF } from './exporters.js';
import { STLLoader } from '../vendor/three/addons/loaders/STLLoader.js';
import { PLYLoader } from '../vendor/three/addons/loaders/PLYLoader.js';
import { OBJLoader } from '../vendor/three/addons/loaders/OBJLoader.js';
import { MeshoptSimplifier } from '../vendor/three/addons/libs/meshopt_simplifier.module.js';

function collectFromObject(root) {
  const posParts = [], idxParts = [];
  let base = 0;
  root.updateMatrixWorld(true);
  root.traverse((o) => {
    if (!o.isMesh || !o.geometry?.attributes?.position) return;
    const g = o.geometry.clone();
    g.applyMatrix4(o.matrixWorld);
    const p = g.attributes.position;
    const n = p.count;
    const arr = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { arr[i * 3] = p.getX(i); arr[i * 3 + 1] = p.getY(i); arr[i * 3 + 2] = p.getZ(i); }
    posParts.push(arr);
    const idx = g.index ? g.index.array : null;
    const cnt = idx ? idx.length : n;
    const out = new Uint32Array(cnt);
    for (let i = 0; i < cnt; i++) out[i] = (idx ? idx[i] : i) + base;
    idxParts.push(out);
    base += n;
  });
  const concat = (parts, T) => { const len = parts.reduce((s, a) => s + a.length, 0); const o = new T(len); let k = 0; for (const a of parts) { o.set(a, k); k += a.length; } return o; };
  return { positions: concat(posParts, Float32Array), indices: concat(idxParts, Uint32Array) };
}

function zUpToYUp(pos) {
  for (let i = 0; i < pos.length; i += 3) { const y = pos[i + 1]; pos[i + 1] = pos[i + 2]; pos[i + 2] = -y; }
}

const handlers = {
  async parse({ buffer, ext }, progress) {
    progress(0.02, 'Parsing file…');
    let raw;
    if (ext === 'stl') {
      const g = new STLLoader().parse(buffer);
      raw = { positions: new Float32Array(g.attributes.position.array), indices: null };
      zUpToYUp(raw.positions); // STL files are Z-up by convention
    } else if (ext === 'ply') {
      const g = new PLYLoader().parse(buffer);
      if (!g.index) throw new Error('This PLY has no faces (point cloud or Gaussian splat). Export a mesh (OBJ/GLB/STL/PLY mesh) from your scan app instead.');
      raw = { positions: new Float32Array(g.attributes.position.array), indices: new Uint32Array(g.index.array) };
    } else if (ext === 'obj') {
      const text = typeof buffer === 'string' ? buffer : new TextDecoder().decode(buffer);
      raw = collectFromObject(new OBJLoader().parse(text));
    } else throw new Error('Unsupported format in worker: ' + ext);
    if (!raw.positions.length) throw new Error('No triangles found in file.');
    return handlers.weld(raw, progress);
  },

  async weld({ positions, indices }, progress) {
    progress(0.3, 'Welding vertices…');
    const mesh = ops.removeDuplicateFaces(ops.weld(positions, indices, 1e-6, (p) => progress(0.3 + 0.5 * p, 'Welding vertices…'))).mesh;
    if (!mesh.indices.length) throw new Error('No triangles found in file.');
    progress(0.85, 'Analyzing…');
    return { mesh, stats: ops.analyze(mesh) };
  },

  async analyze({ mesh }) { return { stats: ops.analyze(mesh) }; },

  async cut({ mesh, normal, offset, cap }, progress) {
    progress(0.05, 'Cutting…');
    const r = ops.planeCut(mesh, { normal, offset, cap }, (p) => progress(p * 0.9, 'Cutting…'));
    if (!r.mesh.indices.length) throw new Error('The cut removed everything — flip the kept side or move the plane.');
    return { mesh: r.mesh, info: r.info, stats: ops.analyze(r.mesh) };
  },

  async removeSmall({ mesh, mode, percent }, progress) {
    progress(0.1, 'Finding pieces…');
    const r = ops.removeSmallPieces(mesh, { mode, percent });
    return { mesh: r.mesh, info: r.info, stats: ops.analyze(r.mesh) };
  },

  async fillHoles({ mesh, maxEdges }, progress) {
    progress(0.1, 'Filling holes…');
    const r = ops.fillHoles(mesh, { maxEdges }, (p) => progress(0.1 + 0.8 * p, 'Filling holes…'));
    return { mesh: r.mesh, info: r.info, stats: ops.analyze(r.mesh) };
  },

  async smooth({ mesh, iterations, lambda, keepBoundary }, progress) {
    const r = ops.smooth(mesh, { iterations, lambda, mu: -(lambda + 0.03), keepBoundary }, (p) => progress(p * 0.95, 'Smoothing…'));
    return { mesh: r.mesh, info: r.info, stats: ops.analyze(r.mesh) };
  },

  async simplify({ mesh, ratio }, progress) {
    progress(0.05, 'Loading simplifier…');
    await MeshoptSimplifier.ready;
    progress(0.15, 'Simplifying…');
    const target = Math.max(3, Math.floor((mesh.indices.length / 3) * ratio) * 3);
    const [idx, err] = MeshoptSimplifier.simplify(mesh.indices, mesh.positions, 3, target, 0.25, []);
    progress(0.85, 'Cleaning up…');
    // meshopt can leave a few coincident face pairs ("fins") on dense noisy scans; they would count as non-manifold
    let out = ops.removeDuplicateFaces(ops.compact({ positions: mesh.positions, indices: idx })).mesh;
    if (ops.analyze(out).nonManifoldEdges) out = ops.repairNonManifold(out).mesh;
    return { mesh: out, info: { error: err, before: mesh.indices.length / 3, after: out.indices.length / 3 }, stats: ops.analyze(out) };
  },

  async repair({ mesh }, progress) {
    progress(0.1, 'Fixing non-manifold edges…');
    const r = ops.repairNonManifold(mesh);
    return { mesh: r.mesh, info: r.info, stats: ops.analyze(r.mesh) };
  },

  async export({ mesh, format, name }, progress) {
    progress(0.1, 'Writing ' + format.toUpperCase() + '…');
    const bytes = format === 'stl' ? exportSTL(mesh, name) : format === 'obj' ? exportOBJ(mesh, name) : export3MF(mesh, name);
    return { bytes };
  },
};

function transferables(obj, out = []) {
  if (!obj || typeof obj !== 'object') return out;
  if (ArrayBuffer.isView(obj)) { if (!out.includes(obj.buffer)) out.push(obj.buffer); return out; }
  for (const k in obj) transferables(obj[k], out);
  return out;
}

self.onmessage = async (ev) => {
  const { id, op, args } = ev.data;
  let last = 0;
  const progress = (p, label) => {
    const now = performance.now();
    if (now - last < 60 && p < 0.99) return;
    last = now;
    self.postMessage({ id, type: 'progress', p, label });
  };
  try {
    const h = handlers[op];
    if (!h) throw new Error('Unknown op ' + op);
    const result = await h(args, progress);
    // make sure every returned typed array owns a compact buffer before transferring
    if (result.mesh) result.mesh = { positions: own(result.mesh.positions), indices: own(result.mesh.indices) };
    if (result.bytes) result.bytes = own(result.bytes);
    self.postMessage({ id, type: 'done', result }, transferables(result));
  } catch (e) {
    self.postMessage({ id, type: 'error', message: e?.message || String(e) });
  }
};
function own(a) { return a.byteOffset === 0 && a.byteLength === a.buffer.byteLength ? a : a.slice(); }
self.postMessage({ type: 'ready' });
