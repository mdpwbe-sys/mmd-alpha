/* Coordinate adapter only. One backend route, never a second route calculation. */
(function(root){
  'use strict';
  function physicalPoint(position,transform) {
    if(!position||!transform)return null;
    const point={};
    for(const axis of ['x','y','z']) {
      point[axis]=(Number(position[axis])-transform.centre[axis])*transform.scale;
      if(!Number.isFinite(point[axis]))return null;
    }
    return point;
  }
  function physicalView(jumpRouteState,transform) {
    if(!jumpRouteState)return {jumpRouteState:null,points:new Map(),range:null};
    const points=new Map(Object.entries(jumpRouteState.positions_m||{}).map(([id,p])=>[Number(id),physicalPoint(p,transform)]));
    const center=points.get(Number(jumpRouteState.origin_id));
    const radius=Number(jumpRouteState.range_m)*transform.scale;
    return {jumpRouteState,points,range:center&&radius>0&&Number.isFinite(radius)?{center,radius}:null};
  }
  function tacticalView(jumpRouteState,nodesById) {
    return {jumpRouteState,points:nodesById,range:null};
  }
  function sphere(sample,range,style) {
    if(!sample?.clone||!range)return null;
    const geometry=sample.geometry;
    if(geometry?.type!=='SphereGeometry')return null;
    // Reuse bundled Three constructors; no second runtime or renderer loop.
    const mesh=sample.clone(false);
    mesh.geometry=new geometry.constructor(range.radius,24,16);
    mesh.material=sample.material.clone();mesh.material.color.set(style.color);
    mesh.material.transparent=true;mesh.material.opacity=.12;mesh.material.wireframe=true;mesh.material.depthWrite=false;
    mesh.scale.set(1,1,1);mesh.position.set(range.center.x,range.center.y,range.center.z);
    mesh.visible=true;mesh.userData={jumpRange:true};mesh.raycast=()=>{};
    return mesh;
  }
  function disposeSphere(mesh) {if(mesh){mesh.parent?.remove(mesh);mesh.geometry.dispose();mesh.material.dispose();}}
  const api={physicalPoint,physicalView,tacticalView,sphere,disposeSphere};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.EveJumpOverlay=api;
}(typeof window!=='undefined'?window:globalThis));
