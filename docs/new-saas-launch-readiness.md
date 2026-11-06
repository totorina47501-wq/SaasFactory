# New SaaS launch readiness — v1

## Status and scope

**Starter generation-ready** means a generic isolated project can be validated, previewed, generated into a fresh directory, smoke-tested and (for the minimal baseline) typechecked/built by CI. It does **not** mean a market-ready product, provisioned infrastructure, published GitHub repository, configured authentication, real payments, production database or public deployment.

The SaaS Factory repository is a factory, not the location to host a generated product. Never import another application's code, customer data, branding, migrations, or secrets.

## Concrete startup procedure

1. Choose a new product name, unique slug, domain, language(s), approved modules and target. Start from `examples/saas-starter.json` but **edit** those values for the new project. Do not reuse the example domain in production.
2. Run `npm test` and `node --test tests/saas-launch-readiness.test.mjs` on the factory (requires Node.js 22.12+).
3. Run `node generate.mjs --config <your-config.json> --output-root <new-root>` to inspect the deterministic, no-write manifest. Review all paths.
4. Run the same command with `--write` into a **new** destination only. Never overwrite.
5. In the generated project, run `npm install --ignore-scripts --no-audit --no-fund`, `npm test`, `npm run typecheck` and `npm run build`. CI presently exercises the minimal app build; full module/Cloudflare integration requires additional validation in a distinct deployment environment.
6. Review the generated sources, `.env.example` placeholders, any scanner warnings, legal requirements and security design. Create an independent GitHub repository only via an explicit approved action; configure its own secrets, branch protections and deployment separately.

## Evidence checklist

| Gate | Where to verify | Meaning |
| --- | --- | --- |
| Factory standalone generator | `npm test` | Manifest, invalid inputs, sandboxing, optional module combinations |
| Comprehensive SaaS starter | `tests/saas-launch-readiness.test.mjs` | Full scaffold preview/write consistency and local smoke test |
| Buildable minimal project | `.github/workflows/ci.yml` `generated-app` job | Actual Next.js install, tests, TS typecheck and build |
| Specialized agent routing | Dispatcher workflow and its JSON report | Explicit approved role; max 2 concurrent, 1 new per cycle |
| Projects V2 visibility | Existing Projects V2 sync workflow | Cards only; no issue/PR creation or dispatch |

The full-starter test intentionally does **not** install dependencies or build the Cloudflare-target starter. This is a remaining release gate for a real Cloudflare project, as are live provider integration, end-to-end user journeys, security/accessibility review and successful independent deployment.

## Operating cadence and rollback

The dispatch and Projects V2 sync schedules are `*/10 * * * *` (UTC); actual triggering can lag. To revert to the previous load, restore their existing cron entries to `0,30 * * * *` in a reviewed PR. Concurrency protections are unchanged; do not automate merges or token permission increases for speed.

**Decision rule:** report the factory as *starter generation-ready* only when the current `main` CI is green; do not claim production-ready without project-specific, provider and deployment evidence.
