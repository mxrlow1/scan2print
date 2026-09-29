// Scan2Print mesh operations. Pure functions on indexed triangle meshes:
//   mesh = { positions: Float32Array(nv*3), indices: Uint32Array(nt*3) }
// No DOM access, so this module runs on the main thread, in a Web Worker, or in Node.
import { ShapeUtils, Vector2 } from '../vendor/three/build/three.core.js';

const noop = () => {};

// ---------- small growable typed buffers ----------
class GrowF32 {
  constructor(n = 1024) { this.a = new Float32Array(Math.max(16, n)); this.n = 0; }
  push3(x, y, z) {
    if (this.n + 3 > this.a.length) { const b = new Float32Array(this.a.length * 2); b.set(this.a); this.a = b; }
    this.a[this.n++] = x; this.a[this.n++] = y; this.a[this.n++] = z;
  }
  get() { return this.a.slice(0, this.n); }
}
class GrowU32 {
  constructor(n = 1024) { this.a = new Uint32Array(Math.max(16, n)); this.n = 0; }
  push(x) {
    if (this.n + 1 > this.a.length) { const b = new Uint32Array(this.a.length * 2); b.set(this.a); this.a = b; }
    this.a[this.n++] = x;
  }
  push3(x, y, z) { this.push(x); this.push(y); this.push(z); }
  get() { return this.a.slice(0, this.n); }
}

function nextPow2(n) { let p = 16; while (p < n) p *= 2; return p; }
const nextE = (e) => (e % 3 === 2 ? e - 2 : e + 1);

// ---------- basic geometry ----------
export function computeBBox(pos) {
  let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
  for (let i = 0; i < pos.length; i += 3) {
    const x = pos[i], y = pos[i + 1], z = pos[i + 2];
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
    if (z < z0) z0 = z; if (z > z1) z1 = z;
  }
  if (!isFinite(x0)) return { min: [0, 0, 0], max: [0, 0, 0] };
  return { min: [x0, y0, z0], max: [x1, y1, z1] };
}

export function bboxDiag(bb) {
  return Math.hypot(bb.max[0] - bb.min[0], bb.max[1] - bb.min[1], bb.max[2] - bb.min[2]);
}

/** Signed volume (positive for outward-facing closed meshes) and surface area. */
export function volumeArea(mesh) {
  const P = mesh.positions, I = mesh.indices;
  let vol = 0, area = 0;
  for (let t = 0; t < I.length; t += 3) {
    const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
    const ax = P[a], ay = P[a + 1], az = P[a + 2];
    const bx = P[b], by = P[b + 1], bz = P[b + 2];
    const cx = P[c], cy = P[c + 1], cz = P[c + 2];
    vol += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
    const ux = bx - ax, uy = by - ay, uz = bz - az, vx = cx - ax, vy = cy - ay, vz = cz - az;
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    area += Math.sqrt(nx * nx + ny * ny + nz * nz);
  }
  return { volume: vol / 6, area: area / 2 };
}

/** Apply a column-major 4x4 matrix (three.js Matrix4.elements). Flips winding when det < 0. */
export function transformMesh(mesh, m) {
  const P = mesh.positions, out = new Float32Array(P.length);
  for (let i = 0; i < P.length; i += 3) {
    const x = P[i], y = P[i + 1], z = P[i + 2];
    out[i] = m[0] * x + m[4] * y + m[8] * z + m[12];
    out[i + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
    out[i + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
  }
  const det = m[0] * (m[5] * m[10] - m[9] * m[6]) - m[4] * (m[1] * m[10] - m[9] * m[2]) + m[8] * (m[1] * m[6] - m[5] * m[2]);
  return { positions: out, indices: det < 0 ? flipWinding(mesh.indices) : mesh.indices };
}

export function flipWinding(I) {
  const out = new Uint32Array(I.length);
  for (let t = 0; t < I.length; t += 3) { out[t] = I[t]; out[t + 1] = I[t + 2]; out[t + 2] = I[t + 1]; }
  return out;
}

/** Translate so the model sits on y=0 and is centered in x/z. Returns same indices. */
export function dropToPlate(mesh) {
  const bb = computeBBox(mesh.positions);
  const dx = -(bb.min[0] + bb.max[0]) / 2, dy = -bb.min[1], dz = -(bb.min[2] + bb.max[2]) / 2;
  if (Math.abs(dx) < 1e-9 && Math.abs(dy) < 1e-9 && Math.abs(dz) < 1e-9) return mesh;
  const P = mesh.positions, out = new Float32Array(P.length);
  for (let i = 0; i < P.length; i += 3) { out[i] = P[i] + dx; out[i + 1] = P[i + 1] + dy; out[i + 2] = P[i + 2] + dz; }
  return { positions: out, indices: mesh.indices };
}

// ---------- welding / compaction ----------
/** Merge coincident vertices (grid quantized at relTol * bbox diagonal) and drop degenerate triangles. */
export function weld(positions, indices = null, relTol = 1e-6, progress = noop) {
  const nIn = positions.length / 3;
  const bb = computeBBox(positions);
  const diag = bboxDiag(bb) || 1;
  const inv = 1 / (diag * relTol);
  const cap = nextPow2(nIn * 2), mask = cap - 1;
  const table = new Int32Array(cap).fill(-1);
  const qx = new Int32Array(nIn), qy = new Int32Array(nIn), qz = new Int32Array(nIn);
  const out = new Float32Array(nIn * 3);
  const remap = new Uint32Array(nIn);
  let nu = 0;
  const [mx, my, mz] = bb.min;
  for (let i = 0; i < nIn; i++) {
    if ((i & 0x3ffff) === 0) progress(0.8 * i / nIn);
    const x = positions[i * 3], y = positions[i * 3 + 1], z = positions[i * 3 + 2];
    const ix = Math.round((x - mx) * inv), iy = Math.round((y - my) * inv), iz = Math.round((z - mz) * inv);
    let h = (Math.imul(ix, 0x8da6b343) ^ Math.imul(iy, 0xd8163841) ^ Math.imul(iz, 0xcb1ab31f)) & mask;
    for (;;) {
      const s = table[h];
      if (s === -1) {
        table[h] = nu; qx[nu] = ix; qy[nu] = iy; qz[nu] = iz;
        out[nu * 3] = x; out[nu * 3 + 1] = y; out[nu * 3 + 2] = z;
        remap[i] = nu++; break;
      }
      if (qx[s] === ix && qy[s] === iy && qz[s] === iz) { remap[i] = s; break; }
      h = (h + 1) & mask;
    }
  }
  const nIdx = indices ? indices.length : nIn;
  const tris = new Uint32Array(nIdx - (nIdx % 3));
  let n = 0;
  for (let t = 0; t + 2 < nIdx; t += 3) {
    const a = remap[indices ? indices[t] : t], b = remap[indices ? indices[t + 1] : t + 1], c = remap[indices ? indices[t + 2] : t + 2];
    if (a === b || b === c || a === c) continue;
    tris[n++] = a; tris[n++] = b; tris[n++] = c;
  }
  progress(1);
  return compact({ positions: out.subarray(0, nu * 3), indices: tris.subarray(0, n) });
}

/** Remove unreferenced vertices. Always returns fresh arrays. */
export function compact(mesh) {
  const P = mesh.positions, I = mesh.indices, nv = P.length / 3;
  const map = new Int32Array(nv).fill(-1);
  let n = 0;
  for (let i = 0; i < I.length; i++) { const v = I[i]; if (map[v] === -1) map[v] = n++; }
  const pos = new Float32Array(n * 3);
  for (let v = 0; v < nv; v++) {
    const m = map[v];
    if (m !== -1) { pos[m * 3] = P[v * 3]; pos[m * 3 + 1] = P[v * 3 + 1]; pos[m * 3 + 2] = P[v * 3 + 2]; }
  }
  const idx = new Uint32Array(I.length);
  for (let i = 0; i < I.length; i++) idx[i] = map[I[i]];
  return { positions: pos, indices: idx };
}

/** Remove repeated faces. Same winding: keep one. Opposite winding (a zero-volume "fin"): drop both. */
export function removeDuplicateFaces(mesh) {
  const I = mesh.indices, nv = mesh.positions.length / 3, nt = I.length / 3;
  const map = new Map();
  const drop = new Uint8Array(nt);
  let removed = 0;
  for (let t = 0; t < nt; t++) {
    const a = I[t * 3], b = I[t * 3 + 1], c = I[t * 3 + 2];
    let lo = a, mid = b, hi = c, tmp;
    if (lo > mid) { tmp = lo; lo = mid; mid = tmp; }
    if (mid > hi) { tmp = mid; mid = hi; hi = tmp; }
    if (lo > mid) { tmp = lo; lo = mid; mid = tmp; }
    const key = lo * nv + mid;
    let list = map.get(key);
    if (!list) { map.set(key, [hi, t]); continue; }
    let found = -1;
    for (let k = 0; k < list.length; k += 2) if (list[k] === hi && !drop[list[k + 1]]) { found = list[k + 1]; break; }
    if (found === -1) { list.push(hi, t); continue; }
    // same cyclic order => same orientation
    const fa = I[found * 3], fb = I[found * 3 + 1], fc = I[found * 3 + 2];
    const same = (fa === a && fb === b) || (fb === a && fc === b) || (fc === a && fa === b);
    drop[t] = 1; removed++;
    if (!same) { drop[found] = 1; removed++; }
  }
  if (!removed) return { mesh, removed: 0 };
  const out = new Uint32Array(I.length - removed * 3);
  let n = 0;
  for (let t = 0; t < nt; t++) if (!drop[t]) { out[n++] = I[t * 3]; out[n++] = I[t * 3 + 1]; out[n++] = I[t * 3 + 2]; }
  return { mesh: compact({ positions: mesh.positions, indices: out }), removed };
}

// ---------- edge table (open addressing hash of undirected edges) ----------
export function buildEdges(I) {
  const ne = I.length;
  const cap = nextPow2(Math.ceil(ne * 1.3)), mask = cap - 1;
  const ka = new Int32Array(cap).fill(-1), kb = new Int32Array(cap);
  const cnt = new Int32Array(cap), first = new Int32Array(cap);
  const slot = new Int32Array(ne);
  for (let e = 0; e < ne; e++) {
    const a = I[e], b = I[nextE(e)];
    const lo = a < b ? a : b, hi = a < b ? b : a;
    let h = (Math.imul(lo, 0x9e3779b1) ^ Math.imul(hi, 0x85ebca77)) & mask;
    for (;;) {
      const s = ka[h];
      if (s === -1) { ka[h] = lo; kb[h] = hi; cnt[h] = 1; first[h] = e; break; }
      if (s === lo && kb[h] === hi) { cnt[h]++; break; }
      h = (h + 1) & mask;
    }
    slot[e] = h;
  }
  return { ka, kb, cnt, first, slot, cap };
}

export function edgeCount(E, a, b) {
  const lo = a < b ? a : b, hi = a < b ? b : a, mask = E.cap - 1;
  let h = (Math.imul(lo, 0x9e3779b1) ^ Math.imul(hi, 0x85ebca77)) & mask;
  for (;;) {
    const s = E.ka[h];
    if (s === -1) return 0;
    if (s === lo && E.kb[h] === hi) return E.cnt[h];
    h = (h + 1) & mask;
  }
}

// ---------- connectivity ----------
function vertexComponents(I, nv) {
  const parent = new Int32Array(nv);
  for (let i = 0; i < nv; i++) parent[i] = i;
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const union = (a, b) => { a = find(a); b = find(b); if (a !== b) { if (a < b) parent[b] = a; else parent[a] = b; } };
  for (let t = 0; t < I.length; t += 3) { union(I[t], I[t + 1]); union(I[t], I[t + 2]); }
  const label = new Int32Array(nv).fill(-1), rootLabel = new Int32Array(nv).fill(-1);
  let nc = 0;
  for (let v = 0; v < nv; v++) {
    const r = find(v);
    if (rootLabel[r] === -1) rootLabel[r] = nc++;
    label[v] = rootLabel[r];
  }
  return { label, count: nc };
}

/** Returns per-shell triangle counts and a triangle->shell label. */
export function shells(mesh) {
  const I = mesh.indices, nv = mesh.positions.length / 3;
  const { label, count } = vertexComponents(I, nv);
  const triCount = new Int32Array(count);
  for (let t = 0; t < I.length; t += 3) triCount[label[I[t]]]++;
  return { vertexLabel: label, count, triCount };
}

/** Remove disconnected pieces. mode 'largest' keeps only the biggest shell; 'threshold' keeps shells with
 *  at least `percent`% of the triangles of the largest shell. */
export function removeSmallPieces(mesh, { mode = 'largest', percent = 5 } = {}) {
  const sh = shells(mesh);
  let big = 0;
  for (let c = 1; c < sh.count; c++) if (sh.triCount[c] > sh.triCount[big]) big = c;
  const minTris = mode === 'largest' ? Infinity : sh.triCount[big] * (percent / 100);
  const I = mesh.indices, keep = new GrowU32(I.length);
  let removedShells = 0;
  const keepShell = new Uint8Array(sh.count);
  for (let c = 0; c < sh.count; c++) { keepShell[c] = (c === big || sh.triCount[c] >= minTris) ? 1 : 0; if (!keepShell[c]) removedShells++; }
  for (let t = 0; t < I.length; t += 3) if (keepShell[sh.vertexLabel[I[t]]]) keep.push3(I[t], I[t + 1], I[t + 2]);
  const out = compact({ positions: mesh.positions, indices: keep.get() });
  return { mesh: out, info: { removedShells, removedTris: (I.length - out.indices.length) / 3 } };
}

// ---------- boundary loops & hole filling ----------
export function boundaryLoops(mesh, E = buildEdges(mesh.indices)) {
  const I = mesh.indices, nv = mesh.positions.length / 3;
  const bl = [];
  for (let s = 0; s < E.cap; s++) if (E.ka[s] !== -1 && E.cnt[s] === 1) bl.push(E.first[s]);
  const nb = bl.length;
  const head = new Int32Array(nv).fill(-1), nxt = new Int32Array(nb);
  for (let j = 0; j < nb; j++) { const a = I[bl[j]]; nxt[j] = head[a]; head[a] = j; }
  const used = new Uint8Array(nb);
  const loops = [];
  let open = 0;
  for (let j0 = 0; j0 < nb; j0++) {
    if (used[j0]) continue;
    const start = I[bl[j0]];
    const loop = [];
    let j = j0, closed = false;
    for (;;) {
      used[j] = 1;
      const e = bl[j];
      loop.push(I[e]);
      const b = I[nextE(e)];
      if (b === start) { closed = true; break; }
      let k = head[b];
      while (k !== -1 && used[k]) k = nxt[k];
      if (k === -1) break;
      j = k;
    }
    if (closed && loop.length >= 3) loops.push(loop); else open++;
  }
  return { loops, open, boundaryEdges: nb };
}

function newellNormal(P, verts) {
  let nx = 0, ny = 0, nz = 0;
  const n = verts.length;
  for (let i = 0; i < n; i++) {
    const a = verts[i] * 3, b = verts[(i + 1) % n] * 3;
    nx += (P[a + 1] - P[b + 1]) * (P[a + 2] + P[b + 2]);
    ny += (P[a + 2] - P[b + 2]) * (P[a] + P[b]);
    nz += (P[a] - P[b]) * (P[a + 1] + P[b + 1]);
  }
  return [nx, ny, nz];
}

function planeBasis(n) {
  const [nx, ny, nz] = n;
  // u = any unit vector perpendicular to n; v = n x u  (so u x v = n)
  let ux, uy, uz;
  if (Math.abs(nx) < 0.9) { ux = 0; uy = nz; uz = -ny; } else { ux = -nz; uy = 0; uz = nx; }
  const ul = Math.hypot(ux, uy, uz); ux /= ul; uy /= ul; uz /= ul;
  const vx = ny * uz - nz * uy, vy = nz * ux - nx * uz, vz = nx * uy - ny * ux;
  return [[ux, uy, uz], [vx, vy, vz]];
}

const area2 = (a, b, c) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);

/** Triangulate a polygon (vertex indices, CCW around its Newell normal). Returns flat index list or null. */
function triangulatePolygon(P, verts) {
  const n = verts.length;
  if (n === 3) return [verts[0], verts[1], verts[2]];
  let N = newellNormal(P, verts);
  const len = Math.hypot(N[0], N[1], N[2]);
  if (len < 1e-20) return null;
  N = [N[0] / len, N[1] / len, N[2] / len];
  const [u, v] = planeBasis(N);
  const pts = verts.map((vi) => {
    const x = P[vi * 3], y = P[vi * 3 + 1], z = P[vi * 3 + 2];
    return new Vector2(x * u[0] + y * u[1] + z * u[2], x * v[0] + y * v[1] + z * v[2]);
  });
  let faces;
  try { faces = ShapeUtils.triangulateShape(pts.slice(), []); } catch { return null; }
  if (faces.length !== n - 2) return null;
  const out = [];
  for (const [i, j, k] of faces) {
    if (area2(pts[i], pts[j], pts[k]) >= 0) out.push(verts[i], verts[j], verts[k]);
    else out.push(verts[i], verts[k], verts[j]);
  }
  return out;
}

/** Split a boundary cycle that passes through the same vertex more than once into simple cycles. */
function splitLoop(loop) {
  const out = [], stack = [], seen = new Map();
  for (const v of loop) {
    if (seen.has(v)) {
      const sub = stack.splice(seen.get(v));
      for (const w of sub) seen.delete(w);
      out.push(sub);
    }
    seen.set(v, stack.length); stack.push(v);
  }
  if (stack.length) out.push(stack);
  return out.filter((l) => l.length >= 3);
}

/** Fill boundary loops. maxEdges = 0 fills every hole; otherwise skips loops with more edges. */
export function fillHoles(mesh, { maxEdges = 0, onlyVerts = null } = {}, progress = noop) {
  const P = mesh.positions;
  const E = buildEdges(mesh.indices);
  const bl = boundaryLoops(mesh, E), open = bl.open;
  const loops = bl.loops.flatMap(splitLoop);
  const newPos = new GrowF32(1024);
  const newTris = new GrowU32(4096);
  const nv = P.length / 3;
  let filled = 0, skipped = 0, fan = 0;
  loops.forEach((loop, li) => {
    if (li % 16 === 0) progress(li / loops.length);
    if (onlyVerts && !loop.some((v) => onlyVerts[v])) return;
    if (maxEdges > 0 && loop.length > maxEdges) { skipped++; return; }
    const rev = loop.slice().reverse(); // fill faces must run opposite to the existing border edges
    let tris = triangulatePolygon(P, rev);
    if (tris && rev.length > 3) {
      // a diagonal that already exists elsewhere would create a non-manifold edge -> use a centroid fan instead
      const pos = new Map(rev.map((v, i) => [v, i]));
      const isChord = (x, y) => { const d = Math.abs(pos.get(x) - pos.get(y)); return d !== 1 && d !== rev.length - 1; };
      for (let i = 0; tris && i < tris.length; i += 3) {
        for (let k = 0; k < 3; k++) {
          const x = tris[i + k], y = tris[i + (k + 1) % 3];
          if (isChord(x, y) && edgeCount(E, x, y) > 0) { tris = null; break; }
        }
      }
    }
    if (tris && rev.length === 3 && edgeCount(E, rev[0], rev[1]) + edgeCount(E, rev[1], rev[2]) + edgeCount(E, rev[2], rev[0]) > 3) tris = null;
    if (tris) { for (const i of tris) newTris.push(i); }
    else {
      let cx = 0, cy = 0, cz = 0;
      for (const vi of rev) { cx += P[vi * 3]; cy += P[vi * 3 + 1]; cz += P[vi * 3 + 2]; }
      const c = nv + newPos.n / 3;
      newPos.push3(cx / rev.length, cy / rev.length, cz / rev.length);
      for (let i = 0; i < rev.length; i++) newTris.push3(rev[i], rev[(i + 1) % rev.length], c);
      fan++;
    }
    filled++;
  });
  const extra = newPos.get();
  const positions = new Float32Array(P.length + extra.length);
  positions.set(P); positions.set(extra, P.length);
  const add = newTris.get();
  const indices = new Uint32Array(mesh.indices.length + add.length);
  indices.set(mesh.indices); indices.set(add, mesh.indices.length);
  return { mesh: { positions, indices }, info: { filled, skipped, fan, openChains: open } };
}

/** Fix edges shared by more than two faces: delete the faces around them and re-fill the small holes left behind. */
export function repairNonManifold(mesh, maxIter = 4) {
  let cur = removeDuplicateFaces(mesh).mesh;
  let removedFaces = 0, iter = 0;
  for (; iter < maxIter; iter++) {
    const I = cur.indices, E = buildEdges(I), nt = I.length / 3;
    const drop = new Uint8Array(nt);
    let nd = 0;
    for (let e = 0; e < I.length; e++) if (E.cnt[E.slot[e]] > 2 && !drop[(e / 3) | 0]) { drop[(e / 3) | 0] = 1; nd++; }
    if (!nd) break;
    const touched = new Uint8Array(cur.positions.length / 3);
    const keep = new Uint32Array(I.length - nd * 3);
    let n = 0;
    for (let t = 0; t < nt; t++) {
      if (drop[t]) { touched[I[t * 3]] = touched[I[t * 3 + 1]] = touched[I[t * 3 + 2]] = 1; continue; }
      keep[n++] = I[t * 3]; keep[n++] = I[t * 3 + 1]; keep[n++] = I[t * 3 + 2];
    }
    removedFaces += nd;
    cur = fillHoles({ positions: cur.positions, indices: keep }, { onlyVerts: touched }).mesh;
    cur = removeDuplicateFaces(cur).mesh;
  }
  return { mesh: compact(cur), info: { removedFaces, iterations: iter } };
}

// ---------- smoothing (Taubin lambda|mu, avoids the shrinkage of plain Laplacian) ----------
export function smooth(mesh, { iterations = 5, lambda = 0.5, mu = -0.53, keepBoundary = true } = {}, progress = noop) {
  const I = mesh.indices, nv = mesh.positions.length / 3;
  const E = buildEdges(I);
  const deg = new Int32Array(nv + 1);
  const fixed = new Uint8Array(nv);
  for (let s = 0; s < E.cap; s++) {
    if (E.ka[s] === -1) continue;
    deg[E.ka[s]]++; deg[E.kb[s]]++;
    if (keepBoundary && E.cnt[s] !== 2) { fixed[E.ka[s]] = 1; fixed[E.kb[s]] = 1; }
  }
  const off = new Int32Array(nv + 1);
  for (let v = 0; v < nv; v++) off[v + 1] = off[v] + deg[v];
  const fill = off.slice(0, nv);
  const adj = new Int32Array(off[nv]);
  for (let s = 0; s < E.cap; s++) {
    if (E.ka[s] === -1) continue;
    const a = E.ka[s], b = E.kb[s];
    adj[fill[a]++] = b; adj[fill[b]++] = a;
  }
  let cur = new Float32Array(mesh.positions), tmp = new Float32Array(cur.length);
  const pass = (f) => {
    for (let v = 0; v < nv; v++) {
      const i = v * 3, o0 = off[v], o1 = off[v + 1];
      if (fixed[v] || o1 === o0) { tmp[i] = cur[i]; tmp[i + 1] = cur[i + 1]; tmp[i + 2] = cur[i + 2]; continue; }
      let sx = 0, sy = 0, sz = 0;
      for (let k = o0; k < o1; k++) { const j = adj[k] * 3; sx += cur[j]; sy += cur[j + 1]; sz += cur[j + 2]; }
      const inv = 1 / (o1 - o0);
      tmp[i] = cur[i] + f * (sx * inv - cur[i]);
      tmp[i + 1] = cur[i + 1] + f * (sy * inv - cur[i + 1]);
      tmp[i + 2] = cur[i + 2] + f * (sz * inv - cur[i + 2]);
    }
    const s = cur; cur = tmp; tmp = s;
  };
  for (let it = 0; it < iterations; it++) {
    progress(it / iterations);
    pass(lambda);
    if (mu) pass(mu);
  }
  return { mesh: { positions: cur, indices: I }, info: { iterations } };
}

// ---------- plane cut with capping ----------
function pointInPoly(p, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}
function polyArea(pts) {
  let s = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) s += pts[j].x * pts[i].y - pts[i].x * pts[j].y;
  return s / 2;
}

/**
 * Cut with plane n·p = offset, keeping the side where n·p < offset (n points to the removed side).
 * With cap=true the cut section is triangulated so a closed input stays closed.
 */
export function planeCut(mesh, { normal, offset, cap = true }, progress = noop) {
  const P = mesh.positions, I = mesh.indices, nv = P.length / 3;
  const nl = Math.hypot(normal[0], normal[1], normal[2]);
  const nx = normal[0] / nl, ny = normal[1] / nl, nz = normal[2] / nl;
  const c0 = offset / nl;
  const eps = (bboxDiag(computeBBox(P)) || 1) * 1e-5;
  const d = new Float64Array(nv);
  const onPlane = new Uint8Array(nv);
  for (let v = 0; v < nv; v++) {
    let dv = nx * P[v * 3] + ny * P[v * 3 + 1] + nz * P[v * 3 + 2] - c0;
    // Vertices (almost) on the plane count as removed, and every crossing edge that ends in one snaps to
    // a single shared copy of it. That avoids sliver triangles and keeps the cut boundary manifold.
    if (Math.abs(dv) < eps) { dv = eps; onPlane[v] = 1; }
    d[v] = dv;
  }
  const snapMap = new Map();
  const vmap = new Int32Array(nv).fill(-1);
  const pos = new GrowF32(P.length + 1024);
  let nOut = 0;
  for (let v = 0; v < nv; v++) if (d[v] < 0) { vmap[v] = nOut++; pos.push3(P[v * 3], P[v * 3 + 1], P[v * 3 + 2]); }
  const nKept = nOut;
  const edgeMap = new Map();
  const ix = (a, b) => {
    const lo = a < b ? a : b, hi = a < b ? b : a;
    const on = onPlane[lo] ? lo : onPlane[hi] ? hi : -1;
    if (on !== -1) {
      let r = snapMap.get(on);
      if (r === undefined) { pos.push3(P[on * 3], P[on * 3 + 1], P[on * 3 + 2]); r = nOut++; snapMap.set(on, r); }
      return r;
    }
    const key = lo * nv + hi;
    let r = edgeMap.get(key);
    if (r !== undefined) return r;
    const t = d[lo] / (d[lo] - d[hi]);
    pos.push3(P[lo * 3] + t * (P[hi * 3] - P[lo * 3]), P[lo * 3 + 1] + t * (P[hi * 3 + 1] - P[lo * 3 + 1]), P[lo * 3 + 2] + t * (P[hi * 3 + 2] - P[lo * 3 + 2]));
    r = nOut++;
    edgeMap.set(key, r);
    return r;
  };
  const tris = new GrowU32(I.length + 1024);
  const segs = new GrowU32(4096);
  const nt = I.length / 3;
  for (let t = 0; t < nt; t++) {
    if ((t & 0x3ffff) === 0) progress(0.7 * t / nt);
    let a = I[t * 3], b = I[t * 3 + 1], c = I[t * 3 + 2];
    const ka = d[a] < 0, kb = d[b] < 0, kc = d[c] < 0;
    const k = ka + kb + kc;
    if (k === 3) { tris.push3(vmap[a], vmap[b], vmap[c]); continue; }
    if (k === 0) continue;
    if (k === 1) {
      if (kb) { const s = a; a = b; b = c; c = s; } else if (kc) { const s = a; a = c; c = b; b = s; }
      const ab = ix(a, b), ca = ix(c, a);
      if (ab !== ca) { tris.push3(vmap[a], ab, ca); segs.push(ab); segs.push(ca); }
    } else {
      if (!ka) { const s = a; a = b; b = c; c = s; } else if (!kb) { const s = a; a = c; c = b; b = s; }
      const bc = ix(b, c), ca = ix(c, a);
      tris.push3(vmap[a], vmap[b], bc);
      if (bc !== ca) { tris.push3(vmap[a], bc, ca); segs.push(bc); segs.push(ca); }
    }
  }
  let capInfo = { loops: 0, capTris: 0, openChains: 0 };
  if (cap && segs.n) {
    const S = segs.get();
    const posArr = pos.a; // live view, ok for reading
    const ni = nOut - nKept;
    const adjA = new Int32Array(ni).fill(-1), adjB = new Int32Array(ni).fill(-1), deg = new Int32Array(ni);
    const link = (p, q) => { const i = p - nKept; if (adjA[i] === -1) adjA[i] = q; else if (adjB[i] === -1) adjB[i] = q; deg[i]++; };
    for (let s = 0; s < S.length; s += 2) { if (S[s] === S[s + 1]) continue; link(S[s], S[s + 1]); link(S[s + 1], S[s]); }
    const visited = new Uint8Array(ni);
    const loops = [];
    const walk = (s0) => {
      const loop = [s0 + nKept]; visited[s0] = 1; let cur = s0;
      for (;;) {
        const a1 = adjA[cur], a2 = adjB[cur];
        let n = -1;
        if (a1 !== -1 && !visited[a1 - nKept]) n = a1 - nKept; else if (a2 !== -1 && !visited[a2 - nKept]) n = a2 - nKept;
        if (n === -1) break;
        visited[n] = 1; loop.push(n + nKept); cur = n;
      }
      const last = loop[loop.length - 1] - nKept;
      const closed = adjA[last] === s0 + nKept || adjB[last] === s0 + nKept;
      if (!closed) capInfo.openChains++;
      if (loop.length >= 3) loops.push(loop);
    };
    for (let i = 0; i < ni; i++) if (!visited[i] && deg[i] === 1) walk(i); // open chains first
    for (let i = 0; i < ni; i++) if (!visited[i] && deg[i] > 0) walk(i);
    progress(0.8);
    const [u, v] = planeBasis([nx, ny, nz]);
    const polys = loops.map((idx) => {
      const pts = idx.map((vi) => {
        const x = posArr[vi * 3], y = posArr[vi * 3 + 1], z = posArr[vi * 3 + 2];
        return new Vector2(x * u[0] + y * u[1] + z * u[2], x * v[0] + y * v[1] + z * v[2]);
      });
      const A = polyArea(pts);
      return { idx, pts, absA: Math.abs(A), parent: -1, depth: 0, holes: [] };
    }).filter((p) => p.absA > 0);
    polys.sort((a, b) => b.absA - a.absA);
    for (let i = 0; i < polys.length; i++) {
      for (let j = 0; j < i; j++) {
        if (pointInPoly(polys[i].pts[0], polys[j].pts)) { polys[i].depth++; polys[i].parent = j; }
      }
    }
    for (const p of polys) if (p.depth % 2 === 1 && p.parent >= 0) polys[p.parent].holes.push(p);
    for (const p of polys) {
      if (p.depth % 2 === 1 && p.parent >= 0) continue;
      const ptsAll = p.pts.concat(...p.holes.map((h) => h.pts));
      const idxAll = p.idx.concat(...p.holes.map((h) => h.idx));
      let faces;
      try { faces = ShapeUtils.triangulateShape(p.pts.slice(), p.holes.map((h) => h.pts.slice())); } catch { faces = []; }
      for (const [i, j, k] of faces) {
        if (area2(ptsAll[i], ptsAll[j], ptsAll[k]) >= 0) tris.push3(idxAll[i], idxAll[j], idxAll[k]);
        else tris.push3(idxAll[i], idxAll[k], idxAll[j]);
        capInfo.capTris++;
      }
      capInfo.loops++;
    }
  }
  progress(0.95);
  const out = compact({ positions: pos.get(), indices: tris.get() });
  return { mesh: out, info: { ...capInfo, removedTris: nt - (out.indices.length / 3 - capInfo.capTris) } };
}

// ---------- analysis ----------
export function analyze(mesh) {
  const I = mesh.indices, nv = mesh.positions.length / 3;
  const E = buildEdges(I);
  let edges = 0, boundaryEdges = 0, nonManifoldEdges = 0;
  for (let s = 0; s < E.cap; s++) {
    if (E.ka[s] === -1) continue;
    edges++;
    const c = E.cnt[s];
    if (c === 1) boundaryEdges++; else if (c > 2) nonManifoldEdges++;
  }
  const holes = boundaryEdges ? boundaryLoops(mesh, E).loops.length : 0;
  const sh = shells(mesh);
  const va = volumeArea(mesh);
  return {
    tris: I.length / 3, verts: nv, edges, boundaryEdges, nonManifoldEdges, holes,
    shells: sh.count, volume: va.volume, area: va.area,
    watertight: boundaryEdges === 0 && nonManifoldEdges === 0 && I.length > 0,
  };
}
