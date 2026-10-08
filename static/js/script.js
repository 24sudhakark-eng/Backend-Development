/* ==========================================================================
   StockFlow – dashboard behaviour
   Talks to the Flask REST API with the Fetch API and updates the page
   without reloading. Sections: config · state · helpers · API · rendering
   · dialogs · settings · navigation · init
   ========================================================================== */
(() => {
  'use strict';

  /* ------------------------------------------------------------------ */
  /* Configuration – edit these values to tune the front end            */
  /* ------------------------------------------------------------------ */
  const CONFIG = {
    // Used only until /api/settings answers. The live threshold is stored in
    // the database (Settings page) and used by the server for every status.
    defaultLowStockThreshold: 5,
    defaultCurrency: 'INR',
    searchDebounceMs: 250,
    toastDurationMs: 3800,
    dashboardAlertLimit: 5,
    maxQuantity: 1000000,
    maxPrice: 10000000,
  };

  const CURRENCY_LOCALES = { INR: 'en-IN', USD: 'en-US', EUR: 'en-IE', GBP: 'en-GB' };
  const CURRENCY_SYMBOLS = { INR: '₹', USD: '$', EUR: '€', GBP: '£' };

  const VIEWS = {
    dashboard: { title: 'Dashboard', desc: 'A live summary of your inventory.' },
    products: { title: 'Products', desc: 'Add, search, edit and remove products.' },
    alerts: { title: 'Stock Alerts', desc: 'Products that are running low or sold out.' },
    reports: { title: 'Reports', desc: 'Inventory totals and category breakdown.' },
    settings: { title: 'Settings', desc: 'Application name, stock threshold and admin profile.' },
  };

  const STATUS = {
    in_stock: { label: 'In stock', tone: 'ok' },
    low_stock: { label: 'Low stock', tone: 'warn' },
    out_of_stock: { label: 'Out of stock', tone: 'danger' },
  };

  const PRODUCT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{1,19}$/;

  /* ------------------------------------------------------------------ */
  /* State                                                               */
  /* ------------------------------------------------------------------ */
  const state = {
    view: 'dashboard',
    products: [],
    productsStatus: 'loading', // loading | ready | error
    productsError: '',
    stats: null,
    alerts: [],
    settings: {
      app_name: 'StockFlow',
      low_stock_threshold: CONFIG.defaultLowStockThreshold,
      currency: CONFIG.defaultCurrency,
      admin_name: 'Admin',
      admin_email: '',
    },
    filters: { q: '', category: '', status: '' },
    sort: { by: 'product_id', order: 'asc' },
    editingId: null,
    deletingProduct: null,
    highlightId: null,
    productsRequest: null, // AbortController of the in-flight list request
    charts: { stock: null, category: null },
  };

  /* ------------------------------------------------------------------ */
  /* DOM helpers                                                         */
  /* ------------------------------------------------------------------ */
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

  const els = {
    app: $('#app'),
    menuBtn: $('#menuBtn'),
    scrim: $('#scrim'),
    pageTitle: $('#pageTitle'),
    pageDesc: $('#pageDesc'),
    brandName: $('#brandName'),
    avatar: $('#avatar'),
    profileName: $('#profileName'),
    search: $('#globalSearch'),
    bellBtn: $('#bellBtn'),
    bellCount: $('#bellCount'),
    navAlertCount: $('#navAlertCount'),
    addBtn: $('#addBtn'),
    stats: $('#stats'),
    statProducts: $('#statProducts'),
    statUnits: $('#statUnits'),
    statValue: $('#statValue'),
    statLow: $('#statLow'),
    statLowNote: $('#statLowNote'),
    lowStatCard: $('#lowStatCard'),
    stockChartBox: $('#stockChartBox'),
    stockChartNote: $('#stockChartNote'),
    chartTotal: $('#chartTotal'),
    stockLegend: $('#stockLegend'),
    alertsSummary: $('#alertsSummary'),
    dashAlerts: $('#dashAlerts'),
    alertsPageSummary: $('#alertsPageSummary'),
    alertsList: $('#alertsList'),
    filterCategory: $('#filterCategory'),
    filterStatus: $('#filterStatus'),
    clearFilters: $('#clearFilters'),
    resultCount: $('#resultCount'),
    productsBody: $('#productsBody'),
    productsState: $('#productsState'),
    productsTable: $('#productsTable'),
    repValue: $('#repValue'),
    repProducts: $('#repProducts'),
    repLow: $('#repLow'),
    repOut: $('#repOut'),
    categoryBody: $('#categoryBody'),
    categoryChartBox: $('#categoryChartBox'),
    categoryChartNote: $('#categoryChartNote'),
    settingsForm: $('#settingsForm'),
    saveSettings: $('#saveSettings'),
    productDialog: $('#productDialog'),
    productForm: $('#productForm'),
    productDialogTitle: $('#productDialogTitle'),
    productSubmit: $('#productSubmit'),
    productFormError: $('#productFormError'),
    productFormErrorText: $('#productFormErrorText'),
    categoryList: $('#categoryList'),
    deleteDialog: $('#deleteDialog'),
    deleteTarget: $('#deleteTarget'),
    confirmDelete: $('#confirmDelete'),
    toasts: $('#toasts'),
  };

  const icon = (name) => `<svg class="icon" aria-hidden="true"><use href="#i-${name}"/></svg>`;

  /** Escape text before putting it into an innerHTML template. */
  const esc = (value) =>
    String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

  const debounce = (fn, wait) => {
    let timer;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), wait);
    };
  };

  const locale = () => CURRENCY_LOCALES[state.settings.currency] || 'en-US';
  const formatNumber = (value) => new Intl.NumberFormat(locale()).format(value ?? 0);
  const formatMoney = (value, digits = 2) =>
    new Intl.NumberFormat(locale(), {
      style: 'currency',
      currency: state.settings.currency,
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(value ?? 0);
  const units = (n) => `${formatNumber(n)} ${n === 1 ? 'unit' : 'units'}`;
  const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

  /* ------------------------------------------------------------------ */
  /* API (Fetch)                                                         */
  /* ------------------------------------------------------------------ */
  class ApiError extends Error {
    constructor(message, status = 0, fields = {}) {
      super(message);
      this.status = status;
      this.fields = fields;
    }
  }

  async function api(path, { method = 'GET', body, signal } = {}) {
    const options = { method, signal, credentials: 'same-origin', headers: { Accept: 'application/json' } };
    if (body !== undefined) {
      options.headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(body);
    }

    let response;
    try {
      response = await fetch(path, options);
    } catch (error) {
      if (error.name === 'AbortError') throw error;
      throw new ApiError('Cannot reach the server. Check that Flask is running.');
    }

    if (response.status === 401) {
      window.location.assign('/login'); // session expired
      throw new ApiError('Your session has expired.', 401);
    }

    const data = await response.json().catch(() => null);
    if (!response.ok) {
      throw new ApiError(data?.error || `Request failed (${response.status}).`, response.status, data?.fields || {});
    }
    return data;
  }

  /* ------------------------------------------------------------------ */
  /* Toasts                                                              */
  /* ------------------------------------------------------------------ */
  function toast(message, type = 'success') {
    const node = document.createElement('div');
    node.className = `toast toast-${type}`;
    node.innerHTML = `${icon(type === 'error' ? 'alert-circle' : 'check-circle')}
      <p class="toast-text">${esc(message)}</p>
      <button type="button" class="toast-close" aria-label="Dismiss notification">${icon('x')}</button>`;
    els.toasts.appendChild(node);

    const dismiss = () => {
      node.classList.add('is-leaving');
      node.addEventListener('animationend', () => node.remove(), { once: true });
      setTimeout(() => node.remove(), 400); // safety net if animations are disabled
    };
    node.querySelector('.toast-close').addEventListener('click', dismiss);
    setTimeout(dismiss, CONFIG.toastDurationMs);
  }

  /* ------------------------------------------------------------------ */
  /* Data loading                                                        */
  /* ------------------------------------------------------------------ */
  async function loadSettings() {
    const data = await api('/api/settings');
    state.settings = { ...state.settings, ...data };
    applySettings();
  }

  async function loadStats() {
    state.stats = await api('/api/stats');
    renderStats();
    renderStockOverview();
    renderReports();
    renderCategoryOptions();
  }

  async function loadAlerts() {
    const data = await api('/api/alerts');
    state.alerts = data.alerts;
    renderAlerts();
  }

  async function loadProducts({ showLoading = false } = {}) {
    state.productsRequest?.abort(); // a newer search replaces the older one
    const controller = new AbortController();
    state.productsRequest = controller;

    if (showLoading) {
      state.productsStatus = 'loading';
      renderProducts();
    }

    const params = new URLSearchParams({ sort: state.sort.by, order: state.sort.order });
    if (state.filters.q) params.set('q', state.filters.q);
    if (state.filters.category) params.set('category', state.filters.category);
    if (state.filters.status) params.set('status', state.filters.status);

    try {
      const data = await api(`/api/products?${params}`, { signal: controller.signal });
      state.products = data.products;
      state.productsStatus = 'ready';
    } catch (error) {
      if (error.name === 'AbortError') return;
      state.productsStatus = 'error';
      state.productsError = error.message;
    }
    renderProducts();
  }

  /** Re-fetch everything that depends on inventory data. */
  async function refreshAll() {
    const results = await Promise.allSettled([loadStats(), loadAlerts(), loadProducts()]);
    const failed = results.find((r) => r.status === 'rejected');
    if (failed) toast(failed.reason?.message || 'Could not refresh the dashboard.', 'error');
  }

  /* ------------------------------------------------------------------ */
  /* Rendering: statistics, overview, alerts                             */
  /* ------------------------------------------------------------------ */
  function setValue(el, text) {
    el.textContent = text;
    el.classList.remove('skeleton');
  }

  function renderStats() {
    const s = state.stats;
    if (!s) return;
    els.stats.classList.remove('is-loading');
    setValue(els.statProducts, formatNumber(s.total_products));
    setValue(els.statUnits, formatNumber(s.total_units));
    setValue(els.statValue, formatMoney(s.inventory_value, 0));
    setValue(els.statLow, formatNumber(s.low_stock));
    els.statLowNote.textContent =
      s.out_of_stock > 0
        ? `${formatNumber(s.out_of_stock)} more out of stock`
        : `Between 1 and ${s.threshold} units left`;
    els.lowStatCard.classList.toggle('has-alerts', s.low_stock > 0);
  }

  function renderStockOverview() {
    const s = state.stats;
    if (!s) return;

    const segments = [
      { key: 'in_stock', label: 'In Stock', value: s.in_stock, color: cssVar('--ok-fill') },
      { key: 'low_stock', label: 'Low Stock', value: s.low_stock, color: cssVar('--warn-fill') },
      { key: 'out_of_stock', label: 'Out of Stock', value: s.out_of_stock, color: cssVar('--danger-fill') },
    ];
    const total = s.total_products;

    els.chartTotal.textContent = formatNumber(total);
    els.stockLegend.innerHTML = segments
      .map((seg) => {
        const pct = total ? Math.round((seg.value / total) * 100) : 0;
        return `<li><span class="dot" style="background:${seg.color}"></span>
          <span class="l-label">${seg.label}</span>
          <span class="l-count">${formatNumber(seg.value)}</span>
          <span class="l-pct">${pct}%</span></li>`;
      })
      .join('');

    if (!window.Chart) {
      els.stockChartBox.classList.add('chart-unavailable');
      els.stockChartNote.hidden = false;
      return;
    }

    // With no products show a neutral ring instead of an empty canvas.
    const data = total ? segments.map((seg) => seg.value) : [1];
    const colors = total ? segments.map((seg) => seg.color) : [cssVar('--line')];

    if (state.charts.stock) {
      const chart = state.charts.stock;
      chart.data.labels = total ? segments.map((seg) => seg.label) : ['No products'];
      chart.data.datasets[0].data = data;
      chart.data.datasets[0].backgroundColor = colors;
      chart.update();
      return;
    }

    state.charts.stock = new window.Chart($('#stockChart'), {
      type: 'doughnut',
      data: {
        labels: total ? segments.map((seg) => seg.label) : ['No products'],
        datasets: [{ data, backgroundColor: colors, borderColor: '#ffffff', borderWidth: 3, hoverOffset: 4 }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: '70%',
        plugins: { legend: { display: false } },
        animation: { duration: 500 },
      },
    });
  }

  function alertItem(product, { withRestock = true } = {}) {
    const meta = STATUS[product.status];
    const remaining =
      product.quantity === 0 ? '0 units remaining' : `${units(product.quantity)} remaining`;
    return `<li class="alert-item ${meta.tone}" data-id="${product.id}">
      <div class="alert-main">
        <p class="alert-name">${esc(product.name)}<small>${esc(product.product_id)}</small></p>
        <p class="alert-units">${remaining}</p>
      </div>
      <span class="badge badge-${meta.tone}">${meta.label}</span>
      ${withRestock ? `<button type="button" class="btn btn-secondary btn-sm" data-action="restock" data-id="${product.id}">Restock</button>` : ''}
    </li>`;
  }

  function alertsEmpty() {
    return `<li class="state state--ok">
      <span class="state-icon">${icon('check-circle')}</span>
      <h3>Everything is stocked</h3>
      <p>No product is at or below ${state.settings.low_stock_threshold} units right now.</p>
    </li>`;
  }

  function renderAlerts() {
    const alerts = state.alerts;
    const out = alerts.filter((a) => a.status === 'out_of_stock').length;
    const low = alerts.length - out;

    const summary = alerts.length
      ? `${formatNumber(low)} low stock, ${formatNumber(out)} out of stock`
      : 'All products are above the threshold';
    els.alertsSummary.textContent = summary;
    els.alertsPageSummary.textContent = alerts.length
      ? `${formatNumber(alerts.length)} ${alerts.length === 1 ? 'product needs' : 'products need'} attention (${summary.toLowerCase()})`
      : summary;

    // Dashboard panel: first few only
    const preview = alerts.slice(0, CONFIG.dashboardAlertLimit);
    els.dashAlerts.innerHTML = alerts.length
      ? preview.map((a) => alertItem(a)).join('') +
        (alerts.length > preview.length
          ? `<li class="alert-more">and ${alerts.length - preview.length} more on the Stock Alerts page</li>`
          : '')
      : alertsEmpty();

    // Full page
    els.alertsList.innerHTML = alerts.length ? alerts.map((a) => alertItem(a)).join('') : alertsEmpty();

    // Counters in the sidebar and the bell
    const count = alerts.length;
    [els.navAlertCount, els.bellCount].forEach((badge) => {
      badge.hidden = count === 0;
      badge.textContent = count > 99 ? '99+' : String(count);
    });
    els.bellBtn.setAttribute('aria-label', count ? `Stock alerts: ${count} need attention` : 'Stock alerts');
  }

  /* ------------------------------------------------------------------ */
  /* Rendering: products table                                           */
  /* ------------------------------------------------------------------ */
  function filtersActive() {
    return Boolean(state.filters.q || state.filters.category || state.filters.status);
  }

  function productRow(p) {
    const meta = STATUS[p.status];
    const comfortable = Math.max(state.settings.low_stock_threshold * 4, 1);
    const fill = p.quantity === 0 ? 0 : Math.max(8, Math.min(100, (p.quantity / comfortable) * 100));
    const flash = p.id === state.highlightId ? ' class="flash"' : '';
    return `<tr data-id="${p.id}"${flash}>
      <td data-label="Product"><div class="cell-product"><span class="p-name">${esc(p.name)}</span><span class="p-id">${esc(p.product_id)}</span></div></td>
      <td data-label="Category">${esc(p.category)}</td>
      <td data-label="Stock"><div class="stock"><span class="stock-qty">${formatNumber(p.quantity)}</span><span class="meter" aria-hidden="true"><span class="${meta.tone}" style="width:${fill}%"></span></span></div></td>
      <td data-label="Price" class="num">${formatMoney(p.price)}</td>
      <td data-label="Status"><span class="badge badge-${meta.tone}">${meta.label}</span></td>
      <td data-label="Actions" class="actions">
        <button type="button" class="btn-icon" data-action="edit" data-id="${p.id}" aria-label="Edit ${esc(p.name)}" title="Edit">${icon('edit')}</button>
        <button type="button" class="btn-icon" data-action="delete" data-id="${p.id}" aria-label="Delete ${esc(p.name)}" title="Delete">${icon('trash')}</button>
      </td></tr>`;
  }

  function productsStateBlock({ tone = '', iconName, title, text, action = '' }) {
    return `<span class="state-icon">${icon(iconName)}</span><h3>${esc(title)}</h3><p>${esc(text)}</p>${action}`;
  }

  function renderProducts() {
    const body = els.productsBody;
    const stateBox = els.productsState;
    const table = els.productsTable;

    els.clearFilters.hidden = !filtersActive();
    updateSortHeaders();

    if (state.productsStatus === 'loading') {
      table.hidden = false;
      stateBox.hidden = true;
      body.innerHTML = Array.from({ length: 5 }, () =>
        `<tr class="skeleton-row">${'<td><span class="skeleton"></span></td>'.repeat(6)}</tr>`).join('');
      els.resultCount.textContent = 'Loading products…';
      return;
    }

    if (state.productsStatus === 'error') {
      table.hidden = true;
      stateBox.hidden = false;
      stateBox.className = 'state state--error';
      stateBox.innerHTML = productsStateBlock({
        iconName: 'alert-circle',
        title: 'Could not load products',
        text: state.productsError || 'Something went wrong while contacting the server.',
        action: '<button type="button" class="btn btn-primary" data-action="retry">Try again</button>',
      });
      els.resultCount.textContent = '';
      return;
    }

    const list = state.products;
    if (!list.length) {
      table.hidden = true;
      stateBox.hidden = false;
      stateBox.className = 'state';
      stateBox.innerHTML = filtersActive()
        ? productsStateBlock({
            iconName: 'search',
            title: 'No matching products',
            text: 'Nothing matches your search or filters. Check the spelling or try a different Product ID, name or category.',
            action: '<button type="button" class="btn btn-secondary" data-action="clear-filters">Clear search and filters</button>',
          })
        : productsStateBlock({
            iconName: 'inbox',
            title: 'No products yet',
            text: 'Add your first product to start tracking stock levels.',
            action: '<button type="button" class="btn btn-primary" data-action="add">Add Product</button>',
          });
      els.resultCount.textContent = filtersActive() ? '0 results' : '';
      return;
    }

    table.hidden = false;
    stateBox.hidden = true;
    body.innerHTML = list.map(productRow).join('');
    els.resultCount.textContent = filtersActive()
      ? `${formatNumber(list.length)} ${list.length === 1 ? 'result' : 'results'}`
      : `${formatNumber(list.length)} ${list.length === 1 ? 'product' : 'products'}`;
    state.highlightId = null;
  }

  function updateSortHeaders() {
    $$('th[data-col]', els.productsTable).forEach((th) => {
      const active = th.dataset.col === state.sort.by;
      th.setAttribute('aria-sort', active ? (state.sort.order === 'asc' ? 'ascending' : 'descending') : 'none');
    });
  }

  function renderCategoryOptions() {
    const categories = (state.stats?.categories || []).map((c) => c.category);
    const current = state.filters.category;
    els.filterCategory.innerHTML =
      '<option value="">All categories</option>' +
      categories.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
    // Keep the selection if it still exists, otherwise drop the filter.
    if (current && categories.some((c) => c.toLowerCase() === current.toLowerCase())) {
      els.filterCategory.value = categories.find((c) => c.toLowerCase() === current.toLowerCase());
    } else if (current) {
      state.filters.category = '';
    }
    els.categoryList.innerHTML = categories.map((c) => `<option value="${esc(c)}"></option>`).join('');
  }

  /* ------------------------------------------------------------------ */
  /* Rendering: reports                                                  */
  /* ------------------------------------------------------------------ */
  function renderReports() {
    const s = state.stats;
    if (!s) return;

    els.repValue.textContent = formatMoney(s.inventory_value, 2);
    els.repProducts.textContent = formatNumber(s.total_products);
    els.repLow.textContent = formatNumber(s.low_stock);
    els.repOut.textContent = formatNumber(s.out_of_stock);

    els.categoryBody.innerHTML = s.categories.length
      ? s.categories
          .map(
            (c) => `<tr>
              <td><div class="share"><span>${esc(c.category)}</span></div></td>
              <td class="num">${formatNumber(c.count)}</td>
              <td class="num">${formatNumber(c.units)}</td>
              <td class="num">${formatMoney(c.value, 2)}</td></tr>`
          )
          .join('')
      : '<tr><td colspan="4">No categories yet. Add a product to see the breakdown.</td></tr>';

    renderCategoryChart();
  }

  function renderCategoryChart() {
    const categories = state.stats.categories;
    if (!window.Chart) {
      els.categoryChartBox.classList.add('chart-unavailable');
      els.categoryChartNote.hidden = false;
      return;
    }

    const labels = categories.map((c) => c.category);
    const counts = categories.map((c) => c.count);
    els.categoryChartBox.style.height = `${Math.max(200, labels.length * 42 + 50)}px`;

    if (state.charts.category) {
      const chart = state.charts.category;
      chart.data.labels = labels;
      chart.data.datasets[0].data = counts;
      chart.update();
      return;
    }

    state.charts.category = new window.Chart($('#categoryChart'), {
      type: 'bar',
      data: {
        labels,
        datasets: [{
          label: 'Products',
          data: counts,
          backgroundColor: cssVar('--blue-600'),
          borderRadius: 6,
          maxBarThickness: 26,
        }],
      },
      options: {
        indexAxis: 'y',
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { beginAtZero: true, ticks: { precision: 0 }, grid: { color: cssVar('--line') } },
          y: { grid: { display: false } },
        },
      },
    });
  }

  /* ------------------------------------------------------------------ */
  /* Add / edit dialog                                                   */
  /* ------------------------------------------------------------------ */
  const productFields = {
    product_id: $('#fProductId'),
    name: $('#fName'),
    category: $('#fCategory'),
    quantity: $('#fQuantity'),
    price: $('#fPrice'),
  };

  function setFieldError(name, message) {
    const slot = document.getElementById(`err-${name}`);
    if (slot) slot.textContent = message || '';
    const input = productFields[name];
    if (input) input.setAttribute('aria-invalid', message ? 'true' : 'false');
  }

  function clearProductErrors() {
    Object.keys(productFields).forEach((name) => setFieldError(name, ''));
    els.productFormError.hidden = true;
  }

  function showFieldErrors(errors) {
    Object.entries(errors).forEach(([name, message]) => setFieldError(name, message));
    const first = Object.keys(errors).find((name) => productFields[name]);
    if (first) productFields[first].focus();
  }

  function openProductDialog(product = null, focusField = null) {
    state.editingId = product ? product.id : null;
    els.productForm.reset();
    clearProductErrors();

    const editing = Boolean(product);
    els.productDialogTitle.textContent = editing ? 'Edit Product' : 'Add Product';
    els.productSubmit.textContent = editing ? 'Save changes' : 'Add Product';

    productFields.product_id.value = product?.product_id ?? '';
    productFields.product_id.readOnly = editing; // the ID is fixed once created
    productFields.product_id.classList.toggle('is-readonly', editing);
    productFields.name.value = product?.name ?? '';
    productFields.category.value = product?.category ?? '';
    productFields.quantity.value = product?.quantity ?? '';
    productFields.price.value = product?.price ?? '';

    els.productDialog.showModal();
    (focusField ? productFields[focusField] : editing ? productFields.name : productFields.product_id).focus();
  }

  /** Mirrors the server rules so users get instant feedback. */
  function validateProduct(values, { isNew }) {
    const errors = {};

    if (isNew) {
      if (!values.product_id) errors.product_id = 'Product ID is required.';
      else if (!PRODUCT_ID_PATTERN.test(values.product_id))
        errors.product_id = 'Use 2–20 characters: letters, numbers, hyphen or underscore.';
    }

    if (!values.name) errors.name = 'Product name is required.';
    else if (values.name.length > 100) errors.name = 'Product name cannot be longer than 100 characters.';

    if (!values.category) errors.category = 'Category is required.';
    else if (values.category.length > 50) errors.category = 'Category cannot be longer than 50 characters.';

    if (values.quantity === '') errors.quantity = 'Quantity is required.';
    else {
      const qty = Number(values.quantity);
      if (!Number.isFinite(qty)) errors.quantity = 'Enter a valid number.';
      else if (qty < 0) errors.quantity = 'Quantity cannot be negative.';
      else if (!Number.isInteger(qty)) errors.quantity = 'Quantity must be a whole number.';
      else if (qty > CONFIG.maxQuantity) errors.quantity = `Quantity cannot exceed ${formatNumber(CONFIG.maxQuantity)}.`;
    }

    if (values.price === '') errors.price = 'Price is required.';
    else {
      const price = Number(values.price);
      if (!Number.isFinite(price)) errors.price = 'Enter a valid number.';
      else if (price < 0) errors.price = 'Price cannot be negative.';
      else if (!/^\d+(\.\d{1,2})?$/.test(String(values.price).trim())) errors.price = 'Price can have at most 2 decimal places.';
      else if (price > CONFIG.maxPrice) errors.price = `Price cannot exceed ${formatNumber(CONFIG.maxPrice)}.`;
    }
    return errors;
  }

  function readProductForm() {
    return {
      product_id: productFields.product_id.value.trim(),
      name: productFields.name.value.trim().replace(/\s+/g, ' '),
      category: productFields.category.value.trim().replace(/\s+/g, ' '),
      quantity: productFields.quantity.value.trim(),
      price: productFields.price.value.trim(),
    };
  }

  function setButtonLoading(button, loading) {
    button.classList.toggle('is-loading', loading);
    button.disabled = loading;
  }

  async function handleProductSubmit(event) {
    event.preventDefault();
    clearProductErrors();

    const isNew = state.editingId === null;
    const values = readProductForm();
    const errors = validateProduct(values, { isNew });
    if (Object.keys(errors).length) {
      showFieldErrors(errors);
      return;
    }

    const payload = {
      name: values.name,
      category: values.category,
      quantity: Number(values.quantity),
      price: Number(values.price),
    };

    setButtonLoading(els.productSubmit, true);
    try {
      const result = isNew
        ? await api('/api/products', { method: 'POST', body: { product_id: values.product_id, ...payload } })
        : await api(`/api/products/${state.editingId}`, { method: 'PUT', body: payload });

      els.productDialog.close();
      state.highlightId = result.product.id;
      if (isNew && filtersActive()) resetFilters({ reload: false }); // make sure the new row is visible
      toast(isNew ? `${result.product.name} was added.` : `${result.product.name} was updated.`);
      await refreshAll();
    } catch (error) {
      if (Object.keys(error.fields || {}).length) {
        showFieldErrors(error.fields);
      } else {
        els.productFormErrorText.textContent = error.message;
        els.productFormError.hidden = false;
      }
    } finally {
      setButtonLoading(els.productSubmit, false);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Delete dialog                                                       */
  /* ------------------------------------------------------------------ */
  function openDeleteDialog(product) {
    state.deletingProduct = product;
    els.deleteTarget.textContent = `${product.name} (${product.product_id})`;
    els.deleteDialog.showModal();
  }

  async function handleDelete() {
    const product = state.deletingProduct;
    if (!product) return;

    setButtonLoading(els.confirmDelete, true);
    try {
      await api(`/api/products/${product.id}`, { method: 'DELETE' });
      els.deleteDialog.close();
      toast(`${product.name} was deleted.`);
      await refreshAll();
    } catch (error) {
      els.deleteDialog.close();
      toast(error.message, 'error');
      if (error.status === 404) await refreshAll(); // already gone: resync the list
    } finally {
      setButtonLoading(els.confirmDelete, false);
      state.deletingProduct = null;
    }
  }

  /* ------------------------------------------------------------------ */
  /* Search and filters                                                  */
  /* ------------------------------------------------------------------ */
  function resetFilters({ reload = true } = {}) {
    state.filters = { q: '', category: '', status: '' };
    els.search.value = '';
    els.filterCategory.value = '';
    els.filterStatus.value = '';
    if (reload) loadProducts();
    else renderProducts();
  }

  const runSearch = debounce(() => {
    state.filters.q = els.search.value.trim();
    loadProducts();
  }, CONFIG.searchDebounceMs);

  function productById(id) {
    const numeric = Number(id);
    return state.products.find((p) => p.id === numeric) || state.alerts.find((p) => p.id === numeric);
  }

  /* ------------------------------------------------------------------ */
  /* Settings                                                            */
  /* ------------------------------------------------------------------ */
  const settingsFields = {
    app_name: $('#sApp'),
    currency: $('#sCurrency'),
    low_stock_threshold: $('#sThreshold'),
    admin_name: $('#sAdminName'),
  };

  function applySettings() {
    const s = state.settings;
    els.brandName.textContent = s.app_name;
    els.profileName.textContent = s.admin_name;
    els.avatar.textContent = (s.admin_name || 'A').trim().charAt(0).toUpperCase();
    document.title = `${VIEWS[state.view].title} – ${s.app_name}`;
    $$('[data-currency-symbol]').forEach((node) => { node.textContent = CURRENCY_SYMBOLS[s.currency] || s.currency; });

    settingsFields.app_name.value = s.app_name;
    settingsFields.currency.value = s.currency;
    settingsFields.low_stock_threshold.value = s.low_stock_threshold;
    settingsFields.admin_name.value = s.admin_name;
    $('#sAdminEmail').value = s.admin_email || '';
  }

  function setSettingsError(name, message) {
    const slot = document.getElementById(`err-${name}`);
    if (slot) slot.textContent = message || '';
    settingsFields[name]?.setAttribute('aria-invalid', message ? 'true' : 'false');
  }

  async function handleSettingsSubmit(event) {
    event.preventDefault();
    Object.keys(settingsFields).forEach((name) => setSettingsError(name, ''));

    const values = {
      app_name: settingsFields.app_name.value.trim(),
      currency: settingsFields.currency.value,
      low_stock_threshold: settingsFields.low_stock_threshold.value.trim(),
      admin_name: settingsFields.admin_name.value.trim(),
    };

    const errors = {};
    if (!values.app_name) errors.app_name = 'Application name is required.';
    if (!values.admin_name) errors.admin_name = 'Display name is required.';
    const threshold = Number(values.low_stock_threshold);
    if (values.low_stock_threshold === '' || !Number.isInteger(threshold) || threshold < 1 || threshold > 1000) {
      errors.low_stock_threshold = 'Enter a whole number between 1 and 1000.';
    }
    if (Object.keys(errors).length) {
      Object.entries(errors).forEach(([name, message]) => setSettingsError(name, message));
      settingsFields[Object.keys(errors)[0]].focus();
      return;
    }

    setButtonLoading(els.saveSettings, true);
    try {
      const data = await api('/api/settings', { method: 'PUT', body: { ...values, low_stock_threshold: threshold } });
      state.settings = { ...state.settings, ...data };
      applySettings();
      toast('Settings saved.');
      await refreshAll(); // statuses are recalculated with the new threshold
    } catch (error) {
      if (Object.keys(error.fields || {}).length) {
        Object.entries(error.fields).forEach(([name, message]) => setSettingsError(name, message));
      } else {
        toast(error.message, 'error');
      }
    } finally {
      setButtonLoading(els.saveSettings, false);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Navigation                                                          */
  /* ------------------------------------------------------------------ */
  function setMenu(open) {
    els.app.classList.toggle('nav-open', open);
    els.scrim.hidden = !open;
    els.menuBtn.setAttribute('aria-expanded', String(open));
  }

  function showView(name) {
    const view = VIEWS[name] ? name : 'dashboard';
    state.view = view;

    $$('.view').forEach((section) => { section.hidden = section.dataset.view !== view; });
    $$('[data-nav]').forEach((link) => {
      const active = link.dataset.nav === view;
      link.classList.toggle('is-active', active);
      if (active) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    });

    els.pageTitle.textContent = VIEWS[view].title;
    els.pageDesc.textContent = VIEWS[view].desc;
    document.title = `${VIEWS[view].title} – ${state.settings.app_name}`;
    setMenu(false);
    window.scrollTo(0, 0);

    // Charts drawn while hidden need a nudge to measure themselves.
    Object.values(state.charts).forEach((chart) => chart?.resize());
  }

  const currentHash = () => window.location.hash.replace('#', '');
  const goTo = (view) => {
    if (currentHash() === view) showView(view);
    else window.location.hash = view;
  };

  /* ------------------------------------------------------------------ */
  /* Event wiring                                                        */
  /* ------------------------------------------------------------------ */
  function bindEvents() {
    window.addEventListener('hashchange', () => showView(currentHash()));

    els.menuBtn.addEventListener('click', () => setMenu(!els.app.classList.contains('nav-open')));
    els.scrim.addEventListener('click', () => setMenu(false));
    els.bellBtn.addEventListener('click', () => goTo('alerts'));
    els.addBtn.addEventListener('click', () => openProductDialog());

    // Global search: jump to the Products view and query the API
    els.search.addEventListener('input', () => {
      if (state.view !== 'products') goTo('products');
      runSearch();
    });
    els.search.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && els.search.value) {
        els.search.value = '';
        state.filters.q = '';
        loadProducts();
      }
    });
    document.addEventListener('keydown', (event) => {
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '');
      if (event.key === '/' && !typing && !document.querySelector('dialog[open]')) {
        event.preventDefault();
        els.search.focus();
      }
      if (event.key === 'Escape') setMenu(false);
    });

    els.filterCategory.addEventListener('change', () => {
      state.filters.category = els.filterCategory.value;
      loadProducts();
    });
    els.filterStatus.addEventListener('change', () => {
      state.filters.status = els.filterStatus.value;
      loadProducts();
    });
    els.clearFilters.addEventListener('click', () => resetFilters());

    // Sorting
    els.productsTable.addEventListener('click', (event) => {
      const button = event.target.closest('.sort');
      if (!button) return;
      const column = button.dataset.sort;
      state.sort = {
        by: column,
        order: state.sort.by === column && state.sort.order === 'asc' ? 'desc' : 'asc',
      };
      loadProducts();
    });

    // One delegated listener handles every row / card action
    document.addEventListener('click', (event) => {
      const trigger = event.target.closest('[data-action]');
      if (!trigger) return;
      const { action, id } = trigger.dataset;

      if (action === 'edit') {
        const product = productById(id);
        if (product) openProductDialog(product);
      } else if (action === 'restock') {
        const product = productById(id);
        if (product) openProductDialog(product, 'quantity');
      } else if (action === 'delete') {
        const product = productById(id);
        if (product) openDeleteDialog(product);
      } else if (action === 'add') {
        openProductDialog();
      } else if (action === 'clear-filters') {
        resetFilters();
      } else if (action === 'retry') {
        loadProducts({ showLoading: true });
      }
    });

    // Dialogs: close buttons, click on backdrop
    $$('dialog').forEach((dialog) => {
      dialog.addEventListener('click', (event) => {
        if (event.target === dialog || event.target.closest('[data-close]')) dialog.close();
      });
    });

    els.productForm.addEventListener('submit', handleProductSubmit);
    Object.entries(productFields).forEach(([name, input]) =>
      input.addEventListener('input', () => setFieldError(name, '')));
    els.confirmDelete.addEventListener('click', handleDelete);
    els.settingsForm.addEventListener('submit', handleSettingsSubmit);
  }

  /* ------------------------------------------------------------------ */
  /* Init                                                                */
  /* ------------------------------------------------------------------ */
  async function init() {
    bindEvents();
    showView(currentHash());
    renderProducts(); // skeleton rows while data loads

    try {
      await loadSettings(); // currency and threshold first, so numbers format correctly
    } catch (error) {
      toast(error.message, 'error');
    }
    await refreshAll();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
