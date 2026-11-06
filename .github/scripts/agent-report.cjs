'use strict';

module.exports = async ({github, context, core, fs}) => {
  const owner = context.repo.owner;
  const repo = context.repo.repo;
  if (`${owner}/${repo}` !== process.env.EXPECTED_REPO) throw Error('Repository guard rejected');

  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    repository: `${owner}/${repo}`,
    event: context.eventName,
    sources: {},
    errors: [],
    main: null,
    workflowRuns: [],
    activeCopilotIssues: [],
    openPullRequests: [],
    recentMergedPullRequests: [],
    blockers: [],
    complete: true
  };
  const capture = async (source, request, fallback) => {
    try {
      const result = await request();
      report.sources[source] = 'available';
      return result;
    } catch (error) {
      report.sources[source] = 'unavailable';
      report.errors.push({source, message: String(error?.message || error).slice(0, 300)});
      return fallback;
    }
  };
  const labelNames = item => (item.labels || []).map(label => typeof label === 'string' ? label : label.name);
  const isCopilotActive = issue =>
    (issue.assignees || []).some(assignee => /^(copilot|copilot-swe-agent)(\[bot\])?$/i.test(assignee.login)) ||
    labelNames(issue).some(label => ['agent:in-progress', 'agent:review', 'agent:blocked'].includes(label));
  const issueFields = issue => ({
    number: issue.number,
    title: issue.title,
    url: issue.html_url,
    updatedAt: issue.updated_at,
    labels: labelNames(issue),
    assignees: (issue.assignees || []).map(assignee => assignee.login)
  });
  const pullFields = pull => ({
    number: pull.number,
    title: pull.title,
    url: pull.html_url,
    state: pull.state,
    draft: pull.draft,
    createdAt: pull.created_at,
    updatedAt: pull.updated_at,
    head: {ref: pull.head?.ref, sha: pull.head?.sha},
    base: {ref: pull.base?.ref, sha: pull.base?.sha},
    requestedReviewers: (pull.requested_reviewers || []).map(reviewer => reviewer.login),
    requestedTeams: (pull.requested_teams || []).map(team => team.slug),
    reviewDecision: null,
    reviews: []
  });

  const [mainBranch, runs, issues, openPulls, closedPulls] = await Promise.all([
    capture('mainBranch', async () => {
      const result = await github.rest.repos.getBranch({owner, repo, branch: 'main'});
      if (!result?.data?.commit?.sha) throw Error('main branch SHA missing from API response');
      return result;
    }, null),
    capture('workflowRuns', async () => {
      const result = await github.rest.actions.listWorkflowRunsForRepo({owner, repo, branch: 'main', per_page: 10});
      if (!Array.isArray(result?.data?.workflow_runs)) throw Error('workflow runs missing from API response');
      return result.data.workflow_runs;
    }, null),
    capture('copilotIssues', async () => {
      const result = await github.paginate(github.rest.issues.listForRepo, {owner, repo, state: 'open', per_page: 100});
      if (!Array.isArray(result)) throw Error('issues missing from API response');
      return result;
    }, null),
    capture('openPullRequests', async () => {
      const result = await github.paginate(github.rest.pulls.list, {owner, repo, state: 'open', per_page: 100});
      if (!Array.isArray(result)) throw Error('open pull requests missing from API response');
      return result;
    }, null),
    capture('recentMergedPullRequests', async () => {
      const result = await github.paginate(github.rest.pulls.list, {owner, repo, state: 'closed', sort: 'updated', direction: 'desc', per_page: 100});
      if (!Array.isArray(result)) throw Error('closed pull requests missing from API response');
      return result;
    }, null)
  ]);

  if (mainBranch) {
    report.main = {
      branch: 'main',
      sha: mainBranch.data.commit.sha,
      committedAt: mainBranch.data.commit.commit?.committer?.date ?? null,
      authoredAt: mainBranch.data.commit.commit?.author?.date ?? null
    };
  }

  if (issues) {
    report.activeCopilotIssues = issues.filter(isCopilotActive).map(issueFields);
    report.blockers.push(...report.activeCopilotIssues
      .filter(issue => issue.labels.includes('agent:blocked'))
      .map(issue => ({type: 'blocked-issue', number: issue.number, title: issue.title, updatedAt: issue.updatedAt})));
  }

  if (runs) {
    let jobFailures = 0;
    const jobsByRun = await Promise.all(runs.map(async run => {
      try {
        const result = await github.rest.actions.listJobsForWorkflowRun({owner, repo, run_id: run.id, per_page: 100});
        if (!Array.isArray(result?.data?.jobs)) throw Error('workflow jobs missing from API response');
        return result.data.jobs;
      } catch (error) {
        jobFailures++;
        report.errors.push({source: 'workflowJobs', message: String(error?.message || error).slice(0, 300)});
        return null;
      }
    }));
    report.sources.workflowJobs = jobFailures === 0 ? 'available' : jobFailures === runs.length ? 'unavailable' : 'partial';
    report.workflowRuns = runs.map((run, index) => ({
      id: run.id,
      name: run.name,
      workflowId: run.workflow_id,
      runNumber: run.run_number,
      event: run.event,
      status: run.status,
      conclusion: run.conclusion,
      createdAt: run.created_at,
      updatedAt: run.updated_at,
      startedAt: run.run_started_at,
      headBranch: run.head_branch,
      headSha: run.head_sha,
      url: run.html_url,
      jobs: (jobsByRun[index] || []).map(job => ({
        id: job.id,
        name: job.name,
        status: job.status,
        conclusion: job.conclusion,
        startedAt: job.started_at,
        completedAt: job.completed_at,
        url: job.html_url
      }))
    }));
    report.blockers.push(...report.workflowRuns
      .filter(run => run.conclusion === 'failure')
      .map(run => ({type: 'failed-workflow-run', id: run.id, name: run.name, headSha: run.headSha, updatedAt: run.updatedAt, url: run.url})));
  } else {
    report.sources.workflowJobs = 'unavailable';
  }

  if (openPulls) {
    const outcomes = await Promise.all(openPulls.map(async pull => {
      const item = pullFields(pull);
      const [reviews, decision] = await Promise.all([
        capture(`pullRequestReviews:${pull.number}`, async () => {
          const result = await github.paginate(github.rest.pulls.listReviews, {owner, repo, pull_number: pull.number, per_page: 100});
          if (!Array.isArray(result)) throw Error('pull request reviews missing from API response');
          return result;
        }, null),
        capture(`pullRequestDecision:${pull.number}`, async () => {
          const result = await github.graphql(
            'query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){pullRequest(number:$number){reviewDecision}}}',
            {owner, repo, number: pull.number}
          );
          if (!result?.repository?.pullRequest || !Object.hasOwn(result.repository.pullRequest, 'reviewDecision')) {
            throw Error('pull request review decision missing from API response');
          }
          return result;
        }, null)
      ]);
      if (reviews) item.reviews = reviews.map(review => ({
        user: review.user?.login,
        state: review.state,
        submittedAt: review.submitted_at
      }));
      if (decision) item.reviewDecision = decision.repository?.pullRequest?.reviewDecision ?? null;
      if (item.reviewDecision === 'CHANGES_REQUESTED') {
        report.blockers.push({type: 'changes-requested', number: item.number, title: item.title, updatedAt: item.updatedAt});
      }
      return item;
    }));
    report.openPullRequests = outcomes;
    const reviewSources = Object.entries(report.sources).filter(([source]) =>
      source.startsWith('pullRequestReviews:') || source.startsWith('pullRequestDecision:'));
    report.sources.pullRequestReviews = reviewSources.every(([, status]) => status === 'available') ? 'available' :
      reviewSources.some(([, status]) => status === 'available') ? 'partial' : openPulls.length ? 'unavailable' : 'available';
    report.blockers.push(...report.openPullRequests
      .filter(pull => pull.reviewDecision === 'REVIEW_REQUIRED')
      .map(pull => ({
        type: 'approval-required',
        number: pull.number,
        title: pull.title,
        requestedReviewers: pull.requestedReviewers,
        requestedTeams: pull.requestedTeams
      })));
  } else {
    report.sources.pullRequestReviews = 'unavailable';
  }

  if (closedPulls) {
    report.recentMergedPullRequests = closedPulls
      .filter(pull => pull.merged_at)
      .sort((a, b) => String(b.merged_at).localeCompare(String(a.merged_at)))
      .slice(0, 10)
      .map(pull => ({
        number: pull.number,
        title: pull.title,
        url: pull.html_url,
        mergedAt: pull.merged_at,
        updatedAt: pull.updated_at,
        headSha: pull.head?.sha,
        mergeCommitSha: pull.merge_commit_sha
      }));
  }

  report.complete = Object.values(report.sources).every(status => status === 'available');
  fs.writeFileSync('agent-report.json', `${JSON.stringify(report, null, 2)}\n`);
  const unavailable = Object.entries(report.sources)
    .filter(([, status]) => status !== 'available')
    .map(([source, status]) => `${source}: ${status}`);
  const approvalsNeeded = report.blockers.filter(blocker => blocker.type === 'approval-required').length;
  const blockers = report.blockers.length - approvalsNeeded;
  const mainSha = /^[a-f\d]{40,64}$/i.test(report.main?.sha || '') ? report.main.sha : 'unavailable';
  const latestRun = report.workflowRuns[0];
  const runStatus = value => /^[a-z_]{1,40}$/i.test(value || '') ? value : 'unavailable';
  core.summary
    .addHeading('SaaS Factory exploitation report')
    .addRaw(`\n- Report completeness: ${report.complete ? 'complete' : 'incomplete'}\n`)
    .addRaw(`- Main SHA: ${mainSha}\n`)
    .addRaw(`- Workflow runs inspected: ${report.workflowRuns.length}\n`)
    .addRaw(`- Latest Actions run: ${latestRun ? `${runStatus(latestRun.status)} / ${runStatus(latestRun.conclusion)}` : 'unavailable'}\n`)
    .addRaw(`- Active Copilot issues: ${report.activeCopilotIssues.length}\n`)
    .addRaw(`- Open pull requests: ${report.openPullRequests.length}\n`)
    .addRaw(`- Recent merged pull requests: ${report.recentMergedPullRequests.length}\n`)
    .addRaw(`- Blockers: ${blockers}\n`)
    .addRaw(`- Approvals needed: ${approvalsNeeded}\n`)
    .addRaw(unavailable.length ? `- Unavailable or partial sources: ${unavailable.join(', ')}\n` : '- All report sources were available.\n');
  await core.summary.write();
};
