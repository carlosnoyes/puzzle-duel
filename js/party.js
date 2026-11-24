/* Puzzle Duel — party rooms (3–8 players).
 *
 * The host's phone is the hub: friends connect to it over the same two routes as duels (direct or
 * relay), and the host runs the match — it picks each round's puzzle, collects everyone's progress
 * and finish times, scores the round and broadcasts the results.
 *
 * Scoring per round: 1st 5 pts, 2nd 3, 3rd 2, anyone else who finishes 1, unfinished 0.
 * A round ends when everyone is done, 20 s after half the players have finished, or at the time limit.
 *
 * Host -> guests: welcome, players, match, round, board, result, final, emote, lobby, bye
 * Guests -> host: hello (sent by the normal join flow), prog, fin, giveup, emote, name, ping, bye
 */
(function () {
  'use strict';
  const MAX_PLAYERS = 8;
  const POINTS = [5, 3, 2];
  const FINISH_POINTS = 1;
  const STRAGGLER_GRACE = 20000;
  const TIME_LIMIT = { easy: 90, normal: 150, hard: 210 };
  const HOST_ID = 'H';
  const ordinal = n => n + (['th', 'st', 'nd', 'rd'][(n % 100 - 20) % 10] || ['th', 'st', 'nd', 'rd'][n % 100] || 'th');

  let A = null; // app internals (PD._app), bound in init
  let P = null; // the current party session

  function el(...a) { return PD.el(...a); }
  const $ = id => document.getElementById(id);

  class Party {
    constructor(role, net, myId) {
      this.role = role;            // 'host' | 'guest'
      this.net = net;
      this.me = myId;
      this.players = [];           // [{ id, name }]
      this.match = null;           // host: { seed, rounds, diff, pool, totals, history }
      this.round = null;           // current round state
      this.inMatch = false;
      this.waiting = false;        // guest joined mid-match
      this.progTimer = null; this.boardTimer = null; this.raf = null;
      this.lastSeen = {};
    }

    get isHost() { return this.role === 'host'; }
    nameOf(id) { const p = this.players.find(x => x.id === id); return p ? p.name : 'Player'; }

    // ── networking helpers ──
    sendHost(m) { this.net.send(m); }
    broadcast(m) { if (this.isHost) this.net.send(m); }
    deliverLocal(m) { this.onMessage(m, HOST_ID); }    // the host plays too: its own actions go through the same code
    toHost(m) { if (this.isHost) this.onHostMessage(m, HOST_ID); else this.sendHost(m); }

    // ── host: membership ──
    hostStart() {
      this.players = [{ id: HOST_ID, name: A.myName() }];
      this.pinger = setInterval(() => this.hostSweep(), 5000);
      this.renderLobby();
    }
    hostSweep() {
      // drop friends we haven't heard from in a long while (closed tab on the relay route, dead phone)
      const now = Date.now(), limit = this.inMatch ? 30000 : 60000;
      this.players.filter(p => p.id !== HOST_ID && this.lastSeen[p.id] && now - this.lastSeen[p.id] > limit).forEach(p => this.hostRemove(p.id, true));
    }
    hostAdd(id, name) {
      if (this.players.some(p => p.id === id)) return;
      if (this.players.length >= MAX_PLAYERS) { this.net.send({ t: 'full', max: MAX_PLAYERS }, id); return; }
      const p = { id, name: String(name || 'Player').slice(0, 16), late: this.inMatch };
      this.players.push(p);
      this.net.send({ t: 'welcome', party: true, you: id, name: A.myName(), settings: A.S.settings, v: A.VERSION, inMatch: this.inMatch,
        list: this.players.map(x => ({ id: x.id, name: x.name, late: !!x.late })) }, id);
      A.toast(`${p.name} joined the party!`);
      A.Sound.good();
      this.syncPlayers();
    }
    hostRemove(id, silent) {
      const p = this.players.find(x => x.id === id);
      if (!p) return;
      this.players = this.players.filter(x => x.id !== id);
      if (silent) this.net.drop(id);
      A.toast(`${p.name} left.`);
      this.syncPlayers();
      if (this.round && !this.round.resolved) this.hostCheckRoundEnd();
    }
    syncPlayers() {
      this.broadcast({ t: 'players', list: this.players.map(p => ({ id: p.id, name: p.name, late: !!p.late })) });
      this.renderLobby();
      if (this.inMatch) this.renderBoard();
    }

    // ── host: match flow ──
    hostStartMatch() {
      const s = A.S.settings;
      this.players.forEach(p => { p.late = false; });
      const m = { seed: PD.randomSeed(), rounds: +s.rounds || 5, diff: s.diff, pool: s.pool.slice() };
      this.match = Object.assign({ totals: {}, times: {}, history: [] }, m);
      this.players.forEach(p => { this.match.totals[p.id] = 0; this.match.times[p.id] = 0; });
      this.broadcast({ t: 'match', match: m, list: this.players.map(p => ({ id: p.id, name: p.name })) });
      this.deliverLocal({ t: 'match', match: m, list: this.players.map(p => ({ id: p.id, name: p.name })) });
      setTimeout(() => this.hostNextRound(), 400);
    }
    hostNextRound() {
      const M = this.match; if (!M) return;
      const i = M.history.length;
      const cycle = Math.floor(i / M.pool.length);
      const pid = PD.makeRng(M.seed + cycle * 7919).shuffle(M.pool)[i % M.pool.length];
      const msg = { t: 'round', i, pid, seed: (M.seed ^ Math.imul(i + 1, 0x9E3779B1)) >>> 0, diff: M.diff, limit: TIME_LIMIT[M.diff] || 150 };
      this.hr = { i, pid, ids: this.players.filter(p => !p.late).map(p => p.id), prog: {}, fin: {}, gaveUp: {}, resolved: false, dirty: true };
      this.hr.limitTimer = setTimeout(() => this.hostResolve(), (msg.limit + 6) * 1000);
      this.broadcast(msg);
      this.deliverLocal(msg);
      clearInterval(this.boardTimer);
      this.boardTimer = setInterval(() => {
        if (!this.hr || !this.hr.dirty || this.hr.resolved) return;
        this.hr.dirty = false;
        const b = { t: 'board', i: this.hr.i, prog: this.hr.prog, fin: this.hr.fin, gaveUp: this.hr.gaveUp };
        this.broadcast(b); this.deliverLocal(b);
      }, 250);
    }
    onHostMessage(m, id) {
      this.lastSeen[id] = Date.now();
      const R = this.hr;
      switch (m.t) {
        case 'hello': this.hostAdd(id, m.name); break;
        case 'name': { const p = this.players.find(x => x.id === id); if (p) { p.name = String(m.name || p.name).slice(0, 16); this.syncPlayers(); } break; }
        case 'prog': if (R && m.i === R.i && !R.resolved && R.ids.includes(id)) { R.prog[id] = Math.max(0, Math.min(1, +m.p || 0)); R.dirty = true; } break;
        case 'fin':
          if (R && m.i === R.i && !R.resolved && R.ids.includes(id) && R.fin[id] == null) {
            R.fin[id] = Math.max(0, +m.ms || 0); R.prog[id] = 1; R.dirty = true;
            this.hostCheckRoundEnd();
          }
          break;
        case 'giveup': if (R && m.i === R.i && !R.resolved) { R.gaveUp[id] = true; R.dirty = true; this.hostCheckRoundEnd(); } break;
        case 'emote': { const e = { t: 'emote', from: this.nameOf(id), e: String(m.e).slice(0, 4) }; this.broadcast(e); this.deliverLocal(e); break; }
        case 'ping': break;
        case 'bye': this.hostRemove(id, true); break;
      }
    }
    hostCheckRoundEnd() {
      const R = this.hr; if (!R || R.resolved) return;
      const live = R.ids.filter(id => this.players.some(p => p.id === id));
      const done = live.filter(id => R.fin[id] != null || R.gaveUp[id]);
      if (!live.length || done.length === live.length) { this.hostResolve(); return; }
      const finished = live.filter(id => R.fin[id] != null).length;
      if (finished >= Math.ceil(live.length / 2) && !R.graceTimer) {
        R.graceTimer = setTimeout(() => this.hostResolve(), STRAGGLER_GRACE);
        const note = { t: 'hurry', i: R.i, secs: STRAGGLER_GRACE / 1000 };
        this.broadcast(note); this.deliverLocal(note);
      }
    }
    hostResolve() {
      const R = this.hr, M = this.match; if (!R || R.resolved || !M) return;
      R.resolved = true;
      clearTimeout(R.graceTimer); clearTimeout(R.limitTimer); clearInterval(this.boardTimer);
      const finishers = R.ids.filter(id => R.fin[id] != null).sort((a, b) => R.fin[a] - R.fin[b]);
      const places = finishers.map((id, k) => ({ id, ms: R.fin[id], pts: k < POINTS.length ? POINTS[k] : FINISH_POINTS }));
      R.ids.filter(id => R.fin[id] == null).forEach(id => places.push({ id, ms: null, prog: R.prog[id] || 0, pts: 0, gaveUp: !!R.gaveUp[id] }));
      places.forEach(p => { M.totals[p.id] = (M.totals[p.id] || 0) + p.pts; if (p.ms != null) M.times[p.id] = (M.times[p.id] || 0) + p.ms; });
      M.history.push({ i: R.i, pid: R.pid, places });
      const over = M.history.length >= M.rounds;
      const msg = { t: 'result', i: R.i, pid: R.pid, places, totals: M.totals, times: M.times, over };
      this.broadcast(msg); this.deliverLocal(msg);
      if (over) setTimeout(() => this.hostFinal(), 4200);
      else setTimeout(() => { if (this.match === M) this.hostNextRound(); }, 5200);
    }
    hostFinal() {
      const M = this.match; if (!M) return;
      const standings = Object.keys(M.totals).map(id => ({ id, name: this.nameOf(id), pts: M.totals[id], ms: M.times[id] || 0 }))
        .sort((a, b) => b.pts - a.pts || a.ms - b.ms);
      const msg = { t: 'final', standings, history: M.history.map(h => ({ pid: h.pid, winner: h.places[0] && h.places[0].ms != null ? this.nameOf(h.places[0].id) : null })) };
      this.broadcast(msg); this.deliverLocal(msg);
      this.match = null;
    }

    // ── everyone (host included): react to the host's messages ──
    onMessage(m, from) {
      switch (m.t) {
        case 'players':
          this.players = m.list;
          if (this.waiting && !m.list.find(p => p.id === this.me && p.late)) this.waiting = false;
          this.renderLobby(); if (this.inMatch) this.renderBoard();
          break;
        case 'match':
          this.inMatch = true; this.waiting = false;
          this.players = m.list; this.totals = {}; m.list.forEach(p => { this.totals[p.id] = 0; });
          this.rounds = m.match.rounds;
          A.overlay('result', false);
          document.body.classList.add('party-mode');
          A.show('game');
          break;
        case 'round': this.playRound(m); break;
        case 'board': if (this.round && m.i === this.round.i) { this.round.board = m; this.renderBoard(); } break;
        case 'hurry':
          if (this.round && m.i === this.round.i && this.round.active) A.toast(`Half the players are done: ${m.secs}s left to finish!`);
          break;
        case 'result': this.showResult(m); break;
        case 'final': this.showFinal(m); break;
        case 'emote': A.showEmote('me', `${m.from} ${m.e}`); break;
        case 'lobby': this.backToLobby(); break;
        case 'settings': if (!this.isHost) { Object.assign(A.S.settings, m.settings); A.renderSettings(); } break;
        case 'full': A.toast(`That room is full (${m.max} players).`, true); A.goHome(); break;
        case 'bye': if (!this.isHost) { A.toast('The host closed the party.', true); A.goHome(); } break;
      }
    }

    // ── playing a round ──
    playRound(m) {
      this.endRound();
      if (this.waiting) return; // joined mid-match: watch the lobby until the next one
      const pz = PD.Puzzles.byId[m.pid];
      if (!pz) { A.toast('This version doesn’t have that puzzle — refresh the page.', true); return; }
      A.overlay('result', false);
      document.body.classList.add('party-mode');
      A.show('game');
      const R = this.round = { i: m.i, pid: m.pid, limit: m.limit, active: false, startAt: 0, frozenUntil: 0, board: null, myDone: false };
      A.S.round = R; // lets the app's keyboard handler drive the puzzle
      $('ph-icon').textContent = pz.icon; $('ph-name').textContent = pz.name; $('ph-how').textContent = pz.how;
      $('party-round').textContent = `Round ${m.i + 1} of ${this.rounds}`;
      $('party-timer').textContent = '0.0s';
      const stage = $('stage'); stage.innerHTML = ''; stage.style.visibility = 'hidden';
      A.overlay('waiting', false); A.overlay('penalty', false);
      let pending = null, lastSent = 0;
      const api = {
        rng: PD.makeRng(m.seed), diff: m.diff,
        progress: p => {
          if (!R.active) return;
          pending = p;
          const flush = () => { this.progTimer = null; if (pending != null) { this.toHost({ t: 'prog', i: R.i, p: pending }); pending = null; lastSent = performance.now(); } };
          if (performance.now() - lastSent > 200) flush(); else if (!this.progTimer) this.progTimer = setTimeout(flush, 200);
        },
        done: () => {
          if (!R.active) return;
          const ms = performance.now() - R.startAt;
          R.active = false; R.myDone = true;
          clearTimeout(this.progTimer); this.progTimer = null;
          this.toHost({ t: 'fin', i: R.i, ms });
          A.Sound.win();
          $('wait-msg').innerHTML = `Solved in <b>${PD.fmtTime(ms)}</b>!<br><span class="muted small">Waiting for the others…</span>`;
          A.overlay('waiting', true);
        },
        penalty: (ms, reason) => {
          if (!R.active) return 0;
          const end = performance.now() + ms;
          if (R.frozenUntil && R.frozenUntil >= end) return 0;
          R.frozenUntil = end; $('pen-msg').textContent = reason || 'Penalty!'; A.overlay('penalty', true);
          return end;
        },
      };
      R.api = api;
      try { R.puzzle = pz.create(stage, api); } catch (e) { stage.textContent = 'Puzzle failed to load: ' + e.message; }
      this.renderBoard();
      A.countdown(pz, () => {
        if (this.round !== R) return;
        stage.style.visibility = '';
        R.active = true; R.startAt = performance.now();
        const tick = () => {
          if (this.round !== R) return;
          if (R.active) {
            const now = performance.now(), t = now - R.startAt, left = R.limit * 1000 - t;
            $('party-timer').textContent = left < 30000 ? PD.fmtTime(Math.max(0, left)) : PD.fmtTime(t);
            $('party-timer').classList.toggle('low', left < 30000);
            if (left <= 0) { R.active = false; $('wait-msg').textContent = '⏰ Time’s up!'; A.overlay('waiting', true); }
            if (R.frozenUntil) { const fl = R.frozenUntil - now; if (fl <= 0) { R.frozenUntil = 0; A.overlay('penalty', false); } else $('pen-time').textContent = (fl / 1000).toFixed(1); }
          }
          this.raf = requestAnimationFrame(tick);
        };
        this.raf = requestAnimationFrame(tick);
      });
      // countdown() writes its own context line; give it the party's instead
      $('cd-ctx').textContent = `Party · round ${m.i + 1} of ${this.rounds} · ${this.players.length} players`;
    }
    giveUp() {
      const R = this.round; if (!R || !R.active) return;
      if (!confirm('Give up this round?')) return;
      R.active = false;
      this.toHost({ t: 'giveup', i: R.i });
      $('wait-msg').textContent = '🏳️ You gave up this round.'; A.overlay('waiting', true);
    }
    endRound() {
      const R = this.round;
      if (R) { R.active = false; try { R.puzzle && R.puzzle.destroy && R.puzzle.destroy(); } catch (e) {} }
      cancelAnimationFrame(this.raf); clearTimeout(this.progTimer); this.progTimer = null;
      A.overlay('penalty', false); A.overlay('waiting', false);
    }

    renderBoard() {
      const box = $('party-board'); if (!box) return;
      const b = (this.round && this.round.board) || { prog: {}, fin: {}, gaveUp: {} };
      const rows = this.players.filter(p => !p.late).map(p => ({ p, prog: b.fin[p.id] != null ? 1 : (b.prog[p.id] || 0), fin: b.fin[p.id], gave: b.gaveUp && b.gaveUp[p.id], pts: (this.totals || {})[p.id] || 0 }));
      const order = Object.keys(b.fin).sort((x, y) => b.fin[x] - b.fin[y]);
      box.innerHTML = '';
      rows.forEach(r => {
        const place = order.indexOf(r.p.id);
        box.appendChild(el('div', { class: 'pb-row' + (r.p.id === this.me ? ' me' : '') + (r.fin != null ? ' done' : '') },
          el('span', { class: 'pb-name' }, (place >= 0 ? ['🥇', '🥈', '🥉'][place] || '✅' : r.gave ? '🏳️' : '') + ' ' + r.p.name),
          el('span', { class: 'pb-bar' }, el('span', { class: 'pb-fill', style: { width: Math.round(r.prog * 100) + '%' } })),
          el('span', { class: 'pb-pts' }, r.pts + ' pts')));
      });
    }

    showResult(m) {
      this.endRound();
      this.totals = m.totals;
      const myPlace = m.places.findIndex(p => p.id === this.me);
      const mine = m.places[myPlace];
      const iFinished = mine && mine.ms != null;
      $('res-emoji').textContent = !mine ? '👀' : !iFinished ? '🧩' : ['🥇', '🥈', '🥉'][myPlace] || '✅';
      $('res-title').textContent = !mine ? 'Round over' : !iFinished ? 'Not finished this time' : myPlace === 0 ? 'You won the round!' : `You came ${ordinal(myPlace + 1)}`;
      $('res-title').className = 'res-title' + (iFinished && myPlace === 0 ? ' win' : '');
      if (iFinished && myPlace === 0) A.Sound.win();
      const list = $('res-times'); list.innerHTML = ''; list.classList.add('party-list');
      m.places.forEach((p, k) => list.appendChild(el('div', { class: 'pl-row' + (p.id === this.me ? ' me' : '') },
        el('span', null, p.ms != null ? (['🥇', '🥈', '🥉'][k] || ordinal(k + 1)) : '—'),
        el('span', { class: 'pl-n' }, this.nameOf(p.id)),
        el('span', null, p.ms != null ? PD.fmtTime(p.ms) : p.gaveUp ? 'gave up' : Math.round((p.prog || 0) * 100) + '%'),
        el('span', { class: 'pl-pts' }, '+' + p.pts))));
      const lead = Object.keys(m.totals).sort((a, b) => m.totals[b] - m.totals[a])[0];
      $('res-score').textContent = lead ? `Leader: ${this.nameOf(lead)} (${m.totals[lead]} pts)` : '';
      $('res-next').textContent = m.over ? 'Final standings next…' : 'Next round starting…';
      A.overlay('result', true);
      this.renderBoard();
    }

    showFinal(m) {
      this.endRound();
      this.inMatch = false;
      A.overlay('result', false);
      $('res-times').classList.remove('party-list');
      const myRank = m.standings.findIndex(s => s.id === this.me);
      $('final-emoji').textContent = myRank === 0 ? '🏆' : myRank === 1 ? '🥈' : myRank === 2 ? '🥉' : '🎉';
      $('final-title').textContent = myRank === 0 ? 'You won the party!' : myRank >= 0 ? `You finished ${ordinal(myRank + 1)}` : 'Party over';
      $('final-score').textContent = `${m.standings[0].name} wins with ${m.standings[0].pts} pts`;
      if (myRank === 0) { A.confetti(); A.Sound.win(); }
      $('final-rating').classList.add('hidden');
      $('final-stats').innerHTML = '';
      const tb = $('final-history'); tb.innerHTML = '';
      tb.appendChild(el('tr', null, el('th', null, '#'), el('th', null, 'Player'), el('th', null, 'Points'), el('th', null, 'Total time')));
      m.standings.forEach((s, k) => tb.appendChild(el('tr', { class: s.id === this.me ? 'me-row' : '' },
        el('td', { class: k === 0 ? 'w' : '' }, ['🥇', '🥈', '🥉'][k] || String(k + 1)), el('td', null, s.name), el('td', { class: k === 0 ? 'w' : '' }, String(s.pts)), el('td', null, PD.fmtTime(s.ms)))));
      $('btn-rematch').classList.toggle('hidden', !this.isHost);
      $('btn-rematch').textContent = '🔁 Play again';
      $('btn-share-result').classList.add('hidden'); $('btn-share-qr').classList.add('hidden');
      $('btn-final-home').textContent = 'Back to party lobby';
      $('rematch-hint').textContent = this.isHost ? '' : 'Waiting for the host to start another match…';
      document.body.classList.remove('party-mode');
      A.show('final');
    }

    backToLobby() {
      this.endRound();
      this.inMatch = false; this.waiting = false;
      document.body.classList.remove('party-mode');
      A.overlay('result', false);
      if (this.isHost) { this.match = null; this.hr = null; clearInterval(this.boardTimer); this.broadcast({ t: 'lobby' }); }
      A.openLobby(); // also re-renders the party list
    }

    // ── lobby ──
    renderLobby() {
      const box = $('party-players'); if (!box) return;
      box.innerHTML = '';
      this.players.forEach(p => box.appendChild(el('div', { class: 'pp' + (p.id === this.me ? ' me' : '') },
        el('span', { class: 'pp-dot' }), el('span', { class: 'pp-name' }, p.name),
        el('span', { class: 'pp-tag' }, p.id === HOST_ID ? 'Host' : p.late ? 'joins next match' : ''))));
      for (let k = this.players.length; k < Math.max(3, Math.min(MAX_PLAYERS, this.players.length + 1)); k++) box.appendChild(el('div', { class: 'pp empty' }, el('span', { class: 'pp-dot' }), el('span', { class: 'pp-name' }, 'Waiting for players…')));
      $('party-count').textContent = `${this.players.length} / ${MAX_PLAYERS}`;
      if (this.isHost) {
        const btn = $('btn-start');
        btn.disabled = this.players.length < 2 || this.inMatch;
        $('start-hint').textContent = this.players.length < 2 ? 'Waiting for friends to join… (2–8 players)' : this.inMatch ? 'Match in progress' : `Ready with ${this.players.length} players`;
      } else {
        $('start-hint').textContent = this.waiting ? 'A match is in progress — you’ll join the next one.' : 'Waiting for the host to start…';
      }
    }

    leave() {
      clearInterval(this.pinger); clearInterval(this.boardTimer); clearInterval(this.guestPing);
      this.endRound();
      if (this.hr) { clearTimeout(this.hr.graceTimer); clearTimeout(this.hr.limitTimer); }
      try { this.isHost ? this.broadcast({ t: 'bye' }) : this.sendHost({ t: 'bye' }); } catch (e) {}
      document.body.classList.remove('party-mode');
      $('res-times').classList.remove('party-list');
      this.match = null; this.hr = null;
    }
  }

  // ── entry points used by the app ──
  function host() {
    const S = A.S;
    A.stopMatchmaker(); A.teardownNet();
    S.mode = 'party-host';
    S.code = PD.Net.makeCode();
    const party = P = S.party = new Party('host', null, HOST_ID);
    $('room-code').textContent = S.code;
    $('invite-hint').textContent = 'Opening room…';
    A.setShareEnabled(false);
    A.openLobby();
    const net = PD.Net.create({
      onReady: () => A.setShareEnabled(true),
      onStatus: st => { if (typeof st === 'object' && S.party === party) { $('invite-hint').textContent = A.hostStatusText(st).replace('until your friend joins', 'until everyone has joined'); A.setShareEnabled(st.ready); } },
      onMessage: (m, gid) => { if (S.party === party && m && typeof m === 'object') party.onHostMessage(m, gid); },
      onClose: gid => { if (S.party === party && gid) party.hostRemove(gid); },
      onError: (msg, type) => { if (type === 'unavailable-id') { party.leave(); S.party = null; host(); return; } A.toast(msg, true); },
    });
    net.capacity = MAX_PLAYERS - 1;
    party.net = S.net = net;
    net.host(S.code);
    party.hostStart();
  }

  // A guest who joined through the normal flow finds out from the welcome that this is a party.
  function becomeGuest(m) {
    const S = A.S;
    const party = P = S.party = new Party('guest', S.net, m.you);
    S.mode = 'party-guest';
    S.connected = false; // the duel heartbeat stays off; the party has its own keep-alive
    S.oppName = m.name;
    party.waiting = !!m.inMatch;
    if (Array.isArray(m.list)) party.players = m.list;
    if (m.settings) Object.assign(S.settings, m.settings);
    S.net.h.onMessage = msg => { if (S.party === party && msg && typeof msg === 'object') party.onMessage(msg); };
    S.net.h.onClose = () => { if (S.party === party) { A.toast('Lost connection to the party host.', true); A.goHome(); } };
    party.guestPing = setInterval(() => party.sendHost({ t: 'ping' }), 5000);
    A.openLobby();
  }

  function init(app) { A = app; }

  window.PD = window.PD || {};
  PD.Party = { init, host, becomeGuest, MAX_PLAYERS, POINTS };
})();
