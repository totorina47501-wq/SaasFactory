# Agent operating rules — SaaS Factory

- This repository is **not** a deployable business application. Keep all factory code and tests in this repository only.
- Review README.md, docs/generator-contract.md, open issues/PRs before changes. Do not duplicate work.
- The generator must default to dry-run; writing requires `--write` and an explicit safe destination.
- Reject unknown input fields, suspicious paths, symlinks, overwrite attempts, and potentially leaked secrets.
- NEVER copy production secrets, brand assets, customer data, legal documents, proprietary business logic, DB migrations, Git histories or provider account IDs from any other repository.
- No network API, paid AI provider, payment or remote deployment during generation or tests.
- Make small isolated PRs, run `npm test` and ensure GitHub CI green. Never auto-merge code without review.
- Keep any generated Next.js app isolated from the factory repository, in a new destination with independent configuration.
