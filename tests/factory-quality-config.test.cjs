'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const root=path.join(__dirname,'..');
test('Renovate stays opt-in with valid documented defaults',()=>{
 const conf=JSON.parse(fs.readFileSync(path.join(root,'.github/renovate.json'),'utf8'));
 assert.deepEqual(conf.extends,['config:recommended']);
 assert.equal(conf.dependencyDashboardApproval,false);
 assert.equal(conf.automerge,false);
 assert.equal(conf.platformAutomerge,false);
 assert.ok(conf.prConcurrentLimit<=2);
 assert.ok(conf.prHourlyLimit<=1);
});
test('Codecov upload remains explicitly gated and workflow read-only',()=>{
 const y=fs.readFileSync(path.join(root,'.github/workflows/factory-quality-integrations.yml'),'utf8');
 assert.match(y,/if:.*vars\.CODECOV_ENABLED == 'true'/);
 assert.match(y,/contents:\s*read/);
 assert.doesNotMatch(y,/contents:\s*write/);
 assert.match(y,/coverage\/lcov\.info/);
 assert.doesNotMatch(y,/auto-merge|workflow_run:/i);
});
