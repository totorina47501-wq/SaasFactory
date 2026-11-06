'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const recover = require('../.github/scripts/agent-ci-recovery.cjs');

const WORKFLOW = fs.readFileSync(path.join(__dirname, '../.github/workflows/saas-factory-agent-ci-recovery.yml'), 'utf8');
const REPO = 'totorina47501-wq/SaasFactory';
const SHA = 'a'.repeat(40);

test('CI executes the recovery security suite', () => {
  const ci=fs.readFileSync(path.join(__dirname,'../.github/workflows/ci.yml'),'utf8');
  assert.match(ci,/run: node --test tests\/agent-ci-recovery\.test\.cjs/);
});

test('uppercase ledger statuses cannot reset the retry quota or bypass a block', async () => {
  const comments=[];
  await exercise({comments,runId:1});
  await exercise({comments,runId:2});
  for(const c of comments)c.body=c.body.replace('status=retry','status=RETRY');
  const blocked=await exercise({comments,runId:3});
  assert.equal(blocked.report.decision,'blocked:attempt-limit-reached');
  assert.equal(comments.length,3);
  comments[2].body=comments[2].body.replace('status=blocked','status=BLOCKED');
  const replay=await exercise({comments,runId:4});
  assert.equal(replay.report.decision,'blocked:attempt-limit-reached');
  assert.equal(replay.created.length,0);
});

test('changes during ledger pagination invalidate eligibility before any write', async () => {
  for(const drift of ['head','close','revoke','link','base','author','role']) {
    const state=await exercise({drift});
    assert.equal(state.created.length,0,drift);
    assert.equal(state.report.decision,'ignored:eligibility-changed',drift);
  }
});

test('unverifiable authors and inconsistent PR markers cannot reset the quota', async () => {
  const valid=[];
  await exercise({comments:valid,runId:1});
  for(const broken of [
    {...valid[0],user:null},
    {...valid[0],body:null},
    {...valid[0],body:valid[0].body.replace(';pr=12;',';pr=99;')}
  ]) {
    await assert.rejects(exercise({comments:[broken],runId:2}),/failed closed/);
  }
});

test('recovery requires exactly one valid specialist role', async () => {
  for(const roles of [[],['unknown'],['platform-engineer','qa-engineer']]) {
    const state=await exercise({roles});
    assert.equal(state.created.length,0);
    assert.equal(state.report.decision,'ignored');
  }
});

test('workflow is failure-only, guarded, and checks out only trusted main with read-only contents', () => {
  assert.match(WORKFLOW, /@copilot comment trigger is unverified/);
  assert.match(WORKFLOW, /workflow_run:\s*\n\s+workflows: \["SaaS Factory CI"\]\s*\n\s+types: \[completed\]/);
  assert.match(WORKFLOW, /github\.repository == 'totorina47501-wq\/SaasFactory'/);
  assert.match(WORKFLOW, /github\.event\.workflow_run\.conclusion == 'failure'/);
  assert.match(WORKFLOW, /vars\.SAAS_FACTORY_CI_RECOVERY_ENABLED == 'true'/);
  assert.match(WORKFLOW, /issues: write/);
  assert.match(WORKFLOW, /pull-requests: read/);
  assert.match(WORKFLOW, /actions: read/);
  assert.match(WORKFLOW, /contents: read/);
  assert.match(WORKFLOW, /concurrency:\s*\n\s+group: saas-factory-ci-recovery-\$\{\{ github\.event\.workflow_run\.pull_requests\[0\]\.number \|\| 'unassociated' \}\}/);
  const checkout = WORKFLOW.slice(WORKFLOW.indexOf('uses: actions/checkout@v4'), WORKFLOW.indexOf('uses: actions/github-script@v7'));
  assert.match(checkout, /ref: main/);
  assert.match(checkout, /persist-credentials: false/);
  assert.doesNotMatch(checkout, /workflow_run\.head_sha|pull_request\.head\.sha/);
  assert.doesNotMatch(WORKFLOW, /pull_request:|pull_request_target:/);
});

function fixture(options = {}) {
  const comments = options.comments || [];
  const created = [];
  const run = {
    id: options.runId || 1,
    workflow_id: 100,
    name: options.name || 'SaaS Factory CI',
    event: options.event || 'pull_request',
    conclusion: options.conclusion || 'failure',
    repository: {full_name: REPO},
    head_repository: {full_name: options.fork ? 'someone/SaasFactory' : REPO},
    head_branch: options.branch || 'copilot/fix-ci',
    head_sha: options.sha || SHA,
    pull_requests: [{number: 12}]
  };
  const pr = {
    state: 'open',
    base: {ref: 'main'},
    head: {
      ref: run.head_branch,
      sha: run.head_sha,
      repo: {full_name: options.fork ? 'someone/SaasFactory' : REPO}
    },
    user: {login: options.author || 'Copilot'},
    body: options.prBody || 'Fixes #6'
  };
  const issue = {
    state: options.issueState || 'open',
    labels: options.approved === false ? [] : [{name: 'agent:approved'},...(options.roles??['platform-engineer']).map(role=>({name:'agent:role:'+role}))]
  };
  const github = {
    rest: {
      actions: {
        getWorkflowRun: async () => {
          if (options.failAt === 'run') throw new Error('untrusted API detail');
          return {data: run};
        },
        getWorkflow: async () => {
          if (options.failAt === 'workflow') throw new Error('untrusted API detail');
          return {data: {
            path: options.workflowPath || '.github/workflows/ci.yml',
            name: 'SaaS Factory CI'
          }};
        }
      },
      pulls: {
        get: async () => {
          if (options.failAt === 'pr') throw new Error('untrusted API detail');
          return {data: pr};
        }
      },
      issues: {
        get: async () => {
          if (options.failAt === 'issue') throw new Error('untrusted API detail');
          return {data: issue};
        },
        listComments: async ({page}) => {
          if (options.failAt === 'comments') throw new Error('untrusted API detail');
          if(options.drift==='head')pr.head.sha='b'.repeat(40);
          if(options.drift==='close')pr.state='closed';
          if(options.drift==='revoke')issue.labels=[];
          if(options.drift==='link')pr.body='Fixes #7';
          if(options.drift==='base')pr.base.ref='other';
          if(options.drift==='author')pr.user.login='someone';
          if(options.drift==='role')issue.labels=[{name:'agent:approved'}];
          return {data: comments.slice((page - 1) * 100, page * 100)};
        },
        createComment: async (request) => {
          if (options.failAt === 'write') throw new Error('untrusted API detail');
          const comment = {user: {login: 'github-actions[bot]'}, body: request.body};
          created.push(comment);
          comments.push(comment);
        }
      }
    }
  };
  const summary = {text: '', addHeading() { return this; }, addRaw(text) { this.text += text; return this; }, async write() {}};
  const context = {
    eventName: options.eventName || 'workflow_run',
    repo: {owner: 'totorina47501-wq', repo: 'SaasFactory'},
    payload: {
      workflow_run: {
        id: run.id,
        pull_requests: options.payloadPullRequests === undefined ? [{number: 12}] : options.payloadPullRequests
      }
    }
  };
  return {github, context, summary, comments, created, run};
}

async function exercise(options = {}) {
  const previous = process.env.EXPECTED_REPO;
  process.env.EXPECTED_REPO = REPO;
  const state = fixture(options);
  try {
    const report = await recover({...state, core: {summary: state.summary}});
    return {...state, report};
  } finally {
    if (previous === undefined) delete process.env.EXPECTED_REPO;
    else process.env.EXPECTED_REPO = previous;
  }
}

test('requests one predefined correction and replaying the same failure is idempotent', async () => {
  const state = await exercise();
  assert.equal(state.report.decision, 'requested:attempt-1');
  assert.equal(state.created.length, 1);
  assert.match(state.created[0].body, /^@copilot Please inspect the failing checks/);
  assert.match(state.created[0].body, /automatic correction request 1\/2/);
  assert.doesNotMatch(state.created[0].body, /untrusted API detail|stack trace/i);

  const replay = await exercise({comments: state.comments});
  assert.equal(replay.report.decision, 'ignored:duplicate-failure');
  assert.equal(replay.created.length, 0);
});

test('allows at most two correction requests for one PR and SHA, then marks it blocked', async () => {
  const comments = [];
  assert.equal((await exercise({comments, runId: 1})).report.decision, 'requested:attempt-1');
  assert.equal((await exercise({comments, runId: 2})).report.decision, 'requested:attempt-2');
  assert.equal((await exercise({comments, runId: 3})).report.decision, 'blocked:attempt-limit-reached');
  assert.equal(comments.length, 3);
  assert.match(comments[2].body, /blocked after the maximum of two correction requests/);
  assert.equal((await exercise({comments, runId: 4})).report.decision, 'blocked:attempt-limit-reached');
  assert.equal(comments.length, 3);
});

test('a new SHA gets an independent two-request quota', async () => {
  const comments = [];
  await exercise({comments, runId: 1});
  await exercise({comments, runId: 2});
  await exercise({comments, runId: 3});
  const nextSha = 'b'.repeat(40);
  const next = await exercise({comments, runId: 4, sha: nextSha});
  assert.equal(next.report.decision, 'requested:attempt-1');
  assert.equal(next.report.sha, nextSha);
});

test('refuses to act when the persistent recovery ledger is malformed', async () => {
  const state = fixture({
    comments: [{user: {login: 'github-actions[bot]'}, body: '<!-- saas-factory-ci-recovery:corrupt -->'}]
  });
  const previous = process.env.EXPECTED_REPO;
  process.env.EXPECTED_REPO = REPO;
  try {
    await assert.rejects(
      recover({...state, core: {summary: state.summary}}),
      /failed closed; verification or GitHub API operation did not complete/
    );
  } finally {
    if (previous === undefined) delete process.env.EXPECTED_REPO;
    else process.env.EXPECTED_REPO = previous;
  }
  assert.equal(state.created.length, 0);
  assert.match(state.summary.text, /blocked:verification-or-api-failure/);
});

test('fails closed when the persistent recovery ledger exceeds the page limit', async () => {
  const state = fixture({comments: Array.from({length: 1000}, () => ({user: {login: 'someone'}, body: 'ordinary comment'}))});
  const previous = process.env.EXPECTED_REPO;
  process.env.EXPECTED_REPO = REPO;
  try {
    await assert.rejects(
      recover({...state, core: {summary: state.summary}}),
      /failed closed; verification or GitHub API operation did not complete/
    );
  } finally {
    if (previous === undefined) delete process.env.EXPECTED_REPO;
    else process.env.EXPECTED_REPO = previous;
  }
  assert.equal(state.created.length, 0);
  assert.match(state.summary.text, /blocked:verification-or-api-failure/);
});

test('ignores main, forks, non-Copilot PRs, and non-failure workflow conclusions', async () => {
  for (const options of [
    {event: 'push', branch: 'main'},
    {fork: true},
    {branch: 'feature/change'},
    {author: 'someone'},
    {name: 'Other workflow'},
    {workflowPath: '.github/workflows/another-ci.yml'},
    {payloadPullRequests: []},
    {payloadPullRequests: [{number: 13}]},
    {conclusion: 'cancelled'},
    {conclusion: 'skipped'},
    {conclusion: 'action_required'},
    {approved: false}
  ]) {
    const state = await exercise(options);
    assert.equal(state.created.length, 0, JSON.stringify(options));
    assert.equal(state.report.decision, 'ignored', JSON.stringify(options));
  }
});

test('fails closed on GitHub API errors without exposing API details or writing a correction', async () => {
  for (const failAt of ['run', 'workflow', 'pr', 'issue', 'comments', 'write']) {
    const state = fixture({failAt});
    const previous = process.env.EXPECTED_REPO;
    process.env.EXPECTED_REPO = REPO;
    try {
      await assert.rejects(
        recover({...state, core: {summary: state.summary}}),
        /failed closed; verification or GitHub API operation did not complete/
      );
    } finally {
      if (previous === undefined) delete process.env.EXPECTED_REPO;
      else process.env.EXPECTED_REPO = previous;
    }
    assert.equal(state.created.length, 0, failAt);
    assert.doesNotMatch(state.summary.text, /untrusted API detail/);
    assert.match(state.summary.text, /blocked:verification-or-api-failure/);
  }
});

