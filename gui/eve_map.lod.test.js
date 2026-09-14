const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const { performance } = require('node:perf_hooks');

function harness() {
  const window = { __eveMapTest: {}, EveMapTactical:require('./eve_map_tactical') };
  const context = vm.createContext({ window, performance, console, setTimeout, clearTimeout,
    requestAnimationFrame: () => 1, cancelAnimationFrame() {},
    document: { readyState: 'loading', addEventListener() {}, getElementById() { return null; } } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'eve_map.js'), 'utf8'), context);
  return window.__eveMapTest;
}
function camera(z = 0) {
  return { position: { x: 0, y: 0, z },
    matrixWorldInverse: { elements: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, -z, 1] },
    projectionMatrix: { elements: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -1, -1, 0, 0, -.2, 0] } };
}
test('Tactical labels stay adjacent to disks at every zoom, never collision-displaced',()=>{
  const api=harness();
  for(const radius of [2.2,3.5,4])for(const textWidth of [40,140,240]){
    const p={x:500,y:300};
    const a=api.tacticalAttachedLabel(p,textWidth,1000,600,radius);
    assert.ok(Math.abs(p.x-a.x-radius-4)<1e-9);assert.ok(Math.abs(p.y-a.y-radius-4)<1e-9);
    const edge=api.tacticalAttachedLabel({x:4,y:300},textWidth,1000,600,radius);
    assert.ok(Math.abs(edge.x-textWidth-4-radius-4)<1e-9);
    assert.ok(edge.x<=1000);
  }
});
test('Tactical live suffix keeps yellow/orange/red activity colours and readable opacity',()=>{
  const api=harness();
  for(const [count,pods,color] of [[1,0,'#f4d07f'],[2,0,'#ffb34e'],[5,0,'#ff7652'],[10,0,'#ff4867'],[1,1,'#ffb34e']]) {
    const draws=[];
    const ctx={fillStyle:'#def4f9',globalAlpha:.5,textAlign:'right',save(){},restore(){},
      measureText(text){return {width:text.length*6};},
      fillText(text,x,y){draws.push({text,x,y,color:this.fillStyle,alpha:this.globalAlpha});}};
    api.drawTacticalCombatLabel(ctx,'System · injoignable',{count,pod_count:pods},200,100);
    assert.equal(draws[0].color,'#def4f9');assert.equal(draws[1].color,color);
    assert.ok(draws[1].alpha>=.9);assert.equal(draws[0].y,draws[1].y);
    assert.equal(draws[0].x,200-ctx.measureText(draws[1].text).width);
    assert.equal(draws[1].text.includes(pods?'🥚':count===1?'◉':count===2?'⚠':count===5?'🔥':'💀'),true);
  }
});
test('Tactical disk and range ring share exact cached centers and radii at every zoom',()=>{
  const api=harness();
  for(const flags of [{},{selected:true},{route:true},{live:true}]) for(const depth of [100,650,2000]) {
    api.setTacticalVisualTestMode(flags);
    const n=node(42,-depth,{hops:4});
    const view=api.updateNodeView(camera(),1000,800,[n]);
    const arcs=[],ctx={save(){},restore(){},beginPath(){},arc(...args){arcs.push(args);},fill(){},stroke(){}};
    api.drawDistantNodes(ctx);api.drawTacticalSystemRing(ctx,n,'cyan');
    assert.equal(arcs.length,2);
    assert.equal(arcs[0][0],arcs[1][0]);assert.equal(arcs[0][1],arcs[1][1]);
    assert.equal(arcs[1][2],arcs[0][2]*1.2);
    assert.equal(api.tacticalSystemVisualCenter(n),view.points[0].point);
  }
});
class Sphere {
  constructor(radius, widthSegments = 12, heightSegments = 12) {
    this.type = 'SphereGeometry'; this.parameters = { radius, widthSegments, heightSegments };
  }
}
function node(id, z, extra = {}) {
  return { id, x: 0, y: 0, z, fx: 0, fy: 0, fz: z, security: .9, region_id: 10000002, ...extra,
    __threeObj: { geometry: new Sphere(1), scale: { setScalar(value) { this.value = value; } }, visible: true } };
}

test('preselection draws only reticle corners immediately and clears for non-system targets', () => {
  const api = harness();
  let strokes = 0;
  const positions = [];
  const context = { save() {}, restore() {}, translate(x, y) { positions.push([x, y]); },
    beginPath() {}, moveTo() {}, lineTo() {}, stroke() { strokes++; } };
  const target = node(42, -100);
  api.setSystemPreselection({ kind: 'system', target });
  api.drawSystemPreselection(context, camera(), 1000, 800);
  assert.equal(strokes, 4);
  assert.deepEqual(positions[0], [500, 400]);
  target.x = 10;
  api.drawSystemPreselection(context, camera(), 1000, 800);
  assert.notEqual(positions[1][0], positions[0][0], 'follows the current projection');
  api.setSystemPreselection({ kind: 'gate' });
  api.drawSystemPreselection(context, camera(), 1000, 800);
  assert.equal(strokes, 8);
  api.setSystemPreselection(null);
  api.drawSystemPreselection(context, camera(), 1000, 800);
  assert.equal(strokes, 8);
});

test('system LOD remains readable through its hysteresis band and near-camera outliers', () => {
  const api = harness(), target = node(42, -100);
  api.mapLabelLayers(100);
  api.mapLabelLayers(290);
  assert.equal(api.systemLabelOpacity(target, 290), 1);
  assert.equal(api.labelDistanceOpacity(target, camera(), 1), 1);
});

test('graphics switches Normal/Off/Low without altering tactical colours or node LOD', () => {
  const api = harness(), target = node(42, -100);
  const color = api.focusNodeColor(target), lod = api.nodeLod(100);
  assert.equal(api.normalizeGraphicsQuality('OFF'), 'off');
  for (const quality of ['off', 'low', 'normal', 'off']) {
    assert.equal(api.applyGraphicsQuality(quality), quality);
    assert.equal(api.currentGraphicsProfile().quality, quality);
    assert.equal(api.focusNodeColor(target), color);
    assert.equal(api.nodeLod(100), lod);
  }
  const off = api.currentGraphicsProfile();
  assert.equal(off.skyTextureUrl, null);
  assert.equal(off.nebulaEnabled, false);
  assert.equal(off.nearStarsEnabled, false);
  assert.equal(off.decorativeStars, 0);
  assert.equal(off.labelGlow, 0);
  assert.ok(off.trafficParticleBudget > 0);
});

test('flat camera disables rotation only and restores it on exit', () => {
  const api = harness();
  const controls = { enableRotate:true, enablePan:true, enableZoom:true, mouseButtons:{LEFT:0,RIGHT:2} };
  api.setFlatCameraControls(controls,true);
  assert.equal(controls.enableRotate,false);
  assert.equal(controls.enablePan,true); assert.equal(controls.enableZoom,true);
  assert.deepEqual(controls.mouseButtons,{LEFT:0,RIGHT:2});
  api.setFlatCameraControls(controls,false);
  assert.equal(controls.enableRotate,true);
});

test('W-Space is independent of Null and uses CCP region IDs', () => {
  const api = harness(), wh = node(1, -100, { region_id: 11000001, security: -1 });
  assert.equal(api.spaceClass(wh), 'wspace');
  assert.equal(api.spaceClass({ region_id: 10000070, security: -1 }), 'null');
  assert.equal(api.visibleNode(wh), false);
  api.setMapFilter('wspace', true); api.setMapFilter('null', false);
  assert.equal(api.visibleNode(wh), true);
  assert.equal(api.visibleNode({ region_id: 10000070, security: -1 }), false);
});

test('LOD thresholds have hysteresis and protect tactical nodes', () => {
  const { nodeLod } = harness();
  assert.equal(nodeLod(100), 0); assert.equal(nodeLod(650), 1); assert.equal(nodeLod(2000), 2);
  assert.equal(nodeLod(350, 0), 0); assert.equal(nodeLod(350, 1), 1);
  assert.equal(nodeLod(1050, 1), 1); assert.equal(nodeLod(1050, 2), 2);
  assert.equal(nodeLod(5000, 2, true), 1);
});

test('LOD culls offscreen meshes, replaces distant spheres and restores close geometry', () => {
  const api = harness(), near = node(1, -100), mid = node(2, -650), far = node(3, -2000);
  const original = mid.__threeObj.geometry;
  const nodes = [near, mid, far, node(4, -100, { x: 5000 }), node(5, 100)];
  const cam = camera();
  let view = api.updateNodeView(cam, 1000, 800, nodes);
  assert.deepEqual(Array.from(view.rows, row => row.lod), [0, 1, 2]);
  assert.equal(far.__threeObj.visible, false);
  assert.equal(view.points[0].node, far);
  assert.equal(nodes[3].__threeObj.visible, false); assert.equal(nodes[4].__threeObj.visible, false);
  assert.equal(mid.__threeObj.geometry.parameters.widthSegments, 5);
  const before = api.nodeViewSnapshot().overlayNodeIterations;
  api.updateNodeView(cam, 1000, 800, nodes);
  assert.equal(api.nodeViewSnapshot().overlayNodeIterations, before);
  api.updateNodeView(camera(-550), 1000, 800, nodes);
  assert.equal(mid.__threeObj.geometry, original);
  assert.equal(mid._nodeLod, 0);
  assert.equal(mid.x, mid.fx); assert.equal(mid.z, mid.fz);
});

test('full packaged galaxy uses points at distance and does no idle node rescan', t => {
  const api = harness(), data = JSON.parse(fs.readFileSync(path.join(__dirname, 'data/eve_map.json')));
  const nodes = api.displayNodes(data.systems, data.gates), cam = camera(6000);
  const whCount = data.systems.filter(system => api.spaceClass(system) === 'wspace').length;
  const started = performance.now();
  const first = api.updateNodeView(cam, 1600, 1000, nodes);
  const offCount = first.rows.length;
  assert.equal(offCount, data.systems.length - whCount);
  assert.equal(first.points.length, offCount);
  api.setMapFilter('wspace', true);
  // A real filter change calls render/markOverlayDirty. In this headless
  // policy fixture use a new array to model that invalidation explicitly.
  const allNodes = [...nodes];
  const second = api.updateNodeView(cam, 1600, 1000, allNodes);
  assert.equal(second.points.length, data.systems.length);
  const iterations = api.nodeViewSnapshot().overlayNodeIterations;
  for (let frame = 0; frame < 60; frame++) api.updateNodeView(cam, 1600, 1000, allNodes);
  assert.equal(api.nodeViewSnapshot().overlayNodeIterations, iterations);
  t.diagnostic(JSON.stringify({ systems: nodes.length, wormholes: whCount, distantOff: offCount,
    distantOn: second.points.length, lod0: 0, lod1: 0, lod2: second.points.length,
    twoPassesAnd60CacheHitsMs: performance.now() - started, measurement: 'CPU policy test, not WebGL FPS' }));
});
