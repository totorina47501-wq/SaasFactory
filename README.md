# SaaS Factory

A standalone, **neutral** SaaS project generator and agent workflow.

This repository is independent from every application built with it. It does not contain a production database, service credentials, user data, brand assets, business rules, or deployment tokens.

## Scope

- Generate a minimal Next.js / TypeScript application from a validated JSON manifest.
- Default to dry-run. Writing requires explicit `--write` and a new, empty destination.
- Test the generator offline and never deploy or provision paid providers automatically.
- Keep new SaaS applications in **separate repositories**.

## Safety

The generated application must not copy existing products, their secrets, proprietary content, production configuration or database migrations. All optional integrations remain off by default.

Development continues through isolated PRs with CI and code review; never run unreviewed PR code with a privileged GitHub token.

The generator and its instructions are being migrated into this repository. See the active pull requests for the implementation.
