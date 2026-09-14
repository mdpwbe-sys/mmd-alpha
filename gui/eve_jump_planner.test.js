const test=require('node:test'),assert=require('node:assert/strict');
const {registry,applyLine}=require('./eve_map_styles');
const planner=require('./eve_jump_planner');
test('partial danger displays known lower bounds and Safer mode',()=>{
  const result={mode:'SAFER',route:{reachable:true,jump_count:3},profile:{},cyno_coverage:{},
    danger_summary:{partial:true,peak:{score:18,band:'normal'},total:30}};
  const view=planner.summaryFrom(result);
  assert.equal(view.danger,'LOW · partial');assert.equal(view.peak,'≥ 18');assert.equal(view.risk,'≥ 30');
  assert.equal(view.mode,'Safer');assert.match(planner.template,/value="SAFER"/);
});
test('route and danger differ by width and dash as well as colour',()=>{
  assert.ok(registry.ACTIVE_STARGATE_ROUTE.width>registry.LIVE_INTEL_DANGER.width);
  assert.deepEqual(registry.ACTIVE_STARGATE_ROUTE.dash,[]);
  assert.ok(registry.LIVE_INTEL_DANGER.dash.length);
  assert.notEqual(registry.ACTIVE_STARGATE_ROUTE.color,registry.LIVE_INTEL_DANGER.color);
  assert.deepEqual(registry.PLANNED_JUMP.dash,[]);
  assert.equal(registry.MIDPOINT.shape,'diamond');
  assert.equal(registry.CYNO_POSITIONED.shape,'diamond');
  assert.ok(registry.CYNO_CONNECTION.dash.length);
});
test('solid route resets danger dash; dotted cyno uses round caps',()=>{
  const context={setLineDash(value){this.dash=value;}};
  applyLine(context,'LIVE_INTEL_DANGER');assert.ok(context.dash.length);
  applyLine(context,'ACTIVE_STARGATE_ROUTE');assert.deepEqual(context.dash,[]);
  applyLine(context,'CYNO_CONNECTION');assert.equal(context.lineCap,'round');
  applyLine(context,'STARGATE');assert.equal(context.lineCap,'butt');
});
test('planner starts disabled until validated inputs exist',()=>{
  for(const id of ['pilot','ship','origin','destination','mode']) assert.ok(planner.template.includes(`id="jump-${id}"`));
  assert.match(planner.template,/id="jump-calculate" disabled/);
  assert.match(planner.template,/Select pilot, ship, origin and destination/);
});
test('summary preserves raw values and unknowns without computing',()=>{
  const nodes=new Map();const doc={getElementById(id){if(!nodes.has(id))nodes.set(id,{});return nodes.get(id);}};
  planner.setSummary({jump_count:0,total_ly:'2.12345',fuel:'3.08625',cyno_coverage:'1 positioned'},doc);
  assert.equal(nodes.get('jump-summary-jump_count').textContent,'0');
  assert.equal(nodes.get('jump-summary-fuel').textContent,'3.08625');
  assert.equal(nodes.get('jump-summary-danger').textContent,'—');
  planner.setSummary({},doc);assert.equal(nodes.get('jump-summary-fuel').textContent,'—');
});
test('shell mount is idempotent',()=>{
  let mounted=false,calls=0;const panel={insertAdjacentHTML(){calls++;mounted=true;}};
  const doc={getElementById(id){return id==='eve-map-panel'?panel:mounted?{}:null;}};
  planner.mount(doc);planner.mount(doc);assert.equal(calls,1);
});

const fixture=()=>({ok:true,route:{reachable:true,systems:[1,2,3],jump_count:2,total_distance_ly:'6.0000',total_fuel_raw:'150.00000',legs:[
  {source_id:1,target_id:2,source_name:'Origin',target_name:'Mid',distance_ly:'3.0000',fuel_raw:'75.00000'},
  {source_id:2,target_id:3,source_name:'Mid',target_name:'Dest',distance_ly:'3.0000',fuel_raw:'75.00000'}]},
  midpoints:[{system_id:2,npc_station:true}],cynos:[{system_id:2,name:'Alt',observed_at:1000,position_fresh:true,status:'CYNO_POSITIONED'}],
  profile:{character_id:42,jump_drive_operation:4,jump_drive_calibration:0,jump_fuel_conservation:5},
  cyno_coverage:{positioned:1,required:2},max_jump_range:'3.0',isotope_name:'Isotope',isotope_type_id:10,
  positions_m:{1:{x:100,y:200,z:300},2:{x:110,y:220,z:330},3:{x:120,y:240,z:360}},range_m:'30',origin_id:1,reachableSystemIds:[2]});
const options={pilots:[{id:42,name:'Pilot'}],ships:[{id:900,name:'Hull'}],systems:[{id:1,name:'Origin'},{id:2,name:'Mid'},{id:3,name:'Dest'}]};
test('NPC station line appears only for known presence; danger uses supplied map band',()=>{
  const data=fixture();
  for(const value of [null,undefined,false]) {
    data.midpoints[0].npc_station=value;
    assert.ok(!planner.legDescriptions(data)[0].includes('NPC station'));
  }
  data.midpoints[0].npc_station=true;
  data.route.legs[0].danger={score:18,band:'normal'};
  assert.match(planner.legDescriptions(data)[0],/NPC station ✓\nDanger 18 · LOW/);
  data.mode='SAFEST';data.danger_summary={peak:{score:63,band:'orange'},total:81};
  const summary=planner.summaryFrom(data);
  assert.equal(summary.mode,'Safest');assert.equal(summary.danger,'HIGH');
  assert.equal(summary.peak,'63');assert.equal(summary.risk,'81');
  assert.ok(planner.canCalculate({pilot_id:42,ship_id:900,origin_id:1,destination_id:3,mode:'SAFEST'},options,data.profile));
});
test('EVE decimal formatting handles grouping, rounding, zeros and exact large decimals',()=>{
  for(const [value,places,expected] of [
    ['46.9568960207',2,'46,96'],['117392.240051',0,'117.392'],
    ['10.00',2,'10,00'],['0',2,'0,00'],[0,0,'0'],[null,2,'—'],
    ['NaN',0,'—'],['Infinity',2,'—'],['999.995',2,'1.000,00'],
    ['9007199254740993.499999',0,'9.007.199.254.740.993'],
    ['117392.5',0,'117.393'],['1.25E+3',2,'1.250,00'],['1E-8',2,'0,00']
  ])assert.equal(planner.formatDecimal(value,places),expected);
});
test('compact summary and leg DOM show only formatted values, raw values remain in tooltips',()=>{
  const data=fixture();data.route.total_distance_ly='46.9568960207';data.route.total_fuel_raw='117392.240051';
  data.max_jump_range='10.00';data.isotope_name='Nitrogen Isotopes';
  data.route.legs[0].distance_ly='7.719999999';data.route.legs[0].fuel_raw='19290.240051';data.midpoints[0].npc_station=null;
  const before=JSON.stringify(data),summary=planner.summaryFrom(data);
  assert.equal(summary.total_ly,'46,96 LY');assert.equal(summary.fuel,'117.392');
  assert.equal(summary.range,'10,00 LY');assert.equal(summary.isotope,'Nitrogen Isotopes');
  assert.equal(summary.cyno_coverage,'1 / 2');
  const {doc}=ui({}),rows=planner.renderLegs(data,doc);
  assert.deepEqual(rows[0].children.map(n=>n.textContent),[
    'Origin → Mid','7,72 LY · 19.290 isotopes','Midpoint · Cyno positioned: Alt','Danger —']);
  assert.equal(rows[0].children[0].tag,'strong');
  assert.match(rows[0].title,/19290\.240051/);assert.match(rows[0].title,/1970-01-01/);
  assert.equal(JSON.stringify(data),before);
  assert.ok(!planner.legDescriptions(data).join('').includes('fuelRaw'));
});
test('Calculate rejects incomplete inputs, mismatched profile and busy state',()=>{
  const input={pilot_id:42,ship_id:900,origin_id:1,destination_id:3,mode:'FEWEST_JUMPS'};
  assert.equal(planner.canCalculate(input,options,{character_id:42}),true);
  for(const key of Object.keys(input))assert.equal(planner.canCalculate({...input,[key]:null},options,{character_id:42}),false);
  assert.equal(planner.canCalculate(input,options,null),false);
  assert.equal(planner.canCalculate(input,options,{character_id:43}),false);
  assert.equal(planner.canCalculate(input,options,{character_id:42},true),false);
});
test('summary and structured legs format display without changing backend decimals',()=>{
  const data=fixture();const summary=planner.summaryFrom(data);
  assert.equal(summary.total_ly,'6,00 LY');assert.equal(summary.fuel,'150');
  assert.match(summary.skills,/JDO IV · JDC 0 · JFC V/);
  assert.equal(planner.legDescriptions(data)[0],'Origin → Mid\n3,00 LY · 75 isotopes\nMidpoint · Cyno positioned: Alt\nNPC station ✓\nDanger —');
  assert.equal(data.route.total_fuel_raw,'150.00000');
  data.cynos[0].position_fresh=false;data.cynos[0].status='STALE';
  assert.match(planner.legDescriptions(data)[0],/Cyno required/);
});
function ui(bridge) {
  planner.publish(null);
  const getProfile=bridge.get_jump_pilot_profile;
  if(getProfile)bridge={...bridge,get_jump_pilot_profile:async id=>({ships:options.ships,...await getProfile(id)})};
  const nodes=new Map(),doc={getElementById(id){if(!nodes.has(id))nodes.set(id,{value:id==='jump-mode'?'FEWEST_JUMPS':'',children:[],replaceChildren(...nodes){this.children=nodes;},append(node){this.children.push(node);}});return nodes.get(id);},createElement(tag){return {tag,children:[],setAttribute(key,value){this[key]=value;},append(node){this.children.push(node);}};}};
  const controller=planner.connect(doc,bridge);return {doc,nodes,controller};
}
test('shell pilot defaults planner and swap retains route with manual origin',async()=>{
  const data=fixture();let request;
  globalThis.__selChar=42;
  try {
    const t=ui({get_jump_planner_options:async()=>({ok:true,...options}),
      get_jump_pilot_profile:async()=>({ok:true,profile:data.profile,origin_system_id:1,ships:options.ships}),
      start_jump_calculation:async value=>{request=value;return {ok:false,error:'stop'};}});
    await t.controller.load();const el=id=>t.doc.getElementById(id);
    assert.equal(el('jump-pilot').value,'42');assert.equal(el('jump-origin').value,'Origin');
    t.controller.setDestination({id:3});el('jump-ship').value='900';planner.publish(data);
    el('jump-swap').onclick();
    assert.equal(el('jump-origin').value,'Dest');assert.equal(el('jump-destination').value,'Origin');
    assert.equal(planner.jumpRouteState,data);
    await t.controller.calculate();assert.equal(request.origin_auto,false);assert.equal(request.origin_id,3);
  } finally {delete globalThis.__selChar;}
});
test('no eligible ships keeps Calculate disabled',async()=>{
  const data=fixture(),t=ui({get_jump_planner_options:async()=>({ok:true,...options}),
    get_jump_pilot_profile:async()=>({ok:true,profile:data.profile,ships:[],origin_system_id:1})});
  await t.controller.load();await t.controller.setPilot(42);t.controller.setDestination({id:3});
  assert.equal(t.doc.getElementById('jump-ship').children.length,1);
  assert.equal(t.doc.getElementById('jump-calculate').disabled,true);
});
test('UI connects selected profile, current origin and backend result',async()=>{
  const calls=[],data=fixture(),t=ui({get_jump_planner_options:async()=>({ok:true,...options}),
    get_jump_pilot_profile:async id=>{calls.push(id);return {ok:true,profile:data.profile,origin_system_id:1};},
    start_jump_calculation:async request=>{calls.push(request);return {ok:true,job_id:'job'};},
    get_jump_calculation:async id=>{assert.equal(id,'job');return data;}});
  await t.controller.load();const el=id=>t.doc.getElementById(id);
  assert.equal(el('jump-calculate').disabled,true);
  el('jump-pilot').value='42';await el('jump-pilot').onchange();
  assert.equal(el('jump-origin').value,'Origin');
  el('jump-ship').value='900';el('jump-ship').oninput();t.controller.setDestination({id:3});
  assert.equal(el('jump-calculate').disabled,false);await t.controller.calculate();
  assert.equal(calls[0],42);assert.equal(calls[1].origin_auto,true);
  assert.equal(planner.jumpRouteState,data);
  assert.equal(el('jump-summary-fuel').textContent,'150');assert.equal(el('jump-legs').children.length,2);
  data.route={reachable:false,systems:[],legs:[],jump_count:0,total_distance_ly:null,total_fuel_raw:null};data.midpoints=[];data.cynos=[];
  await t.controller.calculate();assert.equal(el('jump-shell-status').textContent,'No valid jump route');assert.equal(el('jump-legs').children.length,0);
});
test('stale pilot-profile response cannot overwrite newer selection',async()=>{
  let release;const t=ui({get_jump_planner_options:async()=>({ok:true,...options}),get_jump_pilot_profile:()=>new Promise(r=>{release=r;})});
  await t.controller.load();const pilot=t.doc.getElementById('jump-pilot');pilot.value='42';const first=pilot.onchange();const resolveFirst=release;
  pilot.value='43';const second=pilot.onchange();release({ok:false,error:'not connected'});await second;
  resolveFirst({ok:true,profile:{character_id:42},origin_system_id:1});await first;
  assert.equal(t.doc.getElementById('jump-calculate').disabled,true);
  assert.equal(t.doc.getElementById('jump-origin').value,'');
});
test('editing destination discards a late calculation result',async()=>{
  let deliver;const data=fixture();const t=ui({get_jump_planner_options:async()=>({ok:true,...options}),
    get_jump_pilot_profile:async()=>({ok:true,profile:data.profile,origin_system_id:1}),
    start_jump_calculation:async()=>({ok:true,job_id:'job'}),
    get_jump_calculation:()=>new Promise(resolve=>{deliver=resolve;})});
  await t.controller.load();const el=id=>t.doc.getElementById(id);
  el('jump-pilot').value='42';await el('jump-pilot').onchange();el('jump-ship').value='900';t.controller.setDestination({id:3});
  const calculation=t.controller.calculate();await Promise.resolve();
  t.controller.setDestination({id:2});deliver(data);await calculation;
  assert.equal(planner.jumpRouteState,null);assert.equal(el('jump-legs').children.length,0);
});
test('Physical and Tactical share route identity, only Physical has CCP range geometry',()=>{
  const overlay=require('./eve_jump_overlay'),data=fixture();
  const transform={centre:{x:100,y:200,z:300},scale:.1};
  const physical=overlay.physicalView(data,transform);
  const tacticalNodes=new Map([[2,{x:-900,y:0,z:7}]]),tactical=overlay.tacticalView(data,tacticalNodes);
  assert.equal(physical.jumpRouteState,data);assert.equal(tactical.jumpRouteState,data);
  assert.equal(tactical.jumpRouteState.route,physical.jumpRouteState.route);
  assert.deepEqual(physical.points.get(2),{x:1,y:2,z:3});
  assert.equal(physical.range.radius,3);assert.equal(tactical.range,null);
  assert.equal(tactical.points,tacticalNodes);
  assert.equal(overlay.physicalPoint({x:NaN,y:0,z:0},transform),null);
});
test('range sphere uses CCP-scaled radius and disposes private resources',()=>{
  const overlay=require('./eve_jump_overlay');let disposed=0;
  class Geometry {constructor(radius){this.radius=radius;this.type='SphereGeometry';}dispose(){disposed++;}}
  const material={clone(){return {color:{set(){}},dispose(){disposed++;}};}};
  const sample={geometry:new Geometry(1),material,clone(){return {scale:{set(){}},position:{set(x,y,z){this.xyz=[x,y,z];}}};}};
  const mesh=overlay.sphere(sample,{center:{x:1,y:2,z:3},radius:7},registry.JUMP_RANGE);
  assert.equal(mesh.geometry.radius,7);assert.deepEqual(mesh.position.xyz,[1,2,3]);
  assert.notEqual(mesh.material,sample.material);overlay.disposeSphere(mesh);assert.equal(disposed,2);
});
test('map destination edits retain old route until successful Calculate replaces it',async()=>{
  const old=fixture(),next=fixture();next.route.total_fuel_raw='200';
  let deliver,request;
  const t=ui({get_jump_planner_options:async()=>({ok:true,...options}),
    get_jump_pilot_profile:async()=>({ok:true,profile:old.profile,origin_system_id:1}),
    start_jump_calculation:async value=>{request=value;return {ok:true,job_id:'next'};},
    get_jump_calculation:()=>new Promise(resolve=>{deliver=resolve;})});
  await t.controller.load();const el=id=>t.doc.getElementById(id);
  el('jump-pilot').value='42';await el('jump-pilot').onchange();el('jump-ship').value='900';
  planner.publish(old);planner.setSummary(planner.summaryFrom(old),t.doc);
  t.controller.setDestination({id:3});
  assert.equal(planner.jumpRouteState,old);
  assert.equal(el('jump-destination').value,'Dest');
  assert.match(el('jump-shell-status').textContent,/outdated/i);
  assert.equal(el('jump-summary-fuel').textContent,'150');
  const pending=t.controller.calculate();await Promise.resolve();
  assert.equal(planner.jumpRouteState,old);assert.equal(request.destination_id,3);
  deliver(next);await pending;
  assert.equal(planner.jumpRouteState,next);assert.equal(el('jump-summary-fuel').textContent,'200');
});
test('manual IDs display names and calculation failure keeps the prior route',async()=>{
  const old=fixture();let request;
  const t=ui({get_jump_planner_options:async()=>({ok:true,...options}),
    get_jump_pilot_profile:async()=>({ok:true,profile:old.profile,origin_system_id:1}),
    start_jump_calculation:async value=>{request=value;return {ok:false,error:'Service unavailable'};}});
  await t.controller.load();const el=id=>t.doc.getElementById(id);
  el('jump-pilot').value='42';await el('jump-pilot').onchange();el('jump-ship').value='900';
  planner.publish(old);
  el('jump-origin').value='2';el('jump-origin').oninput();
  el('jump-destination').value='3';el('jump-destination').oninput();
  assert.equal(el('jump-origin').value,'Mid');assert.equal(el('jump-destination').value,'Dest');
  await t.controller.calculate();
  assert.equal(request.origin_id,2);assert.equal(request.destination_id,3);assert.equal(request.origin_auto,false);
  assert.equal(planner.jumpRouteState,old);assert.match(el('jump-shell-status').textContent,/previous route retained/);
});
