import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const read = () => JSON.parse(readFileSync(new URL('../docs/catalog/factory-backlog-v1.json', import.meta.url), 'utf8'));
const roles = new Set(['product-architect','generator-engineer','qa-engineer','security-engineer','platform-engineer','ux-accessibility','documentation-release']);

test('authorized backlog has unique real issue identities and bounded automation', () => {
  const backlog = read();
  assert.equal(backlog.schemaVersion, 1);
  assert.equal(backlog.repository, 'totorina47501-wq/SaasFactory');
  assert.equal(backlog.tasks.length, 40);
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
      assert.ok(!file.startsWith('/') && !file.includes('..') && !file.includes('\\'));
      assert.match(file, /^[A-Za-z0-9._/-]+$/);
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
      const overlaps=a===b||(a.endsWith('/')&&b.startsWith(a))||(b.endsWith('/')&&a.startsWith(b));
      assert.ok(!overlaps, tasks[i].key+' and '+tasks[j].key+' overlap: '+a+' / '+b);
    }
  }
});
