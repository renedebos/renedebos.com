import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { webkit, devices } = require('playwright-webkit');
const b = await webkit.launch();
const iphone = devices['iPhone 13'] || {};
const ctx = await b.newContext({ ...iphone });
const p = await ctx.newPage();
const logs = [];
p.on('console', m => { if (m.type()==='error'||m.type()==='warning') logs.push(m.type()+': '+m.text().slice(0,200)); });
p.on('pageerror', e => logs.push('pageerror: ' + e.message));
await p.goto('https://renedebos.com/shows/jerry-cafe-java-1999-06-17/', { waitUntil:'load' });
await p.waitForTimeout(4000);
await p.evaluate(() => {
  window.__t = [];
  const c = window.PLAYER_BOOT && window.PLAYER_BOOT.controller;
  if (!c) { window.__t.push('NO CONTROLLER'); return; }
  const a = c.audioElement;
  window.__t.push('preload=' + a.preload + ' readyState=' + a.readyState);
  ['play','playing','pause','error','abort','emptied','loadstart','stalled','waiting','canplay']
    .forEach(ev => a.addEventListener(ev, () => window.__t.push(ev)));
  const rm = a.removeAttribute.bind(a); a.removeAttribute = n => { window.__t.push('removeAttribute('+n+')'); return rm(n); };
  const ld = a.load.bind(a); a.load = () => { window.__t.push('load()'); return ld(); };
});
const row = p.locator('.track-row').nth(4);
await row.scrollIntoViewIfNeeded();
await row.locator('.play-btn').click();
await p.waitForTimeout(5000);
console.log('FIRST TAP ->', await p.evaluate(() => {
  const c = window.PLAYER_BOOT.controller; const a = c.audioElement;
  return JSON.stringify({ state: c.state,
    lastError: c._lastPlayError ? (c._lastPlayError.name + ': ' + c._lastPlayError.message) : null,
    mediaError: a.error ? a.error.code + '/' + a.error.message : null,
    paused: a.paused, t: +a.currentTime.toFixed(2), readyState: a.readyState,
    trace: window.__t }, null, 1);
}));
console.log('console:', logs.slice(0, 8));
await b.close();
