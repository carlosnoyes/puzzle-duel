// Online room flow between two tabs (BroadcastChannel transport): lobby, match, loser picks,
// rematch, disconnect + new guest, freeze power-up and its overlap rules.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { launch, serve, watchErrors, waitFor, sleep, screenOf, isVisible } = require('./helpers');

let browser, ctx, host, guest, errors, code;
before(async () => {
  browser = await launch();
  ctx = await browser.newContext({ viewport: { width: 900, height: 900 } });
  await serve(ctx);
  host = await ctx.newPage(); guest = await ctx.newPage();
  errors = watchErrors(host); watchErrors(guest, errors);
  await host.goto('http://duel.test/?net=bc');
});
after(async () => { await browser.close(); });

const active = p => p.waitForFunction(() => PD.app.round && PD.app.round.active, null, { timeout: 15000 });

test('guest joins by link; host settings sync to the guest', async () => {
  await host.click('#btn-create');
  await waitFor(() => host.evaluate(() => !document.getElementById('copy-link').disabled), 5000, 'room open');
  code = await host.textContent('#room-code');
  await guest.goto('http://duel.test/?net=bc#' + code);
  await waitFor(async () => (await host.textContent('#lobby-opp')) !== 'Waiting…', 5000, 'guest shown to host');
  await host.click('[data-setting=rounds] [data-v="3"]');
  await host.click('[data-setting=order] [data-v=pick]');
  await sleep(200);
  assert.strictEqual(await guest.$eval('[data-setting=rounds] .on', e => e.textContent), 'Best of 3');
  assert.ok(await host.evaluate(() => !document.getElementById('btn-start').disabled));
});

test('match: both get the same puzzle, loser picks the next one, scores agree, rematch works', async () => {
  await host.evaluate(() => { PD.app.settings.pool = PD.Puzzles.list.map(p => p.id); });
  await host.click('#btn-start');
  await active(host); await active(guest);
  assert.strictEqual(await host.evaluate(() => PD.app.round.pid + PD.app.round.seed), await guest.evaluate(() => PD.app.round.pid + PD.app.round.seed));
  await guest.evaluate(() => PD.app.round.attempt.api.done()); // guest wins round 1 -> host picks
  await host.waitForSelector('#pick:not(.hidden)', { timeout: 8000 });
  await host.click('.pick-btn[data-pid=memory]');
  await active(guest);
  assert.strictEqual(await guest.evaluate(() => PD.app.round.pid), 'memory');
  await host.evaluate(() => PD.app.round.attempt.api.done()); // 1-1, guest picks
  await guest.waitForSelector('#pick:not(.hidden)', { timeout: 8000 });
  await guest.click('.pick-btn[data-pid=math]');
  await active(host);
  await host.evaluate(() => PD.app.round.attempt.api.done()); // host wins 2-1
  await waitFor(() => isVisible(guest, 'screen-final'), 10000, 'final');
  assert.strictEqual(await host.textContent('#final-title'), 'Victory!');
  assert.match(await guest.textContent('#final-score'), /1\s*–\s*2/);
  await guest.click('#btn-rematch'); await host.click('#btn-rematch');
  await waitFor(() => isVisible(guest, 'screen-game'), 5000, 'rematch started');
});

test('freeze: earned at 50%, locks the rival for 3s; overlapping freezes keep the longer one', async () => {
  await active(host); await active(guest);
  const pid = await host.evaluate(() => PD.app.round.pid);
  // make sure we're on a puzzle with a known 50% path: force progress directly
  await host.evaluate(() => PD.app.round.attempt.api.progress(0.6));
  assert.ok(await host.evaluate(() => !document.getElementById('btn-power').disabled), 'freeze ready at 60% on ' + pid);
  // A) guest already has a 4s penalty; the 3s freeze must not shorten it
  await guest.evaluate(() => PD.app.round.attempt.api.penalty(4000, 'BOOM! Mine hit'));
  await sleep(300);
  await host.click('#btn-power'); await sleep(250);
  assert.strictEqual(await guest.textContent('#pen-msg'), 'BOOM! Mine hit');
  const left = await guest.evaluate(() => PD.app.round.frozenUntil - performance.now());
  assert.ok(left > 3000, 'kept the longer penalty, left=' + Math.round(left));
  // B) a longer penalty during a freeze takes over; C) a shorter one is ignored
  await guest.waitForFunction(() => document.getElementById('penalty').classList.contains('hidden'), null, { timeout: 6000 });
  await guest.evaluate(() => PD.app.round.attempt.api.penalty(3000, 'freeze'));
  await sleep(500);
  assert.strictEqual(await guest.evaluate(() => PD.app.round.attempt.api.penalty(1000, 'short')), 0);
  assert.ok(await guest.evaluate(() => PD.app.round.attempt.api.penalty(5000, 'long')) > 0);
  assert.strictEqual(await guest.textContent('#pen-msg'), 'long');
});

test('guest leaving returns the host to the lobby; a new guest can join the same room', async () => {
  await guest.close({ runBeforeUnload: true });
  await waitFor(async () => (await screenOf(host)) === 'screen-lobby', 5000, 'host back in lobby');
  assert.match(await host.textContent('#toast'), /disconnected/);
  const g2 = await ctx.newPage(); watchErrors(g2, errors);
  await g2.goto('http://duel.test/?net=bc#' + code);
  await waitFor(async () => (await host.textContent('#lobby-opp')) !== 'Waiting…', 5000, 'new guest');
  assert.ok(await host.evaluate(() => !document.getElementById('btn-start').disabled));
  assert.deepStrictEqual(errors, []);
});
