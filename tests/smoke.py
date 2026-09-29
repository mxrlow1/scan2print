import asyncio, sys
from playwright.async_api import async_playwright
URL = 'http://127.0.0.1:8931/?nosw'
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(args=['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader'])
        ctx = await b.new_context(viewport={'width':430,'height':932}, device_scale_factor=2, is_mobile=True, has_touch=True)
        pg = await ctx.new_page()
        pg.on('console', lambda m: print('CONSOLE', m.type, m.text))
        pg.on('pageerror', lambda e: print('PAGEERROR', e))
        await pg.goto(URL); await pg.wait_for_timeout(1500)
        await pg.click('#btn-sample-empty')
        await pg.wait_for_function('window.S2P && S2P.state.mesh', timeout=20000)
        await pg.wait_for_timeout(800)
        print(await pg.evaluate('JSON.stringify(S2P.state.stats)'))
        print(await pg.inner_text('#dims'), '|', await pg.inner_text('#health'))
        await pg.screenshot(path='/tmp/smoke1.png')
        await b.close()
asyncio.run(main())
