const test=require('node:test');
const assert=require('node:assert/strict');
const {createTopology}=require('./eve_map_tactical');
const data=require('./data/eve_map.json');
const id=name=>data.systems.find(n=>n.name===name).id;
test('Anher local topology keeps Hek/Eystur connected without stretching across radial view',()=>{
  const topology=createTopology(data.systems,data.gates);
  const radial=topology.buildRadialLayout(id('Anher'),5);
  const hybrid=topology.buildHybridLayout(id('Anher'),5);
  const distance=layout=>{const a=layout.nodes.find(n=>n.id===id('Hek')),b=layout.nodes.find(n=>n.id===id('Eystur'));return Math.hypot(a.x-b.x,a.z-b.z);};
  assert.ok(distance(hybrid)<distance(radial)/3);
  assert.ok(distance(hybrid)>18);
  assert.deepEqual(hybrid.links,radial.links);
  for(const n of hybrid.nodes)assert.equal(n.hops,radial.nodes.find(x=>x.id===n.id).hops);
});
test('local placement is stable across selection, remote intel and reload at radius 1/3/5',()=>{
  for(const radius of [1,3,5]){
    const t=createTopology(data.systems,data.gates),reference=id('Anher');
    const before=t.buildHybridLayout(reference,radius);
    const remote=id('Jita');
    const after=t.buildHybridLayout(reference,radius,[remote],new Map([[before.nodes.at(-1).id,5]]));
    for(const n of before.nodes){const m=after.nodes.find(x=>x.id===n.id);assert.deepEqual([m.x,m.z],[n.x,n.z]);}
    const radial=t.buildRadialLayout(reference,radius,[remote]);
    const a=after.nodes.find(n=>n.id===remote),b=radial.nodes.find(n=>n.id===remote);
    assert.deepEqual([a.x,a.z,a.hops],[b.x,b.z,b.hops]);
    const reload=createTopology(data.systems,data.gates).buildHybridLayout(reference,radius);
    assert.deepEqual(reload,before);
    assert.ok(before.nodes.every(n=>n.y===0&&n.fx===n.x&&n.fz===n.z));
  }
});
