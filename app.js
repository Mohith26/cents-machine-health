/* Machine Health page. Every number on the page is computed here from data/data.js with core/health.js. */
(function () {
  'use strict';
  const D = window.CENTS_DATA, H = window.Health;
  const t0 = performance.now();
  const R = H.run(D);
  const F = R.F, M = F.M, T = D.endHour;
  const START = new Date(D.startISO + 'T00:00:00');
  const store = Object.fromEntries(D.stores.map((s) => [s.id, s]));
  const WATCH = 0.5;
  let TH = 0.9;

  // ---------- helpers ----------
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const pct = (p) => (p >= 0.995 ? '99%' : Math.round(p * 100) + '%');
  const money = (x) => '$' + x.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const dayOf = (t) => Math.floor(t / 24);
  const dateOf = (t) => new Date(START.getTime() + dayOf(t) * 864e5);
  const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  function clock(t) { const h = t % 24; return (h % 12 === 0 ? 12 : h % 12) + ':00' + (h < 12 ? 'am' : 'pm'); }
  function when(t) {
    const dd = dayOf(T) - dayOf(t);
    if (dd === 0) return 'Today ' + clock(t);
    if (dd === 1) return 'Yesterday ' + clock(t);
    const d = dateOf(t); return DOW[d.getDay()] + '. ' + String(d.getMonth() + 1).padStart(2, '0') + '/' + String(d.getDate()).padStart(2, '0') + ', ' + clock(t);
  }
  const shortDate = (t) => { const d = dateOf(t); return (d.getMonth() + 1) + '/' + d.getDate(); };
  const pb = (i, t) => 1 - R.post[i][t][0];
  const modeAt = (i, t) => { const p = R.post[i][t]; let k = 1; for (let s = 2; s < 4; s++) if (p[s] > p[k]) k = s; return H.STATES[k]; };
  const sum = (arr, a, b) => { let s = 0; for (let t = Math.max(0, a); t <= Math.min(b, arr.length - 1); t++) s += arr[t]; return s; };
  function sumOpen(arr, a, b) { let s = 0; for (let t = Math.max(0, a); t <= b; t++) if (H.isOpen(D, t)) s += arr[t]; return s; }
  // a log-likelihood ratio shown as an odds multiplier (x15k = this signal makes the failure 15,000x more likely)
  function odds(l) { const r = Math.exp(l); if (r >= 1e6) return '×' + (r / 1e6).toFixed(1) + 'M'; if (r >= 1e3) return '×' + Math.round(r / 1e3) + 'k'; if (r >= 10) return '×' + Math.round(r); return '×' + r.toFixed(1); }
  const toast = (msg) => { const el = $('#toast'); el.textContent = msg; el.classList.add('on'); clearTimeout(toast.h); toast.h = setTimeout(() => el.classList.remove('on'), 2600); };

  // revenue and turns per machine over a span
  const rev = M.map(() => new Float64Array(F.T));
  for (const [h, , id, , amt] of D.turns) rev[F.idx.get(id)][h] += amt;

  // ---------- current state ----------
  const today0 = dayOf(T) * 24;
  const state = M.map((m, i) => {
    const p = pb(i, T);
    const mode = modeAt(i, T);
    return { i, m, p, mode, since: H.onset(F, R.lam, R.P, D, i, mode, T).start };
  });
  const alerts = state.filter((x) => x.p >= WATCH).sort((a, b) => b.p - a.p);
  const level = (p) => (p >= TH ? 'red' : p >= WATCH ? 'amber' : 'green');
  const marked = new Set();

  // ---------- header ----------
  function renderCounters() {
    const nRed = state.filter((x) => x.p >= TH).length, nAmb = state.filter((x) => x.p >= WATCH && x.p < TH).length;
    $('#counters').innerHTML =
      `<div class="counter"><b>${M.length}</b>Machines monitored</div>` +
      `<div class="counter red"><b>${nRed}</b>Likely out of order</div>` +
      `<div class="counter amber"><b>${nAmb}</b>Watching</div>`;
  }
  $('#nowLabel').textContent = `As of ${when(T)} · ${D.stores.length} locations · updated every hour from card turns, refunds and Cents Assist calls`;
  $('#alertRule').innerHTML = `Alert at <b>${pct(TH)}</b> · watch at <b>${pct(WATCH)}</b>`;

  // ---------- needs attention ----------
  const charts = [];
  function evidenceRows(x) {
    const ev = H.evidence(F, R.lam, R.P, D, x.i, x.since, T, x.mode);
    const rows = [['avoid', 'Turns vs. what the store predicts'], ['reloc', 'Customers moved to a sibling'], ['redry', 'Dried again right after'], ['refund', 'Refunds naming this machine'], ['call', 'Cents Assist calls']];
    const shown = rows.filter(([k]) => k !== 'redry' || x.m.type === 'dryer');
    const max = Math.max(1, ...shown.map(([k]) => Math.max(0, ev[k])));
    return shown.map(([k, label]) => `<div class="ev-row"><span>${label}</span><div class="ev-bar"><i style="width:${(Math.max(0, ev[k]) / max * 100).toFixed(0)}%"></i></div><span class="v" title="likelihood ratio, failure vs working">${odds(ev[k])}</span></div>`).join('');
  }
  function facts(x) {
    const i = x.i, a = x.since, b = T;
    const obs = sumOpen(F.n[i], a, b), exp = sumOpen(R.lam[i], a, b), card = sum(F.card[i], a, b);
    const reloc = sum(F.reloc[i], a, b), redry = sum(F.redry[i], a, b), refunds = sum(F.refund[i], a, b), refundAmt = sum(F.refundAmt[i], a, b);
    const calls = D.calls.filter((c) => c[1] === x.m.id && c[0] >= a && c[0] <= b);
    const name = x.m.name, kind = x.m.type === 'dryer' ? `${x.m.size}lb dryer` : `${x.m.size}lb washer`;
    const callTxt = calls.length ? ` ${calls.length} Cents Assist ${calls.length === 1 ? 'call' : 'calls'} named it ("${esc(calls[0][2])}").` : '';
    const refTxt = refunds ? ` ${refunds} ${refunds === 1 ? 'refund' : 'refunds'} (${money(refundAmt)}).` : '';
    if (x.mode === 'nostart') return `<b>${reloc} of ${card}</b> card customers who started ${name} since ${when(a)} started another ${kind} within 7 minutes.${refTxt}${callTxt}`;
    if (x.mode === 'noheat') return `<b>${redry} of ${card}</b> card customers dried again 35 to 70 minutes after using ${name}.${refTxt}${callTxt}`;
    return `<b>${obs} ${obs === 1 ? 'turn' : 'turns'}</b> since ${when(a)}; the other ${kind}s' traffic predicts <b>${exp.toFixed(1)}</b>.${refTxt}${callTxt}`;
  }
  function renderAlerts() {
    charts.splice(0).forEach((c) => c.destroy());
    if (!alerts.length) { $('#alerts').innerHTML = '<div class="ct-sub">No machine is above the watch level.</div>'; return; }
    $('#alerts').innerHTML = alerts.map((x, k) => {
      const lv = level(x.p), st = store[x.m.store];
      const chip = lv === 'red' ? 'c-red' : 'c-amber';
      const act = marked.has(x.m.id)
        ? `<span class="marked"><i data-lucide="check"></i>Marked out of order</span>`
        : `<button class="btn outline" data-run="${x.m.id}"><i data-lucide="play"></i>Run Machine</button><button class="btn primary" data-mark="${x.m.id}">Mark out of order</button>`;
      return `<div class="alert">
        <div><div class="a-name">${x.m.name}<span class="chip ${chip}">${lv === 'red' ? 'Likely out of order' : 'Watch'}</span></div>
          <div class="a-model">${esc(x.m.model)}</div>
          <div class="a-loc">${esc(st.name)}<span>${esc(st.city)}</span></div></div>
        <div class="a-mid"><div class="top"><span class="prob ${lv}">${pct(x.p)}</span><b>${H.LABEL[x.mode]}</b><span class="since">· likely since ${when(x.since)}</span></div>
          <div class="cause">${facts(x)}</div><div class="ev">${evidenceRows(x)}</div></div>
        <div><div class="a-cap"><span>Turns per hour, last 48h</span><span>— expected</span></div><div class="a-chart"><canvas id="ac${k}"></canvas></div><div class="a-actions">${act}</div></div>
      </div>`;
    }).join('');
    alerts.forEach((x, k) => charts.push(turnChart($('#ac' + k), x.i, T - 47, T, false)));
    lucide.createIcons();
  }
  $('#alerts').addEventListener('click', (e) => {
    const r = e.target.closest('[data-run]'), mk = e.target.closest('[data-mark]');
    if (r) toast(`Concept demo: this would start a technical service turn on ${r.dataset.run.split('-').slice(1).join('-')} so an attendant can confirm.`);
    if (mk) { marked.add(mk.dataset.mark); renderAlerts(); renderTable(); toast('Marked out of order. Customers will see it as unavailable in the app.'); }
  });

  // chart: actual turns (bars) vs expected (line), Cents chart palette
  function turnChart(canvas, i, a, b, withScore) {
    const labels = [], actual = [], expct = [], score = [];
    for (let t = a; t <= b; t++) { labels.push(t % 24 === 0 ? shortDate(t) : clock(t)); actual.push(H.isOpen(D, t) ? F.n[i][t] : null); expct.push(H.isOpen(D, t) ? +R.lam[i][t].toFixed(2) : null); score.push(+(pb(i, t) * 100).toFixed(1)); }
    const ds = [
      { type: 'bar', label: 'Turns', data: actual, backgroundColor: '#4f8fea', borderRadius: 2, barPercentage: 0.9, categoryPercentage: 0.9, yAxisID: 'y' },
      { type: 'line', label: 'Expected', data: expct, borderColor: '#303651', borderWidth: 1.5, pointRadius: 0, tension: 0.3, spanGaps: false, yAxisID: 'y' },
    ];
    if (withScore) ds.push({ type: 'line', label: 'Out-of-order score', data: score, borderColor: '#dc562e', backgroundColor: 'rgba(220,86,46,.10)', fill: true, borderWidth: 1.5, pointRadius: 0, tension: 0.2, yAxisID: 'y2' });
    return new Chart(canvas, {
      data: { labels, datasets: ds },
      options: {
        responsive: true, maintainAspectRatio: false, animation: false,
        plugins: { legend: { display: false }, tooltip: { backgroundColor: '#303651', titleFont: { family: 'Inter', size: 11 }, bodyFont: { family: 'Inter', size: 11 }, callbacks: { title: (it) => when(a + it[0].dataIndex) } } },
        scales: {
          x: { grid: { display: false }, ticks: { font: { family: 'Inter', size: 9 }, color: '#8891a8', maxRotation: 0, autoSkip: false,
            callback: (v, k) => { const t = a + k; return withScore ? (t % 24 === 0 ? DOW[dateOf(t).getDay()] + ' ' + shortDate(t) : '') : (t % 12 === 0 ? (t % 24 === 0 ? shortDate(t) : '12:00pm') : ''); } } },
          y: { beginAtZero: true, grid: { color: '#eef0f3' }, border: { display: false }, ticks: { font: { family: 'Inter', size: 9 }, color: '#8891a8', precision: 0, maxTicksLimit: 4 } },
          ...(withScore ? { y2: { position: 'right', min: 0, max: 100, grid: { display: false }, border: { display: false }, ticks: { font: { family: 'Inter', size: 9 }, color: '#dc562e', callback: (v) => v + '%', maxTicksLimit: 3 } } } : {}),
        },
      },
    });
  }

  // ---------- machine list ----------
  const wk0 = T - 7 * 24 + 1;
  const rows = state.map((x) => {
    const i = x.i;
    return { ...x, wkRev: sum(rev[i], wk0, T), wkTurns: sum(F.n[i], wk0, T), today: sum(F.n[i], today0, T), todayExp: sumOpen(R.lam[i], today0, T),
      reloc: sum(F.reloc[i], wk0, T), redry: sum(F.redry[i], wk0, T), refunds: sum(F.refund[i], wk0, T), calls: sum(F.call[i], wk0, T) };
  }).sort((a, b) => b.p - a.p || a.m.store.localeCompare(b.m.store) || a.m.name.localeCompare(b.m.name, undefined, { numeric: true }));
  function healthCell(x) {
    const lv = level(x.p);
    const color = lv === 'red' ? '#dc562e' : lv === 'amber' ? '#f90' : '#3fa01f';
    const label = lv === 'red' ? H.LABEL[x.mode] : lv === 'amber' ? 'Watch: ' + H.LABEL[x.mode].toLowerCase() : 'Healthy';
    return `<div class="hb"><span class="meter"><i style="width:${Math.max(4, x.p * 100).toFixed(0)}%;background:${color}"></i></span><span class="num">${pct(x.p)}</span></div><span class="sub">${label}</span>`;
  }
  function renderTable() {
    const q = ($('#q').value || '').toLowerCase();
    const list = rows.filter((x) => !q || (x.m.name + ' ' + x.m.model + ' ' + store[x.m.store].name).toLowerCase().includes(q));
    $('#showing').innerHTML = `Showing <b>${list.length}</b> machines in ${new Set(list.map((x) => x.m.store)).size} locations`;
    $('#pager').innerHTML = `<span>1–${list.length} of ${list.length}</span><i data-lucide="chevron-left"></i><i data-lucide="chevron-right"></i>`;
    $('#machines tbody').innerHTML = list.map((x) => {
      const st = store[x.m.store];
      const status = marked.has(x.m.id) ? '<span class="dot d-red"></span>Out of order<span class="sub">Marked by you</span>' : '<span class="dot d-green"></span>Available<span class="sub">Last started ' + lastStart(x.i) + '</span>';
      const hot = (v) => (v >= 2 ? ' class="hot"' : '');
      return `<tr data-id="${x.m.id}"><td><b>${x.m.name}</b><span class="sub">${esc(x.m.model)}</span></td><td>${status}</td><td>${healthCell(x)}</td>
        <td class="num">${x.today} turns<span class="sub">expected ${x.todayExp.toFixed(1)}</span></td>
        <td class="num">${money(x.wkRev)}<span class="sub">${x.wkTurns} turns</span></td>
        <td><div class="sig"><span${hot(x.reloc)} title="Relocations"><i data-lucide="arrow-right-left"></i>${x.reloc}</span>${x.m.type === 'dryer' ? `<span${hot(x.redry)} title="Re-dries"><i data-lucide="rotate-ccw"></i>${x.redry}</span>` : ''}<span${hot(x.refunds)} title="Refunds"><i data-lucide="receipt"></i>${x.refunds}</span><span${hot(x.calls)} title="Cents Assist calls"><i data-lucide="phone"></i>${x.calls}</span></div></td>
        <td>${esc(st.name)}<span class="sub">${esc(st.city)}</span></td></tr>`;
    }).join('');
    lucide.createIcons();
  }
  const lastStartCache = new Map();
  function lastStart(i) {
    if (lastStartCache.has(i)) return lastStartCache.get(i);
    let s = 'over a week ago';
    for (let k = D.turns.length - 1; k >= 0; k--) { const tr = D.turns[k]; if (F.idx.get(tr[2]) === i) { s = when(tr[0]).replace(':00', ':' + String(tr[1]).padStart(2, '0')); break; } }
    lastStartCache.set(i, s); return s;
  }
  $('#q').addEventListener('input', renderTable);
  $('#machines tbody').addEventListener('click', (e) => { const tr = e.target.closest('tr[data-id]'); if (tr) openPanel(tr.dataset.id); });

  // ---------- details panel ----------
  let panelChart = null;
  function openPanel(id) {
    const x = rows.find((r) => r.m.id === id); if (!x) return;
    const lv = level(x.p), i = x.i;
    const a7 = T - 7 * 24 + 1;
    const calls = D.calls.filter((c) => c[1] === id && c[0] >= a7);
    const refs = D.refunds.filter((r) => r[1] === id && r[0] >= a7);
    const statusTxt = lv === 'green' ? 'Healthy' : H.LABEL[x.mode];
    $('#panel').innerHTML = `
      <div class="p-head"><h2>${x.m.name}</h2><span class="p-type">${x.m.type === 'dryer' ? 'Dryer' : 'Washer'}</span><span class="sp"></span><button title="More"><i data-lucide="ellipsis"></i></button><button id="pclose" title="Close"><i data-lucide="x"></i></button></div>
      <div class="p-tabs"><span>Details</span><span>Pricing &amp; Settings</span><span>Turns</span><span>Coin Ledger</span><span class="on">Health</span></div>
      <div class="p-status"><i data-lucide="washing-machine" style="width:30px;height:30px"></i><div><div class="t1 ${lv}">${statusTxt} · ${pct(x.p)}</div><div class="t2">Last started ${lastStart(i)}</div></div><span class="sp"></span><button class="btn primary" data-run="${id}">Run Machine</button></div>
      <div class="p-ins">
        <div><i data-lucide="arrow-right-left"></i><span><b>${x.reloc}</b><small>Relocations<br>last 7 days</small></span></div>
        <div><i data-lucide="${x.m.type === 'dryer' ? 'rotate-ccw' : 'receipt'}"></i><span><b>${x.m.type === 'dryer' ? x.redry : x.refunds}</b><small>${x.m.type === 'dryer' ? 'Re-dries' : 'Refunds'}<br>last 7 days</small></span></div>
        <div><i data-lucide="activity"></i><span><b>${x.wkTurns}</b><small>Turns vs. ${sumOpen(R.lam[i], a7, T).toFixed(0)}<br>expected</small></span></div>
      </div>
      <div class="p-sec"><h4><i data-lucide="chart-column"></i>Turns and out-of-order score, last 7 days</h4><div class="p-chart"><canvas id="pc"></canvas></div></div>
      <div class="p-sec"><h4><i data-lucide="list"></i>What the score is based on</h4>${lv === 'green' ? '<div class="ct-sub">Turns, relocations, refunds and calls are in line with its neighbors.</div>' : '<div class="cause">' + facts(x) + '</div><div class="ev">' + evidenceRows(x) + '</div>'}</div>
      <div class="p-sec"><h4><i data-lucide="phone"></i>Refunds and Cents Assist calls, last 7 days</h4>${calls.length || refs.length ? '<ul class="p-list">' + [...refs.map((r) => [r[0], `Refund ${money(r[2])} (${r[3]})`]), ...calls.map((c) => [c[0], `Assist call: "${esc(c[2])}"`])].sort((p, q) => p[0] - q[0]).map(([t, s]) => `<li>${when(t)}: ${s}</li>`).join('') + '</ul>' : '<div class="ct-sub">None.</div>'}</div>`;
    $('#panel').classList.add('on'); $('#scrim').classList.add('on'); $('#panel').setAttribute('aria-hidden', 'false');
    lucide.createIcons();
    if (panelChart) panelChart.destroy();
    panelChart = turnChart($('#pc'), i, a7, T, true);
    $('#pclose').onclick = closePanel;
    $('#panel [data-run]').onclick = () => toast(`Concept demo: this would start a technical service turn on ${x.m.name}.`);
  }
  function closePanel() { $('#panel').classList.remove('on'); $('#scrim').classList.remove('on'); $('#panel').setAttribute('aria-hidden', 'true'); }
  $('#scrim').addEventListener('click', closePanel);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePanel(); });

  // ---------- backtest ----------
  const TRUTH = window.CENTS_TRUTH ? window.CENTS_TRUTH.failures : null;
  const w0 = D.warmupDays * 24;
  function renderBacktest() {
    $('#thVal').textContent = pct(TH);
    if (!TRUTH) { $('#cmp').innerHTML = ''; return; }
    const eps = R.post.map((p) => H.episodes(p, TH));
    const s = H.score(D, F, eps, TRUTH);
    const r6eps = M.map((_, i) => H.ruleEpisodes(F, D, i, 6)), r12eps = M.map((_, i) => H.ruleEpisodes(F, D, i, 12));
    const r6 = H.score(D, F, r6eps, TRUTH), r12 = H.score(D, F, r12eps, TRUTH);
    const weeks = (T + 1 - w0) / 168, nStores = D.stores.length;
    $('#btSub').textContent = `Replayed hour by hour over the ${Math.round(weeks)} weeks after a 2-week warm-up (${shortDate(w0)} to ${shortDate(T)}), against ${TRUTH.length} failures injected into the synthetic data`;
    const row = (name, x, cls) => `<tr class="${cls || ''}"><td>${name}</td><td class="big">${x.caught} <span class="ct-sub">of ${x.failures}</span></td><td class="big">${x.medianOpenDelay == null ? '–' : x.medianOpenDelay}</td><td class="big">${x.falseAlarms}</td><td class="num">${(x.falseAlarms / weeks / nStores).toFixed(2)}</td></tr>`;
    $('#cmp').innerHTML = `<thead><tr><th>Detector</th><th>Failures caught</th><th>Median open hours to alert</th><th>False alerts (${Math.round(weeks)} weeks)</th><th>False alerts per store per week</th></tr></thead><tbody>
      ${row(`Machine Health at ${pct(TH)}`, s, 'ours')}${row('No turns for 6 open hours', r6)}${row('No turns for 12 open hours', r12)}</tbody>`;
    // timeline: every machine with a real failure or a Machine Health false alert
    const ids = new Set(TRUTH.map((f) => f.id));
    M.forEach((m, i) => { for (const e of eps[i]) if (!TRUTH.some((f) => f.id === m.id && e.start >= f.start - 3 && e.start < Math.min(f.end, F.T) + 3) && !TRUTH.some((f) => f.id === m.id && e.start < f.start && (e.end == null || e.end > f.start))) ids.add(m.id); });
    const span = T + 1 - w0, X = (t) => ((t - w0) / span * 100).toFixed(2) + '%';
    const lines = [...ids].map((id) => {
      const i = F.idx.get(id), m = M[i], fs = TRUTH.filter((f) => f.id === id);
      let html = fs.map((f) => `<i class="f" style="left:${X(f.start)};width:${((Math.min(f.end, T + 1) - f.start) / span * 100).toFixed(2)}%" title="${H.LABEL[f.mode]}: ${esc(f.note)}"></i>`).join('');
      for (const e of r12eps[i]) html += `<i class="r" style="left:${X(e.start)}"></i>`;
      for (const e of eps[i]) {
        const ok = fs.some((f) => (e.start >= f.start - 3 && e.start < Math.min(f.end, F.T) + 3) || (e.start < f.start && (e.end == null || e.end > f.start)));
        html += `<i class="${ok ? 'h' : 'x'}" style="left:${X(e.start)}"></i>`;
      }
      const f0 = fs[0];
      return `<div class="tl-label">${store[m.store].name.replace('Lather & Loop ', '')} ${m.name} <span>${f0 ? '· ' + H.LABEL[f0.mode].toLowerCase() : '· no failure'}</span></div><div class="tl-track">${html}</div>`;
    });
    const ticks = []; for (let d = D.warmupDays; d <= dayOf(T); d += 7) ticks.push(`<span style="left:${X(d * 24)}">${DOW[dateOf(d * 24).getDay()]} ${shortDate(d * 24)}</span>`);
    $('#timeline').innerHTML = lines.join('') + `<div class="tl-axis">${ticks.join('')}<span style="left:100%">now</span></div>`;
    // reliability
    const rel = H.reliability(D, F, R.post, TRUTH, [0, 0.05, 0.5, 0.9, 0.95, 1.0001]).filter((g) => g.n);
    $('#rel').innerHTML = `<thead><tr><th>Score band (open hours)</th><th>Hours</th><th>Mean score</th><th>Machine really out of order</th></tr></thead><tbody>` +
      rel.map((g) => `<tr><td>${Math.round(g.lo * 100)}% to ${g.hi > 1 ? 100 : Math.round(g.hi * 100)}%</td><td class="num">${g.n.toLocaleString()}</td><td class="num">${pct(g.meanP)}</td><td class="num">${(g.rate * 100).toFixed(1)}%</td></tr>`).join('') + '</tbody>';
    const caughtByMode = (mode) => { const fs = s.perFailure.filter((p) => p.mode === mode); return `${fs.filter((p) => p.delay != null).length} of ${fs.length}`; };
    $('#methodNums').innerHTML = `Fitted from this operator's data: card-customer relocation rate on working machines <b>${(R.P.fitted.qW * 100).toFixed(2)}%</b>, normal re-dry rate <b>${(R.P.fitted.uW * 100).toFixed(1)}%</b>, refunds <b>${(R.P.fitted.phiW * 100).toFixed(2)}%</b> of turns, turn-count dispersion <b>${R.P.disp.toFixed(1)}</b>. At ${pct(TH)} it caught ${caughtByMode('nostart')} "takes payment, doesn't start", ${caughtByMode('noheat')} "runs without heat" and ${caughtByMode('dead')} "not being used" failures. Avoidance alone is slow on low-traffic machines, so a quiet 60lb washer can go unnoticed for a day; payment-trail failures are caught within hours. Scores are ranked well but not perfectly calibrated:`;
    renderCounters(); $('#alertRule').innerHTML = `Alert at <b>${pct(TH)}</b> · watch at <b>${pct(WATCH)}</b>`;
  }
  $('#th').addEventListener('input', (e) => { TH = +e.target.value; renderBacktest(); renderAlerts(); renderTable(); });

  // ---------- boot ----------
  $('#seed').textContent = D.seed;
  $('#dataDesc').textContent = `${D.operator}, ${D.stores.length} stores, ${M.length} machines, ${D.turns.length.toLocaleString()} turns, ${D.refunds.length} refunds and ${D.calls.length} Cents Assist calls over ${D.days} days`;
  Chart.defaults.font.family = 'Inter';
  renderCounters(); renderAlerts(); renderTable(); renderBacktest();
  lucide.createIcons();
  const qp = new URLSearchParams(location.search).get('machine'); if (qp) openPanel(qp);
  console.log(`Machine Health computed in ${Math.round(performance.now() - t0)} ms`);
})();
