// Seeded synthetic dataset: 10 weeks (2-week warm-up + 8 scored weeks) of self-serve machine turns for a 3-store laundromat operator,
// with injected silent failures (ground truth). Run: node scripts/generate.mjs
// The page computes every number from data/data.js with core/health.js.
import fs from 'node:fs';

const SEED = 77031;
function mulberry32(a) { return function () { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const rnd = mulberry32(SEED);
function poisson(l) { let L = Math.exp(-l), k = 0, p = 1; do { k++; p *= rnd(); } while (p > L); return k - 1; }
function gauss() { let u = 0; while (u === 0) u = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rnd()); }
function pick(ws) { const s = ws.reduce((a, b) => a + b, 0); let r = rnd() * s; for (let i = 0; i < ws.length; i++) { r -= ws[i]; if (r <= 0) return i; } return ws.length - 1; }

const DAYS = 70;
const WARMUP_DAYS = 14; // the detector needs two weeks of history before it may alert
const START = Date.UTC(2026, 7, 31); // Mon Aug 31 2026 .. Sun Nov 8 2026 (local store time, stored as UTC-naive)
const HOURS = DAYS * 24;
const OPEN = 6, CLOSE = 23; // 6 AM - 11 PM

const stores = [
  { id: 'atl', name: 'Lather & Loop Atlantic', city: '612 Atlantic Ave, Brooklyn', traffic: 1.8, washers: [[20, 6], [30, 4], [40, 4], [60, 2]], dryers: [[30, 14]], brand: 'SPEED QUEEN' },
  { id: 'stw', name: 'Lather & Loop Steinway', city: '31-14 Steinway St, Astoria', traffic: 1.45, washers: [[20, 5], [30, 3], [40, 3], [60, 1]], dryers: [[30, 12]], brand: 'ALLIANCE: ACA' },
  { id: 'nwk', name: 'Lather & Loop Newark Ave', city: '488 Newark Ave, Jersey City', traffic: 1.15, washers: [[20, 4], [30, 3], [40, 2], [80, 1]], dryers: [[30, 10]], brand: 'DEXTER: C-Series' },
];
const PRICE = { 20: 4.25, 30: 5.75, 40: 7.5, 60: 10.5, 80: 13.0, dry: 0.25 * 8 };
const machines = [];
for (const s of stores) {
  let w = 1, d = 1;
  for (const [size, n] of s.washers) for (let i = 0; i < n; i++) {
    machines.push({ id: `${s.id}-W-${w}`, store: s.id, name: `W-${w}`, type: 'washer', size, group: `${s.id}:washer:${size}`, price: PRICE[size], pref: 0.6 + 0.8 * rnd(), model: `${s.brand} - Front-Load Washer, ${size}lb` }); w++;
  }
  for (const [size, n] of s.dryers) for (let i = 0; i < n; i++) {
    machines.push({ id: `${s.id}-D-${d}`, store: s.id, name: `D-${d}`, type: 'dryer', size, group: `${s.id}:dryer`, price: PRICE.dry, pref: 0.6 + 0.8 * rnd(), model: `${s.brand} - Tumbler, ${size}lb` }); d++;
  }
}
const byId = new Map(machines.map((m) => [m.id, m]));
const groups = new Map();
for (const m of machines) { if (!groups.has(m.group)) groups.set(m.group, []); groups.get(m.group).push(m); }

// hourly demand profile (per open hour), weekend heavier, evening peak
function profile(h, dow) {
  if (h < OPEN || h >= CLOSE) return 0;
  const x = (h - OPEN) / (CLOSE - OPEN);
  const shape = 0.45 + 0.9 * Math.exp(-((x - 0.25) ** 2) / 0.03) * (dow === 0 || dow === 6 ? 1.3 : 0.7) + 0.7 * Math.exp(-((x - 0.72) ** 2) / 0.02);
  return shape * (dow === 0 || dow === 6 ? 1.45 : 1.0);
}
const dayFactor = []; for (let d = 0; d < DAYS; d++) dayFactor.push(Math.exp(0.18 * gauss()) * (rnd() < 0.08 ? 0.55 : 1)); // occasional rain/holiday dips

// ---- ground-truth failures ----
// mode: dead (no payment taken, customers move on), nostart (payment taken, machine does not run), noheat (dryer runs cold)
const failures = [];
function addFailure(id, startHour, durHours, mode, note) { failures.push({ id, start: startHour, end: Math.min(HOURS, startHour + durHours), mode, note }); }
const H = (day, hour) => (day + WARMUP_DAYS) * 24 + hour; // failure days are counted from the end of the warm-up
addFailure('atl-W-3', H(9, 14), 30, 'nostart', 'door lock solenoid');
addFailure('atl-D-7', H(12, 2), 70, 'noheat', 'gas valve coil');
addFailure('stw-W-6', H(15, 19), 44, 'dead', 'reader power fault');
addFailure('nwk-D-4', H(18, 10), 26, 'nostart', 'start button');
addFailure('atl-W-9', H(22, 8), 20, 'dead', 'drain pump (error not reported on pulse machine)');
addFailure('stw-D-2', H(25, 16), 52, 'noheat', 'thermal fuse');
addFailure('nwk-W-2', H(28, 21), 36, 'nostart', 'coin mech jam');
addFailure('atl-D-12', H(31, 11), 22, 'dead', 'belt');
addFailure('stw-W-1', H(34, 9), 28, 'nostart', 'door switch');
addFailure('atl-W-14', H(38, 13), 60, 'dead', 'control board');
addFailure('nwk-D-9', H(41, 6), 40, 'noheat', 'igniter');
addFailure('stw-W-10', H(45, 17), 33, 'dead', 'water inlet valve');
addFailure('atl-D-3', H(48, 12), 50, 'nostart', 'door switch');
// still open at the end of the data ("now" = Sun Nov 8 2026, 8 PM)
addFailure('atl-W-5', H(55, 14), 999, 'nostart', 'door lock solenoid');
addFailure('stw-D-9', H(55, 11), 999, 'noheat', 'gas valve coil');
addFailure('nwk-W-8', H(55, 9), 999, 'dead', 'reader fault');
const END_HOUR = H(55, 20); // = absolute day 69, 8 PM // data ends at 8 PM on day 55
function failureAt(id, t) { return failures.find((f) => f.id === id && t >= f.start && t < f.end); }

// ---- customers (cards) ----
const nCards = 2600; let cardSeq = 1000;
const newCard = () => 'C' + (cardSeq + Math.floor(rnd() * nCards));

const turns = [];   // [hour, minute, machineId, cardId|null, amount, flag]  flag: 'r' = relocation follow-up (debug only, stripped)
const refunds = []; // [hour, machineId, amount, source]
const calls = [];   // [hour, machineId|null, reason]  Cents Assist machine-diagnostics calls
function choose(group, t, exclude) {
  const ms = groups.get(group).filter((m) => m.id !== exclude && !(failureAt(m.id, t) && failureAt(m.id, t).mode === 'dead' && rnd() < 0.97));
  return ms[pick(ms.map((m) => m.pref))];
}
for (let t = 0; t < Math.min(HOURS, END_HOUR + 1); t++) {
  const day = Math.floor(t / 24), h = t % 24, dow = new Date(START + day * 86400000).getUTCDay();
  const p = profile(h, dow) * dayFactor[day];
  if (p === 0) continue;
  for (const s of stores) {
    for (const [size] of s.washers) {
      const lam = s.traffic * p * (size === 20 ? 1.9 : size === 30 ? 1.3 : size === 40 ? 1.0 : 0.45);
      const n = poisson(lam);
      for (let k = 0; k < n; k++) {
        const card = rnd() < 0.66 ? newCard() : null;
        const minute = Math.floor(rnd() * 60);
        let m = choose(`${s.id}:washer:${size}`, t);
        if (!m) continue;
        const f = failureAt(m.id, t);
        turns.push([t, minute, m.id, card, m.price, 0]);
        let ran = m;
        if (f && f.mode === 'nostart') {
          // paid, did not start: most card customers move to a sibling within minutes; some ask for refunds
          if (rnd() < 0.8) {
            const m2 = choose(m.group, t, m.id);
            const mm = minute + 1 + Math.floor(rnd() * 5);
            if (m2) { turns.push([t + Math.floor(mm / 60), mm % 60, m2.id, card, m2.price, 1]); ran = m2; }
          }
          if (rnd() < 0.22) calls.push([t + (rnd() < 0.5 ? 0 : 1), m.id, 'machine did not start']);
          if (rnd() < 0.3) refunds.push([t + 1 + Math.floor(rnd() * 3), m.id, m.price, rnd() < 0.5 ? 'assist' : 'attendant']);
        } else if (card && rnd() < 0.015) {
          // normal noise: picked the wrong machine / changed mind
          const m2 = choose(m.group, t, m.id); const mm = minute + 1 + Math.floor(rnd() * 5);
          if (m2) turns.push([t + Math.floor(mm / 60), mm % 60, m2.id, card, m2.price, 1]);
        }
        if (rnd() < 0.002) refunds.push([t + 1, m.id, m.price, 'attendant']);
        // dryer use ~40 min later
        if (rnd() < 0.85) {
          const td = t + (minute + 38 + Math.floor(rnd() * 10) >= 60 ? 1 : 0);
          if (td >= HOURS || profile(td % 24, dow) === 0) continue;
          const dm = (minute + 38 + Math.floor(rnd() * 10)) % 60;
          const d = choose(`${s.id}:dryer`, td);
          if (!d) continue;
          const fd = failureAt(d.id, td);
          turns.push([td, dm, d.id, card, d.price * (1 + Math.floor(rnd() * 2)), 0]);
          if (fd && fd.mode === 'nostart') {
            if (rnd() < 0.8) { const d2 = choose(d.group, td, d.id); const mm = dm + 1 + Math.floor(rnd() * 5); if (d2) turns.push([td + Math.floor(mm / 60), mm % 60, d2.id, card, d2.price, 1]); }
            if (rnd() < 0.2) calls.push([td, d.id, 'dryer did not start']);
            if (rnd() < 0.25) refunds.push([td + 1, d.id, d.price, 'assist']);
          } else if (fd && fd.mode === 'noheat') {
            // runs a full cycle cold; most customers re-dry within the hour, often on another dryer
            if (rnd() < 0.7) {
              const d2 = rnd() < 0.75 ? choose(d.group, td, d.id) : d; const mm = dm + 42 + Math.floor(rnd() * 12);
              if (d2 && td + Math.floor(mm / 60) < HOURS) turns.push([td + Math.floor(mm / 60), mm % 60, d2.id, card, d2.price, 2]);
            }
            if (rnd() < 0.12) calls.push([td + 1, d.id, 'clothes still wet']);
            if (rnd() < 0.08) refunds.push([td + 1, d.id, d.price, 'assist']);
          } else if (card && rnd() < 0.1) {
            // heavy loads: normal re-dry
            const d2 = rnd() < 0.5 ? choose(d.group, td, d.id) : d; const mm = dm + 42 + Math.floor(rnd() * 12);
            if (d2 && td + Math.floor(mm / 60) < HOURS) turns.push([td + Math.floor(mm / 60), mm % 60, d2.id, card, d2.price, 2]);
          }
        }
      }
    }
  }
}
// unrelated calls with no machine attached (noise)
for (let i = 0; i < 120; i++) { const t = Math.floor(rnd() * END_HOUR); if (profile(t % 24, 1) > 0) calls.push([t, null, 'hours / pricing question']); }

turns.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
const clean = turns.filter((x) => x[0] <= END_HOUR).map((x) => x.slice(0, 5)); // the flag is generator bookkeeping only
const data = {
  generatedBy: 'scripts/generate.mjs', seed: SEED, startISO: new Date(START).toISOString().slice(0, 10), days: DAYS, warmupDays: WARMUP_DAYS, endHour: END_HOUR, open: OPEN, close: CLOSE,
  operator: 'Lather & Loop Laundromats',
  stores: stores.map(({ id, name, city }) => ({ id, name, city })),
  machines: machines.map(({ pref, ...m }) => m),
  turns: clean, refunds: refunds.filter((r) => r[0] <= END_HOUR).sort((a, b) => a[0] - b[0]), calls: calls.filter((c) => c[0] <= END_HOUR).sort((a, b) => a[0] - b[0]),
};
fs.mkdirSync('data', { recursive: true });
fs.writeFileSync('data/data.js', 'window.CENTS_DATA = ' + JSON.stringify(data) + ';\n');
fs.writeFileSync('data/truth.json', JSON.stringify({ seed: SEED, failures }, null, 1));
// the page loads ground truth separately, only to score the backtest; the detector never sees it
fs.writeFileSync('data/truth.js', 'window.CENTS_TRUTH = ' + JSON.stringify({ seed: SEED, failures }) + ';\n');
console.log(`machines=${machines.length} turns=${clean.length} refunds=${data.refunds.length} calls=${data.calls.length} failures=${failures.length} bytes=${fs.statSync('data/data.js').size}`);
