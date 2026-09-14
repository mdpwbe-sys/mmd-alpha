const test = require('node:test');
const assert = require('node:assert/strict');
const {createTopology,radialRadius,radialReference,applyForces} = require('./eve_map_tactical');
const systems = Array.from({length:42},(_,id)=>({id:id+1,position_m:{x:Math.cos(id)*1e16,y:id*2e16,z:Math.sin(id)*1e16}}));
const gates = Array.from({length:40},(_,i)=>({source:i+1,target:i+2}));
const protectedIds=[2,6,11,21,41,42];
const topology=createTopology(systems,gates);
test('unreachable technical positions spread evenly over 360 degrees in ID order',()=>{
  const nodes=Array.from({length:13},(_,i)=>({id:i+1,position_m:{x:i?100:0,y:0,z:0}}));
  const build=input=>createTopology(input,[]).buildRadialLayout(1,3,nodes.map(n=>n.id));
  const result=build(nodes), remote=result.nodes.filter(n=>n.unreachable);
  for(let i=0;i<remote.length;i++){
    const n=remote[i],angle=2*Math.PI*i/remote.length;
    assert.ok(Math.abs(n.x/result.unreachableRadius-Math.cos(angle))<1e-8);
    assert.ok(Math.abs(n.z/result.unreachableRadius-Math.sin(angle))<1e-8);
    assert.equal(n.hops,null);
  }
  assert.deepEqual(result,build([...nodes].reverse()));
});
test('true 1/5/10/20/40 hop rings are strictly ordered, unreachable is outside',()=>{
  const layout=topology.buildRadialLayout(1,1,protectedIds);
  let previous=0;
  for(const id of protectedIds){
    const n=layout.nodes.find(n=>n.id===id),r=Math.hypot(n.x,n.z);
    assert.ok(r>previous);previous=r;
    assert.equal(n.hops,id===42?null:id-1);
    if(id!==42)assert.ok(Math.abs(r-radialRadius(id-1))<1e-8);
    assert.equal(n.fx,n.x);assert.equal(n.fz,n.z);assert.equal(n.fy,0);
  }
});
test('angle is CCP X/Z, not simulated coordinates; opposite directions stay opposite',()=>{
  const nodes=[{id:1,position_m:{x:0,y:0,z:0}},
    {id:2,x:-999,z:100,position_m:{x:2,y:999,z:0}},
    {id:3,x:999,z:100,position_m:{x:-2,y:-999,z:0}}];
  const result=createTopology(nodes,[{source:1,target:2},{source:1,target:3}]).buildRadialLayout(1);
  assert.equal(result.nodes[1].x,60);assert.equal(result.nodes[2].x,-60);
  assert.ok(Math.abs(result.nodes[2].z)<1e-8);
});
test('six route legs / distant intel / repeated selections never change existing coordinates',()=>{
  const baseline=topology.buildRadialLayout(1,1,protectedIds);
  for(let pass=0;pass<4;pass++)for(const selected of [6,11,21,41]){
    const result=topology.buildRadialLayout(1,3,[...protectedIds,selected,15]);
    for(const n of baseline.nodes){
      const next=result.nodes.find(x=>x.id===n.id);
      assert.deepEqual([next.x,next.z,next.hops],[n.x,n.z,n.hops]);
    }
  }
  assert.deepEqual(baseline,createTopology([...systems].reverse(),[...gates]).buildRadialLayout(1,1,protectedIds));
});
test('only actual stargate edges enter radial layout; planned jumps never affect BFS',()=>{
  const t=createTopology(systems,[...gates,{source:1,target:41,kind:'PLANNED_JUMP'}]);
  const result=t.buildRadialLayout(1,1,protectedIds);
  assert.equal(result.nodes.find(n=>n.id===41).hops,40);
  assert.deepEqual(result.links,[{source:1,target:2,kind:'STARGATE'}]);
});
test('reference priority and retained selection fallback',()=>{
  const known=new Set([1,2,3,4]);
  assert.equal(radialReference(1,2,3,4,known),1);
  assert.equal(radialReference(99,2,3,4,known),2);
  assert.equal(radialReference(null,null,3,4,known),3);
  assert.equal(radialReference(null,null,null,4,known),4);
});
test('2D geometry forces disabled, 2.5D forces retained; raw CCP required',()=>{
  const forces=new Map(), graph={d3Force:(k,v)=>forces.set(k,v),cooldownTicks(){},d3ReheatSimulation(){}};
  const defaults={link:{},charge:{}};
  applyForces(graph,'tactical',defaults,true);
  assert.ok([...forces.values()].every(v=>v===null));
  applyForces(graph,'tactical',defaults,false);
  assert.equal(forces.get('link'),defaults.link);
  assert.throws(()=>createTopology([{id:1,x:1,y:2,z:3}],[]).buildRadialLayout(1),/CCP/);
});
