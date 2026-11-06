'use strict';

const RECOVERY_MARKER = '<!-- saas-factory-ci-recovery:';
const COPILOT_LOGINS = new Set(['copilot', 'copilot-swe-agent[bot]']);
const BOT_LOGIN = 'github-actions[bot]';
const APPROVAL_LABEL = 'agent:approved';
const MAX_ATTEMPTS = 2;
const MAX_COMMENT_PAGES = 10;

const recoveryComment = (attempt) =>
  `@copilot Please inspect the failing checks for this pull request, make a minimal correction within its approved issue scope, and update this pull request. This is automatic correction request ${attempt}/${MAX_ATTEMPTS}.`;

const blockedComment =
  'Automated CI recovery is blocked after the maximum of two correction requests for this commit. Human review is required.';

const labelsOf = (item) => (item.labels || []).map((label) => (typeof label === 'string' ? label : label.name));
const SPECIALISTS = new Set(['product-architect','generator-engineer','qa-engineer','security-engineer','platform-engineer','ux-accessibility','documentation-release']);
function approvedIssue(issue) {
  const labels=labelsOf(issue);
  const roles=labels.filter(label=>typeof label==='string'&&label.startsWith('agent:role:'));
  return !issue.pull_request && issue.state==='open' && labels.includes(APPROVAL_LABEL) &&
    roles.length===1 && SPECIALISTS.has(roles[0].slice('agent:role:'.length));
}
function linkedMission(body) {
  // Hidden examples and ambiguous closure directives cannot authorize a recovery.
  const visible=(body || '').replace(/<!--[\s\S]*?-->/g,'').replace(/```[\s\S]*?```/g,'');
  const ids=[...visible.matchAll(/\b(?:close[sd]?|fix(?:es|ed)?|resolve[sd]?)\s+#(\d+)\b/gi)].map(match=>Number(match[1]));
  if (!ids.length || ids.some(id=>!Number.isSafeInteger(id)||id<1)) return null;
  const unique=[...new Set(ids)];
  return unique.length===1 ? unique[0] : null;
}

function markerFor({pr, sha, runId, attempt, status}) {
  return `<!-- saas-factory-ci-recovery:v1;pr=${pr};sha=${sha};run=${runId};attempt=${attempt};status=${status}-->`;
}

function parseMarker(body) {
  const markers = [...body.matchAll(/<!-- saas-factory-ci-recovery:([^>]*)-->/g)];
  if (markers.length !== 1) throw new Error('Malformed recovery ledger marker');
  const match = markers[0][1].match(/^v1;pr=(\d+);sha=([a-f0-9]{40});run=(\d+);attempt=([12]);status=(retry|blocked)$/i);
  if (!match) throw new Error('Malformed recovery ledger marker');
  if (![match[1],match[3]].every(value=>Number.isSafeInteger(Number(value))&&Number(value)>0)) {
    throw new Error('Invalid recovery ledger identifier');
  }
  return {
    pr: Number(match[1]),
    sha: match[2].toLowerCase(),
    runId: Number(match[3]),
    attempt: Number(match[4]),
    status: match[5].toLowerCase()
  };
}

function recoveryLedger(comments, pr, sha) {
  const entries = [];
  for (const comment of comments) {
    if (!comment || typeof comment.user?.login !== 'string' || !comment.user.login || typeof comment.body !== 'string') {
      throw new Error('Unverifiable recovery comment');
    }
    if (comment.user?.login !== BOT_LOGIN || !comment.body?.includes(RECOVERY_MARKER)) continue;
    const marker = parseMarker(comment.body);
    if (marker.pr !== pr) throw new Error('Recovery marker references a different PR');
    if (marker.sha === sha.toLowerCase()) entries.push(marker);
  }
  const runs = new Set();
  for (const entry of entries) {
    if (runs.has(entry.runId)) throw new Error('Duplicate recovery ledger run');
    runs.add(entry.runId);
  }
  const retries = entries.filter((entry) => entry.status === 'retry').sort((a, b) => a.attempt - b.attempt);
  if (retries.some((entry, index) => entry.attempt !== index + 1) || retries.length > MAX_ATTEMPTS) {
    throw new Error('Invalid recovery ledger sequence');
  }
  if (entries.some((entry) => entry.status === 'blocked' && (entry.attempt !== MAX_ATTEMPTS || retries.length !== MAX_ATTEMPTS))) {
    throw new Error('Invalid blocked recovery ledger entry');
  }
  return {entries, retries};
}

async function loadRecoveryComments(github, owner, repo, pr) {
  const comments = [];
  for (let page = 1; page <= MAX_COMMENT_PAGES; page++) {
    const result = await github.rest.issues.listComments({
      owner, repo, issue_number: pr, per_page: 100, page
    });
    if (!Array.isArray(result.data)) throw new Error('Invalid recovery ledger response');
    comments.push(...result.data);
    if (result.data.length < 100) return comments;
  }
  throw new Error('Recovery ledger exceeds the verification limit');
}

async function writeSummary(core, report) {
  core.summary.addHeading('SaaS Factory agent CI recovery')
    .addRaw(`\nDecision: \`${report.decision}\`\n`)
    .addRaw(report.pr ? `PR: #${report.pr}\n` : '')
    .addRaw(report.sha ? `SHA: \`${report.sha}\`\n` : '')
    .addRaw(report.runId ? `CI run: ${report.runId}\n` : '')
    .addRaw(report.attempt ? `Correction request: ${report.attempt}/${MAX_ATTEMPTS}\n` : '');
  await core.summary.write();
}

module.exports = async ({github, context, core}) => {
  const expectedRepo = process.env.EXPECTED_REPO;
  const report = {decision: 'ignored'};
  const finish = async () => {
    await writeSummary(core, report);
    if (report.decision === 'blocked:attempt-limit-reached') {
      core.setFailed('CI recovery blocked: the two-request quota for this PR/SHA is exhausted');
    }
    return report;
  };

  try {
    if (context.eventName !== 'workflow_run' || `${context.repo.owner}/${context.repo.repo}` !== expectedRepo ||
        expectedRepo !== 'totorina47501-wq/SaasFactory') return await finish();

    const payloadRun = context.payload.workflow_run;
    if (!payloadRun?.id) return await finish();
    if (!Array.isArray(payloadRun.pull_requests) || payloadRun.pull_requests.length !== 1) return await finish();
    const payloadPrNumber = payloadRun.pull_requests[0].number;
    if (!Number.isSafeInteger(payloadPrNumber) || payloadPrNumber < 1) return await finish();
    const {owner, repo} = context.repo;
    const result = await github.rest.actions.getWorkflowRun({owner, repo, run_id: payloadRun.id});
    const run = result.data;
    if (run.name !== 'SaaS Factory CI' || run.event !== 'pull_request' || run.conclusion !== 'failure' ||
        run.repository?.full_name !== expectedRepo || run.head_repository?.full_name !== expectedRepo ||
        !/^copilot\/.+/.test(run.head_branch || '') || !/^[a-f0-9]{40}$/i.test(run.head_sha || '')) {
      return await finish();
    }
    const workflowResult = await github.rest.actions.getWorkflow({owner, repo, workflow_id: run.workflow_id});
    if (workflowResult.data.path !== '.github/workflows/ci.yml' ||
        workflowResult.data.name !== 'SaaS Factory CI') return await finish();

    if (!Array.isArray(run.pull_requests) || run.pull_requests.length !== 1 ||
        run.pull_requests[0].number !== payloadPrNumber) return await finish();
    const prNumber = run.pull_requests[0].number;
    if (!Number.isSafeInteger(prNumber) || prNumber < 1) return await finish();
    const prResult = await github.rest.pulls.get({owner, repo, pull_number: prNumber});
    const pr = prResult.data;
    report.pr = prNumber;
    report.sha = run.head_sha.toLowerCase();
    if (pr.state !== 'open' || pr.base?.ref !== 'main' || pr.head?.ref !== run.head_branch ||
        pr.head?.sha?.toLowerCase() !== report.sha || pr.head?.repo?.full_name !== expectedRepo ||
        !COPILOT_LOGINS.has((pr.user?.login || '').toLowerCase())) return await finish();

    const linkedIssue = linkedMission(pr.body);
    if (!linkedIssue) return await finish();
    const issueResult = await github.rest.issues.get({
      owner, repo, issue_number: linkedIssue
    });
    if (!approvedIssue(issueResult.data)) return await finish();

    const comments = await loadRecoveryComments(github, owner, repo, prNumber);
    const {entries, retries} = recoveryLedger(comments, prNumber, report.sha);
    const runId = Number(run.id);
    if (!Number.isSafeInteger(runId) || runId < 1) throw new Error('Invalid workflow run ID');
    report.runId = runId;
    if (entries.some((entry) => entry.status === 'blocked')) {
      report.decision = 'blocked:attempt-limit-reached';
      return await finish();
    }
    if (entries.some((entry) => entry.runId === runId)) {
      report.decision = 'ignored:duplicate-failure';
      return await finish();
    }

    let body;
    let status;
    let attempt;
    if (retries.length === MAX_ATTEMPTS) {
      status = 'blocked';
      attempt = MAX_ATTEMPTS;
      body = blockedComment;
      report.decision = 'blocked:attempt-limit-reached';
    } else {
      status = 'retry';
      attempt = retries.length + 1;
      body = recoveryComment(attempt);
      report.decision = `requested:attempt-${attempt}`;
    }
    report.attempt = attempt;
    // Pagination can outlive approval or the PR head. Recheck immediately before writing.
    // These API reads narrow the race window; they are not an atomic write precondition.
    const latestPr = (await github.rest.pulls.get({owner, repo, pull_number: prNumber})).data;
    const latestIssue = (await github.rest.issues.get({owner, repo, issue_number: linkedIssue})).data;
    const latestLink = linkedMission(latestPr.body);
    if (latestPr.state !== 'open' || latestPr.base?.ref !== 'main' ||
        latestPr.head?.ref !== run.head_branch || latestPr.head?.sha?.toLowerCase() !== report.sha ||
        latestPr.head?.repo?.full_name !== expectedRepo ||
        !COPILOT_LOGINS.has((latestPr.user?.login || '').toLowerCase()) ||
        latestLink !== linkedIssue || !approvedIssue(latestIssue)) {
      report.decision = 'ignored:eligibility-changed';
      return await finish();
    }
    await github.rest.issues.createComment({
      owner,
      repo,
      issue_number: prNumber,
      body: `${body}\n\n${markerFor({pr: prNumber, sha: report.sha, runId, attempt, status})}`
    });
    return await finish();
  } catch {
    report.decision = 'blocked:verification-or-api-failure';
    await finish();
    throw new Error('CI recovery failed closed; verification or GitHub API operation did not complete');
  }
};

