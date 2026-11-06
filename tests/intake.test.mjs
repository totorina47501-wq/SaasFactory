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
test('generates a deterministic generator configuration and draft-only missions',()=>{
 const a=compileIntake(text()),b=compileIntake(text());
 assert.deepEqual(a,b);
 assert.equal(a.generatorConfig.projectSlug,'workshop-scheduler');
 assert.deepEqual(a.generatorConfig.modules,['ai-disabled','api','auth','billing-test']);
 assert.equal(a.missionDrafts.length,2);
 assert.ok(a.missionDrafts.every(x=>x.approved===false&&x.files===null&&x.status==='draft'));
 assert.equal(a.safeguards.repoCreated,false);
 assert.equal(a.safeguards.readyForDispatch,false);
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
test('reject duplicate JSON keys and malformed input',()=>{
 assert.throws(()=>compileIntake(readFileSync(example,'utf8').replace('"intakeVersion": 1','"intakeVersion": 1, "intakeVersion": 1')),/Duplicate JSON key/);
 const result=spawnSync(process.execPath,[cli,'--config',example],{encoding:'utf8'});
 assert.notEqual(result.status,0);
 assert.equal(result.stdout,'');
});
