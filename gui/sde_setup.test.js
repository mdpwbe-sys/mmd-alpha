const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function harness(api) {
  const nodes = {
    title: {textContent: ''},
    copy: {textContent: '', hidden: false},
    status: {textContent: ''},
    progress: {hidden: false, removeAttribute() { delete this.value; }},
    retry: {hidden: true, disabled: false},
    actions: {hidden: true},
    later: {},
    download: {},
  };
  const dialog = {
    isConnected: false,
    open: false,
    setAttribute() {},
    addEventListener() {},
    querySelector(selector) {
      if (selector === '#sde-setup-title') return nodes.title;
      if (selector === '.sde-setup-copy') return nodes.copy;
      if (selector === 'progress') return nodes.progress;
      if (selector === '[role="status"]') return nodes.status;
      if (selector === '.sde-retry') return nodes.retry;
      if (selector === '.sde-actions') return nodes.actions;
      if (selector === '[data-action="later"]') return nodes.later;
      if (selector === '[data-action="download"]') return nodes.download;
      return null;
    },
    showModal() { this.open = true; },
    remove() { this.isConnected = false; this.open = false; },
  };
  const timers = new Set();
  const window = {};
  const context = {
    window,
    document: {createElement: () => dialog, body: {appendChild() { dialog.isConnected = true; }}},
    setTimeout(fn) { timers.add(fn); return fn; },
    clearTimeout(fn) { timers.delete(fn); },
  };
  vm.runInNewContext(fs.readFileSync(__dirname + '/sde_setup.js', 'utf8'), context);
  return {dialog, nodes, timers, ensure: () => window.MmdSdeSetup.ensure(api)};
}
const flush = () => new Promise(resolve => setImmediate(resolve));

test('installed SDE does not open modal or download', async () => {
  const h = harness({
    sde_setup_status: async () => ({phase: 'ready'}),
    sde_setup_start: () => { throw Error('unexpected download'); },
  });
  await h.ensure();
  assert.equal(h.dialog.open, false);
  assert.equal(h.timers.size, 0);
});

test('first run waits for conversion and leaves no polling after ready', async () => {
  let phase = 'missing', starts = 0;
  const h = harness({
    sde_setup_status: async () => ({phase}),
    sde_setup_start: async () => { starts++; phase = 'converting'; return {phase, percent: 70}; },
  });
  const ready = h.ensure();
  assert.equal(h.ensure(), ready);
  await flush();
  assert.equal(starts, 1);
  assert.equal(h.dialog.open, true);
  assert.equal(h.nodes.progress.value, 70);
  phase = 'ready';
  const timer = [...h.timers][0];
  h.timers.delete(timer);
  await timer();
  await ready;
  assert.equal(h.dialog.open, false);
  assert.equal(h.timers.size, 0);
});

test('offline error remains visible and offers explicit retry', async () => {
  let starts = 0;
  const h = harness({
    sde_setup_status: async () => ({phase: 'error', message: 'Offline'}),
    sde_setup_start: async () => { starts++; return {phase: 'ready'}; },
  });
  const ready = h.ensure();
  await flush();
  assert.equal(h.nodes.retry.hidden, false);
  assert.equal(h.nodes.status.textContent, 'Offline');
  assert.equal(h.timers.size, 0);
  h.nodes.retry.onclick();
  await ready;
  assert.equal(starts, 1);
});

test('launch update offer can be deferred without downloading', async () => {
  let deferred = 0;
  const h = harness({
    sde_setup_status: async () => ({phase: 'ready'}),
    sde_setup_start: () => { throw Error('unexpected download'); },
    sde_update_check: async () => ({
      phase: 'update_available',
      local_build: 42,
      remote_build: 99,
      message: 'Build 99 available',
    }),
    sde_update_defer: async () => { deferred++; return {phase: 'ready'}; },
  });
  const ready = h.ensure();
  await flush();
  assert.equal(h.dialog.open, true);
  assert.equal(h.nodes.actions.hidden, false);
  assert.match(h.nodes.title.textContent, /update/i);
  h.nodes.later.onclick();
  await ready;
  assert.equal(deferred, 1);
  assert.equal(h.dialog.open, false);
});

test('accepted update starts download and closes when ready', async () => {
  let phase = 'ready';
  let starts = 0;
  const h = harness({
    sde_setup_status: async () => ({phase, percent: phase === 'downloading' ? 40 : 100}),
    sde_setup_start: async () => { starts++; phase = 'downloading'; return {phase, percent: 40}; },
    sde_update_check: async () => ({phase: 'update_available', local_build: 1, remote_build: 2}),
  });
  const ready = h.ensure();
  await flush();
  assert.equal(h.nodes.actions.hidden, false);
  h.nodes.download.onclick();
  await flush();
  assert.equal(starts, 1);
  assert.equal(h.nodes.progress.hidden, false);
  phase = 'ready';
  const timer = [...h.timers][0];
  h.timers.delete(timer);
  await timer();
  await ready;
  assert.equal(h.dialog.open, false);
});

test('failed update check alerts and continue dismisses', async () => {
  let deferred = 0;
  let checks = 0;
  const h = harness({
    sde_setup_status: async () => ({phase: 'ready'}),
    sde_setup_start: () => { throw Error('unexpected download'); },
    sde_update_check: async () => {
      checks++;
      return {phase: 'check_error', message: 'Could not check: offline'};
    },
    sde_update_defer: async () => { deferred++; return {phase: 'ready'}; },
  });
  const ready = h.ensure();
  await flush();
  assert.equal(checks, 1);
  assert.equal(h.dialog.open, true);
  assert.match(h.nodes.title.textContent, /could not check/i);
  assert.equal(h.nodes.retry.hidden, false);
  assert.equal(h.nodes.download.hidden, true);
  assert.equal(h.nodes.later.textContent, 'Continue');
  h.nodes.later.onclick();
  await ready;
  assert.equal(deferred, 1);
  assert.equal(h.dialog.open, false);
});

test('failed update check retry can recover to ready', async () => {
  let checks = 0;
  const h = harness({
    sde_setup_status: async () => ({phase: 'ready'}),
    sde_setup_start: () => { throw Error('unexpected download'); },
    sde_update_check: async () => {
      checks++;
      return checks === 1
        ? {phase: 'check_error', message: 'offline'}
        : {phase: 'ready'};
    },
  });
  const ready = h.ensure();
  await flush();
  assert.equal(h.nodes.retry.hidden, false);
  h.nodes.retry.onclick();
  await ready;
  assert.equal(checks, 2);
  assert.equal(h.dialog.open, false);
});
