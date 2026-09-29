// Procedural "phone scan" sample: a lumpy gourd (~0.1 m tall, in metres like real scan exports),
// tilted, with an open bottom, a small side hole, surface noise and a few floating debris blobs.
// Perfect for trying every tool: units, lay flat, cut, flatten, fill holes, remove pieces, smooth, simplify.
export function makeSampleScan() {
  const pos = [], idx = [];
  let seed = 1234567;
  const rnd = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296);
  const nLat = 110, nLon = 200, thetaMax = Math.PI * 0.84;
  const R = 0.045;
  for (let i = 0; i <= nLat; i++) {
    const th = (i / nLat) * thetaMax;
    for (let j = 0; j < nLon; j++) {
      const ph = (j / nLon) * Math.PI * 2;
      const ct = Math.cos(th), st = Math.sin(th);
      let r = 1 - 0.28 * Math.exp(-((ct - 0.38) ** 2) / 0.03) + 0.18 * Math.exp(-((ct + 0.25) ** 2) / 0.25);
      r += 0.035 * Math.sin(6 * ph) * st * st + (i === 0 ? 0 : (rnd() - 0.5) * 0.012);
      const x = r * st * Math.cos(ph), y = ct * 1.25 + (ct > 0.8 ? 0.08 * (ct - 0.8) / 0.2 : 0), z = r * st * Math.sin(ph);
      pos.push(x * R, y * R, z * R);
    }
  }
  const hole = (i, j) => Math.hypot(i - 48, (j - 30) * 0.9) < 5; // small side hole
  for (let i = 0; i < nLat; i++) {
    for (let j = 0; j < nLon; j++) {
      if (hole(i, j)) continue;
      const a = i * nLon + j, b = i * nLon + ((j + 1) % nLon), c = (i + 1) * nLon + j, d = (i + 1) * nLon + ((j + 1) % nLon);
      idx.push(a, b, c, b, d, c);
    }
  }
  // debris blobs (little octahedra-ish lumps) floating near the base, as scan apps often leave behind
  const blob = (cx, cy, cz, s) => {
    const base = pos.length / 3;
    const v = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
    for (const [x, y, z] of v) pos.push(cx + x * s * (0.8 + rnd() * 0.4), cy + y * s, cz + z * s * (0.8 + rnd() * 0.4));
    const f = [[0, 2, 4], [4, 2, 1], [1, 2, 5], [5, 2, 0], [4, 3, 0], [1, 3, 4], [5, 3, 1], [0, 3, 5]];
    for (const [a, b, c] of f) idx.push(base + a, base + b, base + c);
  };
  blob(0.07, -0.05, 0.01, 0.004); blob(-0.06, -0.055, 0.03, 0.003); blob(0.01, -0.06, -0.07, 0.005);
  // tilt the whole thing like a sloppy scan
  const ax = 0.2, az = -0.15;
  const cx = Math.cos(ax), sx = Math.sin(ax), cz = Math.cos(az), sz = Math.sin(az);
  const P = new Float32Array(pos.length);
  for (let i = 0; i < pos.length; i += 3) {
    let x = pos[i], y = pos[i + 1], z = pos[i + 2];
    const y1 = y * cx - z * sx, z1 = y * sx + z * cx; y = y1; z = z1;
    const x2 = x * cz - y * sz, y2 = x * sz + y * cz; x = x2; y = y2;
    P[i] = x + 0.3; P[i + 1] = y + 0.1; P[i + 2] = z - 0.2;
  }
  return { positions: P, indices: new Uint32Array(idx) };
}
