const {chromium} = require('playwright');
const path = require('node:path');
const assert = require('node:assert/strict');
(async () => {
  const browser = await chromium.launch({headless: true});
  try {
    const page = await browser.newPage();
    await page.setContent('<div id="trade-view"></div>');
    await page.evaluate(() => {window.__state = {workspace: 'assets'}; window.calls = []; window.openItem = (id, cid) => calls.push([id, cid]);});
    for (const name of ['list_tools.js', 'trading-ui.js']) await page.addScriptTag({path: path.resolve('gui', name)});
    for (const [view, selected, expected] of [['assets', null, '202'], ['assets', '303', '303'], ['alerts', null, '202']]) {
      await page.evaluate(({view, selected}) => {window.__state.workspace = view; window.__selChar = selected;
        TradingUI.acceptWorkspace({ok:true, complete:true, asset_source:{character_id:'202'},
          assets:[{type_id:34,name:'Item',quantity:1}], alerts:[{type_id:34,name:'Item'}]});
      }, {view, selected});
      if (view === 'assets') {
        assert.equal(await page.getByRole('columnheader', {name: /Coût d’achat/}).count(), 1);
        assert.match(await page.getByRole('columnheader', {name: /Prix estimé/}).getAttribute('title'), /Pas une moyenne BUY\/SELL/);
        assert.match(await page.getByRole('columnheader', {name: /Valeur totale brute/}).getAttribute('title'), /vos prix listés/);
      }
      await page.getByRole('button', {name:'Item',exact:true}).click();
      assert.deepEqual(await page.evaluate(() => calls.at(-1)), [34, expected]);
    }
    console.log('PASS owner/selected pilot routing for Assets and Alerts');
  } finally {await browser.close();}
})().catch(e => {console.error(e); process.exitCode=1;});
