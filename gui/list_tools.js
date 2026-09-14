(function (root) {
  'use strict';
  const normalize = value => String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  function matches(values, query) {
    const text = normalize(values.join(' '));
    return normalize(query).trim().split(/\s+/).filter(Boolean).every(term => text.includes(term));
  }
  function sorted(rows, value, numeric, direction) {
    return rows.slice().sort((a, b) => {
      let x = value(a), y = value(b);
      const absent = v => v == null || v === '';
      if (absent(x) || absent(y)) return absent(x) ? (absent(y) ? 0 : 1) : -1;
      if (numeric) {
        x = /^-?\d+$/.test(String(x)) ? BigInt(x) : Number(x);
        y = /^-?\d+$/.test(String(y)) ? BigInt(y) : Number(y);
        return (x < y ? -1 : x > y ? 1 : 0) * direction;
      }
      return normalize(x).localeCompare(normalize(y), 'fr', {numeric: true}) * direction;
    });
  }
  const api = {matches, sorted};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MmdListTools = api;
})(globalThis);
