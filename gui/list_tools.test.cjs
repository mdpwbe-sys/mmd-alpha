const {test} = require('node:test');
const assert = require('node:assert/strict');
const tools = require('./list_tools.js');
test('search ignores case and accents and combines name/location/owner terms', () => {
  assert.ok(tools.matches(['Mégathron', 'Jita', 'Pilot A'], 'MEGA jita'));
  assert.ok(!tools.matches(['Megathron', 'Perimeter'], 'mega jita'));
  assert.ok(tools.matches(['Anything'], ''));
});
test('numeric sorting preserves precise cents, puts missing values last, and leaves source untouched', () => {
  const rows = [{v: '9007199254740993'}, {v: '2'}, {v: null}, {v: '9007199254740992'}];
  assert.deepEqual(tools.sorted(rows, r => r.v, true, 1).map(r => r.v), ['2', '9007199254740992', '9007199254740993', null]);
  assert.deepEqual(tools.sorted(rows, r => r.v, true, -1).map(r => r.v), ['9007199254740993', '9007199254740992', '2', null]);
  assert.equal(rows[0].v, '9007199254740993');
});
