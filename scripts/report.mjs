import fs from 'node:fs'; import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const H = require('../core/health.js');
const raw = fs.readFileSync(new URL('../data/data.js', import.meta.url),'utf8'); const data = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}')+1));
const truth = JSON.parse(fs.readFileSync(new URL('../data/truth.json', import.meta.url),'utf8')).failures;
const R = H.run(data);
const s = H.score(data,R.F,R.post.map(p=>H.episodes(p,0.9)),truth);
const r6 = H.score(data,R.F,R.F.M.map((_,i)=>H.ruleEpisodes(R.F,data,i,6)),truth);
const r12 = H.score(data,R.F,R.F.M.map((_,i)=>H.ruleEpisodes(R.F,data,i,12)),truth);
const fmt=(n,x)=>`${n}: caught ${x.caught}/${x.failures}, median open hours to alert ${x.medianOpenDelay}, false alerts ${x.falseAlarms} (${(x.falsePerWeek/3).toFixed(2)} per store per week)`;
console.log(fmt('Machine Health @90%',s)); console.log(fmt('No turns 6 open h',r6)); console.log(fmt('No turns 12 open h',r12));
console.log('disp',R.P.disp.toFixed(1), 'fitted', JSON.stringify(R.P.fitted));
for (const m of ['nostart','noheat','dead']) { const f=s.perFailure.filter(p=>p.mode===m); console.log(m, f.filter(p=>p.delay!=null).length+'/'+f.length, 'open delays', f.filter(p=>p.delay!=null).map(p=>p.openDelay).join(',')); }
console.log(H.reliability(data,R.F,R.post,truth,[0,0.05,0.5,0.9,0.95,1.0001]).map(g=>`${g.lo}-${g.hi}: n=${g.n} rate=${(g.rate*100).toFixed(1)}%`).join('\n'));
