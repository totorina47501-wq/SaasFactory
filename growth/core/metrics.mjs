// Offline synthetic and consented product funnel, not real billing.
const kinds=new Set(['visit','signup','trial','paid-simulated','opt-out']);
function assertId(value,label) {
 if(typeof value!=='string'||value.length<1||value.length>80||
 !/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/i.test(value))
 throw new Error(label+' must be a safe pseudonymous identifier');
 return value;
}
function strictUtc(value) {
 if(typeof value!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) ||
 !Number.isFinite(Date.parse(value))||new Date(value).toISOString()!==value)
 throw new Error('Timestamp must be canonical UTC milliseconds');
 return Date.parse(value);
}
function aggregateGrowth({tenantId,events,asOf}) {
 assertId(tenantId,'tenantId');
 if(!Array.isArray(events)||events.length>10000)throw Error('Events must be an array <= 10000');
 const now=strictUtc(asOf),cutoff=now-90*86400000;
 const seen=new Map(),included=[],optedOut=new Set();
 for(const event of events){
  if(!event||typeof event!=='object'||Array.isArray(event))throw Error('Invalid event');
  const keys=Object.keys(event);
  if(keys.some(k=>!['id','tenantId','subjectKey','kind','source','occurredAt','consent','amountCents'].includes(k))||
   !['id','tenantId','subjectKey','kind','source','occurredAt','consent'].every(k=>Object.hasOwn(event,k)))
   throw Error('Unsupported event fields');
  assertId(event.id,'event id');assertId(event.tenantId,'event tenant');
  assertId(event.subjectKey,'subjectKey');
  if(event.tenantId!==tenantId) throw Error('Cross-tenant event rejected');
  if(!kinds.has(event.kind))throw Error('Unsupported event kind');
  if(typeof event.source!=='string'||!/^[a-z0-9-]{1,40}$/.test(event.source))throw Error('Invalid source');
  if(typeof event.consent!=='boolean')throw Error('Consent must be explicit boolean');
  const at=strictUtc(event.occurredAt);
  if(at>now)throw Error('Future event');
  if(event.kind==='paid-simulated') {
   if(!Number.isSafeInteger(event.amountCents)||event.amountCents<0||event.amountCents>1e9)
    throw Error('Simulated amount invalid');
  }else if(Object.hasOwn(event,'amountCents')) throw Error('Amount only permitted for simulated payments');
  const record=JSON.stringify(event);
  if(seen.has(event.id)) {
   if(seen.get(event.id)!==record)throw Error('Conflicting duplicate event ID');
   continue;
  }
  seen.set(event.id,record);
  if(at<cutoff)continue;
  if(event.kind==='opt-out'){optedOut.add(event.subjectKey);continue;}
  if(event.consent!==true) continue;
  included.push({...event,at});
 }
 const accepted=included.filter(e=>!optedOut.has(e.subjectKey))
   .sort((a,b)=>a.at-b.at||a.id.localeCompare(b.id));
 const perSubject=new Map(),counts={visits:0,signups:0,trials:0,simulatedPaid:0,simulatedRevenueCents:0};
 for(const ev of accepted){
  let s=perSubject.get(ev.subjectKey);
  if(!s){s={first:null,last:null,signup:false,trial:false,paid:false};perSubject.set(ev.subjectKey,s);}
  if(ev.kind==='visit') {counts.visits++;s.first??=ev.source;s.last=ev.source;}
  else if(ev.kind==='signup'){counts.signups++;s.signup=true;}
  else if(ev.kind==='trial'){counts.trials++;s.trial=true;}
  else if(ev.kind==='paid-simulated'){
   counts.simulatedPaid++;counts.simulatedRevenueCents+=ev.amountCents;s.paid=true;
  }
 }
 if(!Number.isSafeInteger(counts.simulatedRevenueCents))throw Error('Simulated revenue overflow');
 const bySource=new Map();
 for(const s of perSubject.values()){
  if(!s.signup && !s.paid)continue;
  const first=s.first||'unknown',last=s.last||'unknown';
  for(const [channel,source] of [['firstTouch',first],['lastTouch',last]]){
   const key=channel+':'+source;let row=bySource.get(key);
   if(!row){row={channel,source,signups:0,simulatedPaid:0};bySource.set(key,row);}
   if(s.signup)row.signups++;
   if(s.paid)row.simulatedPaid++;
  }
 }
 return {kind:'saas-factory-growth-metrics',schemaVersion:1,mode:'simulation',
   tenantId,windowDays:90,asOf,counts,
   attribution:[...bySource.values()].sort((a,b)=>a.channel.localeCompare(b.channel)||a.source.localeCompare(b.source)),
   excludedOptOutSubjects:optedOut.size,
   limitations:['Aggregate only; no personal identifiers in output','No real payments or ROAS','Consent-aware synthetic/pseudonymous inputs only']};
}
export {aggregateGrowth,strictUtc};
