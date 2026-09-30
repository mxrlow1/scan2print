// Unit tests for the depth-fusion pipeline (TSDF + marching cubes) using the synthetic depth camera.
import assert from 'node:assert/strict';
import { createVolume, integrate, extractMesh, observedFraction, depthToMeters, invertRigid, mul4 } from '../js/fusion.js';
import { simDepthFrame, simPose, simSDF, SIM_CENTER } from '../js/scan-sim.js';
import * as ops from '../js/meshops.js';

let failed = 0;
const test = (name, fn) => { try { const t = performance.now(); const info = fn(); console.log(`PASS ${name}${info ? '  [' + info + ']' : ''} ${(performance.now() - t).toFixed(0)}ms`); } catch (e) { failed++; console.log(`FAIL ${name}\n  ${e.stack}`); } };

test('invertRigid', () => {
  const m = Float32Array.from([0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, 1, 2, 3, 1]);
  const p = mul4(m, invertRigid(m));
  for (let i = 0; i < 16; i++) assert.ok(Math.abs(p[i] - (i % 5 === 0 ? 1 : 0)) < 1e-6);
});

test('depthToMeters', () => {
  const d = depthToMeters(Uint16Array.from([0, 500, 1000, 5000]), 0.001);
  assert.deepEqual([...d], [0, 0.5, 1, 0]);
});

test('single frame: voxel projection agrees with the synthetic camera (portrait view, landscape depth buffer)', () => {
  const pose = simPose(0, 60);
  const f = simDepthFrame(pose, { noise: 0 });
  const vol = createVolume({ min: [SIM_CENTER[0] - 0.15, 0.004, SIM_CENTER[2] - 0.15], size: 0.3, res: 64 });
  const n = integrate(vol, f);
  assert.ok(n > 1000, 'updated ' + n);
  // voxels in front of the object towards the camera must be free space (+), voxels just inside the surface negative
  const m = extractMesh(vol, {});
  assert.ok(m.indices.length > 300, 'tris ' + m.indices.length / 3);
  let err = 0;
  for (let i = 0; i < m.positions.length; i += 3) err = Math.max(err, Math.abs(simSDF(m.positions[i], m.positions[i + 1], m.positions[i + 2])));
  assert.ok(err < 0.012, 'max surface error ' + err);
  return `${m.indices.length / 3} tris, max err ${(err * 1000).toFixed(1)} mm`;
});

let final;
test('full orbit fusion → closed-ish, correctly oriented mesh close to the true surface', () => {
  const vol = createVolume({ min: [SIM_CENTER[0] - 0.15, 0.004, SIM_CENTER[2] - 0.15], size: 0.3, res: 128 });
  let t0 = performance.now();
  const N = 60;
  for (let i = 0; i < N; i++) integrate(vol, simDepthFrame(simPose(i, N), { noise: 0.003, seed: i + 1 }));
  const perFrame = (performance.now() - t0) / N;
  t0 = performance.now();
  const m = extractMesh(vol, { local: true });
  const mcMs = performance.now() - t0;
  assert.ok(observedFraction(vol) > 0.3);
  // local coords: floor centre at origin → shift back to world to compare against the SDF
  let sum = 0, max = 0;
  const cnt = m.positions.length / 3;
  for (let i = 0; i < m.positions.length; i += 3) {
    const d = Math.abs(simSDF(m.positions[i] + SIM_CENTER[0], m.positions[i + 1] + 0.004, m.positions[i + 2] + SIM_CENTER[2]));
    sum += d; max = Math.max(max, d);
  }
  const mean = sum / cnt;
  assert.ok(mean < 0.003, 'mean error ' + mean);
  const w = ops.removeDuplicateFaces(ops.weld(m.positions, m.indices, 1e-7)).mesh;
  const keep = ops.removeSmallPieces(w, { mode: 'largest' }).mesh;
  const s = ops.analyze(keep);
  const va = ops.volumeArea(keep);
  assert.ok(va.volume > 0, 'outward normals (positive volume) ' + va.volume);
  // bounding box ≈ object: 11 cm wide, ~21 cm tall (minus the 4 mm clearance)
  const bb = ops.computeBBox(keep.positions);
  const wx = bb.max[0] - bb.min[0], hy = bb.max[1] - bb.min[1];
  assert.ok(Math.abs(wx - 0.11) < 0.012, 'width ' + wx);
  assert.ok(Math.abs(hy - 0.206) < 0.015, 'height ' + hy);
  // open only at the bottom (the table side): fill holes should close it
  const filled = ops.fillHoles(keep, { maxEdges: 0 }).mesh;
  const s2 = ops.analyze(filled);
  assert.ok(s2.boundaryEdges === 0, 'watertight after fill: boundary ' + s2.boundaryEdges);
  final = { tris: s.tris, perFrame, mcMs };
  return `${s.tris} tris, ${s.holes} holes before fill → watertight=${s2.watertight}, mean err ${(mean * 1000).toFixed(2)} mm, ` +
    `integrate ${perFrame.toFixed(1)} ms/frame (128³), MC ${mcMs.toFixed(0)} ms, ${(wx * 1000).toFixed(0)}×${(hy * 1000).toFixed(0)} mm`;
});

test('coarse preview (step 2) is much smaller and fast', () => {
  const vol = createVolume({ min: [SIM_CENTER[0] - 0.15, 0.004, SIM_CENTER[2] - 0.15], size: 0.3, res: 128 });
  for (let i = 0; i < 20; i++) integrate(vol, simDepthFrame(simPose(i * 3, 60), { seed: i + 7 }));
  const a = extractMesh(vol, { step: 2 }), b = extractMesh(vol, { step: 1 });
  assert.ok(a.indices.length > 0 && a.indices.length < b.indices.length / 2.5);
});

if (failed) { console.log(`${failed} FUSION TEST(S) FAILED`); process.exit(1); }
console.log('ALL FUSION TESTS PASSED');
