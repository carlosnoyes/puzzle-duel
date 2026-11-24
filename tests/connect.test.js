// Friend-room connectivity under failure: mock PeerJS cloud (with failure switches) plus two REAL
// MQTT brokers (Aedes) standing in for the public relay brokers.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { launch, serve, waitFor, sleep, screenOf, startBroker, Harness } = require('./helpers');

let browser, H, A, B, both;
before(async () => {
  A = await startBroker(); B = await startBroker();
  both = '?relay=' + [A.url, B.url].join(',');
  browser = await launch();
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 900 } });
  await serve(ctx, { mockPeer: true });
  H = await Harness.open(ctx);
});
after(async () => { await browser.close(); A.close(); B.close(); });

const via = n => H.ev(n, () => PD.app.net && PD.app.net.via);
const connected = n => H.ev(n, () => PD.app.connected && PD.app.oppName != null);
const hint = n => H.ev(n, () => document.getElementById('invite-hint').textContent);
const toast = n => H.ev(n, () => document.getElementById('toast').textContent);

async function hostRoom(query = both) {
  const h = await H.add('Hosty', { query });
  await H.ev(h, () => document.getElementById('btn-create').click());
  await waitFor(() => H.ev(h, () => !document.getElementById('copy-link').disabled), 15000, 'room open');
  return { h, code: await H.ev(h, () => PD.app.code) };
}
async function playRound(h, g) {
  await H.ev(h, () => { PD.app.settings.pool = ['hunt']; document.getElementById('btn-start').click(); });
  await waitFor(async () => (await H.ev(h, () => !!(PD.app.round && PD.app.round.active))) && (await H.ev(g, () => !!(PD.app.round && PD.app.round.active))), 15000, 'round');
  await H.ev(g, () => PD.app.round.attempt.api.progress(0.5)); await sleep(500);
  assert.strictEqual(await H.ev(h, () => PD.app.round.prog.guest), 0.5, 'host sees guest progress');
  await H.ev(g, () => PD.app.round.attempt.api.done());
  await waitFor(() => H.ev(h, () => PD.app.match && PD.app.match.scores.guest === 1), 8000, 'result reached host');
}

test('normal: share buttons wait for the room; friend connects directly', async () => {
  await H.reset();
  const h = await H.add('Hosty', { query: both });
  await H.ev(h, () => document.getElementById('btn-create').click());
  assert.ok(await H.ev(h, () => document.getElementById('copy-link').disabled && document.getElementById('qr-link').disabled), 'disabled before open');
  await waitFor(() => H.ev(h, () => !document.getElementById('copy-link').disabled), 15000, 'open');
  // the room opens on whichever route is ready first; both should be up shortly after
  await waitFor(async () => /Room open \(direct \+ relay\)/.test(await hint(h)), 10000, 'both routes open');
  const code = await H.ev(h, () => PD.app.code);
  const g = await H.add('Guesty', { query: both, hash: '#' + code });
  await waitFor(() => connected(g), 15000, 'connected');
  assert.strictEqual(await via(g), 'p2p');
  await playRound(h, g);
});

test('direct link blocked by the network -> relay takes over and the game works', async () => {
  await H.reset({ failRTC: true });
  const { h, code } = await hostRoom();
  const g = await H.add('Guesty', { query: both, hash: '#' + code });
  await waitFor(() => connected(g), 20000, 'connected');
  assert.strictEqual(await via(g), 'relay');
  await playRound(h, g);
  assert.match(await H.ev(g, () => document.getElementById('hud-ping').textContent), /relay/);
});

test('PeerJS server down -> room opens on the relay alone', async () => {
  await H.reset({ serverDown: true });
  const { h, code } = await hostRoom();
  assert.match(await hint(h), /Room open \(relay\)/);
  const g = await H.add('Guesty', { query: both, hash: '#' + code });
  await waitFor(() => connected(g), 20000, 'connected');
  await playRound(h, g);
});

test('host connection blip (app backgrounded) keeps the same room code', async () => {
  await H.reset();
  const { h, code } = await hostRoom('?norelay');
  await H.page.evaluate(id => window.__mockBlip(id, 3000), 'pduel-v1-' + code);
  await sleep(300);
  assert.match(await hint(h), /Opening room/);
  await waitFor(async () => /Room open/.test(await hint(h)), 20000, 'reopened');
  assert.strictEqual(await H.ev(h, () => PD.app.code), code);
  const g = await H.add('Guesty', { query: '?norelay', hash: '#' + code });
  await waitFor(() => connected(g), 15000, 'joined original code');
});

test('friend joins while the host is reconnecting -> gets in over the relay', async () => {
  await H.reset();
  const { code } = await hostRoom();
  await H.page.evaluate(id => window.__mockBlip(id, 8000), 'pduel-v1-' + code);
  const g = await H.add('Guesty', { query: both, hash: '#' + code });
  await waitFor(() => connected(g), 20000, 'connected');
  assert.strictEqual(await via(g), 'relay');
});

test('typed code (messy) and pasted full link both work; links opened into an open page join', async () => {
  await H.reset();
  let { code } = await hostRoom();
  const g = await H.add('Guesty', { query: both });
  await H.ev(g, c => { document.getElementById('join-code').value = ' ' + c.toLowerCase().split('').join(' ') + ' '; document.getElementById('btn-join').click(); }, code);
  await waitFor(() => connected(g), 15000, 'typed');
  await H.reset();
  ({ code } = await hostRoom());
  const g2 = await H.add('Guesty', { query: both });
  await H.ev(g2, c => { document.getElementById('join-code').value = 'https://carlosnoyes.github.io/puzzle-duel/#' + c; document.getElementById('btn-join').click(); }, code);
  await waitFor(() => connected(g2), 15000, 'pasted link');
  await H.reset();
  ({ code } = await hostRoom());
  const g3 = await H.add('Guesty', { query: both });
  await H.ev(g3, c => { location.hash = '#' + c; }, code);
  await waitFor(() => connected(g3), 15000, 'hash change');
});

test('room full: a third person is told so, the first friend stays connected', async () => {
  await H.reset();
  const { code } = await hostRoom();
  const g = await H.add('Guesty', { query: both, hash: '#' + code });
  await waitFor(() => connected(g), 15000, 'g1');
  const g3 = await H.add('Thirdy', { query: both, hash: '#' + code });
  await waitFor(async () => /two players/.test(await toast(g3)), 15000, 'full message');
  assert.ok(await connected(g));
});

test('friend can only reach one relay broker (and direct is blocked)', async () => {
  await H.reset({ failRTC: true });
  const { h, code } = await hostRoom();
  const g = await H.add('Guesty', { query: '?relay=' + B.url, hash: '#' + code });
  await waitFor(() => connected(g), 20000, 'connected');
  await playRound(h, g);
});

test('host silent for 30s in the lobby (app in background) does not kick the friend', async () => {
  await H.reset();
  const { h, code } = await hostRoom();
  const g = await H.add('Guesty', { query: both, hash: '#' + code });
  await waitFor(() => connected(g), 15000, 'connected');
  await H.ev(h, () => { PD.app.net.send = () => {}; });
  await H.ev(g, () => { PD.app.lastSeen = Date.now() - 30000; });
  await sleep(2500);
  assert.strictEqual(await screenOf(H.frame(g)), 'screen-lobby');
});

test('leaving is detected over the relay in both directions; the room reopens', async () => {
  await H.reset({ failRTC: true });
  const { h, code } = await hostRoom();
  const g = await H.add('Guesty', { query: both, hash: '#' + code });
  await waitFor(() => connected(g), 20000, 'connected');
  await H.remove(g);
  await waitFor(async () => /disconnected/.test(await toast(h)), 10000, 'host told');
  const g2 = await H.add('Newbie', { query: both, hash: '#' + code });
  await waitFor(() => connected(g2), 20000, 'new friend');
  await H.isolateHistory(h);
  await H.ev(h, () => document.getElementById('lobby-leave').click());
  await waitFor(async () => /disconnected/.test(await toast(g2)), 10000, 'guest told');
});

test('connection check: reports each route and produces a copyable report with the connection log', async () => {
  await H.reset();
  const { h, code } = await hostRoom();               // generates some connection-log entries
  const g = await H.add('Guesty', { query: both, hash: '#' + code });
  await waitFor(() => connected(g), 15000, 'connected');
  await H.ev(g, () => document.getElementById('lobby-check').click());
  assert.strictEqual(await screenOf(H.frame(g)), 'screen-check');
  await waitFor(() => H.ev(g, () => /check-verdict (good|warn|bad)/.test(document.getElementById('check-verdict').className)), 20000, 'verdict');
  const rows = await H.ev(g, () => [...document.querySelectorAll('.check-row')].map(r => r.querySelector('.check-icon').textContent + ' ' + r.querySelector('.check-label').textContent));
  assert.ok(rows.some(r => r.startsWith('✅ Matchmaking server')), rows.join(' | '));
  assert.strictEqual(rows.filter(r => r.startsWith('✅ Backup relay')).length, 2, rows.join(' | '));
  const report = await H.ev(g, () => PD.Diagnostics.report(null));
  assert.match(report, /join: connected via p2p/);
  // back returns to the lobby with the room still connected
  await H.ev(g, () => document.getElementById('check-back').click());
  assert.strictEqual(await screenOf(H.frame(g)), 'screen-lobby');
  assert.ok(await connected(g));
});

test('connection check: relay-only network still says friend games will connect', async () => {
  await H.reset({ serverDown: true });
  const g = await H.add('Guesty', { query: both });
  await H.ev(g, () => document.getElementById('open-check').click());
  await waitFor(() => H.ev(g, () => /check-verdict (good|warn|bad)/.test(document.getElementById('check-verdict').className)), 20000, 'verdict');
  assert.match(await H.ev(g, () => document.getElementById('check-verdict').textContent), /backup relay works/);
});

test('wrong code gives a clear error instead of spinning forever', async () => {
  await H.reset();
  const g = await H.add('Guesty', { query: both });
  await H.ev(g, () => { document.getElementById('join-code').value = 'ZZZZZ'; document.getElementById('btn-join').click(); });
  await waitFor(async () => /reach that room/.test(await toast(g)), 35000, 'timeout error');
  assert.strictEqual(await screenOf(H.frame(g)), 'screen-home');
  assert.deepStrictEqual(H.errors, []);
});
