/* Sample "Goa weekend" trip, loaded on first run and from the Trip tab. */
(function (root) {
  'use strict';

  function create(uid) {
    const M = root.Money;
    const names = ['Asha', 'Ravi', 'Meera', 'Kabir', 'Zoya'];
    const people = names.map(name => ({ id: uid('p'), name }));
    const P = {};
    people.forEach(p => { P[p.name] = p.id; });
    const everyone = people.map(p => p.id);
    let t = Date.now();

    // E(description, amount in paise/cents, date, category, payer, split, foreign?)
    function E(description, amountMinor, date, category, payer, split, fx) {
      let shares;
      if (split && split.exact) {
        shares = {};
        for (const n in split.exact) shares[P[n]] = split.exact[n];
      } else {
        const ids = split && split.equal ? split.equal.map(n => P[n]) : everyone;
        shares = M.splitEqual(amountMinor, ids);
      }
      return {
        id: uid('e'), description, amountMinor,
        currency: fx ? fx.currency : 'INR',
        rateToINR: fx ? fx.rate : 1,
        rateNote: fx ? fx.note : '',
        date, category, paidBy: P[payer],
        splitMode: split && split.exact ? 'exact' : 'equal',
        shares, createdAt: t++
      };
    }

    const expenses = [
      E('Beach villa (2 nights)', 1200000, '2026-11-20', 'Stay', 'Ravi'),
      E('Taxi from airport', 145000, '2026-11-20', 'Transport', 'Kabir', { equal: ['Kabir', 'Zoya', 'Ravi'] }),
      E('Dinner at the beach shack', 100000, '2026-11-20', 'Food', 'Asha', { equal: ['Asha', 'Meera', 'Kabir'] }),
      E('Scooter rental', 210000, '2026-11-21', 'Transport', 'Asha'),
      E('Scuba diving', 750000, '2026-11-21', 'Activities', 'Meera', { exact: { Meera: 250000, Zoya: 250000, Asha: 250000 } }),
      E('Breakfast café', 84550, '2026-11-21', 'Food', 'Zoya'),
      E('Parasailing', 6000, '2026-11-22', 'Activities', 'Ravi', { equal: ['Ravi', 'Asha'] },
        { currency: 'USD', rate: 88.5, note: 'Sample rate' }),
      E('Souvenirs', 99900, '2026-11-22', 'Other', 'Kabir', { exact: { Kabir: 33300, Zoya: 66600 } })
    ];

    const settlements = [
      { id: uid('s'), from: P.Zoya, to: P.Ravi, amountMinor: 100000, date: '2026-11-22', createdAt: t++ }
    ];

    return {
      id: uid('t'), name: 'Goa weekend', createdAt: Date.now(),
      defaultCurrency: 'INR', people, expenses, settlements
    };
  }

  root.SampleTrip = { create };
})(typeof window !== 'undefined' ? window : globalThis);
