/* Machine Health core (browser + node, no dependencies).
 *
 * Detects machines that are silently out of order from the payment/turn telemetry Cents already has:
 *   - avoidance: a machine's turns fall far below what its siblings' traffic predicts,
 *   - relocations: a card starts this machine and then a sibling of the same type within minutes,
 *   - re-dries: a card starts a dryer and starts a dryer again right after the cycle ends,
 *   - refunds and Cents Assist machine-diagnostics calls that name the machine.
 * A 4-state hidden Markov model per machine (working / dead / takes-payment-no-start / runs-without-heat)
 * is filtered hour by hour. The output is a posterior score per machine and the most likely failure mode;
 * the backtest reports how often high scores were real failures (reliability), which is not perfect.
 */
(function (root) {
  'use strict';
  const STATES = ['ok', 'dead', 'nostart', 'noheat'];
  const LABEL = { ok: 'Working', dead: 'Not being used', nostart: "Takes payment, doesn't start", noheat: 'Runs without heat' };

  function lgamma(x) { // Lanczos
    const g = 7, c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
    if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lgamma(1 - x);
    x -= 1; let a = c[0]; const t = x + g + 0.5;
    for (let i = 1; i < g + 2; i++) a += c[i] / (x + i);
    return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
  }
  const logPois = (k, l) => (l <= 0 ? (k === 0 ? 0 : -50) : k * Math.log(l) - l - lgamma(k + 1));
  // negative binomial with mean mu and size r (overdispersed counts: shoppers arrive in clumps)
  const logNB = (k, mu, r) => (mu <= 0 ? (k === 0 ? 0 : -50) : lgamma(k + r) - lgamma(r) - lgamma(k + 1) + r * Math.log(r / (r + mu)) + k * Math.log(mu / (r + mu)));
  const logBinom = (k, n, p) => (n === 0 ? 0 : lgamma(n + 1) - lgamma(k + 1) - lgamma(n - k + 1) + k * Math.log(Math.max(p, 1e-9)) + (n - k) * Math.log(Math.max(1 - p, 1e-9)));

  // ---------- features ----------
  // Hourly per-machine arrays: turns, card turns, relocations, re-dries, refunds, calls, sibling turns.
  function features(data, opts = {}) {
    const T = data.endHour + 1;
    const M = data.machines;
    const idx = new Map(M.map((m, i) => [m.id, i]));
    const groupOf = M.map((m) => m.group);
    const zeros = () => M.map(() => new Float64Array(T));
    const F = { T, M, idx, n: zeros(), card: zeros(), reloc: zeros(), redry: zeros(), refund: zeros(), refundAmt: zeros(), call: zeros(), groupTot: new Map() };
    const relocWin = opts.relocMinutes || 7;
    // per-card chronological turns to find follow-ups
    const byCard = new Map();
    for (const tr of data.turns) {
      const [h, mi, id, card] = tr; const i = idx.get(id);
      F.n[i][h] += 1;
      if (!F.groupTot.has(groupOf[i])) F.groupTot.set(groupOf[i], new Float64Array(T));
      F.groupTot.get(groupOf[i])[h] += 1;
      if (card) { F.card[i][h] += 1; if (!byCard.has(card)) byCard.set(card, []); byCard.get(card).push({ t: h * 60 + mi, h, i }); }
    }
    for (const list of byCard.values()) {
      list.sort((a, b) => a.t - b.t);
      for (let k = 0; k < list.length; k++) {
        const a = list[k];
        const isDryer = M[a.i].type === 'dryer';
        for (let j = k + 1; j < list.length; j++) {
          const b = list[j]; const dt = b.t - a.t;
          if (dt > 75) break;
          if (groupOf[b.i] !== groupOf[a.i]) continue;
          if (dt >= 1 && dt <= relocWin && b.i !== a.i) { F.reloc[a.i][a.h] += 1; break; }
          if (isDryer && dt >= 35 && dt <= 70) { F.redry[a.i][a.h] += 1; break; }
        }
      }
    }
    for (const [h, id, amt] of data.refunds) { const i = idx.get(id); if (i != null && h < T) { F.refund[i][h] += 1; F.refundAmt[i][h] += amt; } }
    for (const [h, id] of data.calls) { if (id == null) continue; const i = idx.get(id); if (i != null && h < T) F.call[i][h] += 1; }
    return F;
  }

  // Expected turns for machine i at hour t, conditioned on how busy the store actually was that hour:
  //   lambda = share_m * groupShare_g * (store turns at t excluding m)
  // share_m: the machine's trailing share of its group; groupShare_g: the group's trailing share of all
  // store turns. Both use days d-15 .. d-2 (an ongoing failure does not drag its own baseline down) and
  // are shrunk toward uniform. Conditioning on store traffic is what keeps rainy or slow days from
  // looking like failures.
  function expected(F, data) {
    const { T, M } = F; const days = Math.ceil(T / 24);
    const groupSize = new Map(); for (const m of M) groupSize.set(m.group, (groupSize.get(m.group) || 0) + 1);
    const storeTot = new Map();
    for (let i = 0; i < M.length; i++) {
      if (!storeTot.has(M[i].store)) storeTot.set(M[i].store, new Float64Array(T));
      const st = storeTot.get(M[i].store); for (let t = 0; t < T; t++) st[t] += F.n[i][t];
    }
    const daily = (arr) => { const d = new Float64Array(days); for (let t = 0; t < T; t++) d[Math.floor(t / 24)] += arr[t]; return d; };
    const trailing = (d, day) => { let s = 0; for (let e = Math.max(0, day - 15); e <= day - 2; e++) s += d[e]; return s; };
    const storeDaily = new Map([...storeTot].map(([k, v]) => [k, daily(v)]));
    const groupDaily = new Map([...F.groupTot].map(([k, v]) => [k, daily(v)]));
    const nGroupsInStore = new Map(); for (const g of F.groupTot.keys()) { const s = M.find((m) => m.group === g).store; nGroupsInStore.set(s, (nGroupsInStore.get(s) || 0) + 1); }
    const lam = M.map(() => new Float64Array(T));
    const share = M.map(() => new Float64Array(days));
    for (let i = 0; i < M.length; i++) {
      const g = M[i].group, s = M[i].store, k = groupSize.get(g);
      const dM = daily(F.n[i]), dG = groupDaily.get(g), dS = storeDaily.get(s);
      const st = storeTot.get(s);
      for (let d = 0; d < days; d++) {
        const sm = trailing(dM, d), sg = trailing(dG, d), ss = trailing(dS, d);
        share[i][d] = (sm + 40 / k) / (sg + 40);
        const gShare = (sg + 60 / nGroupsInStore.get(s)) / (ss + 60);
        for (let t = d * 24; t < Math.min(T, d * 24 + 24); t++) lam[i][t] = share[i][d] * gShare * (st[t] - F.n[i][t]) / Math.max(1 - share[i][d] * gShare, 0.05);
      }
    }
    return { lam, share };
  }

  // Working-state rates are estimated fleet-wide from the data (failures are rare, so pooled rates are
  // dominated by healthy hours); broken-state rates are documented priors.
  // Fleet-wide negative-binomial size r for the avoidance term, by moments on open hours after the warm-up:
  // E[(n - lam)^2 - n] = lam^2 / r  =>  1/r = sum((n - lam)^2 - n) / sum(lam^2). Clamped to [2, 50].
  function fitDispersion(F, lam, data) {
    let num = 0, den = 0;
    const t0 = (data.warmupDays || 0) * 24;
    for (let i = 0; i < F.M.length; i++) for (let t = t0; t < F.T; t++) {
      if (!isOpen(data, t)) continue;
      const n = F.n[i][t], l = lam[i][t];
      num += (n - l) * (n - l) - n; den += l * l;
    }
    const inv = den > 0 ? num / den : 0.5;
    return Math.min(50, Math.max(2, inv > 0 ? 1 / inv : 50));
  }

  function params(F, opts = {}, lam, data) {
    let card = 0, reloc = 0, dcard = 0, redry = 0, turns = 0, refunds = 0, calls = 0;
    for (let i = 0; i < F.M.length; i++) for (let t = 0; t < F.T; t++) {
      card += F.card[i][t]; reloc += F.reloc[i][t]; turns += F.n[i][t]; refunds += F.refund[i][t]; calls += F.call[i][t];
      if (F.M[i].type === 'dryer') { dcard += F.card[i][t]; redry += F.redry[i][t]; }
    }
    const qW = Math.min(0.05, (reloc + 1) / (card + 50));
    const uW = Math.min(0.25, (redry + 1) / (dcard + 50));
    const phiW = Math.min(0.01, (refunds + 1) / (turns + 100));
    const kapW = Math.min(0.01, (calls + 1) / (turns + 100));
    return {
      rho: { ok: 1, dead: 0.05, nostart: 1, noheat: 1 },           // turns relative to expected
      q: { ok: qW, dead: Math.max(qW, 0.25), nostart: 0.6, noheat: qW }, // relocation probability per card turn
      u: { ok: uW, dead: uW, nostart: uW, noheat: 0.55 },             // re-dry probability per dryer card turn
      phi: { ok: phiW, dead: phiW * 3, nostart: 0.2, noheat: 0.06 },  // refunds per turn
      kap: { ok: kapW, dead: kapW * 3, nostart: 0.15, noheat: 0.1 },  // machine-named calls per turn
      disp: opts.disp || (lam ? fitDispersion(F, lam, data) : 2), hazard: opts.hazard || 1 / 3000, repair: 1 / 72,                                 // per clock hour
      fitted: { qW, uW, phiW, kapW },
    };
  }

  const EXPOSURE_HOURS = 4;
  function exposure(F, i, t) { let e = 0; for (let k = Math.max(0, t - EXPOSURE_HOURS + 1); k <= t; k++) e += F.n[i][k]; return e / EXPOSURE_HOURS; }

  function emissionTerms(F, lam, P, i, t, s) {
    const isDryer = F.M[i].type === 'dryer';
    if (s === 'noheat' && !isDryer) return null; // impossible state for washers
    const n = F.n[i][t], c = F.card[i][t], l = lam[i][t];
    const base = 0.02; // floor so an empty hour is not infinitely informative
    return {
      avoid: logNB(n, (l + base) * P.rho[s], P.disp),
      reloc: logBinom(Math.min(F.reloc[i][t], c), c, P.q[s]),
      redry: isDryer ? logBinom(Math.min(F.redry[i][t], c), c, P.u[s]) : 0,
      // refunds and calls trail the failed start by 0-3 hours, so their exposure is the turns of the last 4 hours
      refund: logPois(F.refund[i][t], exposure(F, i, t) * P.phi[s] + 0.0005),
      call: logPois(F.call[i][t], exposure(F, i, t) * P.kap[s] + 0.0005),
    };
  }
  const sumTerms = (e) => e.avoid + e.reloc + e.redry + e.refund + e.call;

  function isOpen(data, t) { const h = t % 24; return h >= data.open && h < data.close; }

  // Forward filter for one machine. Returns P(state) per hour.
  function filterMachine(F, lam, P, data, i) {
    const T = F.T, S = STATES.length;
    const post = new Array(T);
    let a = [0.997, 0.001, 0.001, 0.001];
    if (F.M[i].type !== 'dryer') { a = [0.998, 0.001, 0.001, 0]; }
    const stay = 1 - 3 * P.hazard;
    for (let t = 0; t < T; t++) {
      // predict
      const pr = [
        a[0] * stay + (a[1] + a[2] + a[3]) * P.repair,
        a[0] * P.hazard + a[1] * (1 - P.repair),
        a[0] * P.hazard + a[2] * (1 - P.repair),
        F.M[i].type === 'dryer' ? a[0] * P.hazard + a[3] * (1 - P.repair) : 0,
      ];
      // update (closed hours carry no evidence)
      if (isOpen(data, t) && t >= (data.warmupDays || 0) * 24) {
        const ll = STATES.map((s) => { const e = emissionTerms(F, lam, P, i, t, s); return e ? sumTerms(e) : -Infinity; });
        const mx = Math.max(...ll);
        for (let s = 0; s < S; s++) pr[s] *= ll[s] === -Infinity ? 0 : Math.exp(ll[s] - mx);
      }
      const z = pr.reduce((x, y) => x + y, 0) || 1;
      a = pr.map((x) => x / z);
      post[t] = a;
    }
    return post;
  }

  function run(data, opts = {}) {
    const F = features(data, opts);
    const { lam, share } = expected(F, data);
    const P = params(F, opts, lam, data);
    const post = F.M.map((_, i) => filterMachine(F, lam, P, data, i));
    return { F, lam, share, P, post };
  }

  // Alert episodes: P(broken) crosses `th` upward; an episode ends when it falls below th/2.
  function episodes(post, th) {
    const out = []; let on = null;
    for (let t = 0; t < post.length; t++) {
      const pb = 1 - post[t][0];
      if (!on && pb >= th) on = { start: t, peak: pb };
      else if (on) { on.peak = Math.max(on.peak, pb); if (pb < th / 2) { on.end = t; out.push(on); on = null; } }
    }
    if (on) { on.end = null; out.push(on); }
    return out;
  }

  // Baseline rule an operator could set today: "no turns for N consecutive open hours".
  function ruleEpisodes(F, data, i, N) {
    const out = []; let quiet = 0, on = null;
    for (let t = (data.warmupDays || 0) * 24; t < F.T; t++) {
      if (!isOpen(data, t)) continue;
      if (F.n[i][t] > 0) { quiet = 0; if (on) { on.end = t; out.push(on); on = null; } continue; }
      quiet++;
      if (!on && quiet >= N) on = { start: t };
    }
    if (on) { on.end = null; out.push(on); }
    return out;
  }

  function openHoursBetween(data, a, b) { let k = 0; for (let t = a; t < b; t++) if (isOpen(data, t)) k++; return k; }

  // Score alert episodes against ground-truth failures.
  function score(data, F, episodesByMachine, truth, opts = {}) {
    const grace = opts.grace || 3;
    const res = { failures: truth.length, caught: 0, delays: [], openDelays: [], falseAlarms: 0, missed: [], perFailure: [] };
    for (const f of truth) {
      const i = F.idx.get(f.id);
      const eps = episodesByMachine[i] || [];
      const end = Math.min(f.end, F.T);
      const hit = eps.find((e) => e.start >= f.start && e.start < end) || eps.find((e) => e.start < f.start && (e.end == null || e.end > f.start));
      if (hit) {
        res.caught++; const t = Math.max(hit.start, f.start);
        res.delays.push(t - f.start); res.openDelays.push(openHoursBetween(data, f.start, t));
        res.perFailure.push({ id: f.id, mode: f.mode, delay: t - f.start, openDelay: openHoursBetween(data, f.start, t) });
      } else { res.missed.push(f.id); res.perFailure.push({ id: f.id, mode: f.mode, delay: null }); }
    }
    for (let i = 0; i < F.M.length; i++) for (const e of episodesByMachine[i] || []) {
      const ok = truth.some((f) => f.id === F.M[i].id && e.start >= f.start - grace && e.start < Math.min(f.end, F.T) + grace)
        || truth.some((f) => f.id === F.M[i].id && e.start < f.start && (e.end == null || e.end > f.start));
      if (!ok) res.falseAlarms++;
    }
    const med = (xs) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };
    res.medianDelay = med(res.delays); res.medianOpenDelay = med(res.openDelays);
    const weeks = (F.T - (data.warmupDays || 0) * 24) / 168;
    res.falsePerWeek = res.falseAlarms / weeks;
    return res;
  }

  // Per-signal evidence (log-likelihood ratio of the most likely broken mode vs working) over a span.
  function evidence(F, lam, P, data, i, a, b, mode) {
    const out = { avoid: 0, reloc: 0, redry: 0, refund: 0, call: 0 };
    for (let t = a; t <= b; t++) {
      if (!isOpen(data, t)) continue;
      const eB = emissionTerms(F, lam, P, i, t, mode), eW = emissionTerms(F, lam, P, i, t, 'ok');
      if (!eB) continue;
      for (const k in out) out[k] += eB[k] - eW[k];
    }
    return out;
  }

  // Most likely onset of the current failure: the start s of the suffix [s, T] with the largest summed
  // log-likelihood ratio (failure mode vs working), searched over the last `maxBack` hours (a CUSUM-style
  // change point). Closed hours contribute nothing.
  function onset(F, lam, P, data, i, mode, T, maxBack = 72) {
    let best = T, bestSum = -Infinity, acc = 0;
    for (let s = T; s >= Math.max((data.warmupDays || 0) * 24, T - maxBack); s--) {
      if (isOpen(data, s)) {
        const eB = emissionTerms(F, lam, P, i, s, mode), eW = emissionTerms(F, lam, P, i, s, 'ok');
        if (eB) acc += sumTerms(eB) - sumTerms(eW);
      }
      if (acc > bestSum) { bestSum = acc; best = s; }
    }
    // report the first open hour of the chosen suffix
    while (best < T && !isOpen(data, best)) best++;
    return { start: best, llr: bestSum };
  }

  // Reliability: bin open-hour P(broken) and compare with the truth.
  function reliability(data, F, post, truth, bins) {
    const B = bins || [0, 0.05, 0.2, 0.5, 0.8, 0.95, 1.0001];
    const agg = B.slice(0, -1).map((lo, k) => ({ lo, hi: B[k + 1], n: 0, sumP: 0, pos: 0 }));
    for (let i = 0; i < F.M.length; i++) {
      const id = F.M[i].id; const fs = truth.filter((f) => f.id === id);
      for (let t = 0; t < F.T; t++) {
        if (!isOpen(data, t)) continue;
        const p = 1 - post[i][t][0]; const k = agg.findIndex((g) => p >= g.lo && p < g.hi);
        const y = fs.some((f) => t >= f.start && t < f.end) ? 1 : 0;
        agg[k].n++; agg[k].sumP += p; agg[k].pos += y;
      }
    }
    return agg.map((g) => ({ ...g, meanP: g.n ? g.sumP / g.n : null, rate: g.n ? g.pos / g.n : null }));
  }

  const api = { STATES, LABEL, fitDispersion, lgamma, logPois, logNB, logBinom, features, expected, params, emissionTerms, filterMachine, run, episodes, ruleEpisodes, score, evidence, onset, reliability, isOpen, openHoursBetween };
  root.Health = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
