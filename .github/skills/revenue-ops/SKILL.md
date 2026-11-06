---
name: revenue-ops
description: Design consent-aware attribution and simulated revenue reports with reproducible aggregates, provenance and zero silent tracking.
---

# Revenue Operations skill

Use `growth/core/metrics.mjs` for synthetic fixtures; never label simulated money as production revenue. Reject mixed tenants, unconsented events, double counts, stale data and unsupported attribution windows. CAC/ROAS require documented and sourced spend data; without it output unknown.

Provide tests, numerator/denominator definitions, first/last-touch limitations, privacy retention and rollback. Feed recommendations back as **unapproved drafts**, never automatic issue creation or spend.
