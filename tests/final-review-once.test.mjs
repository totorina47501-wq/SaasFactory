import {createRequire} from 'node:module';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const require=createRequire(import.meta.url);
const {source,eligible,MARKER}=require('../.github/scripts/final-review-once.cjs');
const sha='a'.repeat(40),name='totorina47501-wq/SaasFactory';
const r={name:'SaaS Factory CI',event:'pull_request',conclusion:'success',status:'completed',id:12,head_sha:sha,repository:{full_name:name},head_repository:{full_name:name},pull_requests:[{number:3}]};
test('only successful CI for trusted repo and one PR',()=>{
 assert.equal(source(r,'totorina47501-wq','SaasFactory',12),true);
 for(const change of [{event:'push'},{conclusion:'failure'},{head_repository:{full_name:'other/repo'}},{pull_requests:[]}]) {
 assert.equal(source({...r,...change},'totorina47501-wq','SaasFactory',12),false);
 }
});
test('only stable non-draft Copilot PR',()=>{
 const p={state:'open',draft:false,user:{login:'Copilot'},head:{sha,ref:'copilot/job',repo:{full_name:name}},base:{ref:'main',repo:{full_name:name}}};
 assert.equal(eligible(p,'totorina47501-wq','SaasFactory',sha),true);
 assert.equal(eligible({...p,draft:true},'totorina47501-wq','SaasFactory',sha),false);
 assert.equal(eligible({...p,user:{login:'bad'}},'totorina47501-wq','SaasFactory',sha),false);
 assert.equal(eligible(p,'totorina47501-wq','SaasFactory','b'.repeat(40)),false);
});
test('no untrusted checkout, serialize requests',()=>{
 const w=fs.readFileSync(new URL('../.github/workflows/saas-factory-final-review.yml',import.meta.url),'utf8');
 assert.match(w,/group: saas-factory-one-review-budget/);
 assert.match(w,/ref: \$\{\{ github.sha \}\}/);
 assert.match(w,/persist-credentials: false/);
 assert.doesNotMatch(w,/pull_request_target:/);
 assert.ok(MARKER.includes('final-review-once'));
});
