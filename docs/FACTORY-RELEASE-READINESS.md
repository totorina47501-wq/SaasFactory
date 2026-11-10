# Factory release readiness — 2026-11-10

## Decision

**Status: not release-qualified; no deployment authorized or performed.** The current repository includes generator, module, security, and local operations work, but the available evidence does not establish a green CI run on the final PR SHA, live issue/PR closure, or Projects V2 reconciliation. The v2 generated starter's Next.js build is an explicitly known blocker. A successful local test suite or green CI alone would not satisfy human review, production acceptance, or a release/deployment decision.

The Factory is tooling for creating an independent project. Neither this checklist nor a generated app is a production deployment plan.

## Evidence and open gates

| Gate | Local evidence | Release status |
| --- | --- | --- |
| Authorized file scope | SFV3-RELEASE catalog entry lists `README.md`, this checklist, audit, model catalog, FR/EN guides, and changelog. | Scope recorded; live issue labels and competing open scopes were not available in this environment. |
| Factory tests | Security report records `npm test` (529 passed, 2 skipped) and CommonJS tests (156 passed) at its inspection. This documentation change must be tested separately; results are not a CI result. | Re-run locally; do not infer final CI. |
| Generated minimal application | `.github/workflows/ci.yml` defines generated test, typecheck, build, and Playwright smoke jobs for a fresh temporary app. | Workflow definition is not a run result; latest run for final SHA was not queried. |
| Generated v2 starter | `docs/testing.md` records generated tests and typecheck in CI, but a Next.js route-type generation failure prevents the v2 build from being included. | **Blocked** for full generated-profile build qualification. |
| Security and secrets | `docs/security/verification-report.md` records synthetic adversarial tests and limited secret-pattern checks. | No exhaustive secret, production configuration, external review, or live GitHub settings audit is claimed. |
| Local operations and restore | `tests/operations/operations.test.mjs` exercises synthetic dump/restore, files, jobs, index, and audit; database operations also have simulator tests. | Does not prove PostgreSQL restore or generated-app recovery in production. Real DB integration is optional and disposable/local only. |
| Local models | Catalog documents one pinned ASR reference and other operator-supplied artifacts; tests use synthetic files/fake engines. | No real model, engine, licensing review, resource measurement, or generated-app inference was tested. |
| Issues, PRs, and dependencies | The local authorized backlog and code/tests are available. The checkout contains merge commit `d33cd2bb47e80208dbf31bb43b5300747af51a3f` (PR #150 in its merge subject). | Current GitHub issue/PR state, required review, dependency closure and CI checks are **not verified** here. A local merge commit does not prove issue acceptance or project status. |
| Projects V2 | Sync contract, implementation, and offline tests exist. | Current board, card fields, permissions and status projection were **not inspected**; do not update a milestone based on these docs. |
| Deployment/provider activation | No deployment or provider operation is part of this mission. | Not performed; no production readiness claim. |

## Dependency and backlog reconciliation

The authorized mission names issues **#17, #54, #55, #43, #40, and #41** as dependencies. This checkout contains implementation and/or test evidence for the relevant contracts, security, local operations, and repository automation. Their live GitHub states, linked PRs, review status, final CI and any Projects V2 cards were not accessible during this inspection. Treat each dependency as **unverified for dispatch/release purposes** until those records are checked; a closed issue or merged PR must be validated against its accepted deliverable and final SHA.

`docs/catalog/factory-backlog-v1.json` remains the authorized backlog source and `docs/FACTORY-REMAINING-BACKLOG.md` remains its static planning view. Neither is a live issue/PR/Project query. Do not mark the release milestone done or create replacement work solely from this static snapshot. Reuse existing issues for remaining gaps; verify duplicates and `Files:` ownership before filing anything.

PR #14's historical review decision and later independent merge record remain in the completion audit. That history is not new authorization or evidence for current readiness.

## Final handoff checklist

- [ ] Confirm the issue is still authorized, its exact `Files:` scope remains unclaimed, and its dependencies are accepted and delivered.
- [ ] Confirm every required workflow is green on the final PR head SHA, and capture run URL/ID and commit SHA. Review actual job logs; do not treat a workflow configuration or historical green run as current evidence.
- [ ] Confirm required human review/branch protections are satisfied. No automatic merge or milestone transition is authorized by this document.
- [ ] Run `npm test`, `node --test tests/*.test.cjs`, focused module tests, and generated-app tests on a new temporary destination. Record exact outcomes and limitations in the audit.
- [ ] Resolve the v2 generated build blocker, or explicitly leave that profile release-blocked. Never bypass type errors or describe a skipped build as passed.
- [ ] Review the generated manifest, source diff, licenses, exclusions, `.env.example`, secret scan, and model artifact inventory. Do not add a credential, customer data, model weights, or proprietary product data.
- [ ] For actual project use, perform a separate, human-approved review of security, accessibility, data retention, local backup/restore, licensing, resource budgets, provider configuration, and applicable legal requirements.
- [ ] Keep any generated app in a new independent destination/repository. Provider activation, payment, remote resources, DNS, publishing and deployment require separate explicit authorization and validation; none is part of this release-preparation task.
- [ ] Retain the previous code/configuration and a verified local backup before any independently approved migration. Roll back by reviewed revert/configuration rollback or restore into a new target; never overwrite or delete the only source.

## Rollback and risk

This deliverable changes documentation only; rollback is a reviewed revert of the documentation commit. It changes no generated behavior, database, provider, secret, CI workflow or Project. The main release risk is overstating maturity or treating offline/synthetic tests, a scaffold, a static backlog, or a green CI run as production evidence. The audit preserves those distinctions and records unavailable live evidence as unknown.
