# Feature reference catalog — Project3 patterns (non-importable)

**Source reference:** [Project3](https://github.com/totorina47501-wq/Project3), accessed for architecture discovery only. This is a **design-pattern catalog**, not a file copying manifest or an authorization to reuse private product content. Confirm actual latest source and permissions at each new intake.

| Capability observed in Project3 | Source paths for research | SaaSFactory v1 equivalent | Classification |
| --- | --- | --- | --- |
| Auth and account flows | `app/(auth)/`, `components/AuthForm.tsx`, `lib/supabase/` | `auth` scaffold | Starter only; no production identity integration |
| Billing and paid subscriptions | `lib/billing/`, `components/PricingCheckout.tsx`, `app/tarifs/` | `billing-test` | Simulated, real provider remains project-specific |
| Data persistence and migrations | `supabase/migrations/`, `lib/supabase/` | None | New SaaS must design its own SQL, access controls and migrations |
| AI assistants and retrieval | `lib/ai/`, `lib/mia/`, `components/MiaChat.tsx` | Mandatory `ai-disabled` | No real AI generation or Project3 prompts/data |
| Media processing | `lib/media/`, `components/MediaLibrary.tsx` | `media` | Synthetic local fixture only |
| Responsive dashboard UX | `app/dashboard/`, `components/DashboardMobileNavigation.tsx` | Base neutral Next.js UI | No inherited business UI/branding |
| E2E testing | `tests/e2e/`, `playwright.config.ts` | Generated smoke + factory CI | No generated Playwright suite |
| Cloudflare/Workers | `workers/`, `wrangler.jsonc`, `open-next.config.ts` | `cloudflare-opennext` | Scaffold, no real deployment |
| Privacy/security | `lib/privacy/`, `lib/security/`, `components/PrivacySettings.tsx` | Factory-level guards | Product controls must be designed anew |

## How the Intake Engine should use these references

1. Read the catalog only as a **capability checklist**. The source repo's implementation, brand, provider credentials, legal rules and private data are **not** templates.
2. Include actual requested capabilities in the product brief, and identify whether SaaSFactory already implements them, partially scaffolds them, or lacks them.
3. Generate only modules supported by `docs/generator-contract.md`. Missing capabilities become **draft** product-specific implementation contracts; do not invent module names.
4. New SaaS implementation lives in its own repo, with its own architecture, data, tests, and approved provider integrations.
5. Treat Project3's MIA, RAG, influence-law analysis, text corpora, migrations and product algorithms as **explicitly excluded** source content.

**Verification boundary:** this catalog is grounded in observed directory/file names, not a line-by-line review or a claim that every source feature is production-ready.
