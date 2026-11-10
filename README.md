# Machine Health for Cents (concept demo)

**Live demo:** https://mohith26.github.io/cents-machine-health/

A concept feature for the Cents Business Manager: a **Machine Health** page under Machines that flags washers and dryers that are quietly out of order, using only data Cents already collects (card and coin turns from the Penny / Laundroworks readers, refunds, and Cents Assist calls). No new sensors.

> Unofficial concept demo by Mohith Gajjela. Not affiliated with Cents. All data is synthetic.

## Why

Machines that report an error code are easy. The expensive failures are the quiet ones: a pulse washer whose door lock fails still takes the tap but never starts; a dryer with a dead igniter tumbles cold for a full cycle; a machine with a dead reader just stops getting picked. Customers notice first, and they leave a trail in the turn data:

- a card customer pays for W-5 and, three minutes later, pays for W-4 (a **relocation**);
- a dryer customer pays again 45 minutes later because the clothes are still wet (a **re-dry**);
- a machine's turns fall far below what the rest of the store's traffic predicts (**avoidance**);
- refunds and Cents Assist calls name the machine.

Today an operator finds out from a review, an attendant, or a "no turns in N hours" rule, which is either slow or fires constantly.

## How it works (`core/health.js`, no dependencies)

- **Expected turns, conditioned on actual store traffic.** For machine *m* at hour *t*: share of its group (trailing days d-15..d-2, so an ongoing failure can't drag its own baseline down, shrunk toward uniform) × the group's share of the store × the store's actual turns that hour. Slow or rainy days don't look like failures.
- **Four-state hidden Markov model per machine:** working / not being used / takes payment but doesn't start / runs without heat (dryers only). Emissions per open hour:
  - turns: negative binomial around the expectation, dispersion **fitted from the fleet by moments**;
  - relocations: binomial over that hour's card turns;
  - re-dries: binomial over the dryer's card turns;
  - refunds and calls: Poisson against the machine's turns in the last 4 hours (they trail the failed start).
  Working-state rates are fitted from the operator's own data; failure-state rates are documented priors. A forward filter gives the posterior every hour; an alert fires when P(not working) crosses the threshold.
- **Explanations:** each alert shows the per-signal log-likelihood ratio (as an odds multiplier) and a CUSUM-style **change point** for when the failure most likely started.
- **Baseline:** "no turns for N consecutive open hours" rules, scored the same way.

## Results on the synthetic data

`node scripts/generate.mjs` builds 10 weeks (2-week warm-up + 8 scored weeks) for a 3-store operator with 74 machines and 45,221 turns, with 16 injected silent failures. `node scripts/report.mjs` prints:

| Detector | Caught | Median open hours to alert | False alerts in 8 weeks |
|---|---|---|---|
| Machine Health at 90% | 11 of 16 | 8 | 4 |
| No turns for 6 open hours | 10 of 16 | 4.5 | 1,871 |
| No turns for 12 open hours | 6 of 16 | 10.5 | 235 |

By failure type at 90%: 5 of 6 "takes payment, doesn't start" (the 6th is still open at the end of the data and sits at 81%, shown as Watch), 2 of 4 "runs without heat", 4 of 6 "not being used".

## Tests

```
node --test test/
```

9 tests: log-gamma / Poisson / negative binomial / binomial log-likelihoods (NB sums to 1, converges to Poisson); relocation and re-dry extraction from card sequences; the forward filter equals brute-force path enumeration; the detector beats the no-turn rules on the 8 scored weeks and catches every finished payment-trail failure; higher score bands contain more truly broken hours; the evidence decomposition sums to the total log-likelihood ratio; fitted dispersion is bounded and nothing alerts during warm-up; refund exposure looks back 4 hours; the change-point onset lands within a median of 4 open hours of the true start.

## Honest limitations

- **Synthetic data.** The generator encodes my assumptions about customer behavior (80% of customers move on after a failed start, 70% re-dry after a cold cycle, 97% avoid a dead machine). Real Cents data would set those rates.
- **Low-traffic machines are slow.** Avoidance alone needs many quiet hours on a machine that only gets a turn or two an hour; 2 of 6 "not being used" and 2 of 4 "runs without heat" failures were missed.
- **Scores rank well but are not calibrated.** In the backtest, hours scored 95%+ were really out of order 84% of the time and 90 to 95% hours 65% of the time. Calibrating against technician tickets would fix this.
- **Coin-only turns leave no card trail**, so relocation evidence only covers card and app payments.
- The UI is a static rebuild of the Machines screen from public help-center screenshots; icons are Lucide stand-ins for Cents' own icon set.

## Novelty check

Cents' docs and launch posts (help center articles on machines, dashboards, Cents Connect reports, technical service turns, Penny troubleshooting; the 2026 Cents Assist updates; the pricing page) describe machine status, turn reports, heat maps and device/maintenance/reboot alerts from connected hardware. I found no feature that infers silent failures from customer behavior (relocations, re-dries, avoidance relative to store traffic). OEM platforms such as Alliance Insights alert on machine-reported error codes; a 2026 coin-collection app proposal flags machines whose earnings fall below a rolling baseline at collection time, which is a weekly, single-signal version.

## Files

- `index.html`, `styles.css`, `app.js`: the page (CDN: Chart.js, Lucide, Google Fonts).
- `core/health.js`: the model (browser + Node).
- `scripts/generate.mjs`: seeded synthetic data → `data/data.js`, `data/truth.json`, `data/truth.js` (ground truth is loaded only to score the backtest).
- `scripts/report.mjs`: prints the headline numbers.
- `test/health.test.mjs`: unit tests.
