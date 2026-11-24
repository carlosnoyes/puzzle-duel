// Quick Match (ranked, no backend) against the mock PeerJS cloud, with several players as iframes.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { launch, serve, waitFor, sleep, screenOf, Harness } = require('./helpers');

let browser, H;
before(async () => {
  browser = await launch();
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  await serve(ctx, { mockPeer: true });
  H = await Harness.open(ctx);
});
after(async () => { await browser.close(); });

const opp = n => H.ev(n, () => PD.app.oppName);
const quick = n => H.ev(n, () => document.getElementById('btn-quick').click());
const elo = async n => ((await H.storage(n, 'elo')) || { r: 1000 }).r;
const scr = n => screenOf(H.frame(n));

async function playMatch(a, b, winner) {
  await waitFor(async () => (await scr(a)) === 'screen-game' && (await scr(b)) === 'screen-game', 15000, 'both in game');
  for (let r = 0; r < 3; r++) {
    await waitFor(async () => (await H.ev(a, () => !!(PD.app.round && PD.app.round.active))) && (await H.ev(b, () => !!(PD.app.round && PD.app.round.active))), 15000, 'round active');
    await sleep(300);
    await H.ev(winner, () => PD.app.round.attempt.api.done());
    try { await waitFor(async () => (await scr(a)) === 'screen-final', 5000, 'final'); break; } catch (e) { /* next round */ }
  }
  await waitFor(async () => (await scr(a)) === 'screen-final' && (await scr(b)) === 'screen-final', 15000, 'both final');
}

let A, B;
test('two players searching find each other; Elo moves +20/-20; rematch is rated too', async () => {
  A = await H.add('Alice'); B = await H.add('Bob');
  await quick(A); await sleep(200); await quick(B);
  await waitFor(async () => (await opp(A)) === 'Bob' && (await opp(B)) === 'Alice', 30000, 'matched');
  const roles = [await H.ev(A, () => PD.app.mode), await H.ev(B, () => PD.app.mode)].sort();
  assert.deepStrictEqual(roles, ['guest', 'host']);
  await playMatch(A, B, A);
  assert.deepStrictEqual([await elo(A), await elo(B)], [1020, 980]);
  await sleep(1800);
  assert.deepStrictEqual(await H.page.evaluate(() => [...window.__mock.ids.keys()].filter(k => k.includes('qm'))), [], 'waiting room released');
  await H.ev(B, () => document.getElementById('btn-rematch').click());
  await H.ev(A, () => document.getElementById('btn-rematch').click());
  await playMatch(A, B, B);
  assert.deepStrictEqual([await elo(A), await elo(B)], [998, 1002]);
});

test('closing the tab mid-match: leaver loses on next launch, opponent wins by forfeit', async () => {
  await H.ev(A, () => document.getElementById('btn-final-home').click());
  await H.ev(B, () => document.getElementById('btn-final-home').click());
  await waitFor(async () => (await scr(A)) === 'screen-game' && (await scr(B)) === 'screen-game', 40000, 're-matched');
  await waitFor(() => H.ev(A, () => !!(PD.app.round && PD.app.round.active)), 15000, 'round');
  await H.page.evaluate(n => { document.querySelector(`iframe[name="${n}"]`).src = '/index.html'; }, B);
  await waitFor(async () => /forfeit/.test(await H.ev(A, () => document.getElementById('toast').textContent)), 8000, 'forfeit toast');
  await waitFor(async () => /counted as a loss/.test(await H.ev(B, () => document.getElementById('toast').textContent)), 8000, 'loss toast');
  assert.deepStrictEqual([await elo(A), await elo(B)], [1018, 982]);
});

test('skill bands: similar ratings pair first; a far-off player matches once the search widens', async () => {
  const C = await H.add('Carol', { storage: { elo: { r: 1700, g: 20, w: 10, l: 10, d: 0, best: 1700 } } });
  const D = await H.add('Dave');
  await quick(C); await sleep(1500);
  await quick(A); await sleep(300); await quick(D);
  await waitFor(async () => (await opp(A)) === 'Dave' && (await opp(D)) === 'Alice', 30000, 'Alice-Dave');
  assert.strictEqual(await scr(C), 'screen-search');
  await quick(B);
  await waitFor(async () => (await opp(C)) === 'Bob', 90000, 'Carol-Bob after widening');
});

test('three searching at once: two pair up, the third pairs with the next arrival', async () => {
  await H.reset();
  const ps = [await H.add('Eve'), await H.add('Finn'), await H.add('Gus')];
  await Promise.all(ps.map(quick));
  await waitFor(async () => (await Promise.all(ps.map(opp))).filter(Boolean).length === 2, 30000, 'pair');
  const lone = ps[(await Promise.all(ps.map(opp))).indexOf(null)];
  const h8 = await H.add('Hana'); await quick(h8);
  try { await waitFor(async () => (await opp(lone)) && (await opp(h8)), 40000, 'leftover matched'); }
  catch (e) {
    const st = async n => n + ': ' + await H.ev(n, () => document.getElementById('search-status').textContent + ' / opp=' + PD.app.oppName + ' / mode=' + PD.app.mode);
    throw new Error(e.message + ' | ' + await st(lone) + ' | ' + await st(h8) + ' | ids=' + await H.page.evaluate(() => [...window.__mock.ids.keys()].join(',')) + ' | log=' + JSON.stringify(await H.page.evaluate(() => window.__mock.log.slice(-6))));
  }
  assert.deepStrictEqual(H.errors, []);
});
