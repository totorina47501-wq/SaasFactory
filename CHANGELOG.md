# Changelog

All notable repository changes are recorded here. This log describes Factory repository changes, not releases or deployments of generated SaaS applications.

## Unreleased

### Documentation

- Added French and English local getting-started guides covering the read-only intake manifest, deterministic dry-run, explicit generation, generated-app checks, local backup/restore test, and production-oriented limitations.
- Added a local-model catalog distinguishing a pinned ASR reference from unapproved or unpinned artifacts; documented explicit installation and model-free tests.
- Added a release-readiness checklist that records unverified GitHub/Projects evidence, the generated v2 build blocker, and the no-deployment gate.
- Linked release documentation from the README and refreshed the completion audit with file/test/SHA/CI evidence and explicit maturity boundaries.

### Validation and limitations

- Documentation-only change; no generator behavior, application runtime, provider, model download, CI workflow, or deployment behavior changed.
- Local test and diff-check results for this revision are recorded in `docs/FACTORY-COMPLETION-AUDIT.md`. They are not a claim of GitHub CI success or production readiness.
