// Promise wrapper around the module worker, with progress callbacks and cancellation.
export class WorkerClient {
  constructor(url) { this.url = url; this.seq = 0; this.pending = new Map(); this.spawn(); }
  spawn() {
    this.w = new Worker(this.url, { type: 'module' });
    this.w.onmessage = (ev) => {
      const m = ev.data;
      if (m.type === 'ready') return;
      const p = this.pending.get(m.id);
      if (!p) return;
      if (m.type === 'progress') { p.onProgress?.(m.p, m.label); return; }
      this.pending.delete(m.id);
      if (m.type === 'done') p.resolve(m.result); else p.reject(new Error(m.message));
    };
    this.w.onerror = (e) => {
      e.preventDefault?.();
      const err = new Error('Worker error: ' + (e.message || 'failed to start (module workers need iOS 15+ / a recent browser)'));
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
    };
  }
  run(op, args, { onProgress, transfer = [] } = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.seq;
      this.pending.set(id, { resolve, reject, onProgress });
      this.w.postMessage({ id, op, args }, transfer);
    });
  }
  cancel() {
    this.w.terminate();
    const err = new Error('Cancelled'); err.cancelled = true;
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
    this.spawn();
  }
}
