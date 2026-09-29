// Node unit tests for js/meshops.js  (run: node tests/meshops.test.mjs)
import * as THREE from '../vendor/three/build/three.module.js';
import * as ops from '../js/meshops.js';
import assert from 'node:assert/strict';

function fromGeo(g) {
  const pos = g.attributes.position.array;
  const idx = g.index ? g.index.array : null;
  return ops.weld(new Float32Array(pos), idx ? new Uint32Array(idx) : null);
}
const t0 = performance.now();
const lap = (l) => console.log(l.padEnd(34), (performance.now() - t0).toFixed(0), 'ms');

let sphere = fromGeo(new THREE.SphereGeometry(50, 64, 48));
let a = ops.analyze(sphere);
assert.ok(a.watertight, 'sphere watertight'); assert.equal(a.shells, 1);
assert.ok(Math.abs(a.volume - 4 / 3 * Math.PI * 50 ** 3) / a.volume < 0.02, 'volume ~ sphere');
lap('sphere ok ' + a.tris);

// plane cut with cap -> closed hemisphere
let cut = ops.planeCut(sphere, { normal: [0, 1, 0], offset: 10 });
a = ops.analyze(cut.mesh);
assert.ok(a.watertight, 'cut watertight ' + JSON.stringify(a)); assert.ok(a.volume > 0);
lap('cut ok ' + JSON.stringify(cut.info));

// tilted cut
cut = ops.planeCut(sphere, { normal: [0.3, 0.8, -0.5], offset: -7 });
a = ops.analyze(cut.mesh); assert.ok(a.watertight && a.volume > 0, 'tilted cut');
// torus cut through the hole -> two loops per side with nesting (annulus cap)
const torus = fromGeo(new THREE.TorusGeometry(40, 12, 32, 96));
cut = ops.planeCut(torus, { normal: [0, 0, 1], offset: 3 });
a = ops.analyze(cut.mesh); assert.ok(a.watertight && a.volume > 0, 'torus flat cut (annulus) ' + JSON.stringify(a));
cut = ops.planeCut(torus, { normal: [1, 0, 0], offset: 0 });
a = ops.analyze(cut.mesh); assert.ok(a.watertight && a.volume > 0 && a.shells === 1, 'torus side cut');
lap('torus cuts ok');

// open mesh -> fill holes
let open = ops.planeCut(sphere, { normal: [0, -1, 0], offset: 30, cap: false }).mesh;
a = ops.analyze(open); assert.equal(a.holes, 1); assert.ok(!a.watertight);
let filled = ops.fillHoles(open);
a = ops.analyze(filled.mesh); assert.ok(a.watertight && a.volume > 0, 'filled ' + JSON.stringify(a));
lap('fill ok ' + JSON.stringify(filled.info));

// remove small pieces
const g2 = new THREE.SphereGeometry(5, 8, 6); g2.translate(100, 0, 0);
const merged = ops.weld(new Float32Array([...sphere.positions, ...fromGeo(g2).positions]),
  new Uint32Array([...sphere.indices, ...fromGeo(g2).indices.map((i) => i + sphere.positions.length / 3)]));
assert.equal(ops.analyze(merged).shells, 2);
const rs = ops.removeSmallPieces(merged, { mode: 'largest' });
assert.equal(ops.analyze(rs.mesh).shells, 1); assert.equal(rs.mesh.indices.length, sphere.indices.length);
lap('remove small ok');

// smoothing keeps closedness, shrinks little
const sm = ops.smooth(sphere, { iterations: 10 });
a = ops.analyze(sm.mesh); assert.ok(a.watertight);
lap('smooth ok vol ratio ' + (a.volume / ops.analyze(sphere).volume).toFixed(4));

// big mesh perf
const big = fromGeo(new THREE.SphereGeometry(50, 710, 355));
lap('big weld tris=' + big.indices.length / 3);
a = ops.analyze(big); lap('big analyze wt=' + a.watertight);
const bc = ops.planeCut(big, { normal: [0, 1, 0], offset: -20 }); lap('big cut wt=' + ops.analyze(bc.mesh).watertight);
ops.smooth(big, { iterations: 5 }); lap('big smooth x5');
const bo = ops.planeCut(big, { normal: [0, -1, 0], offset: 40, cap: false }).mesh;
const bf = ops.fillHoles(bo); lap('big fill wt=' + ops.analyze(bf.mesh).watertight);
console.log('ALL MESHOPS TESTS PASSED');
