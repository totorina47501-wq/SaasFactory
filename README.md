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

A generated app is an independent Next.js/TypeScript starting point. It comes with a basic, non-deploying CI workflow and offline smoke tests; run `npm install` and `npm test` inside it before development. Cloudflare, auth, media and billing-test are optional scaffolds, not active services.

See [generator contract](docs/generator-contract.md). Security and scope constraints for agents are in [AGENTS.md](AGENTS.md).

## Repository policy

This repository holds reusable infrastructure only. Do not copy any application-specific source, branding, user data, migrations, legal corpus or credentials here. Every generated app must live in its own repository. Never enable paid APIs, DNS, payments, migrations or deployments automatically.
