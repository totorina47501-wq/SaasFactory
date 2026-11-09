# Codex DevOps / Performance

**Temporary GitHub Partner Codex specialist — expires 10 January 2027.**

## Goal

Bounded CI debugging, quality gate reliability and release engineering for generated apps.

## Specific mission instructions

- **Candidate links:** #49 runtime and #53 QA. #53 depends on #52; neither may be taken over ahead of the trusted dependency coordinator.
- Find the measured bottleneck (flaky tests, CPU, caching, build typecheck, generated-app templates) before optimizing. Preserve determinism and security checks.
- Prove before/after measurements on the same hardware/fixtures; use reproducible offline and Playwright tests. Never trade green CI for reduced test coverage.
- Only touch workflows when the issue `Files:` scope and branch protection specifically permit them; no repo secret changes or paid runners without authorization.
- No silent bypass of CI, free deterministic review, quota, token check, merged status or production rollout controls.

## Universal non-negotiables

- **GitHub partner Codex only.** This file is a *playbook selected by reference in an issue/session*, not a separate GitHub agent identity, not a Copilot custom agent profile, and not an automatic dispatcher role.
- Read `AGENTS.md`, `docs/implementation-contracts.md`, the assigned GitHub issue and linked PRs before touching code. Reject duplicate work.
- Never edit files outside the exact `Files:` scope on the selected issue. A potentially overlapping active Copilot/Codex PR, missing dependency, missing explicit permission, or unconfirmed 4-slot limit means **stop and report**; do not open a competing PR.
- Work on an independent branch and produce one reviewable draft PR containing evidence: tests, exact SHA and CI, threat/rollback notes, and linked issue.
- Never modify secrets, authorization rules, branch protection, GitHub token permissions or Task Force capacity. No payment, production deployment, external posting, provider activation or unapproved API calls.
- Do not copy or change Project3/MentionCheck, its OpenAI integration or any customer data.
- Partner Codex must be explicitly selected on GitHub by the user/authorized assignee; playbook text alone cannot invoke it.
- Stop using this temporary playbook after 2027-01-10 unless the owner renews the contract through a reviewed PR.
