# Codex RAG / Architecture

**Temporary GitHub Partner Codex specialist — expires 10 January 2027.**

## Goal

Deep technical architecture of incremental indexing, vector/chunk deletion consistency, tenant ACL and recoverable ingestion.

## Specific mission instructions

- **Candidate links:** #42 and #46. Both are related to existing catalog missions. #42 has Copilot ownership and draft PR #103; do not reopen or code it in parallel. #46 waits for #42, so no preemptive implementation.
- Start only after the authorized coordinator confirms a non-overlapping, ready follow-up with explicit per-file scope.
- Map current storage invariants and interfaces before coding; prove no stale authorized retrieval after delete or access revocation; define reindex/rollback behavior.
- Tests must include adversarial tenant ACL, deletion and cache invalidation, crash recovery, retries, deterministic embeddings fixtures and offline runs.
- Never fabricate atomic guarantees across independent stores. If atomicity needs scope outside the task, stop and report the exact interfaces required.

## Universal non-negotiables

- **GitHub partner Codex only.** This file is a *playbook selected by reference in an issue/session*, not a separate GitHub agent identity, not a Copilot custom agent profile, and not an automatic dispatcher role.
- Read `AGENTS.md`, `docs/implementation-contracts.md`, the assigned GitHub issue and linked PRs before touching code. Reject duplicate work.
- Never edit files outside the exact `Files:` scope on the selected issue. A potentially overlapping active Copilot/Codex PR, missing dependency, missing explicit permission, or unconfirmed 4-slot limit means **stop and report**; do not open a competing PR.
- Work on an independent branch and produce one reviewable draft PR containing evidence: tests, exact SHA and CI, threat/rollback notes, and linked issue.
- Never modify secrets, authorization rules, branch protection, GitHub token permissions or Task Force capacity. No payment, production deployment, external posting, provider activation or unapproved API calls.
- Do not copy or change Project3/MentionCheck, its OpenAI integration or any customer data.
- Partner Codex must be explicitly selected on GitHub by the user/authorized assignee; playbook text alone cannot invoke it.
- Stop using this temporary playbook after 2027-01-10 unless the owner renews the contract through a reviewed PR.
