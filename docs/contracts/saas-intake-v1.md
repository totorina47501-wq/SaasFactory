# SaaS Intake Engine — Contract v1

**Purpose:** deterministic, offline handoff from a highly specified ChatGPT product brief to the *existing* SaaSFactory generator, without creating repositories, issues, branches or provider accounts.

## Entry point

1. Use the versioned [ChatGPT intake master prompt](../docs/prompts/chatgpt-saas-intake-v1.md) to prepare a product brief.
2. Write the resulting JSON as an intake manifest; [sample](../../examples/intake-sample.json).
3. `node intake.mjs --input examples/intake-sample.json > /tmp/intake-plan.json`
4. Inspect `generatorConfig`; save **only** this object to a separate JSON configuration file, then use the existing `generate.mjs` dry-run and explicitly approved `--write` procedure.

The intake CLI always writes JSON **to stdout only**; it never changes source files, GitHub issues, Projects V2, remote infrastructure or generated directories.

## Schema (intakeVersion: 1)

Top-level required fields, with unknown fields rejected:

| Field | Contract |
| --- | --- |
| `intakeVersion` | exactly integer 1 |
| `product` | `name`, `slug`, `domain`, `summary` |
| `market` | `audience`, `problem`, `monetization` (proposal only) |
| `mvp` | 1–40 uniquely identified features: `id`, `title`, `description`, `priority` and `owner` |
| `scaffold` | `modules`, `languages`, `defaultLanguage`, `deploymentTarget` |
| `capabilities` | 0–30 distinct identifiers from `docs/catalog/saas-capabilities-v1.json`; they are requested **design capabilities**, never generator modules or activated providers |
| `assumptions` | 0–20 concise statements |

The generator's `validateConfig` is the **single source of truth** for slug, domain, modules, language and target semantics. The adapter compiles to `schemaVersion: 1` unchanged, with no extension to its existing schema. Product/market text is **not copied into the generated starter**.

Allowed priorities: `p0`, `p1`, `p2`. Owners: the seven existing `.github/agents/*.agent.md` specialist slugs. `mvp` features are **draft mission proposals**: not GitHub issues and not authorized for dispatch; they have no `Files:` scope or completed implementation contract.

## Execution and safety gates

- Inspect live `main`, issues, PRs, contracts and existing templates before planning any change; do not duplicate functionality.
- Intake version is distinct from generator `schemaVersion`; incompatible changes need a versioned contract and migration.
- Duplicate JSON keys, unknown keys, invalid role/priority, oversized manifests and invalid generator configuration fail closed.
- No arbitrary commands, deployment, secrets, accounts, network, GitHub mutations, generator writes, production integrations or external paid providers.
- Each real mission subsequently requires a project-specific issue/contract, explicit file ownership, approval, review and CI. Factory Issues/Projects remain for **generic Factory improvements**. New SaaS product missions belong in the independent product repository once provisioned.
- Rollback: revert the new `intake.mjs` adapter and examples; the generator is unmodified.

## Not implemented by this contract

Parsing free-form text directly, automatic SaaS repository creation, project-specific GitHub issues, automatic Copilot dispatch to a new repository, approvals, production auth/billing/database, deployment or monetization are future work and must not be claimed as delivered.

## Capability catalog and media safety

The versioned [capability catalog](../catalog/saas-capabilities-v1.json) is the allowlist for `capabilities`. Each selection is returned as `capabilityRequests` in the read-only plan with `readyForUse: false` and `implementation: draft-only`, regardless of whether its nearest equivalent is an existing scaffold. **Only** `scaffold.modules` are passed to `generate.mjs`. The product brief must distinguish scaffolds from fully implemented product features.

Video/audio examples are **reference architectures**, not code copied from Project3. Any real video/audio feature requires project-specific MIME/size/duration checks, private storage, opt-in explicit processing, cancellation/timeouts and constrained resources, retention/deletion, accessibility, abuse moderation and an audited provider cost/consent policy. FFmpeg, transcription, TTS, subtitle generation and background job workers are **not** shipped by this PR.
