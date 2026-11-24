/* Puzzle Duel — networking for friend rooms.
 *
 * Two independent routes, so a room still works when one is blocked:
 *   1. Direct: PeerJS (WebRTC data channel, brokered by the free PeerJS cloud server).
 *   2. Relay:  public MQTT brokers over WebSockets (js/relay.js). Works behind strict NATs and
 *              firewalls, and when the PeerJS server is down.
 * The host listens on both. The guest tries direct first and falls back to the relay if the
 * direct link hasn't opened within a few seconds. Whichever opens first carries the game.
 *
 * A third transport, BroadcastChannel (same browser, two tabs), is used for local testing (?net=bc).
 */
(function () {
  'use strict';
  const PREFIX = 'pduel-v1-';
  const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const RELAY_AFTER = 3500;   // ms to give the direct link before also trying the relay
  const JOIN_TIMEOUT = 25000; // ms before the guest gives up

  // STUN finds each phone's public address; TURN relays when a direct path is impossible.
  const ICE_SERVERS = [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302', 'stun:stun2.l.google.com:19302'] },
    { urls: 'stun:stun.cloudflare.com:3478' },
    { urls: ['turn:eu-0.turn.peerjs.com:3478', 'turn:us-0.turn.peerjs.com:3478'], username: 'peerjs', credential: 'peerjsp' },
  ];
  const PEER_OPTS = { debug: 0, config: { iceServers: ICE_SERVERS } };
  const L = m => { if (PD.log) PD.log(m); }; // connection log for the diagnostics report

  // read once at load: the app tidies the URL (drops ?source=app etc.) after starting
  const PARAMS = new URLSearchParams(location.search);
  const params = () => PARAMS;
  const p2pAllowed = () => typeof Peer !== 'undefined' && typeof RTCPeerConnection !== 'undefined' && !params().has('nop2p');
  const relayAllowed = () => !!(PD.Relay && PD.Relay.available) && !params().has('norelay');

  function makeCode() {
    let s = '';
    for (let i = 0; i < 5; i++) s += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
    return s;
  }

  // Accepts a bare code ("ab-c 12"), or a whole pasted invite link (".../#ABC12").
  function normalizeCode(c) {
    let s = String(c || '').trim();
    const hash = s.indexOf('#');
    if (hash >= 0) s = s.slice(hash + 1);
    return s.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
  }

  function peerErrorText(type, fallback) {
    if (type === 'network' || type === 'server-error' || type === 'socket-error' || type === 'socket-closed') return 'Could not reach the matchmaking server.';
    if (type === 'browser-incompatible') return 'This browser does not support direct connections.';
    return fallback || 'Connection error.';
  }

  // Wrap a PeerJS DataConnection as a channel: { send, close, onMessage, onClose }
  function peerChannel(conn) {
    const ch = { open: true, onMessage: null, onClose: null,
      send: m => { if (conn.open) conn.send(m); },
      close: () => { ch.open = false; try { conn.close(); } catch (e) {} } };
    conn.on('data', d => ch.onMessage && ch.onMessage(d));
    conn.on('close', () => { if (ch.open) { ch.open = false; ch.onClose && ch.onClose(); } });
    return ch;
  }

  // ── Host side, direct route: keeps the room ID registered, reconnecting as needed ──
  class PeerHost {
    constructor(code, { onChannel, onState, onTaken }) {
      this.code = code; this.onChannel = onChannel; this.onState = onState; this.onTaken = onTaken;
      this.peer = null; this.ready = false; this.everReady = false; this.stopped = false; this.delay = 1000; this.timer = null;
    }
    start() {
      if (this.stopped) return;
      clearTimeout(this.timer);
      const p = this.peer = new Peer(PREFIX + this.code, PEER_OPTS);
      p.on('open', () => { this.ready = true; this.everReady = true; this.delay = 1000; L('host: direct route open'); this.onState(); });
      p.on('connection', conn => {
        conn.on('open', () => this.onChannel(peerChannel(conn), (conn.metadata && conn.metadata.g) || conn.peer, 'p2p'));
      });
      p.on('disconnected', () => { this.ready = false; L('host: direct route disconnected, reconnecting'); this.onState(); this._retry(); });
      p.on('close', () => { this.ready = false; this.onState(); });
      p.on('error', err => {
        const type = err && err.type;
        if (type === 'peer-unavailable') return;
        if (type === 'unavailable-id' && !this.everReady) { this.onTaken(); return; } // genuine code clash on first open
        // anything else (incl. "ID taken" while the server still holds our old session): keep the
        // same code and try again shortly — never silently switch to a new room code
        L('host: direct route error ' + type + ', retrying');
        this.ready = false; this.onState(); this._retry();
      });
    }
    _retry() {
      if (this.stopped) return;
      clearTimeout(this.timer);
      this.timer = setTimeout(() => {
        const p = this.peer;
        if (p && !p.destroyed && p.disconnected) { try { p.reconnect(); return; } catch (e) {} }
        if (!p || p.destroyed) this.start();
      }, this.delay);
      this.delay = Math.min(this.delay * 2, 15000);
    }
    wake() { if (!this.ready && !this.stopped) { this.delay = 500; this._retry(); } }
    stop() { this.stopped = true; clearTimeout(this.timer); this.ready = false; try { this.peer && this.peer.destroy(); } catch (e) {} }
  }

  // ── Guest side, direct route ──
  class PeerJoin {
    constructor(code, guestId, { onChannel, onFail, onMissing }) {
      this.code = code; this.g = guestId; this.onChannel = onChannel; this.onFail = onFail; this.onMissing = onMissing;
      this.peer = null; this.stopped = false; this.done = false; this.attemptTimer = null; this.retryTimer = null; this.misses = 0;
    }
    start() {
      this.peer = new Peer(PEER_OPTS);
      this.peer.on('open', () => this._connect());
      this.peer.on('error', err => {
        if (this.stopped || this.done) return;
        const type = err && err.type;
        if (type === 'peer-unavailable') {
          // the host may be reconnecting (e.g. their app was briefly in the background): keep trying
          this.misses++;
          L('join: direct route found no host (try ' + this.misses + ')');
          if (this.misses === 2) this.onMissing();
          clearTimeout(this.attemptTimer);
          this.retryTimer = setTimeout(() => this._connect(), 2000);
          return;
        }
        L('join: direct route error ' + type);
        this.onFail(peerErrorText(type, err && err.message));
      });
    }
    _connect() {
      if (this.stopped || this.done || !this.peer || this.peer.disconnected) return;
      const conn = this.peer.connect(PREFIX + this.code, { reliable: true, serialization: 'json', metadata: { g: this.g } });
      // The host was found but the direct link never opened: usually a NAT/firewall in the way.
      clearTimeout(this.attemptTimer);
      this.attemptTimer = setTimeout(() => { if (!conn.open && !this.done) { try { conn.close(); } catch (e) {} L('join: direct link never opened (network blocking it)'); this.onFail('Direct connection blocked by the network.'); } }, 9000);
      conn.on('open', () => {
        clearTimeout(this.attemptTimer);
        if (this.stopped || this.done) { try { conn.close(); } catch (e) {} return; }
        this.done = true;
        this.onChannel(peerChannel(conn));
      });
      conn.on('error', () => { if (!conn.open && !this.done) this.onFail('Direct connection failed.'); });
    }
    stop() { this.stopped = true; clearTimeout(this.attemptTimer); clearTimeout(this.retryTimer); try { this.peer && !this.done && this.peer.destroy(); } catch (e) {} }
    destroy() { this.stop(); try { this.peer && this.peer.destroy(); } catch (e) {} }
  }

  // ── The transport the app uses: host or join a room over both routes ──
  class RoomTransport {
    constructor(h) {
      this.h = h; this.active = null; this.parts = []; this.closed = false;
      this.code = null; this.role = null;
      this.members = new Map(); // host: guestId -> { ch, via }
      this.capacity = 1;        // guests allowed (1 for a duel, up to 7 for a party room)
    }

    // ---- host ----
    host(code) {
      this.role = 'host'; this.code = code;
      const onChannel = (ch, guestId, via) => this._hostChannel(ch, guestId, via);
      const onState = () => this._hostState();
      if (p2pAllowed()) this.parts.push(this.p2p = new PeerHost(code, { onChannel, onState, onTaken: () => this.h.onError && this.h.onError('That room code is already in use.', 'unavailable-id') }));
      if (relayAllowed()) this.parts.push(this.relay = new PD.Relay.RelayHost(code, { onChannel, onState }));
      if (!this.parts.length) { this.h.onError && this.h.onError('This browser cannot host online games.', 'unsupported'); return; }
      this.parts.forEach(p => p.start());
      this._hostState();
      // if nothing opens at all, say so (but keep trying in the background)
      this.openTimer = setTimeout(() => { if (!this.parts.some(p => p.ready)) this.h.onStatus && this.h.onStatus({ ready: false, slow: true, p2p: false, relay: false }); }, 12000);
    }
    _hostState() {
      const st = { ready: this.parts.some(p => p.ready), p2p: !!(this.p2p && this.p2p.ready), relay: !!(this.relay && this.relay.ready) };
      if (st.relay !== this.lastRelay) { this.lastRelay = st.relay; L('host: relay route ' + (st.relay ? 'open' : 'down')); }
      if (st.ready && !this.wasReady) { this.wasReady = true; this.h.onReady && this.h.onReady(); }
      this.h.onStatus && this.h.onStatus(st);
    }
    _hostChannel(ch, guestId, via) {
      if (this.closed) { ch.close(); return; }
      ch.onMessage = m => {
        const cur = this.members.get(guestId);
        if (!cur || cur.ch !== ch) {
          if (cur) { cur.ch.onClose = null; cur.ch.close(); cur.ch = ch; cur.via = via; } // same friend, better route
          else if (this.members.size >= this.capacity) { ch.send({ t: 'full', max: this.capacity + 1 }); setTimeout(() => ch.close(), 300); return; }
          else { this.members.set(guestId, { ch, via }); L('host: friend connected via ' + via + ' (' + this.members.size + '/' + this.capacity + ')'); }
        }
        this.h.onMessage && this.h.onMessage(m, guestId);
      };
      ch.onClose = () => {
        const cur = this.members.get(guestId);
        if (cur && cur.ch === ch) { L('host: friend\'s connection closed'); this.members.delete(guestId); this.h.onClose && this.h.onClose(guestId); }
      };
    }
    // route of the (first) connected friend, for the ping label
    get via() { if (this.role === 'host') { const f = this.members.values().next().value; return f && f.via; } return this._via; }
    set via(v) { this._via = v; }

    // ---- join ----
    join(code) {
      this.role = 'guest'; this.code = code;
      this.g = 'g' + Math.random().toString(36).slice(2, 10);
      this.failures = {};
      const onChannel = (ch, via) => this._joinChannel(ch, via);
      const startRelay = () => {
        if (this.relayJoin || this.active || this.closed || !relayAllowed()) return;
        this.status('Trying the backup relay…');
        L('join: trying relay');
        this.relayJoin = new PD.Relay.RelayJoin(code, this.g, { onChannel: ch => onChannel(ch, 'relay') });
        this.relayJoin.start();
      };
      if (p2pAllowed()) {
        this.p2pJoin = new PeerJoin(code, this.g, {
          onChannel: ch => onChannel(ch, 'p2p'),
          onMissing: () => { this.status('Looking for the room… (ask your friend to keep Puzzle Duel open on screen)'); startRelay(); },
          onFail: why => { this.failures.p2p = why; startRelay(); },
        });
        this.p2pJoin.start();
        this.relayTimer = setTimeout(startRelay, RELAY_AFTER);
      } else startRelay();
      this.status('Connecting…');
      L('join: room ' + code + (p2pAllowed() ? '' : ' (no WebRTC here, relay only)'));
      this.joinTimer = setTimeout(() => {
        if (this.active || this.closed) return;
        L('join: gave up after ' + JOIN_TIMEOUT / 1000 + 's');
        const msg = 'Couldn’t reach that room. Check the code, and make sure your friend still has the room open on their screen.';
        this.h.onError && this.h.onError(msg, 'timeout');
      }, JOIN_TIMEOUT);
    }
    status(text) { this.h.onStatus && this.h.onStatus(text); }
    _joinChannel(ch, via) {
      if (this.active || this.closed) { ch.close(); return; }
      this.active = ch; this.via = via;
      L('join: connected via ' + via);
      clearTimeout(this.joinTimer); clearTimeout(this.relayTimer);
      // drop the route we didn't use
      if (via === 'p2p' && this.relayJoin) { this.relayJoin.stop(); this.relayJoin = null; }
      if (via === 'relay' && this.p2pJoin) { this.p2pJoin.destroy(); this.p2pJoin = null; }
      ch.onMessage = m => {
        if (m && m.t === 'full') { this.h.onError && this.h.onError(m.max > 2 ? `That room is full (${m.max} players).` : 'That room already has two players.', 'full'); return; }
        this.h.onMessage && this.h.onMessage(m);
      };
      ch.onClose = kind => { if (this.active === ch) { L('join: connection closed' + (kind ? ' (' + kind + ')' : '')); this.active = null; this.h.onClose && this.h.onClose(); } };
      this.h.onOpen && this.h.onOpen(via);
    }

    // ---- common ----
    // host: send to one friend (guestId) or all of them; guest: send to the host
    send(msg, guestId) {
      if (this.role !== 'host') { if (this.active) this.active.send(msg); return; }
      if (guestId) { const m = this.members.get(guestId); if (m) m.ch.send(msg); return; }
      this.members.forEach(m => m.ch.send(msg));
    }
    get connected() { return this.role === 'host' ? this.members.size > 0 : !!this.active; }
    wake() { this.parts.forEach(p => p.wake && p.wake()); if (this.relayJoin) this.relayJoin.wake(); }
    // host: disconnect one friend (or everyone); guest: drop the link to the host
    drop(guestId) {
      if (this.role === 'host') {
        [...this.members.entries()].forEach(([g, m]) => { if (!guestId || g === guestId) { this.members.delete(g); m.ch.onClose = null; try { m.ch.close(); } catch (e) {} } });
        return;
      }
      const a = this.active; this.active = null; if (a) { a.onClose = null; a.close(); }
    }
    close() {
      this.closed = true;
      clearTimeout(this.joinTimer); clearTimeout(this.relayTimer); clearTimeout(this.openTimer);
      this.drop();
      const a = this.active; this.active = null;
      if (a) { a.onClose = null; try { a.close(); } catch (e) {} }
      this.parts.forEach(p => p.stop());
      if (this.p2pJoin) this.p2pJoin.destroy();
      if (this.relayJoin) this.relayJoin.stop();
    }
  }

  // ── Quick Match hands over an already-open PeerJS connection ──
  class AdoptedTransport {
    constructor(h, peer, conn) {
      this.h = h; this.peer = peer; this.ch = peerChannel(conn);
      this.ch.onMessage = m => h.onMessage && h.onMessage(m);
      this.ch.onClose = () => { this.ch = null; h.onClose && h.onClose(); };
      peer.on('error', err => { if (err && err.type !== 'peer-unavailable' && err.type !== 'unavailable-id' && err.type !== 'network') h.onError && h.onError(peerErrorText(err.type, err.message), err.type); });
    }
    send(m) { if (this.ch) this.ch.send(m); }
    get connected() { return !!this.ch; }
    wake() {}
    drop() { const c = this.ch; this.ch = null; if (c) { c.onClose = null; c.close(); } }
    close() { this.drop(); try { this.peer.destroy(); } catch (e) {} }
  }

  // ── local testing: two tabs of the same browser ──
  class BCTransport {
    constructor(handlers) { this.h = handlers; this.ch = null; this.role = null; this.open = false; this.id = Math.random().toString(36).slice(2); this.other = null; }
    host(code) {
      this.role = 'host';
      this.ch = new BroadcastChannel(PREFIX + code);
      this.ch.onmessage = e => this._on(e.data);
      setTimeout(() => { this.h.onReady && this.h.onReady(); this.h.onStatus && this.h.onStatus({ ready: true, p2p: true, relay: false }); }, 50);
    }
    join(code) {
      this.role = 'guest';
      this.ch = new BroadcastChannel(PREFIX + code);
      this.ch.onmessage = e => this._on(e.data);
      this.ch.postMessage({ _bc: 'hello', from: this.id });
      this._timer = setTimeout(() => { if (!this.open) this.h.onError('Room not found (local tab mode).', 'peer-unavailable'); }, 2500);
    }
    _on(d) {
      if (!d || d.from === this.id) return;
      if (d._bc === 'hello' && this.role === 'host') {
        if (this.open) return;
        this.other = d.from; this.open = true;
        this.ch.postMessage({ _bc: 'welcome', from: this.id, to: d.from });
        return;
      }
      if (d._bc === 'welcome' && d.to === this.id) {
        clearTimeout(this._timer);
        this.other = d.from; this.open = true;
        this.h.onOpen && this.h.onOpen('bc');
        return;
      }
      if (d._bc === 'bye' && d.from === this.other) { this.open = false; this.h.onClose && this.h.onClose(); return; }
      if (d._bc === 'msg' && d.from === this.other) this.h.onMessage && this.h.onMessage(d.m);
    }
    send(m) { if (this.open) this.ch.postMessage({ _bc: 'msg', from: this.id, m }); }
    wake() {}
    drop() { this.open = false; this.other = null; }
    get connected() { return this.open; }
    close() { try { this.ch.postMessage({ _bc: 'bye', from: this.id }); this.ch.close(); } catch (e) {} this.open = false; }
  }

  function adopt(handlers, peer, conn) { return new AdoptedTransport(handlers, peer, conn); }

  function create(handlers) {
    if (params().get('net') === 'bc') return new BCTransport(handlers);
    return new RoomTransport(handlers);
  }

  window.PD = window.PD || {};
  PD.Net = { create, adopt, makeCode, normalizeCode, ICE_SERVERS, PEER_OPTS };
})();
