# GitHub Projects V2 status synchronization

The existing personal project is **SaaSFactory — Agents**, project **#2**. The connection test is already green on `main`. This workflow adds **status-only reconciliation**; it does not replace the existing agent dispatcher or the project UI Auto-add workflow.

## Enable safely

1. The existing Actions secret `SAASFACTORY_PROJECTS_V2_TOKEN` is reused. Never put token values in commits, issues, PRs, or logs.
2. By default, **all runs are dry-run**. Review the job summary after a manual dispatch.
3. To enable the half-hourly status updates, create repository Actions **variable** `SAASFACTORY_PROJECTS_V2_SYNC_ENABLED` with exact value `true`. Scheduled runs apply; manual runs also require `apply=true`.
4. Disable by deleting/changing the variable. No merge, deployment, secrets or Copilot assignment is performed.

## Mapping

| Source | Status |
|---|---|
| Open issue labeled `agent:approved` | Approved |
| Issue assigned to Copilot with no work label | Assigned |
| Issue labeled `agent:coding` | Coding |
| Issue labeled `agent:in-progress` | In Progress |
| Issue labeled `agent:review` | PR Review |
| Issue or PR labeled `agent:blocked` | CI Blocked |
| Closed issue or merged PR | Done |
| Open PR (including draft) | PR Review |

Closed *unmerged* PRs never become Done; CI failure does not trigger blocking unless a workflow or human explicitly applies `agent:blocked` (generic check failures must not cause spurious changes).

## Duplicate prevention and guarantees

Only existing cards in project #2 belonging to `totorina47501-wq/SaasFactory` can be updated. No cards are created because the existing GitHub Projects UI Auto-add already handles new issues/PRs. Unchanged Status values are not written; duplicate card identities make apply-mode fail. Pagination is bounded at 500 items and writes at 100 transitions. Existing protections, Copilot dispatcher, PR #8 and SonarQube exclusion are untouched.

Tests: `node --test tests/projects-v2-sync.test.cjs`. The CI workflow runs this test alongside its existing policy tests.
