// Scan fusion worker: owns the TSDF volume, fuses depth frames and extracts meshes (live preview + final).
import { createVolume, resetVolume, integrate, extractMesh, observedFraction } from './fusion.js';

let vol = null;
self.onmessage = (ev) => {
  const m = ev.data;
  try {
    if (m.type === 'init') {
      vol = createVolume(m.box);
      self.postMessage({ type: 'ready', id: m.id, voxel: vol.voxel, trunc: vol.trunc });
    } else if (m.type === 'reset') {
      if (vol) resetVolume(vol);
      self.postMessage({ type: 'ready', id: m.id });
    } else if (m.type === 'frame') {
      const t = performance.now();
      const n = vol ? integrate(vol, m.frame) : 0;
      self.postMessage({ type: 'integrated', id: m.id, updated: n, frames: vol ? vol.frames : 0, ms: performance.now() - t });
    } else if (m.type === 'mesh') {
      if (!vol) throw new Error('No scan volume');
      const t = performance.now();
      const mesh = extractMesh(vol, { step: m.step || 1, local: !!m.local });
      const info = { tris: mesh.indices.length / 3, frames: vol.frames, observed: observedFraction(vol), ms: performance.now() - t, final: !!m.final };
      self.postMessage({ type: 'mesh', id: m.id, mesh, info }, [mesh.positions.buffer, mesh.indices.buffer]);
    }
  } catch (e) {
    self.postMessage({ type: 'error', id: m.id, message: e?.message || String(e) });
  }
};
