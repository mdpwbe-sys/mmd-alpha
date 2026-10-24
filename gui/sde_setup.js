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
        '<p class="sde-setup-copy">First launch: MMD downloads the official CCP SDE and prepares local IDs, skills, hulls and New Eden data. No developer account or client secret is required.</p>' +
        '<progress max="100" aria-label="EVE data setup progress"></progress>' +
        '<p class="sde-setup-status" role="status" aria-live="polite"></p>' +
        '<button type="button" class="sde-retry" hidden>Retry download</button>' +
        '<div class="sde-actions" hidden>' +
          '<button type="button" class="sde-secondary" data-action="later">Later</button>' +
          '<button type="button" class="sde-primary" data-action="download">Download update</button>' +
        '</div>';
      const title = dialog.querySelector('#sde-setup-title');
      const copy = dialog.querySelector('.sde-setup-copy');
      const progress = dialog.querySelector('progress');
      const message = dialog.querySelector('[role="status"]');
      const retry = dialog.querySelector('.sde-retry');
      const actions = dialog.querySelector('.sde-actions');
      const later = dialog.querySelector('[data-action="later"]');
      const download = dialog.querySelector('[data-action="download"]');
      dialog.addEventListener('cancel', event => event.preventDefault());
      let timer;
      let updateOffered = false;
      let checkAttempted = false;
      let retryMode = 'download';

      function showDialog() {
        if (!dialog.isConnected) document.body.appendChild(dialog);
        if (!dialog.open) dialog.showModal();
      }

      function failed(error) {
        clearTimeout(timer);
        retryMode = 'download';
        title.textContent = 'Preparing EVE data';
        copy.textContent = 'First launch: MMD downloads the official CCP SDE and prepares local IDs, skills, hulls and New Eden data. No developer account or client secret is required.';
        copy.hidden = false;
        progress.hidden = false;
        progress.removeAttribute('value');
        actions.hidden = true;
        download.hidden = false;
        later.textContent = 'Later';
        retry.textContent = 'Retry download';
        retry.hidden = false;
        retry.disabled = false;
        message.textContent = String(error && error.message || error);
        showDialog();
      }

      function showSetup() {
        title.textContent = 'Preparing EVE data';
        copy.textContent = 'First launch: MMD downloads the official CCP SDE and prepares local IDs, skills, hulls and New Eden data. No developer account or client secret is required.';
        copy.hidden = false;
        progress.hidden = false;
        actions.hidden = true;
        download.hidden = false;
        later.textContent = 'Later';
        showDialog();
      }

      function showUpdateOffer(state) {
        updateOffered = true;
        retryMode = 'download';
        title.textContent = 'EVE data update available';
        copy.textContent = 'A newer official CCP Static Data Export is available. Download now (~95 MB) or keep the installed build for now. MMD checks for updates at each launch.';
        copy.hidden = false;
        progress.hidden = true;
        retry.hidden = true;
        actions.hidden = false;
        download.hidden = false;
        later.textContent = 'Later';
        message.textContent = state.message ||
          ('Build ' + state.remote_build + ' available (installed: ' + state.local_build + ')');
        showDialog();
      }

      function showCheckError(state) {
        updateOffered = true;
        retryMode = 'check';
        title.textContent = 'Could not check for EVE data updates';
        copy.textContent = 'MMD could not reach the official CCP SDE manifest. Your installed data stays available. Retry the check, or continue with the current build.';
        copy.hidden = false;
        progress.hidden = true;
        actions.hidden = false;
        download.hidden = true;
        later.textContent = 'Continue';
        retry.textContent = 'Retry check';
        retry.hidden = false;
        retry.disabled = false;
        message.textContent = state.message || 'Update check failed';
        showDialog();
      }

      function finish() {
        clearTimeout(timer);
        dialog.remove();
        resolve();
      }

      async function afterReady() {
        if (updateOffered || checkAttempted || !api.sde_update_check) {
          finish();
          return;
        }
        checkAttempted = true;
        try {
          const state = await api.sde_update_check();
          await handle(state);
        } catch (error) {
          showCheckError({message: String(error && error.message || error)});
        }
      }

      async function handle(state) {
        if (state.phase === 'ready') {
          finish();
          return;
        }
        if (state.phase === 'update_available') {
          showUpdateOffer(state);
          return;
        }
        if (state.phase === 'check_error') {
          showCheckError(state);
          return;
        }
        if (state.phase === 'checking') {
          timer = setTimeout(poll, 400);
          return;
        }
        showSetup();
        message.textContent = state.message || 'Preparing local EVE data…';
        if (state.bytes_total && state.phase === 'downloading') {
          message.textContent += ' · ' + (state.bytes_downloaded / 1048576).toFixed(1) +
            ' / ' + (state.bytes_total / 1048576).toFixed(1) + ' MB';
        }
        if (state.percent) progress.value = state.percent;
        else progress.removeAttribute('value');
        if (state.phase === 'error') { failed(state.message); return; }
        if (state.phase === 'missing') { await poll(true); return; }
        timer = setTimeout(poll, 1000);
      }

      async function poll(start = false) {
        try {
          const state = await (start ? api.sde_setup_start() : api.sde_setup_status());
          if (state.phase === 'ready' && !updateOffered) {
            await afterReady();
            return;
          }
          await handle(state);
        } catch (error) { failed(error); }
      }

      retry.onclick = async () => {
        retry.hidden = true;
        retry.disabled = true;
        if (retryMode === 'check') {
          try {
            const state = await api.sde_update_check();
            await handle(state);
          } catch (error) {
            showCheckError({message: String(error && error.message || error)});
          }
          return;
        }
        poll(true);
      };
      later.onclick = async () => {
        try {
          if (api.sde_update_defer) await api.sde_update_defer();
        } catch (_) {}
        finish();
      };
      download.onclick = () => {
        actions.hidden = true;
        progress.hidden = false;
        title.textContent = 'Updating EVE data';
        copy.textContent = 'Downloading the official CCP SDE and refreshing local IDs, skills, hulls and New Eden data.';
        poll(true);
      };
      poll();
    });
    return pending;
  }
  root.MmdSdeSetup = { ensure };
})(window);
