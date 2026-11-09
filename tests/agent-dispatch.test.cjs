'use strict';
const test=require('node:test'), assert=require('node:assert/strict'), fs=require('node:fs');
const dispatch=require('../.github/scripts/agent-dispatch.cjs');
require('./factory-orchestration.test.cjs');
test('dispatch workflow isolates a user token from checkout and refuses missing credentials',()=>{
 const workflow=fs.readFileSync(require('node:path').join(__dirname,'../.github/workflows/saas-factory-agent-dispatch.yml'),'utf8');
 assert.match(workflow,/github-token: \$\{\{ secrets\.COPILOT_DISPATCH_TOKEN \}\}/);
 assert.doesNotMatch(workflow,/github-token:.*GITHUB_TOKEN|\|\|.*github\.token/);
 assert.match(workflow,/COPILOT_DISPATCH_TOKEN_CONFIGURED: \$\{\{ secrets\.COPILOT_DISPATCH_TOKEN != '' \}\}/);
 assert.match(workflow,/test "\$COPILOT_DISPATCH_TOKEN_CONFIGURED" = 'true'/);
 const checkout=workflow.slice(workflow.indexOf('- uses: actions/checkout@v4'),workflow.indexOf('- uses: actions/github-script@v7'));
 assert.match(checkout,/ref: \$\{\{ github\.sha \}\}/);
 assert.match(checkout,/persist-credentials: false/);
 assert.doesNotMatch(checkout,/COPILOT_DISPATCH_TOKEN/);
 assert.match(workflow,/if:.*github\.repository == 'totorina47501-wq\/SaasFactory'.*github\.ref == 'refs\/heads\/main'/);
 assert.doesNotMatch(workflow,/^\s+pull_request(?:_target)?:/m);
 // Current policy uses scheduled/manual dispatch; the paid review trigger stays paused.
 assert.match(workflow,/workflow_dispatch:/);
 assert.ok(workflow.includes("cron: '*/30 * * * *'"));
 assert.doesNotMatch(workflow,/^\\s+workflow_run:/m);
 assert.match(workflow,/issues: read/);
 assert.match(workflow,/pull-requests: read/);
 assert.match(workflow,/cron: '\*\/10 \* \* \* \*'/);
 assert.match(workflow,/agent-dispatch\.cjs/);
 assert.match(workflow,/Coordinate, review, merge, and dispatch from main/);
 const dispatcher=fs.readFileSync(require('node:path').join(__dirname,'../.github/scripts/agent-dispatch.cjs'),'utf8');
 assert.match(dispatcher,/require\('\.\/factory-orchestration\.cjs'\)/);
});
async function exercise(issues=[],prs=[],opts={}){
 const calls=[];
 const order=opts.order||[];
 const github={
   paginate:async(fn,arg)=>{order.push('github');if(fn===github.rest.issues.listForRepo)return issues;if(fn===github.rest.pulls.list)return prs;if(fn===github.rest.pulls.listFiles)return opts.files?.[arg.pull_number]||[];throw Error('unexpected paginate')},
   rest:{issues:{listForRepo(){},get:async()=>({data:{assignees:opts.unconfirmed?[]:[{login:'copilot-swe-agent[bot]'}]}}),addLabels:async a=>{calls.push(['label',a]);}},pulls:{list(){},listFiles(){}}},
   request:async(_url,args)=>{calls.push(['assign',args]);if(opts.fail)throw Error('assignment refused');}
 };
 const previous=process.env.EXPECTED_REPO;process.env.EXPECTED_REPO='totorina47501-wq/SaasFactory';
 const writes=[];
 const core={summary:{addHeading(){return this},addRaw(){return this},async write(){}},notice(){}};
 const context={repo:{owner:'totorina47501-wq',repo:'SaasFactory'},sha:'test',runId:1};
 const orchestration={run:async()=>({decision:'idle'}),revalidateDispatchCandidate:async()=>true,...opts.orchestration};
 try{await dispatch({github,context,core,orchestration,fs:{writeFileSync:(p,v)=>writes.push(JSON.parse(v))}});}
 catch(e){if(!opts.fail&&!opts.unconfirmed)throw e;}
 finally{if(previous===undefined)delete process.env.EXPECTED_REPO;else process.env.EXPECTED_REPO=previous}
 return {calls,report:writes.at(-1),order};
}
test('coordinator runs before issue selection',async()=>{
 const order=[];
 const x=await exercise([issue(8,['agent:approved','agent:role:qa-engineer'])],[],{
  order,
  orchestration:{run:async()=>{order.push('coordinate');return {decision:'idle'}}}
 });
 assert.deepEqual(order.slice(0,2),['coordinate','github']);
 assert.equal(x.report.orchestration.decision,'idle');
});
test('a merge defers assignment until a new pass reads the new main SHA',async()=>{
 const order=[];
 const x=await exercise([],[],{order,orchestration:{run:async()=>({decision:'merged',merged:[45]})}});
 assert.equal(x.report.decision,'deferred:main-advanced');
 assert.equal(order.length,0);
 assert.equal(x.calls.length,0);
});
test('candidate dependencies and authorization are revalidated before assignment',async()=>{
 const x=await exercise([issue(8,['agent:approved','agent:role:qa-engineer'])],[],{
  orchestration:{revalidateDispatchCandidate:async()=>false}
 });
 assert.equal(x.report.decision,'blocked:mission-no-longer-ready');
 assert.equal(x.calls.length,0);
});
test('dispatcher omits raw operation errors from reports',async()=>{
 const x=await exercise([],[],{
   fail:true,
   orchestration:{run:async()=>{throw Error('SENTINEL_TOKEN_MUST_NOT_LEAK')}}
 });
 assert.equal(x.report.decision,'error');
 assert.doesNotMatch(JSON.stringify(x.report),/SENTINEL_TOKEN_MUST_NOT_LEAK/);
});
test('dispatcher persists sanitized partial orchestration evidence on failure',async()=>{
 const error=new Error('private API response');
 error.orchestrationReport={decision:'error',promoted:[17],merged:[],blockers:['evidence unavailable']};
 const x=await exercise([],[],{fail:true,orchestration:{run:async()=>{throw error}}});
 assert.equal(x.report.orchestration.promoted[0],17);
 assert.doesNotMatch(JSON.stringify(x.report),/private API response/);
});
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

test('assignment evidence requires a confirmed Copilot read-back',async()=>{
 const ok=await exercise([issue(5,['agent:approved','priority:p0','agent:role:platform-engineer'])]);
 assert.deepEqual(ok.report.assignment,{issue:5,specialist:'platform-engineer',confirmed:true});
 const denied=await exercise([issue(5,['agent:approved','priority:p0','agent:role:platform-engineer'])],[],{unconfirmed:true});
 assert.equal(denied.report.decision,'error');
 assert.equal(denied.calls.filter(c=>c[0]==='assign').length,1);
 assert.deepEqual(denied.report.assignment,{issue:5,specialist:'platform-engineer',confirmed:false});
 assert.equal(denied.calls.filter(c=>c[0]==='label').length,0);
});

test('review signal has no privileged credentials or untrusted checkout',()=>{
 const signal=fs.readFileSync(require('node:path').join(__dirname,'../.github/workflows/saas-factory-review-signal.yml'),'utf8');
 assert.match(signal,/workflow_dispatch:/);
 assert.doesNotMatch(signal,/^\\s+pull_request_review:/m);
 assert.match(signal,/permissions: \{\}/);
 assert.match(signal,/github\.event\.review\.user\.login == 'copilot-pull-request-reviewer/);
 assert.match(signal,/github\.event\.pull_request\.base\.ref == 'main'/);
 assert.match(signal,/github\.event\.pull_request\.head\.repo\.full_name == github\.repository/);
 assert.match(signal,/startsWith\(github\.event\.pull_request\.head\.ref, 'copilot\/'\)/);
 assert.doesNotMatch(signal,/^\s*(?:- uses: actions\/checkout|github-token:|pull_request_target:)/m);
 assert.doesNotMatch(signal,/\$\{\{\s*secrets\./);
});

test('privileged dispatcher checks review-signal job evidence before user token access',()=>{
 const workflow=fs.readFileSync(require('node:path').join(__dirname,'../.github/workflows/saas-factory-agent-dispatch.yml'),'utf8');
 const preflight=workflow.indexOf('Verify trusted review notification job before privileged dispatch');
 const token=workflow.indexOf('Require Copilot user token');
 assert.ok(preflight>=0 && preflight<token);
 const block=workflow.slice(preflight,token);
 assert.match(block,/github\.rest\.actions\.getWorkflow/);
 assert.match(block,/saas-factory-review-signal\.yml/);
 assert.match(block,/github\.rest\.actions\.listJobsForWorkflowRun/);
 assert.match(block,/j\.name === 'notify' && j\.status === 'completed' && j\.conclusion === 'success'/);
 assert.doesNotMatch(block,/COPILOT_DISPATCH_TOKEN|secrets\./);
});
test('dispatch workflow full gate rejects untrusted review and CI events',()=>{
 const vm=require('node:vm');
 const workflow=fs.readFileSync(require('node:path').join(__dirname,'../.github/workflows/saas-factory-agent-dispatch.yml'),'utf8');
 const expression=workflow.match(/^\s+if: \$\{\{\s*(.+?)\s*\}\}\s*$/m)?.[1];
 assert.ok(expression,'dispatcher job guard missing');
 const repo='totorina47501-wq/SaasFactory',sha='a'.repeat(40);
 const base={name:'SaaS Factory CI',event:'push',head_branch:'main',head_sha:sha,
   head_repository:{full_name:repo},conclusion:'success'};
 const check=(event,opts={})=>vm.runInNewContext(expression,{
   github:{repository:repo,ref:opts.ref||'refs/heads/main',sha,event_name:opts.eventName||'workflow_run',event:{workflow_run:event}},
   startsWith:(value,prefix)=>String(value).startsWith(prefix)
 },{timeout:100});
 assert.equal(check(base),true);
 assert.equal(check({...base,head_sha:'b'.repeat(40)}),false);
 assert.equal(check({...base,conclusion:'failure'}),false);
 assert.equal(check({...base,head_repository:{full_name:'other/repo'}}),false);
 assert.equal(check({...base,head_branch:'feature/untrusted',event:'pull_request'}),false);
 assert.equal(check({...base,head_branch:'copilot/valid',event:'pull_request',head_sha:'b'.repeat(40)}),true);
 assert.equal(check({...base,name:'SaaS Factory trusted review signal',event:'pull_request_review',head_branch:'copilot/valid'}),true);
 assert.equal(check({...base,name:'SaaS Factory trusted review signal',event:'pull_request_review',conclusion:'skipped'}),false);
 assert.equal(check(base,{ref:'refs/pull/2/merge'}),false);
 assert.equal(check(base,{eventName:'schedule'}),true);
});
