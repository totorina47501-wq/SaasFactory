# SaaSFactory — Optional quality integrations

## Verified baseline

- The factory owns a reusable generator, specialized Copilot dispatcher and GitHub Actions CI; no extra dispatcher is introduced by this PR.
- Agent dispatch and Projects V2 status synchronization request **every ten minutes**, with two concurrent Copilot missions maximum and one assignment per dispatch run.
- GitHub Projects V2 **already exists**: [SaaSFactory — Agents, project #2](https://github.com/users/totorina47501-wq/projects/2). The existing read/write Projects V2 sync is documented in [projects-v2-status-sync.md](projects-v2-status-sync.md). Do **not** create another board, project status sync or issue auto-add workflow.
- Six-hour read-only reports are delivered by the separate Copilot PR #7. Do not add a competing reporting workflow. The bounded CI-recovery proposal is issue #6, not part of this PR.

## Renovate: opt in via the GitHub App

The versioned [Renovate configuration](../.github/renovate.json) uses the documented `config:recommended` preset, `dependencyDashboardApproval: false`, two concurrent update PRs, max one PR/hour, a Monday early-morning maintenance window (Europe/Paris), and grouped GitHub Actions/npm minor-patch updates. Auto-merge is explicitly disabled.

**Not automatically activated:** the repository owner must install the [Renovate GitHub App](https://github.com/apps/renovate) for this repository, review its permissions, then inspect the first dependency dashboard and proposed PR. Renovate PRs still require the normal review and CI gate.

## Offline coverage and optional Codecov

The [factory-quality-integrations workflow](../.github/workflows/factory-quality-integrations.yml) generates a local LCOV artifact for generator and dispatcher code using Node's test coverage reporter, with permissions limited to `contents: read`. It never changes the main CI or deploys a SaaS.

- Default: upload only the first-party GitHub Actions `coverage/lcov.info` artifact (14-day retention).
- Optional external upload: only after explicitly configuring repository variable `CODECOV_ENABLED=true` and, when required, secret `CODECOV_TOKEN` and installing the [Codecov GitHub App](https://github.com/apps/codecov) for **SaasFactory only**.
- Before opt-in, verify the real workflow succeeded and the LCOV artifact is nonempty. Until then, do not claim Codecov is active or coverage has been uploaded externally.

The local smoke check in `tests/factory-quality-config.test.cjs` verifies the reviewed opt-in defaults and Renovate schema shape; it does not validate Renovate cloud service or Codecov's API.

## Copilot review and exclusions

Copilot automated PR review can be configured via GitHub repository settings. It does not substitute for required human approvals and does not authorize automerge.

**Do not introduce SonarQube or Snyk.** They were excluded by the repository owner. Do not install extra SaaS providers, change secrets, enable external uploads or relax branch protections without an explicit decision.

## Rollback

1. Keep Codecov inactive by omitting or disabling `CODECOV_ENABLED`.
2. Disable Renovate using the installed GitHub App's repository permissions if necessary.
3. Remove or disable the optional quality workflow through a reviewed PR if GitHub coverage artifacts cause problems.

Report links to the exact SHA, CI run, coverage artifact and review decision; successful offline configuration tests do **not** prove hosted-provider availability.
