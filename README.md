# Scan2Print

Mobile-first, installable PWA for cleaning up phone 3D scans (Scaniverse, Polycam, KIRI, RealityScan…) and exporting print-ready files.
Static files only, no build step, runs 100 % on-device (nothing is uploaded). Works offline once it has loaded.

**Live:** https://mxrlow1.github.io/scan2print/

## Features
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
vendor/three/        three.js r186 (0.186.1) build + needed addons, re-vendor with tools/vendor.sh
tests/               node unit tests, Playwright e2e (Chromium + WebKit), PWA test, screenshot script
```

## Develop / test
```bash
python3 -m http.server 8931          # then open http://localhost:8931/
# append ?nosw to bypass the service worker while developing
pip install playwright numpy && python3 -m playwright install chromium webkit
tests/run_all.sh                     # unit + e2e (chromium, webkit) + PWA + screenshots
```
When you change any cached file, bump `VERSION` in `sw.js` so installed copies update.
