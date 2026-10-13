#!/usr/bin/env node
// NOODLE v1 — agent-native browser daemon by Merlin. MIT. Built for agents, not thumbs.
// Headful Chromium under Xvfb + persistent profiles + HTTP JSON API + semantic refs + strike budget.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const PORT = parseInt((process.argv.find(a => a.startsWith('--port=')) || '').split('=')[1] || process.env.NOODLE_PORT || '8791', 10);
const DATA = process.env.NOODLE_DATA || path.join(__dirname, 'profiles');
const STRIKE_FILE = path.join(__dirname, 'strikes.json');
fs.mkdirSync(DATA, { recursive: true });

const sessions = {}; // profileId -> { ctx, page, refs, refSeq, state, lastUrl }

// ---- Web Bot Auth identity (RFC 9421 + web-bot-auth draft): prove who NOODLE is ----
const crypto = require('crypto');
const WBA = { key: null, keyid: 'noodle-agent-v1', agent: 'https://skynet.website/.well-known/http-message-signatures-directory' };
try {
  WBA.key = crypto.createPrivateKey(fs.readFileSync(path.join(__dirname, 'keys', 'noodle-agent-ed25519.pem')));
  WBA.keyid = fs.readFileSync(path.join(__dirname, 'keys', 'keyid.txt'), 'utf8').trim(); // RFC 7638 JWK thumbprint
} catch { console.error('NOODLE: no WBA key — browsing unsigned (run wba_init.js)'); }
function signRequest(method, urlObj, opts = {}) {
  if (!WBA.key) return null;
  const created = Math.floor(Date.now() / 1000);
  const expires = opts.expires || (created + 300);
  const agentHeader = `sig1="${WBA.agent}"`;
  const comps = [
    `"@method": ${method.toUpperCase()}`, // CF reference keeps uppercase — verifier interop requires it
    `"@target-uri": ${urlObj.href}`,
    `"signature-agent";key="sig1": "${WBA.agent}"`
  ];
  let params = '("@method" "@target-uri" "signature-agent";key="sig1")';
  params += `;created=${created};keyid="${WBA.keyid}";alg="ed25519";expires=${expires}`;
  if (opts.nonce) params += `;nonce="${opts.nonce}"`;
  params += ';tag="web-bot-auth"';
  const base = comps.join('\n') + '\n' + `"@signature-params": ${params}`; // CF reference: LF joins, NO trailing newline
  if (process.env.NOODLE_SIGDEBUG) fs.appendFileSync(path.join(__dirname, 'sigbase.log'), JSON.stringify(base) + '\n');
  const sig = crypto.sign(null, Buffer.from(base), WBA.key).toString('base64');
  return {
    'Signature-Input': `sig1=${params}`,
    'Signature': `sig1=:${sig}:`,
    'Signature-Agent': agentHeader
  };
}

async function session(profileId) {
  if (sessions[profileId]) return sessions[profileId];
  const ctx = await chromium.launchPersistentContext(path.join(DATA, profileId), {
    headless: false, // honest browser under Xvfb
    viewport: { width: 1440, height: 900 },
    ignoreHTTPSErrors: true, // self-signed internal boxes (iLO etc) — state machine still tells truth
    args: ['--disable-blink-features=AutomationControlled'] // remove the LEAK; we do NOT fake fingerprints
  });
  // sign EVERY request with our agent identity (passport, not lockpick)
  await ctx.route('**/*', async route => {
    try {
      const rq = route.request();
      const h = { ...rq.headers() };
      delete h['content-type']; // chromium recomputes; avoid mismatch
      const sigH = signRequest(rq.method(), new URL(rq.url()), s.wbaOpts || {});
      if (sigH) Object.assign(h, sigH);
      await route.continue({ headers: h });
    } catch { await route.continue().catch(() => {}); }
  });
  const page = ctx.pages()[0] || await ctx.newPage();
  const s = { ctx, page, refs: new Map(), refSeq: 0, state: 'about:blank', lastUrl: '' };
  sessions[profileId] = s;
  return s;
}

async function detectState(page) {
  try {
    const info = await page.evaluate(() => {
      const t = (document.title || '');
      const b = (document.body && document.body.innerText || '').slice(0, 4000);
      const hasSel = s => !!document.querySelector(s);
      return {
        title: t, body: b,
        cf: /Just a moment|Attention Required|Checking your browser|Verify you are human/.test(t + b),
        anubis: /Anubis|Verifying that you are not a robot|Making sure you're not a bot|Verifying your request|Calculating|Difficulty:|busy verifying|just a second/.test(t + b),
        humanCaptcha: hasSel('iframe[src*="recaptcha"],iframe[src*="hcaptcha"],iframe[src*="captcha"],iframe[src*="turnstile"]'),
        loginWall: hasSel('input[type="password"]'),
        len: (document.body && document.body.innerText || '').length
      };
    });
    if (info.humanCaptcha) return 'CHALLENGE_HUMAN';
    if (info.cf || info.anubis) return 'CHALLENGE_JS';
    if (info.len < 200 && info.loginWall) return 'LOGIN_WALL';
    if (info.len < 120) return 'THIN';
    return 'CONTENT';
  } catch { return 'ERROR'; }
}

async function snapshotRefs(page) {
  return page.evaluate(() => {
    const sel = 'a,button,input,select,textarea,[role=button],[role=link],[role=tab],[role=menuitem],[onclick],[contenteditable=true],summary,h1,h2,h3';
    const out = [];
    for (const el of document.querySelectorAll(sel)) {
      const r = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      if (r.width < 2 || r.height < 2 || style.display === 'none' || style.visibility === 'hidden') continue;
      const name = (el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('title') || '').trim().slice(0, 80);
      out.push({
        role: el.getAttribute('role') || el.tagName.toLowerCase(),
        name,
        href: (el.getAttribute && el.getAttribute('href') || '').slice(0, 160),
        x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2)
      });
      if (out.length >= 500) break;
    }
    return out;
  });
}

// ---- strike budget: persisted so cooldowns survive restarts (iLO lesson) ----
let strikes = {};
try { strikes = JSON.parse(fs.readFileSync(STRIKE_FILE, 'utf8')); } catch {}
function persistStrikes() { try { fs.writeFileSync(STRIKE_FILE, JSON.stringify(strikes)); } catch {} }
function guard(host) {
  const s = strikes[host];
  if (s && s.until && Date.now() < s.until) throw new Error('COOLDOWN: ' + host + ' until ' + new Date(s.until).toISOString() + ' (strike budget spent — back off, this is law)');
  return s && s.n ? s : { n: 0, until: 0 };
}
function strike(host, bad) {
  const s = guard(host);
  s.n = bad ? (s.n || 0) + 1 : 0;
  if (s.n >= 4) { s.until = Date.now() + 30 * 60 * 1000; console.error('NOODLE: cooldown engaged for ' + host); }
  strikes[host] = s; persistStrikes();
}

const TOOLS = {
  name: 'noodle', by: 'merlin', version: '1.1', license: 'MIT',
  identity: { scheme: 'web-bot-auth (RFC 9421 Ed25519)', keyid: 'noodle-agent-v1', directory: 'https://skynet.website/.well-known/http-message-signatures-directory' },
  description: 'Agent-native browser. Real Chromium, honest behaviour, persistent profiles, semantic refs, page-state truth, enforced cooldowns.',
  endpoints: [
    { cmd: 'open', method: 'POST', path: '/open', body: { url: 'string', profile: 'string?', challengeMs: 'number?' }, returns: '{url,status,state,ms}' },
    { cmd: 'snapshot', method: 'GET', path: '/snapshot', query: { profile: 'string?', role: 'a|button|input|select|textarea|h1|h2|h3|any?', contains: 'name substring?' }, returns: '{url,title,state,refs:[{ref,role,name,href,x,y}]}' },
    { cmd: 'click', method: 'POST', path: '/click', body: { ref: 'number', profile: 'string?' } },
    { cmd: 'type', method: 'POST', path: '/type', body: { ref: 'number', text: 'string', profile: 'string?' } },
    { cmd: 'press', method: 'POST', path: '/press', body: { key: 'Enter|Tab|...', profile: 'string?' } },
    { cmd: 'read', method: 'GET', path: '/read', query: { profile: 'string?' }, returns: '{title,state,text}' },
    { cmd: 'extract', method: 'POST', path: '/extract', body: { want: [{ role: 'string', contains: 'string?' }], profile: 'string?' }, returns: '{found:[{role,name,href}]}' },
    { cmd: 'state', method: 'GET', path: '/state' },
    { cmd: 'back', method: 'POST', path: '/back' },
    { cmd: 'close', method: 'POST', path: '/close' }
  ],
  states: ['CONTENT', 'CHALLENGE_JS', 'CHALLENGE_HUMAN', 'LOGIN_WALL', 'THIN', 'ERROR'],
  laws: ['No fingerprint spoofing or captcha-solving services.', 'Human captcha -> park and ask owner.', 'Cooldowns enforced per domain; do not restart to escape them (they persist).', 'Owner-provided logins only.']
};

function json(res, code, obj) { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); }
function body(req) { return new Promise(r => { let d = ''; req.on('data', c => d += c); req.on('end', () => r(d ? JSON.parse(d) : {})); }); }

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const p = u.pathname;
  try {
    if (p === '/health') return json(res, 200, { ok: true, name: 'noodle', by: 'merlin', v: '1.0' });
    if (p === '/tools') return json(res, 200, TOOLS);
    const b = req.method === 'POST' ? await body(req) : {};
    const profile = b.profile || u.searchParams.get('profile') || 'default';
    const s = await session(profile);
    const page = s.page;

    if (p === '/open') {
      const url = new URL(b.url); const host = url.hostname;
      guard(host);
      const t0 = Date.now();
      const resp = await page.goto(b.url, { waitUntil: 'domcontentloaded', timeout: b.timeoutMs || 45000 });
      let st = await detectState(page);
      const tEnd = t0 + (b.challengeMs || 25000);
      while (st === 'CHALLENGE_JS' && Date.now() < tEnd) {
        await page.waitForTimeout(3000);
        st = await detectState(page);
        if (st === 'THIN') st = 'CHALLENGE_JS';
      }
      const hdrs = resp ? resp.headers() : {};
      const challenged = resp && resp.status() === 403 && hdrs['accept-signature']; // WBA challenge = protocol flow, not a failure
      strike(host, !challenged && (st === 'CHALLENGE_HUMAN' || (resp && (resp.status() === 403 || resp.status() === 429))));
      if (b.wbaOpts) s.wbaOpts = b.wbaOpts; // nonce-challenge responses from verifiers
      s.state = st; s.lastUrl = page.url();
      return json(res, 200, { url: page.url(), status: resp && resp.status(), state: st, ms: Date.now() - t0 });
    }
    if (p === '/state') { s.state = await detectState(page); return json(res, 200, { url: page.url(), state: s.state }); }
    if (p === '/snapshot') {
      let items = await snapshotRefs(page);
      const role = u.searchParams.get('role'); const contains = (u.searchParams.get('contains') || '').toLowerCase();
      if (role && role !== 'any') items = items.filter(i => i.role === role);
      if (contains) items = items.filter(i => i.name.toLowerCase().includes(contains) || i.href.toLowerCase().includes(contains));
      s.refs = new Map(); s.refSeq = 0;
      const out = items.map(it => ({ ref: ++s.refSeq, ...it }));
      s.state = await detectState(page);
      return json(res, 200, { url: page.url(), title: await page.title(), state: s.state, refs: out });
    }
    if (p === '/extract') {
      const want = b.want || [];
      const items = await snapshotRefs(page);
      const found = [];
      for (const w of want) for (const it of items) {
        if (it.role === w.role && (!w.contains || it.name.toLowerCase().includes(String(w.contains).toLowerCase()) || it.href.toLowerCase().includes(String(w.contains).toLowerCase()))) found.push(it);
      }
      return json(res, 200, { url: page.url(), found: found.slice(0, 100) });
    }
    if (p === '/click' || p === '/type' || p === '/press') {
      const it = s.refs.get(parseInt(b.ref, 10));
      if (!it) return json(res, 400, { error: 'unknown or stale ref — call /snapshot first' });
      if (p === '/click') await page.mouse.click(it.x, it.y);
      if (p === '/type') { await page.mouse.click(it.x, it.y); await page.keyboard.insertText(b.text || ''); }
      if (p === '/press') await page.keyboard.press(b.key || 'Enter');
      await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
      s.state = await detectState(page);
      return json(res, 200, { ok: true, url: page.url(), state: s.state });
    }
    if (p === '/read') {
      const text = await page.evaluate(() => (document.body && document.body.innerText || '').slice(0, 60000));
      return json(res, 200, { url: page.url(), title: await page.title(), state: await detectState(page), text });
    }
    if (p === '/back') { await page.goBack({ timeout: 15000 }).catch(() => {}); return json(res, 200, { url: page.url(), state: await detectState(page) }); }
    if (p === '/close') { for (const k of Object.keys(sessions)) { await sessions[k].ctx.close().catch(() => {}); delete sessions[k]; } return json(res, 200, { ok: true }); }
    return json(res, 404, { error: 'unknown path', tools: '/tools' });
  } catch (e) {
    return json(res, 500, { error: String(e.message || e).slice(0, 300) });
  }
});

server.listen(PORT, '127.0.0.1', () => console.log('NOODLE v1 by Merlin — http://127.0.0.1:' + PORT + ' (profiles: ' + DATA + ', strikes persist)'));
process.on('SIGTERM', async () => { for (const k of Object.keys(sessions)) await sessions[k].ctx.close().catch(() => {}); process.exit(0); });
