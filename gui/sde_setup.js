(function (root) {
  'use strict';
  let pending;
  function ensure(api) {
    if (!api || !api.sde_setup_status) return Promise.resolve();
    if (pending) return pending;
    pending = new Promise((resolve) => {
      const dialog = document.createElement('dialog');
      dialog.className = 'sde-setup';
      dialog.setAttribute('aria-labelledby', 'sde-setup-title');
      dialog.innerHTML = '<h2 id="sde-setup-title">Preparing EVE data</h2>' +
        '<p>First launch: MMD downloads the official CCP SDE and prepares local IDs, skills, hulls and New Eden data. No developer account or client secret is required.</p>' +
        '<progress max="100" aria-label="EVE data setup progress"></progress>' +
        '<p class="sde-setup-status" role="status" aria-live="polite"></p>' +
        '<button type="button" hidden>Retry download</button>';
      const progress = dialog.querySelector('progress');
      const message = dialog.querySelector('[role="status"]');
      const retry = dialog.querySelector('button');
      dialog.addEventListener('cancel', event => event.preventDefault());
      let timer;
      function failed(error) {
        clearTimeout(timer);
        show();
        message.textContent = String(error && error.message || error);
        retry.hidden = false;
        retry.disabled = false;
        progress.removeAttribute('value');
      }
      function show() {
        if (!dialog.isConnected) document.body.appendChild(dialog);
        if (!dialog.open) dialog.showModal();
      }
      async function poll(start = false) {
        try {
          const state = await (start ? api.sde_setup_start() : api.sde_setup_status());
          if (state.phase === 'ready') {
            clearTimeout(timer);
            dialog.remove();
            resolve();
            return;
          }
          show();
          message.textContent = state.message || 'Preparing local EVE data…';
          if (state.bytes_total && state.phase === 'downloading') {
            message.textContent += ' · ' + (state.bytes_downloaded / 1048576).toFixed(1) +
              ' / ' + (state.bytes_total / 1048576).toFixed(1) + ' MB';
          }
          if (state.percent) progress.value = state.percent;
          else progress.removeAttribute('value');
          if (state.phase === 'error') { failed(state.message); return; }
          if (state.phase === 'missing') { await poll(true); return; }
          timer = setTimeout(() => poll(), 1000);
        } catch (error) { failed(error); }
      }
      retry.onclick = () => { retry.hidden = true; retry.disabled = true; poll(true); };
      poll();
    });
    return pending;
  }
  root.MmdSdeSetup = { ensure };
})(window);
