# Temporary Codex Task Force — GitHub Partner

**Mission:** [#121](https://github.com/totorina47501-wq/SaasFactory/issues/121). Codex selected in the GitHub **Agents** picker or issue **Assignees**. Codex from ChatGPT is *not* the execution target.

## What is created

Four **temporary technical role playbooks**, not four separate GitHub identities or four additional concurrent slots. The external Codex partner is a separate provider from the eight permanent custom Copilot profiles in `.github/agents/`. A Codex session follows one playbook when the issue/task prompt explicitly links it; do not assert that GitHub auto-installs or auto-selects a profile from this folder.

## Roles

| Name | Instructions | Candidate issues | Readiness |
|---|---|---|---|
| codex-rag-architect | [Read role](rag-architecture.md) | #42, #46 | standby-until-scope-and-existing-agent-handoff |
| codex-backend-security | [Read role](backend-security.md) | #49, #52 | standby-until-independent-scoped-task-approved |
| codex-mobile-games | [Read role](mobile-games.md) | #119 | candidate-after-live-capacity-and-platform-confirmation |
| codex-devops-performance | [Read role](devops-performance.md) | #49, #53 | standby-until-independent-scoped-task-approved |

## Mandatory capacity gate — applies to **Copilot + Codex combined**

1. Check open issues and PRs on `totorina47501-wq/SaasFactory` from the GitHub API. Count all assigned or `agent:in-progress`, `agent:review`, `agent:blocked` jobs (including third-party agents); count unlinked active agent PRs as blockers. If the current state is ambiguous, **do not launch**.
2. Require fewer than **4 total occupied mission slots**, confirmation of GitHub partner Codex access/usage rights and zero file ownership overlap. The existing dispatcher may not yet account for every partner-agent identity; this protocol is an *additional preflight*, not proof of enforced automatic global quota.
3. Verify issue `Files:` declarations and that dependency gate and permission are satisfied. Partner tasks outside the 45-item catalog require a separate explicitly owner-approved issue; do **not** add `agent:approved` to trick the Copilot dispatcher into assigning them.
4. Open the issue on GitHub, select **Codex**, and ask it to read the exact playbook path together with `AGENTS.md`. Check assignment read-back / actual session. Do not tag `@codex` if both the partner agent and the separate chatgpt-codex-connector are installed unless ambiguity has been resolved.
5. Limit to one new Codex session before repeating the live capacity preflight. Return a PR for exact SHA CI, review and authorized merge. Never assume that a completed job releases its slot until GitHub verifies it.

## Temporary timeline and retirement

- Created 9 November 2026 for large technical work and seasonal delivery; review on **15 December 2026**, expire on **10 January 2027** unless owner renews by reviewed PR.
- Stop invoking playbooks when the specialist backlog clears, when quotas/permissions fail, or on expiry. The permanent eight Copilot profiles remain intact. No daemon, cron, special billing or automated cleanup is installed.
- Generating a profile document does not equal starting Codex and does not change the SaaSFactory workflow, `maxActiveMissions=4`, existing CI protections, RAG algorithms or MentionCheck OpenAI configuration.
