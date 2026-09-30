// Synthetic depth camera used by the unit tests and the in-app scan simulator (?scansim=1).
// It renders ARCore-like depth frames (landscape depth buffer, portrait view, via normDepthFromNormView)
// of a small object standing on a table, by sphere-tracing a signed distance function.
import { invertRigid } from './fusion.js';

/** Scene: table top at y = 0, a "vase" (capsule + sphere + cylinder base) centred at (0, 0, -0.5). Units: metres. */
export const SIM_CENTER = [0, 0, -0.5];
export function simSDF(x, y, z) {
  const px = x - SIM_CENTER[0], pz = z - SIM_CENTER[2];
  const r = Math.hypot(px, pz);
  // cylinder base r=4cm h=0..4cm
  const dCyl = Math.max(r - 0.04, Math.abs(y - 0.02) - 0.02);
  // sphere body r=5.5cm at y=0.09
  const dSph = Math.hypot(px, y - 0.09, pz) - 0.055;
  // neck capsule r=2cm from y=0.12 to 0.19
  const cy = Math.min(Math.max(y, 0.12), 0.19);
  const dNeck = Math.hypot(px, y - cy, pz) - 0.02;
  const obj = smin(smin(dCyl, dSph, 0.015), dNeck, 0.012);
  const table = y; // half-space below y = 0
  return Math.min(obj, table);
}
function smin(a, b, k) { const h = Math.max(k - Math.abs(a - b), 0) / k; return Math.min(a, b) - h * h * k * 0.25; }

export function perspective(fovY, aspect, near = 0.05, far = 20) {
  const f = 1 / Math.tan(fovY / 2), nf = 1 / (near - far);
  return Float32Array.from([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0]);
}

/** Camera→world matrix looking from eye to target (Y up). */
export function lookAt(eye, target) {
  const f = norm(sub(target, eye)), r = norm(cross(f, [0, 1, 0])), u = cross(r, f);
  return Float32Array.from([r[0], r[1], r[2], 0, u[0], u[1], u[2], 0, -f[0], -f[1], -f[2], 0, eye[0], eye[1], eye[2], 1]);
}
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

// portrait view (u,v) → landscape depth buffer (du,dv): du = v, dv = 1 - u  (a 90° rotation, like ARCore on a portrait phone)
export const PORTRAIT_NORM_DEPTH_FROM_NORM_VIEW = Float32Array.from([0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 1, 0, 1]);

/** Pose i of n on an orbit around the object: rings at three heights, like a user walking around it. */
export function simPose(i, n, { radius = 0.42, center = SIM_CENTER } = {}) {
  const t = i / n;
  const ring = Math.floor(t * 3), a = t * 3 * Math.PI * 2 + ring * 0.7;
  const h = [0.12, 0.28, 0.45][ring];
  const rr = radius * [1, 0.95, 0.7][ring];
  const eye = [center[0] + Math.sin(a) * rr, center[1] + h, center[2] + Math.cos(a) * rr];
  return lookAt(eye, [center[0], center[1] + 0.08, center[2]]);
}

/** Render one depth frame from camToWorld. noise: std-dev in metres (deterministic pseudo-noise). */
export function simDepthFrame(camToWorld, { width = 160, height = 90, fovY = 1.1, aspect = 9 / 19.5, noise = 0.002, seed = 1, sdf = simSDF, maxDepth = 3 } = {}) {
  const proj = perspective(fovY, aspect);
  const view = invertRigid(camToWorld);
  const depth = new Float32Array(width * height);
  const th = Math.tan(fovY / 2), eye = [camToWorld[12], camToWorld[13], camToWorld[14]];
  let s = seed >>> 0 || 1;
  const rnd = () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
  for (let py = 0; py < height; py++) for (let px = 0; px < width; px++) {
    const du = (px + 0.5) / width, dv = (py + 0.5) / height;
    const v = du, u = 1 - dv;                // inverse of PORTRAIT_NORM_DEPTH_FROM_NORM_VIEW
    const nx = 2 * u - 1, ny = 1 - 2 * v;
    const dc = [nx * th * aspect, ny * th, -1]; // camera-space ray with z = -1
    const dw = [
      camToWorld[0] * dc[0] + camToWorld[4] * dc[1] + camToWorld[8] * dc[2],
      camToWorld[1] * dc[0] + camToWorld[5] * dc[1] + camToWorld[9] * dc[2],
      camToWorld[2] * dc[0] + camToWorld[6] * dc[1] + camToWorld[10] * dc[2]];
    const len = Math.hypot(dw[0], dw[1], dw[2]);
    let t = 0.05 * len, hit = false;
    for (let it = 0; it < 96 && t < maxDepth * len; it++) {
      const d = sdf(eye[0] + dw[0] / len * t, eye[1] + dw[1] / len * t, eye[2] + dw[2] / len * t);
      if (d < 0.0004) { hit = true; break; }
      t += d * 0.9;
    }
    if (!hit) continue;
    const z = t / len; // distance along the viewing axis
    const g = (rnd() + rnd() + rnd() - 1.5) * 2 * noise;
    depth[py * width + px] = z + g * z;
  }
  return { width, height, depth, proj, view: Float32Array.from(view), normDepthFromNormView: PORTRAIT_NORM_DEPTH_FROM_NORM_VIEW, maxDepth };
}
