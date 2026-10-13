const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({ headless: false });
  const p = await b.newPage();
  await p.goto('https://example.com', { waitUntil: 'domcontentloaded', timeout: 30000 });
  console.log('SMOKE_TITLE=' + await p.title());
  await b.close();
})().catch(e => { console.error('SMOKE_FAIL: ' + e.message); process.exit(1); });
