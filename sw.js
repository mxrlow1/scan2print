// Scan2Print service worker: offline app shell + Web Share Target (Android installed PWA).
const VERSION = 'scan2print-v1.0.0';
const CORE = [
  './', 'index.html', 'manifest.webmanifest', 'css/app.css',
  'js/app.js', 'js/meshops.js', 'js/worker.js', 'js/worker-client.js', 'js/exporters.js', 'js/sample.js',
  'vendor/three/build/three.module.js', 'vendor/three/build/three.core.js',
  'vendor/three/addons/controls/OrbitControls.js',
  'vendor/three/addons/loaders/STLLoader.js', 'vendor/three/addons/loaders/PLYLoader.js', 'vendor/three/addons/loaders/OBJLoader.js',
  'vendor/three/addons/loaders/GLTFLoader.js', 'vendor/three/addons/loaders/DRACOLoader.js',
  'vendor/three/addons/utils/BufferGeometryUtils.js', 'vendor/three/addons/utils/SkeletonUtils.js',
  'vendor/three/addons/libs/fflate.module.js', 'vendor/three/addons/libs/meshopt_simplifier.module.js',
  'vendor/three/addons/libs/meshopt_decoder.module.js',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(CORE)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION && k !== 'scan2print-share').map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method === 'POST' && url.pathname.endsWith('/share-target')) {
    e.respondWith((async () => {
      const form = await e.request.formData();
      const cache = await caches.open('scan2print-share');
      for (const k of await cache.keys()) await cache.delete(k);
      let i = 0;
      for (const f of form.getAll('file')) {
        if (!(f instanceof File)) continue;
        await cache.put(new Request(`shared-file-${i++}`), new Response(f, { headers: { 'x-filename': encodeURIComponent(f.name || 'shared') } }));
      }
      return Response.redirect(new URL('./?shared=1', self.registration.scope).href, 303);
    })());
    return;
  }
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  // cache-first, falling back to network (and storing successful responses, e.g. the Draco decoder)
  e.respondWith((async () => {
    const cache = await caches.open(VERSION);
    const hit = await cache.match(e.request, { ignoreSearch: true });
    if (hit) return hit;
    try {
      const res = await fetch(e.request);
      if (res.ok && res.type === 'basic') cache.put(e.request, res.clone());
      return res;
    } catch (err) {
      if (e.request.mode === 'navigate') return (await cache.match('index.html')) || Response.error();
      throw err;
    }
  })());
});
