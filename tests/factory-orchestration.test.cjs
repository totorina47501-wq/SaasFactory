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

function orchestrationGithub({
  issues = [], allPrs = [], openPrs = [], dependencyMerged = {}, detailedPrs = {},
  pullFiles = {}, reviews = [], reviewComments = [], requestedReviewers = {users: [], teams: []},
  reviewThreads = [], workflowRuns = [{
    id: 100, created_at: '2026-11-06T09:00:00Z', run_attempt: 1,
    workflow_id: 12, head_sha: headSha, event: 'pull_request',
    status: 'completed', conclusion: 'success'
  }], failDependency
} = {}) {
  const calls = [];
  const detailedReads = [];
  const mergedPrs = [];
  const issuesByNumber = new Map(issues.map(issue => [issue.number, issue]));
  const github = {
    paginate: async (method, args) => {
      if (method === github.rest.issues.listForRepo) return issues;
      if (method === github.rest.pulls.list) return args.state === 'all' ? allPrs : openPrs;
      if (method === github.rest.pulls.listFiles) return pullFiles[args.pull_number] || [];
      if (method === github.rest.pulls.listReviews) return reviews;
      if (method === github.rest.pulls.listReviewComments) return reviewComments;
      if (method === github.rest.actions.listWorkflowRuns) return workflowRuns;
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
        listFiles() {},
        listReviews() {},
        listReviewComments() {},
        listRequestedReviewers: async () => ({data: requestedReviewers}),
        get: async args => {
          if (failDependency === args.pull_number) throw Error('partial API failure');
          detailedReads.push(args.pull_number);
          if (detailedPrs[args.pull_number]) return {data: detailedPrs[args.pull_number]};
          return {data: {
            merged: dependencyMerged[args.pull_number] === true,
            body: allPrs.find(pr => pr.number === args.pull_number)?.body
          }};
        },
        merge: async args => {
          mergedPrs.push(args);
          return {data: {merged: true}};
        }
      },
      actions: {
        listWorkflowRuns() {},
        getWorkflow: async () => ({data: {
          id: 12, path: orchestration.REQUIRED_WORKFLOW.path,
          name: orchestration.REQUIRED_WORKFLOW.name, state: 'active'
        }})
      }
    },
    graphql: async () => ({
      repository: {pullRequest: {reviewThreads: {
        nodes: reviewThreads, pageInfo: {hasNextPage: false, endCursor: null}
      }}}
    })
  };
  return {github, calls, detailedReads, mergedPrs};
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

  const staleLink = orchestrationGithub({
    issues: [candidate, completed, completedSecond], allPrs: [proof, secondProof],
    dependencyMerged: {[proof.number]: true, [secondProof.number]: true},
    detailedPrs: {[proof.number]: {merged: true, body: 'Closes #999'}}
  });
  assert.deepEqual((await runCoordinator(staleLink.github)).promoted, []);
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

test('partial sanitized report retains promotions when a later API call fails', async () => {
  const task = coordinatorTask();
  const planned = issue(task, {
    labels: [
      {name: 'agent:planned'},
      {name: `agent:role:${task.role}`},
      {name: `priority:${task.priority}`}
    ]
  });
  const {github} = orchestrationGithub({
    issues: [planned], openPrs: [{number: 44, body: 'Closes #17'}], failDependency: 44
  });
  await assert.rejects(runCoordinator(github), error => {
    assert.deepEqual(error.orchestrationReport.promoted, [task.issue]);
    assert.equal(error.orchestrationReport.decision, 'error');
    assert.doesNotMatch(JSON.stringify(error.orchestrationReport), /partial API failure/);
    return true;
  });
});

test('stale main catalog snapshots cannot promote or merge work', async () => {
  const task = coordinatorTask();
  const planned = issue(task, {
    labels: [
      {name: 'agent:planned'},
      {name: `agent:role:${task.role}`},
      {name: `priority:${task.priority}`}
    ]
  });
  const {github, calls} = orchestrationGithub({issues: [planned]});
  github.rest.repos.getBranch = async () => ({data: {commit: {sha: 'c'.repeat(40)}}});
  await assert.rejects(runCoordinator(github), /failed closed/);
  assert.deepEqual(calls, []);
});

test('newest CI run wins regardless of an older run attempt number', async () => {
  const staleSuccess = mergeMocks({
    workflowRuns: [
      {
        id: 101, created_at: '2026-11-06T08:59:00Z', run_attempt: 2,
        workflow_id: 12, head_sha: headSha, event: 'pull_request',
        status: 'completed', conclusion: 'success'
      },
      {
        id: 102, created_at: '2026-11-06T09:00:00Z', run_attempt: 1,
        workflow_id: 12, head_sha: headSha, event: 'pull_request',
        status: 'completed', conclusion: 'failure'
      }
    ]
  });
  assert.equal(await orchestration.mergeEligiblePullRequest(mergeArgs(staleSuccess)), false);
  assert.equal(staleSuccess.calls.length, 0);

  const newestAttempt = mergeMocks({
    workflowRuns: [
      {
        id: 101, created_at: '2026-11-06T09:00:00Z', run_attempt: 8,
        workflow_id: 12, head_sha: headSha, event: 'pull_request',
        status: 'completed', conclusion: 'success'
      },
      {
        id: 102, created_at: '2026-11-06T09:00:00Z', run_attempt: 1,
        workflow_id: 12, head_sha: headSha, event: 'pull_request',
        status: 'completed', conclusion: 'success'
      },
      {
        id: 102, created_at: '2026-11-06T09:00:00Z', run_attempt: 2,
        workflow_id: 12, head_sha: headSha, event: 'pull_request',
        status: 'completed', conclusion: 'failure'
      }
    ]
  });
  assert.equal(await orchestration.mergeEligiblePullRequest(mergeArgs(newestAttempt)), false);
  assert.equal(newestAttempt.calls.length, 0);
});

test('final issue reread must retain approval, role, file scope, and dependency metadata', async () => {
  const base = coordinatorTask();
  const changedIssues = [
    issue(base, {labels: [{name: 'agent:role:platform-engineer'}, {name: 'priority:p0'}]}),
    issue(base, {labels: [{name: 'agent:approved'}, {name: 'agent:role:qa-engineer'}, {name: 'priority:p0'}]}),
    issue(base, {body: 'Files: README.md\nDepends-On: none'}),
    issue(base, {body: `Files: ${base.files.join(', ')}\nDepends-On: #999`})
  ];
  for (const finalIssue of changedIssues) {
    const candidate = mergeMocks({finalIssue});
    assert.equal(await orchestration.mergeEligiblePullRequest(mergeArgs(candidate)), false);
    assert.equal(candidate.calls.length, 0);
  }

  const advancedMain = mergeMocks({finalMain: 'c'.repeat(40)});
  assert.equal(await orchestration.mergeEligiblePullRequest(mergeArgs(advancedMain)), false);
  assert.equal(advancedMain.calls.length, 0);

  const approvalRevokedLate = mergeMocks({
    finalIssueAfterFirstRead: issue(base, {
      labels: [{name: 'agent:role:platform-engineer'}, {name: 'priority:p0'}]
    })
  });
  assert.equal(await orchestration.mergeEligiblePullRequest(mergeArgs(approvalRevokedLate)), false);
  assert.equal(approvalRevokedLate.calls.length, 0);

  const mainAdvancedLate = mergeMocks({finalMainAfterFirstRead: 'c'.repeat(40)});
  assert.equal(await orchestration.mergeEligiblePullRequest(mergeArgs(mainAdvancedLate)), false);
  assert.equal(mainAdvancedLate.calls.length, 0);
});

test('current existing work is evaluated but CI workflow changes remain manual-review only', async () => {
  const data = catalog();
  const existing = data.existingWork[0];
  const workIssue = issue({
    issue: existing.issue, role: existing.role, priority: 'p1',
    files: existing.files, dependsOn: []
  }, {body: `Files: ${existing.files.join(', ')}\nDepends-On: none`});
  const listSummary = {number: existing.pullRequest, body: `Closes #${existing.issue}`};
  const detailed = {
    ...listSummary,
    state: 'open',
    changed_files: 1,
    draft: false,
    merged: false,
    mergeable: true,
    mergeable_state: 'clean',
    base: {ref: 'main', sha: mainSha, repo: {full_name: orchestration.REPOSITORY}},
    head: {ref: 'copilot/agent-copilot-fix-ci-recovery', sha: headSha,
      repo: {full_name: orchestration.REPOSITORY}},
    user: {login: 'Copilot'}
  };
  const {github, detailedReads} = orchestrationGithub({
    issues: [workIssue],
    openPrs: [listSummary],
    allPrs: [listSummary],
    detailedPrs: {[existing.pullRequest]: detailed},
    pullFiles: {[existing.pullRequest]: [{filename: '.github/workflows/ci.yml'}]}
  });
  const result = await runCoordinator(github);
  assert.deepEqual(detailedReads, [existing.pullRequest]);
  assert.deepEqual(result.merged, []);
  assert.deepEqual(result.blockers, [`manual-workflow-review:#${existing.pullRequest}`]);
});

test('existing work with missing issue dependency metadata is reported as held', async () => {
  const existing = catalog().existingWork[0];
  const workIssue = issue({
    issue: existing.issue, role: existing.role, priority: 'p1',
    files: existing.files, dependsOn: []
  }, {body: `Files: ${existing.files.join(', ')}`});
  const summary = {number: existing.pullRequest, body: `Closes #${existing.issue}`};
  const detail = {...summary, state: 'open'};
  const {github, detailedReads} = orchestrationGithub({
    issues: [workIssue], openPrs: [summary], allPrs: [summary],
    detailedPrs: {[existing.pullRequest]: detail}
  });
  const report = await runCoordinator(github);
  assert.deepEqual(detailedReads, [existing.pullRequest]);
  assert.deepEqual(report.blockers, [`existing-work-metadata:#${existing.issue}/PR#${existing.pullRequest}`]);
});

test('list summaries are detailed before a real-format COMMENTED review can authorize merge', async () => {
  const task = coordinatorTask();
  const workIssue = issue(task);
  const listSummary = {number: 45, body: 'Closes #17'};
  const detail = {
    ...listSummary,
    state: 'open',
    changed_files: 1,
    draft: false,
    merged: false,
    mergeable: true,
    mergeable_state: 'clean',
    base: {ref: 'main', sha: mainSha, repo: {full_name: orchestration.REPOSITORY}},
    head: {ref: 'copilot/task-17', sha: headSha, repo: {full_name: orchestration.REPOSITORY}},
    user: {login: 'Copilot'}
  };
  const review = {
    id: 8,
    state: 'COMMENTED',
    user: {login: 'copilot-pull-request-reviewer[bot]'},
    commit_id: headSha,
    submitted_at: '2026-11-06T09:00:00Z',
    body: `### ✅ Approval recommended

**No open issues** 🎉

| File | Description |
| --- | --- |
| \`${task.files[0]}\` | Reviewed on this commit. |`
  };
  const result = orchestrationGithub({
    issues: [workIssue],
    openPrs: [listSummary],
    allPrs: [listSummary],
    detailedPrs: {45: detail},
    pullFiles: {45: [{filename: task.files[0]}]},
    reviews: [review],
    reviewComments: [],
    requestedReviewers: {users: [], teams: []}
  });
  const report = await runCoordinator(result.github);
  assert.deepEqual(report.merged, [45]);
  assert.deepEqual(result.mergedPrs.map(merge => merge.sha), [headSha]);
  assert.ok(result.detailedReads.length >= 3);
});

function mergeMocks({head = headSha, base = mainSha, state = 'clean', ciWorkflowId = 12,
  review = true, reviewBody, reviewHead = head, unresolved = false, changesRequested = false,
  pendingReviewRequest = false, lateReviewRequest = false, lateChangesRequested = false, changedFiles,
  reportedChangedFiles, workflowRuns, finalIssue, finalIssueAfterFirstRead,
  finalBase = mainSha, author = 'copilot-swe-agent[bot]', finalMain = mainSha,
  finalMainAfterFirstRead, finalState = 'open', reviewUser = 'copilot-pull-request-reviewer[bot]',
  branch = 'copilot/task-17'} = {}) {
  const calls = [];
  let reviewRequestCalls = 0;
  let reviewCalls = 0;
  let issueReadCalls = 0;
  let mainReadCalls = 0;
  const workflow = {id: 12, path: orchestration.REQUIRED_WORKFLOW.path, name: orchestration.REQUIRED_WORKFLOW.name};
  const task = coordinatorTask();
  const fileEntries = (changedFiles || [task.files[0]]).map(file =>
    typeof file === 'string' ? {filename: file} : file);
  const fileList = fileEntries.map(file => file.filename);
  const reviewText = reviewBody ?? `### ✅ Approval recommended

**No open issues** 🎉

| File | Description |
| --- | --- |
${fileList.map(file => `| \`${file}\` | Reviewed on this commit. |`).join('\n')}`;
  const pr = {
    number: 45,
    body: 'Closes #17',
    state: 'open',
    draft: false,
    merged: false,
    changed_files: reportedChangedFiles ?? fileList.length,
    mergeable: true,
    mergeable_state: state,
    base: {ref: 'main', sha: base, repo: {full_name: orchestration.REPOSITORY}},
    head: {ref: branch, sha: head, repo: {full_name: orchestration.REPOSITORY}},
    user: {login: author}
  };
  const linkedIssue = issue(task);
  const github = {
    paginate: async (method) => {
      if (method === github.rest.pulls.listFiles) return fileEntries;
      if (method === github.rest.actions.listWorkflowRuns) return workflowRuns || [{
        id: 100, created_at: '2026-11-06T09:00:00Z',
        workflow_id: ciWorkflowId, head_sha: head, event: 'pull_request',
        status: 'completed', conclusion: 'success', run_attempt: 1
      }];
      if (method === github.rest.pulls.listReviews) {
        reviewCalls++;
        const requestsChanges = changesRequested || (lateChangesRequested && reviewCalls > 1);
        return review ? [{
          id: 8, user: {login: reviewUser},
          state: requestsChanges ? 'CHANGES_REQUESTED' : 'COMMENTED',
          commit_id: reviewHead, body: reviewText, submitted_at: '2026-11-06T09:00:00Z'
        }] : [];
      }
      if (method === github.rest.pulls.list) return [];
      if (method === github.rest.pulls.listReviewComments) return [];
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
        listRequestedReviewers: async () => {
          reviewRequestCalls++;
          const pending = pendingReviewRequest || (lateReviewRequest && reviewRequestCalls > 1);
          return {data: {users: pending ? [{login: 'reviewer'}] : [], teams: []}};
        },
        get: async () => ({data: {
          ...pr, state: finalState,
          ...(finalBase !== mainSha ? {base: {...pr.base, sha: finalBase}} : {}),
          head: {...pr.head, sha: head}, base: {...pr.base, sha: finalBase}
        }}),
        merge: async args => {calls.push(args);return {data: {merged: true}}}
      },
      issues: {
        get: async () => {
          issueReadCalls++;
          return {data: issueReadCalls > 1 ? finalIssueAfterFirstRead || finalIssue || linkedIssue :
            finalIssue || linkedIssue};
        }
      },
      actions: {listWorkflowRuns() {}},
      repos: {getBranch: async () => {
        mainReadCalls++;
        return {data: {commit: {sha: mainReadCalls > 1 ? finalMainAfterFirstRead || finalMain : mainSha}}};
      }}
    }
  };
  const tasks = orchestration.validateCatalog(catalog());
  const issuesByNumber = new Map([[task.issue, linkedIssue]]);
  return {
    github, calls, pr, task, linkedIssue, workflow, tasks, issuesByNumber, allPrs: []
  };
}

function mergeArgs(value) {
  return {
    ...value, issue: value.linkedIssue, owner: 'totorina47501-wq', repo: 'SaasFactory',
    workflow: value.workflow, mainSha
  };
}

test('merge requires authenticated CI and final review of changed files on the current head', async () => {
  const valid = mergeMocks();
  assert.equal(await orchestration.mergeEligiblePullRequest({
    ...mergeArgs(valid)
  }), true);
  assert.equal(valid.calls.length, 1);
  assert.equal(valid.calls[0].sha, headSha);

  for (const options of [
    {base: 'c'.repeat(40)},
    {state: 'dirty'},
    {ciWorkflowId: 99},
    {review: false},
    {reviewUser: 'someone-else[bot]'},
    {reviewBody: 'Approval recommended\n\nNo open issues'},
    {reviewBody: `Approval recommended\n\nNo open issues\n\n| File | Description |\n| --- | --- |\n| \`README.md\` | Not the changed file. |`},
    {reviewHead: 'd'.repeat(40)},
    {unresolved: true},
    {changesRequested: true},
    {pendingReviewRequest: true},
    {lateChangesRequested: true},
    {changedFiles: ['README.md']},
    {reportedChangedFiles: 2},
    {changedFiles: [coordinatorTask().files[0]], finalIssue: issue(coordinatorTask(), {state: 'closed'})},
    {changedFiles: [coordinatorTask().files[0]], finalBase: 'c'.repeat(40)},
    {finalState: 'closed'},
    {changedFiles: ['.github/workflows/ci.yml']},
    {author: 'someone-else'},
    {branch: 'feature/task-17'}
  ]) {
    const invalid = mergeMocks(options);
    assert.equal(await orchestration.mergeEligiblePullRequest(mergeArgs(invalid)), false);
    assert.equal(invalid.calls.length, 0);
  }
});

test('rename sources are scope-checked but only destination paths require review coverage', async () => {
  const task = coordinatorTask();
  const allowedRename = mergeMocks({
    changedFiles: [{filename: task.files[0], previous_filename: task.files[1]}]
  });
  assert.equal(await orchestration.mergeEligiblePullRequest(mergeArgs(allowedRename)), true);
  assert.equal(allowedRename.calls.length, 1);

  const outOfScopeRename = mergeMocks({
    changedFiles: [{filename: task.files[0], previous_filename: 'README.md'}]
  });
  assert.equal(await orchestration.mergeEligiblePullRequest(mergeArgs(outOfScopeRename)), false);
  assert.equal(outOfScopeRename.calls.length, 0);
});

test('new head SHA must have its own successful CI, review, and expected merge SHA', async () => {
  const newHead = 'c'.repeat(40);
  const current = mergeMocks({head: newHead});
  assert.equal(await orchestration.mergeEligiblePullRequest(mergeArgs(current)), true);
  assert.equal(current.calls[0].sha, newHead);
});

test('merge never retries changed heads or already merged PRs', async () => {
  const stale = mergeMocks();
  stale.github.rest.pulls.get = async () => ({
    data: {...stale.pr, head: {ref: stale.pr.head.ref, sha: 'c'.repeat(40)},
      base: {ref: 'main', sha: mainSha}}
  });
  assert.equal(await orchestration.mergeEligiblePullRequest({
    ...mergeArgs(stale)
  }), false);
  assert.equal(stale.calls.length, 0);

  const replay = mergeMocks();
  replay.pr.merged = true;
  assert.equal(await orchestration.mergeEligiblePullRequest({
    ...mergeArgs(replay)
  }), false);
  assert.equal(replay.calls.length, 0);
});

test('merge rechecks reviewer requests immediately before merging', async () => {
  const lateRequest = mergeMocks({lateReviewRequest: true});
  assert.equal(await orchestration.mergeEligiblePullRequest(mergeArgs(lateRequest)), false);
  assert.equal(lateRequest.calls.length, 0);
});

test('recovery attempts stop at two for one PR/SHA', () => {
  assert.equal(orchestration.retryAllowed(0), true);
  assert.equal(orchestration.retryAllowed(1), true);
  assert.equal(orchestration.retryAllowed(2), false);
  assert.equal(orchestration.retryAllowed(-1), false);
  assert.equal(orchestration.retryAllowed(1.5), false);
});
