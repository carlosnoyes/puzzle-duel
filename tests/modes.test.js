// Solo and same-device modes: vs bot, pass & play, daily challenge + challenge links, practice.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { launch, serve, watchErrors, waitFor, sleep, screenOf, isVisible } = require('./helpers');

let browser, ctx, page, errors;
before(async () => {
  browser = await launch();
  ctx = await browser.newContext({ viewport: { width: 900, height: 900 }, permissions: ['clipboard-read', 'clipboard-write'] });
  await serve(ctx);
  page = await ctx.newPage();
  errors = watchErrors(page);
  page.on('dialog', d => d.accept());
  await page.goto('https://duel.test/?net=bc');
  await page.evaluate(() => document.getElementById('howto-close').click());
});
after(async () => { await browser.close(); });

const roundActive = () => page.waitForFunction(() => PD.app.round && PD.app.round.active, null, { timeout: 20000 });
const finalShown = () => page.waitForFunction(() => !document.getElementById('screen-final').classList.contains('hidden'), null, { timeout: 120000 });
const solveNow = () => page.evaluate(() => PD.app.round.attempt.api.done());
const home = async () => { if ((await screenOf(page)) !== 'screen-home') await page.click('#btn-final-home'); };

test('vs bot: an idle player loses to the Master bot; solving by real taps beats the Rookie', async () => {
  await page.click('#btn-bot');
  await page.click('#settings-panel [data-setting=bot] [data-v=master]');
  await page.click('#settings-panel [data-setting=diff] [data-v=easy]');
  await page.click('#settings-panel [data-setting=rounds] [data-v="3"]');
  await page.evaluate(() => { PD.app.settings.pool = ['hunt']; });
  await page.click('#btn-start');
  await finalShown();
  assert.match(await page.textContent('#final-score'), /0\s*–\s*2/);

  await home(); await page.click('#btn-bot');
  await page.click('#settings-panel [data-setting=bot] [data-v=rookie]');
  await page.evaluate(() => { PD.app.settings.pool = ['hunt']; });
  await page.click('#btn-start');
  for (let r = 0; r < 2; r++) {
    await roundActive();
    await page.evaluate(() => { const cells = [...document.querySelectorAll('.hunt-cell')]; for (let v = 1; v <= cells.length; v++) cells.find(c => c.textContent === String(v)).dispatchEvent(new PointerEvent('pointerdown', { button: 0, bubbles: true })); });
    await page.waitForFunction(() => !PD.app.round || !PD.app.round.active, null, { timeout: 5000 });
  }
  await finalShown();
  assert.strictEqual(await page.textContent('#final-title'), 'Victory!');
  assert.match(await page.textContent('#rematch-hint'), /All-time vs Bolt \(Rookie\): 1W/);
});

test('pass & play: two turns per round, player 2 races player 1’s ghost', async () => {
  await home(); await page.click('#btn-local');
  await page.click('#settings-panel [data-setting=rounds] [data-v="3"]');
  await page.evaluate(() => { PD.app.settings.pool = ['math']; });
  await page.click('#btn-start');
  for (let r = 0; r < 3; r++) {
    for (const who of ['p1', 'p2']) {
      await page.waitForFunction(() => !document.getElementById('handoff').classList.contains('hidden') || !document.getElementById('screen-final').classList.contains('hidden'), null, { timeout: 20000 });
      if (await isVisible(page, 'screen-final')) break;
      await page.click('#handoff-go');
      await roundActive();
      await sleep(who === 'p1' ? 300 : 900);
      if (who === 'p2') assert.strictEqual(await page.evaluate(() => document.getElementById('hud-me-bar').style.width), '100%', 'ghost of player 1 finished');
      await solveNow();
    }
    if (await isVisible(page, 'screen-final')) break;
  }
  await finalShown();
  assert.match(await page.textContent('#final-title'), /wins!/);
});

test('daily challenge: 3 puzzles, share link, a friend races your ghost', async () => {
  await home(); await page.click('#btn-daily');
  for (let r = 0; r < 3; r++) { await roundActive(); await sleep(600 + r * 200); await solveNow(); await sleep(400); }
  await finalShown();
  assert.strictEqual(await page.textContent('#final-title'), 'Daily complete!');
  assert.ok(await isVisible(page, 'btn-share-qr'), 'QR option shown for daily');
  await page.click('#btn-share-result');
  const text = await page.evaluate(() => navigator.clipboard.readText());
  const link = text.split('👉 ')[1];
  assert.match(link, /#c=/);

  const friend = await ctx.newPage(); watchErrors(friend, errors);
  await friend.goto(link);
  await waitFor(() => isVisible(friend, 'challenge-banner'), 5000, 'challenge banner');
  await friend.click('#challenge-banner button');
  await friend.waitForFunction(() => PD.app.round && PD.app.round.active, null, { timeout: 20000 });
  await sleep(1500);
  assert.strictEqual(await friend.evaluate(() => PD.app.round.prog.guest), 1, 'ghost already finished puzzle 1');
  await friend.close();
});

test('practice: the personal-best ghost never ends the round; no time limit', async () => {
  await home();
  await page.evaluate(() => localStorage.setItem('pduel.stats', JSON.stringify({ best: { 'odd:normal': 1000 } })));
  await page.click('.practice-diff [data-v=normal]');
  await page.click('.pl-item:has-text("Odd One Out")');
  await roundActive();
  assert.match(await page.textContent('#hud-opp-name'), /Your best 1\.0s/);
  await sleep(3000);
  assert.ok(await page.evaluate(() => PD.app.round.active), 'still playing after the ghost finished');
  await page.evaluate(() => { PD.app.round.startAt -= 400000; }); // way past any time limit
  await sleep(300);
  assert.ok(await page.evaluate(() => PD.app.round.active), 'no time limit');
  await solveNow();
  await finalShown();
  assert.strictEqual(await page.textContent('#final-title'), 'Solved!');

  await page.evaluate(() => localStorage.setItem('pduel.stats', JSON.stringify({ best: { 'odd:normal': 60000 } })));
  await page.click('#btn-final-home');
  await page.click('.pl-item:has-text("Odd One Out")');
  await roundActive(); await sleep(500); await solveNow();
  await finalShown();
  assert.strictEqual(await page.textContent('#final-title'), 'New personal best!');
  assert.deepStrictEqual(errors, []);
});
