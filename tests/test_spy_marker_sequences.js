const test=require('node:test');
const assert=require('node:assert/strict');
const {study}=require('../scripts/study-spy-marker-sequences.js');
const t=Date.parse('2026-11-16T15:00Z')/1000;
const bar=(i,c=100.5)=>({time:t+i*60,open:100,high:110,low:90,close:c});
const get=(rows,depth,direction='green',period='all')=>rows.find(r=>r.depth===depth&&r.direction===direction&&r.period===period);
test('five green markers survive intervening ordinary red candles; opposite doji resets',()=>{
 const bars=[bar(0),bar(1,95),bar(2),bar(3,95),bar(4),bar(5,95),bar(6),bar(7,95),bar(8),bar(9,95),bar(10),bar(11,99.5),bar(12)];
 const rows=study(bars,1,'regular',bars.at(-1).time);
 assert.equal(get(rows,5).n,1);assert.equal(get(rows,5).same,1);
 assert.equal(get(rows,5).ageMinutesTotal,8);assert.equal(get(rows,5).waitMinutesTotal,2);
 assert.equal(get(rows,'6+').same,0);assert.equal(get(rows,1,'red').same,0);
 assert.equal(get(rows,1).observed,2);assert.equal(get(rows,1).censored,1);
 assert.equal(get(rows,5).price[1].same,0); // Next doji green does not mean price rose.
});
test('session restriction resets runs and censors the last marker rather than scoring a loss',()=>{
 const bars=[bar(0),{...bar(1),time:t+86400},{...bar(2),time:t+86460}];
 const continuous=study(bars,1,'regular',bars.at(-1).time);
 const session=study(bars,1,'regular',bars.at(-1).time,'session');
 assert.equal(get(continuous,2).same,1);
 assert.equal(get(session,1).observed,2);assert.equal(get(session,1).n,1);
 assert.equal(get(session,1).censored,1);assert.equal(get(session,2).censored,1);
 assert.equal(get(continuous,1).price[1].n,0); // No overnight fixed horizon.
});
test('cutoff never reads a future doji and all counts reconcile across exact depths',()=>{
 const bars=Array.from({length:80},(_,i)=>bar(i,i%4===0?95:i%9===0?99.5:100.5));
 for(const style of ['regular','heikin-ashi'])for(const mode of ['continuous','session']) {
  const rows=study(bars,1,style,bars[60].time,mode);
  const truncated=study(bars.slice(0,61),1,style,bars[60].time,mode);
  assert.deepEqual(rows,truncated);
  for(const direction of ['green','red']) {
   const all=get(rows,'any',direction),exact=rows.filter(r=>r.period==='all'&&r.direction===direction&&r.depth!=='any');
   for(const key of ['observed','censored','n','same'])assert.equal(all[key],exact.reduce((s,r)=>s+r[key],0));
   assert.equal(all.observed,all.n+all.censored);
  }
 }
 assert.throws(()=>study([bar(1),bar(0)],1,'regular',t+100),/Invalid/);
});
test('flat-neutral sensitivity neither calls a flat doji green nor joins runs through it',()=>{
 const bars=[bar(0),bar(1,100),bar(2),bar(3)];
 const rows=study(bars,1,'regular',bars.at(-1).time,'continuous','neutral-flat');
 assert.equal(get(rows,1).n,2);assert.equal(get(rows,1).same,1);
 assert.equal(get(rows,2).censored,1);
 assert.equal(get(rows,'any').observed,3);
});
