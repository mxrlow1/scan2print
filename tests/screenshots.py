"""Capture phone-sized marketing/QA screenshots into screenshots/ (iPhone 16 Pro Max viewport, 440x956 @3x)."""
import asyncio, os
from playwright.async_api import async_playwright
BASE = os.environ.get('S2P_URL', 'http://127.0.0.1:8931/')
SHOTS = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'screenshots')
os.makedirs(SHOTS, exist_ok=True)

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(args=['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'])
        ctx = await b.new_context(viewport={'width': 440, 'height': 956}, device_scale_factor=3, is_mobile=True, has_touch=True,
                                  user_agent='Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1')
        pg = await ctx.new_page()
        async def idle(): await pg.wait_for_function("document.querySelector('#busy').classList.contains('hidden')"); await pg.wait_for_timeout(200)
        async def rng(sel, v): await pg.evaluate(f"(()=>{{const r=document.querySelector('{sel}'); r.value={v}; r.dispatchEvent(new Event('input',{{bubbles:true}}));}})()")
        async def shot(name):
            await pg.evaluate("document.querySelector('#toast').classList.add('hidden')"); await pg.wait_for_timeout(350)
            await pg.screenshot(path=os.path.join(SHOTS, name)); print('saved', name)
        await pg.goto(BASE); await pg.wait_for_function('window.S2P'); await pg.wait_for_timeout(400)
        await shot('00-start.png')
        await pg.tap('#btn-sample-empty'); await pg.wait_for_function('S2P.state.mesh'); await idle()
        await pg.tap('#tabbar [data-tab=repair]'); await pg.wait_for_timeout(300)
        await shot('01-sample-scan-repair.png')
        await pg.tap('#btn-pieces'); await idle(); await pg.tap('#btn-holes'); await idle()
        await pg.tap('#tabbar [data-tab=cut]'); await rng('#rng-cut-pos', 420); await rng('#rng-cut-ta', 14); await pg.wait_for_timeout(300)
        await shot('02-cut-plane-preview.png')
        await rng('#rng-cut-pos', 150); await rng('#rng-cut-ta', 0); await pg.tap('#btn-cut'); await idle(); await pg.tap('#btn-flatten'); await idle()
        await pg.tap('#tabbar [data-tab=size]'); await pg.fill('#in-z', '60'); await pg.dispatch_event('#in-z', 'input'); await pg.tap('#btn-size-apply'); await idle()
        await pg.tap('#tabbar [data-tab=export]'); await pg.tap('#btn-export'); await idle()
        await pg.evaluate("document.querySelector('#btn-share').classList.remove('hidden')")  # show the iOS share button as it appears on iPhone
        await shot('03-export-ready.png')
        await b.close()
asyncio.run(main())
