const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function harness(api) {
  const status = {}, progress = {removeAttribute() {delete this.value;}}, button = {hidden:true};
  const dialog = {isConnected:false,open:false,setAttribute(){},addEventListener(){},
    querySelector(selector) {return selector === 'progress' ? progress : selector === 'button' ? button : status;},
    showModal(){this.open=true;},remove(){this.isConnected=false;this.open=false;}};
  const timers = new Set();
  const window = {};
  const context = {window,document:{createElement:()=>dialog,body:{appendChild(){dialog.isConnected=true;}}},
    setTimeout(fn){timers.add(fn);return fn;},clearTimeout(fn){timers.delete(fn);}};
  vm.runInNewContext(fs.readFileSync(__dirname+'/sde_setup.js','utf8'),context);
  return {dialog,status,button,progress,timers,ensure:()=>window.MmdSdeSetup.ensure(api)};
}
const flush = () => new Promise(resolve=>setImmediate(resolve));

test('installed SDE does not open modal or download',async()=>{
  const h=harness({sde_setup_status:async()=>({phase:'ready'}),sde_setup_start:()=>{throw Error('unexpected download');}});
  await h.ensure();
  assert.equal(h.dialog.open,false);assert.equal(h.timers.size,0);
});
test('first run waits for conversion and leaves no polling after ready',async()=>{
  let phase='missing',starts=0;
  const h=harness({sde_setup_status:async()=>({phase}),sde_setup_start:async()=>{starts++;phase='converting';return {phase,percent:70};}});
  const ready=h.ensure();assert.equal(h.ensure(),ready);await flush();
  assert.equal(starts,1);assert.equal(h.dialog.open,true);assert.equal(h.progress.value,70);
  phase='ready';const timer=[...h.timers][0];h.timers.delete(timer);await timer();await ready;
  assert.equal(h.dialog.open,false);assert.equal(h.timers.size,0);
});
test('offline error remains visible and offers explicit retry',async()=>{
  let starts=0;
  const h=harness({sde_setup_status:async()=>({phase:'error',message:'Offline'}),sde_setup_start:async()=>{starts++;return {phase:'ready'};}});
  const ready=h.ensure();await flush();assert.equal(h.button.hidden,false);assert.equal(h.status.textContent,'Offline');
  assert.equal(h.timers.size,0);h.button.onclick();await ready;assert.equal(starts,1);
});
