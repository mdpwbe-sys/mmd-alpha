/* Pure, offline gate-flow estimator. ESI only supplies per-system totals. */
(function (root) {
  const DEFAULTS = Object.freeze({ epsilon: 1, alpha: .85, reciprocalWeight: .35, maxIterations: 30 });
  const id = value => String(value);
  function estimateGateTraffic(topology, totals, options = {}) {
    const cfg = { ...DEFAULTS, ...options }, neighbors = new Map();
    Object.entries(topology || {}).forEach(([source, targets]) => neighbors.set(id(source), [...new Set((targets || []).map(id))]));
    const total = key => Math.max(0, Number(totals?.[key] ?? totals?.[Number(key)] ?? 0) || 0);
    const base = (source, target) => Math.pow(total(target) + cfg.epsilon, cfg.alpha);
    const share = (source, target) => {
      const list = neighbors.get(source) || [], sum = list.reduce((value, other) => value + base(source, other), 0);
      return sum ? base(source, target) / sum : 0;
    };
    const directed = {}, add = (source, target, value) => { directed[`${source}:${target}`] = Math.max(0, value); };
    neighbors.forEach((targets, source) => {
      const weighted = targets.map(target => ({ target, weight: base(source, target) * (1 + cfg.reciprocalWeight * share(target, source)) }));
      const sum = weighted.reduce((value, row) => value + row.weight, 0);
      weighted.forEach(row => add(source, row.target, sum ? total(source) * row.weight / sum : 0));
    });
    const gates = {};
    neighbors.forEach((targets, source) => targets.forEach(target => {
      const canonical = [source, target].sort((left, right) => Number(left) - Number(right)).join(':');
      if (gates[canonical]) return;
      const forward = directed[`${source}:${target}`] || 0, reverse = directed[`${target}:${source}`] || 0;
      const degreeA = (neighbors.get(source) || []).length, degreeB = (neighbors.get(target) || []).length;
      const activity = (forward + reverse) / 2;
      const confidence = Math.max(.1, Math.min(1, ((degreeA === 1 || degreeB === 1 ? .8 : .45) + Math.min(.25, Math.abs(forward - reverse) / Math.max(1, forward + reverse)) + (activity >= 1 ? .1 : 0))));
      gates[canonical] = { source: source, target: target, source_to_target: forward, target_to_source: reverse, activity, confidence, method: 'network_flow_estimate' };
    }));
    return { gates, directed, method: 'network_flow_estimate', options: cfg };
  }
  root.EveGateTraffic = { DEFAULTS, estimateGateTraffic };
})(window);
