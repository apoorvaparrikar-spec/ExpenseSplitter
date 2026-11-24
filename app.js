/* Trip Splitter: state, storage, rendering and forms. Money math lives in money.js. */
(function () {
  'use strict';

  const M = window.Money;
  const KEY = 'tripsplit.v1';
  const CAT_ICON = { Food: '🍽️', Transport: '🚕', Fuel: '⛽', Stay: '🏨', Activities: '🎯', Other: '📦' };

  /* ---------- helpers ---------- */
  const $ = (sel, el) => (el || document).querySelector(sel);
  const esc = s => String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const uid = p => (p || 'id') + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const fmt = (minor, code) => M.formatMoney(minor, code || 'INR');
  function todayISO() {
    const d = new Date();
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  }
  function prettyDate(iso) {
    const d = new Date(iso + 'T00:00:00');
    if (isNaN(d)) return iso;
    return d.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  }
  function shortDate(iso) {
    const d = new Date(iso + 'T00:00:00');
    return isNaN(d) ? iso : d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
  }
  const currencyOptions = sel => Object.keys(M.CURRENCIES)
    .map(c => `<option value="${c}"${c === sel ? ' selected' : ''}>${c} ${esc(M.CURRENCIES[c].trim())}</option>`).join('');

  let toastTimer;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
  }

  /** Small modal with custom buttons. Resolves to the clicked button's value, or null. */
  function ask(title, bodyHTML, buttons) {
    return new Promise(resolve => {
      const d = $('#askDialog');
      let done = false;
      const finish = v => { if (!done) { done = true; resolve(v); } };
      $('#askTitle').textContent = title;
      $('#askBody').innerHTML = bodyHTML;
      const foot = $('#askButtons');
      foot.innerHTML = '';
      buttons.forEach(b => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn ' + (b.cls || '');
        btn.textContent = b.label;
        btn.addEventListener('click', () => { finish(b.value); d.close(); });
        foot.appendChild(btn);
      });
      d.addEventListener('close', () => finish(null), { once: true });
      d.showModal();
    });
  }

  /* ---------- state & storage ---------- */
  function emptyState() { return { version: 1, activeTripId: null, trips: [], rateCache: {} }; }

  function normalizeTrip(t) {
    if (!t || typeof t.name !== 'string' || !Array.isArray(t.people)) throw new Error('A trip is missing its name or people');
    const people = t.people.map(p => {
      if (!p || p.id == null || typeof p.name !== 'string') throw new Error(`Bad person in "${t.name}"`);
      return { id: String(p.id), name: p.name };
    });
    const ids = new Set(people.map(p => p.id));
    const isAmt = v => Number.isSafeInteger(v) && v > 0;

    const expenses = (t.expenses || []).map(e => {
      const label = `"${e && e.description}" in "${t.name}"`;
      if (!e || !isAmt(e.amountMinor)) throw new Error(`Bad amount for ${label}`);
      if (!ids.has(String(e.paidBy))) throw new Error(`Unknown payer for ${label}`);
      const shares = {};
      let sum = 0;
      for (const [k, v] of Object.entries(e.shares || {})) {
        if (!ids.has(k)) throw new Error(`Unknown person in split for ${label}`);
        if (!Number.isSafeInteger(v) || v < 0) throw new Error(`Bad split amount for ${label}`);
        if (v > 0 || e.splitMode !== 'exact') { shares[k] = v; sum += v; }
      }
      if (sum !== e.amountMinor) throw new Error(`Split doesn't add up for ${label}`);
      const currency = M.CURRENCIES[e.currency] ? e.currency : 'INR';
      const rate = currency === 'INR' ? 1 : Number(e.rateToINR);
      if (!(rate > 0)) throw new Error(`Missing exchange rate for ${label}`);
      const out = {
        id: String(e.id || uid('e')),
        description: String(e.description || ''),
        amountMinor: e.amountMinor, currency, rateToINR: rate,
        rateNote: e.rateNote ? String(e.rateNote) : '',
        date: /^\d{4}-\d{2}-\d{2}$/.test(e.date) ? e.date : todayISO(),
        category: M.CATEGORIES.includes(e.category) ? e.category : 'Other',
        paidBy: String(e.paidBy),
        splitMode: e.splitMode === 'exact' ? 'exact' : 'equal',
        shares, createdAt: Number(e.createdAt) || Date.now()
      };
      if (e.source === 'bill' || e.source === 'upi') out.source = e.source;
      if (e.ref) out.ref = String(e.ref);
      return out;
    });

    const settlements = (t.settlements || []).map(s => {
      if (!s || !isAmt(s.amountMinor) || !ids.has(String(s.from)) || !ids.has(String(s.to)))
        throw new Error(`Bad payment record in "${t.name}"`);
      return {
        id: String(s.id || uid('s')), from: String(s.from), to: String(s.to),
        amountMinor: s.amountMinor,
        date: /^\d{4}-\d{2}-\d{2}$/.test(s.date) ? s.date : todayISO(),
        createdAt: Number(s.createdAt) || Date.now()
      };
    });

    return {
      id: String(t.id || uid('t')), name: t.name,
      createdAt: Number(t.createdAt) || Date.now(),
      defaultCurrency: M.CURRENCIES[t.defaultCurrency] ? t.defaultCurrency : 'INR',
      people, expenses, settlements
    };
  }

  function normalizeState(o) {
    if (!o || !Array.isArray(o.trips)) throw new Error('No trips found in this file');
    const s = emptyState();
    s.trips = o.trips.map(normalizeTrip);
    if (o.rateCache && typeof o.rateCache === 'object') s.rateCache = o.rateCache;
    s.activeTripId = s.trips.some(t => t.id === o.activeTripId) ? o.activeTripId : (s.trips[0] ? s.trips[0].id : null);
    return s;
  }

  function persist(s) {
    try { localStorage.setItem(KEY, JSON.stringify(s || state)); }
    catch (e) { toast('⚠️ Could not save: storage is full or blocked'); }
  }

  function load() {
    let raw = null;
    try { raw = localStorage.getItem(KEY); } catch (e) { /* storage blocked */ }
    if (raw) {
      try { return normalizeState(JSON.parse(raw)); }
      catch (e) {
        // Keep the unreadable data aside instead of overwriting it.
        try { localStorage.setItem(KEY + '.corrupt.' + Date.now(), raw); } catch (_) { /* ignore */ }
        console.error('Saved data unreadable, starting fresh', e);
      }
    }
    // First run: start with the sample trip.
    const s = emptyState();
    const t = window.SampleTrip.create(uid);
    s.trips.push(t);
    s.activeTripId = t.id;
    persist(s);
    return s;
  }

  let state = load();
  const startTab = location.hash.slice(1);
  const ui = { tab: ['expenses', 'balances', 'trip'].includes(startTab) ? startTab : 'expenses', lastPayer: {} };

  const activeTrip = () => state.trips.find(t => t.id === state.activeTripId) || null;
  const personName = (trip, id) => (trip.people.find(p => p.id === id) || { name: '(removed)' }).name;
  function commit() { persist(); render(); }

  /* ---------- exchange rates ---------- */
  async function fetchJSON(url) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 8000);
    try {
      const res = await fetch(url, { signal: ctl.signal });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.json();
    } finally { clearTimeout(timer); }
  }

  /**
   * INR per 1 unit of `code` on `date`. Tries the historical ECB rate for that date
   * (Frankfurter), then the latest market rate (open.er-api.com) for currencies the
   * ECB doesn't publish. Historical results are cached for good.
   */
  async function fetchRate(code, date) {
    const today = todayISO();
    const d = !date || date > today ? today : date;
    const key = code + '|' + d;
    if (state.rateCache[key]) return state.rateCache[key];

    for (const host of ['https://api.frankfurter.dev/v1', 'https://api.frankfurter.app']) {
      try {
        const r = await fetchJSON(`${host}/${d}?from=${code}&to=INR`);
        if (r && r.rates && r.rates.INR > 0) {
          const out = { rate: r.rates.INR, note: `ECB reference rate for ${shortDate(r.date || d)}` };
          if (d < today) { state.rateCache[key] = out; persist(); }
          return out;
        }
      } catch (e) { /* try next */ }
    }
    const r = await fetchJSON(`https://open.er-api.com/v6/latest/${code}`);
    if (r && r.result === 'success' && r.rates && r.rates.INR > 0) {
      return {
        rate: r.rates.INR,
        note: d === today ? 'Today’s market rate' : `Latest rate (no historical rate for ${code} on ${shortDate(d)}; you can edit it)`
      };
    }
    throw new Error('No rate');
  }

  /* ---------- rendering ---------- */
  function render() {
    const trip = activeTrip();
    const sel = $('#tripSelect');
    sel.innerHTML = state.trips.length
      ? state.trips.map(t => `<option value="${esc(t.id)}"${t.id === state.activeTripId ? ' selected' : ''}>${esc(t.name)}</option>`).join('')
      : '<option value="">No trips yet</option>';
    sel.disabled = !state.trips.length;

    document.querySelectorAll('.tabbar button').forEach(b => {
      if (b.dataset.tab === ui.tab) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    });
    ['expenses', 'balances', 'trip'].forEach(v => { $('#view-' + v).hidden = v !== ui.tab; });
    $('#fab').hidden = $('#fabScan').hidden = !trip || ui.tab === 'trip';

    if (ui.tab === 'expenses') renderExpenses(trip);
    else if (ui.tab === 'balances') renderBalances(trip);
    else renderTrip(trip);
  }

  function noTripHTML() {
    return `<div class="card empty">
      <div class="big-ico">🧳</div>
      <h3>No trips yet</h3>
      <p class="muted">Create a trip, add the people, and start logging expenses.</p>
      <div class="btn-row wrap">
        <button type="button" class="btn primary" data-action="new-trip">Create a trip</button>
        <button type="button" class="btn" data-action="load-sample">Load sample trip</button>
        <button type="button" class="btn" data-action="import">Import backup</button>
      </div></div>`;
  }

  function renderExpenses(trip) {
    const view = $('#view-expenses');
    if (!trip) { view.innerHTML = noTripHTML(); return; }
    const sum = M.tripSummary(trip);
    const n = trip.people.length;
    let html = `<div class="card total-card">
      <div class="label">Total trip spend</div>
      <div class="big">${fmt(sum.totalINR)}</div>
      <div class="muted">${sum.count} expense${sum.count === 1 ? '' : 's'} · ${n} ${n === 1 ? 'person' : 'people'}</div>
    </div>`;

    if (!trip.expenses.length) {
      html += `<div class="card empty"><div class="big-ico">🧾</div>
        <p class="muted">No expenses yet. Tap <strong>+</strong> to add the first one.</p></div>`;
      view.innerHTML = html;
      return;
    }

    const sorted = trip.expenses.slice().sort((a, b) => (b.date.localeCompare(a.date)) || (b.createdAt - a.createdAt));
    let lastDate = null, open = false;
    sorted.forEach(e => {
      if (e.date !== lastDate) {
        if (open) html += '</ul></div>';
        html += `<h4 class="date-head">${esc(prettyDate(e.date))}</h4><div class="card"><ul class="list">`;
        open = true; lastDate = e.date;
      }
      const count = Object.keys(e.shares).length;
      const splitText = (e.splitMode === 'exact' ? 'exact split'
        : count === n ? 'split equally' : `split ${count} of ${n}`) +
        (e.source === 'upi' ? ' · UPI' : e.source === 'bill' ? ' · scanned' : '');
      const inr = M.expenseINR(e).total;
      const orig = e.currency !== 'INR' ? `<span class="orig">${esc(fmt(e.amountMinor, e.currency))}</span>` : '';
      html += `<li><button type="button" class="exp-item" data-action="edit-expense" data-id="${esc(e.id)}">
        <span class="cat-ico" aria-hidden="true">${CAT_ICON[e.category] || '📦'}</span>
        <span class="grow"><span class="title">${esc(e.description || e.category)}</span>
          <span class="sub" style="display:block">${esc(personName(trip, e.paidBy))} paid · ${splitText}</span></span>
        <span class="amt">${fmt(inr)}${orig}</span>
      </button></li>`;
    });
    if (open) html += '</ul></div>';
    view.innerHTML = html;
  }

  function renderBalances(trip) {
    const view = $('#view-balances');
    if (!trip) { view.innerHTML = noTripHTML(); return; }
    const led = M.computeLedger(trip);
    const bal = {};
    for (const id in led) bal[id] = led[id].balance;
    const transfers = M.settleUp(bal).sort((a, b) => b.amount - a.amount);
    const sum = M.tripSummary(trip);
    const name = id => esc(personName(trip, id));

    let html = `<div class="card total-card">
      <div class="label">Total trip spend</div>
      <div class="big">${fmt(sum.totalINR)}</div>
      <div class="muted">All amounts converted to ₹</div></div>`;

    html += `<div class="card"><h3>Settle up</h3>`;
    html += transfers.length
      ? `<ul class="list">${transfers.map(t => `<li class="row">
          <div class="grow"><span class="title">${name(t.from)}</span> pays <span class="title">${name(t.to)}</span></div>
          <div class="amt">${fmt(t.amount)}</div>
          <button type="button" class="btn small" data-action="mark-paid" data-from="${esc(t.from)}" data-to="${esc(t.to)}" data-amt="${t.amount}">Paid</button>
        </li>`).join('')}</ul>
        <p class="hint">${transfers.length} payment${transfers.length === 1 ? '' : 's'} clear${transfers.length === 1 ? 's' : ''} every balance. Tap <strong>Paid</strong> once a payment is made.</p>`
      : `<p class="empty-note">Everyone is settled up 🎉</p>`;
    html += `<div class="btn-row wrap">
        <button type="button" class="btn primary" data-action="copy-summary">📋 Copy summary</button>
        ${navigator.share ? '<button type="button" class="btn" data-action="share-summary">Share…</button>' : ''}
        <button type="button" class="btn" data-action="record-payment">Record a payment</button>
      </div></div>`;

    html += `<div class="card"><h3>Balances</h3><ul class="list">${trip.people.map(p => {
      const r = led[p.id];
      const cls = r.balance > 0 ? 'pos' : r.balance < 0 ? 'neg' : 'muted';
      const word = r.balance > 0 ? 'gets back' : r.balance < 0 ? 'owes' : 'settled';
      const extra = (r.sent ? ` · sent ${fmt(r.sent)}` : '') + (r.received ? ` · received ${fmt(r.received)}` : '');
      return `<li class="row"><div class="grow"><div class="title">${esc(p.name)}</div>
        <div class="sub">Paid ${fmt(r.paid)} · share ${fmt(r.share)}${extra}</div></div>
        <div class="amt ${cls}">${r.balance > 0 ? '+' : ''}${fmt(r.balance)}<span class="orig">${word}</span></div></li>`;
    }).join('')}</ul></div>`;

    html += `<div class="card"><h3>By category</h3>`;
    const cats = M.CATEGORIES.filter(c => sum.byCategory[c] > 0).sort((a, b) => sum.byCategory[b] - sum.byCategory[a]);
    html += cats.length ? cats.map(c => {
      const pct = sum.totalINR ? (sum.byCategory[c] / sum.totalINR) * 100 : 0;
      return `<div class="bar-row"><div class="top"><span>${CAT_ICON[c]} ${c}</span>
        <span class="amt">${fmt(sum.byCategory[c])} <span class="muted" style="font-weight:400">${pct.toFixed(0)}%</span></span></div>
        <div class="bar"><span style="width:${pct.toFixed(1)}%"></span></div></div>`;
    }).join('') : '<p class="empty-note">No expenses yet.</p>';
    html += `</div>`;

    if (trip.settlements.length) {
      const ss = trip.settlements.slice().sort((a, b) => b.date.localeCompare(a.date) || b.createdAt - a.createdAt);
      html += `<div class="card"><h3>Payments recorded</h3><ul class="list">${ss.map(s => `<li class="row">
        <div class="grow"><div class="title">${name(s.from)} → ${name(s.to)}</div><div class="sub">${esc(shortDate(s.date))}</div></div>
        <div class="amt">${fmt(s.amountMinor)}</div>
        <button type="button" class="x-btn" data-action="delete-settlement" data-id="${esc(s.id)}" aria-label="Delete payment">✕</button>
      </li>`).join('')}</ul></div>`;
    }
    view.innerHTML = html;
  }

  function personInUse(trip, id) {
    return trip.expenses.some(e => e.paidBy === id || id in e.shares) ||
      trip.settlements.some(s => s.from === id || s.to === id);
  }

  function renderTrip(trip) {
    const view = $('#view-trip');
    if (!trip) {
      view.innerHTML = noTripHTML() + `<p class="foot-link"><a href="tests.html">Run settle-up tests</a></p>`;
      return;
    }
    view.innerHTML = `
      <div class="card"><h3>Trip details</h3>
        <label class="field"><span>Name</span><input data-field="trip-name" value="${esc(trip.name)}" maxlength="60"></label>
        <label class="field" style="margin-bottom:0"><span>Default currency for new expenses</span>
          <select data-field="trip-currency">${currencyOptions(trip.defaultCurrency)}</select></label>
        <p class="hint">Each expense can use its own currency. Balances are always shown in ₹ using the rate from the expense's date.</p>
      </div>

      <div class="card"><h3>People</h3>
        <ul class="list">${trip.people.map(p => {
          const used = personInUse(trip, p.id);
          return `<li class="row person-row">
            <input data-field="person-name" data-id="${esc(p.id)}" value="${esc(p.name)}" aria-label="Name" maxlength="40">
            <button type="button" class="x-btn" data-action="remove-person" data-id="${esc(p.id)}"
              ${used ? 'disabled title="Part of an expense or payment"' : ''} aria-label="Remove ${esc(p.name)}">✕</button>
          </li>`;
        }).join('')}</ul>
        <div class="add-row">
          <input id="newPerson" placeholder="Add a person" maxlength="40" enterkeyhint="done" aria-label="New person name">
          <button type="button" class="btn" data-action="add-person">Add</button>
        </div>
        <p class="hint">You can only remove someone who isn't part of any expense or payment.</p>
      </div>

      <div class="card"><h3>Backup &amp; move</h3>
        <p class="hint" style="margin-top:0">Export saves every trip to a JSON file. Import it on another phone or browser.</p>
        <div class="btn-row wrap">
          <button type="button" class="btn" data-action="export">⬇️ Export</button>
          <button type="button" class="btn" data-action="import">⬆️ Import</button>
          <button type="button" class="btn" data-action="load-sample">Load sample trip</button>
        </div>
      </div>

      <div class="card"><h3>Delete trip</h3>
        <p class="hint" style="margin-top:0">Once everything is squared off you can delete this trip. This can't be undone, so export first if you want a record.</p>
        <button type="button" class="btn danger-outline" data-action="delete-trip">Delete “${esc(trip.name)}”</button>
      </div>
      <p class="foot-link"><a href="tests.html">Run settle-up tests</a></p>`;
  }

  /* ---------- expense dialog ---------- */
  const expDlg = $('#expenseDialog');
  const ef = $('#expenseForm');
  let draft = null;

  ef.currency.innerHTML = currencyOptions('INR');

  function openExpense(exp, opts) {
    const trip = activeTrip();
    if (!trip) return;
    if (!trip.people.length) { toast('Add people to the trip first'); ui.tab = 'trip'; render(); return; }
    draft = {
      id: exp ? exp.id : null,
      mode: exp ? exp.splitMode : 'equal',
      checked: new Set(exp ? Object.keys(exp.shares) : trip.people.map(p => p.id)),
      exact: {},
      rateNote: exp ? exp.rateNote : '',
      source: exp ? exp.source : undefined,
      ref: exp ? exp.ref : undefined,
      req: 0
    };
    resetScanPanel();
    if (exp && exp.splitMode === 'exact') for (const id in exp.shares) draft.exact[id] = M.minorToInput(exp.shares[id]);

    $('#expTitle').textContent = exp ? 'Edit expense' : 'Add expense';
    ef.description.value = exp ? exp.description : '';
    ef.amount.value = exp ? M.minorToInput(exp.amountMinor) : '';
    ef.currency.value = exp ? exp.currency : trip.defaultCurrency;
    ef.rate.value = exp && exp.currency !== 'INR' ? String(exp.rateToINR) : '';
    ef.date.value = exp ? exp.date : todayISO();
    ef.paidBy.innerHTML = trip.people.map(p => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');
    const payer = exp ? exp.paidBy : ui.lastPayer[trip.id];
    ef.paidBy.value = trip.people.some(p => p.id === payer) ? payer : trip.people[0].id;
    ef.querySelectorAll('input[name="category"]').forEach(r => { r.checked = r.value === (exp ? exp.category : 'Food'); });
    ef.querySelectorAll('input[name="split"]').forEach(r => { r.checked = r.value === draft.mode; });
    $('#expDelete').hidden = !exp;

    renderSplitRows();
    updateRateUI();
    if (!exp && ef.currency.value !== 'INR') lookupRate();
    expDlg.showModal();
    if (!exp && !(opts && opts.forScan)) setTimeout(() => ef.description.focus(), 50);
  }

  function renderSplitRows() {
    const trip = activeTrip();
    const cur = ef.currency.value;
    const amt = M.parseMinor(ef.amount.value);
    const box = $('#splitRows');
    $('#splitTools').hidden = draft.mode !== 'equal';
    if (draft.mode === 'equal') {
      const ids = trip.people.filter(p => draft.checked.has(p.id)).map(p => p.id);
      const shares = amt > 0 && ids.length ? M.splitEqual(amt, ids) : {};
      box.innerHTML = trip.people.map(p => `<label class="split-row">
        <input type="checkbox" data-pid="${esc(p.id)}"${draft.checked.has(p.id) ? ' checked' : ''}>
        <span class="name">${esc(p.name)}</span>
        <span class="share">${shares[p.id] != null ? fmt(shares[p.id], cur) : '—'}</span></label>`).join('');
    } else {
      const sym = esc(M.symbolFor(cur).trim());
      box.innerHTML = trip.people.map(p => `<label class="split-row">
        <span class="name">${esc(p.name)}</span><span class="cur">${sym}</span>
        <input class="exact-input" inputmode="decimal" placeholder="0.00" data-pid="${esc(p.id)}" value="${esc(draft.exact[p.id] || '')}" aria-label="${esc(p.name)} owes"></label>`).join('');
    }
    updateValidity();
  }

  /** Validate the form. Returns { ok, msg, shares, amt }. */
  function computeDraft() {
    const trip = activeTrip();
    const cur = ef.currency.value;
    const amt = M.parseMinor(ef.amount.value);
    if (!(amt > 0)) return { ok: false, msg: ef.amount.value.trim() ? 'Amount doesn’t look right' : 'Enter an amount' };
    let shares = {}, msg;
    if (draft.mode === 'equal') {
      const ids = trip.people.filter(p => draft.checked.has(p.id)).map(p => p.id);
      if (!ids.length) return { ok: false, msg: 'Tick at least one person' };
      shares = M.splitEqual(amt, ids);
      msg = ids.length === 1 ? 'Charged to one person' : `Split equally between ${ids.length}`;
    } else {
      let sum = 0;
      for (const p of trip.people) {
        const raw = (draft.exact[p.id] || '').trim();
        if (!raw) continue;
        const v = M.parseMinor(raw);
        if (isNaN(v)) return { ok: false, msg: `Amount for ${p.name} doesn’t look right` };
        if (v > 0) { shares[p.id] = v; sum += v; }
      }
      const left = amt - sum;
      if (left > 0) return { ok: false, msg: `${fmt(left, cur)} left to assign` };
      if (left < 0) return { ok: false, msg: `${fmt(-left, cur)} over the total` };
      msg = 'Adds up exactly ✓';
    }
    if (cur !== 'INR' && !(Number(ef.rate.value) > 0)) return { ok: false, msg: 'Enter the exchange rate' };
    if (!ef.description.value.trim()) return { ok: false, msg: 'Add a description' };
    if (!ef.category.value) return { ok: false, msg: 'Pick a category' };
    return { ok: true, msg, shares, amt };
  }

  function updateValidity() {
    const r = computeDraft();
    const st = $('#splitStatus');
    st.textContent = r.msg;
    st.className = 'status ' + (r.ok ? 'good' : 'bad');
    $('#expSave').disabled = !r.ok;
    updateRateUI();
    return r;
  }

  function updateRateUI() {
    const cur = ef.currency.value;
    $('#rateBox').hidden = cur === 'INR';
    if (cur === 'INR') return;
    $('#rateLabel').textContent = `1 ${cur} = ? ₹ (rate on the expense date)`;
    $('#rateNote').textContent = draft.rateNote || '';
    const amt = M.parseMinor(ef.amount.value), rate = Number(ef.rate.value);
    $('#inrPreview').textContent = amt > 0 && rate > 0 ? `≈ ${fmt(M.toINRMinor(amt, cur, rate))}` : '';
  }

  async function lookupRate() {
    const cur = ef.currency.value;
    if (cur === 'INR') return;
    const token = ++draft.req;
    draft.rateNote = 'Fetching rate…';
    updateRateUI();
    try {
      const r = await fetchRate(cur, ef.date.value);
      if (token !== draft.req) return;
      ef.rate.value = String(Math.round(r.rate * 10000) / 10000);
      draft.rateNote = r.note;
    } catch (e) {
      if (token !== draft.req) return;
      draft.rateNote = 'Couldn’t fetch the rate (offline?). Type it in.';
    }
    updateValidity();
  }

  ef.addEventListener('input', e => {
    const t = e.target;
    if (t.matches('.exact-input')) { draft.exact[t.dataset.pid] = t.value; updateValidity(); }
    else if (t.name === 'amount') {
      if (draft.mode === 'equal') renderSplitRows(); else updateValidity();
    } else if (t.name === 'rate') { draft.req++; draft.rateNote = 'Entered by you'; updateValidity(); }
    else if (t.name === 'description') updateValidity();
  });

  ef.addEventListener('change', e => {
    const t = e.target;
    if (t.matches('input[type="checkbox"][data-pid]')) {
      if (t.checked) draft.checked.add(t.dataset.pid); else draft.checked.delete(t.dataset.pid);
      renderSplitRows();
    } else if (t.name === 'split') {
      draft.mode = t.value;
      if (draft.mode === 'exact' && !Object.values(draft.exact).some(v => v && v.trim())) {
        // Prefill exact amounts from the current equal split
        const trip = activeTrip();
        const amt = M.parseMinor(ef.amount.value);
        const ids = trip.people.filter(p => draft.checked.has(p.id)).map(p => p.id);
        if (amt > 0 && ids.length) {
          const sh = M.splitEqual(amt, ids);
          for (const id in sh) draft.exact[id] = M.minorToInput(sh[id]);
        }
      }
      renderSplitRows();
    } else if (t.name === 'currency') {
      ef.rate.value = '';
      draft.rateNote = '';
      renderSplitRows();
      lookupRate();
    } else if (t.name === 'date') {
      if (ef.currency.value !== 'INR') lookupRate();
    } else if (t.name === 'category') {
      $('#catHint').hidden = true;
      t.closest('fieldset').classList.remove('need-pick');
      updateValidity();
    } else if (t.name === 'paidBy') updateValidity();
  });

  $('#selAll').addEventListener('click', () => { activeTrip().people.forEach(p => draft.checked.add(p.id)); renderSplitRows(); });
  $('#selNone').addEventListener('click', () => { draft.checked.clear(); renderSplitRows(); });
  $('#rateRefresh').addEventListener('click', () => {
    const cur = ef.currency.value, d = ef.date.value;
    delete state.rateCache[cur + '|' + d];
    lookupRate();
  });

  ef.addEventListener('submit', e => {
    e.preventDefault();
    const r = updateValidity();
    if (!r.ok) return;
    const trip = activeTrip();
    const cur = ef.currency.value;
    const old = draft.id ? trip.expenses.find(x => x.id === draft.id) : null;
    const exp = {
      id: draft.id || uid('e'),
      description: ef.description.value.trim(),
      amountMinor: r.amt,
      currency: cur,
      rateToINR: cur === 'INR' ? 1 : Number(ef.rate.value),
      rateNote: cur === 'INR' ? '' : (draft.rateNote === 'Fetching rate…' ? '' : draft.rateNote),
      date: ef.date.value || todayISO(),
      category: ef.category.value || 'Other',
      paidBy: ef.paidBy.value,
      splitMode: draft.mode,
      shares: r.shares,
      createdAt: old ? old.createdAt : Date.now()
    };
    if (draft.source) exp.source = draft.source;
    if (draft.ref) exp.ref = draft.ref;
    if (old) trip.expenses[trip.expenses.indexOf(old)] = exp; else trip.expenses.push(exp);
    ui.lastPayer[trip.id] = exp.paidBy;
    expDlg.close();
    commit();
    toast(old ? 'Expense updated' : 'Expense added');
  });

  $('#expDelete').addEventListener('click', async () => {
    const trip = activeTrip();
    const exp = trip.expenses.find(x => x.id === draft.id);
    if (!exp) return;
    const ok = await ask('Delete expense?', `<p>“${esc(exp.description)}”, ${esc(fmt(exp.amountMinor, exp.currency))}</p>`,
      [{ label: 'Cancel', value: false }, { label: 'Delete', value: true, cls: 'danger' }]);
    if (!ok) return;
    trip.expenses = trip.expenses.filter(x => x.id !== exp.id);
    expDlg.close();
    commit();
    toast('Expense deleted');
  });

  /* ---------- scanning bills & UPI screenshots ---------- */
  // Text recognition runs on the phone with Tesseract.js. It's downloaded from a CDN on the
  // first scan (a few MB) and cached by the browser after that. Images never leave the device.
  const TESSERACT_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
  let ocrWorker = null, ocrLog = () => {}, scanToken = 0, scanUrl = null;

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = () => reject(new Error('Could not load ' + src));
      document.head.appendChild(s);
    });
  }

  function getOcr() {
    if (!ocrWorker) {
      ocrWorker = (async () => {
        if (!window.Tesseract) await loadScript(TESSERACT_URL);
        return window.Tesseract.createWorker('eng', 1, { logger: m => ocrLog(m) });
      })();
      ocrWorker.catch(() => { ocrWorker = null; }); // allow a retry after a failed download
    }
    return ocrWorker;
  }

  function loadImage(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => resolve({ img, url });
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Not an image')); };
      img.src = url;
    });
  }

  /** Resize to a size OCR handles well, make it greyscale, and invert dark-mode screenshots. */
  function toOcrCanvas(img) {
    const long = Math.max(img.naturalWidth, img.naturalHeight);
    const scale = long > 2200 ? 2200 / long : long < 1200 ? 1600 / long : 1;
    const w = Math.round(img.naturalWidth * scale), h = Math.round(img.naturalHeight * scale);
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    const d = ctx.getImageData(0, 0, w, h), px = d.data;
    let total = 0;
    for (let i = 0; i < px.length; i += 4) {
      const g = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
      px[i] = px[i + 1] = px[i + 2] = g;
      total += g;
    }
    if (total / (px.length / 4) < 110) { // mostly dark: light text on a dark background
      for (let i = 0; i < px.length; i += 4) px[i] = px[i + 1] = px[i + 2] = 255 - px[i];
    }
    ctx.putImageData(d, 0, 0);
    return c;
  }

  function setScan(msg, progress, bad) {
    const m = $('#scanMsg');
    m.textContent = msg;
    m.className = 'scan-msg' + (bad ? ' bad' : '');
    const bar = $('#scanProg');
    bar.hidden = progress == null;
    if (progress != null) bar.firstElementChild.style.width = Math.round(progress * 100) + '%';
  }

  function resetScanPanel() {
    scanToken++;
    $('#scanPanel').hidden = true;
    $('#scanPanel').classList.remove('big');
    $('#catHint').hidden = true;
    $('#catHint').closest('fieldset').classList.remove('need-pick');
    if (scanUrl) { URL.revokeObjectURL(scanUrl); scanUrl = null; }
    $('#scanImg').removeAttribute('src');
  }

  async function scanImage(file) {
    if (!activeTrip()) { toast('Create a trip first'); return; }
    if (!file || (file.type && !/^image\//.test(file.type))) { toast('That isn’t an image'); return; }
    if (!expDlg.open) openExpense(null, { forScan: true });
    if (!expDlg.open || !draft) return;
    resetScanPanel();
    const token = scanToken;
    $('#scanPanel').hidden = false;
    $('#scanFound').innerHTML = '';
    $('#scanAsPayment').hidden = true;
    $('#scanTextBox').hidden = true;
    setScan('Preparing image…', 0);

    let loaded;
    try { loaded = await loadImage(file); }
    catch (e) { setScan('Couldn’t open this image.', null, true); return; }
    if (token !== scanToken) { URL.revokeObjectURL(loaded.url); return; }
    scanUrl = loaded.url;
    $('#scanImg').src = loaded.url;

    try {
      const canvas = toOcrCanvas(loaded.img);
      const firstTime = !ocrWorker;
      setScan(firstTime ? 'Downloading the bill reader (first time only)…' : 'Starting…', 0.03);
      let pass = 1;
      ocrLog = m => {
        if (token !== scanToken) return;
        if (m.status === 'recognizing text') {
          setScan(pass === 1 ? 'Reading the bill…' : 'Taking a closer look…', 0.15 + 0.85 * (m.progress || 0));
        } else if (pass === 1) {
          setScan(firstTime ? 'Downloading the bill reader (first time only)…' : 'Starting…', 0.03 + 0.12 * (m.progress || 0));
        }
      };
      const worker = await getOcr();
      if (token !== scanToken) return;
      const opts = { today: todayISO() };
      let text = (await worker.recognize(canvas)).data.text;
      const r = window.BillParse.parse(text, opts);
      if (token !== scanToken || !expDlg.open) return;

      if (!r.amountMinor) {
        // Very large text (like the big "₹850" on UPI screens) is often skipped.
        // Second pass: half size, "sparse text" mode, which finds isolated words.
        pass = 2;
        const half = document.createElement('canvas');
        half.width = Math.round(canvas.width / 2);
        half.height = Math.round(canvas.height / 2);
        half.getContext('2d').drawImage(canvas, 0, 0, half.width, half.height);
        await worker.setParameters({ tessedit_pageseg_mode: '11' });
        try {
          const text2 = (await worker.recognize(half)).data.text;
          const r2 = window.BillParse.parse(text2, Object.assign({ kind: r.kind }, opts));
          ['amountMinor', 'merchant', 'date', 'currency', 'ref'].forEach(k => { if (!r[k] && r2[k]) r[k] = r2[k]; });
          text += '\n--- second look ---\n' + text2;
        } finally {
          await worker.setParameters({ tessedit_pageseg_mode: '3' });
        }
        if (token !== scanToken || !expDlg.open) return;
      }
      applyScan(r, text);
    } catch (e) {
      if (token !== scanToken) return;
      console.error(e);
      setScan(navigator.onLine === false
        ? 'You’re offline. The bill reader needs internet the first time. Fill in the details by hand.'
        : 'Couldn’t read this image. Fill in the details by hand.', null, true);
    }
  }

  function matchPerson(trip, name) {
    const first = s => s.toLowerCase().trim().split(/\s+/)[0];
    return trip.people.find(p => p.name.toLowerCase().trim() === name.toLowerCase().trim() || first(p.name) === first(name));
  }

  function applyScan(r, text) {
    const trip = activeTrip();
    const found = [], missing = [];
    draft.source = r.kind;
    draft.ref = r.ref || undefined;

    if (r.merchant) {
      ef.description.value = r.merchant;
      found.push(`${r.kind === 'upi' ? 'Paid to' : 'Shop'}: ${r.merchant}`);
    } else missing.push(r.kind === 'upi' ? 'who was paid' : 'shop name');

    if (r.currency && M.CURRENCIES[r.currency] && r.currency !== ef.currency.value) {
      ef.currency.value = r.currency;
      ef.rate.value = '';
      draft.rateNote = '';
    }
    if (r.amountMinor) {
      ef.amount.value = M.minorToInput(r.amountMinor);
      found.push(`Amount: ${fmt(r.amountMinor, ef.currency.value)}`);
    } else missing.push('total amount');

    if (r.date) { ef.date.value = r.date; found.push(`Date: ${prettyDate(r.date)}`); }
    else missing.push('date (using today)');
    if (r.ref) found.push(`UPI ref: ${r.ref}`);

    // The user chooses the type.
    ef.querySelectorAll('input[name="category"]').forEach(x => { x.checked = false; });
    $('#catHint').hidden = false;
    $('#catHint').closest('fieldset').classList.add('need-pick');

    const amt = M.parseMinor(ef.amount.value);
    const dup = trip.expenses.find(e => e.id !== draft.id &&
      ((r.ref && e.ref === r.ref) ||
       (amt > 0 && e.amountMinor === amt && e.date === ef.date.value && e.currency === ef.currency.value)));

    $('#scanFound').innerHTML =
      found.map(f => `<li>✓ ${esc(f)}</li>`).join('') +
      missing.map(f => `<li class="miss">✗ Not found: ${esc(f)}</li>`).join('') +
      (dup ? `<li class="warn">⚠️ Looks like a duplicate of “${esc(dup.description)}” (${esc(shortDate(dup.date))})</li>` : '');
    $('#scanTextBox').hidden = false;
    $('#scanText').textContent = text.trim() || '(no text found)';
    setScan(r.amountMinor ? 'Check the details, then pick a category' : 'Couldn’t find the total. Please type it in.', null, !r.amountMinor);

    // A UPI payment to someone on the trip is probably settling up, not an expense.
    const person = r.kind === 'upi' && r.merchant && r.amountMinor ? matchPerson(trip, r.merchant) : null;
    const btn = $('#scanAsPayment');
    btn.hidden = !person;
    if (person) {
      btn.textContent = `Paying ${person.name} back? Record as a payment instead`;
      btn.onclick = () => {
        const from = ef.paidBy.value !== person.id ? ef.paidBy.value : undefined;
        expDlg.close();
        openPayment(from, person.id, r.amountMinor);
      };
    }

    renderSplitRows();
    if (ef.currency.value !== 'INR') lookupRate();
  }

  $('#scanBtn').addEventListener('click', () => $('#scanFile').click());
  $('#scanFile').addEventListener('change', e => {
    const f = e.target.files[0];
    e.target.value = '';
    if (f) scanImage(f);
  });
  $('#scanImg').addEventListener('click', () => $('#scanPanel').classList.toggle('big'));
  expDlg.addEventListener('close', resetScanPanel);

  // Paste a screenshot (Ctrl+V on a computer) or drop an image file onto the page
  document.addEventListener('paste', e => {
    if ($('#paymentDialog').open || $('#tripDialog').open || $('#askDialog').open) return;
    const items = Array.from((e.clipboardData && e.clipboardData.items) || []);
    const item = items.find(i => i.kind === 'file' && /^image\//.test(i.type));
    if (!item) return;
    e.preventDefault();
    scanImage(item.getAsFile());
  });
  document.addEventListener('dragover', e => {
    if (e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files')) e.preventDefault();
  });
  document.addEventListener('drop', e => {
    const f = e.dataTransfer && e.dataTransfer.files[0];
    if (!f) return;
    e.preventDefault();
    if (/^image\//.test(f.type)) scanImage(f);
  });

  // Image shared from another app (GPay, PhonePe, Photos...) via the installed app's share sheet.
  // sw.js receives it, stores it, and opens index.html?shared=1.
  async function takeSharedImage() {
    if (!/[?&]shared=1/.test(location.search) || !('caches' in window)) return;
    history.replaceState(null, '', location.pathname + location.hash);
    try {
      const cache = await caches.open('shared-files');
      const res = await cache.match('shared-image');
      if (!res) return;
      await cache.delete('shared-image');
      const blob = await res.blob();
      scanImage(new File([blob], 'shared-image', { type: blob.type || 'image/png' }));
    } catch (e) { console.error(e); }
  }

  /* ---------- payment dialog ---------- */
  const payDlg = $('#paymentDialog');
  const pf = $('#paymentForm');

  function openPayment(from, to, amountMinor) {
    const trip = activeTrip();
    if (!trip || trip.people.length < 2) { toast('You need at least 2 people'); return; }
    const opts = trip.people.map(p => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');
    pf.from.innerHTML = opts;
    pf.to.innerHTML = opts;
    pf.from.value = from || trip.people[0].id;
    pf.to.value = to || trip.people.find(p => p.id !== pf.from.value).id;
    pf.amount.value = amountMinor ? M.minorToInput(amountMinor) : '';
    pf.date.value = todayISO();
    validatePayment();
    payDlg.showModal();
  }

  function validatePayment() {
    const amt = M.parseMinor(pf.amount.value);
    let msg = '', ok = true;
    if (pf.from.value === pf.to.value) { ok = false; msg = 'Pick two different people'; }
    else if (!(amt > 0)) { ok = false; msg = 'Enter an amount'; }
    else {
      const trip = activeTrip();
      msg = `${personName(trip, pf.from.value)} pays ${personName(trip, pf.to.value)} ${fmt(amt)}`;
    }
    $('#payStatus').textContent = msg;
    $('#payStatus').className = 'status ' + (ok ? 'good' : 'bad');
    $('#paySave').disabled = !ok;
    return ok ? amt : 0;
  }
  pf.addEventListener('input', validatePayment);
  pf.addEventListener('change', validatePayment);
  pf.addEventListener('submit', e => {
    e.preventDefault();
    const amt = validatePayment();
    if (!amt) return;
    const trip = activeTrip();
    trip.settlements.push({
      id: uid('s'), from: pf.from.value, to: pf.to.value, amountMinor: amt,
      date: pf.date.value || todayISO(), createdAt: Date.now()
    });
    payDlg.close();
    commit();
    toast('Payment recorded');
  });

  /* ---------- new trip dialog ---------- */
  const tripDlg = $('#tripDialog');
  const tf = $('#tripForm');
  tf.currency.innerHTML = currencyOptions('INR');

  function parsePeople(text) {
    const seen = new Set();
    return text.split(/[\n,]+/).map(s => s.trim()).filter(s => {
      const k = s.toLowerCase();
      if (!s || seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }
  function validateTrip() {
    const names = parsePeople(tf.people.value);
    let msg = '', ok = false;
    if (!tf.tripName.value.trim()) msg = 'Give the trip a name';
    else if (names.length < 2) msg = 'Add at least 2 people';
    else { ok = true; msg = `${names.length} people: ${names.join(', ')}`; }
    $('#tripStatus').textContent = msg;
    $('#tripStatus').className = 'status ' + (ok ? 'good' : 'bad');
    return ok ? names : null;
  }
  tf.addEventListener('input', validateTrip);
  tf.addEventListener('submit', e => {
    e.preventDefault();
    const names = validateTrip();
    if (!names) return;
    const t = {
      id: uid('t'), name: tf.tripName.value.trim(), createdAt: Date.now(),
      defaultCurrency: tf.currency.value,
      people: names.map(n => ({ id: uid('p'), name: n })),
      expenses: [], settlements: []
    };
    state.trips.push(t);
    state.activeTripId = t.id;
    ui.tab = 'expenses';
    tripDlg.close();
    commit();
    toast(`“${t.name}” created`);
  });

  /* ---------- summary text ---------- */
  function summaryText(trip) {
    const bal = M.computeBalances(trip);
    const transfers = M.settleUp(bal).sort((a, b) => b.amount - a.amount);
    const sum = M.tripSummary(trip);
    const name = id => personName(trip, id);
    const lines = [`🧳 *${trip.name}*`, `Total spend: ${fmt(sum.totalINR)} (${sum.count} expense${sum.count === 1 ? '' : 's'})`, ''];
    if (transfers.length) {
      lines.push('*Settle up:*');
      transfers.forEach(t => lines.push(`• ${name(t.from)} pays ${name(t.to)} ${fmt(t.amount)}`));
    } else {
      lines.push('Everyone is settled up ✅');
    }
    const cats = M.CATEGORIES.filter(c => sum.byCategory[c] > 0);
    if (cats.length) {
      lines.push('', '*By category:*');
      cats.forEach(c => lines.push(`${CAT_ICON[c]} ${c}: ${fmt(sum.byCategory[c])}`));
    }
    return lines.join('\n');
  }

  async function copyText(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); return true; }
    } catch (e) { /* fall back */ }
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { /* ignore */ }
    ta.remove();
    return ok;
  }

  /* ---------- import / export ---------- */
  function exportData() {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `trip-splitter-${todayISO()}.json`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    toast('Backup downloaded');
  }

  $('#importFile').addEventListener('change', async e => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    let incoming;
    try { incoming = normalizeState(JSON.parse(await file.text())); }
    catch (err) {
      await ask('Can’t import this file', `<p>${esc(err.message || 'It isn’t a valid backup.')}</p>`, [{ label: 'OK', value: true, cls: 'primary' }]);
      return;
    }
    const n = incoming.trips.length;
    const choice = await ask('Import backup',
      `<p>This file has <strong>${n} trip${n === 1 ? '' : 's'}</strong>: ${esc(incoming.trips.map(t => t.name).join(', '))}.</p>
       <p><strong>Merge</strong> adds trips you don’t already have. <strong>Replace</strong> swaps everything here for the file’s contents.</p>`,
      [{ label: 'Cancel', value: null }, { label: 'Merge', value: 'merge' }, { label: 'Replace all', value: 'replace', cls: 'danger' }]);
    if (choice === 'replace') {
      state = incoming;
      commit();
      toast(`Imported ${n} trip${n === 1 ? '' : 's'}`);
    } else if (choice === 'merge') {
      const have = new Set(state.trips.map(t => t.id));
      const added = incoming.trips.filter(t => !have.has(t.id));
      state.trips.push(...added);
      Object.assign(state.rateCache, incoming.rateCache);
      if (!state.activeTripId && added[0]) state.activeTripId = added[0].id;
      commit();
      const skipped = n - added.length;
      toast(`Added ${added.length} trip${added.length === 1 ? '' : 's'}` + (skipped ? `, ${skipped} already here` : ''));
    }
  });

  /* ---------- actions ---------- */
  const actions = {
    'tab': el => { ui.tab = el.dataset.tab; render(); window.scrollTo(0, 0); },
    'new-trip': () => {
      tf.reset();
      tf.currency.value = 'INR';
      validateTrip();
      $('#tripStatus').textContent = '';
      tripDlg.showModal();
      setTimeout(() => tf.tripName.focus(), 50);
    },
    'add-expense': () => openExpense(null),
    'scan': () => $('#scanFile').click(),
    'edit-expense': el => {
      const exp = activeTrip().expenses.find(x => x.id === el.dataset.id);
      if (exp) openExpense(exp);
    },
    'record-payment': () => openPayment(),
    'mark-paid': el => openPayment(el.dataset.from, el.dataset.to, Number(el.dataset.amt)),
    'delete-settlement': async el => {
      const trip = activeTrip();
      const s = trip.settlements.find(x => x.id === el.dataset.id);
      if (!s) return;
      const ok = await ask('Delete payment?',
        `<p>${esc(personName(trip, s.from))} → ${esc(personName(trip, s.to))}, ${esc(fmt(s.amountMinor))}</p>`,
        [{ label: 'Cancel', value: false }, { label: 'Delete', value: true, cls: 'danger' }]);
      if (!ok) return;
      trip.settlements = trip.settlements.filter(x => x.id !== s.id);
      commit();
    },
    'copy-summary': async () => {
      const text = summaryText(activeTrip());
      if (await copyText(text)) toast('Summary copied. Paste it in WhatsApp');
      else ask('Copy this summary', `<pre>${esc(text)}</pre>`, [{ label: 'Done', value: true, cls: 'primary' }]);
    },
    'share-summary': async () => {
      try { await navigator.share({ text: summaryText(activeTrip()) }); } catch (e) { /* cancelled */ }
    },
    'add-person': () => {
      const input = $('#newPerson');
      const nm = input.value.trim();
      if (!nm) { input.focus(); return; }
      const trip = activeTrip();
      if (trip.people.some(p => p.name.toLowerCase() === nm.toLowerCase())) { toast(`${nm} is already on this trip`); return; }
      trip.people.push({ id: uid('p'), name: nm });
      commit();
      $('#newPerson').focus();
    },
    'remove-person': async el => {
      const trip = activeTrip();
      const p = trip.people.find(x => x.id === el.dataset.id);
      if (!p || personInUse(trip, p.id)) return;
      trip.people = trip.people.filter(x => x.id !== p.id);
      commit();
      toast(`${p.name} removed`);
    },
    'export': exportData,
    'import': () => $('#importFile').click(),
    'load-sample': () => {
      const t = window.SampleTrip.create(uid);
      state.trips.push(t);
      state.activeTripId = t.id;
      ui.tab = 'expenses';
      commit();
      toast('Sample trip loaded');
    },
    'delete-trip': async () => {
      const trip = activeTrip();
      const transfers = M.settleUp(M.computeBalances(trip));
      const warn = transfers.length
        ? `<p class="neg"><strong>Not settled yet:</strong> ${transfers.length} payment${transfers.length === 1 ? '' : 's'} still due.</p>`
        : '<p>All balances are settled. 👍</p>';
      const ok = await ask(`Delete “${trip.name}”?`,
        `${warn}<p>This permanently removes the trip and its ${trip.expenses.length} expenses.</p>`,
        [{ label: 'Cancel', value: false }, { label: 'Delete trip', value: true, cls: 'danger' }]);
      if (!ok) return;
      state.trips = state.trips.filter(t => t.id !== trip.id);
      state.activeTripId = state.trips[0] ? state.trips[0].id : null;
      commit();
      toast('Trip deleted');
    }
  };

  document.addEventListener('click', e => {
    const closer = e.target.closest('[data-close]');
    if (closer) { closer.closest('dialog').close(); return; }
    const el = e.target.closest('[data-action]');
    if (el && actions[el.dataset.action]) actions[el.dataset.action](el, e);
  });

  // Tapping the dark backdrop closes a dialog
  document.querySelectorAll('dialog').forEach(d => d.addEventListener('click', e => { if (e.target === d) d.close(); }));

  // Edits in the Trip tab save on change
  document.addEventListener('change', e => {
    const t = e.target;
    const trip = activeTrip();
    if (t.id === 'tripSelect') { state.activeTripId = t.value; commit(); return; }
    if (!trip || !t.dataset.field) return;
    if (t.dataset.field === 'trip-name') {
      const v = t.value.trim();
      if (v) { trip.name = v; commit(); } else t.value = trip.name;
    } else if (t.dataset.field === 'trip-currency') {
      trip.defaultCurrency = t.value; commit(); toast(`New expenses will default to ${t.value}`);
    } else if (t.dataset.field === 'person-name') {
      const p = trip.people.find(x => x.id === t.dataset.id);
      const v = t.value.trim();
      if (p && v) { p.name = v; commit(); } else if (p) t.value = p.name;
    }
  });

  document.addEventListener('keydown', e => {
    if (e.key === 'Enter' && e.target.id === 'newPerson') { e.preventDefault(); actions['add-person'](); }
  });

  // Keep tabs in sync if the app is open in two tabs
  window.addEventListener('storage', e => {
    if (e.key === KEY && e.newValue) {
      try { state = normalizeState(JSON.parse(e.newValue)); render(); } catch (_) { /* ignore */ }
    }
  });

  render();
  takeSharedImage();
  if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
    navigator.serviceWorker.register('sw.js').catch(e => console.warn('Service worker not registered', e));
  }
})();
