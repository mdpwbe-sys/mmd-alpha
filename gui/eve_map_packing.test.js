const test=require('node:test');
const assert=require('node:assert/strict');
const tactical=require('./eve_map_tactical');
const make=(angles,r=60)=>angles.map((a,i)=>({id:i+1,hops:1,ringRadius:r,geographicAngle:a,x:Math.cos(a)*r,z:Math.sin(a)*r}));
test('near identical CCP bearings no longer overlap, radii remain exact',()=>{
  const nodes=make([0,.0001]);
  tactical.packRadialNodes(nodes);
  assert.ok(Math.hypot(nodes[0].x-nodes[1].x,nodes[0].z-nodes[1].z)>=17.99);
  for(const n of nodes)assert.ok(Math.abs(Math.hypot(n.x,n.z)-60)<1e-9);
  assert.ok(Math.abs(nodes[0].packedAngle+nodes[1].packedAngle-.0001)<1e-8);
});
test('dense wrap cluster packs deterministically in geographic order',()=>{
  const nodes=make([-.003,-.002,-.001,0,.001,.002,.003]);
  const reverse=nodes.map(n=>({...n})).reverse();
  tactical.packRadialNodes(nodes);tactical.packRadialNodes(reverse);
  for(let i=0;i<nodes.length;i++){
    assert.deepEqual(nodes[i],reverse.find(n=>n.id===nodes[i].id));
    if(i)assert.ok(nodes[i].packedAngle>nodes[i-1].packedAngle);
  }
  for(let i=0;i<nodes.length;i++)for(let j=0;j<i;j++)assert.ok(Math.hypot(nodes[i].x-nodes[j].x,nodes[i].z-nodes[j].z)>=17.99);
});
test('positive/negative pi seam, boosted priorities and neighbouring rings',()=>{
  const nodes=make([Math.PI-.001,-Math.PI+.001]);nodes[0].packingPriority=5;nodes[1].packingPriority=3;
  nodes.push({...make([Math.PI],72)[0],id:99,hops:2});
  tactical.packRadialNodes(nodes);
  assert.ok(Math.hypot(nodes[0].x-nodes[1].x,nodes[0].z-nodes[1].z)>=21.99);
  assert.ok(Math.abs(Math.hypot(nodes[2].x,nodes[2].z)-72)<1e-9);
  assert.ok(nodes[0].x<0&&nodes[1].x<0);
});
test('overfull ring keeps order and reports saturation instead of moving radius',()=>{
  const nodes=make(Array(60).fill(0));tactical.packRadialNodes(nodes);
  assert.ok(nodes.every(n=>n.packingSaturated&&Math.abs(Math.hypot(n.x,n.z)-60)<1e-8));
});
test('label rectangles pack separately including long text and viewport clipping',()=>{
  const place=tactical.createLabelPacker(500,300);
  const a=place(200,100,140),b=place(202,100,140),c=place(202,100,140);
  assert.ok(a&&b&&c);
  for(const [p,q] of [[a,b],[a,c],[b,c]])assert.ok(p.bottom<=q.top||q.bottom<=p.top||p.right<=q.left||q.right<=p.left);
  assert.equal(place(2,2,600),null);
});
test('seeded circular packing respects every feasible adjacent gap including closing edge',()=>{
  let seed=12345;
  const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/2**32;};
  for(let trial=0;trial<100;trial++){
    const nodes=make(Array.from({length:12},()=>random()*Math.PI*2),180);
    tactical.packRadialNodes(nodes);
    const sorted=[...nodes].sort((a,b)=>a.geographicAngle-b.geographicAngle);
    for(let i=0;i<sorted.length;i++){
      const a=sorted[i],b=sorted[(i+1)%sorted.length];
      const delta=((b.packedAngle-a.packedAngle)%(2*Math.PI)+2*Math.PI)%(2*Math.PI);
      assert.ok(delta>=2*Math.asin(18/360)-1e-9);
      assert.ok(Math.abs(Math.hypot(a.x,a.z)-180)<1e-8);
    }
    const before=JSON.stringify(nodes);tactical.packRadialNodes(nodes);assert.equal(JSON.stringify(nodes),before);
  }
});
test('real topology invokes packing without changing hops or links',()=>{
  const systems=[{id:1,position_m:{x:0,y:0,z:0}},
    ...[2,3,4,5,6,7].map(id=>({id,position_m:{x:100,y:0,z:id*.00001}}))];
  const gates=systems.slice(1).map(n=>({source:1,target:n.id}));
  const priorities=new Map([[2,5],[3,3],[4,4]]);
  const result=tactical.createTopology(systems,gates).buildRadialLayout(1,3,[],priorities);
  assert.equal(result.links.length,gates.length);
  for(const n of result.nodes.slice(1)){
    assert.equal(n.hops,1);assert.equal(n.ringRadius,60);
    assert.ok(Math.abs(Math.hypot(n.x,n.z)-60)<1e-8);
    assert.equal(n.fx,n.x);assert.equal(n.fz,n.z);
  }
});
