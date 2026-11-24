// Test double for PeerJS: an in-memory "PeerJS cloud" shared by same-origin iframes.
// The network itself (peers, connections, timers) lives in the TOP window's JavaScript realm, so a
// player's frame closing can't freeze deliveries to the others — just like a real network.
//
// Mirrors the PeerJS behaviours the app relies on:
//  - new Peer(id) fails with 'unavailable-id' if the id is registered
//  - connect() to an unregistered id emits 'peer-unavailable' on the connecting peer
//  - disconnect() frees the id but keeps live connections; destroy() closes everything
//  - a peer that never registered is destroyed on a fatal error; one that had registered is disconnected
// Failure switches (set on window.top.__mock): serverDown, failRTC (data channel never opens),
// stale[id] = until (server still holds a dropped session's ID), and __mockBlip(id, ms).
// Also gives each iframe (by window.name) its own persistent in-memory localStorage.
(function () {
  const T = window.top;
  const S = T.__mock || (T.__mock = { ids: new Map(), ctr: 0, storage: {}, log: [] });
  S.stale = S.stale || {};

  // ── per-frame: storage that survives iframe reloads ──
  const bucket = S.storage[window.name] || (S.storage[window.name] = {});
  const mem = {
    getItem: k => (k in bucket ? bucket[k] : null),
    setItem: (k, v) => { bucket[k] = String(v); },
    removeItem: k => { delete bucket[k]; },
    clear: () => { Object.keys(bucket).forEach(k => delete bucket[k]); },
    key: i => Object.keys(bucket)[i] || null,
    get length() { return Object.keys(bucket).length; },
  };
  Object.defineProperty(window, 'localStorage', { value: mem, configurable: true });

  // ── the network, built once in the top window's realm ──
  function factory(S) {
    const lat = () => 15 + Math.random() * 40;
    // frames that have closed: their code must never be called again (a removed iframe's functions
    // stay callable from this realm, which would let "ghost" players keep playing)
    const dead = new Set();
    class EE {
      constructor() { this._h = {}; }
      on(e, f) { (this._h[e] = this._h[e] || []).push(f); return this; }
      off(e, f) { this._h[e] = (this._h[e] || []).filter(x => x !== f); return this; }
      emit(e, ...a) { (this._h[e] || []).slice().forEach(f => { try { f(...a); } catch (err) { /* listener's frame may be gone */ } }); }
    }
    class Conn extends EE {
      constructor(owner, remoteId) { super(); this.owner = owner; this.peer = remoteId; this.open = false; this.other = null; }
      emit(...a) { if (!dead.has(this.owner.owner)) super.emit(...a); }
      send(d) {
        if (!this.open) return;
        const o = this.other, c = JSON.parse(JSON.stringify(d));
        // jittery latency, but in order (WebRTC reliable channels are ordered)
        const at = Math.max(Date.now() + 5 + Math.random() * 10, (this._lastAt || 0) + 1);
        this._lastAt = at;
        setTimeout(() => { if (o.open) o.emit('data', c); }, at - Date.now());
      }
      close() {
        if (!this.open) return;
        this.open = false; this.emit('close');
        const o = this.other;
        // the far end learns of the close only after any data already in flight (as on a real connection)
        if (o && o.open) { const at = Math.max(Date.now() + 5, (this._lastAt || 0) + 1); setTimeout(() => { if (o.open) { o.open = false; o.emit('close'); } }, at - Date.now()); }
      }
    }
    class Peer extends EE {
      constructor(id, opts, owner) {
        super();
        if (id == null || typeof id === 'object') id = 'anon-' + (++S.ctr) + '-' + Math.random().toString(36).slice(2, 6);
        this.id = id; this.owner = owner; this.open = false; this.destroyed = false; this.disconnected = false; this.conns = []; this._last = null;
        this._register();
      }
      emit(...a) { if (!dead.has(this.owner)) super.emit(...a); }
      _register() {
        const id = this.id;
        setTimeout(() => {
          if (this.destroyed) return;
          if (S.serverDown) { const e = new Error('Lost connection to server'); e.type = 'network'; this._abort(e); return; }
          const holder = S.ids.get(id);
          if ((holder && holder !== this && !holder.destroyed && !holder.disconnected) || (S.stale[id] && Date.now() < S.stale[id])) {
            const e = new Error('ID "' + id + '" is taken'); e.type = 'unavailable-id'; this._abort(e); return;
          }
          S.ids.set(id, this); this.open = true; this.disconnected = false; this._last = id;
          S.log.push(['claim', this.owner, id]);
          this.emit('open', id);
        }, lat());
      }
      _abort(e) { this.emit('error', e); if (this._last) this.disconnect(); else this.destroy(); }
      connect(id, opts) {
        const c = new Conn(this, id); this.conns.push(c);
        setTimeout(() => {
          const t = S.ids.get(id);
          if (!t || t.destroyed || t.disconnected || this.destroyed) {
            const e = new Error('Could not connect to peer ' + id); e.type = 'peer-unavailable'; this.emit('error', e); return;
          }
          const c2 = new Conn(t, this.id); c.other = c2; c2.other = c; t.conns.push(c2);
          c2.metadata = opts && opts.metadata;
          t.emit('connection', c2);
          if (S.failRTC) return; // signalling reached the host, but the direct link never opens (NAT)
          setTimeout(() => { c.open = c2.open = true; c2.emit('open'); c.emit('open'); }, lat());
        }, lat());
        return c;
      }
      disconnect() {
        if (this.disconnected) return;
        if (S.ids.get(this.id) === this) S.ids.delete(this.id);
        this.disconnected = true; this.open = false;
        this.emit('disconnected');
      }
      reconnect() { if (this.destroyed) throw new Error('destroyed'); if (!this.disconnected) return; this._register(); }
      destroy() {
        if (this.destroyed) return;
        this.disconnect(); this.destroyed = true;
        this.conns.forEach(c => c.close());
        this.emit('close');
      }
    }
    const all = [];
    return {
      create(id, opts, owner) { const p = new Peer(id, opts, owner); all.push(p); return p; },
      closeFrame(owner) { dead.add(owner); all.forEach(p => { if (p.owner === owner) p.destroy(); }); },
      kill(frameName) { all.forEach(p => { if (p.owner.startsWith(frameName + '#')) p.destroy(); }); },
      blip(id, ms) { const p = S.ids.get(id); if (!p) return false; S.stale[id] = Date.now() + ms; p.disconnect(); return true; },
    };
  }
  if (!T.__mockNet) T.__mockNet = new T.Function('S', 'return (' + factory.toString() + ')(S);')(S);
  const NET = T.__mockNet;
  T.__mockBlip = (id, ms) => NET.blip(id, ms);
  T.__mockKill = name => NET.kill(name);

  // ── per-frame: the Peer constructor the app sees ──
  const owner = window.name + '#' + Math.random().toString(36).slice(2, 6);
  window.Peer = function (id, opts) { return NET.create(id, opts, owner); };
  window.peerjs = { Peer: window.Peer };
  // closing or reloading this frame closes its peers, like a closed tab. Registered after the app's
  // own handlers (on load), so the app gets to say goodbye first, as it would in a real browser.
  window.addEventListener('load', () => window.addEventListener('pagehide', () => NET.closeFrame(owner)));
})();
