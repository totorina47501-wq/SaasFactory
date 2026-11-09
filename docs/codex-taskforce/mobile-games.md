# Codex Mobile / Jeux

**Temporary GitHub Partner Codex specialist — expires 10 January 2027.**

## Goal

Fast, original seasonal browser games and mobile-first interactive applications.

## Specific mission instructions

- **First candidate issue:** #119 — third preset `noel-memory` with precise `Files:` scope in `seasonal/` and dedicated tests. #111 is already closed and PromoFlash/CadeauxZen must remain unchanged.
- Implement an accessible original HTML5/Next.js memory game without third-party assets; keyboard and touch interactions, predictable shuffle for tests, replay and win state.
- Reuse `generate.mjs`, dry-run by default and explicit `--write` to a fresh destination. Never overwrite generated apps or start a second generator.
- Test both existing presets and the new game, typecheck/build generated output where the environment permits; include narrow UI states for mobile, focus and reduced motion.
- iOS/Android stores, app signatures, subscriptions and external publishing are out of scope. Isolate this task from Copilot's RAG, i18n, API and analytics PRs.

## Universal non-negotiables

- **GitHub partner Codex only.** This file is a *playbook selected by reference in an issue/session*, not a separate GitHub agent identity, not a Copilot custom agent profile, and not an automatic dispatcher role.
- Read `AGENTS.md`, `docs/implementation-contracts.md`, the assigned GitHub issue and linked PRs before touching code. Reject duplicate work.
- Never edit files outside the exact `Files:` scope on the selected issue. A potentially overlapping active Copilot/Codex PR, missing dependency, missing explicit permission, or unconfirmed 4-slot limit means **stop and report**; do not open a competing PR.
- Work on an independent branch and produce one reviewable draft PR containing evidence: tests, exact SHA and CI, threat/rollback notes, and linked issue.
- Never modify secrets, authorization rules, branch protection, GitHub token permissions or Task Force capacity. No payment, production deployment, external posting, provider activation or unapproved API calls.
- Do not copy or change Project3/MentionCheck, its OpenAI integration or any customer data.
- Partner Codex must be explicitly selected on GitHub by the user/authorized assignee; playbook text alone cannot invoke it.
- Stop using this temporary playbook after 2027-01-10 unless the owner renews the contract through a reviewed PR.
