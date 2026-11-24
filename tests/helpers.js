// Shared helpers for the Puzzle Duel browser tests (Node's built-in test runner + Playwright).
const { chromium } = require('playwright');
const path = require('path');
const http = require('http');

const ROOT = path.resolve(__dirname, '..');
const MOCK_PEER = path.join(__dirname, 'mock-peer.js');
// Lets pages reach the local test MQTT brokers on 127.0.0.1 (Chromium blocks that by default).
const BROWSER_ARGS = ['--disable-features=LocalNetworkAccessChecks,BlockInsecurePrivateNetworkRequests,PrivateNetworkAccessChecks'];
// A page that hosts several players as iframes sharing one mock PeerJS cloud (window.__mock).
const HARNESS = '<!doctype html><body style="margin:0;background:#000"><script>window.__mock={ids:new Map(),ctr:0,storage:{},log:[],stale:{}};</script></body>';

const sleep = ms => new Promise(r => setTimeout(r, ms));

function launch() { return chromium.launch({ args: BROWSER_ARGS }); }

// Serve the repo at http(s)://duel.test without a web server; optionally swap PeerJS for the mock.
async function serve(ctx, { mockPeer = false } = {}) {
  await ctx.route(/https?:\/\/duel\.test\/.*/, route => {
    const u = new URL(route.request().url());
    if (u.pathname === '/harness.html') return route.fulfill({ contentType: 'text/html', body: HARNESS });
    if (mockPeer && u.pathname === '/vendor/peerjs.min.js') return route.fulfill({ path: MOCK_PEER, contentType: 'application/javascript' });
    let f = path.join(ROOT, decodeURIComponent(u.pathname));
    if (u.pathname.endsWith('/')) f = path.join(f, 'index.html');
    return route.fulfill({ path: f });
  });
}

// Collect page errors so a test can assert there were none.
function watchErrors(page, errs = []) {
  page.on('pageerror', e => errs.push(e.message));
  page.on('console', m => { if (m.type() === 'error' && !/WebSocket|ERR_CONNECTION|Failed to load resource/.test(m.text())) errs.push(m.text()); });
  return errs;
}

async function waitFor(cond, ms, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { if (await cond()) return Date.now() - t0; } catch (e) { /* frame may be reloading */ }
    await sleep(120);
  }
  throw new Error('timed out waiting for: ' + label);
}

// Visible screen id of a page or frame, e.g. 'screen-home'.
const screenOf = pf => pf.evaluate(() => [...document.querySelectorAll('.screen')].find(s => !s.classList.contains('hidden')).id);
const isVisible = (pf, id) => pf.evaluate(id => !document.getElementById(id).classList.contains('hidden'), id);

// Real MQTT broker (Aedes) over WebSockets, standing in for the public relay brokers.
function startBroker() {
  const aedes = require('aedes');
  const { WebSocketServer, createWebSocketStream } = require('ws');
  return new Promise(resolve => {
    const broker = aedes.createBroker ? aedes.createBroker() : aedes();
    const server = http.createServer();
    const wss = new WebSocketServer({ server, handleProtocols: () => 'mqtt' });
    const b = { msgs: 0, close: () => { wss.close(); server.close(); broker.close(); } };
    wss.on('connection', ws => broker.handle(createWebSocketStream(ws)));
    broker.on('publish', (p, c) => { if (c && p.topic.startsWith('pduel/')) b.msgs++; });
    server.listen(0, '127.0.0.1', () => { b.url = 'ws://127.0.0.1:' + server.address().port; resolve(b); });
  });
}

// Several players in one page (iframes), each with its own name and storage.
class Harness {
  constructor(page) { this.page = page; this.n = 0; }
  static async open(ctx) {
    const page = await ctx.newPage();
    const h = new Harness(page);
    h.errors = watchErrors(page);
    await page.goto('http://duel.test/harness.html');
    return h;
  }
  frame(name) { return this.page.frame({ name }); }
  async reset(flags = {}) {
    await this.page.evaluate(f => {
      document.querySelectorAll('iframe').forEach(x => x.remove());
      Object.assign(window.__mock, { ids: new Map(), stale: {}, serverDown: false, failRTC: false }, f);
    }, flags);
    await sleep(250);
  }
  // add a player; returns the frame name. storage: extra localStorage entries (objects are JSON-encoded)
  async add(player, { query = '', hash = '', storage = {} } = {}) {
    const name = player + (++this.n);
    await this.page.evaluate(([n, p, extra]) => {
      const st = window.__mock.storage[n] = {};
      st['pduel.name'] = JSON.stringify(p); st['pduel.seenHowto'] = 'true'; st['pduel.sound'] = 'false';
      for (const k in extra) st['pduel.' + k] = JSON.stringify(extra[k]);
    }, [name, player, storage]);
    await this.page.evaluate(([n, src]) => {
      const f = document.createElement('iframe'); f.name = n; f.src = src;
      f.style.cssText = 'width:360px;height:860px;border:1px solid #333';
      document.body.appendChild(f);
    }, [name, '/index.html' + query + hash]);
    await waitFor(() => this.frame(name).evaluate(() => !!(window.PD && PD.app)), 10000, 'app loaded in ' + name);
    return name;
  }
  ev(name, fn, arg) { return this.frame(name).evaluate(fn, arg); }
  storage(name, key) { return this.page.evaluate(([n, k]) => { const v = window.__mock.storage[n]['pduel.' + k]; return v == null ? null : JSON.parse(v); }, [name, key]); }
  remove(name) { return this.page.evaluate(n => document.querySelector(`iframe[name="${n}"]`).remove(), name); }
  // frames share one joint session history; stop a frame's history.back() from popping another's entry
  isolateHistory(name) { return this.ev(name, () => { history.back = () => {}; }); }
}

module.exports = { ROOT, launch, serve, watchErrors, waitFor, sleep, screenOf, isVisible, startBroker, Harness };
