/* Puzzle Duel — Quick Match without a backend.
 *
 * The free PeerJS broker only lets you register an ID and connect to an ID, so it doubles
 * as a tiny "waiting list": every rating band has a well-known waiting-room ID.
 *   1. Scan: try to connect to the waiting rooms for nearby bands. If someone answers, play them.
 *   2. Wait: otherwise claim the waiting room for your own band and wait a few seconds.
 *      If the claim fails ("ID taken"), someone just got there first — join them instead.
 *   3. Repeat, widening the bands each cycle until every skill level is included.
 * Once matched, the waiting player releases the ID (keeping the live connection) so the
 * room is free for the next pair.
 */
(function () {
  'use strict';
  const BAND = 200;          // rating points per band
  const MAX_BAND = 15;       // bands 0..15 cover ratings 0–3199
  const JOIN_TIMEOUT = 4500; // ms to wait for a waiting room to answer
  const SEARCH_ALL_AFTER = 3; // cycles before searching every band

  const bandOf = r => Math.max(0, Math.min(MAX_BAND, Math.floor(r / BAND)));

  // Own band first, then alternate outwards: b, b-1, b+1, b-2, b+2…
  function bandsWithin(b, reach) {
    const out = [b];
    for (let d = 1; d <= reach; d++) {
      if (b - d >= 0) out.push(b - d);
      if (b + d <= MAX_BAND) out.push(b + d);
    }
    return out;
  }

  class Matchmaker {
    constructor(opts) {
      this.o = opts; // { rating, name, version, onStatus(text, info), onMatch(result), onError(msg) }
      this.prefix = 'pduel-qm' + opts.version + '-b';
      this.stopped = false;
      this.joiner = null;
      this.hostPeer = null;
      this.cycle = 0;
    }

    start() {
      if (typeof Peer === 'undefined') { this.o.onError('Networking library failed to load.'); return; }
      this.band = bandOf(this.o.rating);
      this._run().catch(err => { if (!this.stopped) this.o.onError(err && err.message ? err.message : String(err)); });
    }

    stop() {
      this.stopped = true;
      this._kill(this.joiner); this._kill(this.hostPeer);
      this.joiner = this.hostPeer = null;
    }

    _kill(p) { try { p && p.destroy(); } catch (e) {} }

    async _run() {
      this.joiner = await this._openPeer();
      while (!this.stopped) {
        const reach = this.cycle >= SEARCH_ALL_AFTER ? MAX_BAND : this.cycle;
        const lo = Math.max(0, (this.band - reach) * BAND), hi = Math.min(MAX_BAND + 1, this.band + reach + 1) * BAND;
        this.o.onStatus(reach >= MAX_BAND ? 'Searching all skill levels…' : reach === 0 ? 'Looking for players near your rating…' : `Widening search (${lo}–${hi})…`, { reach, cycle: this.cycle });
        // 1. scan nearby waiting rooms
        for (const b of bandsWithin(this.band, reach)) {
          if (this.stopped) return;
          const m = await this._tryJoin(b);
          if (m) return this._finish(m);
        }
        // 2. wait in our own band's room for a while (jittered so two waiters fall out of sync)
        if (this.stopped) return;
        const m = await this._wait(this.band, 6000 + Math.random() * 4000);
        if (m) return this._finish(m);
        this.cycle++;
      }
    }

    _finish(m) {
      if (this.stopped) { try { m.conn.close(); } catch (e) {} return; }
      this.stopped = true;
      // destroy whichever peer we are not using for the match
      if (m.peer !== this.joiner) this._kill(this.joiner);
      if (m.peer !== this.hostPeer) this._kill(this.hostPeer);
      this.joiner = this.hostPeer = null;
      this.o.onMatch(m);
    }

    _openPeer(id) {
      return new Promise((resolve, reject) => {
        const opts = (PD.Net && PD.Net.PEER_OPTS) || { debug: 0 };
        const p = id ? new Peer(id, opts) : new Peer(opts);
        let settled = false;
        p.on('open', () => { if (!settled) { settled = true; resolve(p); } });
        p.on('error', err => {
          if (settled) return;
          settled = true;
          reject(Object.assign(new Error(friendly(err)), { type: err && err.type, peer: p }));
        });
      });
    }

    _hello() { return { t: 'qm-hello', name: this.o.name, rating: Math.round(this.o.rating), v: this.o.version }; }

    // Try to connect to the waiting room for band b. Resolves to a match or null.
    _tryJoin(b) {
      const peer = this.joiner;
      return new Promise(resolve => {
        if (!peer || peer.destroyed) return resolve(null);
        let done = false;
        const conn = peer.connect(this.prefix + b, { reliable: true, serialization: 'json' });
        const finish = r => {
          if (done) return; done = true;
          clearTimeout(timer);
          peer.off('error', onErr);
          conn.off('data', onData);
          if (!r) { try { conn.close(); } catch (e) {} }
          resolve(r);
        };
        const onErr = err => {
          if (err && err.type === 'peer-unavailable') return finish(null); // nobody waiting there
          if (err && (err.type === 'network' || err.type === 'server-error' || err.type === 'socket-error')) {
            finish(null); this.stopped = true; this.o.onError(friendly(err));
          }
        };
        const onData = d => {
          if (!d || typeof d !== 'object') return;
          if (d.t === 'qm-ok') finish({ peer, conn, role: 'guest', opp: sanitizeOpp(d) });
          else if (d.t === 'qm-busy') finish(null);
        };
        const timer = setTimeout(() => finish(null), JOIN_TIMEOUT);
        peer.on('error', onErr);
        conn.on('data', onData);
        conn.on('open', () => { if (!done) conn.send(this._hello()); });
      });
    }

    // Claim the waiting room for band b and wait up to ms for someone to join.
    async _wait(b, ms) {
      let peer;
      try {
        peer = await this._openPeer(this.prefix + b);
      } catch (err) {
        this._kill(err.peer);
        if (err.type === 'unavailable-id') return this._tryJoin(b); // someone is already waiting — join them
        if (err.type === 'network' || err.type === 'server-error' || err.type === 'socket-error') { this.stopped = true; this.o.onError(err.message); }
        return null;
      }
      if (this.stopped) { this._kill(peer); return null; }
      this.hostPeer = peer;
      this.o.onStatus(null, { waiting: true });
      return new Promise(resolve => {
        let matched = false;
        const finish = r => {
          clearTimeout(timer); clearInterval(poll);
          if (!r) { this._kill(peer); if (this.hostPeer === peer) this.hostPeer = null; }
          resolve(r);
        };
        peer.on('connection', conn => {
          const onData = d => {
            if (!d || d.t !== 'qm-hello') return;
            conn.off('data', onData);
            if (matched || this.stopped || d.v !== this.o.version) { conn.send({ t: 'qm-busy' }); setTimeout(() => { try { conn.close(); } catch (e) {} }, 300); return; }
            matched = true;
            conn.send({ t: 'qm-ok', name: this.o.name, rating: Math.round(this.o.rating), v: this.o.version });
            // free the waiting-room ID for the next pair; the live connection stays open
            setTimeout(() => { try { peer.disconnect(); } catch (e) {} }, 1500);
            finish({ peer, conn, role: 'host', opp: sanitizeOpp(d) });
          };
          conn.on('data', onData);
        });
        peer.on('error', () => {});
        const timer = setTimeout(() => { if (!matched) finish(null); }, ms);
        const poll = setInterval(() => { if (this.stopped && !matched) finish(null); }, 200);
      });
    }
  }

  function sanitizeOpp(d) {
    const r = Number(d.rating);
    return { name: String(d.name || 'Rival').slice(0, 16), rating: isFinite(r) ? Math.max(100, Math.min(3200, Math.round(r))) : 1000 };
  }

  function friendly(err) {
    const t = err && err.type;
    if (t === 'network' || t === 'server-error' || t === 'socket-error') return 'Could not reach the matchmaking server. Check your connection.';
    if (t === 'browser-incompatible') return 'Your browser does not support WebRTC.';
    return (err && err.message) || String(err);
  }

  // ── Elo (stored on this device) ──
  const Elo = {
    get() { return Object.assign({ r: 1000, g: 0, w: 0, l: 0, d: 0, best: 1000 }, PD.store('elo') || {}); },
    // score: 1 win, 0.5 draw, 0 loss
    apply(score, oppRating) {
      const e = Elo.get();
      const before = e.r;
      const K = e.g < 10 ? 40 : 24; // provisional players move faster
      const expected = 1 / (1 + Math.pow(10, (oppRating - e.r) / 400));
      const delta = Math.round(K * (score - expected));
      e.r = Math.max(100, e.r + delta);
      e.g++;
      if (score === 1) e.w++; else if (score === 0) e.l++; else e.d++;
      e.best = Math.max(e.best, e.r);
      PD.store('elo', e);
      return { before, after: e.r, delta };
    },
    provisional() { return Elo.get().g < 10; },
  };

  window.PD = window.PD || {};
  PD.Matchmaker = Matchmaker;
  PD.Elo = Elo;
  PD.qmBandOf = bandOf;
})();
