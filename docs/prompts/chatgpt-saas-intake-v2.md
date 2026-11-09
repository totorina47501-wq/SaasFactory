# ChatGPT MASTER PROMPT — SaaSFactory Intake v2

Produce one strict, versioned JSON intake manifest for a product concept. Do not claim to implement or deploy the product.

## Preparation

When GitHub connector tools are available, inspect current repository docs, open issues/PRs, generator options, capability catalog and specialist profiles. If unavailable, state that live verification was not possible and do not claim new work or capabilities. Reuse generic Factory scaffolds only; never copy product source, branding, customer information, secrets, migrations or provider account details from another repository.

Distinguish selected generic scaffolds from implemented product functionality. Identify absent or proposed capabilities, dependencies, constraints, security/privacy/accessibility needs, and testable acceptance criteria. Do not create GitHub issues or imply a proposed mission is authorized.

## Output

Return exactly one JSON object matching `docs/contracts/saas-intake-v2.md`:

```json
{
  "intakeVersion": 2,
  "product": {"name": "...", "slug": "...", "domain": "...", "summary": "..."},
  "market": {"audience": "...", "problem": "...", "monetization": "..."},
  "mvp": [{
    "id": "safe-feature-id",
    "title": "...",
    "description": "...",
    "priority": "p0",
    "owner": "product-architect",
    "dependsOn": [],
    "moduleIds": ["ai-disabled"],
    "capabilityIds": [],
    "acceptanceCriteria": ["..."]
  }],
  "scaffold": {
    "modules": [{"id": "ai-disabled", "version": "1.0.0"}],
    "acceptedLimitations": [{
      "id": "ai-disabled",
      "version": "1.0.0",
      "limitations": ["disabled-by-design"]
    }],
    "prerequisites": [],
    "permissions": [],
    "offline": true,
    "languages": ["en"],
    "defaultLanguage": "en",
    "deploymentTarget": "none"
  },
  "capabilities": [],
  "assumptions": []
}
```

Rules:

- Use only the seven declared specialist owners and priorities `p0`, `p1`, `p2`. Include at least one P0 MVP feature.
- Feature dependencies must point to existing feature IDs, be acyclic, and must not require a lower-priority feature.
- Feature module and capability IDs must be selected by the top-level scaffold and capability lists.
- Use exact module versions and explicitly accept all limitations of selected modules, including `ai-disabled@1.0.0`. Do not invent module versions, permissions, prerequisites or capabilities.
- `capabilities` are requests from the versioned catalog, not code or activated services. A selected `auth`, `api`, `billing-test`, or `media` module is only its documented scaffold.
- Add 1–20 meaningful acceptance criteria to each feature; do not use placeholder-only criteria.
- Do not include real credentials, customer data, legal content, arbitrary commands, or production integrations.

## Local validation

Save the JSON and run:

```sh
node intake.mjs --input /path/to/intake-v2.json
```

The output is a read-only plan. Review every proposed implementation contract, missing capability, accepted limitation, and generator dry-run report. Only its `generatorConfig` is input to `generate.mjs`; generator writes still require the separate explicit `--write` flag and safe destination.

To migrate a v1 manifest, use the explicit `migrateIntakeV1` API and supply every decision described in the v2 contract. Never silently infer acceptance of a limitation or implementation scope.
