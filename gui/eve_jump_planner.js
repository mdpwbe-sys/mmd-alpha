/* Application adapter: backend owns profiles/math/routing; renderer owns none. */
(function(root) {
  'use strict';
  const fields=['jump_count','total_ly','fuel','cyno_coverage','danger','isotope','range','skills','mode','peak','risk'];
  const template=`<details id="eve-jump-planner" class="eve-map-section" open>
    <summary class="eve-map-section-title">JUMP PLANNER</summary>
    <div class="eve-map-section-body">
      <div class="eve-map-route">
        <label for="jump-pilot">Pilot</label><select id="jump-pilot"><option value="">Select pilot</option></select>
        <label for="jump-ship">Ship</label><select id="jump-ship"><option value="">Select hull</option></select>
        <label for="jump-origin">Origin</label><input id="jump-origin" list="jump-systems" placeholder="System name">
        <label for="jump-destination">Destination</label><input id="jump-destination" list="jump-systems" placeholder="System name">
        <datalist id="jump-systems"></datalist>
        <button class="btn mini" type="button" id="jump-swap" title="Swap origin and destination" aria-label="Swap origin and destination">⇄ Origin / Destination</button>
        <label for="jump-mode">Mode</label><select id="jump-mode"><option value="FEWEST_JUMPS">Fewest jumps</option><option value="LEAST_FUEL">Least fuel</option><option value="SAFER">Safer (+25%, max +3 jumps/segment)</option><option value="SAFEST">Safest</option></select>
        <button class="btn mini" type="button" id="jump-calculate" disabled aria-describedby="jump-shell-status">Calculate</button>
        <small id="jump-shell-status" role="status">Select pilot, ship, origin and destination.</small>
      </div>
      <h4>Route Summary</h4>
      <dl aria-live="polite" style="display:grid;grid-template-columns:auto minmax(0,1fr);gap:4px 12px;font-variant-numeric:tabular-nums">
        <dt>Jumps</dt><dd id="jump-summary-jump_count">—</dd>
        <dt>Total distance</dt><dd id="jump-summary-total_ly">—</dd>
        <dt>Fuel</dt><dd><span id="jump-summary-fuel">—</span> <span id="jump-summary-isotope"></span></dd>
        <dt>Cyno coverage</dt><dd id="jump-summary-cyno_coverage">—</dd>
        <dt>Danger</dt><dd id="jump-summary-danger">—</dd>
        <dt>Mode</dt><dd id="jump-summary-mode">—</dd>
        <dt>Peak danger</dt><dd id="jump-summary-peak">—</dd>
        <dt>Total risk</dt><dd id="jump-summary-risk">—</dd>
        <dt>Max range</dt><dd id="jump-summary-range">—</dd>
        <dt>Skills</dt><dd id="jump-summary-skills">—</dd>
      </dl>
      <ol id="jump-legs"></ol>
    </div>
  </details>`;
  function mount(doc) {
    const panel=doc.getElementById('eve-map-panel');
    if(panel && !doc.getElementById('eve-jump-planner')) panel.insertAdjacentHTML('beforeend',template);
  }
  function setOptions({pilots=[],ships=[]}={},doc=document) {
    for(const [id,rows,title] of [['jump-pilot',pilots,'Select pilot'],['jump-ship',ships,'Select hull']]) {
      const select=doc.getElementById(id);if(!select)continue;
      const previous=select.value; select.replaceChildren();
      for(const row of [{id:'',name:title},...rows]) {
        const option=doc.createElement('option');option.value=String(row.id);option.textContent=String(row.name);select.append(option);
      }
      select.value=previous;
      if(select.selectedIndex<0) select.value='';
    }
  }
  function setSummary(summary={},doc=document) {
    for(const key of fields) {
      const target=doc.getElementById(`jump-summary-${key}`);
      if(target) target.textContent=summary[key]==null?'—':String(summary[key]);
    }
  }
  function canCalculate(input,options,profile,busy=false) {
    return !busy && profile?.character_id===Number(input.pilot_id) &&
      options.pilots.some(p=>Number(p.id)===Number(input.pilot_id)) &&
      options.ships.some(s=>Number(s.id)===Number(input.ship_id)) &&
      options.systems.some(s=>Number(s.id)===Number(input.origin_id)) &&
      options.systems.some(s=>Number(s.id)===Number(input.destination_id)) &&
      ['FEWEST_JUMPS','LEAST_FUEL','SAFER','SAFEST'].includes(input.mode);
  }
  // Display-only decimal rounding, without conversion through floating point.
  // Fuel display is NOT a guaranteed in-game integer consumption calculation.
  function formatDecimal(value,places=0) {
    if(value==null)return '—';
    const match=String(value).match(/^([+-]?)(\d+)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/);
    if(!match)return '—';
    const exponent=Number(match[4]||0);if(Math.abs(exponent)>1000)return '—';
    const fraction=match[3]||'', shift=places+exponent-fraction.length;
    let scaled=BigInt(match[2]+fraction);
    if(shift>=0)scaled*=10n**BigInt(shift);
    else {const divisor=10n**BigInt(-shift);scaled=(scaled+divisor/2n)/divisor;}
    const digits=scaled.toString().padStart(places+1,'0');
    const integer=places?digits.slice(0,-places):digits;
    return (match[1]==='-'&&scaled!==0n?'-':'')+integer.replace(/\B(?=(\d{3})+(?!\d))/g,'.')+(places?','+digits.slice(-places):'');
  }
  const ly=value=>value==null?'—':`${formatDecimal(value,2)} LY`;
  const skill=value=>['0','I','II','III','IV','V'][value]??'—';
  // Labels translate the map's existing bands; no second score/threshold model.
  const dangerLevel=row=>({normal:'LOW',yellow:'MEDIUM',orange:'HIGH',red:'HIGH'})[row?.band]||'—';
  function summaryFrom(result) {
    return {jump_count:result.route.reachable?formatDecimal(result.route.jump_count):null,
      mode:({FEWEST_JUMPS:'Fewest jumps',LEAST_FUEL:'Least fuel',SAFER:'Safer',SAFEST:'Safest'})[result.mode]||'—',
      danger:dangerLevel(result.danger_summary?.peak)+(result.danger_summary?.partial?' · partial':''),peak:(result.danger_summary?.partial?'≥ ':'')+formatDecimal(result.danger_summary?.peak?.score),
      risk:(result.danger_summary?.partial?'≥ ':'')+formatDecimal(result.danger_summary?.total),
      total_ly:ly(result.route.total_distance_ly),fuel:formatDecimal(result.route.total_fuel_raw),
      isotope:result.isotope_name||'Unknown isotope',range:ly(result.max_jump_range),
      skills:`JDO ${skill(result.profile.jump_drive_operation)} · JDC ${skill(result.profile.jump_drive_calibration)} · JFC ${skill(result.profile.jump_fuel_conservation)}`,
      cyno_coverage:`${formatDecimal(result.cyno_coverage.positioned)} / ${formatDecimal(result.cyno_coverage.required)}`};
  }
  function legRows(result) {
    return result.route.legs.map(leg=>{
      const midpoint=result.midpoints.find(m=>m.system_id===leg.target_id);
      const candidates=result.cynos.filter(c=>c.system_id===leg.target_id&&c.status==='CYNO_POSITIONED'&&c.position_fresh);
      const cyno=candidates.length?`Cyno positioned: ${candidates.map(c=>c.name).join(', ')}`:'Cyno required';
      return {heading:`${leg.source_name||'Unknown system'} → ${leg.target_name||'Unknown system'}`,
        metrics:`${ly(leg.distance_ly)} · ${formatDecimal(leg.fuel_raw)} isotopes`,
        context:`${midpoint?'Midpoint · ':''}${cyno}`,
        station:(leg.npc_station??midpoint?.npc_station)===true?'NPC station ✓':null,
        danger:(leg.danger?`Danger ${formatDecimal(leg.danger.score)} · ${dangerLevel(leg.danger)}`:'Danger —')+
          (leg.proximity_risk?.risk>0?` · Nearby risk +${formatDecimal(leg.proximity_risk.risk,2)}`:''),
        title:`Distance raw: ${leg.distance_ly} LY; fuel_raw: ${leg.fuel_raw}\n${candidates.map(c=>`${c.name}: ${new Date(c.observed_at*1000).toISOString()} (position snapshot, not readiness)`).join('\n')}`};
    });
  }
  function legDescriptions(result) {return legRows(result).map(row=>[row.heading,row.metrics,row.context,row.station,row.danger].filter(Boolean).join('\n'));}
  function renderLegs(result,doc) {
    return legRows(result).map(row=>{
      const li=doc.createElement('li');li.title=row.title;
      li.setAttribute('style','margin:0 0 12px;padding-left:4px;font-variant-numeric:tabular-nums');
      for(const [tag,text] of [['strong',row.heading],['div',row.metrics],['small',row.context],['small',row.station],['small',row.danger]]) {
        if(!text)continue;const line=doc.createElement(tag);line.textContent=text;
        line.setAttribute('style','display:block;margin-top:4px');li.append(line);
      }
      return li;
    });
  }
  let jumpRouteState=null;
  function publish(result) {jumpRouteState=result;root.setEveMapJumpRoute?.(jumpRouteState);}
  function connect(doc,bridge) {
    let options={pilots:[],ships:[],systems:[]},profile=null,busy=false,revision=0,profileRevision=0,manualOrigin=false,loading=null;
    const el=id=>doc.getElementById(id), status=text=>{el('jump-shell-status').textContent=text;};
    const resolveSystem=value=>options.systems.find(s=>String(s.id)===value.trim()||s.name.toLowerCase()===value.trim().toLowerCase());
    const resolve=value=>resolveSystem(value)?.id;
    const showSystem=(field,id)=>{el(field).value=options.systems.find(s=>Number(s.id)===Number(id))?.name||'';};
    const input=()=>({pilot_id:Number(el('jump-pilot').value),ship_id:Number(el('jump-ship').value),origin_id:resolve(el('jump-origin').value),origin_auto:!manualOrigin,destination_id:resolve(el('jump-destination').value),mode:el('jump-mode').value});
    const update=()=>{el('jump-calculate').disabled=!canCalculate(input(),options,profile,busy);};
    let outdated=false;
    const invalidate=()=>{revision++;outdated=!!jumpRouteState;};
    const changedStatus=()=>jumpRouteState?'Route outdated — Calculate to update.':'Inputs changed — Calculate to update the route.';
    async function selectPilot() {
      invalidate();profile=null;const ticket=++profileRevision;
      options.ships=[];setOptions(options,doc);
      if(!manualOrigin)el('jump-origin').value='';
      update();status('Loading active jump skills…');
      try {
        const result=await bridge.get_jump_pilot_profile(Number(el('jump-pilot').value));
        if(ticket!==profileRevision)return;
        if(!result.ok)throw new Error(result.error);
        profile=result.profile;
        options.ships=Array.isArray(result.ships)?result.ships:[];setOptions(options,doc);
        if(!options.ships.some(s=>String(s.id)===el('jump-ship').value))el('jump-ship').value='';
        if(!manualOrigin)showSystem('jump-origin',result.origin_system_id);
        status(!options.ships.length?'No accessible jump hull for these active skills.':outdated?changedStatus():'Ready when all inputs are valid.');
      } catch(error) {if(ticket===profileRevision)status(error.message);}
      update();
    }
    async function calculate() {
      if(!canCalculate(input(),options,profile,busy))return;
      const request={...input(),danger_snapshot:root.getEveMapJumpDangerSnapshot?.()||{systems:{},state:'unavailable'}};invalidate();const ticket=revision;busy=true;update();status('Calculating jump route…');
      try {
        const start=await bridge.start_jump_calculation(request);if(!start.ok)throw new Error(start.error);
        let result;
        do {
          if(ticket!==revision)return;
          result=await bridge.get_jump_calculation(start.job_id);
          if(result.pending)await new Promise(resolve=>setTimeout(resolve,400));
        } while(result.pending);
        if(ticket!==revision)return;
        if(!result.ok)throw new Error(result.error);
        const legs=renderLegs(result,doc);
        publish(result);outdated=false;setSummary(summaryFrom(result),doc);
        el('jump-legs').replaceChildren(...legs);
        el('jump-summary-fuel').title=`fuel_raw: ${result.route.total_fuel_raw??'Unknown'} — display rounded only; in-game consumption unverified.`;
        el('jump-summary-danger').title=`Map snapshot: ${result.danger_summary?.state||'unavailable'}. Unknown systems use a conservative search cost of 100, not an observed score. Total risk sums landing systems (origin excluded).`;
        status(result.route.reachable?'Route calculated · fuel rounded for display · cynos are position snapshots, not ready.':'No valid jump route');
      } catch(error) {if(ticket===revision)status(`${error.message}${jumpRouteState?' — previous route retained (outdated).':''}`);}
      finally {busy=false;update();}
    }
    el('jump-pilot').onchange=selectPilot;
    for(const id of ['jump-ship','jump-mode','jump-origin','jump-destination'])el(id).oninput=()=>{
      if(id==='jump-origin')manualOrigin=!!el(id).value;
      if(id==='jump-origin'||id==='jump-destination') {
        const system=resolveSystem(el(id).value);if(system)el(id).value=system.name;
      }
      invalidate();update();status(changedStatus());
      if(id==='jump-origin'||id==='jump-destination') {
        const list=el('jump-systems');list.replaceChildren();const query=el(id).value.toLowerCase();
        if(query.length>=2) for(const system of options.systems.filter(s=>s.name.toLowerCase().includes(query)).slice(0,20)) {
          const option=doc.createElement('option');option.value=system.name;list.append(option);
        }
      }
    };
    el('jump-calculate').onclick=calculate;
    el('jump-swap').onclick=()=>{
      const origin=el('jump-origin').value;
      el('jump-origin').value=el('jump-destination').value;
      el('jump-destination').value=origin;
      manualOrigin=true;invalidate();update();status(changedStatus());
    };
    async function setPilot(id) {
      if(!options.pilots.some(p=>String(p.id)===String(id))||String(el('jump-pilot').value)===String(id))return;
      el('jump-pilot').value=String(id);await selectPilot();
    }
    return {load(){
      if(loading)return loading;
      loading=(async()=>{
        try{const result=await bridge.get_jump_planner_options();if(!result.ok)throw new Error(result.error);options={...result,ships:options.ships};setOptions(options,doc);
          await setPilot(root.__selChar);
          if(profile&&!options.pilots.some(p=>Number(p.id)===profile.character_id)){profile=null;invalidate();}
          update();status(outdated?changedStatus():jumpRouteState?'Route snapshot retained — Calculate to refresh.':'Select pilot, ship, origin and destination.');}
        catch(error){status(error.message);el('jump-calculate').disabled=true;}
        finally{loading=null;}
      })();return loading;
    },setDestination(system){
      const previous=resolve(el('jump-destination').value);
      showSystem('jump-destination',system.id);
      if(!el('jump-destination').value&&system.name)el('jump-destination').value=system.name;
      if(Number(previous)!==Number(system.id))el('jump-destination').oninput();
    },calculate,setPilot,getOriginSystemId:()=>input().origin_id};
  }
  const api={mount,setOptions,setSummary,template,canCalculate,formatDecimal,summaryFrom,legDescriptions,renderLegs,connect,publish,get jumpRouteState(){return jumpRouteState;}};
  if(typeof module!=='undefined'&&module.exports) module.exports=api;
  else {root.EveJumpPlanner=api;mount(document);
    const bridge=root.pywebview?.api||root.api;
    if(bridge){const controller=connect(document,bridge);api.setDestination=controller.setDestination;api.setPilot=controller.setPilot;api.load=controller.load;api.getOriginSystemId=controller.getOriginSystemId;void controller.load();}
  }
}(typeof window!=='undefined'?window:globalThis));
