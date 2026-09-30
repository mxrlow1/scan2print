"""E2E tests for the Scan feature: WebXR depth scan (mocked ARCore session), simulator, graceful fallbacks and the
iPhone/unsupported hand-off. Saves phone screenshots of the Scan UI to screenshots/.
Usage: python3 tests/scan_e2e.py [--no-shots]   (needs the static server on 8931, or S2P_URL)"""
import asyncio, os, sys, json
from playwright.async_api import async_playwright

BASE = os.environ.get('S2P_URL', 'http://127.0.0.1:8931/')
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SHOTS = os.path.join(ROOT, 'screenshots')
SAVE = '--no-shots' not in sys.argv
MOCK = open(os.path.join(ROOT, 'tests', 'xr_mock.js')).read()
LINKS = {
    'lnk-scaniverse-ios': 'https://apps.apple.com/us/app/scaniverse-3d-scanner/id1541433223',
    'lnk-polycam-ios': 'https://apps.apple.com/us/app/polycam-3d-scanner-measuring/id1532482376',
    'lnk-scaniverse-android': 'https://play.google.com/store/apps/details?id=com.nianticlabs.scaniverse',
    'lnk-polycam-android': 'https://play.google.com/store/apps/details?id=ai.polycam',
    'lnk-native': 'https://github.com/mxrlow1/scan2print/blob/main/ios/README.md',
}
results = []
def check(name, ok, detail=''):
    results.append((name, bool(ok)))
    print(('PASS ' if ok else 'FAIL ') + name + (f'  [{detail}]' if detail else ''), flush=True)

CHROME_ARGS = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader']

async def new_page(browser, device, mock=None, query=''):
    ctx = await browser.new_context(**device)
    if mock:
        await ctx.add_init_script(f'window.__XRMOCK = {json.dumps({"mode": mock})};\n' + MOCK)
    pg = await ctx.new_page()
    errs = []
    pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.on('console', lambda m: errs.append(m.text) if m.type == 'error' else None)
    await pg.goto(BASE + '?nosw' + query)
    try:
        await pg.wait_for_function('window.S2P && document.documentElement.dataset.scan', timeout=20000, polling=200)
    except Exception:
        print('BOOT FAILED', errs, await pg.evaluate('({s: !!window.S2P, d: document.documentElement.dataset.scan, url: location.href})')); raise
    await pg.wait_for_timeout(400)
    return ctx, pg, errs

async def shot(pg, name):
    if SAVE: await pg.screenshot(path=os.path.join(SHOTS, name))

async def handoff_checks(pg, label, platform_first):
    await pg.tap('#btn-scan-empty')
    await pg.wait_for_selector('#scan-help[open]', timeout=5000)
    first = await pg.evaluate("[...document.querySelectorAll('#scan-help section')].map(s => s.id)[0]")
    check(f'{label}: hand-off opens, {platform_first} section first', first == platform_first, first)
    hrefs = await pg.evaluate("Object.fromEntries([...document.querySelectorAll('#scan-help a[id]')].map(a => [a.id, a.href]))")
    check(f'{label}: only verified app links', hrefs == LINKS, json.dumps(hrefs) if hrefs != LINKS else '')
    return await pg.text_content('#scan-reason')

async def run_scan(pg, label, errs, min_frames=60, shots=None):
    await pg.tap('#btn-scan-empty')
    await pg.wait_for_function("S2P.scan.phase === 'place' && !document.querySelector('#xr-place-btn').disabled", timeout=15000)
    check(f'{label}: AR overlay in place phase', await pg.is_visible('#xr-overlay') and await pg.is_visible('#xr-place'))
    # headless has no camera passthrough: show the XR canvas (reticle, scan box, live mesh) for the screenshots
    await pg.evaluate("document.querySelector('#xr-canvas')?.classList.remove('hidden')")
    if shots: await pg.wait_for_timeout(300); await shot(pg, shots[0])
    await pg.tap('#xr-place-btn')
    try:  # wait for enough frames AND views from around the object (frame pacing varies with machine load)
        await pg.wait_for_function(f"S2P.scan.stats.frames >= {min_frames} && S2P.scan.stats.tris > 500 && S2P.scan.stats.coverage >= 0.6", timeout=120000, polling=500)
    except Exception: pass
    st = await pg.evaluate('S2P.scan.stats')
    check(f'{label}: live fusion + preview mesh', st['tris'] > 500 and st['coverage'] >= 0.6, f"{st['frames']} frames, {st['tris']} preview tris, coverage {st['coverage']:.2f}, fuse {st['fuseMs']:.0f} ms")
    if shots: await shot(pg, shots[1])
    await pg.tap('#xr-finish')
    await pg.wait_for_function('S2P.state.lastScan && document.querySelector("#busy").classList.contains("hidden")', timeout=120000)
    await pg.wait_for_timeout(600)
    r = await pg.evaluate('''(() => { const b = new S2P.THREE.Box3().setFromBufferAttribute(S2P.modelMesh.geometry.attributes.position); const s = b.getSize(new S2P.THREE.Vector3());
      return { stats: S2P.state.stats, last: S2P.state.lastScan, unit: S2P.state.unit, dims: [s.x, s.z, s.y], overlay: !document.querySelector('#xr-overlay').classList.contains('hidden'),
               phase: S2P.scan.phase, undo: S2P.state.undo.length, minY: b.min.y } })()''')
    d = r['dims']
    check(f'{label}: scan imported into editor (mm, on plate)', r['unit'] == 'm' and abs(d[0] - 110) < 12 and abs(d[1] - 110) < 12 and abs(d[2] - 205) < 15 and abs(r['minY']) < 0.01,
          f"{d[0]:.0f}×{d[1]:.0f}×{d[2]:.0f} mm")
    check(f'{label}: auto clean-up → watertight, 1 piece, undoable', r['stats']['watertight'] and r['stats']['shells'] == 1 and r['undo'] >= 1,
          f"{r['stats']['tris']} tris, steps {r['last']['steps']}, undo {r['undo']}")
    check(f'{label}: AR UI closed after finish', not r['overlay'] and r['phase'] == 'idle')
    if shots: await shot(pg, shots[2])
    check(f'{label}: no page errors', not errs, '; '.join(errs[:3]))
    return r

async def main():
    os.makedirs(SHOTS, exist_ok=True)
    async with async_playwright() as p:
        android = p.devices['Galaxy S24'] if 'Galaxy S24' in p.devices else p.devices['Pixel 7']
        cb = await p.chromium.launch(args=CHROME_ARGS)

        # 1. Android with WebXR depth (mocked ARCore): full live scan through the real AR code path
        ctx, pg, errs = await new_page(cb, android, mock='full')
        check('android+depth: Scan button says live scan', 'Live depth scan' in (await pg.text_content('#btn-scan-empty')))
        await shot(pg, '04-scan-button-android.png')
        await run_scan(pg, 'android+depth (mock XR)', errs, shots=['05-scan-place-box.png', '06-scan-live-fusion.png', '07-scan-result-in-editor.png'])
        init = await pg.evaluate('__xrLog.init[0]')
        ok = (init['mode'] == 'immersive-ar' and set(init['requiredFeatures']) >= {'depth-sensing', 'hit-test', 'dom-overlay'}
              and init['depthSensing']['usagePreference'] == ['cpu-optimized'] and init['domOverlay']['root'] == 'xr-overlay')
        check('android+depth: requestSession asks for CPU depth + hit-test + DOM overlay', ok, json.dumps(init)[:200])
        check('android+depth: session ended cleanly', await pg.evaluate('__xrLog.ended') == 1 and await pg.evaluate('__xrLog.depthCalls') >= 60)
        await ctx.close()

        # 2. newer Chrome that rejects the 'luminance-alpha' enum → retries with 'unsigned-short'
        ctx, pg, errs = await new_page(cb, android, mock='newformat')
        await pg.tap('#btn-scan-empty')
        await pg.wait_for_function("S2P.scan.phase === 'place'", timeout=15000)
        fm = await pg.evaluate('__xrLog.init.map(i => i.depthSensing.dataFormatPreference[0])')
        check('android newer Chrome: retries depth format list', fm == ['luminance-alpha', 'unsigned-short'], str(fm))
        await pg.tap('#xr-close'); await pg.wait_for_timeout(300)
        check('close button ends session and restores editor', await pg.evaluate("S2P.scan.phase === 'idle' && document.querySelector('#xr-overlay').classList.contains('hidden') && __xrLog.ended === 1"))
        check('android newer Chrome: no page errors', not errs, '; '.join(errs[:3]))
        await ctx.close()

        # 3. ARCore phone without Depth API → graceful fallback to the hand-off sheet
        ctx, pg, errs = await new_page(cb, android, mock='nodepth')
        reason = await handoff_checks(pg, 'android no depth', 'scan-android')
        check('android no depth: explains missing depth support', 'depth' in reason.lower(), reason)
        check('android no depth: AR overlay hidden again', await pg.evaluate("document.querySelector('#xr-overlay').classList.contains('hidden') && S2P.scan.phase === 'idle' && !document.body.classList.contains('xr-active')"))
        await shot(pg, '08-scan-handoff-android-no-depth.png')
        check('android no depth: no page errors', not errs, '; '.join(errs[:3]))
        await ctx.close()

        # 4. Android Chrome without WebXR AR at all (real headless Chromium: isSessionSupported → false)
        ctx, pg, errs = await new_page(cb, android)
        reason = await handoff_checks(pg, 'android no WebXR AR', 'scan-android')
        check('android no WebXR AR: reason shown', len(reason) > 20, reason)
        await pg.tap('#scan-help-close'); await pg.wait_for_timeout(200)
        check('hand-off closes', not await pg.evaluate("document.querySelector('#scan-help').open"))
        check('android no WebXR AR: no page errors', not errs, '; '.join(errs[:3]))
        await ctx.close()

        # 5. simulator mode (?scansim=1): same worker + UI, synthetic depth camera, visible render
        ctx, pg, errs = await new_page(cb, android, query='&scansim=1')
        await pg.tap('#btn-scan-empty')
        await pg.wait_for_function("S2P.scan.phase === 'place'", timeout=15000)
        await pg.tap('#xr-place-btn')
        await pg.wait_for_function("S2P.scan.stats.frames >= 80", timeout=120000, polling=500)
        await pg.wait_for_timeout(1600)
        await shot(pg, '09-scan-simulator-live-mesh.png')
        await pg.tap('#xr-finish')
        await pg.wait_for_function('S2P.state.lastScan && document.querySelector("#busy").classList.contains("hidden")', timeout=120000)
        last = await pg.evaluate('S2P.state.lastScan')
        check('simulator: scan → editor, watertight', last['simulated'] and await pg.evaluate('S2P.state.stats.watertight'), f"{last['frames']} frames, {last['tris']} tris")
        check('simulator: no page errors', not errs, '; '.join(errs[:3]))
        await ctx.close()
        await cb.close()

        # 6. iPhone Safari (WebKit, no navigator.xr) → hand-off with App Store links + native app info
        wb = await p.webkit.launch()
        iphone = {**p.devices['iPhone 15 Pro Max'], 'viewport': {'width': 430, 'height': 932}}
        ctx, pg, errs = await new_page(wb, iphone)
        check('iphone: Scan button offers app hand-off', 'iPhone' in (await pg.text_content('#btn-scan-empty')))
        await shot(pg, '10-scan-button-iphone.png')
        reason = await handoff_checks(pg, 'iphone', 'scan-ios')
        check('iphone: explains Safari has no WebXR', 'WebXR' in reason, reason)
        check('iphone: native Scanner app info visible', await pg.is_visible('#lnk-native'))
        await shot(pg, '11-scan-handoff-iphone.png')
        await pg.evaluate("document.querySelector('#lnk-native').scrollIntoView({block: 'center'})"); await pg.wait_for_timeout(200)
        await shot(pg, '12-scan-handoff-iphone-native-app.png')
        # "Open an exported file" goes to the file picker and closes the sheet
        async with pg.expect_file_chooser() as fc:
            await pg.tap('#scan-help-open')
        await (await fc.value).set_files(os.path.join(ROOT, 'tests', 'fixtures', 'cube.stl')) if os.path.exists(os.path.join(ROOT, 'tests', 'fixtures', 'cube.stl')) else None
        check('iphone: "Open an exported file" opens picker and closes sheet', not await pg.evaluate("document.querySelector('#scan-help').open"))
        check('iphone: no page errors', not errs, '; '.join(errs[:3]))
        await ctx.close()
        await wb.close()

    failed = [n for n, ok in results if not ok]
    print(f'\n{len(results) - len(failed)}/{len(results)} scan checks passed')
    if failed: print('FAILED:', *failed, sep='\n  '); sys.exit(1)

asyncio.run(main())
