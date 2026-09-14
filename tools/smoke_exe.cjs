// Launch ONLY the supplied test executable with an isolated, empty user profile.
const {chromium} = require('playwright');
const {spawn} = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
(async()=>{
  const exe=path.resolve(process.argv[2]);
  if (!fs.existsSync(exe)) throw Error('Executable missing');
  const profile=fs.mkdtempSync(path.join(os.tmpdir(),'mmd-alpha-exe-'));
  const port=process.argv[3]||'9237';
  const child=spawn(exe,[],{windowsHide:true,env:{...process.env,APPDATA:profile,
    WEBVIEW2_USER_DATA_FOLDER:path.join(profile,'webview'),
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:`--remote-debugging-port=${port}`},stdio:'ignore'});
  let browser,page;
  try {
    for(let attempt=0;attempt<45;attempt++) {
      try {browser=await chromium.connectOverCDP(`http://127.0.0.1:${port}`);break;} catch {await delay(1000);}
      if(child.exitCode!==null) throw Error('EXE exited before WebView startup: '+child.exitCode);
    }
    if(!browser) throw Error('WebView debugger unavailable');
    for(let attempt=0;attempt<20;attempt++) {
      page=browser.contexts().flatMap(context=>context.pages()).find(p=>p.url()!=='about:blank');
      if(page)break;await delay(500);
    }
    if(!page) throw Error('No application page');
    page.on('pageerror',error=>console.log('PAGE ERROR:',error.message));
    await page.waitForFunction(()=>window.pywebview?.api?.sde_setup_status,{},{timeout:45000});
    console.log('EXE bridge ready');
    let sdeState;
    for(let attempt=0;attempt<120;attempt++) {
      sdeState=await page.evaluate(()=>window.pywebview.api.sde_setup_status());
      if(sdeState.phase==='ready')break;
      if(sdeState.phase==='error')throw Error(sdeState.message);
      await delay(1000);
    }
    if(sdeState?.phase!=='ready')throw Error('SDE setup timed out: '+JSON.stringify(sdeState));
    await page.waitForFunction(()=>!document.querySelector('dialog.sde-setup'),{}, {timeout:15000});
    console.log('SDE first launch ready');
    const options=await page.evaluate(()=>window.pywebview.api.get_jump_planner_options());
    if(!options.ok || !options.ships?.length || !options.systems?.length)throw Error('Jump Planner SDE options unavailable: '+JSON.stringify(options));
    console.log('Jump Planner static options',options.ships.length,'hulls',options.systems.length,'systems');
    await page.locator('[data-workspace="map"]').click();
    await page.waitForFunction(()=>document.querySelector('canvas'),{}, {timeout:30000});
    await page.screenshot({path:path.join(profile,'new-eden.png')});
    console.log(JSON.stringify({ok:true,profile,url:page.url(),canvases:await page.locator('canvas').count()}));
  } catch(error) {
    if(page) {
      console.log('DIAGNOSTIC',await page.evaluate(()=>({dialog:document.querySelector('dialog.sde-setup')?.innerText,api:!!window.pywebview?.api})).catch(()=>null));
      await page.screenshot({path:path.join(profile,'failure.png')}).catch(()=>{});
      console.log('failure screenshot',path.join(profile,'failure.png'));
    }
    throw error;
  } finally {
    if(page) await page.evaluate(()=>window.pywebview?.api?.close_window()).catch(()=>{});
    await delay(1500);
    if(child.exitCode===null)child.kill();
  }
})().catch(error=>{console.error(error.message);process.exitCode=1;});
