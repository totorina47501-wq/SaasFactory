import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createGrowthPlan,recommendNextActions} from '../growth/core/market.mjs';
import {createLocalCrm} from '../growth/core/crm.mjs';
import {aggregateGrowth} from '../growth/core/metrics.mjs';
import {run as cli} from '../growth/cli.mjs';
const source=new URL('../examples/intake-sample.json',import.meta.url);
const raw=readFileSync(source,'utf8');
const time='2026-11-07T12:00:00.000Z';
const e=(id,subjectKey,kind,source='organic',t='2026-11-07T10:00:00.000Z',extra={})=>({
 id,tenantId:'workshop-scheduler',subjectKey,kind,source,occurredAt:t,consent:true,...extra
});
test('GTM plan uses strict intake, is deterministic and draft-only',()=>{
 const a=createGrowthPlan(raw),b=createGrowthPlan(raw);
 assert.deepEqual(a,b);assert.equal(a.schemaVersion,1);
 assert.equal(a.projectSlug,'workshop-scheduler');
 assert.equal(a.marketEvidence,'unverified');
 assert.equal(a.safeguards.commercialMessagesSent,false);
 assert.equal(a.safeguards.readyForProduction,false);
 assert.ok(a.campaigns.every(c=>c.status==='draft'&&!c.sendEnabled&&!c.spendEnabled&&c.requiresApproval));
});
test('GTM refuses malformed inputs, secret-shaped values and extra keys',()=>{
 assert.throws(()=>createGrowthPlan('{}'));
 assert.throws(()=>createGrowthPlan(raw.replace('"intakeVersion": 1','"intakeVersion": 1, "intakeVersion": 1')),/Duplicate JSON/);
 const v=JSON.parse(raw);v.assumptions=['sk-proj-'+ 'a'.repeat(30)];
 assert.throws(()=>createGrowthPlan(JSON.stringify(v)),/credential-like/);
 assert.throws(()=>createGrowthPlan(null));
});
test('local CRM keeps tenant boundaries and all campaigns in draft',()=>{
 const a=createLocalCrm({tenantId:'tenant-a'}),b=createLocalCrm({tenantId:'tenant-b'});
 assert.equal(a.addLead({id:'lead-1',segment:'manufacturing',legalBasis:'none'}).stage,'new');
 assert.equal(a.updateStage('lead-1','qualified').stage,'qualified');
 assert.equal(a.addDraft({id:'launch-1',channel:'email',message:'Request an introduction',targetSegment:'manufacturing'}).deliveryEnabled,false);
 assert.equal(a.snapshot().leadCount,1);assert.equal(b.snapshot().leadCount,0);
 assert.equal(a.snapshot().campaignDrafts,1);assert.equal(a.snapshot().outboundEnabled,false);
 a.clear();assert.equal(a.snapshot().leadCount,0);
});
test('CRM requires basis evidence; opt-out irreversible; duplicates rejected',()=>{
 const s=createLocalCrm({tenantId:'team-one'});
 assert.throws(()=>s.addLead({id:'one',segment:'SaaS',legalBasis:'consent'}),/basisEvidence/);
 assert.throws(()=>s.addLead({id:'one',segment:'SaaS',legalBasis:'none',email:'unsafe@example.com'}),/shape/);
 s.addLead({id:'one',segment:'SaaS',legalBasis:'legitimate-interest-b2b',basisEvidence:'Source and relevance reviewed'});
 assert.throws(()=>s.addLead({id:'one',segment:'SaaS',legalBasis:'none'}),/Duplicate/);
 s.optOut('one');s.optOut('one');
 assert.equal(s.snapshot().suppressed,1);
 assert.throws(()=>s.updateStage('one','unknown'),/stage/);
 s.updateStage('one','lost');assert.throws(()=>s.updateStage('one','won'),/Terminal/);
 assert.throws(()=>s.addDraft({id:'x',channel:'email',message:'X',targetSegment:'SaaS',send:true}),/shape/);
});
test('attribution aggregates consented synthetic events and first-last touch',()=>{
 const events=[
 e('v1','p1','visit','seo','2026-11-07T08:00:00.000Z'),
 e('v2','p1','visit','referral','2026-11-07T09:00:00.000Z'),
 e('s1','p1','signup','referral'),
 e('t1','p1','trial','referral'),
 e('p1','p1','paid-simulated','referral','2026-11-07T11:00:00.000Z',{amountCents:2500}),
 e('other','p2','visit','direct','2026-11-07T08:00:00.000Z',{consent:false}),
 ];
 const out=aggregateGrowth({tenantId:'workshop-scheduler',events,asOf:time});
 assert.equal(out.mode,'simulation');assert.equal(out.counts.visits,2);
 assert.equal(out.counts.signups,1);assert.equal(out.counts.simulatedRevenueCents,2500);
 assert.ok(out.attribution.some(x=>x.channel==='firstTouch'&&x.source==='seo'&&x.signups===1));
 assert.ok(out.attribution.some(x=>x.channel==='lastTouch'&&x.source==='referral'&&x.signups===1));
 assert.doesNotMatch(JSON.stringify(out),/p1|p2/);
});
test('opt-out removes previous events; duplicates are idempotent, conflicting IDs fail',()=>{
 const v=e('v','subject-one','visit'),s=e('s','subject-one','signup');
 const baseline=aggregateGrowth({tenantId:'workshop-scheduler',events:[v,v,s],asOf:time});
 assert.equal(baseline.counts.visits,1);
 const opted=aggregateGrowth({tenantId:'workshop-scheduler',
   events:[v,s,e('opt','subject-one','opt-out','direct')],asOf:time});
 assert.equal(opted.counts.visits,0);assert.equal(opted.excludedOptOutSubjects,1);
 assert.throws(()=>aggregateGrowth({tenantId:'workshop-scheduler',
   events:[v,{...v,kind:'signup'}],asOf:time}),/Conflicting/);
});
test('metrics fail closed on invalid tenant, future time, money and identity leak',()=>{
 assert.throws(()=>aggregateGrowth({tenantId:'other',events:[e('a','s','visit')],asOf:time}),/Cross-tenant/);
 assert.throws(()=>aggregateGrowth({tenantId:'workshop-scheduler',
   events:[e('a','s','visit','seo','2027-11-07T10:00:00.000Z')],asOf:time}),/Future/);
 assert.throws(()=>aggregateGrowth({tenantId:'workshop-scheduler',
   events:[e('a','user@example.com','visit')],asOf:time}),/identifier/);
 assert.throws(()=>aggregateGrowth({tenantId:'workshop-scheduler',
   events:[e('a','s','paid-simulated','seo',undefined,{amountCents:-1})],asOf:time}),/amount/);
 assert.throws(()=>aggregateGrowth({tenantId:'workshop-scheduler',
   events:[e('a','s','signup','seo',undefined,{amountCents:5})],asOf:time}),/Amount only/);
});
test('recommendations remain drafts, never schedule campaigns or issues',()=>{
 const report=aggregateGrowth({tenantId:'workshop-scheduler',events:[],asOf:time});
 const out=recommendNextActions({report});
 assert.equal(out.issuesCreated,false);assert.equal(out.campaignsSent,false);
 assert.equal(out.actions[0].automaticExecution,false);
 assert.throws(()=>recommendNextActions({report:{kind:'wrong'}}));
});
test('read-only CLI produces identical plan and metrics without writing files',()=>{
 const result=cli(['--input',new URL('../examples/intake-sample.json',import.meta.url).pathname]);
 assert.deepEqual(result.plan,createGrowthPlan(raw));
 const dir=mkdtempSync(join(tmpdir(),'growth-fixture-'));
 try{
  const file=join(dir,'events.json');
  writeFileSync(file,JSON.stringify([e('v','lead-1','visit')]));
  const args=['--input',source.pathname,'--events',file,'--as-of',time];
  const withEvents=cli(args);
  assert.equal(withEvents.metrics.counts.visits,1);
  const child=spawnSync(process.execPath,['growth/cli.mjs',...args],{encoding:'utf8'});
  assert.equal(child.status,0,child.stderr);
  assert.deepEqual(JSON.parse(child.stdout),withEvents);
  assert.throws(()=>cli(['--input',source.pathname,'--events',file]));
 }finally{rmSync(dir,{recursive:true,force:true});}
});
