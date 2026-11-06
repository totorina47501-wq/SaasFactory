# SaaS Factory agent orchestration V2

- Runs at minutes 00, 10, 20, 30, 40 and 50 **UTC**, contingent on the workflow being merged to `main` and Actions being enabled. GitHub schedule may be delayed or skipped.
- Always examines open issues and PRs before assignment. Never creates an issue, deploys, provisions cloud resources, or changes secrets. Only the guarded coordinator may merge a catalog-authorized PR after the complete v1 gate below.
- `agent:approved` is the explicit authorization to dispatch, with priority labels `priority:p0`, `priority:p1`, `priority:p2`. Issues must state `Files: path/to/file, directory/` on a single line. Never approve overlapping file scopes.
- A Copilot-assigned issue, in-progress/review/blocked label, or linked Copilot PR consumes capacity. Maximum two concurrent missions. Issues without scope or PRs without an issue link block unsafe dispatch.
- At most one approved, unassigned issue is dispatched per pass. No newly approved issue means an idle run.
- REST Copilot assignment is in public preview and requires a user token. The dispatcher uses repository secret `COPILOT_DISPATCH_TOKEN` only in its API step, with no `GITHUB_TOKEN` fallback. Missing credentials fail before checkout; checkout uses the read-only default token without persisted credentials, and dispatch only runs on `main`. See [authorization setup and rollback](copilot-dispatch-authorization.md). A successful assignment still requires API read-back; owner setup and live validation remain required.
- Dispatcher reports: JSON artifact and job summary on each dispatch pass (currently every 10 minutes). A separate **read-only operations report** runs at 00, 06, 12, 18 UTC and on manual dispatch from `main`. The dedicated report covers verified Actions runs, CI jobs, active agent issues and PR reviews, blocking approvals and last merged PRs; missing GitHub API data is explicitly flagged `incomplete`. No inference of paid Copilot credit usage.
- Bounded recovery remains delegated to existing issue #6 / PR #16 and is disabled until a real Copilot trigger is proven. The two-attempt PR/SHA limit is a hard stop, not a simulated retry or correction loop.
- Manual verification before enabling: merge with review; check scheduled run; create a harmless approved issue with exact `Files:` scope; inspect whether GitHub accepted assignment and created a Copilot task/PR; review usage/quota from GitHub billing controls. Do not assert that assignment works from a workflow-only test.
- Do not reuse code, migrations, secrets, Mia/RAG or workflows from Project3.


## Specialist agents (custom Copilot profiles)

The approved mission must carry **one and only one** `agent:role:<slug>` label, in addition to `agent:approved`; selection by natural-language issue text is not allowed. Without a valid specialist label the dispatcher refuses assignment with `blocked:invalid-specialist-role`. This is intentional: existing approved issues (including #6) must be classified before reassignment. The existing 2-task cap, one-task-per-run limit, `Files:` scope enforcement and approval check still apply.

| Label | Copilot profile | Scope |
| --- | --- | --- |
| `agent:role:product-architect` | `.github/agents/product-architect.agent.md` | Product strategy, requirements, scalable architecture and implementation contracts |
| `agent:role:generator-engineer` | `.github/agents/generator-engineer.agent.md` | Safe deterministic SaaS generator, TypeScript scaffolds and backward compatibility |
| `agent:role:qa-engineer` | `.github/agents/qa-engineer.agent.md` | Offline automated tests, regression, CI quality and accessibility checks |
| `agent:role:security-engineer` | `.github/agents/security-engineer.agent.md` | Threat modeling, secrets hygiene, input validation and least privilege |
| `agent:role:platform-engineer` | `.github/agents/platform-engineer.agent.md` | GitHub Actions, Copilot dispatcher, Projects V2, observability and rollback |
| `agent:role:ux-accessibility` | `.github/agents/ux-accessibility.agent.md` | Accessible design of generated SaaS starter experience and mobile navigation |
| `agent:role:documentation-release` | `.github/agents/documentation-release.agent.md` | Versioned technical documentation, release notes, decision records and handover |

GitHub cloud agent accepts `agent_assignment.custom_agent` in its API (public preview). The dispatcher sends the profile filename without `.agent.md`. A green local test verifies routing code, **not** availability of the GitHub service, entitlement or successful live Copilot assignment. Do not add broader tokens to work around failures. The available custom profiles are discovered when merged to the default branch. Never move a mission to the `Assigned` state until GitHub read-back confirms the actual Copilot assignee.

**Issue contract:** `agent:approved` + exactly one `agent:role:...` + `priority:p0/p1/p2` + the line `Files: path1, path2`. Use `docs/templates/implementation-contract.md` for deliverables. Before assigning a new specialist, check open PRs and any conflicting `Files:` paths.

**Operators:** no automated role-creation, secret changes, GitHub Projects Status mutation or merge by specialist profiles. Review PR and CI evidence before merging.

- The ten-minute cadence increases the frequency of checking the queue, **not** the two-mission concurrency limit or Copilot/GitHub quotas. Check Actions run timestamps and agent-dispatch-report.json for evidence of real assignments. GitHub Actions schedules are best-effort.

- Dedicated reports use `.github/workflows/saas-factory-agent-report.yml` and `.github/scripts/agent-report.cjs`, store `agent-report.json` and a job summary (artifact retention 30 days), use read-only `GITHUB_TOKEN` and never dispatch agents, create issues, merge or deploy.

## Orchestration autonome v1

`.github/scripts/factory-orchestration.cjs` exports `CONTRACT_VERSION: 1` and `run({github, context, core, io})`. It reads only `docs/catalog/factory-backlog-v1.json` from the exact `main` SHA checked out by the existing workflow. Unknown catalog fields, graph cycles, absent references, closed `not_planned` issues, mismatched role / `Files:` / `Depends-On:` fields, and incomplete API evidence fail closed. Only an exact `agent:planned` catalog issue with `automationAuthorized: true` and resolved dependencies can be promoted to `agent:approved`; the coordinator runs before candidate selection. Waiting planned issues do not consume the dispatch cap.

A PR dependency is satisfied only by `merged: true`. An issue dependency must be closed with `state_reason: completed`, retain its exact approved catalog metadata, and have a linked merged PR; alternatively, the dependency itself may declare a non-empty `acceptance` proof in the versioned catalog. Labels, closure alone, and green CI are not dependency proof.

Automatic merge is restricted to the same repository and `main`, exactly one catalog issue link, an expected Copilot author and `copilot/` branch, non-draft status, clean mergeability and current base SHA, changed paths (including rename source paths) wholly inside `Files:`, and no active external hold. Required CI is identified by the canonical `.github/workflows/ci.yml` workflow identity and must succeed on the exact PR head SHA; modifying that required workflow blocks automated merge. The final review must be by the configured Copilot reviewer on that SHA, have review comments covering every changed path, contain no `CHANGES_REQUESTED` review, and have no unresolved review threads. Missing / partial API evidence blocks the merge. The API re-reads the PR and `main` immediately before calling the merge endpoint with `sha` equal to the expected head; it never enables auto-merge or changes protections.

The workflow remains `*/10`, with at most two active missions and one assignment per pass. It runs only from `main`, checks out `github.sha` with no persisted credentials, and supplies the user token only to its API step. Reports contain decisions and issue / PR identifiers, not credentials or raw API errors.

Recovery is not triggered by this coordinator: the existing #6/#16 mechanism must demonstrate real Copilot triggering before activation. `retryAllowed(attempts)` implements the strict two-attempt bound for future integration; it does not claim or simulate a retry. The coordinator never retries a merge, changes code, or loops corrections.
