'use strict';
const test=require('node:test'), assert=require('node:assert/strict'), fs=require('node:fs');
const dispatch=require('../.github/scripts/agent-dispatch.cjs');
async function exercise(issues=[],prs=[],opts={}){
 const calls=[];
 const github={
   paginate:async(fn,arg)=>{if(fn===github.rest.issues.listForRepo)return issues;if(fn===github.rest.pulls.list)return prs;if(fn===github.rest.pulls.listFiles)return opts.files?.[arg.pull_number]||[];throw Error('unexpected paginate')},
   rest:{issues:{listForRepo(){},get:async()=>({data:{assignees:[{login:'copilot-swe-agent[bot]'}]}}),addLabels:async a=>{calls.push(['label',a]);}},pulls:{list(){},listFiles(){}}},
   request:async(_url,args)=>{calls.push(['assign',args]);if(opts.fail)throw Error('assignment refused');}
 };
 const previous=process.env.EXPECTED_REPO;process.env.EXPECTED_REPO='totorina47501-wq/SaasFactory';
 const writes=[];
 const core={summary:{addHeading(){return this},addRaw(){return this},async write(){}},notice(){}};
 const context={repo:{owner:'totorina47501-wq',repo:'SaasFactory'},sha:'test',runId:1};
 try{await dispatch({github,context,core,fs:{writeFileSync:(p,v)=>writes.push(JSON.parse(v))}});}
 catch(e){if(!opts.fail)throw e;}
 finally{if(previous===undefined)delete process.env.EXPECTED_REPO;else process.env.EXPECTED_REPO=previous}
 return {calls,report:writes.at(-1)};
}
const issue=(n,labels=[],body='Files: src/a.js')=>({number:n,labels:labels.map(name=>({name})),assignees:[],body});
const pr=(n,body='',head='feature/other')=>({number:n,body,head:{ref:head},user:{login:head.startsWith('copilot/')?'Copilot':'someone'},draft:true});
test('idle without explicitly approved issues',async()=>{const x=await exercise([issue(2)]);assert.equal(x.report.decision,'idle:no-approved-missions');assert.equal(x.calls.length,0)});
test('assign exactly one approved issue',async()=>{const x=await exercise([issue(5,['agent:approved','priority:p1','agent:role:qa-engineer']),issue(6,['agent:approved','priority:p0','agent:role:platform-engineer'])]);assert.equal(x.report.decision,'assigned:#6');assert.equal(x.calls.filter(a=>a[0]==='assign').length,1);assert.equal(x.calls.find(a=>a[0]==='assign')[1].agent_assignment.custom_agent,'platform-engineer')});
test('existing two missions prevent dispatch',async()=>{const x=await exercise([issue(2,['agent:in-progress']),issue(3,['agent:review']),issue(8,['agent:approved'])]);assert.equal(x.report.decision,'capacity-full');assert.equal(x.calls.length,0)});
test('active Copilot PR consumes capacity; overlapping scope blocked',async()=>{const x=await exercise([issue(2,[],'Files: src/a.js'),issue(7,['agent:approved','agent:role:qa-engineer'])],[pr(3,'Fixes #2','copilot/task')],{files:{3:[{filename:'src/a.js'}]}});assert.equal(x.report.decision,'blocked:file-overlap');assert.equal(x.calls.length,0)});
test('unlinked Copilot PR blocks new tasks',async()=>{const x=await exercise([issue(8,['agent:approved'])],[pr(3,'','copilot/task')]);assert.equal(x.report.decision,'blocked:unlinked-pr')});
test('missing file scope fails closed',async()=>{const x=await exercise([issue(8,['agent:approved'],'Task without scope')]);assert.equal(x.report.decision,'blocked:missing-files-scope')});
test('rejected Copilot assignment never marks issue in progress',async()=>{const x=await exercise([issue(8,['agent:approved','agent:role:qa-engineer'])],[],{fail:true});assert.equal(x.report.decision,'error');assert.equal(x.calls.filter(a=>a[0]==='label').length,0)});

test('approved mission without specialist is not dispatched',async()=>{
 const x=await exercise([issue(10,['agent:approved'])]);
 assert.equal(x.report.decision,'blocked:invalid-specialist-role');
 assert.equal(x.calls.length,0);
});
test('ambiguous or unknown specialist fails closed',async()=>{
 for(const labels of [
  ['agent:approved','agent:role:qa-engineer','agent:role:platform-engineer'],
  ['agent:approved','agent:role:unknown']]){
  const x=await exercise([issue(10,labels)]);
  assert.equal(x.report.decision,'blocked:invalid-specialist-role');
  assert.equal(x.calls.length,0);
 }
});
test('specialist assignment remains limited to one issue',async()=>{
 const x=await exercise([issue(1,['agent:approved','agent:role:generator-engineer']),issue(2,['agent:approved','agent:role:platform-engineer'])]);
 assert.equal(x.calls.filter(a=>a[0]==='assign').length,1);
 assert.equal(x.report.specialist,'generator-engineer');
});
