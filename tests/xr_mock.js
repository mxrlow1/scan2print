// Minimal WebXR mock for the scan e2e tests: an "ARCore phone" that orbits the synthetic object from js/scan-sim.js
// and returns CPU depth like Chrome (16-bit millimetres, landscape buffer + normDepthBufferFromNormView).
// Configure with window.__XRMOCK = { mode: 'full' | 'nodepth' | 'newformat' | 'unsupported' } before this runs.
(() => {
  const cfg = window.__XRMOCK || { mode: 'full' };
  const log = (window.__xrLog = { init: [], sessions: 0, depthCalls: 0, ended: 0 });
  const inv = (m) => { // rigid inverse, column-major
    const o = new Float32Array(16);
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) o[c * 4 + r] = m[r * 4 + c];
    for (let r = 0; r < 3; r++) o[12 + r] = -(o[r] * m[12] + o[4 + r] * m[13] + o[8 + r] * m[14]);
    o[15] = 1; return o;
  };
  class RT {
    constructor(m) { this.matrix = Float32Array.from(m); this.position = { x: m[12], y: m[13], z: m[14], w: 1 }; this.orientation = { x: 0, y: 0, z: 0, w: 1 }; }
    get inverse() { return new RT(inv(this.matrix)); }
  }
  window.XRRigidTransform = RT;
  delete window.XRWebGLBinding;
  window.XRWebGLLayer = class {
    constructor(session, gl) { this.framebuffer = null; this.framebufferWidth = gl.drawingBufferWidth || 400; this.framebufferHeight = gl.drawingBufferHeight || 800; this.ignoreDepthValues = true; this.antialias = false; }
    getViewport() { return { x: 0, y: 0, width: this.framebufferWidth, height: this.framebufferHeight }; }
  };
  for (const C of [window.WebGLRenderingContext, window.WebGL2RenderingContext]) if (C) C.prototype.makeXRCompatible = async function () {};

  class Session extends EventTarget {
    constructor(init, fmt, sim) {
      super();
      this.init = init; this.sim = sim; this.i = 0; this.tick = 0;
      this.enabledFeatures = [...(init.requiredFeatures || []), ...(init.optionalFeatures || [])];
      this.depthUsage = 'cpu-optimized'; this.depthDataFormat = fmt;
      this.renderState = { baseLayer: null, depthNear: 0.1, depthFar: 1000, inlineVerticalFieldOfView: null };
      this.inputSources = []; this.environmentBlendMode = 'alpha-blend'; this.visibilityState = 'visible';
      this.proj = sim.perspective(1.1, 9 / 19.5);
    }
    updateRenderState(s) { Object.assign(this.renderState, s); }
    async requestReferenceSpace(type) { return { type }; }
    async requestHitTestSource() { return { cancel() {} }; }
    requestAnimationFrame(cb) { return window.requestAnimationFrame((t) => { if (!this.ended) cb(t, this.frame()); }); }
    cancelAnimationFrame(id) { window.cancelAnimationFrame(id); }
    async end() { if (this.ended) return; this.ended = true; log.ended++; this.dispatchEvent(new Event('end')); }
    frame() {
      const s = this, sim = s.sim;
      if (++s.tick % 2 === 0) s.i++;
      const pose = sim.simPose(s.i % 90, 90);
      const view = { eye: 'none', projectionMatrix: s.proj, transform: new RT(pose), recommendedViewportScale: null };
      return {
        session: s,
        getViewerPose: () => ({ transform: new RT(pose), views: [view], emulatedPosition: false }),
        getHitTestResults: () => {
          const C = sim.SIM_CENTER, dx = pose[12] - C[0], dz = pose[14] - C[2], l = Math.hypot(dx, dz) || 1;
          const m = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, C[0] + dx / l * 0.1, 0, C[2] + dz / l * 0.1, 1];
          return [{ getPose: () => ({ transform: new RT(m) }) }];
        },
        getDepthInformation: (v) => {
          log.depthCalls++;
          const f = sim.simDepthFrame(v.transform.matrix, { seed: s.i + 1, noise: 0.003 });
          let data, k;
          if (s.depthDataFormat === 'float32') { data = f.depth.buffer; k = 1; }
          else { const u = new Uint16Array(f.depth.length); for (let i = 0; i < u.length; i++) u[i] = Math.round(f.depth[i] * 1000); data = u.buffer; k = 0.001; }
          return { width: f.width, height: f.height, data, rawValueToMeters: k, normDepthBufferFromNormView: new RT(f.normDepthFromNormView) };
        },
      };
    }
  }

  const xr = {
    async isSessionSupported(mode) { return cfg.mode !== 'unsupported' && mode === 'immersive-ar'; },
    async requestSession(mode, init) {
      log.init.push(JSON.parse(JSON.stringify({ mode, ...init, domOverlay: init.domOverlay ? { root: init.domOverlay.root?.id } : undefined })));
      if (cfg.mode === 'nodepth' && (init.requiredFeatures || []).includes('depth-sensing')) throw new DOMException('depth-sensing is not supported', 'NotSupportedError');
      const prefs = init.depthSensing?.dataFormatPreference || [];
      if (cfg.mode === 'newformat' && prefs.includes('luminance-alpha')) throw new TypeError("The provided value 'luminance-alpha' is not a valid enum value of type XRDepthDataFormat.");
      const sim = await import(new URL('js/scan-sim.js', document.baseURI).href);
      log.sessions++;
      return (window.__xrSession = new Session(init, prefs[0], sim));
    },
  };
  Object.defineProperty(navigator, 'xr', { value: xr, configurable: true });
})();
