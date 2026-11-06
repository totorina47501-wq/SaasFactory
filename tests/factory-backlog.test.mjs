import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {posix} from 'node:path';

const read = () => JSON.parse(readFileSync(new URL('../docs/catalog/factory-backlog-v1.json', import.meta.url), 'utf8'));
const roles = new Set(['product-architect','generator-engineer','qa-engineer','security-engineer','platform-engineer','ux-accessibility','documentation-release']);
function assertScope(file) {
  assert.ok(!file.startsWith('/') && !file.includes('..') && !file.includes('\\'));
  assert.match(file, /^[A-Za-z0-9._/-]+$/);
  const pathWithoutDirectoryMarker=file.endsWith('/')?file.slice(0,-1):file;
  assert.equal(posix.normalize(pathWithoutDirectoryMarker),pathWithoutDirectoryMarker,'noncanonical scope '+file);
  assert.ok(pathWithoutDirectoryMarker.split('/').every(part=>part&&part!=='.'&&part!=='..'));
}

test('scope validation rejects alias paths that could hide a concurrent owner', () => {
  for (const file of ['./.github/workflows/ci.yml','.github/./workflows/ci.yml','.github//workflows/ci.yml','modules/auth//','/tmp/file','../file']) {
    assert.throws(()=>assertScope(file));
  }
  assert.doesNotThrow(()=>assertScope('.github/workflows/ci.yml'));
  assert.doesNotThrow(()=>assertScope('modules/auth/'));
});

test('authorized backlog has unique real issue identities and bounded automation', () => {
  const backlog = read();
  assert.equal(backlog.schemaVersion, 1);
  assert.equal(backlog.repository, 'totorina47501-wq/SaasFactory');
  assert.equal(backlog.tasks.length, 45);
  assert.deepEqual(backlog.limits, {maxActiveMissions:2,maxAssignmentsPerRun:1,maxCiRetriesPerPrSha:2,scheduleCron:'*/10 * * * *'});
  assert.equal(new Set(backlog.tasks.map(t=>t.key)).size, backlog.tasks.length);
  assert.equal(new Set(backlog.tasks.map(t=>t.issue)).size, backlog.tasks.length);
  for (const task of backlog.tasks) {
    assert.match(task.key, /^SFV3-[A-Z][A-Z0-9]*$/);
    assert.ok(Number.isSafeInteger(task.issue) && task.issue > 16);
    assert.ok(roles.has(task.role));
    assert.ok(['p0','p1','p2'].includes(task.priority));
    assert.equal(task.automationAuthorized, true);
    assert.ok(task.files.length && task.acceptance.length >= 3);
    for (const file of task.files) {
      assertScope(file);
    }
  }
});

test('starter and final QA cover optional speech, documents and analytics before release', () => {
  const backlog=read(), tasks=new Map(backlog.tasks.map(t=>[t.issue,t]));
  function ancestors(task, found=new Set()) {
    for (const dep of task.dependsOn) if (dep.kind==='issue'&&!found.has(dep.number)) {
      found.add(dep.number); ancestors(tasks.get(dep.number),found);
    }
    return found;
  }
  for (const key of ['SFV3-PROFILE','SFV3-QA','SFV3-SECURITY','SFV3-OPERATIONS']) {
    const deps=ancestors(backlog.tasks.find(t=>t.key===key));
    for(const optional of ['SFV3-SPEECH','SFV3-DOCUMENTS','SFV3-ANALYTICS']) {
      assert.ok(deps.has(backlog.tasks.find(t=>t.key===optional).issue),key+' must validate '+optional);
    }
  }
});

test('dependencies are resolvable, acyclic and all dependents wait for the coordinator', () => {
  const backlog = read();
  const tasks = new Map(backlog.tasks.map(t=>[t.issue,t]));
  const coordinator = backlog.tasks.find(t=>t.key==='SFV3-AUTO');
  assert.ok(coordinator);
  const visiting = new Set(), visited = new Set();
  function visit(number) {
    assert.ok(!visiting.has(number), 'dependency cycle at '+number);
    if (visited.has(number)) return;
    const task = tasks.get(number);
    assert.ok(task, 'missing issue '+number);
    visiting.add(number);
    for (const dependency of task.dependsOn) {
      assert.ok(Number.isSafeInteger(dependency.number));
      if (dependency.kind === 'pull_request') {
        assert.equal(dependency.number,14);
      } else {
        assert.equal(dependency.kind,'issue');
        visit(dependency.number);
      }
    }
    visiting.delete(number);
    visited.add(number);
  }
  for (const task of backlog.tasks) {
    if (task !== coordinator) assert.ok(task.dependsOn.some(d=>d.kind==='issue'&&d.number===coordinator.issue));
    visit(task.issue);
  }
});

test('existing CI recovery is reused and the authorization refusal remains auditable', () => {
  const backlog=read();
  assert.ok(backlog.existingWork.some(t=>t.issue===6&&t.pullRequest===16));
  const hold=backlog.externalHolds.find(h=>h.pullRequest===14);
  assert.ok(hold);
  assert.equal(hold.automationMayRelease,false);
  assert.equal(hold.requiresExplicitAuthorization,true);
  assert.equal(hold.active,false);
  assert.equal(hold.status,'resolved-externally');
  assert.match(hold.observedMergeSha,/^[0-9a-f]{40}$/);
  assert.ok(backlog.tasks.some(t=>t.dependsOn.some(d=>d.kind==='pull_request'&&d.number===14)));
});

test('separate mission file scopes cannot race over the same files', () => {
  const tasks=read().tasks;
  for (let i=0;i<tasks.length;i++) for (let j=i+1;j<tasks.length;j++) {
    for (const a of tasks[i].files) for (const b of tasks[j].files) {
      const left=a.toLowerCase(),right=b.toLowerCase();
      const overlaps=left===right||(left.endsWith('/')&&right.startsWith(left))||(right.endsWith('/')&&left.startsWith(right));
      assert.ok(!overlaps, tasks[i].key+' and '+tasks[j].key+' overlap: '+a+' / '+b);
    }
  }
});

test('growth missions are present with isolated file scopes and complete dependencies',()=>{
 const all=new Map(read().tasks.map(t=>[t.issue,t]));
 for(const issue of [64,65,66,70,71]) {
  const task=all.get(issue);
  assert.ok(task,'missing growth task '+issue);
  assert.ok(task.files.length>=3);
  assert.ok(task.dependsOn.some(d=>d.kind==='issue'&&d.number===17));
 }
 for(const n of [64,65,66,70]) {
  assert.ok(all.get(71).dependsOn.some(x=>x.kind==='issue'&&x.number===n));
 }
});
