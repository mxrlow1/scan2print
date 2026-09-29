// Exporters. Internal space is three.js Y-up in millimetres; STL and 3MF are written Z-up
// (print convention: X right, Y back, Z up) via the proper rotation (x, y, z) -> (x, -z, y).
import { zipSync, strToU8 } from '../vendor/three/addons/libs/fflate.module.js';

const toZUp = (P, i) => [P[i], -P[i + 2], P[i + 1]];

export function exportSTL(mesh, name = 'Scan2Print') {
  const P = mesh.positions, I = mesh.indices, nt = I.length / 3;
  const buf = new ArrayBuffer(84 + nt * 50);
  const dv = new DataView(buf);
  const header = `Scan2Print binary STL - ${name}`.slice(0, 80);
  for (let i = 0; i < header.length; i++) dv.setUint8(i, header.charCodeAt(i) & 0x7f);
  dv.setUint32(80, nt, true);
  let o = 84;
  for (let t = 0; t < nt; t++) {
    const a = toZUp(P, I[t * 3] * 3), b = toZUp(P, I[t * 3 + 1] * 3), c = toZUp(P, I[t * 3 + 2] * 3);
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
    dv.setFloat32(o, nx, true); dv.setFloat32(o + 4, ny, true); dv.setFloat32(o + 8, nz, true);
    dv.setFloat32(o + 12, a[0], true); dv.setFloat32(o + 16, a[1], true); dv.setFloat32(o + 20, a[2], true);
    dv.setFloat32(o + 24, b[0], true); dv.setFloat32(o + 28, b[1], true); dv.setFloat32(o + 32, b[2], true);
    dv.setFloat32(o + 36, c[0], true); dv.setFloat32(o + 40, c[1], true); dv.setFloat32(o + 44, c[2], true);
    dv.setUint16(o + 48, 0, true);
    o += 50;
  }
  return new Uint8Array(buf);
}

const f = (x) => { const s = (Math.round(x * 1e4) / 1e4).toString(); return s === '-0' ? '0' : s; };

export function exportOBJ(mesh, name = 'Scan2Print') {
  // OBJ stays Y-up (the common convention for OBJ viewers/slicers import it as-is, units mm).
  const P = mesh.positions, I = mesh.indices;
  const parts = [`# Scan2Print OBJ export (units: mm, Y-up)\n# vertices ${P.length / 3} triangles ${I.length / 3}\no ${name.replace(/\s+/g, '_')}\n`];
  let chunk = [];
  for (let i = 0; i < P.length; i += 3) {
    chunk.push(`v ${f(P[i])} ${f(P[i + 1])} ${f(P[i + 2])}`);
    if (chunk.length >= 20000) { parts.push(chunk.join('\n') + '\n'); chunk = []; }
  }
  for (let t = 0; t < I.length; t += 3) {
    chunk.push(`f ${I[t] + 1} ${I[t + 1] + 1} ${I[t + 2] + 1}`);
    if (chunk.length >= 20000) { parts.push(chunk.join('\n') + '\n'); chunk = []; }
  }
  if (chunk.length) parts.push(chunk.join('\n') + '\n');
  return new TextEncoder().encode(parts.join(''));
}

export function export3MF(mesh, name = 'Scan2Print') {
  const P = mesh.positions, I = mesh.indices;
  const esc = (s) => s.replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
  const parts = ['<?xml version="1.0" encoding="UTF-8"?>\n<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">\n',
    ` <metadata name="Title">${esc(name)}</metadata>\n <metadata name="Application">Scan2Print</metadata>\n`,
    ` <resources>\n  <object id="1" type="model" name="${esc(name)}">\n   <mesh>\n    <vertices>\n`];
  let chunk = [];
  const flush = () => { parts.push(chunk.join('')); chunk = []; };
  for (let i = 0; i < P.length; i += 3) {
    chunk.push(`     <vertex x="${f(P[i])}" y="${f(-P[i + 2])}" z="${f(P[i + 1])}"/>\n`);
    if (chunk.length > 20000) flush();
  }
  chunk.push('    </vertices>\n    <triangles>\n');
  for (let t = 0; t < I.length; t += 3) {
    chunk.push(`     <triangle v1="${I[t]}" v2="${I[t + 1]}" v3="${I[t + 2]}"/>\n`);
    if (chunk.length > 20000) flush();
  }
  chunk.push('    </triangles>\n   </mesh>\n  </object>\n </resources>\n <build>\n  <item objectid="1"/>\n </build>\n</model>\n');
  flush();
  const model = new TextEncoder().encode(parts.join(''));
  const types = '<?xml version="1.0" encoding="UTF-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>\n';
  const rels = '<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>\n';
  return zipSync({
    '[Content_Types].xml': strToU8(types),
    '_rels/.rels': strToU8(rels),
    '3D/3dmodel.model': [model, { level: 6 }],
  }, { level: 6 });
}
