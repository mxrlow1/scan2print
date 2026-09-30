// Live 3D scanning with WebXR depth sensing (Android Chrome + ARCore Depth API), with a hand-off to scanner apps elsewhere.
// Depth frames are fused into a TSDF volume in js/fusion-worker.js; marching cubes gives a live preview mesh and the final mesh.
import * as THREE from '../vendor/three/build/three.module.js';
import { depthToMeters, createVolume, extractMesh } from './fusion.js';

const $ = (s) => document.querySelector(s);

// Verified store / project links (checked 2026-09-29).
export const LINKS = {
  scaniverseIOS: 'https://apps.apple.com/us/app/scaniverse-3d-scanner/id1541433223',
  polycamIOS: 'https://apps.apple.com/us/app/polycam-3d-scanner-measuring/id1532482376',
  scaniverseAndroid: 'https://play.google.com/store/apps/details?id=com.nianticlabs.scaniverse',
  polycamAndroid: 'https://play.google.com/store/apps/details?id=ai.polycam',
  nativeScanner: 'https://github.com/mxrlow1/scan2print/blob/main/ios/README.md',
};

export const PLATFORM = (() => {
  const ua = navigator.userAgent || '';
  if (/iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)) return 'ios';
  if (/Android/i.test(ua)) return 'android';
  return 'desktop';
})();

const SIM = new URLSearchParams(location.search).has('scansim');
const FUSE_INTERVAL = 160;   // ms between fused depth frames (the worker drops nothing: one frame in flight)
const PREVIEW_INTERVAL = 1400;
const CLEARANCE = 0.004;     // box floor sits 4 mm above the surface so the table itself is not scanned
const RES = 128;

/** Resolves to { ar: boolean, reason: string } */
export async function checkSupport() {
  if (!navigator.xr) {
    return { ar: false, reason: PLATFORM === 'ios'
      ? 'Safari on iPhone and iPad has no WebXR, so live depth scanning can’t run in the browser there.'
      : PLATFORM === 'android' ? 'This browser has no WebXR. Open Scan2Print in Chrome for live depth scanning.'
        : 'Live depth scanning runs in Chrome on Android phones with ARCore depth support.' };
  }
  let ar = false;
  try { ar = await navigator.xr.isSessionSupported('immersive-ar'); } catch { ar = false; }
  if (!ar) {
    return { ar: false, reason: PLATFORM === 'android'
      ? 'This phone or browser can’t start WebXR AR. It needs Chrome and “Google Play Services for AR”.'
      : 'Live depth scanning runs in Chrome on Android phones with ARCore depth support.' };
  }
  return { ar: true, reason: '' };
}

export function reasonFromError(e) {
  const n = e?.name || '';
  if (n === 'NotSupportedError') return 'This phone supports AR but not the depth sensing this scanner needs (ARCore Depth API), or the browser is too old.';
  if (n === 'SecurityError' || n === 'NotAllowedError') return 'The browser blocked the AR session (camera permission denied or the page isn’t served over HTTPS).';
  return 'The AR scan could not start: ' + (e?.message || String(e));
}

class ScanController {
  constructor({ onResult, toast }) {
    this.onResult = onResult; this.toast = toast;
    this.phase = 'idle';
    this.size = 0.5;
    this.support = checkSupport();
    this.stats = { frames: 0, tris: 0, fuseMs: 0, coverage: 0 };
    this.bins = new Set();
    this.wireUI();
  }

  // ------------------------------------------------------------------ UI
  wireUI() {
    for (const id of ['#btn-scan-empty', '#btn-scan']) { const b = $(id); if (b) b.onclick = () => this.start(); }
    $('#xr-close').onclick = () => this.stop();
    $('#xr-place-btn').onclick = () => this.place();
    $('#xr-pause').onclick = () => { this.paused = !this.paused; this.updateUI(); };
    $('#xr-move').onclick = () => this.setPhase('place');
    $('#xr-reset').onclick = () => this.resetVolume();
    $('#xr-finish').onclick = () => this.finish();
    $('#seg-xr-size').addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) return;
      this.size = +b.dataset.v;
      $('#seg-xr-size').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
      this.updateUI();
    });
    // taps on the DOM overlay must not also count as XR "select" input
    $('#xr-overlay').addEventListener('beforexrselect', (e) => e.preventDefault());
    $('#scan-help-close').onclick = () => this.closeHandoff();
    $('#scan-help-open').addEventListener('click', () => this.closeHandoff());
    this.support.then((s) => {
      const sub = s.ar ? 'Live depth scan with your camera' : PLATFORM === 'ios' ? 'iPhone / iPad: scan with an app, then open it here' : 'How to scan with your phone';
      document.querySelectorAll('.scan-sub').forEach((el) => (el.textContent = SIM ? 'Simulated depth scan (demo)' : sub));
      document.documentElement.dataset.scan = s.ar ? 'ar' : 'handoff';
    });
  }

  showHandoff(reason) {
    const d = $('#scan-help');
    $('#scan-reason').textContent = reason || '';
    $('#scan-reason').classList.toggle('hidden', !reason);
    // put the section for this platform first
    const ios = $('#scan-ios'), android = $('#scan-android');
    if (PLATFORM === 'android') ios.before(android); else android.before(ios);
    d.dataset.platform = PLATFORM;
    if (d.showModal) { if (!d.open) d.showModal(); } else d.setAttribute('open', '');
  }
  closeHandoff() { const d = $('#scan-help'); d.close ? d.close() : d.removeAttribute('open'); }

  setStatus(title, sub = '') { $('#xr-title').textContent = title; $('#xr-sub').textContent = sub; }

  updateUI() {
    const p = this.phase;
    $('#xr-place').classList.toggle('hidden', p !== 'place');
    $('#xr-scan').classList.toggle('hidden', p !== 'scan' && p !== 'finishing');
    $('#xr-pause').textContent = this.paused ? 'Resume' : 'Pause';
    $('#xr-finish').disabled = p === 'finishing' || !this.stats.tris;
    $('#xr-finish').textContent = p === 'finishing' ? 'Building mesh…' : 'Finish & edit';
    $('#xr-place-btn').disabled = !this.candidate;
    $('#xr-cover').style.width = Math.round(this.stats.coverage * 100) + '%';
    $('#xr-cover-label').textContent = `Coverage ${Math.round(this.stats.coverage * 100)}% · ${this.stats.frames} frames · ${fmtK(this.stats.tris)} ▲`;
    if (p === 'place') {
      this.setStatus('Place the scan box', this.candidate
        ? `Box ${Math.round(this.size * 100)} cm. Aim the ring at the table just in front of your object, then tap Place.`
        : this.surfaceHint || 'Move the phone slowly so it can find the table or floor…');
    } else if (p === 'scan') {
      this.setStatus(this.paused ? 'Paused' : this.tracking === false ? 'Tracking lost: move slowly' : 'Scanning…',
        this.stats.coverage < 0.5 ? 'Walk slowly all the way around the object, 30–60 cm away.'
          : this.stats.coverage < 0.8 ? 'Good. Now cover it from higher up and lower down.' : 'Great coverage. Tap Finish when the preview looks complete.');
    }
  }

  // ------------------------------------------------------------------ session
  async start() {
    if (this.phase !== 'idle') return;
    if (SIM) return this.startSim();
    const s = await this.support;
    if (!s.ar) return this.showHandoff(s.reason);
    try {
      await this.startAR();
    } catch (e) {
      console.warn('AR scan failed', e);
      await this.cleanup();
      this.showHandoff(reasonFromError(e));
    }
  }

  async startAR() {
    const overlay = $('#xr-overlay');
    overlay.classList.remove('hidden');
    document.body.classList.add('xr-active');
    const base = { requiredFeatures: ['depth-sensing', 'hit-test', 'dom-overlay'], optionalFeatures: ['local-floor'], domOverlay: { root: overlay } };
    let session = null, lastErr = null;
    // 'luminance-alpha' (older Chrome) / 'unsigned-short' (newer name) are both 16-bit; float32 is the fallback
    for (const formats of [['luminance-alpha', 'float32'], ['unsigned-short', 'float32'], ['float32']]) {
      try {
        session = await navigator.xr.requestSession('immersive-ar', { ...base, depthSensing: { usagePreference: ['cpu-optimized'], dataFormatPreference: formats } });
        break;
      } catch (e) { lastErr = e; if (e.name !== 'TypeError') break; }
    }
    if (!session) throw lastErr || new Error('Could not start AR');
    this.session = session;
    if (session.depthUsage && session.depthUsage !== 'cpu-optimized') {
      const err = new Error('Only GPU depth is available on this device.'); err.name = 'NotSupportedError'; throw err;
    }
    this.depthFormat = session.depthDataFormat || 'luminance-alpha';
    session.addEventListener('end', () => this.cleanup());
    const r = this.ensureRenderer();
    r.xr.enabled = true;
    r.xr.setReferenceSpaceType('local');
    await r.xr.setSession(session);
    this.refSpace = r.xr.getReferenceSpace();
    this.viewerSpace = await session.requestReferenceSpace('viewer');
    this.hitSource = await session.requestHitTestSource({ space: this.viewerSpace });
    this.startWorker();
    this.setPhase('place');
    r.setAnimationLoop((t, frame) => this.onXRFrame(t, frame));
  }

  ensureRenderer() {
    if (this.renderer) return this.renderer;
    const canvas = document.createElement('canvas');
    canvas.id = 'xr-canvas'; canvas.className = 'xr-canvas hidden';
    document.body.appendChild(canvas);
    const r = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    r.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer = r;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(60, 1, 0.02, 30);
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 2.2));
    const reticle = new THREE.Mesh(new THREE.RingGeometry(0.045, 0.06, 40).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x3dd6b5 }));
    reticle.matrixAutoUpdate = false; reticle.visible = false; this.scene.add(reticle); this.reticle = reticle;
    const box = new THREE.Group();
    box.add(new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)), new THREE.LineBasicMaterial({ color: 0x3dd6b5 })));
    box.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ color: 0x3dd6b5, transparent: true, opacity: 0.08, depthWrite: false })));
    box.visible = false; this.scene.add(box); this.boxMesh = box;
    this.live = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshNormalMaterial({ transparent: true, opacity: 0.85, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
    this.live.frustumCulled = false; this.scene.add(this.live);
    return r;
  }

  startWorker() {
    if (this.worker) return;
    this.worker = new Worker(new URL('./fusion-worker.js', import.meta.url), { type: 'module' });
    this.worker.onmessage = (ev) => this.onWorker(ev.data);
    this.worker.onerror = (e) => { e.preventDefault?.(); this.toast('Scan worker failed: ' + (e.message || 'error'), true); this.stop(); };
  }

  setPhase(p) {
    this.phase = p;
    if (p === 'place') { this.boxMin = null; this.candidate = null; this.live.geometry.dispose(); this.live.geometry = new THREE.BufferGeometry(); this.resetStats(); }
    if (p === 'scan') { this.paused = false; this.lastFuse = 0; this.lastPreview = 0; }
    this.updateUI();
  }
  resetStats() { this.stats = { frames: 0, tris: 0, fuseMs: 0, coverage: 0 }; this.bins = new Set(); this.objCenter = null; this.frameBusy = false; this.meshBusy = false; }

  place() {
    if (!this.candidate) return;
    const { min, size } = this.candidate;
    this.boxMin = min; this.boxSize = size;
    this.worker.postMessage({ type: 'init', box: { min, size, res: RES } });
    this.resetStats();
    this.setPhase('scan');
  }

  resetVolume() {
    if (!this.boxMin) return;
    this.worker.postMessage({ type: 'reset' });
    this.resetStats();
    this.live.geometry.dispose(); this.live.geometry = new THREE.BufferGeometry();
    this.updateUI();
  }

  /** Candidate box from a surface hit: centred a bit beyond the aimed point, floor just above the surface. */
  updateCandidate(hit, camPos) {
    const fwd = new THREE.Vector3(hit.x - camPos.x, 0, hit.z - camPos.z);
    if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, -1);
    fwd.normalize();
    const s = this.size, c = hit.clone().addScaledVector(fwd, s / 2 - 0.02);
    this.candidate = { min: [c.x - s / 2, hit.y + CLEARANCE, c.z - s / 2], size: s };
    this.showBox(this.candidate.min, s, true);
  }
  showBox(min, s, ghost) {
    this.boxMesh.visible = true;
    this.boxMesh.scale.set(s, s, s);
    this.boxMesh.position.set(min[0] + s / 2, min[1] + s / 2, min[2] + s / 2);
    this.boxMesh.children[0].material.opacity = ghost ? 0.6 : 1;
    this.boxMesh.children[0].material.transparent = ghost;
  }

  onXRFrame(t, frame) {
    if (!frame || !this.session) return;
    const pose = frame.getViewerPose(this.refSpace);
    if (pose) {
      const cp = pose.transform.position, camPos = new THREE.Vector3(cp.x, cp.y, cp.z);
      this.tracking = !pose.emulatedPosition;
      if (this.phase === 'place') {
        const hits = this.hitSource ? frame.getHitTestResults(this.hitSource) : [];
        const hp = hits.length ? hits[0].getPose(this.refSpace) : null;
        if (hp) {
          const m = hp.transform.matrix;
          this.reticle.visible = true; this.reticle.matrix.fromArray(m);
          const flat = m[5] > 0.85; // hit pose Y axis = surface normal
          this.surfaceHint = flat ? '' : 'Aim at a flat, horizontal surface (table or floor).';
          if (flat) this.updateCandidate(new THREE.Vector3(m[12], m[13], m[14]), camPos); else { this.candidate = null; this.boxMesh.visible = false; }
        } else { this.reticle.visible = false; this.candidate = null; this.boxMesh.visible = false; }
        this.throttledUI(t);
      } else if (this.phase === 'scan') {
        this.reticle.visible = false;
        this.showBox(this.boxMin, this.boxSize, false);
        if (!this.paused && this.tracking && !this.frameBusy && t - this.lastFuse > FUSE_INTERVAL) {
          const view = pose.views[0];
          const di = frame.getDepthInformation(view);
          if (di && di.width && di.data) {
            this.lastFuse = t;
            const raw = this.depthFormat === 'float32' ? new Float32Array(di.data) : new Uint16Array(di.data);
            const maxDepth = Math.min(4, camPos.distanceTo(this.boxCenter()) + this.boxSize);
            const depth = depthToMeters(raw, di.rawValueToMeters, 0.1, maxDepth);
            this.fuse({ width: di.width, height: di.height, depth, maxDepth,
              proj: Float32Array.from(view.projectionMatrix), view: Float32Array.from(view.transform.inverse.matrix),
              normDepthFromNormView: Float32Array.from(di.normDepthBufferFromNormView.matrix) }, camPos);
          }
        }
        this.maybePreview(t);
        this.throttledUI(t);
      }
    }
    this.renderer.render(this.scene, this.camera);
  }

  boxCenter() { const s = this.boxSize; return new THREE.Vector3(this.boxMin[0] + s / 2, this.boxMin[1] + s / 2, this.boxMin[2] + s / 2); }

  /** Send one depth frame to the worker and record which viewing direction it covers. */
  fuse(frame, camPos) {
    this.frameBusy = true;
    this.worker.postMessage({ type: 'frame', frame }, [frame.depth.buffer]);
    // measure viewing directions around the object itself (centre of the live mesh), not the box
    const c = this.objCenter || new THREE.Vector3(this.boxMin[0] + this.boxSize / 2, this.boxMin[1] + Math.min(this.boxSize / 2, 0.1), this.boxMin[2] + this.boxSize / 2);
    const d = camPos.clone().sub(c);
    const az = Math.floor(((Math.atan2(d.x, d.z) / (2 * Math.PI)) + 1) * 12) % 12;
    const el = Math.atan2(d.y, Math.hypot(d.x, d.z));
    this.bins.add((el > 0.61 ? 12 : 0) + az);  // 12 low + 12 high (above ~35°) directions
    this.stats.coverage = this.bins.size / 24;
  }

  maybePreview(t) {
    if (this.meshBusy || t - this.lastPreview < PREVIEW_INTERVAL || !this.stats.frames) return;
    this.lastPreview = t; this.meshBusy = true;
    this.worker.postMessage({ type: 'mesh', step: 2 });
  }

  throttledUI(t) { if (!this._ui || t - this._ui > 250) { this._ui = t; this.updateUI(); } }

  onWorker(m) {
    if (m.type === 'integrated') { this.frameBusy = false; this.stats.frames = m.frames; this.stats.fuseMs = m.ms; }
    else if (m.type === 'mesh') {
      if (m.info.final) return this.deliver(m.mesh, m.info);
      this.meshBusy = false;
      if (this.phase !== 'scan') return;
      this.stats.tris = m.info.tris;
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(m.mesh.positions, 3));
      g.setIndex(new THREE.BufferAttribute(m.mesh.indices, 1));
      g.computeVertexNormals();
      g.computeBoundingBox();
      if (m.info.tris) this.objCenter = g.boundingBox.getCenter(new THREE.Vector3());
      this.live.geometry.dispose(); this.live.geometry = g;
      this.updateUI();
    } else if (m.type === 'error') { this.toast('Scan error: ' + m.message, true); this.frameBusy = false; this.meshBusy = false; if (this.phase === 'finishing') this.setPhase('scan'); }
  }

  finish() {
    if (this.phase !== 'scan' || !this.stats.tris) return;
    this.phase = 'finishing'; this.updateUI();
    this.setStatus('Building mesh…', 'Full-resolution marching cubes');
    this.worker.postMessage({ type: 'mesh', step: 1, local: true, final: true });
  }

  async deliver(mesh, info) {
    if (!mesh.indices.length) { this.toast('Nothing was captured inside the box. Try again closer to the object.', true); this.setPhase('scan'); return; }
    const cleanup = $('#chk-xr-clean').checked;
    const extra = { cleanup, info: { ...info, frames: this.stats.frames, coverage: this.stats.coverage, box: this.boxSize, simulated: !!this.sim } };
    await this.stop();
    this.onResult(mesh, extra);
  }

  async stop() {
    if (this.session) { const s = this.session; try { await s.end(); } catch { /* already ended */ } }
    await this.cleanup();
  }

  async cleanup() {
    this.renderer?.setAnimationLoop(null);
    try { this.hitSource?.cancel(); } catch { /* ignore */ }
    this.hitSource = null; this.session = null; this.sim = null;
    if (this.renderer) { this.renderer.xr.enabled = false; $('#xr-canvas')?.classList.add('hidden'); }
    if (this.worker) { this.worker.terminate(); this.worker = null; }
    if (this.live) { this.live.geometry.dispose(); this.live.geometry = new THREE.BufferGeometry(); }
    if (this.boxMesh) this.boxMesh.visible = false;
    if (this.simGroup) { this.scene.remove(this.simGroup); this.simGroup = null; }
    if (this.scene) this.scene.background = null;
    if (this.camera) this.camera.matrixAutoUpdate = true;
    this.frameBusy = false; this.meshBusy = false;
    $('#xr-overlay').classList.add('hidden');
    document.body.classList.remove('xr-active');
    this.phase = 'idle';
  }

  // ------------------------------------------------------------------ simulator (?scansim=1): same worker/UI path, synthetic depth camera
  async startSim() {
    const sim = await import('./scan-sim.js');
    const r = this.ensureRenderer();
    r.xr.enabled = false;
    $('#xr-canvas').classList.remove('hidden');
    $('#xr-overlay').classList.remove('hidden');
    document.body.classList.add('xr-active');
    this.sim = { mod: sim, i: 0, n: 90, t0: performance.now() };
    // stand-in for the camera image: the table plus a grey version of the synthetic object
    const g = new THREE.Group();
    const table = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 1.2).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x6b5a48, roughness: 0.9 }));
    table.position.set(sim.SIM_CENTER[0], -0.001, sim.SIM_CENTER[2]);
    g.add(table);
    const vol = createVolume({ min: [sim.SIM_CENTER[0] - 0.1, 0.0005, sim.SIM_CENTER[2] - 0.1], size: 0.22, res: 64 });
    for (let k = 0; k < 64; k++) for (let j = 0; j < 64; j++) for (let i = 0; i < 64; i++) {
      const x = vol.min[0] + (i + 0.5) * vol.voxel, y = vol.min[1] + (j + 0.5) * vol.voxel, z = vol.min[2] + (k + 0.5) * vol.voxel;
      const id = i + (j + k * 64) * 64;
      vol.tsdf[id] = Math.max(-1, Math.min(1, sim.simSDF(x, y, z) === y ? 1 : sim.simSDF(x, y, z) / vol.trunc)); vol.weight[id] = 1;
    }
    const truth = extractMesh(vol);
    const tg = new THREE.BufferGeometry();
    tg.setAttribute('position', new THREE.BufferAttribute(truth.positions, 3)); tg.setIndex(new THREE.BufferAttribute(truth.indices, 1)); tg.computeVertexNormals();
    g.add(new THREE.Mesh(tg, new THREE.MeshStandardMaterial({ color: 0x9aa0a8, roughness: 0.7 })));
    this.scene.add(g); this.simGroup = g;
    this.scene.background = new THREE.Color(0x1b1e24);
    this.startWorker();
    this.setPhase('place');
    const resize = () => { const w = innerWidth, h = innerHeight; r.setSize(w, h, false); this.camera.aspect = w / h; this.camera.updateProjectionMatrix(); };
    resize();
    this.camera.fov = 63; this.camera.updateProjectionMatrix();
    r.setAnimationLoop((t) => this.onSimFrame(t));
  }

  onSimFrame(t) {
    const S = this.sim; if (!S) return;
    const { mod } = S;
    const pose = mod.simPose(S.i % S.n, S.n);
    this.camera.matrixAutoUpdate = false;
    this.camera.matrix.fromArray(pose); this.camera.matrixWorld.copy(this.camera.matrix); this.camera.matrixWorldInverse.copy(this.camera.matrix).invert();
    const camPos = new THREE.Vector3(pose[12], pose[13], pose[14]);
    this.tracking = true;
    if (this.phase === 'place') {
      // "aim" at the table just in front of the object
      const toCam = new THREE.Vector3(camPos.x - mod.SIM_CENTER[0], 0, camPos.z - mod.SIM_CENTER[2]).normalize();
      const hit = new THREE.Vector3(mod.SIM_CENTER[0], 0, mod.SIM_CENTER[2]).addScaledVector(toCam, this.size / 2 - 0.02);
      this.reticle.visible = true; this.reticle.matrix.makeTranslation(hit.x, 0.001, hit.z);
      this.updateCandidate(hit, camPos);
      this.throttledUI(t);
    } else if (this.phase === 'scan') {
      this.reticle.visible = false;
      this.showBox(this.boxMin, this.boxSize, false);
      if (!this.paused && !this.frameBusy && t - this.lastFuse > FUSE_INTERVAL) {
        this.lastFuse = t; S.i++;
        const f = mod.simDepthFrame(pose, { seed: S.i, noise: 0.003 });
        this.fuse(f, camPos);
      }
      this.maybePreview(t);
      this.throttledUI(t);
    }
    this.renderer.render(this.scene, this.camera);
  }
}

const fmtK = (n) => (n >= 1e4 ? (n / 1e3).toFixed(0) + 'k' : String(n));

export function initScan(opts) { return new ScanController(opts); }
