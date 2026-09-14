const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const html = fs.readFileSync(__dirname + '/index.html', 'utf8');
const source = html.slice(html.indexOf('  const DYNAMIC_PALETTE'), html.indexOf('  function getCharLedStyle'));
function boot(storage = {}) {
  const ctx = {window: {}, localStorage: {
    getItem: k => storage[k] || null,
    setItem: (k, v) => { storage[k] = v; },
  }};
  vm.createContext(ctx); vm.runInContext(source, ctx); return ctx;
}
test('first-run pilots get separated hues before the roster is loaded', () => {
  const ctx = boot();
  const colors = ['Pilot A', 'Pilot B', 'Pilot C'].map(n => ctx.getCharColorInfo(n));
  const hues = colors.map(c => Number(c.color.match(/^hsl\((\d+)/)?.[1]));
  for (let i = 0; i < hues.length; i++) for (let j = i + 1; j < hues.length; j++) {
    const d = Math.abs(hues[i] - hues[j]);
    assert.ok(Math.min(d, 360 - d) >= 90, 'near-identical pilot colors');
  }
});
test('roster reorder and reload preserve assigned colors', () => {
  const storage = {}, ctx = boot(storage);
  const a = ctx.getCharColorInfo('Pilot A').color;
  ctx.getCharColorInfo('Pilot B'); ctx.window.__allChars = ['Pilot B', 'Pilot A'];
  assert.equal(ctx.getCharColorInfo(' PILOT A ').color, a);
  assert.equal(boot(storage).getCharColorInfo('Pilot A').color, a);
});
test('many pilots stay unique and blocked storage does not break rendering', () => {
  const ctx = boot(); ctx.localStorage.setItem = () => {throw Error('blocked');};
  const colors = Array.from({length: 32}, (_, i) => ctx.getCharColorInfo('Pilot ' + i).color);
  assert.equal(new Set(colors).size, 32);
});
test('duplicate badge LEDs use the shared pilot color, not legacy green classes', () => {
  const block = html.slice(html.indexOf('const ledsHtml = charList.map'), html.indexOf("}).join('');", html.indexOf('const ledsHtml = charList.map')));
  assert.ok(block.includes('getCharLedStyle(name)'));
  assert.ok(!block.includes('getCharLedClass'));
});
