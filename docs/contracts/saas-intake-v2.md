# SaaS Intake Engine — Contract v2

**Input version:** `intakeVersion: 2` · **Generator configuration:** `schemaVersion: 2`

v2 extends the read-only v1 intake. The v1 schema and plan remain supported and retain their existing output shape. v2 adds explicit module versions and accepted limitations, an implementation contract for every MVP feature, dependency and priority checks, and a complete generator dry-run report. Neither version creates issues, repositories, generated files, or provider accounts.

## Entry point

```sh
node intake.mjs --input examples/intake-v2.json > /tmp/intake-plan.json
```

The CLI writes JSON only to stdout and errors only to stderr. Parsing, unknown-field and duplicate-key diagnostics do not echo user-supplied names or values. The plan is deterministic and has no network or filesystem write effects.

## Input schema

The v2 top-level fields are exactly `intakeVersion`, `product`, `market`, `mvp`, `scaffold`, `capabilities`, and `assumptions`. The first four fields retain the v1 meanings. `product` requires `name`, `slug`, `domain`, `summary`; `market` requires `audience`, `problem`, `monetization`. Unknown and missing fields are rejected.

Each MVP feature has exactly:

| Field | Contract |
| --- | --- |
| `id`, `title`, `description` | Unique safe feature ID; non-empty bounded text. Credential-like values are rejected. |
| `priority` | `p0`, `p1`, or `p2`; an MVP has at least one P0 feature. |
| `owner` | One of the seven existing specialist profile slugs. |
| `dependsOn` | Unique feature IDs in this MVP. Dependencies must exist, be acyclic, and have equal or higher priority than the dependent feature. |
| `moduleIds` | Selected generator module IDs only. |
| `capabilityIds` | IDs selected in the top-level capability request only. |
| `acceptanceCriteria` | 1–20 bounded, non-empty statements for the proposed implementation contract. |

`scaffold` fields match generator v2: `modules` (ID/version pairs), `acceptedLimitations` (exact ID/version/limitation decisions), `prerequisites`, `permissions`, `offline`, `languages`, `defaultLanguage`, and `deploymentTarget`. The generator's v2 module resolver and v1 scaffold validator remain authoritative for module dependencies, versions, limitations, permissions, offline support, names, language tags, and target semantics. `ai-disabled@1.0.0` is required. Modules remain scaffolds; selected capability requests never activate providers.

`capabilities` accepts up to 30 unique IDs from the versioned capability catalog. `assumptions` accepts up to 20 bounded strings.

## Output and guarantees

The output contains:

- `generatorConfig`: the validated schema-v2 generator input; pass only this field to `generate.mjs`.
- `capabilityRequests`: selected catalog entries as `draft-only`, `readyForUse: false`.
- `implementationContracts`: one draft contract per MVP feature, with specialist, priority, dependencies, selected modules, acceptance criteria, missing capabilities and accepted module limitations. Each is unapproved and has no `Files:` scope.
- `dryRunReport`: the generator's complete dry-run manifest (selected versions/maturities and limitations, generated paths, hashes, exclusions and checks), with a stable destination placeholder and explicit proof that no files were written. Product/market requirements and unresolved capabilities are included separately.
- `assumptions`.

The report does not imply a feature is implemented merely because a scaffold is selected. Missing/proposed capabilities and accepted scaffold limitations remain explicit. No mission is authorized for dispatch and no GitHub issue is created from an intake.

## Explicit v1 migration

There is no automatic conversion when reading a v1 manifest. A caller may use `migrateIntakeV1(v1Manifest, decisions)` from `factory/intake-migrations.mjs`. Decisions must state the complete v2 module limitation, prerequisite, permission and offline choices, plus dependencies, module/capability mapping, and acceptance criteria for every feature. Incomplete or invalid decisions fail closed. Migration does not infer that a v1 scaffold is a production capability.

## Security, effects and rollback

- Input is bounded by the existing 64 KiB strict JSON parser. Duplicate keys, unknown fields, unsupported versions, secrets, malformed feature graphs, missing module dependencies, and invalid generator configuration fail closed.
- Error messages use generic field/JSON diagnostics and never include credential-like input or untrusted field names.
- No command, network access, GitHub mutation, provider activation, generator write, issue creation, or repository creation occurs. A dry-run computes only a deterministic manifest in memory.
- Rollback is to revert the v2 intake adapter, migration module, contract, prompt, example and tests; v1 remains available.

## Validation evidence

`node --test tests/intake-v2.test.mjs tests/intake.test.mjs` verifies v1 compatibility, strict schema failures, false-positive secret patterns, diagnostic redaction, dependency and priority consistency, module resolution, explicit migration, idempotence and deterministic dry-run output. `npm test` includes the same tests.
