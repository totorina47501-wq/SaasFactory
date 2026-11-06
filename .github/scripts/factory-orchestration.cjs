'use strict';

const fs = require('node:fs');
const path = require('node:path');

const REPOSITORY = 'totorina47501-wq/SaasFactory';
const CATALOG_PATH = path.join(__dirname, '../../docs/catalog/factory-backlog-v1.json');
const ROLES = new Set([
  'product-architect', 'generator-engineer', 'qa-engineer', 'security-engineer',
  'platform-engineer', 'ux-accessibility', 'documentation-release'
]);
const ROOT_KEYS = new Set([
  'schemaVersion', 'repository', 'authorizedAt', 'authorization', 'limits',
  'existingWork', 'externalHolds', 'tasks'
]);
const TASK_KEYS = new Set([
  'key', 'issue', 'title', 'role', 'priority', 'automationAuthorized',
  'files', 'dependsOn', 'acceptance'
]);
const DEPENDENCY_KEYS = new Set(['kind', 'number', 'acceptance']);
const BOT_REVIEWERS = new Set(['copilot-pull-request-reviewer[bot]']);
const REQUIRED_WORKFLOW = {
  id: 'ci.yml',
  name: 'SaaS Factory CI',
  path: '.github/workflows/ci.yml'
};

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertExactKeys(value, allowed, label) {
  assert(value && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`);
  assert(Object.keys(value).every(key => allowed.has(key)), `${label} contains unknown fields`);
}

function assertScope(files) {
  assert(Array.isArray(files) && files.length > 0, 'Files scope must be a non-empty array');
  assert(new Set(files).size === files.length, 'Duplicate catalog file scope');
  for (const file of files) {
    assert(typeof file === 'string' && !file.startsWith('/') && !file.includes('\\') &&
      !file.includes('..') && /^[A-Za-z0-9._/-]+$/.test(file), 'Invalid catalog file scope');
    const normalized = path.posix.normalize(file.endsWith('/') ? file.slice(0, -1) : file);
    assert(normalized === (file.endsWith('/') ? file.slice(0, -1) : file), 'Noncanonical catalog file scope');
  }
}

function validateCatalog(catalog) {
  assertExactKeys(catalog, ROOT_KEYS, 'Catalog');
  assert(catalog.schemaVersion === 1 && catalog.repository === REPOSITORY, 'Unsupported catalog identity');
  assert(catalog.authorization && typeof catalog.authorization === 'string', 'Catalog authorization is missing');
  assertExactKeys(catalog.limits, new Set([
    'maxActiveMissions', 'maxAssignmentsPerRun', 'maxCiRetriesPerPrSha', 'scheduleCron'
  ]), 'Catalog limits');
  assert(catalog.limits?.maxActiveMissions === 2 && catalog.limits?.maxAssignmentsPerRun === 1 &&
    catalog.limits?.maxCiRetriesPerPrSha === 2 && catalog.limits?.scheduleCron === '*/10 * * * *',
  'Catalog limits do not match the orchestration contract');
  assert(Array.isArray(catalog.tasks) && Array.isArray(catalog.externalHolds), 'Catalog collections are missing');
  assert(Array.isArray(catalog.existingWork), 'Catalog existing work is missing');
  for (const work of catalog.existingWork) {
    assertExactKeys(work, new Set([
      'issue', 'pullRequest', 'role', 'priority', 'dependsOn', 'statusAtSnapshot',
      'automationAuthorized', 'files', 'note'
    ]), 'Existing work');
    assert(Number.isSafeInteger(work.issue) && Number.isSafeInteger(work.pullRequest) &&
      ROLES.has(work.role) && /^p[012]$/.test(work.priority) &&
      Array.isArray(work.dependsOn) && work.automationAuthorized === true,
    'Invalid existing work record');
    assertScope(work.files);
    for (const dependency of work.dependsOn) {
      assertExactKeys(dependency, DEPENDENCY_KEYS, 'Existing work dependency');
      assert(['issue', 'pull_request'].includes(dependency.kind) &&
        Number.isSafeInteger(dependency.number) && dependency.number > 0,
      'Invalid existing work dependency');
    }
  }

  const tasks = new Map();
  for (const task of catalog.tasks) {
    assertExactKeys(task, TASK_KEYS, 'Task');
    assert(Number.isSafeInteger(task.issue) && task.issue > 0, 'Invalid catalog issue number');
    assert(/^SFV3-[A-Z][A-Z0-9]*$/.test(task.key) && ROLES.has(task.role), 'Invalid catalog task identity');
    assert(task.automationAuthorized === true, 'Task is not explicitly authorized');
    assert(Array.isArray(task.dependsOn), 'Task dependencies must be an array');
    assertScope(task.files);
    assert(task.acceptance?.length >= 1, 'Task acceptance evidence is missing');
    assert(!tasks.has(task.issue), 'Duplicate catalog issue number');
    tasks.set(task.issue, task);
    for (const dependency of task.dependsOn) {
      assertExactKeys(dependency, DEPENDENCY_KEYS, 'Dependency');
      assert(['issue', 'pull_request'].includes(dependency.kind) &&
        Number.isSafeInteger(dependency.number) && dependency.number > 0,
      'Invalid catalog dependency');
      if (dependency.acceptance !== undefined) {
        assert(dependency.kind === 'issue' && typeof dependency.acceptance === 'string' &&
          dependency.acceptance.trim().length > 0, 'Invalid catalog acceptance proof');
      }
    }
  }

  for (const work of catalog.existingWork) {
    assert(!tasks.has(work.issue), 'Existing work duplicates a catalog task');
    tasks.set(work.issue, {
      issue: work.issue, pullRequest: work.pullRequest, role: work.role,
      priority: work.priority, files: work.files,
      dependsOn: work.dependsOn, automationAuthorized: work.automationAuthorized,
      existingWork: true
    });
  }

  const visiting = new Set();
  const visited = new Set();
  function visit(issue) {
    assert(!visiting.has(issue), 'Catalog dependency cycle');
    if (visited.has(issue)) return;
    const task = tasks.get(issue);
    assert(task, 'Catalog dependency issue is missing');
    visiting.add(issue);
    for (const dependency of task.dependsOn) {
      if (dependency.kind === 'issue') {
        assert(tasks.has(dependency.number), 'Catalog dependency issue is missing');
        visit(dependency.number);
      }
    }
    visiting.delete(issue);
    visited.add(issue);
  }
  for (const task of tasks.values()) visit(task.issue);

  for (const hold of catalog.externalHolds) {
    assertExactKeys(hold, new Set([
      'pullRequest', 'requiresExplicitAuthorization', 'automationMayRelease', 'reason',
      'active', 'status', 'observedMergeSha'
    ]), 'External hold');
    assert(hold && Number.isSafeInteger(hold.pullRequest) && typeof hold.active === 'boolean' &&
      hold.requiresExplicitAuthorization === true && hold.automationMayRelease === false,
      'Invalid external hold');
  }
  return tasks;
}

function names(labels = []) {
  return labels.map(label => typeof label === 'string' ? label : label.name);
}

function parseLine(body, label) {
  const lines = [...body.matchAll(new RegExp(`^${label}:\\s*(.+)$`, 'gim'))];
  return lines.length === 1 ? lines[0][1].trim() : null;
}

function issueFiles(body) {
  const line = parseLine(body, 'Files');
  return line ? line.split(',').map(file => file.trim()).filter(Boolean) : null;
}

function issueDependencies(body, task) {
  const line = parseLine(body, 'Depends-On');
  if (!line || /^(none|aucun|aucune)$/i.test(line)) return line ? [] : null;
  const tokens = line.split(/[,;]/).map(token => token.trim()).filter(Boolean);
  const result = [];
  for (const token of tokens) {
    const match = token.match(/^(?:(issue|pr|pull_request)\s*)?#?(\d+)$/i);
    if (!match) return null;
    const number = Number(match[2]);
    const prefix = match[1]?.toLowerCase();
    const expected = task.dependsOn.find(dependency => dependency.number === number &&
      (!prefix || (prefix === 'issue' ? dependency.kind === 'issue' : dependency.kind === 'pull_request')));
    if (!expected || result.some(dependency => dependency.kind === expected.kind && dependency.number === number)) return null;
    result.push(expected);
  }
  return result;
}

function sameDependencies(left, right) {
  return left && left.length === right.length &&
    right.every(expected => left.some(actual => actual.kind === expected.kind && actual.number === expected.number));
}

function isUnplanned(labels) {
  return labels.some(label => ['not_planned', 'agent:not_planned', 'agent:not-planned'].includes(label.toLowerCase()));
}

function taskMatchesIssue(task, issue) {
  const labels = names(issue.labels);
  return issue.state === 'open' && !isUnplanned(labels) &&
    labels.includes('agent:planned') && !labels.includes('agent:approved') &&
    !labels.includes('agent:blocked') && !labels.includes('agent:in-progress') &&
    !labels.includes('agent:review') &&
    taskMetadataMatches(task, issue, false);
}

function taskMetadataMatches(task, issue, requireApproved = true) {
  const labels = names(issue.labels);
  const roleLabels = labels.filter(label => label.startsWith('agent:role:'));
  const priorityLabels = labels.filter(label => /^priority:p[012]$/.test(label));
  const files = issueFiles(issue.body || '');
  const dependencies = issueDependencies(issue.body || '', task);
  const noDeclaredLegacyDependencies = task.existingWork && task.dependsOn.length === 0 &&
    !/^Depends-On:/im.test(issue.body || '');
  return !isUnplanned(labels) && (!requireApproved || labels.includes('agent:approved')) &&
    task.automationAuthorized === true &&
    roleLabels.length === 1 && roleLabels[0] === `agent:role:${task.role}` &&
    priorityLabels.length === 1 && priorityLabels[0] === `priority:${task.priority}` &&
    files && files.length === task.files.length && task.files.every(file => files.includes(file)) &&
    (noDeclaredLegacyDependencies || sameDependencies(dependencies, task.dependsOn));
}

function linkedIssueNumbers(body) {
  const found = [];
  const pattern = /\b(?:fixes|closes|resolves)\s+#(\d+)\b/gi;
  for (const match of body.matchAll(pattern)) found.push(Number(match[1]));
  return found;
}

function pathAllowed(filename, scope) {
  return scope.some(file => filename === file || (file.endsWith('/') && filename.startsWith(file)));
}

function overlap(left, right) {
  return left === right || (left.endsWith('/') && right.startsWith(left)) ||
    (right.endsWith('/') && left.startsWith(right));
}

function retryAllowed(attempts) {
  return Number.isSafeInteger(attempts) && attempts >= 0 && attempts < 2;
}

function safeApiError() {
  return new Error('Orchestration API failed closed; no additional action was taken');
}

async function dependenciesReady({github, owner, repo, task, tasks, issuesByNumber, allPrs, cache, stack = new Set()}) {
  if (stack.has(task.issue)) throw new Error('Catalog dependency cycle');
  stack.add(task.issue);
  for (const dependency of task.dependsOn) {
    if (dependency.kind === 'pull_request') {
      const key = `pr:${dependency.number}`;
      if (!cache.has(key)) {
        const result = await github.rest.pulls.get({owner, repo, pull_number: dependency.number});
        cache.set(key, result.data);
      }
      if (cache.get(key).merged !== true) return false;
      continue;
    }

    const dependencyTask = tasks.get(dependency.number);
    if (!dependencyTask || !issuesByNumber.has(dependency.number)) return false;
    const issueResult = await github.rest.issues.get({owner, repo, issue_number: dependency.number});
    const issue = issueResult.data;
    if (issue.state !== 'closed' || issue.state_reason !== 'completed' ||
      !taskMetadataMatches(dependencyTask, issue)) return false;
    if (!await dependenciesReady({
      github, owner, repo, task: dependencyTask, tasks, issuesByNumber, allPrs, cache, stack
    })) return false;

    if (typeof dependency.acceptance === 'string' && dependency.acceptance.trim()) continue;
    const linked = allPrs.filter(pr => linkedIssueNumbers(pr.body || '').includes(dependency.number));
    let mergedProof = false;
    for (const pr of linked) {
      const key = `pr:${pr.number}`;
      if (!cache.has(key)) {
        const result = await github.rest.pulls.get({owner, repo, pull_number: pr.number});
        cache.set(key, result.data);
      }
      const mergedPr = cache.get(key);
      const linkedIssues = linkedIssueNumbers(mergedPr.body || '');
      if (mergedPr.merged === true && linkedIssues.length === 1 &&
        linkedIssues[0] === dependency.number) {
        mergedProof = true;
        break;
      }
    }
    if (!mergedProof) return false;
  }
  stack.delete(task.issue);
  return true;
}

async function loadWorkflow(github, owner, repo) {
  const result = await github.rest.actions.getWorkflow({
    owner, repo, workflow_id: REQUIRED_WORKFLOW.id
  });
  assert(result.data.path === REQUIRED_WORKFLOW.path &&
    result.data.name === REQUIRED_WORKFLOW.name && result.data.state === 'active',
  'Required CI workflow identity is not trusted');
  return result.data;
}

async function trustedCi(github, owner, repo, workflow, sha) {
  const runs = await github.paginate(github.rest.actions.listWorkflowRuns, {
    owner, repo, workflow_id: workflow.id, head_sha: sha, event: 'pull_request', per_page: 100
  });
  const matching = runs.filter(run => run.workflow_id === workflow.id && run.head_sha === sha &&
    run.event === 'pull_request');
  if (!matching.length || matching.some(run => !Number.isSafeInteger(run.id) || run.id < 1 ||
    !Number.isSafeInteger(run.run_attempt) || run.run_attempt < 1 ||
    !Number.isFinite(Date.parse(run.created_at)))) return false;
  matching.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) ||
    (Number(b.id) - Number(a.id)) ||
    (a.id === b.id && b.run_attempt - a.run_attempt));
  return matching[0].status === 'completed' && matching[0].conclusion === 'success';
}

function reviewFiles(body) {
  const files = new Set();
  const lines = body.split(/\r?\n/);
  let foundTable = false;
  for (let index = 0; index < lines.length; index++) {
    if (!/^\|\s*File\s*\|\s*Description\s*\|$/i.test(lines[index])) continue;
    if (foundTable || !/^\|\s*:?-{3,}:?\s*\|\s*:?-{3,}:?\s*\|$/.test(lines[index + 1] || '')) {
      return new Set();
    }
    foundTable = true;
    for (index += 2; index < lines.length && /^\|/.test(lines[index]); index++) {
      const row = lines[index].match(/^\|\s*`([^`]+)`\s*\|\s*[^|]+\|\s*$/);
      if (!row) return new Set();
      const candidate = row[1].trim();
      if (!/^[A-Za-z0-9._/-]+$/.test(candidate) || candidate.includes('..')) return new Set();
      files.add(candidate);
    }
  }
  return foundTable ? files : new Set();
}

async function trustedReview({github, owner, repo, pr, changedFiles, headSha}) {
  const [reviews, comments, requested, threads] = await Promise.all([
    github.paginate(github.rest.pulls.listReviews, {owner, repo, pull_number: pr.number, per_page: 100}),
    github.paginate(github.rest.pulls.listReviewComments, {owner, repo, pull_number: pr.number, per_page: 100}),
    github.rest.pulls.listRequestedReviewers({owner, repo, pull_number: pr.number}),
    (async () => {
      const all = [];
      let after = null;
      do {
        const page = await github.graphql(
          `query($owner:String!,$repo:String!,$number:Int!,$after:String){repository(owner:$owner,name:$repo){pullRequest(number:$number){reviewThreads(first:100,after:$after){nodes{isResolved}pageInfo{hasNextPage endCursor}}}}}`,
          {owner, repo, number: pr.number, after}
        );
        const connection = page?.repository?.pullRequest?.reviewThreads;
        assert(Array.isArray(connection?.nodes) && typeof connection.pageInfo?.hasNextPage === 'boolean',
          'Review thread evidence is incomplete');
        all.push(...connection.nodes);
        after = connection.pageInfo.hasNextPage ? connection.pageInfo.endCursor : null;
        assert(!connection.pageInfo.hasNextPage || after, 'Review thread pagination is incomplete');
      } while (after);
      return all;
    })()
  ]);
  assert(Array.isArray(requested.data?.users) && Array.isArray(requested.data?.teams),
    'Review request evidence is incomplete');
  if (requested.data.users.length || requested.data.teams.length) return false;
  if (threads.some(thread => thread.isResolved !== true)) return false;
  if (reviews.some(review => review.state === 'CHANGES_REQUESTED')) return false;

  const finalReview = reviews.filter(review => BOT_REVIEWERS.has(review.user?.login) &&
    review.commit_id === headSha)
    .sort((a, b) => String(b.submitted_at || '').localeCompare(String(a.submitted_at || '')))[0];
  if (!finalReview || finalReview.state !== 'COMMENTED' || typeof finalReview.body !== 'string' ||
    !/\bApproval recommended\b/i.test(finalReview.body) ||
    !/\bNo open issues\b/i.test(finalReview.body) ||
    /\b(?:changes recommended|needs a closer look|human review|request changes)\b/i.test(finalReview.body)) return false;
  const examined = reviewFiles(finalReview.body);
  return changedFiles.length > 0 && changedFiles.every(file => examined.has(file));
}

async function mergeEligiblePullRequest({
  github, owner, repo, pr, task, issue, workflow, mainSha, tasks, issuesByNumber, allPrs,
}) {
  if (pr.merged === true || pr.base?.repo?.full_name !== REPOSITORY || pr.head?.repo?.full_name !== REPOSITORY ||
    pr.base?.ref !== 'main' || pr.draft !== false ||
    !/^copilot\//.test(pr.head?.ref || '') ||
    !['copilot', 'copilot-swe-agent[bot]'].includes(pr.user?.login?.toLowerCase()) ||
    pr.base?.sha !== mainSha || pr.mergeable !== true || pr.mergeable_state !== 'clean') return false;
  if (linkedIssueNumbers(pr.body || '').filter(number => number === task.issue).length !== 1 ||
    linkedIssueNumbers(pr.body || '').length !== 1) return false;

  const roleLabels = names(issue.labels).filter(label => label.startsWith('agent:role:'));
  if (issue.state !== 'open' || names(issue.labels).includes('agent:blocked') ||
    names(issue.labels).includes('agent:not_planned') ||
    roleLabels.length !== 1 || roleLabels[0] !== `agent:role:${task.role}` ||
    !taskMatchesAuthorizedIssue(task, issue)) return false;

  const files = await github.paginate(github.rest.pulls.listFiles, {
    owner, repo, pull_number: pr.number, per_page: 100
  });
  if (!Number.isSafeInteger(pr.changed_files) || pr.changed_files < 1 ||
    files.length !== pr.changed_files || files.some(file => typeof file.filename !== 'string')) return false;
  const changedFiles = [...new Set(files.flatMap(file =>
    [file.filename, file.previous_filename].filter(Boolean)))];
  if (!changedFiles.length || changedFiles.some(file => !pathAllowed(file, task.files)) ||
    changedFiles.some(file => file.startsWith('.github/workflows/'))) return false;
  if (!await trustedCi(github, owner, repo, workflow, pr.head.sha)) return false;
  if (!await trustedReview({github, owner, repo, pr, changedFiles, headSha: pr.head.sha})) return false;

  const [latest, main, latestIssue] = await Promise.all([
    github.rest.pulls.get({owner, repo, pull_number: pr.number}),
    github.rest.repos.getBranch({owner, repo, branch: 'main'}),
    github.rest.issues.get({owner, repo, issue_number: task.issue})
  ]);
  const latestPr = latest.data;
  if (latestPr.merged === true || latestPr.state !== 'open' || latestPr.head?.sha !== pr.head.sha ||
    latestPr.head?.ref !== pr.head.ref || latestPr.head?.repo?.full_name !== REPOSITORY ||
    latestPr.user?.login?.toLowerCase() !== pr.user?.login?.toLowerCase() ||
    latestPr.base?.repo?.full_name !== REPOSITORY ||
    linkedIssueNumbers(latestPr.body || '').length !== 1 ||
    linkedIssueNumbers(latestPr.body || '')[0] !== task.issue ||
    latestPr.base?.sha !== mainSha || main.data.commit?.sha !== mainSha ||
    latestPr.base?.ref !== 'main' ||
    latestPr.mergeable !== true ||
    latestPr.mergeable_state !== 'clean' || latestPr.draft !== false ||
    latestPr.changed_files !== pr.changed_files ||
    !taskMatchesAuthorizedIssue(task, latestIssue.data)) return false;
  const currentIssues = new Map(issuesByNumber);
  currentIssues.set(task.issue, latestIssue.data);
  if (!await dependenciesReady({
    github, owner, repo, task, tasks, issuesByNumber: currentIssues, allPrs, cache: new Map()
  })) return false;
  if (!await trustedReview({
    github, owner, repo, pr: latestPr, changedFiles, headSha: pr.head.sha
  })) return false;
  const [finalPr, finalMain, finalIssue, finalReviewRequests, finalReviews] = await Promise.all([
    github.rest.pulls.get({owner, repo, pull_number: pr.number}),
    github.rest.repos.getBranch({owner, repo, branch: 'main'}),
    github.rest.issues.get({owner, repo, issue_number: task.issue}),
    github.rest.pulls.listRequestedReviewers({owner, repo, pull_number: pr.number}),
    github.paginate(github.rest.pulls.listReviews, {owner, repo, pull_number: pr.number, per_page: 100})
  ]);
  assert(Array.isArray(finalReviewRequests.data?.users) && Array.isArray(finalReviewRequests.data?.teams),
    'Final review request evidence is incomplete');
  assert(Array.isArray(finalReviews), 'Final review evidence is incomplete');
  if (finalReviewRequests.data.users.length || finalReviewRequests.data.teams.length ||
    finalReviews.some(review => review.state === 'CHANGES_REQUESTED') ||
    finalPr.data.merged === true || finalPr.data.state !== 'open' ||
    finalPr.data.head?.sha !== pr.head.sha ||
    finalPr.data.head?.ref !== pr.head.ref || finalPr.data.head?.repo?.full_name !== REPOSITORY ||
    finalPr.data.user?.login?.toLowerCase() !== pr.user?.login?.toLowerCase() ||
    finalPr.data.base?.ref !== 'main' || finalPr.data.base?.repo?.full_name !== REPOSITORY ||
    finalPr.data.base?.sha !== mainSha || finalMain.data.commit?.sha !== mainSha ||
    finalPr.data.changed_files !== pr.changed_files || finalPr.data.mergeable !== true ||
    finalPr.data.mergeable_state !== 'clean' || finalPr.data.draft !== false ||
    linkedIssueNumbers(finalPr.data.body || '').length !== 1 ||
    linkedIssueNumbers(finalPr.data.body || '')[0] !== task.issue ||
    !taskMatchesAuthorizedIssue(task, finalIssue.data)) return false;
  const finalIssues = new Map(currentIssues);
  finalIssues.set(task.issue, finalIssue.data);
  if (!await dependenciesReady({
    github, owner, repo, task, tasks, issuesByNumber: finalIssues, allPrs, cache: new Map()
  }) || !await trustedReview({
    github, owner, repo, pr: finalPr.data, changedFiles, headSha: pr.head.sha
  })) return false;
  const result = await github.rest.pulls.merge({
    owner, repo, pull_number: pr.number, merge_method: 'merge', sha: pr.head.sha
  });
  return result.data.merged === true;
}

function taskMatchesAuthorizedIssue(task, issue) {
  const labels = names(issue.labels);
  return task.automationAuthorized === true &&
    labels.includes('agent:approved') && !labels.includes('agent:planned') &&
    !labels.includes('agent:blocked') && !isUnplanned(labels) &&
    issue.state === 'open' && taskMetadataMatches(task, issue);
}

async function run({github, context, core, io = fs}) {
  const report = {decision: 'none', promoted: [], merged: [], blockers: []};
  const expectedRepo = process.env.EXPECTED_REPO;
  if (`${context.repo.owner}/${context.repo.repo}` !== REPOSITORY ||
    expectedRepo !== REPOSITORY || context.ref !== 'refs/heads/main' ||
    !/^[0-9a-f]{40}$/i.test(context.sha || '')) {
    throw new Error('Orchestration source guard rejected');
  }

  try {
    const catalog = JSON.parse(io.readFileSync(CATALOG_PATH, 'utf8'));
    const tasks = validateCatalog(catalog);
    const {owner, repo} = context.repo;
    const [main, issues, openPrs, allPrs, workflow] = await Promise.all([
      github.rest.repos.getBranch({owner, repo, branch: 'main'}),
      github.paginate(github.rest.issues.listForRepo, {owner, repo, state: 'all', per_page: 100}),
      github.paginate(github.rest.pulls.list, {owner, repo, state: 'open', per_page: 100}),
      github.paginate(github.rest.pulls.list, {owner, repo, state: 'all', per_page: 100}),
      loadWorkflow(github, owner, repo)
    ]);
    const workIssues = issues.filter(issue => !issue.pull_request);
    const issuesByNumber = new Map(workIssues.map(issue => [issue.number, issue]));
    const dependencyCache = new Map();
    const promote = [];

    assert(main.data.commit?.sha === context.sha, 'Main advanced beyond the trusted catalog snapshot');
    for (const task of catalog.tasks) {
      const issue = issuesByNumber.get(task.issue);
      if (issue && taskMatchesIssue(task, issue) &&
        await dependenciesReady({
          github, owner, repo, task, tasks, issuesByNumber, allPrs, cache: dependencyCache
        })) promote.push({task, issue});
    }

    for (const {task, issue} of promote) {
      const current = await github.rest.issues.get({owner, repo, issue_number: task.issue});
      if (!taskMatchesIssue(task, current.data) ||
        !await dependenciesReady({
          github, owner, repo, task, tasks, issuesByNumber: new Map(workIssues.map(item => [item.number, item])),
          allPrs, cache: dependencyCache
        })) continue;
      const labels = names(current.data.labels).filter(label => label !== 'agent:planned');
      if (!labels.includes('agent:approved')) labels.push('agent:approved');
      await github.rest.issues.setLabels({owner, repo, issue_number: task.issue, labels});
      report.promoted.push(task.issue);
    }

    const activeHolds = new Set(catalog.externalHolds.filter(hold => hold.active).map(hold => hold.pullRequest));
    for (const prNumber of activeHolds) {
      if (openPrs.some(pr => pr.number === prNumber)) report.blockers.push(`external-hold:#${prNumber}`);
    }
    {
      for (const pr of openPrs) {
        if (activeHolds.has(pr.number)) continue;
        const linked = linkedIssueNumbers(pr.body || '');
        if (linked.length !== 1) continue;
        const task = tasks.get(linked[0]);
        const issue = issuesByNumber.get(linked[0]);
        if (!task || !issue || catalog.externalHolds.some(hold => hold.pullRequest === pr.number)) continue;
        if (task.existingWork && task.pullRequest !== pr.number) {
          report.blockers.push(`existing-work-pr-mismatch:#${pr.number}`);
          continue;
        }
        const detailedPr = (await github.rest.pulls.get({owner, repo, pull_number: pr.number})).data;
        if (!await dependenciesReady({
          github, owner, repo, task, tasks, issuesByNumber, allPrs, cache: dependencyCache
        })) continue;
        const latestIssue = await github.rest.issues.get({owner, repo, issue_number: task.issue});
        if (!taskMatchesAuthorizedIssue(task, latestIssue.data)) continue;
        if (detailedPr.changed_files > 0 && detailedPr.state === 'open' &&
          (await github.paginate(github.rest.pulls.listFiles, {
            owner, repo, pull_number: pr.number, per_page: 100
          })).some(file => [file.filename, file.previous_filename].some(filename =>
            filename?.startsWith('.github/workflows/')))) {
          report.blockers.push(`manual-workflow-review:#${pr.number}`);
          continue;
        }
        if (await mergeEligiblePullRequest({
          github, owner, repo, pr: detailedPr, task, issue: latestIssue.data,
          workflow, mainSha: main.data.commit.sha, tasks, issuesByNumber, allPrs
        })) {
          report.merged.push(pr.number);
          break;
        }
      }
    }
    report.decision = report.merged.length ? 'merged' :
      report.promoted.length ? 'promoted' : report.blockers.length ? 'blocked' : 'idle';
    core?.notice?.(`Orchestration: ${report.decision}`);
    return report;
  } catch {
    report.decision = 'error';
    report.blockers.push('Orchestration API or evidence unavailable; no additional action was taken');
    throw safeApiError();
  }
}

module.exports = {
  run, validateCatalog, taskMatchesIssue, issueDependencies, pathAllowed,
  mergeEligiblePullRequest, retryAllowed, CONTRACT_VERSION: 1, REQUIRED_WORKFLOW, REPOSITORY
};
