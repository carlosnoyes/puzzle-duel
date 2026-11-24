// App-level behaviour: installability, install flows, Back button, shortcuts, QR codes, clean links.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { devices } = require('playwright');
const { launch, serve, watchErrors, waitFor, sleep, screenOf, isVisible } = require('./helpers');

let browser;
const errors = [];
before(async () => { browser = await launch(); });
after(async () => { await browser.close(); });

async function open(url, opts = {}, init) {
  const ctx = await browser.newContext(opts);
  await serve(ctx);
  if (init) await ctx.addInitScript(init);
  const page = await ctx.newPage(); watchErrors(page, errors);
  await page.goto(url);
  return { ctx, page };
}

test('Chromium judges the site installable (manifest, icons, service worker)', async () => {
  const { ctx, page } = await open('https://duel.test/', { serviceWorkers: 'allow' });
  await page.evaluate(() => navigator.serviceWorker.ready);
  await sleep(500);
  const cdp = await ctx.newCDPSession(page);
  assert.deepStrictEqual((await cdp.send('Page.getAppManifest')).errors, []);
  assert.deepStrictEqual((await cdp.send('Page.getInstallabilityErrors')).installabilityErrors, []);
  // desktop/Android: the button appears only when the browser offers a prompt, and uses it
  assert.ok(await page.evaluate(() => document.getElementById('btn-install').classList.contains('hidden')));
  await page.evaluate(() => { const e = new Event('beforeinstallprompt'); e.prompt = () => { window.__prompted = true; }; e.userChoice = Promise.resolve({ outcome: 'accepted' }); window.dispatchEvent(e); });
  await page.click('#btn-install');
  assert.ok(await page.evaluate(() => window.__prompted));
  await ctx.close();
});

test('iPhone shows Add-to-Home-Screen steps; an installed app hides the install UI', async () => {
  let { ctx, page } = await open('https://duel.test/', { ...devices['iPhone 13'] });
  assert.ok(await isVisible(page, 'install-banner'));
  await page.click('#btn-install');
  assert.match(await page.textContent('#install-steps'), /Add to Home Screen/);
  await ctx.close();
  ({ ctx, page } = await open('https://duel.test/?source=app', { ...devices['iPhone 13'] }, () => Object.defineProperty(navigator, 'standalone', { get: () => true })));
  assert.ok(!(await isVisible(page, 'btn-install')) && !(await isVisible(page, 'install-banner')));
  assert.strictEqual(page.url(), 'https://duel.test/', 'launch params tidied away');
  await ctx.close();
});

test('Back button returns to the menu and asks before leaving a live game; shortcuts work', async () => {
  const { ctx, page } = await open('https://duel.test/?net=bc', { viewport: { width: 800, height: 900 } });
  await page.click('#btn-bot');
  await page.goBack(); await sleep(300);
  assert.strictEqual(await screenOf(page), 'screen-home');
  await page.click('#btn-bot'); await page.click('#btn-start');
  await page.waitForFunction(() => PD.app.round && PD.app.round.active, null, { timeout: 15000 });
  let asked = '';
  page.once('dialog', d => { asked = d.message(); d.dismiss(); });
  await page.goBack(); await sleep(400);
  assert.strictEqual(asked, 'Leave this game?');
  assert.strictEqual(await screenOf(page), 'screen-game');
  page.once('dialog', d => d.accept());
  await page.goBack(); await sleep(400);
  assert.strictEqual(await screenOf(page), 'screen-home');
  await page.goto('https://duel.test/?action=daily&net=bc'); await sleep(600);
  assert.strictEqual(await screenOf(page), 'screen-game');
  assert.ok(!page.url().includes('action='));
  await ctx.close();
});

test('QR codes decode to exactly the invite, challenge and game links', async () => {
  const { ctx, page } = await open('https://duel.test/?source=app&net=bc', { ...devices['iPhone 13'], permissions: ['clipboard-read', 'clipboard-write'] });
  await page.evaluate(() => document.getElementById('howto-close').click());
  await page.addScriptTag({ path: require.resolve('jsqr/dist/jsQR.js') });
  const decode = () => page.evaluate(async () => {
    const img = document.getElementById('qr-img'); await img.decode();
    const c = document.createElement('canvas'); c.width = c.height = 360; const g = c.getContext('2d'); g.drawImage(img, 0, 0, 360, 360);
    const r = jsQR(g.getImageData(0, 0, 360, 360).data, 360, 360); return r && r.data;
  });
  await page.click('#btn-create');
  await waitFor(() => page.evaluate(() => !document.getElementById('copy-link').disabled), 5000, 'room open');
  await page.click('#copy-link');
  const invite = await page.evaluate(() => navigator.clipboard.readText());
  assert.ok(!invite.includes('source='), 'invite link carries no launch params');
  await page.click('#qr-link');
  assert.strictEqual(await decode(), invite);
  await page.click('#qr-close'); await page.click('#lobby-leave');
  await page.click('#share-app');
  assert.strictEqual(await decode(), 'https://duel.test/?net=bc');
  await page.click('#qr-close');
  await ctx.close();
  assert.deepStrictEqual(errors, []);
});
