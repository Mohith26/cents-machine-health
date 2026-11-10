import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const H = require('../core/health.js');

const raw = fs.readFileSync(new URL('../data/data.js', import.meta.url), 'utf8');
const data = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
const truth = JSON.parse(fs.readFileSync(new URL('../data/truth.json', import.meta.url), 'utf8')).failures;
const R = H.run(data);

test('log-gamma, Poisson, negative binomial and binomial log-likelihoods', () => {
  assert.ok(Math.abs(H.lgamma(5) - Math.log(24)) < 1e-10);
  assert.ok(Math.abs(H.lgamma(0.5) - Math.log(Math.sqrt(Math.PI))) < 1e-10);
  assert.ok(Math.abs(H.logPois(3, 2) - Math.log(Math.exp(-2) * 8 / 6)) < 1e-12);
  // NB -> Poisson as the size grows
  assert.ok(Math.abs(H.logNB(3, 2, 1e6) - H.logPois(3, 2)) < 1e-4);
  // NB sums to one
  let s = 0; for (let k = 0; k < 400; k++) s += Math.exp(H.logNB(k, 1.7, 2)); assert.ok(Math.abs(s - 1) < 1e-9);
  assert.ok(Math.abs(H.logBinom(2, 5, 0.3) - Math.log(10 * 0.09 * 0.343)) < 1e-12);
});

test('relocation and re-dry features are found from card sequences', () => {
  const tiny = {
    endHour: 30, open: 0, close: 24,
    machines: [
      { id: 'a-W-1', store: 'a', type: 'washer', group: 'a:w', name: 'W-1' }, { id: 'a-W-2', store: 'a', type: 'washer', group: 'a:w', name: 'W-2' },
      { id: 'a-D-1', store: 'a', type: 'dryer', group: 'a:d', name: 'D-1' }, { id: 'a-D-2', store: 'a', type: 'dryer', group: 'a:d', name: 'D-2' },
    ],
    turns: [
      [10, 5, 'a-W-1', 'C1', 4], [10, 8, 'a-W-2', 'C1', 4],     // relocation W-1 -> W-2 after 3 min
      [10, 50, 'a-D-1', 'C1', 2], [11, 38, 'a-D-2', 'C1', 2],   // re-dry 48 min later
      [12, 0, 'a-W-1', 'C2', 4], [12, 20, 'a-W-2', 'C2', 4],    // 20 min later: not a relocation
      [13, 0, 'a-W-1', null, 4],                                 // coin turn: no card trail
    ],
    refunds: [[11, 'a-W-1', 4, 'assist']], calls: [[11, 'a-W-1', 'machine did not start'], [12, null, 'hours']],
  };
  const F = H.features(tiny);
  const i = (id) => F.idx.get(id);
  assert.equal(F.reloc[i('a-W-1')][10], 1);
  assert.equal(F.reloc[i('a-W-1')][12], 0);
  assert.equal(F.redry[i('a-D-1')][10], 1);
  assert.equal(F.card[i('a-W-1')][13], 0); assert.equal(F.n[i('a-W-1')][13], 1);
  assert.equal(F.refund[i('a-W-1')][11], 1); assert.equal(F.call[i('a-W-1')][11], 1);
});

test('forward filter equals brute-force path enumeration on a short sequence', () => {
  const i = R.F.idx.get('atl-D-3');
  const t0 = truth.find((f) => f.id === 'atl-D-3').start - 2; // a window that straddles a failure onset
  const T = 6;
  // build a sliced copy so the filter starts at t0 with the same prior
  const F2 = { ...R.F, T, M: [R.F.M[i]], n: [R.F.n[i].slice(t0, t0 + T)], card: [R.F.card[i].slice(t0, t0 + T)], reloc: [R.F.reloc[i].slice(t0, t0 + T)], redry: [R.F.redry[i].slice(t0, t0 + T)], refund: [R.F.refund[i].slice(t0, t0 + T)], call: [R.F.call[i].slice(t0, t0 + T)] };
  const lam2 = [R.lam[i].slice(t0, t0 + T)];
  const d2 = { ...data, open: 0, close: 24, warmupDays: 0 };
  const post = H.filterMachine(F2, lam2, R.P, d2, 0);
  const P = R.P, S = H.STATES;
  const prior = [0.997, 0.001, 0.001, 0.001];
  const stay = 1 - 3 * P.hazard;
  const A = (a, b) => (a === 0 ? (b === 0 ? stay : P.hazard) : (b === 0 ? P.repair : a === b ? 1 - P.repair : 0));
  const em = (t, s) => { const e = H.emissionTerms(F2, lam2, P, 0, t, S[s]); return e ? Math.exp(e.avoid + e.reloc + e.redry + e.refund + e.call) : 0; };
  for (let tt = 0; tt < T; tt++) {
    const marg = [0, 0, 0, 0];
    const rec = (t, s, w) => { // w: weight up to and including state s at time t
      if (t === tt) { marg[s] += w; return; }
      for (let s2 = 0; s2 < 4; s2++) { const a = A(s, s2); if (a) rec(t + 1, s2, w * a * em(t + 1, s2)); }
    };
    for (let s0 = 0; s0 < 4; s0++) { // prior -> first transition, as in the filter
      let w = 0; for (let sp = 0; sp < 4; sp++) w += prior[sp] * A(sp, s0);
      rec(0, s0, w * em(0, s0));
    }
    const z = marg.reduce((a, b) => a + b, 0);
    for (let s = 0; s < 4; s++) assert.ok(Math.abs(marg[s] / z - post[tt][s]) < 1e-9, `t=${tt} s=${s}`);
  }
});

test('detector beats the "no turns for N open hours" rules on the 8 scored weeks', () => {
  const eps = R.post.map((p) => H.episodes(p, 0.9));
  const s = H.score(data, R.F, eps, truth);
  assert.ok(s.caught >= 10, `caught ${s.caught}`);
  assert.ok(s.falsePerWeek <= 1, `false alarms/week ${s.falsePerWeek}`);
  const r12 = H.score(data, R.F, R.F.M.map((_, i) => H.ruleEpisodes(R.F, data, i, 12)), truth);
  assert.ok(s.caught > r12.caught && s.falseAlarms < r12.falseAlarms);
  // every finished "takes payment, doesn't start" failure leaves a relocation trail and is caught
  for (const f of truth.filter((x) => x.mode === 'nostart' && x.end <= data.endHour)) assert.ok(s.perFailure.find((p) => p.id === f.id).delay != null, f.id);
});

test('probabilities are ordered: higher P(broken) bins contain more truly broken hours', () => {
  const rel = H.reliability(data, R.F, R.post, truth).filter((g) => g.n > 30);
  for (let k = 1; k < rel.length; k++) assert.ok(rel[k].rate >= rel[k - 1].rate, `bin ${k}`);
  assert.ok(rel[0].rate < 0.01);
});

test('evidence decomposition sums to the per-hour log-likelihood ratio', () => {
  const i = R.F.idx.get('atl-W-5'); const a = data.endHour - 6, b = data.endHour;
  const ev = H.evidence(R.F, R.lam, R.P, data, i, a, b, 'nostart');
  let tot = 0;
  for (let t = a; t <= b; t++) { if (!H.isOpen(data, t)) continue; const eB = H.emissionTerms(R.F, R.lam, R.P, i, t, 'nostart'), eW = H.emissionTerms(R.F, R.lam, R.P, i, t, 'ok'); tot += (eB.avoid + eB.reloc + eB.redry + eB.refund + eB.call) - (eW.avoid + eW.reloc + eW.redry + eW.refund + eW.call); }
  const sum = Object.values(ev).reduce((x, y) => x + y, 0);
  assert.ok(Math.abs(sum - tot) < 1e-9);
  assert.ok(ev.reloc > 0);
});

test('fitted dispersion is finite and within bounds; no alert can fire during the warm-up', () => {
  assert.ok(R.P.disp >= 2 && R.P.disp <= 50);
  const w = data.warmupDays * 24;
  for (const p of R.post) for (let t = 0; t < w; t++) assert.ok(1 - p[t][0] < 0.5);
});

test('refund and call exposure looks back four hours', () => {
  const tiny = { endHour: 10, open: 0, close: 24, machines: [{ id: 'a-W-1', store: 'a', type: 'washer', group: 'a:w', name: 'W-1' }],
    turns: [[2, 0, 'a-W-1', null, 4], [3, 0, 'a-W-1', null, 4]], refunds: [[5, 'a-W-1', 4, 'assist']], calls: [] };
  const F = H.features(tiny);
  const lam = [new Float64Array(11).fill(0.5)];
  const P = H.params(F, {});
  const e5 = H.emissionTerms(F, lam, P, 0, 5, 'nostart'), w5 = H.emissionTerms(F, lam, P, 0, 5, 'ok');
  assert.ok(e5.refund > w5.refund, 'a refund two hours after turns is evidence for "takes payment, doesn\'t start"');
});

test('onset estimate lands near the true start for failures the detector caught', () => {
  const eps = R.post.map((p) => H.episodes(p, 0.9));
  const errs = [];
  for (const f of truth) {
    const i = R.F.idx.get(f.id); const e = eps[i].find((x) => x.start >= f.start - 3 && x.start < Math.min(f.end, R.F.T) + 3);
    if (!e) continue;
    const mode = H.STATES.slice(1).reduce((a, b) => (R.post[i][e.start][H.STATES.indexOf(b)] > R.post[i][e.start][H.STATES.indexOf(a)] ? b : a));
    const o = H.onset(R.F, R.lam, R.P, data, i, mode, e.start);
    errs.push(H.openHoursBetween(data, Math.min(o.start, f.start), Math.max(o.start, f.start)));
  }
  errs.sort((a, b) => a - b);
  assert.ok(errs.length >= 10);
  assert.ok(errs[Math.floor(errs.length / 2)] <= 4, `median onset error ${errs[Math.floor(errs.length / 2)]} open hours`);
});
