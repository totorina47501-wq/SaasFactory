# Local getting started — English

## Requirements and scope

Use Node.js `>=22.12.0 <27` and a checkout separate from SaaSFactory-generated projects. No account, secret, payment, hosted service, or local model is required for the commands below. The generator is local, deterministic, and needs no install step; its tests call no provider. Installing the generated app's open-source dependencies may require network access, but its tests and app do not call remote services.

The generated project is a development starting point, not production-ready software. Keep it separate from the Factory repository. No GitHub repository, cloud resource, provider, DNS, or deployment is created or activated.

## Brief → manifest → dry-run → app → tests

From the repository root:

```sh
node --version
npm test
node intake.mjs --input examples/intake-v2.json > /tmp/atelier-plan.json
```

The intake manifest is a revisable example brief, not an approved plan or authorized mission. Intake is read-only: it creates neither an app nor an issue. Extract only its validated generator configuration:

```sh
node --input-type=module -e "import { readFile, writeFile } from 'node:fs/promises'; const plan = JSON.parse(await readFile('/tmp/atelier-plan.json', 'utf8')); await writeFile('/tmp/atelier-config.json', JSON.stringify(plan.generatorConfig, null, 2) + '\n');"
```

Preview generation. This remains a `dry-run` and does not create the output path:

```sh
node generate.mjs --config /tmp/atelier-config.json --output-root /tmp/atelier-preview
test ! -e /tmp/atelier-preview
```

Review the manifest, module maturity, and accepted limitations. To write, choose an isolated, new destination and explicitly add `--write`:

```sh
node generate.mjs --config /tmp/atelier-config.json --output-root /tmp/atelier-output --write
cd /tmp/atelier-output/workshop-scheduler
```

Generation refuses existing destinations, symlinks, and unsafe paths; it never replaces output. Install the generated app's open-source dependencies if needed, then run its checks:

```sh
npm install --ignore-scripts --no-audit --no-fund
npm test
npm run typecheck
```

The `examples/intake-v2.json` profile selects scaffolds and does not prove a business capability. As of 2026-11-10, the v2 profile's Next.js build is blocked by its API route typing; CI reports this and does not claim it succeeded. CI builds the minimal v1 profile, not this v2 profile. See [test status and limits](testing.md). To check a minimal build, generate `examples/minimal.json` into a different new directory, install its dependencies, and run `npm run build`.

## Local backup and restore

Factory services do not automatically back up a generated app. For a synthetic, offline exercise that does not use a real PostgreSQL database:

```sh
node --test tests/operations/operations.test.mjs
```

This test uses a simulated dump and executor; it does not verify real PostgreSQL or restore a generated application. The full procedure, persistent-file consistency, new target database, failure handling, and limits are in the [disaster recovery plan](operations/disaster-recovery.md) and [local PostgreSQL operations contract](modules/database-operations.md). Real PostgreSQL integration is optional and must use only the disposable local container documented in that contract, never a remote database.

## Limits before real-world use

- Generated profiles and modules are explicitly limited scaffolds, examples, or local services. Review each limitation in `factory-manifest.json`.
- Module tests use synthetic fixtures or fake executables; they do not install models or attest behavior with a real engine.
- No production qualification, hosted authentication, real payments, remote email, remote storage, remote monitoring, or deployment. Generation does not activate the Cloudflare target if selected.
- Define security, isolation, retention, RPO/RTO objectives, licenses, backup, restore, and legal requirements separately for the independent project. Do not put customer data or secrets in reports or fixtures.
- A green CI run does not replace human review, acceptance of the generated project, provider validation, or explicitly authorized deployment.

Also see the [local model catalog](LOCAL-MODEL-CATALOG.md), [release readiness checklist](FACTORY-RELEASE-READINESS.md), and [generator contract](generator-contract.md).
