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

A generated app is an independent Next.js/TypeScript starting point. GitHub Actions generates the minimal app in a temporary directory, installs its dependencies, and runs its `npm test`, `npm run typecheck`, and `npm run build` scripts. The minimal app pins Next.js 15.5.28, React and React DOM 19.3.1, TypeScript 5.9.3, `@types/node` 22.19.2, and `@types/react`/`@types/react-dom` 19.2.0. The optional Cloudflare scaffold pins `@opennextjs/cloudflare` 1.20.15.

The offline generator tests run the generated smoke tests for every combination of the optional `api`, `auth`, `billing-test`, and `media` scaffolds, with both `none` and `cloudflare-opennext` targets. These option combinations are scaffold-tested only; they are not included in the full Next.js build job. Cloudflare configuration is not deployed or validated against a provider.

See [generator contract](docs/generator-contract.md). Security and scope constraints for agents are in [AGENTS.md](AGENTS.md).

## Repository policy

This repository holds reusable infrastructure only. Do not copy any application-specific source, branding, user data, migrations, legal corpus or credentials here. Every generated app must live in its own repository. Never enable paid APIs, DNS, payments, migrations or deployments automatically.
