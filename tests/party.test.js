// Party rooms (3–8 players): host is the hub; scoring by finishing order; late joiners; leavers.
// Uses the mock PeerJS cloud plus a real local MQTT broker, with each player in an iframe.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { launch, serve, waitFor, sleep, screenOf, startBroker, Harness } = require('./helpers');

let browser, H, broker, Q, host, code, g = [];
before(async () => {
  broker = await startBroker();
  Q = '?relay=' + broker.url;
  browser = await launch();
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  await serve(ctx, { mockPeer: true });
  H = await Harness.open(ctx);
});
after(async () => { await browser.close(); broker.close(); });

const ev = (n, fn, a) => H.ev(n, fn, a);
const players = n => ev(n, () => [...document.querySelectorAll('#party-players .pp:not(.empty) .pp-name')].map(e => e.textContent));
const inRound = (n, i) => ev(n, i => !!(PD.app.party && PD.app.party.round && PD.app.party.round.i === i && PD.app.party.round.active), i);
const finish = n => ev(n, () => PD.app.party.round.api.done()); // same path as solving the puzzle
const resultTotals = n => ev(n, () => PD.app.party.totals);

test('host opens a party; three friends join by link; everyone sees the same player list', async () => {
  host = await H.add('Hana', { query: Q });
  await ev(host, () => document.getElementById('btn-party').click());
  await waitFor(() => ev(host, () => !document.getElementById('copy-link').disabled), 15000, 'party room open');
  assert.strictEqual(await ev(host, () => document.getElementById('lobby-title').textContent), 'Party room');
  assert.ok(await ev(host, () => document.getElementById('btn-start').disabled), 'needs 2+ players');
  code = await ev(host, () => PD.app.code);
  for (const name of ['Ari', 'Bo', 'Cy']) g.push(await H.add(name, { query: Q, hash: '#' + code }));
  await waitFor(async () => (await players(host)).length === 4, 20000, 'host sees 4');
  for (const n of g) await waitFor(async () => (await players(n)).length === 4, 10000, n + ' sees 4');
  assert.deepStrictEqual((await players(g[2])).sort(), ['Ari', 'Bo', 'Cy', 'Hana']);
  assert.strictEqual(await ev(g[0], () => document.getElementById('lobby-title').textContent), 'Party room');
  assert.ok(await ev(host, () => !document.getElementById('btn-start').disabled));
});

test('round 1: same puzzle for all, live board, points by finishing order (give-up scores 0)', async () => {
  await ev(host, () => { document.querySelector('#settings-panel [data-setting=rounds] [data-v="3"]').click(); });
  await ev(host, () => document.getElementById('btn-start').click());
  for (const n of [host, ...g]) await waitFor(() => inRound(n, 0), 15000, n + ' round 1');
  const pids = await Promise.all([host, ...g].map(n => ev(n, () => PD.app.party.round.pid)));
  assert.strictEqual(new Set(pids).size, 1, 'same puzzle for everyone');
  assert.strictEqual(await ev(g[0], () => document.querySelectorAll('#party-board .pb-row').length), 4);
  await ev(g[1], () => PD.app.party.round.api.progress(0.5));
  await sleep(700);
  assert.match(await ev(g[0], () => [...document.querySelectorAll('#party-board .pb-row')].find(r => r.textContent.includes('Bo')).querySelector('.pb-fill').style.width), /50%/);
  // Bo 1st, Hana 2nd, Ari 3rd, Cy gives up
  await finish(g[1]); await sleep(150); await finish(host); await sleep(150); await finish(g[0]);
  await ev(g[2], () => { window.confirm = () => true; document.getElementById('btn-forfeit').click(); });
  await waitFor(() => ev(g[0], () => !document.getElementById('result').classList.contains('hidden')), 10000, 'result shown');
  const expected = { Bo: 5, Hana: 3, Ari: 2, Cy: 0 };
  for (const n of [host, ...g]) {
    const t = await resultTotals(n);
    const byName = await ev(n, t => Object.fromEntries(Object.entries(t).map(([id, v]) => [PD.app.party.nameOf(id), v])), t);
    assert.deepStrictEqual(byName, expected, 'totals on ' + n);
  }
  assert.match(await ev(g[1], () => document.getElementById('res-title').textContent), /You won the round/);
  assert.match(await ev(g[0], () => document.getElementById('res-title').textContent), /3rd/);
});

let late;
test('round 2: a late arrival waits for the next match; a player leaving mid-round doesn’t stall it', async () => {
  for (const n of [host, ...g]) await waitFor(() => inRound(n, 1), 15000, n + ' round 2');
  late = await H.add('Dee', { query: Q, hash: '#' + code });
  await waitFor(async () => (await ev(host, () => PD.app.party.players.length)) === 5, 15000, 'late joiner added');
  assert.ok(await ev(late, () => PD.app.party.waiting), 'late joiner is waiting');
  assert.ok(!(await ev(late, () => !!(PD.app.party.round && PD.app.party.round.active))), 'late joiner not playing');
  await H.remove(g[2]); // Cy closes the tab mid-round
  await waitFor(async () => !(await ev(host, () => PD.app.party.players.some(p => p.name === 'Cy'))), 15000, 'Cy removed');
  await finish(host); await finish(g[0]); await finish(g[1]);
  await waitFor(() => ev(host, () => PD.app.party.round && !PD.app.party.round.active && !document.getElementById('result').classList.contains('hidden')), 10000, 'round 2 resolved without Cy');
});

test('round 3: once half have finished, a straggler gets 20 seconds', async () => {
  for (const n of [host, g[0], g[1]]) await waitFor(() => inRound(n, 2), 15000, n + ' round 3');
  await finish(host); await finish(g[0]);           // 2 of 3 done -> 20s grace for Bo
  const t0 = Date.now();
  await waitFor(() => ev(g[1], () => /left to finish/.test(document.getElementById('toast').textContent)), 5000, 'hurry warning');
  await waitFor(() => ev(host, () => !document.getElementById('result').classList.contains('hidden')), 30000, 'round ended');
  const waited = (Date.now() - t0) / 1000;
  assert.ok(waited > 15 && waited < 26, 'grace period ~20s, was ' + waited);
});

test('final standings match everywhere; Play again includes the late arrival', async () => {
  for (const n of [host, g[0], g[1], late]) await waitFor(async () => (await screenOf(H.frame(n))) === 'screen-final', 15000, n + ' final');
  const table = n => ev(n, () => [...document.querySelectorAll('#final-history tr')].slice(1).map(r => r.children[1].textContent + ':' + r.children[2].textContent).join(','));
  const ref = await table(host);
  for (const n of [g[0], g[1]]) assert.strictEqual(await table(n), ref);
  assert.ok(await ev(host, () => !document.getElementById('btn-rematch').classList.contains('hidden')));
  assert.ok(await ev(g[0], () => document.getElementById('btn-rematch').classList.contains('hidden')), 'only the host restarts');
  await ev(host, () => document.getElementById('btn-rematch').click());
  for (const n of [host, g[0], g[1], late]) await waitFor(() => inRound(n, 0), 15000, n + ' in new match');
  assert.strictEqual(await ev(late, () => document.querySelectorAll('#party-board .pb-row').length), 4);
});

test('a full party turns new players away; host leaving tells everyone', async () => {
  await ev(host, () => { PD.app.net.capacity = 3; }); // pretend the room is at its limit
  const extra = await H.add('Eli', { query: Q, hash: '#' + code });
  await waitFor(() => ev(extra, () => /full/.test(document.getElementById('toast').textContent)), 15000, 'full message');
  await H.isolateHistory(host);
  await ev(host, () => PD._app.goHome());
  await waitFor(() => ev(g[0], () => /closed the party|Lost connection/.test(document.getElementById('toast').textContent)), 10000, 'guests told');
  assert.strictEqual(await screenOf(H.frame(g[0])), 'screen-home');
  assert.deepStrictEqual(H.errors, []);
});
