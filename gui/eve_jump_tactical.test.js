const test = require('node:test');
const assert = require('node:assert/strict');
const {createTopology} = require('./eve_map_tactical');
test('seven jump legs keep true hops and geographic angles, without a route spine', () => {
  const systems=Array.from({length:41},(_,id)=>({id:id+1,position_m:{x:Math.cos(id)*1e16,y:0,z:Math.sin(id)*1e16}}));
  const gates=Array.from({length:40},(_,id)=>({source:id+1,target:id+2}));
  const route=[1,6,11,16,21,26,31,41];
  const topology=createTopology(systems,gates);
  const baseline=topology.buildRadialLayout(1,3,route);
  for(const id of route) {
    const n=baseline.nodes.find(n=>n.id===id);
    assert.equal(n.hops,id-1);
    assert.equal(n.x,n.fx);assert.equal(n.z,n.fz);
    const inspection=topology.buildRadialLayout(1,3,[...route,...topology.getNeighborhood(id,3).keys()]);
    for(const before of baseline.nodes) {
      const after=inspection.nodes.find(n=>n.id===before.id);
      assert.deepEqual([after.x,after.z],[before.x,before.z]);
    }
  }
  assert.ok(baseline.nodes.filter(n=>route.includes(n.id)).some(n=>Math.abs(n.z)>1));
  assert.ok(baseline.links.every(l=>Math.abs(l.source-l.target)===1));
});
