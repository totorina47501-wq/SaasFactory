import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {execFileSync,spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {compileIntake} from '../intake.mjs';
const example=fileURLToPath(new URL('../examples/intake-sample.json',import.meta.url));
const cli=fileURLToPath(new URL('../intake.mjs',import.meta.url));
const base=JSON.parse(readFileSync(example,'utf8'));
const text=change=>JSON.stringify({...base,...change});
test('accepts ordinary words containing credential prefixes and still rejects actual keys',()=>{
 const benign={...base.product,name:'Task management platform',slug:'task-management-platform'};
 assert.equal(compileIntake(text({product:benign})).projectSlug,benign.slug);
 for(const prefix of ['sk-','sk-proj-','sk-test-','sk-live-']){
  const token=prefix+'a'.repeat(24);
  for(const separator of ['', 'Key: ', '(', '\"']){
   assert.throws(()=>compileIntake(text({assumptions:[separator+token]})),/credential-like/);
  }
 }
});
test('generates a deterministic generator configuration and draft-only missions',()=>{
 const a=compileIntake(text()),b=compileIntake(text());
 assert.deepEqual(a,b);
 assert.equal(a.generatorConfig.projectSlug,'workshop-scheduler');
 assert.deepEqual(a.generatorConfig.modules,['ai-disabled','api','auth','billing-test']);
 assert.equal(a.missionDrafts.length,2);
 assert.ok(a.missionDrafts.every(x=>x.approved===false&&x.files===null&&x.status==='draft'));
 assert.equal(a.safeguards.repoCreated,false);
 assert.equal(a.safeguards.readyForDispatch,false);
 assert.equal(a.capabilityRequests.length,5);
 assert.ok(a.capabilityRequests.every(c=>c.readyForUse===false&&c.implementation==='draft-only'));
 assert.ok(a.capabilityRequests.some(c=>c.status==='missing'));

});
test('CLI outputs the same plan and never creates a destination',()=>{
 const output=JSON.parse(execFileSync(process.execPath,[cli,'--input',example],{encoding:'utf8'}));
 assert.deepEqual(output,compileIntake(text()));
});
test('fail closed on invalid versions, extra keys, invalid schema and role',()=>{
 const invalid=[
  {intakeVersion:2},
  {unknown:'value'},
  {product:{...base.product,slug:'../unsafe'}},
  {scaffold:{...base.scaffold,modules:['api']}},
  {mvp:base.mvp.map((f,i)=>({...f,id:'duplicate'}))},
  {mvp:[{...base.mvp[0],owner:'untrusted-agent'}]},
  {market:{...base.market,extra:'x'}},
  {assumptions:['not printable\nvalue']}
 ];
 for(const entry of invalid)assert.throws(()=>compileIntake(text(entry)));
});
test('explicit video/audio requirements are catalogued but never activated as scaffold modules',()=>{
 const manifest={...base,capabilities:['video-ingest','video-extraction','audio-extraction','audio-transcription','audio-subtitles','audio-tts','media-job-queue']};
 const result=compileIntake(JSON.stringify(manifest));
 assert.deepEqual(result.capabilityRequests.map(x=>x.id),manifest.capabilities);
 assert.ok(result.capabilityRequests.every(x=>!x.readyForUse));
 assert.ok(!result.generatorConfig.modules.includes('audio-transcription'));
 assert.equal(result.safeguards.providerActivated,false);
});
test('unknown/duplicate capabilities and module names fail closed',()=>{
 for(const capabilities of [['video-ingest','video-ingest'],['unknown-module'],['audio transcription']])
  assert.throws(()=>compileIntake(JSON.stringify({...base,capabilities})));
 assert.throws(()=>compileIntake(JSON.stringify({...base,scaffold:{...base.scaffold,modules:['ai-disabled','video-extraction']}})));
});
test('capability catalog has unique safe ids and supported status vocabulary',()=>{
 const catalog=JSON.parse(readFileSync(fileURLToPath(new URL('../docs/catalog/saas-capabilities-v1.json',import.meta.url)),'utf8'));
 assert.equal(catalog.catalogVersion,1);
 assert.ok(catalog.capabilities.length>=20);
 const ids=catalog.capabilities.map(c=>c.id);
 assert.equal(new Set(ids).size,ids.length);
 for(const c of catalog.capabilities){
  assert.match(c.id,/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
  assert.ok(['scaffold','missing','proposed'].includes(c.status));
  assert.ok(['generator-engineer','qa-engineer','security-engineer','platform-engineer','product-architect','ux-accessibility','documentation-release'].includes(c.owner));
 }
});
test('rejects token-shaped secrets in all free-form intake strings without echoing them',()=>{
 const token='ghp_'+ 'a'.repeat(36);
 const variants=[
  {mvp:[{...base.mvp[0],description:'Description '+token}]},
  {assumptions:['Do not publish '+token]},
  {product:{...base.product,summary:'Data '+token}},
  {market:{...base.market,problem:'Bearer '+ 'a'.repeat(30)}},
  {mvp:[{...base.mvp[0],description:'api_key='+ 'b'.repeat(24)}]}
 ];
 for(const variant of variants){
  assert.throws(()=>compileIntake(text(variant)),error=>error.message.includes('credential-like')&&!error.message.includes(token));
 }
});
test('reject duplicate JSON keys and malformed input',()=>{
 assert.throws(()=>compileIntake(readFileSync(example,'utf8').replace('"intakeVersion": 1','"intakeVersion": 1, "intakeVersion": 1')),/Duplicate JSON key/);
 const result=spawnSync(process.execPath,[cli,'--config',example],{encoding:'utf8'});
 assert.notEqual(result.status,0);
 assert.equal(result.stdout,'');
});

