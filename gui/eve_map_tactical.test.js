const test = require('node:test');
const assert = require('node:assert/strict');
const {createTopology, createAnchorForce} = require('./eve_map_tactical');
const {createCollisionForce, applyForces} = require('./eve_map_tactical');
test('labels use hop LOD but all tactical exceptions override it', () => {
  const {labelPolicy} = require('./eve_map_tactical');
  for(const hops of [0,1,2]) assert.equal(labelPolicy(hops),'always');
  assert.equal(labelPolicy(3),'space');
  for(const hops of [4,5,null]) {
    assert.equal(labelPolicy(hops),'hidden'); assert.equal(labelPolicy(hops,true),'always');
  }
});
test('protected remote outlier is retained but bounded in tactical coordinates', () => {
  const local = [{id:1,position_m:{x:0,y:0,z:0}},{id:2,position_m:{x:1,y:0,z:0}}, {id:3,position_m:{x:1e9,y:1e9,z:0}}];
  const layout = createTopology(local,[{source:1,target:2}]).buildTacticalLayout(1,1,[3]);
  const outlier = layout.nodes.find(node => node.id === 3);
  assert.ok(Math.hypot(outlier.x,outlier.y,outlier.z)<=516);
  assert.equal(outlier.ccpX,1e9); assert.equal(layout.nodes.length,3);
});
test('collision separates coincident nodes without nonfinite velocity', () => {
  const nodes = [1,2,3].map(id => ({id,x:0,y:0,z:0,vx:0,vy:0,vz:0}));
  const force = createCollisionForce(); force.initialize(nodes); force(1);
  assert.ok(nodes.every(node => Number.isFinite(node.vx) && Number.isFinite(node.vy)));
  assert.ok(nodes.some(node => node.vx !== 0));
});
test('ForceGraph adapter enables bounded Tactical forces and disables every force in Physical', () => {
  const forces = new Map(); let ticks, reheats=0;
  const graph = {d3Force(name,value) {forces.set(name,value);},cooldownTicks(value){ticks=value;},d3ReheatSimulation(){reheats++;}};
  const native = {strength(){},distance(){},distanceMax(){}};
  applyForces(graph,'tactical',{link:native,charge:native});
  assert.equal(forces.get('link'),native); assert.equal(ticks,180);
  assert.equal(typeof forces.get('tactical-collision'),'function');
  applyForces(graph,'physical',{link:native,charge:native});
  assert.ok([...forces.values()].every(value => value === null));
  assert.equal(ticks,0); assert.equal(reheats,2);
});
const systems = Array.from({length: 7}, (_, id) => ({id, position_m: {x:id*10,y:id%2,z:id%3}, fx:id, fy:0, fz:0}));
const gates = Array.from({length:5}, (_,source) => ({source,target:source+1}));

test('radius 1/3/5 hierarchy keeps context at least half opaque and intel only boosts', () => {
  const {visualHierarchy} = require('./eve_map_tactical');
  assert.deepEqual([0,1,2,3,4,5].map(h=>visualHierarchy(h).opacity),[1,1,.85,.70,.60,.50]);
  for (const radius of [1,3,5]) {
    const layout=createTopology(systems,gates).buildTacticalLayout(0,radius);
    let previous=Infinity;
    for (const node of layout.nodes) {
      const normal=visualHierarchy(node.hops);
      assert.ok(normal.opacity>=.5 && normal.radius<=previous);
      previous=normal.radius;
      for (const priority of [2,3,4,5]) assert.ok(visualHierarchy(node.hops,priority).opacity>=normal.opacity);
    }
  }
  assert.equal(visualHierarchy(null).opacity,.5);
  assert.equal(visualHierarchy(55).opacity,.5);
});

test('future overlays have distinct semantics and cannot enter stargate topology', () => {
  const {OVERLAY_STYLES}=require('./eve_map_tactical');
  assert.deepEqual(Object.keys(OVERLAY_STYLES),['JUMP_RANGE','CYNO','CYNO_ALT','MIDPOINT','PLANNED_JUMP','UNREACHABLE']);
  for (const kind of Object.keys(OVERLAY_STYLES)) {
    const topology=createTopology(systems,[...gates,{source:0,target:6,kind}]);
    assert.equal(topology.getNeighborhood(0,5).has(6),false);
  }
});
test('external alerts get real BFS hops and actual connecting gates', () => {
  const nodes=Array.from({length:19},(_,id)=>({id,position_m:{x:id,y:0,z:0}}));
  const links=Array.from({length:17},(_,source)=>({source,target:source+1}));
  const topology=createTopology(nodes,links);
  const layout=topology.buildTacticalLayout(0,5,[6,7,8,9,15,16,18]);
  const byId=new Map(layout.nodes.map(n=>[n.id,n]));
  for(const id of [6,7,8,9,15,16]) assert.equal(byId.get(id).hops,id);
  assert.equal(byId.get(18).hops,null);
  assert.ok(layout.links.some(l=>l.source===5 && l.target===6));
  assert.ok(!layout.links.some(l=>l.target===18));
  assert.equal(byId.get(6).inNeighborhood,false);
  assert.equal(topology.getNeighborhood(0,5).size,6);
});
test('tactical neighborhoods use only stargates and exact hop distance', () => {
  const topology = createTopology(systems, [...gates,{source:0,target:6,kind:'JUMP'}]);
  for (const radius of [1,3,5]) assert.equal(topology.getNeighborhood(0,radius).size,radius+1);
  assert.equal(topology.getNeighborhood(0,5).has(6),false);
});
test('projection is deterministic, preserves protected systems and never mutates Physical', () => {
  const before = JSON.stringify(systems), topology = createTopology(systems,gates);
  const layout = topology.buildTacticalLayout(0,3,[6]);
  assert.equal(layout.nodes.length,5); assert.equal(layout.links.length,3);
  assert.deepEqual(layout,topology.buildTacticalLayout(0,3,[6]));
  assert.equal(JSON.stringify(systems),before);
  assert.ok(layout.nodes.every(n => ['x','y','z','ccpX','ccpY','ccpZ'].every(k => Number.isFinite(n[k]))));
  assert.ok(layout.nodes.every(n => n.fx === undefined));
  layout.links[0].source = layout.nodes[0];
  assert.equal(topology.buildTacticalLayout(0,3).links[0].source,0);
});
test('anchor force attracts to the physical projection without moving pinned source data', () => {
  const layout = createTopology(systems,gates).buildTacticalLayout(0,3);
  const force = createAnchorForce(); force.initialize(layout.nodes);
  const node = layout.nodes[0]; node.x = node.tx+10; force(1);
  assert.ok(node.vx<0); assert.equal(node.ccpX,0);
});
test('isolated and collinear systems have a finite projection', () => {
  const isolated = createTopology(systems,[]).buildTacticalLayout(0);
  assert.deepEqual([isolated.nodes[0].x,isolated.nodes[0].y,isolated.nodes[0].z],[0,0,0]);
  assert.throws(() => createTopology(systems,[]).buildTacticalLayout(99),/known system/);
});
