#!/usr/bin/env node
// NOODLE CLI — thin agent client for the noodle daemon. Usage: noodle <cmd> [args] [--profile id] [--port 8791]
const http = require('http');
const PORT = process.env.NOODLE_PORT || '8791';
const argv = process.argv.slice(2);
const flags = {}; const pos = [];
for (const a of argv) { if (a.startsWith('--')) { const [k, v] = a.slice(2).split('='); flags[k] = v === undefined ? true : v; } else pos.push(a); }
const cmd = pos.shift() || 'help';
const profile = flags.profile || 'default';

function req(method, path, body) {
  return new Promise((res, rej) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ host: '127.0.0.1', port: PORT, path, method, headers: { 'Content-Type': 'application/json' } }, resp => {
      let d = ''; resp.on('data', c => d += c); resp.on('end', () => res(d));
    });
    r.on('error', rej); if (data) r.write(data); r.end();
  });
}

(async () => {
  try {
    switch (cmd) {
      case 'open': console.log(await req('POST', '/open', { url: pos[0], profile, challengeMs: flags.challenge ? parseInt(flags.challenge, 10) : undefined })); break;
      case 'snapshot': console.log(await req('GET', '/snapshot?profile=' + profile)); break;
      case 'state': console.log(await req('GET', '/state?profile=' + profile)); break;
      case 'read': console.log(await req('GET', '/read?profile=' + profile)); break;
      case 'back': console.log(await req('POST', '/back', { profile })); break;
      case 'click': console.log(await req('POST', '/click', { ref: parseInt(pos[0], 10), profile })); break;
      case 'type': console.log(await req('POST', '/type', { ref: parseInt(pos[0], 10), text: pos.slice(1).join(' '), profile })); break;
      case 'press': console.log(await req('POST', '/press', { key: pos[0] || 'Enter', profile })); break;
      case 'close': console.log(await req('POST', '/close', { profile })); break;
      case 'health': console.log(await req('GET', '/health')); break;
      default: console.log(`NOODLE v0 by Merlin — agent browser
commands: open <url> | snapshot | click <ref> | type <ref> <text> | press <key> | read | state | back | close | health
flags: --profile <id> --challenge <ms> --port <n>
daemon: xvfb-run -a node noodle.js --port=8791`);
    }
  } catch (e) { console.error('NOODLE_ERR: ' + e.message); process.exit(1); }
})();
