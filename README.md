# Scan2Print

Mobile-first, installable PWA for cleaning up phone 3D scans (Scaniverse, Polycam, KIRI, RealityScan…) and exporting print-ready files.
Static files only, no build step, runs 100 % on-device (nothing is uploaded). Works offline once it has loaded.

**Live:** https://mxrlow1.github.io/scan2print/

## Features
- **Scan (new in 1.1):** a big **Scan** button on the start screen.
  - **Android (Chrome + ARCore Depth API):** a live scan runs right in the browser through WebXR `depth-sensing` (CPU depth), `hit-test` and `dom-overlay`. Aim at the table in front of the object and place a 25 cm, 50 cm or 1 m scan box. Then walk around the object: depth frames are fused into a 128³ TSDF volume in a Web Worker, and a live marching-cubes preview mesh shows up in AR along with a coverage meter. **Finish & edit** builds the full-resolution mesh (metres to mm, dropped on the plate). By default it also keeps the largest piece and fills holes, so the result is usually watertight straight away. Every step can be undone.
  - **Graceful fallback:** iPhone/iPad (Safari has no WebXR), desktop, and Android phones without WebXR AR or depth get a hand-off sheet instead. It explains why live scanning isn't available, links to Scaniverse and Polycam (App Store / Google Play), gives export → import steps, and points to the native [Scan2Print Scanner](ios/README.md) LiDAR app.
  - `?scansim=1` runs the same pipeline against a synthetic depth camera, for demos and tests.
- **Import:** OBJ, GLB, GLTF (+ .bin, pick all the files), PLY (mesh), STL, or a `.zip` holding one of these. Also drag & drop, the Android "Share to" target (installed PWA), and a built-in sample scan.
  Units are auto-detected (GLB/GLTF and tiny models are read as metres, everything else as mm) and you can change them. Textures are dropped on purpose because printing only needs geometry, and that saves a lot of memory on phones.
- **Viewer:** one finger orbits, a pinch zooms, two fingers pan, a double-tap resets the view. Shows the build-plate grid (180/220/256/350 mm), the bounding box and a live size readout in mm. There is a wireframe toggle, and faces seen from the inside are tinted red so holes and flipped faces stand out. Models are auto-centred and dropped onto the plate.
- **Edit:** uniform scale, exact size in mm on any axis (proportional by default, non-uniform optional), ±90° rotations, free rotate with live preview, **lay flat** (tap the face that should touch the bed), mirror X/Y/Z, and undo/redo (20 steps).
- **Cut:** horizontal, front or side plane. Move it with a slider or ±0.1/1 mm nudges, tilt it on two axes and flip which side you keep. The live preview clips the model and shows the removed part as a red ghost. The cut face is **capped**, including faces with holes in them, so a closed mesh stays closed. **Flatten bottom** slices off N mm at the lowest point.
- **Repair:** remove floating pieces (keep the largest, or drop pieces under X % of it), fill holes (triangulated boundary loops, with a size limit and pinched-loop handling), fix non-manifold edges and duplicate faces, Taubin/Laplacian smoothing (open edges can stay fixed), and simplify/decimate with meshoptimizer (WASM). The mesh health panel shows pieces, holes, open and non-manifold edges, volume and whether the mesh is watertight.
- **Export:** binary **STL** (mm, Z-up), **3MF** (mm, Z-up, zipped) and **OBJ**. Where the browser can share files (iOS Safari) you get **Share / Save to Files** through the Web Share API, and a normal download always works as a fallback.
- **Performance:** parsing, welding and every heavy operation run in a module Web Worker with a progress bar and Cancel button. Scans of about 500k triangles work (see the test numbers below).

## Native iPad/iPhone LiDAR scanner (optional)

[`ios/`](ios/) contains **Scan2Print Scanner**, a native LiDAR scanning app that crops the object, removes the floor and
saves STL/OBJ/PLY for this editor. No Mac is required:

1. **Swift Playgrounds (free):** download this repo's ZIP on your iPad, unzip it in Files, open
   `ios/Scan2PrintScanner.swiftpm` in Swift Playgrounds and tap Run. LiDAR scanning needs an iPad Pro (2020+).
2. **TestFlight via GitHub Actions ($99 Apple Developer account):** add four App Store Connect API key secrets and run the
   *iOS app* workflow. It signs the app on a macOS runner and uploads it to TestFlight. Without secrets it only does an
   unsigned build check.

Step-by-step instructions are in [`ios/README.md`](ios/README.md).

## Layout
```
index.html  css/app.css  manifest.webmanifest  sw.js  icons/
js/app.js            UI, viewer, transforms, import/export flow
js/worker.js         parse + heavy ops (runs in a module worker)
js/meshops.js        pure mesh algorithms (weld, cut+cap, fill, smooth, pieces, analysis…)
js/exporters.js      STL / OBJ / 3MF writers
js/sample.js         procedural "phone scan" sample
js/scan.js           Scan button, WebXR depth session, AR overlay UI, hand-off sheet, simulator
js/fusion.js         TSDF depth fusion + marching cubes (pure JS)   js/mc-tables.js  MC lookup tables
js/fusion-worker.js  fusion worker              js/scan-sim.js  synthetic ARCore-like depth camera
vendor/three/        three.js r186 (0.186.1) build + needed addons, re-vendor with tools/vendor.sh
tests/               node unit tests (meshops, fusion), Playwright e2e (Chromium + WebKit), scan e2e with a
                     mocked WebXR ARCore session (tests/xr_mock.js), PWA test, screenshot script
ios/                 native LiDAR scanner app (Swift Playgrounds package + TestFlight CI), see ios/README.md
```

## Develop / test
```bash
python3 -m http.server 8931          # then open http://localhost:8931/
# append ?nosw to bypass the service worker while developing
pip install playwright numpy && python3 -m playwright install chromium webkit
tests/run_all.sh                     # unit + e2e (chromium, webkit) + PWA + SW upgrade + scan e2e + screenshots
```

Live depth scanning can only be exercised for real on an ARCore phone with the Depth API (e.g. recent Pixel / Galaxy S
models) in Chrome over HTTPS, so use the GitHub Pages URL. Locally, `?scansim=1` and `tests/scan_e2e.py` cover the rest of the pipeline.
```text
screenshots/04–12    Scan UI: button, place box, live fusion, result, Android/iPhone hand-off, simulator
```
When you change any cached file, bump `VERSION` in `sw.js` so installed copies update.
