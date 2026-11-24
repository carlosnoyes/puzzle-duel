/* Puzzle Duel — connection check.
 * Tests each piece friend games depend on, from this device and network, and explains the result:
 *   - PeerJS matchmaking server (introduces two phones for a direct link)
 *   - direct-link capability: STUN (public address), TURN relay, strict/symmetric NAT
 *   - each relay broker (the backup route): connect, subscribe, publish, receive
 * Also keeps a short log of recent networking events (PD.log) for the "Copy diagnostics" report.
 */
(function () {
  'use strict';
  const BUILD = '2026-11-24';
  const logLines = [];
  function log(msg) {
    const t = new Date().toISOString().slice(11, 19);
    logLines.push(t + ' ' + msg);
    if (logLines.length > 60) logLines.shift();
  }

  const withTimeout = (p, ms, label) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(label || 'timed out')), ms))]);

  function checkPeerServer() {
    return new Promise((resolve) => {
      if (typeof Peer === 'undefined') return resolve({ ok: false, detail: 'Networking library did not load.' });
      const t0 = performance.now();
      let peer;
      const done = r => { try { peer && peer.destroy(); } catch (e) {} resolve(r); };
      const timer = setTimeout(() => done({ ok: false, detail: 'No answer from the PeerJS server (0.peerjs.com) within 8s.' }), 8000);
      try { peer = new Peer(PD.Net.PEER_OPTS); } catch (e) { clearTimeout(timer); return done({ ok: false, detail: e.message }); }
      peer.on('open', () => { clearTimeout(timer); done({ ok: true, detail: `Reached in ${Math.round(performance.now() - t0)} ms` }); });
      peer.on('error', err => { clearTimeout(timer); done({ ok: false, detail: `Error: ${err && err.type || err}` }); });
    });
  }

  // Gather ICE candidates to see what kinds of direct paths this network allows.
  function checkDirect() {
    return new Promise(resolve => {
      if (typeof RTCPeerConnection === 'undefined') return resolve({ ok: false, detail: 'This browser has no WebRTC (common in apps’ built-in browsers). The relay will be used.', types: [] });
      let pc;
      try { pc = new RTCPeerConnection({ iceServers: PD.Net.ICE_SERVERS }); } catch (e) { return resolve({ ok: false, detail: e.message, types: [] }); }
      const cands = [];
      pc.createDataChannel('probe');
      pc.onicecandidate = e => { if (e.candidate && e.candidate.candidate) cands.push(e.candidate.candidate); };
      const finish = () => {
        try { pc.close(); } catch (e) {}
        const parse = c => { const p = c.split(' '); const typ = p[p.indexOf('typ') + 1]; return { typ, ip: p[4], port: p[5], proto: (p[2] || '').toLowerCase() }; };
        const list = cands.map(parse);
        const types = [...new Set(list.map(c => c.typ))];
        const srflx = list.filter(c => c.typ === 'srflx');
        // the same public IP showing different ports to different STUN servers = symmetric NAT
        const ports = new Set(srflx.map(c => c.ip + ':' + c.port));
        const ips = new Set(srflx.map(c => c.ip));
        const symmetric = srflx.length > 1 && ports.size > ips.size;
        const relay = types.includes('relay');
        let ok, detail;
        if (!srflx.length && !relay) { ok = false; detail = 'Could not discover a public address (STUN blocked). Direct links will fail; the relay will be used.'; }
        else if (symmetric && !relay) { ok = 'warn'; detail = 'Strict network (symmetric NAT) and the TURN relay is unreachable. Direct links will likely fail; the relay will be used.'; }
        else if (symmetric) { ok = 'warn'; detail = 'Strict network (symmetric NAT). Direct links will go through the TURN relay.'; }
        else { ok = true; detail = 'Public address found' + (relay ? ' · TURN relay reachable' : ' · TURN relay not reachable (fine on most networks)'); }
        resolve({ ok, detail, types, symmetric, relay });
      };
      pc.onicegatheringstatechange = () => { if (pc.iceGatheringState === 'complete') { clearTimeout(timer); finish(); } };
      const timer = setTimeout(finish, 7000);
      pc.createOffer().then(o => pc.setLocalDescription(o)).catch(e => { clearTimeout(timer); resolve({ ok: false, detail: e.message, types: [] }); });
    });
  }

  async function checkBroker(url) {
    const host = url.replace(/^wss?:\/\//, '').replace(/[:/].*$/, '');
    const t0 = performance.now();
    const link = new PD.Relay.MqttLink(url);
    try {
      await link.connect(7000);
      const topic = 'pduel/v1/_check/' + Math.random().toString(36).slice(2, 10);
      await withTimeout(link.subscribe(topic), 5000, 'subscribe timed out');
      const echo = new Promise(res => { link.onMessage = () => res(); });
      link.publish(topic, { k: 'check' });
      await withTimeout(echo, 5000, 'message did not come back');
      return { ok: true, label: host, detail: `Round trip in ${Math.round(performance.now() - t0)} ms` };
    } catch (e) {
      return { ok: false, label: host, detail: e.message + (location.protocol === 'https:' ? ' (port may be blocked on this network)' : '') };
    } finally { try { link.close(); } catch (e) {} }
  }

  function verdict(r) {
    const relayOk = r.brokers.some(b => b.ok === true);
    const directOk = r.server.ok === true && r.direct.ok === true;
    const directMaybe = r.server.ok === true && r.direct.ok === 'warn';
    if (!navigator.onLine) return { level: 'bad', text: 'This device is offline. Connect to the internet to play online.' };
    if (directOk && relayOk) return { level: 'good', text: 'Friend games should work here: direct link and backup relay both available.' };
    if (directOk) return { level: 'good', text: 'Friend games should work here over the direct link. (The backup relay is blocked on this network.)' };
    if (relayOk) return { level: 'warn', text: (directMaybe ? 'Direct links may fail on this network' : 'Direct links are unavailable here') + ', but the backup relay works, so friend games will still connect.' };
    if (directMaybe) return { level: 'warn', text: 'Only the direct link is available, and this network is strict, so connecting may fail. Try mobile data or another Wi-Fi.' };
    return { level: 'bad', text: 'Nothing needed for online games is reachable from this network. Some school or work Wi-Fi blocks games — try mobile data.' };
  }

  // Runs everything in parallel; onUpdate(results) fires as each check finishes.
  async function run(onUpdate) {
    const urls = PD.Relay ? PD.Relay.brokers() : [];
    const r = { online: navigator.onLine, server: { pending: true }, direct: { pending: true }, brokers: urls.map(u => ({ pending: true, label: u.replace(/^wss?:\/\//, '').replace(/[:/].*$/, '') })), started: new Date().toISOString() };
    const update = () => onUpdate && onUpdate(r);
    update();
    await Promise.all([
      checkPeerServer().then(x => { r.server = x; update(); }),
      checkDirect().then(x => { r.direct = x; update(); }),
      ...urls.map((u, i) => checkBroker(u).then(x => { r.brokers[i] = x; update(); })),
    ]);
    r.verdict = verdict(r);
    update();
    log('connection check: ' + r.verdict.level);
    return r;
  }

  function report(r) {
    const mark = x => x.pending ? '…' : x.ok === true ? 'OK' : x.ok === 'warn' ? 'WARN' : 'FAIL';
    const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
    const lines = [
      'Puzzle Duel connection report',
      `Build ${BUILD} · ${new Date().toISOString()}`,
      `Device: ${navigator.userAgent}`,
      `Mode: ${standalone ? 'installed app' : 'browser'} · online: ${navigator.onLine}` + (navigator.connection && navigator.connection.effectiveType ? ' · ' + navigator.connection.effectiveType : ''),
    ];
    if (r) {
      lines.push('', 'Result: ' + (r.verdict ? r.verdict.text : 'incomplete'));
      lines.push(`[${mark(r.server)}] PeerJS server: ${r.server.detail || ''}`);
      lines.push(`[${mark(r.direct)}] Direct link: ${r.direct.detail || ''}` + (r.direct.types ? ` (candidates: ${r.direct.types.join(', ') || 'none'})` : ''));
      r.brokers.forEach(b => lines.push(`[${mark(b)}] Relay ${b.label}: ${b.detail || ''}`));
    }
    lines.push('', 'Recent connection log:', ...(logLines.length ? logLines : ['(nothing yet)']));
    return lines.join('\n');
  }

  window.PD = window.PD || {};
  PD.log = log;
  PD.Diagnostics = { run, report, BUILD };
})();
