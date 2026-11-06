# GitHub Projects V2 status synchronization

The existing personal project is **SaaSFactory — Agents**, project **#2**. This workflow adds **status-only reconciliation**; it does not replace the existing agent dispatcher or the project UI Auto-add workflow. It reads and updates existing cards only.

## Enable safely

1. The existing Actions secret `SAASFACTORY_PROJECTS_V2_TOKEN` is reused. Never put token values in commits, issues, PRs, or logs.
2. By default, **all runs are dry-run**. Review the job summary after a manual dispatch.
3. To enable the scheduled status updates (six checks per hour), create repository Actions **variable** `SAASFACTORY_PROJECTS_V2_SYNC_ENABLED` with exact value `true`. Scheduled runs apply; manual runs also require `apply=true`.
4. Disable by deleting/changing the variable. No merge, deployment, secrets or Copilot assignment is performed.

The read-only connection check proves read access only. A successful status update acknowledges that specific API mutation; local tests and dry-runs do not prove write permissions. This sync does not change Project options, secrets, or the activation variable.

## Mapping

| Source | Status |
|---|---|
| Open issue labeled `agent:approved` | Approved |
| Open issue labeled `agent:planned` | Backlog |
| Issue assigned to Copilot with no work label | Assigned |
| Issue labeled `agent:coding` | Coding |
| Issue labeled `agent:in-progress` | In Progress |
| Issue labeled `agent:review` | PR Review |
| Issue or PR labeled `agent:blocked` | CI Blocked |
| Issue closed with `stateReason=COMPLETED`, or merged PR | Done |
| Issue closed as `NOT_PLANNED` or with an unrecognized closure reason | Backlog; reported as `not_planned` or `closed_unverified` |
| Open PR (including draft) | PR Review |

Closed *unmerged* PRs never become Done; CI failure does not trigger blocking unless a workflow or human explicitly applies `agent:blocked` (generic check failures must not cause spurious changes). Project options stay unchanged: the JSON report distinguishes `planned` from `waiting` while both remain `Backlog`. It shows declared `Depends-On:` relationships and marks an issue dependency delivered only when it is closed as completed and a merged project PR canonically references it; a PR dependency must be merged. Missing, invalid, duplicate, or incomplete dependency evidence remains unresolved.

## Duplicate prevention and guarantees

Only existing cards in project #2 belonging to `totorina47501-wq/SaasFactory` can be updated. New issues/PRs are expected to enter through the existing GitHub Projects UI Auto-add; the sync cannot detect or repair a missing card. Verify Auto-add in the Project UI if a new issue is absent; do not extend this sync to create cards. Unchanged Status values are not written; duplicate card identities make apply-mode fail. Pagination is bounded at 500 items and writes at 100 transitions. Partial issue/PR fields, incomplete connections, repeated cursors, and missing mutation acknowledgements fail closed. Existing protections, Copilot dispatcher, PR #8 and SonarQube exclusion are untouched.

The schedule remains every 10 minutes (six checks/hour); scheduling is best-effort. Tests: `node --test tests/projects-v2-sync.test.cjs`. The CI workflow runs this test alongside its existing policy tests.
