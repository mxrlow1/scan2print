"""Service-worker upgrade test: a returning user who has an older build cached (default: the v1.0.0 commit) must get
the current build after reloading. Serves both versions from the same origin on port 8933.
Usage: python3 tests/sw_upgrade.py [old-git-ref]"""
import asyncio, os, subprocess, sys, tempfile, shutil, re
from playwright.async_api import async_playwright
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OLD = sys.argv[1] if len(sys.argv) > 1 else '3d6833c'
want = re.search(r"APP_VERSION = '([^']+)'", open(os.path.join(ROOT, 'js/app.js')).read()).group(1)

def export(ref, dst):
    for n in os.listdir(dst): shutil.rmtree(os.path.join(dst, n)) if os.path.isdir(os.path.join(dst, n)) else os.remove(os.path.join(dst, n))
    if ref == 'WORKTREE':
        subprocess.run(f'cd "{ROOT}" && git ls-files -co --exclude-standard | tar -cf - -T - | tar -xf - -C "{dst}"', shell=True, check=True)
    else:
        subprocess.run(f'cd "{ROOT}" && git archive {ref} | tar -x -C "{dst}"', shell=True, check=True)

async def main():
    site, prof = tempfile.mkdtemp(), tempfile.mkdtemp()
    export(OLD, site)
    srv = subprocess.Popen([sys.executable, '-m', 'http.server', '8933', '--bind', '127.0.0.1'], cwd=site, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    ok = False
    try:
        await asyncio.sleep(1)
        async with async_playwright() as p:
            ctx = await p.chromium.launch_persistent_context(prof, args=['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'])
            pg = await ctx.new_page()
            await pg.goto('http://127.0.0.1:8933/'); await pg.wait_for_function('window.S2P')
            await pg.evaluate('navigator.serviceWorker.ready.then(() => 1)'); await pg.reload()
            await pg.wait_for_function('!!navigator.serviceWorker.controller', timeout=15000)
            before = await pg.text_content('#version-note')
            export('WORKTREE', site)
            await pg.reload(); await pg.wait_for_timeout(2500)   # new sw.js installs + activates
            await pg.reload(); await pg.wait_for_function('window.S2P'); await pg.wait_for_timeout(300)
            after = await pg.text_content('#version-note')
            keys = await pg.evaluate('caches.keys()')
            ok = want in after and before != after
            print(('PASS' if ok else 'FAIL') + f' sw upgrade {OLD} → worktree: "{before}" → "{after}", caches {keys}')
            await ctx.close()
    finally:
        srv.terminate(); shutil.rmtree(site, ignore_errors=True); shutil.rmtree(prof, ignore_errors=True)
    sys.exit(0 if ok else 1)
asyncio.run(main())
