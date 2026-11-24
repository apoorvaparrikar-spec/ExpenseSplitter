/*
 * Turns text read from a bill photo or a UPI screenshot into expense details.
 * Pure functions, no DOM. Covered by tests.js.
 *
 *   BillParse.parse(text, { today: 'YYYY-MM-DD' })
 *     -> { kind: 'bill' | 'upi', merchant, amountMinor, date, currency, ref }
 *
 * OCR text is messy, so every field may come back null. The app shows the
 * image next to the form so the user can check and correct what was found.
 */
(function (root) {
  'use strict';

  const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
  const MON = '(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\\.?';

  function toLines(text) {
    return String(text || '').split(/\r?\n/)
      .map(l => l.replace(/[|]/g, ' ').replace(/\s+/g, ' ').trim())
      .filter(Boolean);
  }

  /* ---------------- dates ---------------- */
  function iso(y, m, d) {
    if (y < 100) y += 2000;
    if (!(m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null;
    const dt = new Date(Date.UTC(y, m - 1, d));
    if (dt.getUTCMonth() !== m - 1) return null;
    return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
  function addDays(isoStr, n) {
    const d = new Date(isoStr + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }
  const plausible = (v, today) => !!v && Number(v.slice(0, 4)) >= 2015 && v <= addDays(today, 1);

  // Each pattern returns an ISO date (or null) from its match.
  const DATE_PATTERNS = [
    // 2026-11-24, 2026/11/24
    [/(^|[^\d])(\d{4})[/\-.](\d{1,2})[/\-.](\d{1,2})(?!\d)/g, m => iso(+m[2], +m[3], +m[4])],
    // 24/11/2026, 24-11-26, 24.11.2026 (Indian day-first; swaps if month > 12)
    [/(^|[^\d])(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4}|\d{2})(?![\d:])/g, m => {
      let d = +m[2], mo = +m[3];
      if (mo > 12 && d <= 12) { const t = d; d = mo; mo = t; }
      return iso(+m[4], mo, d);
    }],
    // 24 Nov 2026, 24-Nov-26, 24th November, 2026
    [new RegExp(`(^|[^\\d])(\\d{1,2})(?:st|nd|rd|th)?[\\s\\-.,/]*${MON}[\\s\\-.,/']*(\\d{4}|\\d{2})(?![\\d:])`, 'gi'),
      m => iso(+m[4], MONTHS[m[3].toLowerCase()], +m[2])],
    // Nov 24, 2026
    [new RegExp(`(^|[^a-z])${MON}[\\s\\-.]*(\\d{1,2})(?:st|nd|rd|th)?,?[\\s\\-.']*(\\d{4})(?!\\d)`, 'gi'),
      m => iso(+m[4], MONTHS[m[2].toLowerCase()], +m[3])]
  ];

  function findDate(lines, today) {
    const text = lines.join('\n');
    const found = [];
    DATE_PATTERNS.forEach(([rx, fn]) => {
      rx.lastIndex = 0;
      let m;
      while ((m = rx.exec(text))) {
        const v = fn(m);
        if (plausible(v, today)) found.push({ v, idx: m.index });
      }
    });
    if (found.length) return found.sort((a, b) => a.idx - b.idx)[0].v;

    // No year, as UPI apps often show: "24 Nov, 7:42 pm" or "Nov 24"
    let m = new RegExp(`(?:^|[^\\d])(\\d{1,2})(?:st|nd|rd|th)?[\\s\\-]*${MON}(?![a-z])`, 'i').exec(text);
    let d, mo;
    if (m) { d = +m[1]; mo = MONTHS[m[2].toLowerCase()]; }
    else if ((m = new RegExp(`(?:^|[^a-z])${MON}\\s*(\\d{1,2})(?!\\d)`, 'i').exec(text))) { mo = MONTHS[m[1].toLowerCase()]; d = +m[2]; }
    if (mo) {
      const y = Number(today.slice(0, 4));
      let v = iso(y, mo, d);
      if (v && v > addDays(today, 1)) v = iso(y - 1, mo, d);
      if (v) return v;
    }
    if (/\byesterday\b/i.test(text)) return addDays(today, -1);
    if (/\btoday\b/i.test(text)) return today;
    return null;
  }

  /** Remove dates and times so their digits aren't mistaken for amounts. */
  function stripDatesTimes(line) {
    let s = line;
    DATE_PATTERNS.forEach(([rx]) => { s = s.replace(new RegExp(rx.source, rx.flags), '$1 '); });
    s = s.replace(new RegExp(`(\\d{1,2})(?:st|nd|rd|th)?[\\s\\-]*${MON}(?![a-z])`, 'gi'), ' ');
    s = s.replace(/\b\d{1,2}:\d{2}(:\d{2})?\s*(am|pm|hrs)?/gi, ' ');
    return s;
  }

  /* ---------------- amounts ---------------- */
  // "1,23,456.78" / "1,234.56" / "450.00" / "450,00" / "450"
  const NUM_RX = /(\d{1,3}(?:,\d{2})*,\d{3}|\d+)(?:\s?[.,]\s?(\d{2}))?/g;
  // Currency marks in front of an amount. OCR often reads ₹ as % or ? or =.
  const CUR_BEFORE = /(₹|rs\.?|inr|\$|€|£|%|\?|=|aed|usd|eur|gbp|thb|sgd|lkr|npr)\s*:?\s*$/i;

  function amountsIn(line) {
    const out = [];
    NUM_RX.lastIndex = 0;
    let m;
    while ((m = NUM_RX.exec(line))) {
      const start = m.index, end = start + m[0].length;
      const prev = line[start - 1] || '', next = line[end] || '';
      if (/[\d/:xX*]/.test(prev) || /[\d/:]/.test(next)) continue;      // ids, masked card numbers
      const hasCur = CUR_BEFORE.test(line.slice(Math.max(0, start - 6), start));
      if (/[a-z]/i.test(prev) && !hasCur) continue;                       // "A1234", but allow "Rs450"
      const raw = m[1].replace(/,/g, '');
      if (raw.length > 7) continue;                                      // phone / account numbers
      out.push({ minor: Number(raw) * 100 + (m[2] ? Number(m[2]) : 0), raw, hasDec: !!m[2], hasCur });
    }
    return out;
  }

  const TOTAL_KEYS = [
    [/grand\s*total|net\s*payable|amount\s*payable|total\s*payable|net\s*amount|net\s*amt|bill\s*amount|bill\s*amt|total\s*amount|total\s*amt|amount\s*due|total\s*due|to\s*pay\b|total\s*rs|total\s*inr/i, 100],
    [/sale\s*amount|txn\s*amount|transaction\s*amount|amount\s*paid|paid\s*amount|total\s*sale/i, 85],
    [/\btotal\b|\bamount\b|\bamt\b|\bsale\b|\bpaid\b/i, 60]
  ];
  const NOT_TOTAL = /sub\s*-?\s*total|total\s*(qty|quantity|items?|savings|discount|tax|gst|no)|discount|saving|\btax|cgst|sgst|igst|\bvat\b|\bcess|change\b|tender|cash\s*rec|round\s*(ed\s*)?off|balance|points|\bqty\b|\brate\b|\bvol|litre|liter|\bltr|mrp|tip\b|service\s*charge/i;
  const NOT_AMOUNT_LINE = /\btid\b|\bmid\b|batch|invoice\s*(no|#)|bill\s*(no|#)|\binv\b|txn\s*(id|no)|\bref\b|rrn|approval|auth|card|a\/c|account|phone|\bmob|\bph\b|tel\b|gstin|fssai|table|cover|\bpax\b|token|order\s*(no|#|id)|\bstan\b|terminal|upi\s*id|vpa|utr|transaction\s*id|pin\s*code|pincode/i;

  function keyScore(line) {
    for (const [rx, s] of TOTAL_KEYS) if (rx.test(line)) return s;
    return 0;
  }

  function pickBillTotal(lines) {
    const cands = [];
    lines.forEach((line, i) => {
      const key = keyScore(line);
      const neg = NOT_TOTAL.test(line);
      if (NOT_AMOUNT_LINE.test(line) && !(key && !neg)) return;
      let am = amountsIn(line);
      // Label and value split across two lines ("TOTAL" / "1,250.00")
      if (!am.length && key && !neg && lines[i + 1] && !keyScore(lines[i + 1])) am = amountsIn(lines[i + 1]);
      am.forEach((a, j) => {
        let s = 0;
        if (key && !neg) s += key; else if (neg) s -= 50;
        if (a.hasDec) s += 10;
        if (a.hasCur) s += 10;
        if (j === am.length - 1) s += 3;          // rightmost column
        s += (i / lines.length) * 5;              // totals are near the bottom
        if (a.minor === 0) s -= 200;
        cands.push(Object.assign({ score: s, keyed: key > 0 && !neg }, a));
      });
    });
    if (!cands.length) return null;
    const keyed = cands.filter(c => c.keyed && c.minor > 0);
    if (keyed.length) return keyed.sort((a, b) => b.score - a.score || b.minor - a.minor)[0];
    // No "Total" label found: the largest money-looking amount is usually the total.
    const money = cands.filter(c => c.score > -40 && c.minor > 0 && (c.hasDec || c.hasCur));
    const pool = money.length ? money : cands.filter(c => c.score > -40 && c.minor > 0);
    return pool.sort((a, b) => b.minor - a.minor)[0] || null;
  }

  const UPI_SKIP = /\bref\b|\butr\b|\bid\b|no\.|a\/c|account|bank|@|transaction|mobile|phone|\+91|xx/i;
  function pickUpiAmount(lines) {
    const cands = [];
    lines.forEach((line, i) => {
      if (UPI_SKIP.test(line) && !/₹|rs\.?\s*\d/i.test(line)) return;
      const bare = /^[₹%?=\s\-]*(rs\.?|inr)?\s*[\d,]+([.,]\s?\d{2})?\s*$/i.test(line);
      amountsIn(line).forEach(a => {
        let s = 0;
        if (bare) s += 50;
        if (a.hasCur) s += 40;
        if (/paid|sent|debited|amount|received|transferred|payment/i.test(line)) s += 20;
        if (a.hasDec) s += 5;
        s -= i * 0.5; // the big amount is near the top
        if (a.minor === 0) s -= 200;
        cands.push(Object.assign({ score: s }, a));
      });
    });
    if (!cands.length) return null;
    cands.sort((a, b) => b.score - a.score);
    const best = cands[0];
    if (best.score < 20) return null;
    // OCR often reads a large "₹" as a leading "2": "₹450" -> "2450".
    if (!best.hasCur && best.raw.length > 1 && best.raw[0] === '2') {
      const alt = Number(best.raw.slice(1)) * 100 + (best.minor % 100);
      if (cands.some(c => c !== best && c.minor === alt)) return Object.assign({}, best, { minor: alt });
    }
    return best;
  }

  /* ---------------- merchant / payee ---------------- */
  function tidy(s) {
    s = s.replace(/^[^a-z0-9]+|[^a-z0-9).]+$/gi, '').replace(/\s+/g, ' ').trim();
    if (s && s === s.toUpperCase()) s = s.toLowerCase().replace(/(^|[\s(&\-/])([a-z])/g, (_, p, c) => p + c.toUpperCase());
    return s.slice(0, 60);
  }

  const MERCHANT_JUNK = /tax\s*invoice|invoice|receipt|bill\s*of\s*supply|^bill\b|gstin|gst\s*no|fssai|\bcin\b|welcome|thank|customer\s*copy|merchant\s*copy|duplicate|original|cash\s*memo|estimate|\bkot\b|date|time|\btel\b|phone|\bmob|www\.|@|\.com|\bsale\b|card|\btid\b|\bmid\b|batch|bank|pine\s*labs|razorpay|mswipe|ezetap|\bvisa\b|master\s*card|rupay|charge\s*slip|^copy$/i;

  function pickMerchant(lines) {
    for (const line of lines.slice(0, 8)) {
      const letters = (line.match(/[a-z]/gi) || []).length;
      if (letters < 3 || letters / line.length < 0.5) continue;
      if (MERCHANT_JUNK.test(line)) continue;
      return tidy(line);
    }
    return null;
  }

  const hasName = s => /[a-z]{2}/i.test(s || '');
  function pickPayee(lines) {
    for (let i = 0; i < lines.length; i++) {
      const m = /^(?:paid\s*(?:successfully\s*)?to|sent\s*to|transferred\s*to|money\s*sent\s*to|paying|to)\b\s*:?\s*(.*)$/i.exec(lines[i]);
      if (!m) continue;
      let name = m[1].trim();
      if (!hasName(name) || name.includes('@')) {
        const nx = lines[i + 1] || '';
        if (hasName(nx) && !nx.includes('@') && !/^(upi|from|bank)/i.test(nx)) name = nx;
        else if (!name) continue;
      }
      if (name.includes('@')) name = name.split('@')[0].replace(/[._\-]+/g, ' ');
      name = name.replace(/[₹%]?\s*[\d,]+([.,]\d{2})?\s*$/, '').trim();
      if (hasName(name)) return tidy(name);
    }
    const vpa = lines.join(' ').match(/([a-z][a-z0-9._\-]{2,})@[a-z]{2,}/i);
    return vpa ? tidy(vpa[1].replace(/[._\-]+/g, ' ')) : null;
  }

  /* ---------------- kind, currency, reference ---------------- */
  const UPI_HINTS = [/paid\s*to/i, /sent\s*to/i, /google\s*pay|\bg\s?pay\b/i, /phonepe/i, /paytm/i, /\bbhim\b/i,
    /upi\s*(transaction|ref|id)/i, /\butr\b/i, /payment\s*(successful|completed)/i, /paid\s*successfully/i,
    /transaction\s*successful/i, /debited\s*from/i, /money\s*sent/i, /@ok[a-z]+|@ybl|@paytm|@ibl|@axl|@upi/i];
  const BILL_HINTS = [/gstin/i, /invoice/i, /\bqty\b/i, /cgst|sgst|igst|\bvat\b/i, /sub\s*-?total/i, /grand\s*total/i,
    /\btid\b|\bmid\b|batch/i, /approval|auth\s*code/i, /card\s*(no|number|type)|\bvisa\b|master\s*card|rupay/i,
    /litre|liter|\bvol/i, /\brate\b/i, /table|\bkot\b|cashier|steward/i, /visit\s*again/i, /charge\s*slip/i];

  function detectKind(text) {
    const u = UPI_HINTS.filter(rx => rx.test(text)).length;
    const b = BILL_HINTS.filter(rx => rx.test(text)).length;
    return u > b ? 'upi' : 'bill';
  }

  const CURRENCY_HINTS = [
    ['INR', /₹|\binr\b|\brs\.?\s?\d|gstin|cgst|sgst/i],
    ['SGD', /\bsgd\b|s\$/i], ['AUD', /\baud\b|a\$/i], ['USD', /\$|\busd\b/i],
    ['EUR', /€|\beur\b/i], ['GBP', /£|\bgbp\b/i], ['AED', /\baed\b|\bdhs?\b|dirham/i],
    ['THB', /฿|\bthb\b|\bbaht\b/i], ['MYR', /\bmyr\b|\brm\s?\d/i], ['LKR', /\blkr\b/i], ['NPR', /\bnpr\b/i]
  ];
  function detectCurrency(text) {
    for (const [code, rx] of CURRENCY_HINTS) if (rx.test(text)) return code;
    return null;
  }

  function findRef(text) {
    const m = /(?:utr|upi\s*(?:transaction\s*)?(?:ref(?:erence)?|id)|transaction\s*id|ref(?:erence)?\s*(?:no|number|id)?)\.?\s*(?:no\.?)?\s*[:\-]?\s*([A-Z0-9]{10,})/i.exec(text);
    if (m) return m[1];
    const twelve = /(?:^|\D)(\d{12})(?!\d)/.exec(text); // UPI refs are 12 digits
    return twelve ? twelve[1] : null;
  }

  function parse(text, opts) {
    const today = (opts && opts.today) || new Date().toISOString().slice(0, 10);
    const lines = toLines(text);
    const joined = lines.join('\n');
    const kind = (opts && opts.kind) || detectKind(joined);
    const clean = lines.map(stripDatesTimes);
    const amt = kind === 'upi' ? pickUpiAmount(clean) : pickBillTotal(clean);
    return {
      kind,
      merchant: kind === 'upi' ? pickPayee(lines) : pickMerchant(lines),
      amountMinor: amt ? amt.minor : null,
      date: findDate(lines, today),
      currency: kind === 'upi' ? 'INR' : detectCurrency(joined),
      ref: kind === 'upi' ? findRef(joined) : null
    };
  }

  root.BillParse = { parse, findDate, amountsIn, detectKind, pickMerchant, pickPayee };
})(typeof window !== 'undefined' ? window : globalThis);
