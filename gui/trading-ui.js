(function () {
  'use strict';
  const VALID_VIEWS = new Set(['dashboard', 'assets', 'transactions', 'alerts']);
  const T = { workspace: null, settings: null, containerKey: '', request: 0, settingsRequest: 0, initialized: false, assetSearch: '', assetSort: 0, assetSortDir: 1 };
  const el = id => document.getElementById(id);
  const esc = value => String(value == null ? '' : value).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
  const api = () => (window.pywebview && window.pywebview.api) || window.api || null;
  const asId = value => value == null ? null : String(value);

  function integer(value) {
    const raw = String(value == null ? '' : value).trim();
    return /^-?\d+$/.test(raw) ? BigInt(raw) : null;
  }
  function grouped(value) { return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, '.'); }
  function fmtCents(value) {
    const amount = integer(value); if (amount == null) return '–';
    const neg = amount < 0n, abs = neg ? -amount : amount;
    return `${neg ? '-' : ''}${grouped(abs / 100n)},${String(abs % 100n).padStart(2, '0')} ISK`;
  }
  function fmtQty(value) { const n = integer(value); return n == null ? '–' : `${n < 0n ? '-' : ''}${grouped(n < 0n ? -n : n)}`; }
  function fmtBps(value) {
    const n = integer(value); if (n == null) return '–';
    const neg = n < 0n, abs = neg ? -n : n;
    return `${neg ? '-' : '+'}${abs / 100n},${String(abs % 100n).padStart(2, '0')} %`;
  }
  function tone(value) { const n = integer(value); return n == null || n === 0n ? 'trade-muted' : (n > 0n ? 'trade-positive' : 'trade-negative'); }
  function pick(row, keys, fallback) {
    for (const key of keys) if (row && row[key] != null && row[key] !== '') return row[key];
    return fallback == null ? '' : fallback;
  }
  function textCell(value, cls) { return `<td class="${cls || ''}" title="${esc(value)}">${esc(value || '–')}</td>`; }
  function moneyCell(value) { return `<td class="num ${tone(value)}">${fmtCents(value)}</td>`; }
  function table(rows, columns, emptyText, sortable = false) {
    if (!Array.isArray(rows) || !rows.length) return `<div class="trade-empty">${esc(emptyText)}</div>`;
    const head = columns.map((c, i) => `<th class="${c.num ? 'num' : ''}" title="${esc(c.help || c.label)}"${sortable ? ` aria-sort="${T.assetSort === i ? (T.assetSortDir === 1 ? 'ascending' : 'descending') : 'none'}"` : ''}>${sortable ? `<button class="asset-sort" data-asset-sort="${i}">${esc(c.label)}${T.assetSort === i ? (T.assetSortDir === 1 ? ' ▲' : ' ▼') : ''}</button>` : esc(c.label)}</th>`).join('');
    const body = rows.map(row => `<tr>${columns.map(c => c.render(row)).join('')}</tr>`).join('');
    return `<div class="trade-table-wrap"><table class="trade-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
  }
  function sourceBadge() { return `<span class="trade-source">${esc((T.workspace && T.workspace.source_label) || 'Source non configurée')}</span>`; }
  function syncNotice() {
    const data = T.workspace || {}, errors = Array.isArray(data.sync_errors) ? data.sync_errors : [];
    if (!data.stale && !data.cached && !errors.length) return '';
    const details = errors.map(value => value && typeof value === 'object' ? (value.message || value.error || 'Erreur ESI') : String(value)).join(' · ');
    const message = details ? `Données partielles — synchronisation incomplète : ${details}` : (data.cached ? 'Données locales en cache — actualisez pour interroger ESI.' : 'Données potentiellement périmées.');
    return `<div class="trade-sync-warning">${esc(message)}</div>`;
  }
  function shell(title, body, controls) {
    const unvalued = Number(T.workspace?.summary?.unvalued_types || 0);
    const valuationNotice = unvalued > 0 ? `<div class="trade-sync-warning">Valorisation partielle : ${unvalued} type(s) non estimable(s), comptés à 0 ISK. Coûts et profits inconnus non inventés.</div>` : '';
    return `<div class="trade-shell"><div class="trade-toolbar"><h2>${esc(title)}</h2>${controls || ''}${sourceBadge()}` +
      `<button class="btn small" onclick="TradingUI.refresh()">Actualiser trading</button></div>${syncNotice()}${valuationNotice}${body}</div>`;
  }
  function kpi(label, value, primary) {
    return `<div class="trade-kpi${primary ? ' primary' : ''}"><div class="k">${esc(label)}</div><div class="v ${tone(value)}">${fmtCents(value)}</div></div>`;
  }
  function percentKpi(label, value) { return `<div class="trade-kpi"><div class="k">${esc(label)}</div><div class="v ${tone(value)}">${fmtBps(value)}</div></div>`; }
  function assetName(row) { return pick(row, ['name', 'item_name', 'type_name'], 'Objet'); }
  function marketItem(row) {
    const id = String(row.type_id ?? '');
    const label = esc(assetName(row));
    return /^[1-9]\d*$/.test(id) && Number.isSafeInteger(Number(id))
      ? `<button class="trade-market-item" data-market-item="${id}" title="Ouvrir le marché dans EVE">${label}</button>` : label;
  }
  function assetLocation(row, selectedPath) {
    if (integer(row.asset_qty) > 0n) return pick(row, ['container_path', 'container_name'], selectedPath);
    if (integer(row.sell_qty) > 0n) return 'En vente';
    return pick(row, ['container_path', 'container_name'], 'Hors conteneur');
  }

  function dashboard(data) {
    const s = data.summary || {}, assets = Array.isArray(data.assets) ? data.assets : [];
    const ranked = assets.filter(a => integer(pick(a, ['unrealized_pnl_cents', 'latent_pnl_cents'], null)) != null)
      .sort((a, b) => { const av = integer(pick(a, ['unrealized_pnl_cents', 'latent_pnl_cents'], 0)); const bv = integer(pick(b, ['unrealized_pnl_cents', 'latent_pnl_cents'], 0)); return av === bv ? 0 : (av < bv ? 1 : -1); });
    const winner = ranked[0], loser = ranked[ranked.length - 1];
    const insight = (label, row) => `<div class="trade-insight"><div class="title">${label}</div><div class="name">${esc(row ? assetName(row) : '–')}</div>` +
      `<div class="amount ${row ? tone(pick(row, ['unrealized_pnl_cents', 'latent_pnl_cents'], 0)) : 'trade-muted'}">${row ? fmtCents(pick(row, ['unrealized_pnl_cents', 'latent_pnl_cents'], null)) : '–'}</div></div>`;
    const cards = kpi('Fund Value', s.fund_value_cents, true) + kpi('Cash', s.cash_cents) + kpi('Inventaire', s.inventory_value_cents) +
      kpi('Escrow achats', s.buy_escrow_cents) + kpi('P&L réalisé', s.realized_pnl_cents) + kpi('P&L latent', s.unrealized_pnl_cents) +
      percentKpi('Rendement réalisé 30j', s.monthly_return_bp) +
      `<div class="trade-kpi"><div class="k">Jours actifs</div><div class="v">${fmtQty(s.days_running)}</div></div>` +
      `<div class="trade-kpi"><div class="k">Alertes</div><div class="v">${fmtQty(Array.isArray(data.alerts) ? data.alerts.length : null)}</div></div>`;
    return shell('Dashboard', `<div class="trade-kpis">${cards}</div><div class="trade-insights">${insight('Meilleure position', winner)}${insight('Position à surveiller', loser)}</div>`);
  }
  function visibleAssetRows(data) {
    // Portfolio rows also describe unfilled buys and historical cost lots.
    // Keep those in the model, but not in the current-holdings table.
    return (Array.isArray(data.assets) ? data.assets : []).filter(row => {
      const quantity = integer(pick(row, ['quantity', 'qty'], null));
      return quantity == null || quantity > 0n;
    });
  }
  function assets(data) {
    const selectedPath = data.asset_source && (Array.isArray(data.asset_source.path) ? data.asset_source.path.join(' / ') : data.asset_source.name);
    const marketRef = row => row.market_source === 'zero_unvalued' ? 'Non estimable · compté à 0' : row.market_source === 'bpc_manufacturing_margin' ? 'BPC · marge fabrication × runs' : row.market_source === 'cost_fallback' ? 'Coût (marché indisponible)' : row.market_source === 'forge_fallback' ? `The Forge fallback · ${row.valuation_region_id}` : row.market_source === 'regional_history' ? `Région ${row.valuation_region_id}` : 'Indisponible';
    const columns = [
      { label: 'Item', render: r => `<td class="item">${marketItem(r)}</td>` },
      { label: 'Qté', num: true, render: r => `<td class="num">${fmtQty(pick(r, ['quantity', 'qty'], null))}</td>` },
      { label: 'Conteneur', render: r => textCell(assetLocation(r, selectedPath)) },
      { label: 'Source', render: r => textCell(pick(r, ['acquisition_source', 'source'], '–')) },
      { label: 'Coût FIFO', num: true, render: r => moneyCell(pick(r, ['fifo_unit_cost_cents', 'unit_cost_cents', 'avg_cost_cents'], null)) },
      { label: 'Prix de valorisation', num: true, render: r => moneyCell(pick(r, ['market_unit_cents', 'market_price_cents', 'valuation_price_cents', 'market_median_cents'], null)) },
      { label: 'Référence', render: r => textCell(marketRef(r)) },
      { label: 'Valeur', num: true, render: r => moneyCell(r.inventory_value_cents) },
      { label: 'P&L latent', num: true, render: r => moneyCell(pick(r, ['unrealized_pnl_cents', 'latent_pnl_cents'], null)) },
      { label: 'Profit projeté', num: true, render: r => moneyCell(r.projected_profit_cents) },
      { label: 'Taxes / frais', num: true, render: r => moneyCell(pick(r, ['taxes_fees_cents', 'projected_fees_cents', 'fees_cents'], null)) },
      { label: 'Marge', num: true, render: r => { const value = pick(r, ['margin_bps', 'margin_bp'], null); return `<td class="num ${tone(value)}">${fmtBps(value)}</td>`; } },
      { label: 'Liquidité', num: true, render: r => `<td class="num">${fmtQty(pick(r, ['liquidity_volume_30d', 'volume_30d', 'daily_volume'], null))}</td>` },
      { label: 'État', render: r => textCell(pick(r, ['listing_state', 'status', 'action'], '–')) }
    ];
    const headings = {
      2: ['Emplacement / vente', 'Station ou conteneur sélectionné ; En vente si les quantités sont placées en ordre de vente.'],
      3: ['Origine d’achat', 'Origine des lots de coût : achat marché, contrat ou origine inconnue.'],
      4: ['Coût d’achat / u.', 'Coût unitaire moyen des lots FIFO restants, frais d’achat comptabilisés inclus. Les quantités sans coût connu ne sont pas inventées.'],
      5: ['Prix estimé / u.', 'Référence marché : médiane des prix moyens journaliers des 30 derniers relevés disponibles. Pas une moyenne BUY/SELL. À défaut : coût d’achat, signalé dans Base du prix.'],
      6: ['Base du prix', 'Source du prix estimé : historique régional, historique The Forge en secours, ou coût d’achat faute de données marché.'],
      7: ['Valeur totale brute', 'Quantités en vente valorisées à vos prix listés ; stock non listé valorisé au prix estimé. Total avant frais, pas un prix unitaire ni une vente garantie.'],
      8: ['Gain latent brut', 'Valeur totale brute moins coût d’acquisition FIFO connu. Les frais futurs de vente ne sont pas déduits.'],
      9: ['Gain net estimé', 'Scénario de vente de toute la quantité au prix estimé, moins frais de vente estimés et coût d’acquisition FIFO connu. Peut différer du gain aux prix actuellement listés.'],
      10: ['Frais de vente estimés', 'Frais et taxes estimés pour le scénario au prix estimé ; ce ne sont pas nécessairement les frais effectivement payés.'],
      11: ['Marge nette estimée', 'Gain net estimé rapporté au montant brut du scénario de vente au prix estimé.'],
      12: ['Volume moyen / jour', 'Volume journalier moyen sur les derniers relevés d’historique disponibles ; pas le volume de vos seuls ordres.']
    };
    for (const [index, [label, help]] of Object.entries(headings)) Object.assign(columns[index], {label, help});
    const values = [r => assetName(r), r => pick(r, ['quantity', 'qty'], null),
      r => assetLocation(r, selectedPath),
      r => pick(r, ['acquisition_source', 'source'], null),
      r => pick(r, ['fifo_unit_cost_cents', 'unit_cost_cents', 'avg_cost_cents'], null),
      r => pick(r, ['market_unit_cents', 'market_price_cents', 'valuation_price_cents', 'market_median_cents'], null), marketRef,
      r => r.inventory_value_cents, r => pick(r, ['unrealized_pnl_cents', 'latent_pnl_cents'], null),
      r => r.projected_profit_cents, r => pick(r, ['taxes_fees_cents', 'projected_fees_cents', 'fees_cents'], null),
      r => pick(r, ['margin_bps', 'margin_bp'], null), r => pick(r, ['liquidity_volume_30d', 'volume_30d', 'daily_volume'], null),
      r => pick(r, ['listing_state', 'status', 'action'], null)];
    const rows = visibleAssetRows(data).filter(r => MmdListTools.matches([assetName(r), r.type_id, assetLocation(r, selectedPath), r.acquisition_source, r.listing_state], T.assetSearch));
    const sorted = MmdListTools.sorted(rows, values[T.assetSort], columns[T.assetSort].num, T.assetSortDir);
    return shell('Assets', table(sorted, columns, T.assetSearch ? 'Aucun résultat pour cette recherche.' : (data.complete ? 'Aucun stock détenu pour cette sélection.' : 'Assets indisponibles ou synchronisation incomplète.'), true),
      `<select id="trade-container-filter" class="trade-select" aria-label="Conteneur d’assets"></select><input id="asset-search" class="trade-select" type="search" aria-label="Rechercher les assets" placeholder="Rechercher les assets…" value="${esc(T.assetSearch)}" />`);
  }
  function transactions(data) {
    const columns = [
      { label: 'Date', render: r => textCell(pick(r, ['date', 'occurred_at'], '–')) },
      { label: 'Sens', render: r => textCell(pick(r, ['side', 'direction'], '–')) },
      { label: 'Item', render: r => textCell(assetName(r), 'item') },
      { label: 'Qté', num: true, render: r => `<td class="num">${fmtQty(pick(r, ['quantity', 'qty'], null))}</td>` },
      { label: 'Prix unitaire', num: true, render: r => moneyCell(r.unit_price_cents) },
      { label: 'Taxes / frais', num: true, render: r => moneyCell(pick(r, ['tax_fee_cents', 'fees_cents', 'tax_cents'], null)) },
      { label: 'Statut frais', render: r => textCell(pick(r, ['fee_status'], 'indisponible')) },
      { label: 'Valeur', num: true, render: r => moneyCell(pick(r, ['value_cents', 'total_cents'], null)) },
      { label: 'Coût FIFO', num: true, render: r => moneyCell(r.fifo_cost_cents) },
      { label: 'P&L réalisé', num: true, render: r => moneyCell(r.realized_pnl_cents) },
      { label: 'Owner', render: r => textCell(pick(r, ['owner_name', 'owner'], '–')) },
      { label: 'Station', render: r => textCell(pick(r, ['station_name', 'station'], '–')) }
    ];
    return shell('Transactions', table(data.transactions, columns, data.complete ? 'Aucune transaction pour cette source.' : 'Transactions jamais synchronisées ou temporairement indisponibles.'));
  }
  function alertTone(row) {
    const level = String(pick(row, ['severity', 'level'], '')).toLowerCase();
    return /critical|high|danger|error/.test(level) ? 'bad' : (/warn|medium|risk/.test(level) ? 'warn' : 'good');
  }
  function alerts(data) {
    const known = Array.isArray(data.alerts), rows = known ? data.alerts : [];
    const cards = rows.length ? `<div class="trade-alerts">${rows.map(row => { const cls = alertTone(row); return `<article class="trade-alert ${cls}">` +
      `<div class="trade-alert-head"><span class="trade-chip ${cls}">${esc(pick(row, ['severity', 'level'], 'Info'))}</span><span class="trade-chip ${cls}">${esc(pick(row, ['action'], 'Voir'))}</span></div>` +
      `<div class="trade-alert-name">${marketItem(row)}</div><div class="trade-alert-message">${esc(pick(row, ['message', 'reason'], 'Aucun détail'))}</div>` +
      `<div class="trade-alert-impact ${tone(pick(row, ['impact_cents', 'value_cents'], null))}">Impact : ${fmtCents(pick(row, ['impact_cents', 'value_cents'], null))}</div></article>`; }).join('')}</div>` : `<div class="trade-empty">${known ? 'Aucune alerte active.' : 'Alertes indisponibles.'}</div>`;
    return shell('Alerts', cards);
  }

  function updateCounts(data) {
    [['tab-assets-c', Array.isArray(data.assets) ? visibleAssetRows(data) : null, 'assets'], ['tab-transactions-c', data.transactions, 'transactions'], ['tab-alerts-c', data.alerts, 'alerts']].forEach(([id, rows, source]) => { const node = el(id), known = source === 'alerts' ? Array.isArray(rows) : (data.complete || Boolean(data.availability?.[source]?.available)); if (node) node.textContent = known && Array.isArray(rows) ? rows.length : '–'; });
  }
  function render() {
    const root = el('trade-view'); if (!root || window.__state.workspace === 'orders') return;
    if (!T.workspace) { root.innerHTML = '<div class="trade-loading">Chargement des données trading…</div>'; return; }
    if (!T.workspace.ok) { root.innerHTML = `<div class="trade-error">${esc(T.workspace.error || 'Données trading indisponibles.')}<br><button class="btn small" onclick="TradingUI.refresh()">Réessayer</button></div>`; return; }
    const view = window.__state.workspace;
    root.innerHTML = view === 'dashboard' ? dashboard(T.workspace) : (view === 'assets' ? assets(T.workspace) : (view === 'transactions' ? transactions(T.workspace) : alerts(T.workspace)));
    root.querySelectorAll('[data-market-item]').forEach(button => {
      button.onclick = () => {
        const pilot = window.__selChar || T.workspace?.asset_source?.character_id || null;
        window.openItem?.(Number(button.dataset.marketItem), pilot);
      };
    });
    if (view === 'assets') {
      hydrateContainerFilter();
      el('asset-search').oninput = event => {
        const start = event.target.selectionStart, end = event.target.selectionEnd;
        T.assetSearch = event.target.value;
        render(); el('asset-search').focus();
        if (start != null) el('asset-search').setSelectionRange(start, end);
      };
      root.querySelectorAll('[data-asset-sort]').forEach(button => {
        button.onclick = () => {
          const column = Number(button.dataset.assetSort);
          T.assetSortDir = T.assetSort === column ? -T.assetSortDir : 1;
          T.assetSort = column; render();
        };
      });
    }
  }
  function layout(view) {
    const orders = view === 'orders'; window.__state.workspace = view;
    const metrics = el('orders-metrics'), grid = el('orders-grid'), trade = el('trade-view'), map = el('eve-map-workspace');
    if (metrics) metrics.hidden = !orders; if (grid) grid.hidden = !orders; if (trade) trade.hidden = orders;
    if (map) map.hidden = true;
    window.closeEveMap?.();
    document.querySelectorAll('#tabs .tab').forEach(tab => tab.classList.toggle('active', orders ? tab.dataset.tab === window.__state.tab : tab.dataset.workspace === view));
  }
  function show(view) { if (!VALID_VIEWS.has(view)) return false; layout(view); window.__state.selIndex = -1; render(); if (!T.settings) fetchSettings(false).then(render); if (!T.workspace || !T.workspace.ok) loadWorkspace(false); return true; }
  function showOrders() { layout('orders'); return true; }
  async function call(name, payload) { const bridge = api(); if (!bridge || typeof bridge[name] !== 'function') return undefined; return Promise.resolve(payload === undefined ? bridge[name]() : bridge[name](payload)); }
  function filters() { return { container_key: T.containerKey || null }; }
  function acceptWorkspace(data) { T.workspace = data || { ok: false, error: 'Réponse trading vide.' }; if (T.workspace.ok) updateCounts(T.workspace); render(); return T.workspace; }
  async function loadWorkspace(refresh) {
    const request = ++T.request; if (window.__state.workspace !== 'orders') { T.workspace = null; render(); }
    try {
      let data = await call(refresh ? 'refresh_trade_workspace' : 'get_trade_workspace', filters());
      if (refresh && data == null) data = await call('get_trade_workspace', filters());
      if (request !== T.request) return null;
      return acceptWorkspace(data === undefined ? { ok: false, error: 'API trading indisponible.' } : data);
    } catch (error) { if (request === T.request) acceptWorkspace({ ok: false, error: String(error) }); return null; }
  }
  async function fetchSettings(force) {
    if (T.settings && !force) return T.settings; const request = ++T.settingsRequest;
    try { const data = await call('get_trade_settings', !!force); if (request !== T.settingsRequest) return T.settings; T.settings = data || { ok: false, error: 'Réponse settings vide.' }; if (T.settings.ok && !T.containerKey) T.containerKey = selectedKey(T.settings.containers, T.settings.asset_source, ['character_id', 'item_id']); return T.settings; }
    catch (error) { if (request === T.settingsRequest) T.settings = { ok: false, error: String(error) }; return T.settings; }
  }
  function selectedKey(items, source, fields) {
    if (!source) return ''; const exact = (items || []).find(item => String(item.key) === String(source.key || source.container_key || source.division_key || '')); if (exact) return String(exact.key);
    const match = (items || []).find(item => fields.every(field => source[field] != null && String(item[field]) === String(source[field]))); return match ? String(match.key) : '';
  }
  function option(select, value, label, title) { const node = document.createElement('option'); node.value = value; node.textContent = label; node.title = title || label; select.appendChild(node); }
  function fillDivisionSelect(select, data) {
    option(select, '', 'Choisir une division…'); (data.divisions || []).forEach(row => option(select, String(row.key), `${row.corporation_name || `Corporation ${row.corporation_id}`} · ${row.name || row.label || 'Division'} · ID ${row.division_id}`, `Corporation ${row.corporation_id} · division ${row.division_id}`));
    select.value = selectedKey(data.divisions, data.wallet_source, ['corporation_id', 'division_id']);
  }
  function fillContainerSelect(select, data, placeholder) {
    option(select, '', placeholder || 'Choisir une station ou un conteneur…');
    const groups = new Map();
    (data.containers || []).forEach(row => {
      const key = `${row.character_id}:${row.root_location_id || 'unknown'}`;
      if (!groups.has(key)) {
        const group = document.createElement('optgroup');
        group.label = `${row.path?.[0] || 'Personnage'} · ${row.station_name || 'Lieu inconnu'}`;
        select.appendChild(group); groups.set(key, group);
      }
      const indent = '— '.repeat(Math.max(0, Number(row.depth) || 0));
      const label = row.kind === 'station' ? 'Toute la station (conteneurs inclus)' : `${indent}${row.name || 'Conteneur'} · ID ${row.item_id}`;
      option(groups.get(key), String(row.key), label, Array.isArray(row.path) ? row.path.join(' / ') : String(row.path || row.name || ''));
    });
    select.value = T.containerKey || selectedKey(data.containers, data.asset_source, ['character_id', 'item_id']); select.disabled = !(data.containers || []).length;
  }
  function hydrateContainerFilter() {
    const select = el('trade-container-filter'); if (!select) return; if (!T.settings || !T.settings.ok) { option(select, '', 'Configuration requise'); select.disabled = true; return; }
    fillContainerSelect(select, T.settings, 'Choisir un conteneur…'); select.onchange = () => { if (!select.value) return; T.containerKey = String(select.value); loadWorkspace(false); };
  }
  async function loadSettings(slot) {
    if (!slot) return; slot.innerHTML = '<div class="trade-settings-box trade-loading">Chargement des divisions et conteneurs…</div>';
    const data = await fetchSettings(true); if (!data || !data.ok) { slot.innerHTML = `<div class="trade-settings-box trade-error">${esc((data && data.error) || 'Settings trading indisponibles.')}</div>`; return; }
    const issueText = (data.errors || []).map(row => pick(row && row.error ? row.error : row, ['message', 'error'], 'Découverte ESI partielle')).join(' · ');
    slot.innerHTML = (issueText ? `<div class="trade-sync-warning">${esc(issueText)}</div>` : '') + '<div class="trade-settings-box"><div class="trade-settings-title">Sources Asset / Transaction</div><div class="trade-settings-grid">' +
      '<label for="trade-division-select">Division wallet corporation</label><select id="trade-division-select" class="trade-select"></select>' +
      '<label for="trade-container-select">Assets personnels · station ou conteneur</label><select id="trade-container-select" class="trade-select"></select></div>' +
      '<div class="trade-settings-actions"><span id="trade-settings-status" class="trade-settings-status">Division requise; conteneur personnel optionnel. Sélections enregistrées par ID.</span><button id="trade-settings-save" class="btn primary">Sauver</button></div></div>';
    const division = el('trade-division-select'), container = el('trade-container-select'), save = el('trade-settings-save');
    fillDivisionSelect(division, data); fillContainerSelect(container, data); const validate = () => { save.disabled = !division.value; };
    division.onchange = validate; container.onchange = validate; save.onclick = () => saveSettings(); validate();
  }
  async function saveSettings() {
    const divisionSelect = el('trade-division-select'), containerSelect = el('trade-container-select'), status = el('trade-settings-status'), save = el('trade-settings-save');
    if (!divisionSelect || !containerSelect || !divisionSelect.value || !T.settings) return false;
    const division = (T.settings.divisions || []).find(row => String(row.key) === String(divisionSelect.value)); const container = (T.settings.containers || []).find(row => String(row.key) === String(containerSelect.value)); if (!division || (containerSelect.value && !container)) return false;
    const payload = { wallet_source: { key: String(division.key), corporation_id: asId(division.corporation_id), division_id: asId(division.division_id) }, asset_source: container ? { key: String(container.key), character_id: asId(container.character_id), item_id: asId(container.item_id) } : null };
    save.disabled = divisionSelect.disabled = containerSelect.disabled = true; status.textContent = 'Sauvegarde…';
    try { const result = await call('save_trade_settings', payload); if (result === undefined || (result && result.ok === false)) throw new Error((result && result.error) || 'Sauvegarde indisponible'); T.settings.wallet_source = payload.wallet_source; T.settings.asset_source = payload.asset_source; T.containerKey = payload.asset_source ? payload.asset_source.key : ''; status.textContent = 'Sources sauvegardées.'; await loadWorkspace(false); return true; }
    catch (error) { status.textContent = `Erreur : ${String(error)}`; return false; } finally { save.disabled = divisionSelect.disabled = false; containerSelect.disabled = !(T.settings.containers || []).length; }
  }
  async function init() { if (T.initialized) return; T.initialized = true; showOrders(); }

  window.TradingUI = { init, show, showOrders, refresh: () => loadWorkspace(true), loadSettings, saveSettings, acceptWorkspace, fmtCents };
  window.renderTradeWorkspace = acceptWorkspace;
  if (api()) init();
  else window.addEventListener('pywebviewready', init);
}());
