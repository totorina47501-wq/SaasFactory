'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const orchestration = require('../.github/scripts/factory-orchestration.cjs');

const catalogPath = path.join(__dirname, '../docs/catalog/factory-backlog-v1.json');
const catalog = () => JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
const mainSha = 'b'.repeat(40);
const headSha = 'a'.repeat(40);
const coordinatorTask = () => catalog().tasks.find(task => task.key === 'SFV3-AUTO');
const issue = (task, extra = {}) => ({
  number: task.issue,
  state: 'open',
  body: `Files: ${task.files.join(', ')}\nDepends-On: ${task.dependsOn.length ?
    task.dependsOn.map(dep => `${dep.kind === 'pull_request' ? 'PR ' : ''}#${dep.number}`).join(', ') : 'none'}`,
  labels: [
    {name: 'agent:approved'},
    {name: `agent:role:${task.role}`},
    {name: `priority:${task.priority}`}
  ],
  ...extra
});

function orchestrationGithub({issues = [], allPrs = [], openPrs = [], dependencyMerged = {}, failDependency} = {}) {
  const calls = [];
  const issuesByNumber = new Map(issues.map(issue => [issue.number, issue]));
  const github = {
    paginate: async (method, args) => {
      if (method === github.rest.issues.listForRepo) return issues;
      if (method === github.rest.pulls.list) return args.state === 'all' ? allPrs : openPrs;
      throw new Error('unexpected paginate');
    },
    rest: {
      repos: {getBranch: async () => ({data: {commit: {sha: mainSha}}})},
      issues: {
        listForRepo() {},
        get: async args => {
          const value = issuesByNumber.get(args.issue_number);
          if (!value) throw Error('missing issue');
          return {data: value};
        },
        setLabels: async args => {
          const current = issuesByNumber.get(args.issue_number);
          current.labels = args.labels.map(name => ({name}));
          calls.push(['setLabels', args]);
        }
      },
      pulls: {
        list() {},
        get: async args => {
          if (failDependency === args.pull_number) throw Error('partial API failure');
          return {data: {merged: dependencyMerged[args.pull_number] === true}};
        }
      },
      actions: {
        getWorkflow: async () => ({data: {
          id: 12, path: orchestration.REQUIRED_WORKFLOW.path,
          name: orchestration.REQUIRED_WORKFLOW.name, state: 'active'
        }})
      }
    }
  };
  return {github, calls};
}

async function runCoordinator(github, overrides = {}) {
  const previous = process.env.EXPECTED_REPO;
  process.env.EXPECTED_REPO = orchestration.REPOSITORY;
  try {
    return await orchestration.run({
      github,
      context: {
        repo: {owner: 'totorina47501-wq', repo: 'SaasFactory'},
        ref: 'refs/heads/main',
        sha: mainSha
      },
      io: {readFileSync: () => fs.readFileSync(catalogPath, 'utf8')},
      ...overrides
    });
  } finally {
    if (previous === undefined) delete process.env.EXPECTED_REPO;
    else process.env.EXPECTED_REPO = previous;
  }
}

test('catalog rejects unknown fields, missing references, and cycles', () => {
  const value = catalog();
  assert.doesNotThrow(() => orchestration.validateCatalog(value));
  assert.throws(() => orchestration.validateCatalog({...value, unexpected: true}), /unknown fields/);

  const unknown = catalog();
  unknown.tasks[0].unexpected = true;
  assert.throws(() => orchestration.validateCatalog(unknown), /unknown fields/);

  const cyclic = catalog();
  cyclic.tasks[0].dependsOn.push({kind: 'issue', number: cyclic.tasks[1].issue});
  cyclic.tasks[1].dependsOn.push({kind: 'issue', number: cyclic.tasks[0].issue});
  assert.throws(() => orchestration.validateCatalog(cyclic), /cycle/);

  const missing = catalog();
  missing.tasks[0].dependsOn.push({kind: 'issue', number: 9999});
  assert.throws(() => orchestration.validateCatalog(missing), /missing/);
});

test('only an exact catalog-backed planned mission is promoted', async () => {
  const task = coordinatorTask();
  const planned = issue(task, {
    labels: [
      {name: 'agent:planned'},
      {name: 'agent:role:platform-engineer'},
      {name: 'priority:p0'}
    ]
  });
  const {github, calls} = orchestrationGithub({issues: [planned]});
  const result = await runCoordinator(github);
  assert.deepEqual(result.promoted, [task.issue]);
  assert.deepEqual(calls.map(call => call[0]), ['setLabels']);
  assert.ok(calls[0][1].labels.includes('agent:approved'));
  assert.ok(!calls[0][1].labels.includes('agent:planned'));
  const replay = await runCoordinator(github);
  assert.deepEqual(replay.promoted, []);
  assert.equal(calls.length, 1);
});

test('scope, role, dependencies, and not-planned closures block promotion', async () => {
  const task = coordinatorTask();
  const cases = [
    issue(task, {labels: [{name: 'agent:planned'}, {name: 'agent:role:qa-engineer'}, {name: 'priority:p0'}]}),
    issue(task, {body: 'Files: README.md\nDepends-On: none',
      labels: [{name: 'agent:planned'}, {name: 'agent:role:platform-engineer'}, {name: 'priority:p0'}]}),
    issue(task, {state: 'closed', state_reason: 'not_planned',
      labels: [{name: 'agent:planned'}, {name: 'agent:role:platform-engineer'}, {name: 'priority:p0'}]})
  ];
  for (const candidate of cases) {
    const {github, calls} = orchestrationGithub({issues: [candidate]});
    const result = await runCoordinator(github);
    assert.deepEqual(result.promoted, []);
    assert.deepEqual(calls, []);
  }
});

test('issue dependency requires completed closure and a merged linked PR', async () => {
  const data = catalog();
  const task = data.tasks.find(item => item.key === 'SFV3-REG');
  const parent = data.tasks.find(item => item.issue === 17);
  const secondParent = data.tasks.find(item => item.issue === 18);
  const candidate = issue(task, {
    labels: [{name: 'agent:planned'}, {name: `agent:role:${task.role}`}, {name: `priority:${task.priority}`}]
  });
  const completed = issue(parent, {state: 'closed', state_reason: 'completed'});
  const completedSecond = issue(secondParent, {state: 'closed', state_reason: 'completed'});
  const proof = {number: 90, body: `Closes #${parent.issue}`};
  const secondProof = {number: 91, body: `Closes #${secondParent.issue}`};

  const pending = orchestrationGithub({
    issues: [candidate, completed, completedSecond], allPrs: [proof, secondProof],
    dependencyMerged: {[proof.number]: false, [secondProof.number]: true, 14: true}
  });
  assert.deepEqual((await runCoordinator(pending.github)).promoted, []);

  const merged = orchestrationGithub({
    issues: [candidate, completed, completedSecond], allPrs: [proof, secondProof],
    dependencyMerged: {[proof.number]: true, [secondProof.number]: true, 14: true}
  });
  assert.deepEqual((await runCoordinator(merged.github)).promoted, [task.issue]);

  const notPlanned = orchestrationGithub({
    issues: [candidate, {...completed, state_reason: 'not_planned'}, completedSecond],
    allPrs: [proof, secondProof],
    dependencyMerged: {[proof.number]: true, [secondProof.number]: true, 14: true}
  });
  assert.deepEqual((await runCoordinator(notPlanned.github)).promoted, []);
});

test('partial dependency API failure aborts before any promotion', async () => {
  const data = catalog();
  const task = data.tasks.find(item => item.key === 'SFV3-REG');
  const parent = data.tasks.find(item => item.issue === 17);
  const secondParent = data.tasks.find(item => item.issue === 18);
  const candidate = issue(task, {
    labels: [{name: 'agent:planned'}, {name: `agent:role:${task.role}`}, {name: `priority:${task.priority}`}]
  });
  const completed = issue(parent, {state: 'closed', state_reason: 'completed'});
  const completedSecond = issue(secondParent, {state: 'closed', state_reason: 'completed'});
  const proof = {number: 90, body: `Closes #${parent.issue}`};
  const secondProof = {number: 91, body: `Closes #${secondParent.issue}`};
  const {github, calls} = orchestrationGithub({
    issues: [candidate, completed, completedSecond], allPrs: [proof, secondProof],
    dependencyMerged: {[proof.number]: true, [secondProof.number]: true}, failDependency: 14
  });
  await assert.rejects(runCoordinator(github), /failed closed/);
  assert.deepEqual(calls, []);
});

function mergeMocks({head = headSha, base = mainSha, state = 'clean', ciWorkflowId = 12,
  review = true, comments = true, unresolved = false, changesRequested = false,
  changedFiles, author = 'copilot-swe-agent[bot]', branch = 'copilot/task-17'} = {}) {
  const calls = [];
  const workflow = {id: 12, path: orchestration.REQUIRED_WORKFLOW.path, name: orchestration.REQUIRED_WORKFLOW.name};
  const pr = {
    number: 45,
    body: 'Closes #17',
    draft: false,
    merged: false,
    mergeable: true,
    mergeable_state: state,
    base: {ref: 'main', sha: base, repo: {full_name: orchestration.REPOSITORY}},
    head: {ref: branch, sha: head, repo: {full_name: orchestration.REPOSITORY}},
    user: {login: author}
  };
  const task = coordinatorTask();
  const linkedIssue = issue(task);
  const github = {
    paginate: async (method) => {
      if (method === github.rest.pulls.listFiles) return (changedFiles || [task.files[0]]).map(filename => ({filename}));
      if (method === github.rest.actions.listWorkflowRuns) return [{
        workflow_id: ciWorkflowId, head_sha: head, event: 'pull_request',
        status: 'completed', conclusion: 'success', run_attempt: 1
      }];
      if (method === github.rest.pulls.listReviews) return review ? [{
        id: 8, user: {login: 'copilot-pull-request-reviewer[bot]'},
        state: changesRequested ? 'CHANGES_REQUESTED' : 'APPROVED',
        commit_id: head, submitted_at: '2026-11-06T09:00:00Z'
      }] : [];
      if (method === github.rest.pulls.listReviewComments) return comments ? [{
        pull_request_review_id: 8,
        user: {login: 'copilot-pull-request-reviewer[bot]'},
        commit_id: head, path: task.files[0]
      }] : [];
      throw Error('unexpected paginate');
    },
    graphql: async () => ({
      repository: {pullRequest: {reviewThreads: {
        nodes: [{isResolved: !unresolved}], pageInfo: {hasNextPage: false, endCursor: null}
      }}}
    }),
    rest: {
      pulls: {
        listFiles() {}, listReviews() {}, listReviewComments() {},
        get: async () => ({data: {...pr, head: {...pr.head, sha: head}, base: {...pr.base, sha: mainSha}}}),
        merge: async args => {calls.push(args);return {data: {merged: true}}}
      },
      actions: {listWorkflowRuns() {}},
      repos: {getBranch: async () => ({data: {commit: {sha: mainSha}}})}
    }
  };
  return {github, calls, pr, task, linkedIssue, workflow};
}

test('merge requires authenticated CI and final review of changed files on the current head', async () => {
  const valid = mergeMocks();
  assert.equal(await orchestration.mergeEligiblePullRequest({
    ...valid, issue: valid.linkedIssue, owner: 'totorina47501-wq', repo: 'SaasFactory', workflow: valid.workflow, mainSha
  }), true);
  assert.equal(valid.calls.length, 1);
  assert.equal(valid.calls[0].sha, headSha);

  for (const options of [
    {base: 'c'.repeat(40)},
    {state: 'dirty'},
    {ciWorkflowId: 99},
    {review: false},
    {comments: false},
    {unresolved: true},
    {changesRequested: true},
    {changedFiles: ['README.md']},
    {author: 'someone-else'},
    {branch: 'feature/task-17'}
  ]) {
    const invalid = mergeMocks(options);
    assert.equal(await orchestration.mergeEligiblePullRequest({
      ...invalid, issue: invalid.linkedIssue, owner: 'totorina47501-wq', repo: 'SaasFactory',
      workflow: invalid.workflow, mainSha
    }), false);
    assert.equal(invalid.calls.length, 0);
  }
});

test('new head SHA must have its own successful CI, review, and expected merge SHA', async () => {
  const newHead = 'c'.repeat(40);
  const current = mergeMocks({head: newHead});
  assert.equal(await orchestration.mergeEligiblePullRequest({
    ...current, issue: current.linkedIssue, owner: 'totorina47501-wq', repo: 'SaasFactory',
    workflow: current.workflow, mainSha
  }), true);
  assert.equal(current.calls[0].sha, newHead);
});

test('merge never retries changed heads or already merged PRs', async () => {
  const stale = mergeMocks();
  stale.github.rest.pulls.get = async () => ({
    data: {...stale.pr, head: {ref: stale.pr.head.ref, sha: 'c'.repeat(40)},
      base: {ref: 'main', sha: mainSha}}
  });
  assert.equal(await orchestration.mergeEligiblePullRequest({
    ...stale, issue: stale.linkedIssue, owner: 'totorina47501-wq', repo: 'SaasFactory',
    workflow: stale.workflow, mainSha
  }), false);
  assert.equal(stale.calls.length, 0);

  const replay = mergeMocks();
  replay.pr.merged = true;
  assert.equal(await orchestration.mergeEligiblePullRequest({
    ...replay, issue: replay.linkedIssue, owner: 'totorina47501-wq', repo: 'SaasFactory',
    workflow: replay.workflow, mainSha
  }), false);
  assert.equal(replay.calls.length, 0);
});

test('recovery attempts stop at two for one PR/SHA', () => {
  assert.equal(orchestration.retryAllowed(0), true);
  assert.equal(orchestration.retryAllowed(1), true);
  assert.equal(orchestration.retryAllowed(2), false);
  assert.equal(orchestration.retryAllowed(-1), false);
  assert.equal(orchestration.retryAllowed(1.5), false);
});
