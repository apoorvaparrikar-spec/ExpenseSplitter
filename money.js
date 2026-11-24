/*
 * Money math for Trip Splitter. No DOM code in here, so it can be tested on its own.
 *
 * Every amount is an INTEGER in minor units (paise / cents). Floats are only
 * used for the exchange rate itself; every result is rounded back to integers
 * and redistributed so that parts always add up exactly to the whole.
 */
(function (root) {
  'use strict';

  const CATEGORIES = ['Food', 'Transport', 'Fuel', 'Stay', 'Activities', 'Other'];

  // Currency code -> display symbol. INR first; it is the reporting currency.
  const CURRENCIES = {
    INR: '₹', USD: '$', EUR: '€', GBP: '£', AED: 'AED ', THB: '฿', SGD: 'S$',
    MYR: 'RM ', IDR: 'Rp ', LKR: 'LKR ', NPR: 'NPR ', BTN: 'Nu. ', MVR: 'MVR ',
    VND: '₫', JPY: '¥', KRW: '₩', CNY: 'CN¥', HKD: 'HK$', PHP: '₱', AUD: 'A$',
    NZD: 'NZ$', CAD: 'C$', CHF: 'CHF ', ZAR: 'R ', TRY: '₺', SAR: 'SAR ', QAR: 'QAR '
  };

  /** "1,234.5" -> 123450. Rounds half-up at the 3rd decimal. Returns NaN if invalid. */
  function parseMinor(input) {
    const s = String(input == null ? '' : input).trim().replace(/[,\s]/g, '');
    if (!/^(\d+(\.\d*)?|\.\d+)$/.test(s)) return NaN;
    const parts = s.split('.');
    const whole = parts[0] || '0';
    const frac = (parts[1] || '') + '000';
    let minor = Number(whole) * 100 + Number(frac.slice(0, 2));
    if (Number(frac[2]) >= 5) minor += 1;
    return Number.isSafeInteger(minor) ? minor : NaN;
  }

  /** 123450 -> "1234.50" (for putting back into an input field). */
  function minorToInput(minor) {
    const a = Math.abs(minor);
    return (minor < 0 ? '-' : '') + Math.floor(a / 100) + '.' + String(a % 100).padStart(2, '0');
  }

  const nf = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  function symbolFor(code) {
    return CURRENCIES[code] || (code + ' ');
  }

  /** 123450, 'INR' -> "₹1,234.50"; negative -> "−₹1,234.50". */
  function formatMoney(minor, code) {
    const sign = minor < 0 ? '−' : '';
    return sign + symbolFor(code || 'INR') + nf.format(Math.abs(minor) / 100);
  }

  /**
   * Split `total` (integer) in proportion to `weights` (integers) using the
   * largest-remainder method. Result always sums to exactly `total`.
   * Ties go to the earliest index, so results are deterministic.
   */
  function allocate(total, weights) {
    const n = weights.length;
    if (!n) return [];
    let w = weights.map(x => Math.max(0, Math.round(x)));
    let sumW = w.reduce((a, b) => a + b, 0);
    if (sumW === 0) { w = w.map(() => 1); sumW = n; }
    // BigInt so total * weight can never overflow.
    const T = BigInt(total), S = BigInt(sumW);
    const out = new Array(n), rems = [];
    let used = 0n;
    for (let i = 0; i < n; i++) {
      const p = T * BigInt(w[i]);
      out[i] = p / S;
      used += out[i];
      rems.push({ i, r: p % S });
    }
    rems.sort((a, b) => (b.r > a.r ? 1 : b.r < a.r ? -1 : a.i - b.i));
    const left = Number(T - used);
    for (let k = 0; k < left; k++) out[rems[k].i] += 1n;
    return out.map(Number);
  }

  /** Equal split among ids -> { id: minor }. ₹100 / 3 -> 33.34, 33.33, 33.33. */
  function splitEqual(amountMinor, ids) {
    const vals = allocate(amountMinor, ids.map(() => 1));
    const shares = {};
    ids.forEach((id, i) => { shares[id] = vals[i]; });
    return shares;
  }

  /** Convert an amount to INR paise with the expense's locked rate. */
  function toINRMinor(amountMinor, currency, rate) {
    if (!currency || currency === 'INR') return amountMinor;
    return Math.round(amountMinor * Number(rate));
  }

  /**
   * An expense's total and shares in INR. The INR total is converted once,
   * then split in proportion to the original shares, so shares still add up
   * exactly to the converted total.
   */
  function expenseINR(exp) {
    const total = toINRMinor(exp.amountMinor, exp.currency, exp.rateToINR);
    const ids = Object.keys(exp.shares);
    const vals = exp.currency === 'INR' || !exp.currency
      ? ids.map(id => exp.shares[id])
      : allocate(total, ids.map(id => exp.shares[id]));
    const shares = {};
    ids.forEach((id, i) => { shares[id] = vals[i]; });
    return { total, shares };
  }

  /**
   * Per-person ledger in INR paise.
   * balance = paid - share + sent - received
   *   > 0  -> others owe this person
   *   < 0  -> this person owes others
   */
  function computeLedger(trip) {
    const L = {};
    const get = id => L[id] || (L[id] = { paid: 0, share: 0, sent: 0, received: 0, balance: 0 });
    trip.people.forEach(p => get(p.id));
    (trip.expenses || []).forEach(exp => {
      const { total, shares } = expenseINR(exp);
      get(exp.paidBy).paid += total;
      for (const id in shares) get(id).share += shares[id];
    });
    (trip.settlements || []).forEach(s => {
      get(s.from).sent += s.amountMinor;
      get(s.to).received += s.amountMinor;
    });
    for (const id in L) {
      const r = L[id];
      r.balance = r.paid - r.share + r.sent - r.received;
    }
    return L;
  }

  function computeBalances(trip) {
    const L = computeLedger(trip), b = {};
    for (const id in L) b[id] = L[id].balance;
    return b;
  }

  /** Total spend in INR and a breakdown by category (settlements are not spend). */
  function tripSummary(trip) {
    const byCategory = {};
    CATEGORIES.forEach(c => { byCategory[c] = 0; });
    let totalINR = 0;
    (trip.expenses || []).forEach(exp => {
      const t = expenseINR(exp).total;
      totalINR += t;
      byCategory[exp.category] = (byCategory[exp.category] || 0) + t;
    });
    return { totalINR, byCategory, count: (trip.expenses || []).length };
  }

  /* ---------------- Settle up ---------------- */

  /** Largest debtor pays largest creditor, repeatedly. Uses at most n-1 payments. */
  function greedySettle(entries) {
    const cred = entries.filter(e => e.amt > 0).map(e => ({ id: e.id, amt: e.amt }));
    const debt = entries.filter(e => e.amt < 0).map(e => ({ id: e.id, amt: -e.amt }));
    const out = [];
    const byAmt = (a, b) => b.amt - a.amt; // Array#sort is stable, so ties keep input order
    while (cred.length && debt.length) {
      cred.sort(byAmt); debt.sort(byAmt);
      const c = cred[0], d = debt[0];
      const x = Math.min(c.amt, d.amt);
      out.push({ from: d.id, to: c.id, amount: x });
      c.amt -= x; d.amt -= x;
      if (c.amt === 0) cred.shift();
      if (d.amt === 0) debt.shift();
    }
    return out;
  }

  const MAX_EXACT = 16; // 2^16 subsets; still instant

  /**
   * Fewest payments that clear every balance.
   *
   * A group of k people whose balances sum to zero can always be cleared in
   * k-1 payments. So the minimum number of payments is n - G, where G is the
   * largest number of zero-sum groups the people can be split into. G comes
   * from a DP over subsets: dp[mask] = max over i in mask of dp[mask without i],
   * plus 1 if mask itself sums to zero. We then rebuild the groups and settle
   * each one greedily, which uses at most k-1 payments per group.
   *
   * Above MAX_EXACT people with non-zero balances it falls back to greedy.
   */
  function settleUp(balances) {
    const entries = Object.keys(balances)
      .map(id => ({ id, amt: balances[id] }))
      .filter(e => e.amt !== 0);
    if (!entries.length) return [];
    const n = entries.length;
    if (n > MAX_EXACT) return greedySettle(entries);

    const size = 1 << n, full = size - 1;
    const sum = new Float64Array(size); // integers well within 2^53
    const dp = new Int8Array(size);
    for (let mask = 1; mask < size; mask++) {
      const low = mask & -mask;
      sum[mask] = sum[mask ^ low] + entries[31 - Math.clz32(low)].amt;
      let best = 0;
      for (let i = 0; i < n; i++) {
        if (mask & (1 << i)) {
          const v = dp[mask ^ (1 << i)];
          if (v > best) best = v;
        }
      }
      dp[mask] = best + (sum[mask] === 0 ? 1 : 0);
    }

    // Walk back from the full set. Each time the remaining set sums to zero,
    // the people removed since the last such point form one group.
    const groups = [];
    let mask = full, current = [];
    while (mask) {
      const need = dp[mask] - (sum[mask] === 0 ? 1 : 0);
      let pick = -1;
      for (let i = 0; i < n; i++) {
        if ((mask & (1 << i)) && dp[mask ^ (1 << i)] === need) { pick = i; break; }
      }
      current.push(entries[pick]);
      mask ^= 1 << pick;
      if (sum[mask] === 0) { groups.push(current); current = []; }
    }

    const out = [];
    groups.forEach(g => out.push(...greedySettle(g)));
    return out;
  }

  const Money = {
    CATEGORIES, CURRENCIES, MAX_EXACT,
    parseMinor, minorToInput, formatMoney, symbolFor,
    allocate, splitEqual, toINRMinor, expenseINR,
    computeLedger, computeBalances, tripSummary,
    settleUp, greedySettle
  };

  root.Money = Money;
  if (typeof module !== 'undefined' && module.exports) module.exports = Money;
})(typeof window !== 'undefined' ? window : globalThis);
