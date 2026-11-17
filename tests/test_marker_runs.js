const test=require('node:test'),assert=require('node:assert/strict');
const Runs=require('../site/marker-runs.js');
const {forward}=require('../scripts/export-spy-marker-context.js');
const spec=require('../research/spy-marker-forward-v1.json');
const start=Date.parse(spec.startUtc)/1000;
const bar=(i,c=100.5)=>({time:start+i*300,open:100,high:110,low:90,close:c});
test('marker runs preserve unknown left edge, flats, session crossings, and selection time',()=>{
 const markers=[bar(-1),bar(1),bar(2,99.5),bar(3,100),{...bar(4),time:bar(3).time+86400}];
 const runs=Runs.annotate(markers);
 assert.equal(runs[1].count,2);assert.equal(runs[1].knownStart,false);
 assert.equal(runs[4].count,2);assert.equal(runs[4].knownStart,true);
 assert.equal(runs[4].flat,1);assert.equal(runs[4].crossings,1);
 assert.equal(Runs.selected(runs,bar(3).time+10).count,1);
 assert.equal(Runs.selected(runs,bar(-2).time),null);
});
test('comparison keeps exact and pooled runs separate and validates counts',()=>{
 const data=require('../site/data/spy_marker_context.json');
 const run={direction:'green',count:5,knownStart:true};
 const result=Runs.comparison(data,5,'regular',run);
 assert.equal(result.row.depth,5);assert.equal(result.baseline.depth,'any');
 assert.equal(Runs.comparison(data,5,'regular',{...run,knownStart:false}),null);
 assert.equal(Runs.comparison(data,5,'regular',{...run,count:7}).row.depth,'6+');
 assert.throws(()=>Runs.comparison({...data,rows:[]},5,'regular',run),/invalid/);
});
test('forward specification stays frozen; future outcomes remain pending until completed',()=>{
 assert.equal(spec.startUtc,'2026-11-17T14:30:00Z');assert.equal(spec.depth,5);
 assert.equal(spec.reviewNotBeforeUtc,'2027-02-17T14:30:00Z');assert.equal(spec.minimumResolvedEventsForReview,100);
 const bars=[bar(-2,99.5),bar(-1),bar(1),bar(2,95),bar(3),bar(4),bar(5),bar(6,95),bar(7,100)];
 const pending=forward(bars,bar(5).time);
 assert.equal(pending.events.length,1);assert.equal(pending.pending,1);assert.equal(pending.n,0);
 const resolved=forward(bars,bar(7).time);
 assert.equal(resolved.n,1);assert.equal(resolved.same,1);assert.equal(resolved.events[0].nextFlat,true);
 assert.equal(resolved.reviewReady,false);
 assert.deepEqual(pending,forward(bars.slice(0,7),bar(5).time));
 assert.equal(forward(bars,start-1).status,'not-started');
 assert.equal(forward(bars,start-1).events.length,0);
});

test('frozen v1 protocol cannot be silently retuned',()=>{
 const fs=require('node:fs'),crypto=require('node:crypto'),path=require('node:path');
 const bytes=fs.readFileSync(path.join(__dirname,'../research/spy-marker-forward-v1.json'));
 assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'),"acb848e25a9a8d955ecba51aa5ae01c4ac290baeef1925f38d0093778eb9d80c");
});
