/* Tests for money.js. Open tests.html in a browser to run them. */
(function () {
  'use strict';
  const M = window.Money;
  const results = [];

  function test(name, fn) {
    try { fn(); results.push({ name, ok: true }); }
    catch (e) { results.push({ name, ok: false, err: e.message }); }
  }
  function eq(actual, expected, msg) {
    const a = JSON.stringify(actual), b = JSON.stringify(expected);
    if (a !== b) throw new Error((msg ? msg + ': ' : '') + `expected ${b}, got ${a}`);
  }
  function ok(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
  const sum = arr => arr.reduce((a, b) => a + b, 0);

  // Seeded RNG so failures are reproducible
  let seed = 12345;
  const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const randInt = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));

  /** Apply transfers to balances; every balance must end up at exactly 0. */
  function applyTransfers(balances, transfers) {
    const b = Object.assign({}, balances);
    transfers.forEach(t => { b[t.from] += t.amount; b[t.to] -= t.amount; });
    return b;
  }
  function assertClears(balances, transfers) {
    transfers.forEach(t => ok(t.amount > 0 && Number.isInteger(t.amount), 'payment amounts must be positive integers'));
    transfers.forEach(t => ok(t.from !== t.to, 'nobody pays themselves'));
    const after = applyTransfers(balances, transfers);
    for (const id in after) if (after[id] !== 0) throw new Error(`${id} left with ${after[id]}`);
  }

  /** Brute force minimum: n minus the max number of zero-sum groups (independent of the DP). */
  function bruteMinPayments(vals) {
    vals = vals.filter(v => v !== 0);
    function maxGroups(list) {
      if (!list.length) return 0;
      const first = list[0], rest = list.slice(1);
      let best = 0;
      // choose a subset of `rest` that together with `first` sums to zero
      const m = rest.length;
      for (let mask = 0; mask < (1 << m); mask++) {
        let s = first;
        for (let i = 0; i < m; i++) if (mask & (1 << i)) s += rest[i];
        if (s !== 0) continue;
        const remaining = rest.filter((_, i) => !(mask & (1 << i)));
        best = Math.max(best, 1 + maxGroups(remaining));
      }
      return best;
    }
    return vals.length - maxGroups(vals);
  }

  /* ---------- parsing & formatting ---------- */
  test('parseMinor reads amounts as exact paise', () => {
    eq(M.parseMinor('450'), 45000);
    eq(M.parseMinor('12.5'), 1250);
    eq(M.parseMinor('0.1'), 10);
    eq(M.parseMinor('1,234.56'), 123456);
    eq(M.parseMinor('.75'), 75);
    eq(M.parseMinor('0.005'), 1, 'rounds half up');
    eq(M.parseMinor('0.004'), 0);
    ok(isNaN(M.parseMinor('abc')) && isNaN(M.parseMinor('')) && isNaN(M.parseMinor('1.2.3')) && isNaN(M.parseMinor('-5')));
  });

  test('formatMoney uses Indian grouping and 2 decimals', () => {
    eq(M.formatMoney(12345678, 'INR'), '₹1,23,456.78');
    eq(M.formatMoney(-45000, 'INR'), '−₹450.00');
    eq(M.formatMoney(6000, 'USD'), '$60.00');
  });

  /* ---------- splitting ---------- */
  test('₹100 split 3 ways = 33.34 + 33.33 + 33.33', () => {
    eq(Object.values(M.splitEqual(10000, ['a', 'b', 'c'])), [3334, 3333, 3333]);
  });
  test('₹1,000 split 3 ways keeps every paisa', () => {
    eq(Object.values(M.splitEqual(100000, ['a', 'b', 'c'])), [33334, 33333, 33333]);
  });
  test('₹0.02 split 3 ways', () => {
    eq(Object.values(M.splitEqual(2, ['a', 'b', 'c'])), [1, 1, 0]);
  });
  test('5,000 random equal splits always add up exactly', () => {
    for (let k = 0; k < 5000; k++) {
      const amt = randInt(1, 5000000), n = randInt(1, 12);
      const ids = Array.from({ length: n }, (_, i) => 'p' + i);
      const vals = Object.values(M.splitEqual(amt, ids));
      ok(sum(vals) === amt, `amt ${amt} / ${n} summed to ${sum(vals)}`);
      ok(Math.max(...vals) - Math.min(...vals) <= 1, 'shares differ by at most 1 paisa');
    }
  });
  test('Currency conversion: converted shares add up to converted total', () => {
    for (let k = 0; k < 3000; k++) {
      const n = randInt(1, 8);
      const amt = randInt(1, 1000000);
      const ids = Array.from({ length: n }, (_, i) => 'p' + i);
      const shares = M.splitEqual(amt, ids);
      const exp = { amountMinor: amt, currency: 'USD', rateToINR: 80 + rand() * 10, shares };
      const r = M.expenseINR(exp);
      ok(sum(Object.values(r.shares)) === r.total, 'INR shares must sum to INR total');
    }
  });
  test('$60 at ₹88.50 = ₹5,310.00', () => {
    const r = M.expenseINR({ amountMinor: 6000, currency: 'USD', rateToINR: 88.5, shares: { a: 3000, b: 3000 } });
    eq(r.total, 531000);
    eq(r.shares, { a: 265500, b: 265500 });
  });

  /* ---------- balances ---------- */
  test('Balances: payer is owed, others owe', () => {
    const trip = {
      people: [{ id: 'A' }, { id: 'B' }, { id: 'C' }],
      expenses: [{ amountMinor: 30000, currency: 'INR', paidBy: 'A', shares: M.splitEqual(30000, ['A', 'B', 'C']) }],
      settlements: []
    };
    eq(M.computeBalances(trip), { A: 20000, B: -10000, C: -10000 });
  });
  test('Balances: recording a payment reduces what the payer owes', () => {
    const trip = {
      people: [{ id: 'A' }, { id: 'B' }],
      expenses: [{ amountMinor: 10000, currency: 'INR', paidBy: 'A', shares: { A: 5000, B: 5000 } }],
      settlements: [{ from: 'B', to: 'A', amountMinor: 2000 }]
    };
    eq(M.computeBalances(trip), { A: 3000, B: -3000 });
  });
  test('Sample trip: balances sum to exactly zero', () => {
    let i = 0;
    const trip = window.SampleTrip.create(p => p + (i++));
    const b = M.computeBalances(trip);
    eq(sum(Object.values(b)), 0);
    assertClears(b, M.settleUp(b));
  });
  test('Random trips: balances always sum to zero', () => {
    for (let k = 0; k < 300; k++) {
      const n = randInt(2, 8);
      const people = Array.from({ length: n }, (_, i) => ({ id: 'p' + i }));
      const expenses = Array.from({ length: randInt(1, 15) }, () => {
        const parts = people.filter(() => rand() < 0.7).map(p => p.id);
        const ids = parts.length ? parts : [people[0].id];
        const amt = randInt(1, 2000000);
        const usd = rand() < 0.3;
        return { amountMinor: amt, currency: usd ? 'USD' : 'INR', rateToINR: usd ? 83 + rand() * 5 : 1,
          paidBy: people[randInt(0, n - 1)].id, shares: M.splitEqual(amt, ids) };
      });
      eq(sum(Object.values(M.computeBalances({ people, expenses, settlements: [] }))), 0, 'trip ' + k);
    }
  });

  /* ---------- settle up ---------- */
  test('Nobody owes anything: no payments', () => {
    eq(M.settleUp({ A: 0, B: 0 }), []);
  });
  test('One debtor, one creditor: "B pays A ₹450"', () => {
    eq(M.settleUp({ A: 45000, B: -45000 }), [{ from: 'B', to: 'A', amount: 45000 }]);
  });
  test('One payer for the group: everyone pays them (n−1 payments)', () => {
    const b = { A: 40000, B: -10000, C: -10000, D: -10000, E: -10000 };
    const t = M.settleUp(b);
    eq(t.length, 4);
    ok(t.every(x => x.to === 'A'));
    assertClears(b, t);
  });
  test('Two independent pairs: 2 payments, never 3', () => {
    const b = { A: 50000, B: -50000, C: 30000, D: -30000 };
    const t = M.settleUp(b);
    eq(t.length, 2);
    assertClears(b, t);
  });
  test('Case where greedy uses 4 payments but 3 is the minimum', () => {
    // {A+5, D-3, E-2} and {B+4, C-4} are separate zero-sum groups
    const b = { A: 500, B: 400, C: -400, D: -300, E: -200 };
    eq(M.greedySettle(Object.keys(b).map(id => ({ id, amt: b[id] }))).length, 4, 'greedy');
    const t = M.settleUp(b);
    eq(t.length, 3, 'optimal');
    assertClears(b, t);
  });
  test('Uneven paise: 3 people, ₹100 total, settles exactly', () => {
    const b = { A: 6666, B: -3333, C: -3333 };
    const t = M.settleUp(b);
    eq(t.length, 2);
    assertClears(b, t);
  });
  test('1,000 random groups: always clears, never worse than greedy, always the true minimum', () => {
    for (let k = 0; k < 1000; k++) {
      const n = randInt(2, 8);
      // Small values make zero-sum subgroups (and greedy failures) common
      const vals = Array.from({ length: n - 1 }, () => randInt(-6, 6) * (rand() < 0.5 ? 100 : 1));
      vals.push(-sum(vals));
      const b = {};
      vals.forEach((v, i) => { b['p' + i] = v; });
      const t = M.settleUp(b);
      assertClears(b, t);
      const nonZero = vals.filter(v => v !== 0).length;
      ok(t.length <= Math.max(0, nonZero - 1), 'at most n−1 payments');
      const g = M.greedySettle(Object.keys(b).map(id => ({ id, amt: b[id] }))).length;
      ok(t.length <= g, `worse than greedy for ${JSON.stringify(vals)}`);
      eq(t.length, bruteMinPayments(vals), `not minimal for ${JSON.stringify(vals)}`);
    }
  });
  test('Large group (20 people) falls back to greedy and still clears', () => {
    const b = {};
    let total = 0;
    for (let i = 0; i < 19; i++) { const v = randInt(-500000, 500000); b['p' + i] = v; total += v; }
    b.p19 = -total;
    const t = M.settleUp(b);
    assertClears(b, t);
    ok(t.length <= 19);
  });

  /* ---------- bill / UPI screenshot parsing ---------- */
  const B = window.BillParse;
  const TODAY = '2026-11-24';
  const parse = t => B.parse(t, { today: TODAY });
  function expectScan(text, want) {
    const got = parse(text);
    for (const k in want) eq(got[k], want[k], k);
  }

  test('Restaurant bill: grand total (not subtotal/tax), merchant, date', () => expectScan(
    `CAFE MOCHA
Baga Beach Road, Goa
GSTIN: 30ABCDE1234F1Z5
TAX INVOICE
Bill No: 1042   Table: 7
Date: 21/11/2026  Time: 21:14
Item          Qty   Amount
Prawn Curry    1    450.00
Fish Thali     2    640.00
Lime Soda      3    180.00
Sub Total          1,270.00
CGST 2.5%            31.75
SGST 2.5%            31.75
Round Off            -0.50
Grand Total   ₹ 1,333.00
Thank you! Visit again`,
    { kind: 'bill', merchant: 'Cafe Mocha', amountMinor: 133300, date: '2026-11-21', currency: 'INR' }));

  test('Card POS slip: skips bank name, TID/MID/card digits', () => expectScan(
    `HDFC BANK
SHELL FUEL STATION
PANJIM GOA
TID: 12345678 MID: 000012345678901
DATE: 22/11/26 TIME: 10:42:11
BATCH NO: 000123 INVOICE NO: 000456
SALE
CARD NO: XXXX XXXX XXXX 4321
AMOUNT: INR 2,000.00
APPR CODE: 654321
CUSTOMER COPY`,
    { kind: 'bill', merchant: 'Shell Fuel Station', amountMinor: 200000, date: '2026-11-22' }));

  test('Fuel pump slip: amount, not rate or volume', () => expectScan(
    `WELCOME
INDIAN OIL
COCO MARGAO
Receipt No: 8812
Date: 23-11-2026 Time: 08:15
Product: PETROL
Rate(Rs/L): 101.94
Volume(L): 9.81
Amount(Rs): 1000.00
Vehicle No: GA07AB1234
Thank you`,
    { kind: 'bill', merchant: 'Indian Oil', amountMinor: 100000, date: '2026-11-23' }));

  test('Foreign bill: USD, US-style date, total after tip', () => expectScan(
    `JOE'S DINER
123 Main St, New York
11/20/2026 8:15 PM
Burger 12.50
Fries 4.00
Subtotal $16.50
Tax $1.46
Tip $3.00
Total $20.96
VISA ****1234`,
    { kind: 'bill', merchant: "Joe's Diner", amountMinor: 2096, date: '2026-11-20', currency: 'USD' }));

  test('GPay screenshot: payee, amount, date, UPI ref', () => expectScan(
    `To Ravi Kumar
ravikumar@okhdfcbank
₹450
Completed
24 Nov 2026, 7:42 pm
UPI transaction ID
433012345678
To: RAVI KUMAR
From: Asha (HDFC Bank)
Google transaction ID
CICAgOCx1234`,
    { kind: 'upi', merchant: 'Ravi Kumar', amountMinor: 45000, date: '2026-11-24', currency: 'INR', ref: '433012345678' }));

  test('PhonePe screenshot: "Paid to" on its own line', () => expectScan(
    `Transaction Successful
07:42 pm on 24 Nov 2026
Paid to
GOA BEACH SHACK
₹ 1,250
Transfer Details
Transaction ID
T2611241942123456789
Debited from
XXXXXX1234
₹1,250
UTR: 433098765432`,
    { kind: 'upi', merchant: 'Goa Beach Shack', amountMinor: 125000, date: '2026-11-24' }));

  test('Paytm screenshot: date without a year', () => expectScan(
    `Paid Successfully to
Ravi
₹ 300
23 Nov, 07:42 PM
UPI Ref No: 433011112222
Paytm`,
    { kind: 'upi', merchant: 'Ravi', amountMinor: 30000, date: '2026-11-23', ref: '433011112222' }));

  test('UPI: "₹" misread as a leading 2 is corrected', () => expectScan(
    `Paid to Zoya
2450
Amount 450
UPI Ref No 433000000001`,
    { kind: 'upi', amountMinor: 45000 }));

  test('Dates: Indian day-first, ISO, month names; times are not years', () => {
    eq(B.findDate(['Date: 05/04/2026'], TODAY), '2026-04-05');
    eq(B.findDate(['2026-11-02 10:00'], TODAY), '2026-11-02');
    eq(B.findDate(['Nov 3, 2026'], TODAY), '2026-11-03');
    eq(B.findDate(['3rd November 2026'], TODAY), '2026-11-03');
    eq(B.findDate(['24 Nov, 19:42'], TODAY), '2026-11-24');
    eq(B.findDate(['Yesterday, 9:10 pm'], TODAY), '2026-11-23');
    eq(B.findDate(['Total 1234.00'], TODAY), null);
  });

  test('Nothing readable: fields come back empty, no crash', () => {
    const r = parse('~~ ### ~~');
    eq([r.amountMinor, r.date, r.merchant], [null, null, null]);
  });

  /* ---------- report ---------- */
  const passed = results.filter(r => r.ok).length;
  const out = document.getElementById('results');
  document.getElementById('summary').textContent = `${passed} / ${results.length} passed`;
  document.getElementById('summary').className = passed === results.length ? 'pass' : 'fail';
  out.innerHTML = results.map(r =>
    `<li class="${r.ok ? 'pass' : 'fail'}">${r.ok ? '✅' : '❌'} ${r.name}${r.ok ? '' : `<pre>${r.err.replace(/</g, '&lt;')}</pre>`}</li>`
  ).join('');
  document.title = (passed === results.length ? 'PASS ' : 'FAIL ') + document.title;
})();
