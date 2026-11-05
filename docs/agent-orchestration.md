# SaaS Factory agent orchestration V2

- Runs at 00 and 30 minutes **UTC**, contingent on the workflow being merged to `main` and Actions being enabled. GitHub schedule may be delayed or skipped.
- Always examines open issues and PRs before assignment. Never creates an issue, merges, deploys, provisions cloud resources, or changes secrets.
- `agent:approved` is the explicit authorization to dispatch, with priority labels `priority:p0`, `priority:p1`, `priority:p2`. Issues must state `Files: path/to/file, directory/` on a single line. Never approve overlapping file scopes.
- A Copilot-assigned issue, in-progress/review/blocked label, or linked Copilot PR consumes capacity. Maximum two concurrent missions. Issues without scope or PRs without an issue link block unsafe dispatch.
- At most one approved, unassigned issue is dispatched per pass. No newly approved issue means an idle run.
- REST Copilot assignment is in public preview. The default GitHub Actions `GITHUB_TOKEN` may not support it; failed assignment fails the job. Never add a broader credential or change permissions without owner review.
- Reports: the read-only [exploitation report workflow](../.github/workflows/saas-factory-agent-report.yml) runs at 00, 06, 12, and 18 UTC and on manual dispatch from `main`. It publishes a JSON artifact and a compact GitHub job summary. The JSON preserves API-provided dates, SHAs, statuses, and conclusions for the main branch, recent Actions runs and jobs, active Copilot issues, open PRs/reviews, recent merged PRs, blockers, and approval decisions. Merged PRs are listed as change history; the report does not infer that a PR was a correction from its title.
- The report uses only `GITHUB_TOKEN` with read permissions. Each source is recorded as available, partial, or unavailable; any unavailable/partial source marks the report incomplete rather than filling in estimated results. A failed API call is not evidence that an action or test ran.
- Report artifacts are retained for 30 days. The report workflow does not dispatch agents, write repository data, deploy, or merge. Manual or scheduled reporting does not replace required CI or human review.
- This first phase does **not** auto-retry failed CI or assign automated code review. A bounded corrective workflow requires explicit scope and separate security tests.
- Manual verification before enabling: merge with review; check scheduled run; create a harmless approved issue with exact `Files:` scope; inspect whether GitHub accepted assignment and created a Copilot task/PR; review usage/quota from GitHub billing controls. Do not assert that assignment works from a workflow-only test.
- Do not reuse code, migrations, secrets, Mia/RAG or workflows from Project3.
