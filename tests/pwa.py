"""PWA checks: service worker install, offline reload, and the Web Share Target POST handler."""
import asyncio, os
from playwright.async_api import async_playwright
BASE = os.environ.get('S2P_URL', 'http://127.0.0.1:8931/')
FIX = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'fixtures')
async def main():
    ok = True
    async with async_playwright() as p:
        b = await p.chromium.launch(args=['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'])
        ctx = await b.new_context(viewport={'width': 390, 'height': 844}, is_mobile=True, has_touch=True)
        pg = await ctx.new_page()
        await pg.goto(BASE)
        await pg.evaluate('navigator.serviceWorker.ready')
        await pg.reload(); await pg.wait_for_function('!!navigator.serviceWorker.controller', timeout=15000)
        print('PASS service worker active & controlling')
        await ctx.set_offline(True)
        await pg.reload(); await pg.wait_for_function('window.S2P', timeout=15000)
        await pg.tap('#btn-sample-empty'); await pg.wait_for_function('S2P.state.mesh && S2P.state.stats', timeout=20000)
        print('PASS offline reload + sample + worker work offline')
        await ctx.set_offline(False)
        # simulate Android "Share to Scan2Print": multipart POST to ./share-target, intercepted by the SW
        data = open(os.path.join(FIX, 'sphere_mm.stl'), 'rb').read()
        status = await pg.evaluate('''async (bytes) => {
            const fd = new FormData(); fd.append('file', new File([new Uint8Array(bytes)], 'shared-sphere.stl'));
            const r = await fetch('share-target', { method: 'POST', body: fd, redirect: 'manual' });
            return r.type + ' ' + r.status;
        }''', list(data))
        await pg.goto(BASE + '?shared=1')
        await pg.wait_for_function("S2P.state.mesh && S2P.state.name === 'shared-sphere.stl'", timeout=20000)
        n = await pg.evaluate('S2P.state.stats.tris')
        print(f'PASS share-target POST ({status}) -> opened shared-sphere.stl with {n} triangles')
        m = await pg.evaluate("fetch('manifest.webmanifest').then(r=>r.json())")
        assert m['share_target']['method'] == 'POST' and m['display'] == 'standalone'
        print('PASS manifest ok (standalone, share_target, icons:', [i['sizes'] for i in m['icons']], ')')
        await b.close()
asyncio.run(main())
