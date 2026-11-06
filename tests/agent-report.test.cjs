'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const reportAgent = require('../.github/scripts/agent-report.cjs');

function fixture(options = {}) {
  const calls = [];
  const sources = {
    main: {data: {commit: {sha: 'main-sha', commit: {
      committer: {date: '2026-11-05T12:00:00Z'}, author: {date: '2026-11-05T11:59:00Z'}
    }}}},
    runs: [{id: 12, name: 'CI', workflow_id: 3, run_number: 4, event: 'push', status: 'completed', conclusion: 'failure',
      created_at: '2026-11-05T12:00:00Z', updated_at: '2026-11-05T12:01:00Z', run_started_at: '2026-11-05T12:00:10Z',
      head_branch: 'main', head_sha: 'run-sha', html_url: 'https://example.test/run/12'}],
    jobs: [{id: 30, name: 'test', status: 'completed', conclusion: 'failure', started_at: '2026-11-05T12:00:10Z',
      completed_at: '2026-11-05T12:01:00Z', html_url: 'https://example.test/job/30'}],
    issues: [
      {number: 5, title: 'Active mission', html_url: 'https://example.test/issues/5', updated_at: '2026-11-05T12:02:00Z',
        labels: [{name: 'agent:blocked'}], assignees: [{login: 'copilot'}]},
      {number: 6, title: 'Regular issue', labels: [], assignees: []}
    ],
    openPulls: [{
      number: 7, title: 'Open PR', html_url: 'https://example.test/pull/7', state: 'open', draft: false,
      created_at: '2026-11-05T12:00:00Z', updated_at: '2026-11-05T12:03:00Z',
      head: {ref: 'copilot/task', sha: 'pr-head-sha'}, base: {ref: 'main', sha: 'pr-base-sha'},
      requested_reviewers: [{login: 'reviewer'}], requested_teams: [{slug: 'maintainers'}]
    }],
    reviews: [{user: {login: 'reviewer'}, state: 'COMMENTED', submitted_at: '2026-11-05T12:04:00Z'}],
    decision: {repository: {pullRequest: {reviewDecision: 'REVIEW_REQUIRED'}}},
    closedPulls: [
      {number: 8, title: 'Recent fix', html_url: 'https://example.test/pull/8', merged_at: '2026-11-05T12:05:00Z',
        updated_at: '2026-11-05T12:05:00Z', head: {sha: 'fix-head-sha'}, merge_commit_sha: 'merge-sha'},
      {number: 9, title: 'Closed without merge', merged_at: null}
    ]
  };
  const shouldFail = name => options.fail?.includes(name);
  const github = {
    rest: {
      repos: {getBranch: async () => {
        if (shouldFail('main')) throw Error('branch unavailable');
        return sources.main;
      }},
      actions: {
        listWorkflowRunsForRepo: async () => {
          if (shouldFail('runs')) throw Error('runs unavailable');
          if (options.malformedRuns) return {data: {}};
          return {data: {workflow_runs: sources.runs}};
        },
        listJobsForWorkflowRun: async () => {
          if (shouldFail('jobs')) throw Error('jobs unavailable');
          return {data: {jobs: sources.jobs}};
        }
      },
      issues: {listForRepo() {}},
      pulls: {list() {}, listReviews() {}}
    },
    paginate: async (method, args) => {
      if (method === github.rest.issues.listForRepo) {
        if (shouldFail('issues')) throw Error('issues unavailable');
        return sources.issues;
      }
      if (method === github.rest.pulls.list) return args.state === 'open' ? sources.openPulls : sources.closedPulls;
      if (method === github.rest.pulls.listReviews) return sources.reviews;
      throw Error('unexpected pagination request');
    },
    graphql: async () => sources.decision
  };
  const core = {summary: {
    content: '',
    addHeading(value) { this.content += value; return this; },
    addRaw(value) { this.content += value; return this; },
    async write() { calls.push('summary-written'); }
  }};
  const writes = [];
  const context = {repo: {owner: 'totorina47501-wq', repo: 'SaasFactory'}, eventName: 'schedule', ref: 'refs/heads/main'};
  const run = async () => {
    const previous = process.env.EXPECTED_REPO;
    process.env.EXPECTED_REPO = 'totorina47501-wq/SaasFactory';
    try {
      await reportAgent({github, context, core, fs: {writeFileSync: (path, text) => writes.push({path, report: JSON.parse(text)})}});
    } finally {
      if (previous === undefined) delete process.env.EXPECTED_REPO;
      else process.env.EXPECTED_REPO = previous;
    }
    return {report: writes.at(-1)?.report, path: writes.at(-1)?.path, calls, summary: core.summary.content};
  };
  return run;
}

test('reports source SHAs, dates, conclusions, active work, approvals, and blockers', async () => {
  const result = await fixture()();
  const {report} = result;
  assert.equal(result.path, 'agent-report.json');
  assert.equal(report.complete, true);
  assert.deepEqual(report.main, {
    branch: 'main', sha: 'main-sha', committedAt: '2026-11-05T12:00:00Z', authoredAt: '2026-11-05T11:59:00Z'
  });
  assert.equal(report.workflowRuns[0].headSha, 'run-sha');
  assert.equal(report.workflowRuns[0].conclusion, 'failure');
  assert.equal(report.workflowRuns[0].jobs[0].conclusion, 'failure');
  assert.deepEqual(report.activeCopilotIssues.map(issue => issue.number), [5]);
  assert.equal(report.openPullRequests[0].head.sha, 'pr-head-sha');
  assert.equal(report.openPullRequests[0].reviewDecision, 'REVIEW_REQUIRED');
  assert.equal(report.openPullRequests[0].reviews[0].submittedAt, '2026-11-05T12:04:00Z');
  assert.equal(report.recentMergedPullRequests[0].mergeCommitSha, 'merge-sha');
  assert.deepEqual(report.blockers.map(blocker => blocker.type), ['blocked-issue', 'failed-workflow-run', 'approval-required']);
  assert.ok(result.summary.includes('Report completeness: complete'));
  assert.ok(result.calls.includes('summary-written'));
});

test('API failures produce an incomplete report without fabricated source data', async () => {
  const result = await fixture({fail: ['main', 'runs', 'issues', 'jobs']})();
  assert.equal(result.report.complete, false);
  assert.equal(result.report.main, null);
  assert.deepEqual(result.report.workflowRuns, []);
  assert.deepEqual(result.report.activeCopilotIssues, []);
  assert.equal(result.report.sources.mainBranch, 'unavailable');
  assert.equal(result.report.sources.workflowRuns, 'unavailable');
  assert.equal(result.report.sources.copilotIssues, 'unavailable');
  assert.ok(result.report.errors.some(error => error.source === 'mainBranch'));
  assert.ok(result.summary.includes('Report completeness: incomplete'));
  assert.ok(result.calls.includes('summary-written'));
});

test('malformed API responses are incomplete rather than empty success', async () => {
  const result = await fixture({malformedRuns: true})();
  assert.equal(result.report.complete, false);
  assert.deepEqual(result.report.workflowRuns, []);
  assert.equal(result.report.sources.workflowRuns, 'unavailable');
  assert.ok(result.report.errors.some(error => error.message.includes('workflow runs missing')));
});

test('workflow is scheduled six-hourly and grants only read permissions', () => {
  const workflow = fs.readFileSync(`${__dirname}/../.github/workflows/saas-factory-agent-report.yml`, 'utf8');
  assert.match(workflow, /cron:\s*['"]0 0,6,12,18 \* \* \*['"]/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /actions:\s*read/);
  assert.match(workflow, /contents:\s*read/);
  assert.match(workflow, /issues:\s*read/);
  assert.match(workflow, /pull-requests:\s*read/);
  assert.match(workflow, /if:\s*github\.ref == 'refs\/heads\/main'/);
  assert.doesNotMatch(workflow, /(?:issues|pull-requests|actions|contents):\s*write/);
  assert.doesNotMatch(workflow, /secrets\.(?!GITHUB_TOKEN)/);
});
