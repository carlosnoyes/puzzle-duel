// Brief dropouts mid-match: both sides pause, the guest reconnects automatically, the match
// resumes with scores intact and the interrupted round replayed. If the player never comes back,
// the old behaviour applies once the reconnect window (shortened to 6s here via ?resume=) runs out.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { launch, serve, waitFor, sleep, screenOf, startBroker, Harness } = require('./helpers');

let browser, H, broker, Q;
before(async () => {
  broker = await startBroker();
  Q = '?resume=6000&relay=' + broker.url;
  browser = await launch();
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 900 } });
  await serve(ctx, { mockPeer: true });
  H = await Harness.open(ctx);
});
after(async () => { await browser.close(); broker.close(); });

const ev = (n, fn, a) => H.ev(n, fn, a);
const active = (n, i) => ev(n, i => !!(PD.app.round && PD.app.round.active && (i == null || PD.app.round.i === i)), i);
const scores = n => ev(n, () => PD.app.match && PD.app.match.scores);
const overlayOn = n => ev(n, () => !document.getElementById('reconnect').classList.contains('hidden'));
const kill = n => H.page.evaluate(n => window.__mockKill(n), n); // cut this player's connection, page stays open
// a phone that died: network cut and it never rejoins (closing a tab instead sends a goodbye = immediate leave)
const dies = async n => { await ev(n, () => { PD.Net.create = () => ({ join() {}, host() {}, send() {}, close() {}, drop() {}, wake() {} }); }); await kill(n); };

async function room() {
  const h = await H.add('Hosty', { query: Q });
  await ev(h, () => document.getElementById('btn-create').click());
  await waitFor(() => ev(h, () => !document.getElementById('copy-link').disabled), 15000, 'room open');
  const code = await ev(h, () => PD.app.code);
  const g = await H.add('Guesty', { query: Q, hash: '#' + code });
  await waitFor(() => ev(g, () => PD.app.connected && PD.app.oppName != null), 15000, 'guest in');
  await ev(h, () => { PD.app.settings.pool = ['hunt', 'odd', 'math']; PD.app.settings.rounds = 3; PD.app.settings.order = 'random'; document.getElementById('btn-start').click(); });
  await waitFor(async () => (await active(h, 0)) && (await active(g, 0)), 15000, 'round 1');
  return { h, g };
}

test('friend room: a dropped connection pauses both sides, then resumes with scores intact', async () => {
  await H.reset();
  const { h, g } = await room();
  await ev(g, () => PD.app.round.attempt.api.done());                      // guest wins round 1
  await waitFor(async () => (await active(h, 1)) && (await active(g, 1)), 15000, 'round 2');
  const before = await ev(h, () => PD.app.round.seed);
  await kill(g);
  await waitFor(async () => (await overlayOn(h)) && (await overlayOn(g)), 5000, 'both show reconnecting');
  assert.ok(!(await active(g)), 'puzzle paused during the dropout');
  await waitFor(async () => !(await overlayOn(h)) && !(await overlayOn(g)), 15000, 'resumed');
  assert.deepStrictEqual(await scores(h), { host: 0, guest: 1 });
  assert.deepStrictEqual(await scores(g), { host: 0, guest: 1 });
  await waitFor(async () => (await active(h, 1)) && (await active(g, 1)), 15000, 'round 2 replayed');
  assert.notStrictEqual(await ev(h, () => PD.app.round.seed), before, 'replayed round uses a fresh puzzle');
  assert.strictEqual(await ev(h, () => PD.app.round.pid), await ev(g, () => PD.app.round.pid));
  await ev(g, () => PD.app.round.attempt.api.done());                      // guest wins again: 2-0
  await waitFor(async () => (await screenOf(H.frame(h))) === 'screen-final', 15000, 'match finished');
  assert.match(await ev(g, () => document.getElementById('final-title').textContent), /Victory/);
});

test('friend room: a player who never comes back is treated as gone once the window expires', async () => {
  await H.reset();
  const { h, g } = await room();
  await dies(g);
  await waitFor(() => overlayOn(h), 5000, 'host waits');
  const t0 = Date.now();
  await waitFor(async () => (await screenOf(H.frame(h))) === 'screen-lobby', 15000, 'host back in lobby');
  assert.ok(Date.now() - t0 > 4000, 'waited for the reconnect window');
  assert.match(await ev(h, () => document.getElementById('toast').textContent), /disconnected|left/);
});

test('friend room: "Leave match" on the reconnect screen leaves immediately', async () => {
  await H.reset();
  const { h, g } = await room();
  await kill(g);
  await waitFor(() => overlayOn(g), 5000, 'guest reconnecting');
  await H.isolateHistory(g);
  await ev(g, () => document.getElementById('reconnect-leave').click());
  assert.strictEqual(await screenOf(H.frame(g)), 'screen-home');
});

test('ranked Quick Match: dropout resumes over a private resume code; Elo is applied once', async () => {
  await H.reset();
  const a = await H.add('Alice', { query: Q }), b = await H.add('Bob', { query: Q });
  await ev(a, () => document.getElementById('btn-quick').click()); await sleep(200);
  await ev(b, () => document.getElementById('btn-quick').click());
  await waitFor(async () => (await active(a, 0)) && (await active(b, 0)), 40000, 'ranked round 1');
  const guest = (await ev(a, () => PD.app.mode)) === 'guest' ? a : b, host = guest === a ? b : a;
  await kill(guest);
  await waitFor(async () => (await overlayOn(host)) && (await overlayOn(guest)), 5000, 'both reconnecting');
  await waitFor(async () => !(await overlayOn(host)) && !(await overlayOn(guest)), 20000, 'resumed');
  for (let r = 0; r < 2; r++) {
    await waitFor(async () => (await active(host, r)) && (await active(guest, r)), 15000, 'ranked round ' + (r + 1));
    await ev(host, () => PD.app.round.attempt.api.done());
  }
  await waitFor(async () => (await screenOf(H.frame(guest))) === 'screen-final', 15000, 'final');
  assert.strictEqual(((await H.storage(host, 'elo')) || {}).r, 1020);
  assert.strictEqual(((await H.storage(guest, 'elo')) || {}).r, 980);
});

test('closing the tab mid-match is an immediate leave, not a dropout', async () => {
  await H.reset();
  const { h, g } = await room();
  await H.remove(g);
  await waitFor(async () => (await screenOf(H.frame(h))) === 'screen-lobby', 5000, 'host back in lobby at once');
});

test('ranked Quick Match: opponent gone for good -> forfeit win after the window', async () => {
  await H.reset();
  const a = await H.add('Cara', { query: Q }), b = await H.add('Dan', { query: Q });
  await ev(a, () => document.getElementById('btn-quick').click()); await sleep(200);
  await ev(b, () => document.getElementById('btn-quick').click());
  await waitFor(async () => (await active(a, 0)) && (await active(b, 0)), 40000, 'ranked round 1');
  await dies(b);
  await waitFor(() => overlayOn(a), 5000, 'waiting for Dan');
  await waitFor(async () => /forfeit/.test(await ev(a, () => document.getElementById('toast').textContent)), 20000, 'forfeit win');
  assert.strictEqual(((await H.storage(a, 'elo')) || {}).r, 1020);
  assert.deepStrictEqual(H.errors, []);
});
