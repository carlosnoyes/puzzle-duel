// Every puzzle: identical for both players (seeded), fast to generate, and solvable through its real UI.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { launch, serve, watchErrors } = require('./helpers');

let browser, page, errors;
before(async () => {
  browser = await launch();
  const ctx = await browser.newContext();
  await serve(ctx);
  page = await ctx.newPage();
  errors = watchErrors(page);
  await page.goto('http://duel.test/?net=bc');
});
after(async () => { await browser.close(); });

test('every puzzle is deterministic from its seed and generates quickly', async () => {
  const bad = await page.evaluate(() => {
    const out = [];
    for (const p of PD.Puzzles.list) for (const diff of ['easy', 'normal', 'hard']) for (const seed of [1, 777, 123456]) {
      const mk = () => { const r = document.createElement('div'); const h = p.create(r, { rng: PD.makeRng(seed), diff, progress() {}, done() {}, penalty() {} }); h && h.destroy && h.destroy(); return r.innerHTML; };
      const t0 = performance.now(); const a = mk(); const ms = performance.now() - t0;
      if (a !== mk()) out.push(`${p.id}/${diff}/${seed}: not deterministic`);
      if (ms > 250) out.push(`${p.id}/${diff}/${seed}: slow (${Math.round(ms)}ms)`);
    }
    return out;
  });
  assert.deepStrictEqual(bad, []);
});

// In-page solvers that only use what a player can see, driving the real controls.
const SOLVERS = String.raw`
const press = n => n.dispatchEvent(new PointerEvent('pointerdown', { button: 0, bubbles: true }));
const key = (h, k) => h.onKey({ key: k, preventDefault() {} });
const sleep = ms => new Promise(r => setTimeout(r, ms));
window.__solvers = {
  hunt(root) { const cells = [...root.querySelectorAll('.hunt-cell')]; for (let v = 1; v <= cells.length; v++) press(cells.find(c => c.textContent === String(v))); },
  odd(root) { for (let k = 0; k < 10; k++) { const cells = [...root.querySelectorAll('.odd-cell')]; const cnt = {}; cells.forEach(c => cnt[c.textContent] = (cnt[c.textContent] || 0) + 1); press(cells.find(c => cnt[c.textContent] === 1)); } },
  memory(root) { const by = {}; root.querySelectorAll('.card').forEach(c => { const f = c.querySelector('.card-face').textContent; (by[f] = by[f] || []).push(c); }); for (const f in by) { press(by[f][0]); press(by[f][1]); } },
  math(root, h) { for (let k = 0; k < 10; k++) { const q = root.querySelector('.math-q').textContent.replace('=', '').replace('×', '*').replace('÷', '/'); for (const ch of String(Math.round(Function('return ' + q)()))) key(h, ch); } },
  sudoku(root, h) {
    const cells = [...root.querySelectorAll('.scell')], n = Math.round(Math.sqrt(cells.length)), [br, bc] = n === 4 ? [2, 2] : [2, 3];
    const g = cells.map(c => +c.textContent || 0);
    const ok = (i, v) => { const r = Math.floor(i / n), c = i % n; for (let k = 0; k < n; k++) if (g[r * n + k] === v || g[k * n + c] === v) return false; const r0 = Math.floor(r / br) * br, c0 = Math.floor(c / bc) * bc; for (let a = 0; a < br; a++) for (let b = 0; b < bc; b++) if (g[(r0 + a) * n + c0 + b] === v) return false; return true; };
    const empty = g.map((v, i) => v ? -1 : i).filter(i => i >= 0);
    (function s(k) { if (k === empty.length) return true; const i = empty[k]; for (let v = 1; v <= n; v++) if (ok(i, v)) { g[i] = v; if (s(k + 1)) return true; g[i] = 0; } return false; })(0);
    empty.forEach(i => { press(cells[i]); key(h, String(g[i])); });
  },
  lights(root) {
    const cells = [...root.querySelectorAll('.light')], n = 5, s0 = cells.map(c => c.classList.contains('on'));
    for (let m = 0; m < 32; m++) {
      const st = s0.slice(), presses = [];
      const tog = i => { const r = Math.floor(i / n), c = i % n; [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]].forEach(([a, b]) => { const rr = r + a, cc = c + b; if (rr >= 0 && rr < n && cc >= 0 && cc < n) st[rr * n + cc] = !st[rr * n + cc]; }); presses.push(i); };
      for (let c = 0; c < n; c++) if (m >> c & 1) tog(c);
      for (let r = 1; r < n; r++) for (let c = 0; c < n; c++) if (st[(r - 1) * n + c]) tog(r * n + c);
      if (st.every(x => !x)) { presses.forEach(i => press(cells[i])); return; }
    }
  },
  slide(root) { // breadth-first search for the shortest solution (3x3 boards)
    const tiles = [...root.querySelectorAll('.slide-tile')], n = Math.round(Math.sqrt(tiles.length + 1));
    if (n !== 3) return 'skip';
    const size = parseFloat(root.querySelector('.slide-board').style.width) / n;
    const pos = t => { const m = t.style.transform.match(/translate\(([\d.]+)px, ([\d.]+)px\)/); return Math.round((+m[2] - 3) / size) * n + Math.round((+m[1] - 3) / size); };
    const start = new Array(9).fill(0); tiles.forEach(t => { start[pos(t)] = +t.textContent; });
    const goal = '123456780', key0 = start.join('');
    const prev = new Map([[key0, null]]), q = [key0];
    while (q.length) { const s = q.shift(); if (s === goal) break; const b = s.indexOf('0'), r = Math.floor(b / 3), c = b % 3;
      for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const rr = r + dr, cc = c + dc; if (rr < 0 || rr > 2 || cc < 0 || cc > 2) continue; const j = rr * 3 + cc, a = s.split(''); a[b] = a[j]; a[j] = '0'; const ns = a.join(''); if (!prev.has(ns)) { prev.set(ns, [s, s[j]]); q.push(ns); } } }
    const moves = []; for (let s = goal; prev.get(s); s = prev.get(s)[0]) moves.unshift(prev.get(s)[1]);
    moves.forEach(v => press(tiles.find(t => t.textContent === v)));
  },
  nono(root) { // row-by-row search, pruning on column clues
    const n = root.querySelectorAll('.nclue.row').length;
    const rows = [...root.querySelectorAll('.nclue.row')].map(e => e.textContent.trim().split(/\s+/).map(Number));
    const cols = [...root.querySelectorAll('.nclue.col')].map(e => [...e.children].map(s => +s.textContent));
    const runs = a => { const o = []; let k = 0; a.forEach(v => { if (v) k++; else if (k) { o.push(k); k = 0; } }); if (k) o.push(k); return o.length ? o : [0]; };
    const pats = clue => { const out = []; for (let m = 0; m < 1 << n; m++) { const a = Array.from({ length: n }, (_, i) => (m >> i) & 1); if (runs(a).join() === clue.join()) out.push(a); } return out; };
    const P = rows.map(pats), grid = [];
    const colOk = (c, final) => { const seg = grid.map(r => r[c]); const r = runs(seg).filter(x => x), clue = cols[c][0] === 0 ? [] : cols[c];
      if (final) return r.join() === clue.join();
      const open = seg[seg.length - 1] === 1; const done = open ? r.slice(0, -1) : r;
      for (let i = 0; i < done.length; i++) if (done[i] !== clue[i]) return false;
      if (open && (r.length > clue.length || r[r.length - 1] > clue[r.length - 1])) return false;
      return done.length <= clue.length; };
    (function dfs(i) { if (i === n) return true; for (const p of P[i]) { grid.push(p); let ok = true; for (let c = 0; c < n && ok; c++) ok = colOk(c, i === n - 1); if (ok && dfs(i + 1)) return true; grid.pop(); } return false; })(0);
    const cells = [...root.querySelectorAll('.ncell')];
    grid.forEach((r, ri) => r.forEach((v, ci) => { if (v) { press(cells[ri * n + ci]); window.dispatchEvent(new PointerEvent('pointerup')); } }));
  },
  async code(root, h) { // only ever guess codes consistent with all feedback so far
    const len = root.querySelectorAll('.code-row.current .peg').length, ncol = root.querySelectorAll('.peg.big').length;
    const score = (g, s) => { let b = 0, w = 0; const sc = Array(ncol).fill(0), gc = Array(ncol).fill(0); g.forEach((x, i) => { if (x === s[i]) b++; else { sc[s[i]]++; gc[x]++; } }); for (let c = 0; c < ncol; c++) w += Math.min(sc[c], gc[c]); return b + ',' + w; };
    let cands = []; (function gen(a) { if (a.length === len) { cands.push(a); return; } for (let c = 0; c < ncol; c++) gen(a.concat(c)); })([]);
    for (let t = 0; t < 12 && cands.length; t++) {
      const g = cands[0]; g.forEach(c => key(h, String(c + 1))); await sleep(200);
      const fb = root.querySelector('.code-rows .code-row .code-fb').textContent;
      const res = (fb.match(/●/g) || []).length + ',' + (fb.match(/○/g) || []).length;
      if (+res.split(',')[0] === len) return;
      cands = cands.filter(c => score(g, c) === res);
    }
  },
  async recall(root) {
    for (let lv = 0; lv < 6; lv++) {
      let lit = []; for (let k = 0; k < 80 && !lit.length; k++) { await sleep(25); lit = [...root.querySelectorAll('.rcell')].map((c, i) => c.classList.contains('lit') ? i : -1).filter(i => i >= 0); }
      await sleep(1250); const cells = [...root.querySelectorAll('.rcell')]; lit.forEach(i => press(cells[i])); await sleep(20);
    }
  },
  async words(root, h) {
    const D = PD.Puzzles.byId.words.dictionary;
    for (let k = 0; k < 5; k++) { const letters = [...root.querySelectorAll('.wtile')].map(t => t.textContent), s = letters.slice().sort().join('');
      for (const ch of D[letters.length].find(x => x.split('').sort().join('') === s)) key(h, ch.toLowerCase()); await sleep(160); }
  },
  pipes(root) { // rotate each tile back to its generated orientation (read from its drawn rotation)
    root.querySelectorAll('.pipe').forEach(b => { const k = (+b.firstChild.style.transform.match(/-?\d+/)[0] / 90) % 4; for (let t = 0; t < (4 - k) % 4; t++) press(b); });
  },
  mines(root) { // pure logic: single-cell rules + subset rule (boards are generated to need no guessing)
    const grid = root.querySelector('.mines-grid'), cells = [...grid.children], w = +grid.style.gridTemplateColumns.match(/repeat\((\d+)/)[1], h = cells.length / w;
    const nb = i => { const r = Math.floor(i / w), c = i % w, o = []; for (let a = -1; a <= 1; a++) for (let d = -1; d <= 1; d++) { if (!a && !d) continue; const rr = r + a, cc = c + d; if (rr >= 0 && rr < h && cc >= 0 && cc < w) o.push(rr * w + cc); } return o; };
    const open = i => cells[i].classList.contains('open'), flg = i => cells[i].classList.contains('flag'), num = i => +cells[i].textContent || 0;
    const reveal = i => { cells[i].dispatchEvent(new PointerEvent('pointerdown', { button: 0, bubbles: true })); cells[i].dispatchEvent(new PointerEvent('pointerup', { button: 0, bubbles: true })); };
    const flag = i => cells[i].dispatchEvent(new PointerEvent('pointerdown', { button: 2, bubbles: true }));
    for (let guard = 0, prog = true; prog && guard < 600; guard++) { prog = false; const cons = [];
      for (let i = 0; i < cells.length && !prog; i++) { if (!open(i) || !num(i)) continue; const unk = nb(i).filter(j => !open(j) && !flg(j)); if (!unk.length) continue;
        const need = num(i) - nb(i).filter(flg).length; if (need === 0) { unk.forEach(reveal); prog = true; } else if (need === unk.length) { unk.forEach(flag); prog = true; } else cons.push({ set: unk, need }); }
      if (prog) continue;
      outer: for (const a of cons) for (const c of cons) { if (a === c || a.set.length >= c.set.length || !a.set.every(x => c.set.includes(x))) continue;
        const rest = c.set.filter(x => !a.set.includes(x)), dn = c.need - a.need; if (dn === 0) { rest.forEach(reveal); prog = true; break outer; } if (dn === rest.length) { rest.forEach(flag); prog = true; break outer; } } }
  },
};`;

test('every puzzle can be solved through its real controls, at every difficulty', async () => {
  await page.addScriptTag({ content: SOLVERS });
  const results = await page.evaluate(async () => {
    const out = {};
    for (const p of PD.Puzzles.list) for (const diff of ['easy', 'normal', 'hard']) {
      const seeds = p.id === 'recall' ? [3] : [11, 222, 3333];
      let solved = 0, skipped = 0, penalties = 0;
      for (const seed of seeds) {
        const root = document.createElement('div'); document.body.appendChild(root);
        let done = false;
        const h = p.create(root, { rng: PD.makeRng(seed), diff, progress() {}, done() { done = true; }, penalty() { penalties++; } });
        const r = await window.__solvers[p.id](root, h);
        await new Promise(res => setTimeout(res, 30));
        if (r === 'skip') skipped++; else if (done) solved++;
        h && h.destroy && h.destroy(); root.remove();
      }
      out[p.id + '/' + diff] = skipped === seeds.length ? 'skipped' : `${solved}/${seeds.length - skipped}` + (p.id === 'mines' && penalties ? ` (${penalties} mine hits)` : '');
    }
    return out;
  });
  const failures = Object.entries(results).filter(([k, v]) => v !== 'skipped' && !/^(\d+)\/\1$/.test(v));
  assert.deepStrictEqual(failures, [], JSON.stringify(results, null, 1));
  assert.ok(!JSON.stringify(results).includes('mine hits'), 'Mine Dash needed a guess');
  assert.deepStrictEqual(errors, []);
});
