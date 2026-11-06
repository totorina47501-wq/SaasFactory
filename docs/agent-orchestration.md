# SaaS Factory agent orchestration V2

- Runs at minutes 00, 10, 20, 30, 40 and 50 **UTC**, contingent on the workflow being merged to `main` and Actions being enabled. GitHub schedule may be delayed or skipped.
- Always examines open issues and PRs before assignment. Never creates an issue, merges, deploys, provisions cloud resources, or changes secrets.
- `agent:approved` is the explicit authorization to dispatch, with priority labels `priority:p0`, `priority:p1`, `priority:p2`. Issues must state `Files: path/to/file, directory/` on a single line. Never approve overlapping file scopes.
- A Copilot-assigned issue, in-progress/review/blocked label, or linked Copilot PR consumes capacity. Maximum two concurrent missions. Issues without scope or PRs without an issue link block unsafe dispatch.
- At most one approved, unassigned issue is dispatched per pass. No newly approved issue means an idle run.
- REST Copilot assignment is in public preview. The default GitHub Actions `GITHUB_TOKEN` may not support it; failed assignment fails the job. Never add a broader credential or change permissions without owner review.
- Reports: JSON artifact and job summary on every pass, including six-hour UTC checkpoints (00, 06, 12, 18). They capture the dispatch decision, not full GitHub CI/review/credit usage. A more comprehensive reporting workflow is a separate approved work item.
- This first phase does **not** auto-retry failed CI or assign automated code review. A bounded corrective workflow requires explicit scope and separate security tests.
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

**Operators:** no automated role-creation, secret changes, GitHub Projects Status mutation or auto-merge by specialist profiles. Review PR and CI evidence before merging.

- The ten-minute cadence increases the frequency of checking the queue, **not** the two-mission concurrency limit or Copilot/GitHub quotas. Check Actions run timestamps and agent-dispatch-report.json for evidence of real assignments. GitHub Actions schedules are best-effort.
