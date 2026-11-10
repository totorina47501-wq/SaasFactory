# Operational hold (owner decision 2026-11-10)

**PAUSED:** Do not assign, instruct, reawaken, merge or incur AI coding/review charges from Codex, Copilot or other SaaSFactory agents while work focuses on MentionCheck in a separate repo. See [docs/AGENT-PAUSE-AND-RESUME.md](docs/AGENT-PAUSE-AND-RESUME.md) for the freeze register and controlled restart. Deterministic CI continues. This hold takes precedence over previously authorized automation until explicitly lifted by the owner.

# Agent operating rules — SaaS Factory

- This repository is **not** a deployable business application. Keep all factory code and tests in this repository only.
- Review README.md, docs/generator-contract.md, docs/implementation-contracts.md, open issues/PRs before changes. Do not duplicate work.
- For significant changes, use docs/templates/implementation-contract.md and link the mission-specific contract to the issue and PR. Follow documented preconditions, outputs, idempotence, failure modes, acceptance evidence, security and rollback. Existing specialized contracts remain authoritative.
- The generator must default to dry-run; writing requires `--write` and an explicit safe destination.
- Reject unknown input fields, suspicious paths, symlinks, overwrite attempts, and potentially leaked secrets.
- NEVER copy production secrets, brand assets, customer data, legal documents, proprietary business logic, DB migrations, Git histories or provider account IDs from any other repository.
- No network API, paid AI provider, payment or remote deployment during generation or tests.
- Make small isolated PRs, run `npm test` and ensure GitHub CI green. Human review remains the default. Full-auto is limited to missions explicitly authorized in `docs/catalog/factory-backlog-v1.json` and the guarded coordinator; require its verified final review and CI evidence, and never bypass branch protections.
- Keep any generated Next.js app isolated from the factory repository, in a new destination with independent configuration.

- The specialist catalog is in `docs/agent-orchestration.md` and `.github/agents/*.agent.md`. Use **one** explicit `agent:role:<profile>` label per approved mission; never guess or override role from a title or Projects Status. Specialists share the same nondeployment and review gates.
