const {test} = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const source = fs.readFileSync(__dirname + '/trading-ui.js', 'utf8');
function context() {
  const nodes = {};
  const ctx = {el: id => nodes[id] ||= {}, nodes,
    T: {assetSearch: '', assetSort: 0, assetSortDir: 1}, MmdListTools: require('./list_tools.js'),
    assetName: row => String(row.type_id || ''), esc: v => String(v ?? ''),
    integer: v => v == null ? null : BigInt(v),
    pick: (row, keys, fallback) => {for (const k of keys) if (row[k] != null) return row[k]; return fallback;},
    shell: (_, content) => content, table: rows => rows};
  vm.createContext(ctx);
  vm.runInContext(source.slice(source.indexOf('  function assetLocation('), source.indexOf('  function dashboard(')), ctx);
  const start = source.includes('  function visibleAssetRows(') ? source.indexOf('  function visibleAssetRows(') : source.indexOf('  function assets(');
  vm.runInContext(source.slice(start, source.indexOf('  function transactions(')), ctx);
  vm.runInContext(source.slice(source.indexOf('  function updateCounts('), source.indexOf('  function render(')), ctx);
  return ctx;
}
test('Assets hides zero holdings without removing history or active sell inventory', () => {
  const ctx = context();
  const data = {complete: true, assets: [{type_id: 1, quantity: 0, buy_qty: 12},
    {type_id: 2, quantity: '0'}, {type_id: 3, quantity: 4, asset_qty: 4},
    {type_id: 4, quantity: 2, asset_qty: 0, sell_qty: 2}], transactions: [{quantity: 12}], alerts: []};
  const original = JSON.stringify(data);
  assert.deepEqual(ctx.assets(data).map(r => r.type_id), [3, 4]);
  ctx.updateCounts(data);
  assert.equal(ctx.nodes['tab-assets-c'].textContent, 2);
  assert.equal(ctx.nodes['tab-transactions-c'].textContent, 1);
  assert.equal(JSON.stringify(data), original);
});
test('unknown quantity is not silently treated as zero', () => {
  const ctx = context();
  assert.equal(ctx.assets({assets: [{quantity: null}], complete: false}).length, 1);
  ctx.updateCounts({complete: false});
  assert.equal(ctx.nodes['tab-assets-c'].textContent, '–');
});
