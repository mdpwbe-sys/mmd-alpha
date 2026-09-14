/* Offline tactical layout preparation. No renderer, timers, network or mutation
 * of Physical nodes. ForceGraph owns the eventual simulation lifecycle. */
(function (root) {
  'use strict';
  const AXES = ['x', 'y', 'z'];
  const READABILITY = Object.freeze({ collisionRadius: 11, charge: -18, ringSpacing: 60, outlierBase: 100, outlierPerHop: 55 });
  function visualHierarchy(hops, priority = 0) {
    const hop = Math.max(0, Math.min(5, hops ?? 5));
    const opacity = [1,1,.85,.70,.60,.50][hop];
    return { opacity: priority >= 3 ? 1 : priority >= 2 ? Math.max(.85,opacity) : opacity,
      radius: priority >= 3 ? 4 : [3.5,3.5,3,2.7,2.4,2.2][hop],
      width: priority >= 3 ? 2.2 : priority >= 2 ? 1.6 : [1.5,1.5,1.25,1,.85,.75][hop] };
  }
  const styles = (typeof module !== 'undefined' && module.exports ? require('./eve_map_styles') : root.EveMapStyles).registry;
  const OVERLAY_STYLES = Object.freeze({
    JUMP_RANGE:styles.JUMP_RANGE, CYNO:styles.CYNO_POSITIONED,
    CYNO_ALT:styles.CYNO_ALT, MIDPOINT:styles.MIDPOINT,
    PLANNED_JUMP:styles.PLANNED_JUMP, UNREACHABLE:styles.UNREACHABLE
  });
  const idOf = value => Number(value?.id ?? value);
  const dot = (a, b) => a.reduce((sum, value, i) => sum + value * b[i], 0);
  const unit = vector => { const length = Math.hypot(...vector) || 1; return vector.map(v => v / length); };
  const cross = (a, b) => [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];

  function createTopology(systems, gates) {
    const byId = new Map(systems.map(node => [Number(node.id), node]));
    const adjacency = new Map([...byId.keys()].map(id => [id, new Set()]));
    const links = [], seen = new Set();
    for (const gate of gates) {
      if (gate.kind && gate.kind !== 'STARGATE') continue;
      const source = idOf(gate.source), target = idOf(gate.target);
      if (!byId.has(source) || !byId.has(target) || source === target) continue;
      const key = [source, target].sort((a,b) => a-b).join(':');
      if (seen.has(key)) continue;
      seen.add(key); adjacency.get(source).add(target); adjacency.get(target).add(source);
      links.push({ source, target, kind: 'STARGATE' });
    }
    let cachedOrigin = null, cachedDistances = null;
    function allDistances(systemId) {
      const origin = Number(systemId);
      if (cachedOrigin === origin && cachedDistances) return cachedDistances;
      if (!byId.has(origin)) return new Map();
      const distances = new Map([[origin, 0]]), queue = [origin];
      for (let cursor = 0; cursor < queue.length; cursor++) {
        const id = queue[cursor], distance = distances.get(id);
        for (const next of adjacency.get(id)) if (!distances.has(next)) {
          distances.set(next, distance + 1); queue.push(next);
        }
      }
      cachedOrigin = origin; cachedDistances = distances;
      return distances;
    }
    function getNeighborhood(systemId, maxJumps = 3) {
      const radius = Math.max(0, Math.min(5, Math.floor(Number(maxJumps) || 0)));
      return new Map([...allDistances(systemId)].filter(([,distance]) => distance <= radius));
    }
    function buildTacticalLayout(systemId, radius = 3, protectedIds = []) {
      const origin = byId.get(Number(systemId));
      if (!origin) throw new Error('Select a known system for Tactical.');
      const distances = getNeighborhood(systemId, radius), ids = new Set(distances.keys());
      const fullDistances = allDistances(systemId);
      for (const id of protectedIds) if (byId.has(Number(id))) ids.add(Number(id));
      const selected = [...ids].sort((a,b) => a-b).map(id => byId.get(id));
      const position = node => AXES.map(axis => Number(node.position_m?.[axis] ?? node['ccp' + axis.toUpperCase()] ?? node[axis]));
      const centre = position(origin), offsets = selected.map(node => position(node).map((v,i) => v - centre[i]));
      if (offsets.some(v => v.some(x => !Number.isFinite(x)))) throw new Error('Invalid CCP coordinates.');
      const extent = Math.max(1, ...offsets.map(v => Math.hypot(...v)));
      const normalized = offsets.map(v => v.map(x => x / extent));
      // The longest physical direction defines a deterministic local axis.
      // Pick the most independent second direction, then compress its normal.
      const longest = normalized.reduce((a,b) => dot(a,a) >= dot(b,b) ? a : b, [0,0,0]);
      const u = Math.hypot(...longest) > 1e-9 ? unit(longest) : [1,0,0];
      const residuals = normalized.map(v => v.map((x,i) => x - dot(v,u)*u[i]));
      let second = residuals.reduce((a,b) => dot(a,a) >= dot(b,b) ? a : b, [0,0,0]);
      if (Math.hypot(...second) < 1e-9) second = cross(u, Math.abs(u[1]) < .9 ? [0,1,0] : [0,0,1]);
      const v = unit(second), normal = unit(cross(u,v));
      const localLinks = links.filter(link => ids.has(link.source) && ids.has(link.target));
      const offsetById = new Map(selected.map((node,i) => [Number(node.id), normalized[i]]));
      const lengths = localLinks.map(link => Math.hypot(...offsetById.get(link.source).map((x,i) => x-offsetById.get(link.target)[i]))).filter(x => x > 1e-9).sort((a,b) => a-b);
      const scale = lengths.length ? 32 / lengths[Math.floor(lengths.length/2)] : 60;
      const nodes = selected.map((node,i) => {
        const physical = position(node), offset = normalized[i];
        let tx = dot(offset,u)*scale, ty = dot(offset,v)*scale, tz = dot(offset,normal)*scale*.08;
        const hops = fullDistances.get(Number(node.id)) ?? null;
        const limit = READABILITY.outlierBase + READABILITY.outlierPerHop*Math.min(hops ?? 6,6);
        const length = Math.hypot(tx,ty,tz);
        if (length > limit) {
          const compression = (limit + limit*.2*Math.tanh((length-limit)/limit))/length;
          tx *= compression; ty *= compression; tz *= compression;
        }
        return { id: Number(node.id), ccpX: physical[0], ccpY: physical[1], ccpZ: physical[2],
          tx, ty, tz, x: tx, y: ty, z: tz, vx: 0, vy: 0, vz: 0,
          hops, inNeighborhood: distances.has(Number(node.id)) };
      });
      return { nodes, links: localLinks.map(link => ({...link})), centreId: Number(systemId), plane: {u,v,normal}, scale };
    }
    function buildRadialLayout(systemId, radius = 3, protectedIds = [], priorities = new Map()) {
      const origin = byId.get(Number(systemId));
      if (!origin) throw new Error('Select a known system for Tactical.');
      const position = node => AXES.map(axis => node.position_m?.[axis]);
      const centre = position(origin);
      if (!centre.every(Number.isFinite)) throw new Error('Invalid CCP coordinates.');
      const distances = allDistances(systemId), local = getNeighborhood(systemId, radius);
      const ids = new Set(local.keys());
      for (const id of protectedIds) if (byId.has(Number(id))) ids.add(Number(id));
      // Full connected component, not visible nodes: this band never moves on selection.
      const unreachableIds = [...ids].filter(id=>!distances.has(id)).sort((a,b)=>a-b);
      const unreachableAngles = new Map(unreachableIds.map((id,index)=>[id,index*2*Math.PI/unreachableIds.length]));
      const unreachableRadius = Math.max(radialRadius(Math.max(0, ...distances.values())) + 60, unreachableIds.length*18/(2*Math.PI));
      const nodes = [...ids].sort((a,b) => a-b).map(id => {
        const p = position(byId.get(id));
        if (!p.every(Number.isFinite)) throw new Error('Invalid CCP coordinates.');
        const hops = distances.get(id) ?? null;
        const dx = p[0]-centre[0], dz = p[2]-centre[2];
        const angle = hops === null ? unreachableAngles.get(id) : Math.atan2(dz, dx);
        const ringRadius = hops === null ? unreachableRadius : radialRadius(hops);
        const x = Math.cos(angle)*ringRadius, z = Math.sin(angle)*ringRadius;
        // Exact X/Z geographic projection. No route spine, simulation or label offset.
        return {id, ccpX:p[0], ccpY:p[1], ccpZ:p[2], hops,
          inNeighborhood:local.has(id), geographicAngle:angle, packingPriority:priorities.get(id)||0,
          geographicDirectionKnown:hops !== null && (dx !== 0 || dz !== 0),
          ringRadius, unreachable:hops === null,
          x,y:0,z,tx:x,ty:0,tz:z,fx:x,fy:0,fz:z,vx:0,vy:0,vz:0};
      });
      packRadialNodes(nodes);
      return {nodes, links:links.filter(l=>ids.has(l.source)&&ids.has(l.target)).map(l=>({...l})),
        centreId:Number(systemId), plane:{u:[1,0,0],v:[0,0,1],normal:[0,-1,0]}, unreachableRadius};
    }
    let localLayoutKey=null, localLayoutPositions=null;
    function buildHybridLayout(systemId, radius=3, protectedIds=[], priorities=new Map()) {
      const layout=buildRadialLayout(systemId,radius,protectedIds,priorities);
      const key=`${Number(systemId)}:${radius}`;
      if(localLayoutKey!==key) {
        // Local geometry depends only on the reference and neighborhood, never
        // on selection, remote kills or a planned jump passing through it.
        const local=buildRadialLayout(systemId,radius).nodes.filter(n=>n.inNeighborhood);
        const localById=new Map(local.map(n=>[n.id,n]));
        const edges=links.filter(l=>localById.has(l.source)&&localById.has(l.target));
        const collision=createCollisionForce(9,'xz');collision.initialize(local);
        for(let tick=0;tick<200;tick++) {
          for(const n of local) {
            n.vx=(n.vx||0)*.65+(n.tx-n.x)*.002;
            n.vz=(n.vz||0)*.65+(n.tz-n.z)*.002;
          }
          for(const edge of edges) {
            const a=localById.get(edge.source),b=localById.get(edge.target);
            const dx=b.x-a.x,dz=b.z-a.z,d=Math.hypot(dx,dz)||1;
            const force=(d-36)/d*.08;
            a.vx+=dx*force;a.vz+=dz*force;b.vx-=dx*force;b.vz-=dz*force;
          }
          collision();
          for(const n of local) {
            if(n.id===Number(systemId)){n.x=0;n.z=0;n.vx=0;n.vz=0;continue;}
            n.x+=Math.max(-8,Math.min(8,n.vx));n.z+=Math.max(-8,Math.min(8,n.vz));
          }
        }
        const extent=Math.max(1,...local.map(n=>Math.hypot(n.x,n.z)));
        const scale=Math.min(1,Math.max(60,radialRadius(radius)*.85)/extent);
        localLayoutPositions=new Map(local.map(n=>[n.id,{x:n.x*scale,z:n.z*scale}]));
        localLayoutKey=key;
      }
      for(const n of layout.nodes) {
        const p=localLayoutPositions.get(n.id);
        if(!p)continue;
        n.x=n.tx=n.fx=p.x;n.z=n.tz=n.fz=p.z;
        n.layoutRole='LOCAL_TOPOLOGY';n.ringRadius=n.hops===0?0:null;
        n.packedAngle=null;n.angularDisplacement=null;n.packingSaturated=false;
      }
      layout.layoutKind='hybrid';
      return layout;
    }
    return { getNeighborhood, buildTacticalLayout, buildRadialLayout, buildHybridLayout };
  }
  function radialRadius(hops) {
    return Math.min(hops,5)*60 + Math.max(0,Math.min(hops-5,5))*40
      + Math.max(0,Math.min(hops-10,10))*24 + Math.max(0,hops-20)*12;
  }
  // Layout units at the nominal Tactical zoom. Camera changes never repack nodes.
  const PACKING = Object.freeze({unitsPerPixel:2, margin:4, importantMargin:6});
  const TAU = Math.PI*2;
  const wrapAngle = a => Math.atan2(Math.sin(a),Math.cos(a));
  function packRadialNodes(nodes) {
    const rings=new Map();
    for(const n of nodes) {
      if(!(n.ringRadius>0))continue;
      const key=`${n.hops}:${n.ringRadius}`;
      if(!rings.has(key))rings.set(key,[]);
      rings.get(key).push(n);
    }
    for(const ring of rings.values()) {
      const angle=n=>((n.geographicAngle%TAU)+TAU)%TAU;
      ring.sort((a,b)=>angle(a)-angle(b)||a.id-b.id);
      const count=ring.length,R=ring[0].ringRadius;
      const size=n=>visualHierarchy(n.hops,n.packingPriority||0).radius*PACKING.unitsPerPixel;
      const gap=(a,b)=>2*Math.asin(Math.min(1,(size(a)+size(b)+
        (Math.max(a.packingPriority||0,b.packingPriority||0)>=3?PACKING.importantMargin:PACKING.margin))/(2*R)));
      // Cut at the largest geographical gap, away from a seam-straddling cluster.
      let cut=0,largest=-1;
      for(let i=0;i<count;i++) {
        const space=angle(ring[(i+1)%count])-angle(ring[i])+(i===count-1?TAU:0);
        if(space>largest){largest=space;cut=(i+1)%count;}
      }
      const ordered=ring.slice(cut).concat(ring.slice(0,cut));
      const targets=ordered.map(n=>angle(n));
      for(let i=1;i<count;i++)while(targets[i]<targets[i-1])targets[i]+=TAU;
      const gaps=ordered.map((n,i)=>gap(n,ordered[(i+1)%count]));
      const total=gaps.reduce((a,b)=>a+b,0), saturated=total>TAU;
      if(saturated)for(let i=0;i<count;i++)gaps[i]*=TAU/total;
      const offsets=[0];for(let i=1;i<count;i++)offsets[i]=offsets[i-1]+gaps[i-1];
      // Least-squares isotonic regression: minimum angular movement for this
      // geographic ordering. Subtract required gaps, pool adjacent violations.
      const blocks=[];
      for(let i=0;i<count;i++) {
        blocks.push({start:i,end:i,sum:targets[i]-offsets[i],weight:1});
        while(blocks.length>1) {
          const b=blocks[blocks.length-1],a=blocks[blocks.length-2];
          if(a.sum/a.weight<=b.sum/b.weight)break;
          blocks.splice(-2,2,{start:a.start,end:b.end,sum:a.sum+b.sum,weight:a.weight+b.weight});
        }
      }
      // Circular last/first gap imposes a maximum span on the fitted values.
      const span=Math.max(0,TAU-gaps.reduce((a,b)=>a+b,0));
      let lower=-Infinity,upper=Infinity;
      if(blocks.at(-1).sum/blocks.at(-1).weight-blocks[0].sum/blocks[0].weight>span) {
        let lo=blocks[0].sum/blocks[0].weight-span,hi=blocks.at(-1).sum/blocks.at(-1).weight;
        for(let step=0;step<64;step++) {
          const mid=(lo+hi)/2;
          const derivative=blocks.reduce((sum,b)=>{const mean=b.sum/b.weight;return sum+b.weight*(Math.max(mid,Math.min(mid+span,mean))-mean);},0);
          if(derivative>0)hi=mid;else lo=mid;
        }
        lower=(lo+hi)/2;upper=lower+span;
      }
      for(const b of blocks)for(let i=b.start;i<=b.end;i++) {
        const n=ordered[i],fitted=Math.max(lower,Math.min(upper,b.sum/b.weight))+offsets[i];
        const displacement=wrapAngle(fitted-targets[i]);
        n.packedAngle=n.geographicAngle+(Math.abs(displacement)<1e-12?0:displacement);
        n.angularDisplacement=displacement;n.packingSaturated=saturated;
        n.x=n.tx=n.fx=Math.cos(n.packedAngle)*R;
        n.z=n.tz=n.fz=Math.sin(n.packedAngle)*R;
      }
    }
    return nodes;
  }
  function createLabelPacker(width,height) {
    const cells=new Map(),cellSize=64;
    const keys=box=>{
      const result=[];
      for(let x=Math.floor(box.left/cellSize);x<=Math.floor(box.right/cellSize);x++)
        for(let y=Math.floor(box.top/cellSize);y<=Math.floor(box.bottom/cellSize);y++)result.push(`${x}:${y}`);
      return result;
    };
    return (x,y,textWidth,previous=null)=>{
      const options=[...[previous].filter(Boolean),...[0,-18,18,-36,36].flatMap(dy=>[{dx:0,dy},{dx:textWidth+14,dy}])];
      for(const slot of options) {
        const px=x+slot.dx,py=y+slot.dy;
        const box={left:px-textWidth-3,right:px+3,top:py-14,bottom:py+4,x:px,y:py,slot};
        if(box.left<0||box.right>width||box.top<0||box.bottom>height)continue;
        const occupied=new Set(keys(box).flatMap(key=>cells.get(key)||[]));
        if([...occupied].some(b=>box.left<b.right&&box.right>b.left&&box.top<b.bottom&&box.bottom>b.top))continue;
        for(const key of keys(box)){if(!cells.has(key))cells.set(key,[]);cells.get(key).push(box);}
        return box;
      }
      return null;
    };
  }
  function radialReference(characterSystemId, plannerOriginId, retainedReference, selectedId, knownIds) {
    return [characterSystemId,plannerOriginId,retainedReference,selectedId]
      .map(Number).find(id=>id>0 && knownIds.has(id)) ?? null;
  }
  function createAnchorForce(strength = .08) {
    let nodes = [];
    const force = alpha => {
      for (const node of nodes) for (const axis of AXES) {
        node['v'+axis] = (node['v'+axis] || 0) + (node['t'+axis]-node[axis])*strength*alpha;
      }
    };
    force.initialize = values => { nodes = values; };
    return force;
  }
  function labelPolicy(hops, important = false) {
    return important || (hops != null && hops <= 2) ? 'always' : hops === 3 ? 'space' : 'hidden';
  }
  function createCollisionForce(radius = 9, plane = 'xy') {
    const axis = plane === 'xz' ? 'z' : 'y', velocity = 'v'+axis;
    let nodes = [];
    const diameter = radius * 2;
    const force = () => {
      const cells = new Map();
      for (let i = 0; i < nodes.length; i++) {
        const a = nodes[i], cx = Math.floor(a.x/diameter), cy = Math.floor(a[axis]/diameter);
        for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
          for (const b of cells.get(`${cx+dx}:${cy+dy}`) || []) {
            let x = a.x-b.x, y = a[axis]-b[axis], distance = Math.hypot(x,y);
            if (distance >= diameter) continue;
            if (distance < 1e-6) { x = Number(a.id) < Number(b.id) ? -.001 : .001; y = .001; distance = Math.hypot(x,y); }
            const strength = (diameter-distance)/distance*.25;
            a.vx += x*strength; a[velocity] += y*strength;
            b.vx -= x*strength; b[velocity] -= y*strength;
          }
        }
        const key = `${cx}:${cy}`;
        if (!cells.has(key)) cells.set(key, []);
        cells.get(key).push(a);
      }
    };
    force.initialize = values => { nodes = values; };
    return force;
  }
  function applyForces(graph, mode, defaults, flat = false) {
    const tactical = mode === 'tactical' && !flat;
    if (tactical) {
      defaults.link?.distance?.(32); defaults.link?.strength?.(.12);
      defaults.charge?.strength?.(READABILITY.charge); defaults.charge?.distanceMax?.(90);
    }
    graph.d3Force('link', tactical ? defaults.link : null);
    graph.d3Force('charge', tactical ? defaults.charge : null);
    graph.d3Force('center', null);
    graph.d3Force('tactical-anchor', tactical ? createAnchorForce() : null);
    graph.d3Force('tactical-collision', tactical ? createCollisionForce(READABILITY.collisionRadius, flat ? 'xz' : 'xy') : null);
    graph.d3Force('tactical-rings', null);
    graph.cooldownTicks(tactical ? 180 : 0);
    // Reheat only on a requested layout change, never pointermove or idle.
    graph.d3ReheatSimulation?.();
  }
  const api = { createTopology, radialRadius, radialReference, packRadialNodes, createLabelPacker, PACKING, createAnchorForce, createCollisionForce, applyForces, labelPolicy, READABILITY, visualHierarchy, OVERLAY_STYLES };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.EveMapTactical = api;
})(typeof window !== 'undefined' ? window : globalThis);
