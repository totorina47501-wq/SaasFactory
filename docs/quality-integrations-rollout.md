# SaaS Factory — opt-in GitHub quality integration rollout

## Existing inventory (checked on main at 51cd9a8307f75164ed0050e5b483f47918783b15)

- `.github/workflows/ci.yml` already runs generator unit tests, independent generated-app install/test/typecheck/build and dry-run. **Do not duplicate or replace CI.**
- `.github/workflows/saas-factory-agent-dispatch.yml` already schedules assignment every 30 minutes; keep approval, two-active-agent and file-scope guards.
- `docs/agent-orchestration.md` describes dispatch reports; open Copilot PR **#7** implements **six-hour read-only operational reports** in `.github/workflows/saas-factory-agent-report.yml`, `.github/scripts/agent-report.cjs`, `tests/agent-report.test.cjs`, `package.json`, and `docs/agent-orchestration.md`. Do not duplicate or edit these files before #7 is reviewed and merged.
- Open issue **#6** is already approved for bounded CI recovery (maximum two attempts); don't add a competing retry workflow.
- No Renovate, Codecov integration configuration or coverage upload workflow existed on main when this branch was started.

## 1. Copilot automatic reviews — OWNER ACTION REQUIRED

Repository Settings > Rules > Rulesets (or Settings > Copilot > Code review, where available on your plan): enable automatic Copilot code reviews for new PRs, request reviews on subsequent pushes if supported. Keep mandatory human approvals, required status checks and branch protections unchanged. **A Copilot review is not a human approval.** This PR does not modify repository settings or add privileged automation.

## 2. Renovate — OWNER ACTION REQUIRED

Review `.github/renovate.json`, install the [Renovate GitHub App](https://github.com/apps/renovate) **only for SaasFactory**, with least-privilege permissions. The config limits concurrency to two PRs and one PR per hour, schedules a Monday maintenance window, groups non-major npm updates and Actions, and explicitly disables auto-merge. Verify Renovate's dependency dashboard and its first PR before extending scope. Renovate may require changes to the schedule depending on its hosted app constraints.

## 3. GitHub Projects — OWNER ACTION REQUIRED

Create a private **GitHub Projects** board called `SaaSFactory — Agents` with fields:
- `Status`: Backlog, Approved, Assigned, Coding, PR Review, CI Blocked, Done.
- `Priority`: P0 / P1 / P2.
- `Agent`: Copilot / Human.
- `Domain`: Generator / CI / Security / Documentation / Operations.
- `Files scope`: text listing paths, with each GitHub issue also declaring its `Files:` line.
- `PR`: link.
Use an auto-add workflow for this repository's issues and PRs, plus built-in GitHub Projects workflows to mark closed/merged items done. **Never interpret a Project column as `agent:approved`**: explicit issue label remains mandatory. No project was created or third-party app installed by this PR.

## 4. Codecov — OWNER ACTION REQUIRED

The additional `factory-quality-integrations.yml` computes LCOV coverage using only built-in Node 22 testing and uploads a first-party GitHub artifact by default. This is additive to the existing CI. Review the first artifact and verify the LCOV report is not empty.

To enable optional Codecov uploading:
1. Authorize the [Codecov GitHub App](https://github.com/apps/codecov) for **SaasFactory only**.
2. Set repository Actions secret `CODECOV_TOKEN` if Codecov requires one (particularly for private repositories).
3. Set Actions repository variable `CODECOV_ENABLED=true` **after** reviewing terms and permissions.
4. Inspect checks on a harmless PR; remove the variable to stop third-party uploading.

## 5. SonarQube Cloud — REMOVED BY OWNER DECISION

SonarQube / Snyk are not part of this integration batch. No SonarQube action, token, variable, external enrollment or scan is requested. Do not activate either tool without a separate owner request.

## 6. Missions and failure reports — ALREADY BEING BUILT

Review and merge Copilot **PR #7** separately, after successful checks and human review. The proposed report covers Actions conclusions, SHA, active agent issues, PRs and blockers every six hours; its failures can be inspected through GitHub job summary and artifacts. Issue **#6** is the already-approved proposal for bounded CI recovery. This PR does **not** create a duplicate report/retry engine. For alerts, consider native GitHub Actions failure notifications and GitHub Projects filtered `CI Blocked` views; any external notification integration requires separate approval.

## Before fusion

1. Inspect the diff and confirm no overlap with PR #7 or issue #6.
2. Verify `SaaS Factory CI` on this exact head SHA.
3. Verify the extra quality workflow reports a nonempty LCOV artifact with optional Codecov upload **skipped** by default.
4. Review privileges, dependency updater cadence and third-party costs; SonarQube is explicitly excluded.
5. Request human review and explicit owner approval; do not bypass required checks or merge automatically.

## GitHub Projects delivery status

A GitHub Projects v2 board is a GitHub account-level resource, not a repository file. The current repository connector has no Projects creation/edit API permission. Therefore no board has been created. Use [GitHub Projects](https://github.com/users/totorina47501-wq/projects) to create the private board. Its complete field and workflow specification is above; do not invent a project URL or claim the board exists. The agent dispatcher remains label-driven, not board-driven.
