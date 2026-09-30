// Depth fusion core: truncated signed distance field (TSDF) volume + marching cubes.
// Pure JS (no DOM / three.js). Used by js/fusion-worker.js on the phone and by the Node unit tests.
// Conventions: world space in metres, Y up (WebXR 'local' space). Matrices are column-major Float32Array(16) like WebXR.
import { edgeTable, triTable } from './mc-tables.js';

/** Create an axis-aligned voxel volume. min: [x,y,z] of the box corner, size: edge length (m), res: voxels per edge. */
export function createVolume({ min, size, res = 128, trunc }) {
  const n = res * res * res;
  const voxel = size / res;
  return {
    min: Float64Array.from(min), size, res, voxel,
    trunc: trunc || Math.max(4 * voxel, 0.008),
    tsdf: new Float32Array(n).fill(1),
    weight: new Float32Array(n),
    maxWeight: 64,
    frames: 0,
  };
}

export function resetVolume(vol) { vol.tsdf.fill(1); vol.weight.fill(0); vol.frames = 0; }

export function mul4(a, b) { // column-major a*b
  const o = new Float64Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    let s = 0; for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
    o[c * 4 + r] = s;
  }
  return o;
}

export function invertRigid(m) { // inverse of a rotation+translation matrix (column-major)
  const o = new Float64Array(16);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) o[c * 4 + r] = m[r * 4 + c];
  for (let r = 0; r < 3; r++) o[12 + r] = -(o[r] * m[12] + o[4 + r] * m[13] + o[8 + r] * m[14]);
  o[15] = 1;
  return o;
}

/**
 * Fuse one depth frame.
 * frame = { width, height, depth: Float32Array (metres along the camera's viewing axis, 0 = invalid),
 *           proj: projection matrix of the view, view: world→camera matrix,
 *           normDepthFromNormView: matrix mapping normalized view coords (0..1, origin top-left) to normalized depth-buffer coords,
 *           maxDepth?: metres }
 * Returns the number of voxels updated.
 */
export function integrate(vol, frame) {
  const { width: W, height: H, depth } = frame;
  const A = mul4(frame.proj, frame.view);
  const V = frame.view;
  const M = frame.normDepthFromNormView || [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const m0 = M[0], m1 = M[1], m4 = M[4], m5 = M[5], m12 = M[12], m13 = M[13];
  const maxDepth = frame.maxDepth || 3;
  const { res, voxel, tsdf, weight, maxWeight } = vol;
  const mu = vol.trunc, invMu = 1 / mu;
  const ox = vol.min[0] + voxel / 2, oy = vol.min[1] + voxel / 2, oz = vol.min[2] + voxel / 2;
  // clip = A * p, camera z = V * p; both affine in p so step them per voxel
  const ax = A[0] * voxel, ay = A[1] * voxel, aw = A[3] * voxel, az = V[2] * voxel;
  let updated = 0;
  for (let k = 0; k < res; k++) {
    const pz = oz + k * voxel;
    for (let j = 0; j < res; j++) {
      const py = oy + j * voxel;
      let cx = A[0] * ox + A[4] * py + A[8] * pz + A[12];
      let cy = A[1] * ox + A[5] * py + A[9] * pz + A[13];
      let cw = A[3] * ox + A[7] * py + A[11] * pz + A[15];
      let cz = V[2] * ox + V[6] * py + V[10] * pz + V[14];
      let idx = (k * res + j) * res;
      for (let i = 0; i < res; i++, idx++, cx += ax, cy += ay, cw += aw, cz += az) {
        const zc = -cz;
        if (zc < 0.05 || zc > maxDepth + mu) continue;
        const nx = cx / cw, ny = cy / cw;
        if (nx < -1 || nx > 1 || ny < -1 || ny > 1) continue;
        const u = (nx + 1) * 0.5, v = (1 - ny) * 0.5;
        const du = m0 * u + m4 * v + m12, dv = m1 * u + m5 * v + m13;
        if (du < 0 || du >= 1 || dv < 0 || dv >= 1) continue;
        const d = depth[((dv * H) | 0) * W + ((du * W) | 0)];
        if (!(d > 0) || d > maxDepth) continue;
        const sdf = d - zc;
        if (sdf < -mu) continue;               // hidden behind the surface: unknown
        const t = sdf >= mu ? 1 : sdf * invMu;
        const w = weight[idx];
        tsdf[idx] = (tsdf[idx] * w + t) / (w + 1);
        weight[idx] = w + 1 > maxWeight ? maxWeight : w + 1;
        updated++;
      }
    }
  }
  vol.frames++;
  return updated;
}

// corner offsets (Bourke order) and edge → (corner, axis)
const CORNER = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]];
const EDGE_CORNERS = [[0, 1], [1, 2], [3, 2], [0, 3], [4, 5], [5, 6], [7, 6], [4, 7], [0, 4], [1, 5], [2, 6], [3, 7]];
const EDGE_AXIS = [0, 1, 0, 1, 0, 1, 0, 1, 2, 2, 2, 2];

/**
 * Marching cubes over observed voxels. step > 1 gives a coarser, faster preview.
 * Returns { positions: Float32Array, indices: Uint32Array } in world metres (or box-local if local=true: origin at the box floor centre).
 */
export function extractMesh(vol, { step = 1, minWeight = 1, local = false } = {}) {
  const { res, voxel, tsdf, weight } = vol;
  const s = Math.max(1, step | 0);
  const n = Math.floor((res - 1) / s); // cubes per axis
  const ox = local ? -vol.size / 2 + voxel / 2 : vol.min[0] + voxel / 2;
  const oy = local ? voxel / 2 : vol.min[1] + voxel / 2;
  const oz = local ? -vol.size / 2 + voxel / 2 : vol.min[2] + voxel / 2;
  const pos = [], idx = [];
  const cache = new Map();
  const R = res, RR = res * res;
  const cornerIdx = new Int32Array(8), cornerVal = new Float32Array(8), edgeVert = new Int32Array(12);
  const offs = CORNER.map(([a, b, c]) => (a + b * R + c * RR) * s);
  for (let k = 0; k < n; k++) for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const base = (i + j * R + k * RR) * s;
    let cube = 0, ok = true;
    for (let c = 0; c < 8; c++) {
      const id = base + offs[c];
      if (weight[id] < minWeight) { ok = false; break; }
      cornerIdx[c] = id; cornerVal[c] = tsdf[id];
      if (cornerVal[c] < 0) cube |= 1 << c;
    }
    if (!ok || cube === 0 || cube === 255) continue;
    const edges = edgeTable[cube];
    for (let e = 0; e < 12; e++) {
      if (!(edges & (1 << e))) continue;
      const [ca, cb] = EDGE_CORNERS[e];
      const key = cornerIdx[ca] * 3 + EDGE_AXIS[e];
      let vi = cache.get(key);
      if (vi === undefined) {
        const va = cornerVal[ca], vb = cornerVal[cb];
        const t = va === vb ? 0.5 : va / (va - vb);
        const A = CORNER[ca], B = CORNER[cb];
        vi = pos.length / 3;
        pos.push(
          ox + (i + A[0] + t * (B[0] - A[0])) * s * voxel,
          oy + (j + A[1] + t * (B[1] - A[1])) * s * voxel,
          oz + (k + A[2] + t * (B[2] - A[2])) * s * voxel);
        cache.set(key, vi);
      }
      edgeVert[e] = vi;
    }
    const tb = cube * 16;
    for (let t = 0; triTable[tb + t] !== -1; t += 3) {
      // table winding is clockwise for "inside = negative"; swap to get outward-facing CCW triangles
      idx.push(edgeVert[triTable[tb + t]], edgeVert[triTable[tb + t + 2]], edgeVert[triTable[tb + t + 1]]);
    }
  }
  return { positions: new Float32Array(pos), indices: new Uint32Array(idx) };
}

/** Fraction of voxels that have been observed at least once (a rough coverage indicator). */
export function observedFraction(vol) {
  let c = 0; const w = vol.weight;
  for (let i = 0; i < w.length; i++) if (w[i] > 0) c++;
  return c / w.length;
}

/** Convert raw WebXR CPU depth data to metres (0 = invalid). raw: Uint16Array or Float32Array. */
export function depthToMeters(raw, rawValueToMeters, minDepth = 0.1, maxDepth = 3) {
  const out = new Float32Array(raw.length);
  for (let i = 0; i < raw.length; i++) {
    const d = raw[i] * rawValueToMeters;
    out[i] = d > minDepth && d < maxDepth ? d : 0;
  }
  return out;
}
