"""End-to-end test of Scan2Print in a phone-sized headless browser.
Usage: python3 tests/e2e.py [chromium|webkit] [--quick]
Needs a static server on http://127.0.0.1:8931 serving the repo root."""
import asyncio, sys, os, json, time
from playwright.async_api import async_playwright
sys.path.insert(0, os.path.dirname(__file__))
from meshcheck import topo, read_stl, read_obj, read_3mf

BASE = os.environ.get('S2P_URL', 'http://127.0.0.1:8931/')
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FIX = os.path.join(ROOT, 'tests', 'fixtures')
SHOTS = '/tmp/s2p-out/shots'
OUT = '/tmp/s2p-out'; os.makedirs(OUT, exist_ok=True); os.makedirs(SHOTS, exist_ok=True)
ENGINE = sys.argv[1] if len(sys.argv) > 1 and not sys.argv[1].startswith('-') else 'chromium'
QUICK = '--quick' in sys.argv
results = []

def check(name, ok, detail=''):
    results.append((name, bool(ok), detail))
    print(('PASS ' if ok else 'FAIL ') + name + (f'  [{detail}]' if detail else ''), flush=True)

async def stats(pg): return await pg.evaluate('({...S2P.state.stats, dims: (()=>{const b=new S2P.THREE.Box3().setFromBufferAttribute(S2P.modelMesh.geometry.attributes.position); const s=b.getSize(new S2P.THREE.Vector3()); return {x:s.x,y:s.z,z:s.y,minY:b.min.y}})(), undo:S2P.state.undo.length})')
async def idle(pg): await pg.wait_for_function("document.querySelector('#busy').classList.contains('hidden')", timeout=120000); await pg.wait_for_timeout(150)
async def tab(pg, name):
    if not await pg.evaluate(f"document.querySelector('[data-panel={name}]').classList.contains('active') && document.querySelector('#sheet').classList.contains('open')"):
        await pg.tap(f'#tabbar [data-tab={name}]')
    await pg.wait_for_timeout(120)
async def set_range(pg, sel, v): await pg.evaluate(f"(()=>{{const r=document.querySelector('{sel}'); r.value={v}; r.dispatchEvent(new Event('input',{{bubbles:true}}));}})()")
async def tap(pg, sel): await pg.locator(sel).scroll_into_view_if_needed(); await pg.tap(sel); await idle(pg)
async def open_file(pg, path):
    await pg.set_input_files('#file-input', path); await pg.wait_for_timeout(300); await idle(pg)
    await pg.wait_for_function('S2P.state.mesh', timeout=60000)

async def export(pg, fmt, fname):
    await tab(pg, 'export')
    await pg.tap(f'#seg-format [data-v="{fmt}"]')
    await pg.fill('#in-filename', fname)
    await tap(pg, '#btn-export')
    async with pg.expect_download() as dl:
        await pg.tap('#btn-download')
    d = await dl.value
    path = os.path.join(OUT, d.suggested_filename); await d.save_as(path)
    return path

async def main():
    async with async_playwright() as p:
        if ENGINE == 'webkit':
            dev = p.devices['iPhone 15 Pro Max']
            b = await p.webkit.launch()
        else:
            dev = p.devices['Galaxy S24'] if 'Galaxy S24' in p.devices else p.devices['Pixel 7']
            b = await p.chromium.launch(args=['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'])
        dev = {**dev, 'viewport': {'width': 430, 'height': 932} if ENGINE == 'webkit' else dev['viewport']}
        ctx = await b.new_context(**dev, accept_downloads=True)
        pg = await ctx.new_page()
        errors = []
        pg.on('pageerror', lambda e: errors.append(str(e)))
        pg.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)
        await pg.goto(BASE); await pg.wait_for_function('window.S2P'); await pg.wait_for_timeout(500)
        check(f'{ENGINE}: app boots, viewport {dev["viewport"]}', True)

        # ---------- import every format
        for fname, expect_mm in [('sphere_m.obj', 80), ('sphere_m.glb', 80), ('sphere_m.ply', 80), ('sphere_mm.stl', 80), ('polycam_export.zip', 80)]:
            await open_file(pg, os.path.join(FIX, fname))
            s = await stats(pg)
            ok = abs(s['dims']['z'] - expect_mm) < 3 and s['watertight'] and s['shells'] == 1 and s['volume'] > 0
            check(f'import {fname}', ok, f"tris={s['tris']} dims={s['dims']['x']:.1f}x{s['dims']['y']:.1f}x{s['dims']['z']:.1f} wt={s['watertight']}")
        await pg.wait_for_timeout(300)

        # ---------- sample scan + tools
        await tab(pg, 'open'); await tap(pg, '#btn-sample'); await pg.wait_for_timeout(400)
        s0 = await stats(pg)
        check('sample loads (holes + debris, metres->mm)', s0['holes'] == 2 and s0['shells'] == 4 and 100 < s0['dims']['z'] < 150, f"{s0['tris']} tris, holes={s0['holes']}, shells={s0['shells']}, z={s0['dims']['z']:.1f}")
        check('auto drop: sits on plate', abs(s0['dims']['minY']) < 1e-3)

        # units reinterpretation
        await tab(pg, 'open'); await tap(pg, '#seg-units [data-v="mm"]'); s = await stats(pg)
        check('units -> mm rescales', s['dims']['z'] < 0.2, f"z={s['dims']['z']:.4f}")
        await tap(pg, '#seg-units [data-v="auto"]'); s = await stats(pg)
        check('units -> auto restores', abs(s['dims']['z'] - s0['dims']['z']) < 0.01)

        # view toggles
        await tab(pg, 'view'); await pg.tap('#chk-wire'); await pg.wait_for_timeout(200)
        check('wireframe toggle', await pg.evaluate('S2P.modelMesh.parent.children.some(o=>o.material&&o.material.wireframe&&o.visible)'))
        await pg.tap('#chk-wire')

        await tab(pg, 'repair')
        if not QUICK: await pg.screenshot(path=os.path.join(SHOTS, f'01-sample-repair-{ENGINE}.png'))
        await tap(pg, '#btn-pieces'); s = await stats(pg)
        check('remove small pieces (keep largest)', s['shells'] == 1, f"shells={s['shells']} tris={s['tris']}")
        await tap(pg, '#btn-holes'); s = await stats(pg)
        check('fill holes -> watertight', s['watertight'] and s['holes'] == 0 and s['volume'] > 0, f"holes={s['holes']} open={s['boundaryEdges']} vol={s['volume']:.0f}")
        vol_before = s['volume']
        await set_range(pg, '#rng-smooth-it', 4); await tap(pg, '#btn-smooth'); s = await stats(pg)
        check('smooth keeps closed & volume', s['watertight'] and abs(s['volume'] / vol_before - 1) < 0.03, f"vol ratio={s['volume']/vol_before:.4f}")
        t_before = s['tris']
        await set_range(pg, '#rng-simplify', 50); await tap(pg, '#btn-simplify'); s = await stats(pg)
        check('simplify 50%', abs(s['tris'] / t_before - 0.5) < 0.05 and s['watertight'], f"{t_before} -> {s['tris']} wt={s['watertight']}")

        # size / scale
        await tab(pg, 'size')
        await pg.fill('#in-z', '80'); await pg.dispatch_event('#in-z', 'input'); await tap(pg, '#btn-size-apply'); s = await stats(pg)
        check('set exact height Z=80 mm (uniform)', abs(s['dims']['z'] - 80) < 0.05, f"{s['dims']}")
        await tap(pg, '[data-scale="50"]'); s = await stats(pg)
        check('scale 1/2x', abs(s['dims']['z'] - 40) < 0.05)
        await tap(pg, '#btn-undo'); s = await stats(pg); check('undo', abs(s['dims']['z'] - 80) < 0.05)
        await tap(pg, '#btn-redo'); s = await stats(pg); check('redo', abs(s['dims']['z'] - 40) < 0.05)
        await tap(pg, '#btn-undo')
        d0 = (await stats(pg))['dims']
        await tap(pg, '[data-rot="x,90"]'); s = await stats(pg)
        check('rotate X +90 swaps Y/Z', abs(s['dims']['z'] - d0['y']) < 0.1 and abs(s['dims']['y'] - d0['z']) < 0.1, f"{d0} -> {s['dims']}")
        await tap(pg, '[data-rot="x,-90"]')
        await set_range(pg, '#rng-rz', 30); await pg.wait_for_timeout(100)
        preview = await pg.evaluate('!S2P.modelMesh.matrix.equals(new S2P.THREE.Matrix4())')
        await tap(pg, '#btn-rot-apply'); s = await stats(pg)
        check('free rotate preview + apply', preview and s['undo'] > 0 and await pg.evaluate('S2P.modelMesh.matrix.equals(new S2P.THREE.Matrix4())'))
        v = s['volume']
        await tap(pg, '[data-mirror="x"]'); s = await stats(pg)
        check('mirror X keeps outward normals', s['volume'] > 0 and abs(s['volume'] - v) / v < 1e-3 and s['watertight'])
        # lay flat: tilt first, then tap the model
        await tap(pg, '[data-rot="y,90"]'); await tap(pg, '[data-rot="x,45"]') if await pg.locator('[data-rot="x,45"]').count() else None
        await set_range(pg, '#rng-rx', 40); await tap(pg, '#btn-rot-apply')
        before = (await stats(pg))['dims']
        await tap(pg, '#btn-layflat')
        await pg.evaluate('S2P.fitView(new S2P.THREE.Vector3(0.2, -1, 0.3))'); await pg.wait_for_timeout(300)  # look from below
        box = await pg.locator('#canvas').bounding_box()
        await pg.touchscreen.tap(box['x'] + box['width'] / 2, box['y'] + box['height'] / 2); await idle(pg)
        s = await stats(pg)
        check('lay flat by tapping a face', s['undo'] > 0 and abs(s['dims']['minY']) < 1e-3 and s['dims'] != before, f"{before} -> {s['dims']}")
        await pg.evaluate('S2P.fitView()')

        # cut + flatten
        await tab(pg, 'cut'); await pg.wait_for_timeout(200)
        await set_range(pg, '#rng-cut-pos', 300); await set_range(pg, '#rng-cut-ta', 15); await pg.wait_for_timeout(250)
        check('cut preview plane + clipping visible', await pg.evaluate('S2P.modelMesh.material.clippingPlanes.length === 1'))
        if not QUICK: await pg.screenshot(path=os.path.join(SHOTS, f'02-cut-plane-{ENGINE}.png'))
        zb = (await stats(pg))['dims']['z']
        await tap(pg, '#btn-cut'); s = await stats(pg)
        check('tilted plane cut + cap -> still watertight', s['watertight'] and s['shells'] == 1 and s['dims']['z'] < zb, f"z {zb:.1f} -> {s['dims']['z']:.1f}")
        await set_range(pg, '#rng-cut-ta', 0)
        await pg.fill('#in-flatten', '2'); zb = s['dims']['z']
        await tap(pg, '#btn-flatten'); s = await stats(pg)
        check('flatten bottom 2 mm', s['watertight'] and abs((zb - s['dims']['z']) - 2) < 0.05, f"z {zb:.2f} -> {s['dims']['z']:.2f}")
        final = s

        # ---------- export
        p_stl = await export(pg, 'stl', 'sample_print')
        t = topo(*read_stl(p_stl))
        check('export binary STL parses & watertight', t['watertight'] and t['tris'] == final['tris'] and t['misoriented'] == 0 and t['volume'] > 0,
              f"{os.path.basename(p_stl)} app_tris={final['tris']} {t}")
        check('STL is Z-up mm on the bed', abs(t['zmin']) < 1e-3 and abs(t['bbox'][2] - final['dims']['z']) < 0.05, f"bbox={t['bbox']}")
        if not QUICK: await pg.screenshot(path=os.path.join(SHOTS, f'03-export-{ENGINE}.png'))
        p3 = await export(pg, '3mf', 'sample_print'); t3 = topo(*read_3mf(p3), weld=False)
        check('export 3MF valid & watertight', t3['watertight'] and t3['tris'] == final['tris'] and t3['volume'] > 0, f"{t3['tris']} tris vs app {final['tris']}")
        po = await export(pg, 'obj', 'sample_print'); to = topo(*read_obj(po), weld=False)
        check('export OBJ valid & watertight', to['watertight'] and to['tris'] == final['tris'], f"{to['tris']} tris vs app {final['tris']}")

        # help screen
        await pg.tap('#btn-help'); await pg.wait_for_timeout(300)
        check('help dialog opens', await pg.evaluate("document.querySelector('#help').open"))
        if not QUICK: await pg.screenshot(path=os.path.join(SHOTS, f'04-help-{ENGINE}.png'))
        await pg.tap('#help-close')

        # ---------- big scan performance
        if not QUICK:
            await pg.evaluate('''window.__gaps=[];(function f(t0){requestAnimationFrame(t=>{if(window.__last)__gaps.push(t-__last);window.__last=t;if(!window.__stop)f()})})()''')
            t0 = time.time(); await open_file(pg, os.path.join(FIX, 'big_scan_500k.stl')); t_imp = time.time() - t0
            s = await stats(pg)
            check('import ~500k-tri STL', s['tris'] > 480000, f"{s['tris']} tris in {t_imp:.1f}s, holes={s['holes']}")
            await pg.evaluate('__gaps.length=0')
            await tab(pg, 'repair')
            ops_t = {}
            for name, sel, prep in [('pieces', '#btn-pieces', None), ('fill', '#btn-holes', None), ('smooth', '#btn-smooth', ('#rng-smooth-it', 5)), ('simplify', '#btn-simplify', ('#rng-simplify', 40))]:
                if prep: await set_range(pg, *prep)
                t0 = time.time(); await tap(pg, sel); ops_t[name] = round(time.time() - t0, 2)
            gaps = await pg.evaluate('__gaps.slice().sort((a,b)=>b-a).slice(0,3)')
            s = await stats(pg)
            check('500k: fill/smooth/simplify in worker, UI keeps rendering', s['watertight'] and s['tris'] < 220000, f"times={ops_t}s, worst frame gaps ms={[round(g) for g in gaps]}, result {s['tris']} tris wt={s['watertight']}")
            await tab(pg, 'cut'); await set_range(pg, '#rng-cut-pos', 500)
            t0 = time.time(); await tap(pg, '#btn-cut'); tc = time.time() - t0; s = await stats(pg)
            check('500k: cut', s['watertight'], f"{tc:.2f}s")
            t0 = time.time(); pb = await export(pg, 'stl', 'big_print'); tb = time.time() - t0
            tt = topo(*read_stl(pb))
            check('500k: STL export', tt['watertight'] and tt['tris'] == s['tris'], f"{tt['tris']} tris, {os.path.getsize(pb)/1e6:.1f} MB in {tb:.1f}s")

        check('no JS errors', not errors, '; '.join(errors[:5]))
        await b.close()
    failed = [r for r in results if not r[1]]
    print(f"\n{ENGINE}: {len(results) - len(failed)}/{len(results)} checks passed")
    json.dump(results, open(f'/tmp/s2p-e2e-{ENGINE}.json', 'w'), indent=1)
    sys.exit(1 if failed else 0)

asyncio.run(main())
