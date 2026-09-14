const {chromium} = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
(async () => {
  const browser = await chromium.launch({headless: true});
  try {
    const page = await browser.newPage();
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.setContent('<div id="trade-view"></div><span id="tab-assets-c"></span>');
    await page.evaluate(() => {window.__state = {workspace: 'assets'};});
    await page.addScriptTag({path: path.resolve('gui/list_tools.js')});
    await page.addScriptTag({path: path.resolve('gui/trading-ui.js')});
    await page.evaluate(() => TradingUI.acceptWorkspace({ok: true, complete: true,
      assets: [{name: 'Mégathron', type_id: 1, quantity: 10}, {name: 'Raven', type_id: 2, quantity: 2}, {name: 'Empty', quantity: 0}], transactions: [], alerts: []}));
    assert.equal(await page.locator('tbody tr').count(), 2);
    await page.getByRole('button', {name: 'Qté', exact: true}).click();
    assert.match(await page.locator('tbody tr').first().innerText(), /Raven/);
    await page.locator('[data-asset-sort="1"]').click();
    assert.match(await page.locator('tbody tr').first().innerText(), /Mégathron/);
    await page.getByRole('searchbox').fill('MEGA');
    assert.equal(await page.locator('tbody tr').count(), 1);
    await page.getByRole('searchbox').fill('nothing');
    assert.match(await page.locator('.trade-empty').innerText(), /Aucun résultat/);
    await page.getByRole('searchbox').fill('');
    assert.equal(await page.locator('tbody tr').count(), 2);
    const html = fs.readFileSync('gui/index.html', 'utf8');
    await page.addScriptTag({content: 'const COLS = [{key:"name"}];' + html.slice(html.indexOf('  function currentRows()'), html.indexOf('  function toggleDuplicateSort()'))});
    const filtered = await page.evaluate(() => {
      window.__state = {tab: 'buy', orderSearch: 'mega jita', sortKey: 'name', sortDir: 1,
        orders: [{name:'Mégathron', station:'Jita', side:0, char_id:1}, {name:'Mégathron', station:'Jita', side:1, char_id:1}, {name:'Mégathron', station:'Jita', side:0, char_id:2}]};
      window.__selChar = 1; return currentRows();
    });
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].char_id, 1);
    await page.evaluate(() => {
      window.marketClicks = []; window.openItem = id => window.marketClicks.push(id);
      window.__state.workspace = 'assets';
      TradingUI.acceptWorkspace({ok: true, complete: true, assets: [
        {name: 'Listed ship', type_id: 34, quantity: 2, asset_qty: 0, sell_qty: 2},
        {name: 'Stored ship', type_id: 35, quantity: 1, asset_qty: 1, sell_qty: 0}],
        asset_source: {name: 'Station A'}, alerts: [{name: 'Listed ship', type_id: 34, message: 'Check price'}]});
    });
    assert.match(await page.locator('tbody').innerText(), /En vente/);
    assert.match(await page.locator('tbody').innerText(), /Station A/);
    await page.getByRole('button', {name: 'Listed ship', exact: true}).click();
    await page.evaluate(() => {window.__state.workspace = 'alerts'; TradingUI.acceptWorkspace({ok: true, complete: true, assets: [], alerts: [{name: 'Listed ship', type_id: 34}]});});
    await page.getByRole('button', {name: 'Listed ship', exact: true}).click();
    assert.deepEqual(await page.evaluate(() => window.marketClicks), [34, 34]);
    assert.deepEqual(errors, []);
    console.log('PASS: asset sort/search/clear and order search + pilot/side filters; no JS errors');
  } finally { await browser.close(); }
})().catch(e => {console.error(e); process.exitCode = 1;});
