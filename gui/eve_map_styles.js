/* Shared semantic styles. Canvas helpers own dash reset and marker shapes. */
(function(root) {
  'use strict';
  const style=(color,width,dash,priority,symbol='',shape='')=>Object.freeze({color,width,dash:Object.freeze(dash),priority,symbol,shape});
  const registry=Object.freeze({
    STARGATE:style('#69e8f1',.8,[],10),
    ACTIVE_STARGATE_ROUTE:style('#e5fcff',2.8,[],60),
    LIVE_INTEL_DANGER:style('#efa34f',1.2,[5,4],20),
    PLANNED_JUMP:style('#c881f5',2.5,[],50,'⇢'),
    CYNO_CONNECTION:style('#64dfb3',1.8,[1,4],40),
    MIDPOINT:style('#c881f5',1.5,[],40,'◆','diamond'),
    CYNO_POSITIONED:style('#64dfb3',1.5,[],40,'◆','diamond'),
    CYNO_ALT:style('#64dfb3',1.5,[],40,'◇','diamond-outline'),
    JUMP_RANGE:style('#58bfd6',1,[],30,'○','circle'),
    UNREACHABLE:style('#b96670',1,[],15,'×','cross')
  });
  function applyLine(context,kind,{opacity=1,width}={}) {
    const value=registry[kind];
    context.strokeStyle=value.color;
    context.lineWidth=width ?? value.width;
    context.globalAlpha=opacity;
    context.setLineDash?.(value.dash);
    context.lineCap=kind==='CYNO_CONNECTION'?'round':'butt';
    return value;
  }
  const api=Object.freeze({registry,applyLine});
  if(typeof module!=='undefined'&&module.exports) module.exports=api;
  else root.EveMapStyles=api;
}(typeof window!=='undefined'?window:globalThis));
