(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;if(root)root.MarkerRuns=api;})(typeof window!=='undefined'?window:globalThis,function(){
  'use strict';
  const day = new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'});
  function annotate(markers) {
    let previous=null,run=null;
    return markers.map(marker=>{
      const direction=marker.close>=marker.open?'green':'red';
      const session=day.format(new Date(marker.time*1000));
      if(!previous||previous.direction!==direction)run={direction,count:0,flat:0,first:marker.time,crossings:0,knownStart:!!previous};
      else if(session!==previous.session)run.crossings++;
      run.count++;run.flat+=Number(marker.close===marker.open);
      previous={direction,session};
      return {...run,time:marker.time,ageMinutes:(marker.time-run.first)/60};
    });
  }
  function selected(runs,time=Infinity){for(let i=runs.length-1;i>=0;i--)if(runs[i].time<=time)return runs[i];return null;}
  function comparison(report,minutes,style,run){
    if(report?.schemaVersion!==1||!Number.isFinite(Date.parse(report.sourceGeneratedAtUtc))||!Array.isArray(report.rows))throw new Error('Invalid marker context');
    if(!run?.knownStart)return null;
    const matches=r=>r.minutes===Number(minutes)&&r.style===style&&r.direction===run.direction;
    const row=report.rows.find(r=>matches(r)&&r.depth===(run.count>=6?'6+':run.count));
    const baseline=report.rows.find(r=>matches(r)&&r.depth==='any');
    for(const item of [row,baseline])for(const c of [item,item?.price?.[3]])if(!c||!Number.isSafeInteger(c.n)||!Number.isSafeInteger(c.same)||c.n<0||c.same<0||c.same>c.n)throw new Error('Missing or invalid marker counts');
    return {row,baseline};
  }
  return {annotate,selected,comparison};
});
