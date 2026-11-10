'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const paused = ["saas-factory-agent-dispatch.yml","saas-factory-agent-ci-recovery.yml","saas-factory-post-main-ci-wake.yml","saas-factory-copilot-ci-wake.yml","saas-factory-copilot-ready-wake.yml"];
test('owner AI pause disables every automatic agent path and even manual job execution', () => {
 for(const file of paused) {
  const yaml=fs.readFileSync(path.join(__dirname,'../.github/workflows',file),'utf8');
  assert.match(yaml,/^on:\n  workflow_dispatch:\npermissions:/m,file);
  assert.doesNotMatch(yaml,/^  (?:schedule|workflow_run|pull_request_target|pull_request|push):/m,file);
  assert.match(yaml,/(?:if: \$\{\{ false &&|    if: >-\n      false &&)/,file);
 }
});
test('deterministic CI is retained without Copilot token',()=>{
 const yaml=fs.readFileSync(path.join(__dirname,'../.github/workflows/ci.yml'),'utf8');
 assert.match(yaml,/^  pull_request:/m);
 assert.match(yaml,/^  push:/m);
 assert.doesNotMatch(yaml,/secrets\.COPILOT_DISPATCH_TOKEN/);
});
