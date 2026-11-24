/* Puzzle Duel — fallback relay over public MQTT brokers (MQTT 3.1.1 over secure WebSockets).
 *
 * Direct WebRTC links fail on some networks (carrier-grade NAT, strict firewalls) and depend on
 * the PeerJS cloud server being up. The relay only needs an ordinary WebSocket, so it works
 * almost anywhere. Messages pass through a public broker on topics named after the room code.
 *
 * Topics:  pduel/v1/<CODE>/h            guests  -> host
 *          pduel/v1/<CODE>/g/<guestId>   host    -> one guest
 * Payload: JSON { k: 'hello'|'welcome'|'msg'|'bye'|'full', g?: guestId, m?: appMessage }
 */
(function () {
  'use strict';

  const DEFAULT_BROKERS = ['wss://broker.emqx.io:8084/mqtt', 'wss://broker.hivemq.com:8884/mqtt'];
  const enc = new TextEncoder(), dec = new TextDecoder();

  // test hook: ?relay=ws://127.0.0.1:1234 — read once at load (the app tidies the URL later)
  const OVERRIDE = new URLSearchParams(location.search).get('relay');
  function brokers() { return OVERRIDE ? OVERRIDE.split(',') : DEFAULT_BROKERS; }

  // ── minimal MQTT 3.1.1 client (QoS 0 only) ──
  function varint(n) { const out = []; do { let b = n % 128; n = Math.floor(n / 128); if (n > 0) b |= 128; out.push(b); } while (n > 0); return out; }
  function str(s) { const b = enc.encode(s); return [b.length >> 8, b.length & 255, ...b]; }
  function packet(type, body) { return new Uint8Array([type, ...varint(body.length), ...body]); }

  class MqttLink {
    constructor(url) {
      this.url = url; this.ws = null; this.open = false; this.closed = false;
      this.buf = new Uint8Array(0); this.pid = 1; this.subs = {}; this.ping = null;
      this.onMessage = null; this.onClose = null;
    }

    connect(timeoutMs = 6000) {
      return new Promise((resolve, reject) => {
        let settled = false;
        const fail = err => { if (!settled) { settled = true; clearTimeout(t); try { this.ws && this.ws.close(); } catch (e) {} reject(err); } };
        const t = setTimeout(() => fail(new Error('relay connect timeout')), timeoutMs);
        try { this.ws = new WebSocket(this.url, ['mqtt']); } catch (e) { return fail(e); }
        this.ws.binaryType = 'arraybuffer';
        this.ws.onopen = () => {
          const id = 'pd' + Math.random().toString(36).slice(2, 12);
          // protocol "MQTT", level 4, clean session, keepalive 30s
          this.ws.send(packet(0x10, [...str('MQTT'), 4, 0x02, 0, 30, ...str(id)]));
        };
        this.ws.onmessage = e => this._data(new Uint8Array(e.data), () => {
          if (settled) return; settled = true; clearTimeout(t);
          this.open = true;
          this.ping = setInterval(() => this._send(new Uint8Array([0xC0, 0])), 20000);
          resolve(this);
        }, rc => fail(new Error('relay refused connection (' + rc + ')')));
        this.ws.onerror = () => fail(new Error('relay unreachable'));
        this.ws.onclose = () => {
          const was = this.open;
          this.open = false; clearInterval(this.ping);
          fail(new Error('relay closed'));
          if (was && !this.closed && this.onClose) this.onClose();
        };
      });
    }

    _send(bytes) { if (this.ws && this.ws.readyState === 1) this.ws.send(bytes); }

    subscribe(topic) {
      return new Promise((resolve, reject) => {
        const id = this.pid++ & 0xffff || 1;
        this.subs[id] = resolve;
        this._send(packet(0x82, [id >> 8, id & 255, ...str(topic), 0]));
        setTimeout(() => { if (this.subs[id]) { delete this.subs[id]; reject(new Error('subscribe timeout')); } }, 6000);
      });
    }

    publish(topic, obj) { this._send(packet(0x30, [...str(topic), ...enc.encode(JSON.stringify(obj))])); }

    close() {
      this.closed = true; this.open = false; clearInterval(this.ping);
      try { this._send(new Uint8Array([0xE0, 0])); this.ws && this.ws.close(); } catch (e) {}
    }

    // stream parser: a WebSocket frame may hold several packets or part of one
    _data(chunk, onConnack, onRefused) {
      const b = new Uint8Array(this.buf.length + chunk.length); b.set(this.buf); b.set(chunk, this.buf.length);
      let i = 0;
      while (b.length - i >= 2) {
        let len = 0, mul = 1, j = i + 1, byte;
        do { if (j >= b.length) { this.buf = b.slice(i); return; } byte = b[j++]; len += (byte & 127) * mul; mul *= 128; } while (byte & 128);
        if (j + len > b.length) break;
        const type = b[i] & 0xF0, body = b.subarray(j, j + len);
        if (type === 0x20) { if (body[1] === 0) onConnack(); else onRefused(body[1]); }
        else if (type === 0x90) { const id = (body[0] << 8) | body[1]; const r = this.subs[id]; if (r) { delete this.subs[id]; r(); } }
        else if (type === 0x30) {
          const tl = (body[0] << 8) | body[1];
          const topic = dec.decode(body.subarray(2, 2 + tl));
          const qos = (b[i] >> 1) & 3;
          const payload = body.subarray(2 + tl + (qos ? 2 : 0));
          let obj = null; try { obj = JSON.parse(dec.decode(payload)); } catch (e) {}
          if (obj && this.onMessage) this.onMessage(topic, obj);
        }
        i = j + len;
      }
      this.buf = b.slice(i);
    }
  }

  const base = code => 'pduel/v1/' + code;

  // A link that reconnects (with backoff) and re-subscribes if the socket drops.
  class StickyLink {
    constructor(url, topic, onMsg, onState) {
      this.url = url; this.topic = topic; this.onMsg = onMsg; this.onState = onState;
      this.link = null; this.ready = false; this.stopped = false; this.delay = 1000; this.timer = null;
    }
    async start() {
      if (this.stopped) return;
      clearTimeout(this.timer);
      const l = new MqttLink(this.url);
      try {
        await l.connect();
        await l.subscribe(this.topic);
      } catch (e) {
        try { l.close(); } catch (e2) {}
        this._retry(); return;
      }
      if (this.stopped) { l.close(); return; }
      this.link = l; this.ready = true; this.delay = 1000;
      l.onMessage = (t, o) => this.onMsg(o, this);
      l.onClose = () => { this.ready = false; this.link = null; this.onState(); this._retry(); };
      this.onState();
    }
    _retry() { if (this.stopped) return; this.timer = setTimeout(() => this.start(), this.delay); this.delay = Math.min(this.delay * 2, 15000); }
    wake() { if (!this.ready && !this.stopped) { this.delay = 1000; this.start(); } }
    publish(topic, obj) { if (this.link && this.ready) this.link.publish(topic, obj); }
    stop() { this.stopped = true; clearTimeout(this.timer); this.ready = false; try { this.link && this.link.close(); } catch (e) {} }
  }

  // Host side: listen on every broker; each guest becomes a "channel".
  class RelayHost {
    constructor(code, { onChannel, onState }) {
      this.code = code; this.onChannel = onChannel; this.onState = onState;
      this.chans = {}; // `${guestId}|${brokerUrl}` -> channel (one per guest per broker)
      this.links = brokers().map(url => new StickyLink(url, base(code) + '/h', (o, link) => this._msg(o, link), () => this.onState()));
    }
    start() { this.links.forEach(l => l.start()); }
    get ready() { return this.links.some(l => l.ready); }
    wake() { this.links.forEach(l => l.wake()); }
    stop() { Object.values(this.chans).forEach(c => c._bye()); this.links.forEach(l => l.stop()); }
    _msg(o, link) {
      if (!o || typeof o.g !== 'string' || o.g.length > 40) return;
      const g = o.g, key = g + '|' + link.url, to = base(this.code) + '/g/' + g;
      let ch = this.chans[key];
      if (o.k === 'hello') {
        link.publish(to, { k: 'welcome' });
        if (ch) return; // repeated hello
        ch = this.chans[key] = {
          open: true, onMessage: null, onClose: null,
          send: m => { if (ch.open) link.publish(to, { k: 'msg', m }); },
          close: () => { if (!ch.open) return; ch.open = false; link.publish(to, { k: 'bye' }); delete this.chans[key]; },
          _bye: () => { try { ch.close(); } catch (e) {} },
        };
        this.onChannel(ch, g, 'relay');
        return;
      }
      if (!ch) return;
      if (o.k === 'msg' && ch.onMessage) ch.onMessage(o.m);
      else if (o.k === 'bye') { ch.open = false; delete this.chans[key]; ch.onClose && ch.onClose(); }
    }
  }

  // Guest side: say hello on every broker until the host answers on one of them.
  class RelayJoin {
    constructor(code, guestId, { onChannel, onState }) {
      this.code = code; this.g = guestId; this.onChannel = onChannel; this.onState = onState || (() => {});
      this.done = false; this.channel = null; this.hello = null;
      const mine = base(code) + '/g/' + guestId;
      this.links = brokers().map(url => new StickyLink(url, mine, (o, link) => this._msg(o, link), () => this.onState()));
    }
    start() {
      this.links.forEach(l => l.start());
      // keep saying hello on every connected broker until the host answers on one of them
      const say = () => { if (this.done) { clearInterval(this.hello); return; } this.links.forEach(l => l.publish(base(this.code) + '/h', { k: 'hello', g: this.g })); };
      this.hello = setInterval(say, 1200);
      setTimeout(say, 300);
    }
    get reachable() { return this.links.some(l => l.ready); }
    wake() { this.links.forEach(l => l.wake()); }
    _msg(o, link) {
      if (!o) return;
      if (o.k === 'welcome') {
        if (this.done) return;
        this.done = true; clearInterval(this.hello);
        // stop the other brokers; tell the host we're not using them
        this.links.forEach(l => { if (l !== link) { l.publish(base(this.code) + '/h', { k: 'bye', g: this.g }); l.stop(); } });
        const to = base(this.code) + '/h';
        const ch = this.channel = {
          link, open: true, onMessage: null, onClose: null,
          send: m => { if (ch.open) link.publish(to, { k: 'msg', g: this.g, m }); },
          close: () => { if (!ch.open) return; ch.open = false; link.publish(to, { k: 'bye', g: this.g }); setTimeout(() => link.stop(), 300); },
        };
        this.onChannel(ch);
        return;
      }
      const ch = this.channel; if (!ch || link !== ch.link) return;
      if (o.k === 'msg' && ch.onMessage) ch.onMessage(o.m);
      else if (o.k === 'bye' || o.k === 'full') { ch.open = false; ch.onClose && ch.onClose(o.k); }
    }
    stop() { clearInterval(this.hello); if (this.channel) this.channel.close(); this.links.forEach(l => setTimeout(() => l.stop(), 300)); }
  }

  window.PD = window.PD || {};
  PD.Relay = { RelayHost, RelayJoin, MqttLink, brokers, available: typeof WebSocket !== 'undefined' };
})();
