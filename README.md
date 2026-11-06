# SaaS Factory

Standalone SaaS generator, separate from any customer-facing product.

## Generate a new project

Requires Node.js 22.12+; no installation, network connection or credentials are required for the generator.

```sh
npm test
node generate.mjs --config examples/minimal.json --output-root /tmp/saas-factory-demo
node generate.mjs --config examples/minimal.json --output-root /tmp/saas-factory-demo --write
```

The default is **dry-run**, with a deterministic manifest. Explicit `--write` creates one new project folder and refuses existing paths, path traversal and symlinks. No git repository, remote provider, payment or deployment is created.

A generated app is an independent Next.js/TypeScript starting point. GitHub Actions is configured to generate the minimal app in a temporary directory, install its dependencies, and run its `npm test`, `npm run typecheck`, and `npm run build` scripts. The current `main` CI builds a freshly generated minimal application; consult the latest GitHub Actions run for the current result rather than relying on historic status statements. The minimal app pins Next.js 15.5.28, React and React DOM 19.3.1, TypeScript 5.9.3, `@types/node` 22.19.2, and `@types/react`/`@types/react-dom` 19.2.0. The optional Cloudflare scaffold pins `@opennextjs/cloudflare` 1.20.15.

The offline generator tests run the generated smoke tests for every combination of the optional `api`, `auth`, `billing-test`, and `media` scaffolds, with both `none` and `cloudflare-opennext` targets. These option combinations are scaffold-tested only; they are not included in the full Next.js build job. Cloudflare configuration is not deployed or validated against a provider.

See [generator contract](docs/generator-contract.md). Security and scope constraints for agents are in [AGENTS.md](AGENTS.md).

## Repository policy

This repository holds reusable infrastructure only. Do not copy any application-specific source, branding, user data, migrations, legal corpus or credentials here. Every generated app must live in its own repository. Never enable paid APIs, DNS, payments, migrations or deployments automatically.


## Create a new SaaS (preflight)

See [Launch readiness and release gates](docs/new-saas-launch-readiness.md).
A versioned **full-feature starter example** lives in [examples/saas-starter.json](examples/saas-starter.json).
It includes local auth/API/media scaffolds, simulated billing, FR/EN resources and an inactive Cloudflare OpenNext target. It does **not** create production authentication, real payments, hosted storage, accounts or deployment.

```sh
npm test
node --test tests/saas-launch-readiness.test.mjs
node generate.mjs --config examples/saas-starter.json --output-root /tmp/my-saas-preview
node generate.mjs --config examples/saas-starter.json --output-root /tmp/my-saas-preview --write
```

The generated directory must not already exist. Customize the JSON with your new SaaS name, slug and domain before writing; do not run this example a second time into the same destination.

## Agent cadence

Dispatcher and Projects V2 status synchronization request **every 10 minutes** (six per hour). GitHub scheduled execution is best-effort and can be delayed. This does not increase concurrent Copilot assignments: the dispatcher still permits two active missions and one assignment per run, with an explicit specialist role, approved issue and file scope. No automatic merge, SaaS repository creation or deployment.
