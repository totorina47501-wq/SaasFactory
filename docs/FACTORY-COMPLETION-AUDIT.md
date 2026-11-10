# Audit de finalisation SaaSFactory

**Mise à jour :** 2026-11-10
**Code audité :** SHA `d33cd2bb47e80208dbf31bb43b5300747af51a3f` (commit d'intégration PR #150 ; les changements depuis cette révision sont documentaires).
**État :** audit documentaire et tests locaux, pas une déclaration de livraison finale, de production ou de déploiement.

## Méthode et règle de maturité

Le relevé s'appuie sur le contenu local du dépôt, les contrats et les tests nommés ci-dessous. Le SHA désigne la révision du code examiné. **Aucun résultat GitHub Actions, état courant d'issue/PR, revue, protection de branche ou carte Projects V2 n'a été consulté pour ce SHA dans cette session.** Les statuts CI sont donc « non vérifié », pas « réussi ».

Les catégories de preuve sont distinctes :

- Les tests unitaires/intégration de modules prouvent seulement les comportements testés, souvent avec fixtures synthétiques ou doubles.
- Les tests de smoke généré prouvent seulement les fichiers/parcours effectivement générés et exercés. Ils ne valident pas chaque capacité métier.
- La maturité de registre `verified` est refusée dans cet audit faute de preuve d'une capacité testée dans une application SaaS générée avec des dépendances réelles appropriées. Aucun module n'est promu sur la base de ce rapport ou d'une CI verte seule.
- Les états `scaffold`, `missing` et `proposed` du catalogue sont des limites/inventaires, pas des capacités disponibles.

## Matrice de preuves par domaine

Chaque ligne indique les sources, les tests, le SHA de code visé et l'état CI. « Tests présents » n'affirme pas que chaque test de cette ligne a été relancé individuellement ; les résultats exécutés dans cette session figurent après la matrice.

| Domaine / état constaté | Fichiers de preuve | Tests / portée | SHA du code | CI GitHub |
| --- | --- | --- | --- | --- |
| Générateur v1/v2 et intake : implémentés ; génération v1 par manifeste fermé, v2 par allowlist et décisions explicites | `generate.mjs`, `factory/generator-v2.mjs`, `factory/intake-v2.mjs`, contrats v1/v2 | `tests/generator.test.mjs`, `tests/generator-v2.test.mjs`, `tests/intake.test.mjs`, `tests/intake-v2.test.mjs` | `d33cd2bb47e80208dbf31bb43b5300747af51a3f` | Non vérifiée sur ce SHA. |
| Registre : 5 modules opérationnels tous `scaffold`; références restantes sans disponibilité implicite | `factory/module-registry.mjs`, `factory/module-resolver.mjs`, `docs/catalog/saas-capabilities-v1.json`, contrats de registre | `tests/module-registry.test.mjs`, `tests/module-resolver.test.mjs`; ces tests valident le registre/résolveur, pas les capacités du catalogue historique | `d33cd2bb47e80208dbf31bb43b5300747af51a3f` | Non vérifiée sur ce SHA. |
| Profils/applications générés : smoke de profils et combinaisons limitées ; pas une recette de tous les parcours ou capacités | `generate.mjs`, `examples/minimal.json`, `examples/saas-starter-v2.json`, `.github/workflows/ci.yml`, `docs/testing.md` | `tests/generator-v2.test.mjs`, `tests/saas-launch-readiness.test.mjs`; CI définit tests/typecheck pour deux profils, build/Playwright pour le minimal | `d33cd2bb47e80208dbf31bb43b5300747af51a3f` | Le workflow est présent ; dernier run final non consulté. |
| Contrats runtime et maturité : interfaces versionnées ; les contrats ne créent pas un service à eux seuls | `factory/contracts/`, `docs/contracts/factory-runtime-v1.md`, `docs/contracts/module-registry-v1.md`, `docs/contracts/generated-module-v1.md` | `tests/runtime-contracts.test.mjs`; validation des descripteurs/contexte, pas preuve de service produit généré | `d33cd2bb47e80208dbf31bb43b5300747af51a3f` | Non vérifiée sur ce SHA. |
| Auth, MFA, tenancy et RBAC : services Factory testés ; génération auth reste une frontière injectée | `modules/auth/`, `modules/mfa/`, `modules/tenancy/`, `docs/catalog/saas-capabilities-v1.json` | `tests/auth.test.mjs`, `tests/mfa.test.mjs`, `tests/tenancy.test.mjs`; les modules de registre restent scaffolds | `d33cd2bb47e80208dbf31bb43b5300747af51a3f` | Non vérifiée sur ce SHA. |
| PostgreSQL et opérations DB : implémentation locale, backup/restore avec contrôles d'intégrité ; aucune base distante | `modules/database/`, `modules/database-operations/`, `docs/modules/database-operations.md` | `tests/database.test.mjs`, `tests/database-operations.test.mjs`; les tests unitaires utilisent des outils/archives simulés, l'intégration réelle exige un DB jetable local | `d33cd2bb47e80208dbf31bb43b5300747af51a3f` | Non vérifiée ; aucune instance PostgreSQL réelle invoquée dans cette session. |
| Jobs, audit et observabilité : services locaux et bornes documentés | `modules/jobs/`, `modules/observability/`, `docs/operations/resource-budgets.md` | `tests/jobs.test.mjs`, `tests/observability.test.mjs`, `tests/operations/operations.test.mjs`; budgets CPU/RAM jobs indicatifs/cooperatifs, non quotas OS | `d33cd2bb47e80208dbf31bb43b5300747af51a3f` | Non vérifiée sur ce SHA. |
| RAG : ingestion, cycle de vie et recherche implémentés/testés en Factory ; pas une qualification LLM réelle | `modules/rag-ingestion/`, `modules/rag-lifecycle/`, `modules/rag-search/`, `docs/modules/` | `tests/rag-ingestion.test.mjs`, `tests/rag-lifecycle.test.mjs`, `tests/rag-search.test.mjs`; recherche/embeddings réels et déploiement multi-tenant restent des validations distinctes | `d33cd2bb47e80208dbf31bb43b5300747af51a3f` | Non vérifiée sur ce SHA. |
| LLM local, ASR/TTS : adaptateurs opt-in, versions/empreintes configurées ; aucun poids dans les tests | `modules/llm-local/`, `modules/local-speech/`, `docs/modules/llm-local.md`, `docs/modules/local-speech.md`, `docs/security/local-model-security.md` | `tests/llm-local.test.mjs`, `tests/local-speech.test.mjs`; exécutables factices et modèles synthétiques uniquement, pas de test moteur/poids réel | `d33cd2bb47e80208dbf31bb43b5300747af51a3f` | Non vérifiée sur ce SHA. |
| Audio/vidéo/images/documents/média privé : services Factory, limites et fixtures ciblés ; pas de recette de bout en bout générée | `modules/audio/`, `modules/video/`, `modules/images/`, `modules/documents/`, `modules/private-storage/`, `modules/media-ui/` | `tests/audio.test.mjs`, `tests/video.test.mjs`, `tests/images.test.mjs`, `tests/documents.test.mjs`, `tests/private-storage.test.mjs`, `tests/media-ui.test.mjs` | `d33cd2bb47e80208dbf31bb43b5300747af51a3f` | Non vérifiée sur ce SHA. |
| API, facturation simulée, entitlements et notifications : services testés avec portée locale/simulée | `modules/api/`, `modules/billing-simulated/`, `modules/entitlements/`, `modules/notifications/` | `tests/api.test.mjs`, `tests/billing-simulated.test.mjs`, `tests/entitlements.test.mjs`, `tests/notifications.test.mjs`; aucun paiement/email distant | `d33cd2bb47e80208dbf31bb43b5300747af51a3f` | Non vérifiée sur ce SHA. |
| Confidentialité, analytics, admin, i18n et UX : implémentations Factory testées, couverture ne vaut pas parcours produit complet | `modules/privacy/`, `modules/analytics/`, `modules/admin/`, `modules/i18n-seo/`, `modules/ux/` | `tests/privacy.test.mjs`, `tests/analytics.test.mjs`, `tests/admin.test.mjs`, `tests/i18n-seo.test.mjs`, `tests/ux.test.mjs` | `d33cd2bb47e80208dbf31bb43b5300747af51a3f` | Non vérifiée sur ce SHA. |
| Orchestration, intégrations qualité et Projects V2 : politiques/workflows locaux ; aucune preuve de synchronisation réelle du projet | `.github/scripts/`, `.github/workflows/`, `docs/agent-orchestration.md`, `docs/projects-v2-status-sync.md` | `tests/agent-dispatch.test.cjs`, `tests/factory-orchestration.test.cjs`, `tests/projects-v2-sync.test.cjs`, `tests/factory-quality-config.test.cjs` ; API GitHub simulée/offline | `d33cd2bb47e80208dbf31bb43b5300747af51a3f` | Aucun run récent ni état de carte consulté. |
| Sécurité : tests adversariaux/contrôles disponibles ; aucun scan exhaustif de secrets ou validation dynamique externe | `docs/security/verification-report.md`, `docs/security/threat-model.md`, `.github/workflows/ci.yml` | `tests/security/adversarial-boundaries.test.mjs`, tests auth/tenancy/stockage/modèles ; tests synthétiques et limites décrites dans le rapport sécurité | `d33cd2bb47e80208dbf31bb43b5300747af51a3f` | Non vérifiée ; CodeQL et settings GitHub non consultés. |
| Déploiement/production : aucun déploiement, service externe ou activation fournisseur dans le périmètre | `modules/local-runtime/`, `docs/modules/local-runtime.md`, `docs/new-saas-launch-readiness.md` | `tests/local-runtime.test.mjs`, `tests/deployment-profiles.test.mjs`; validation locale/configuration, pas déploiement | `d33cd2bb47e80208dbf31bb43b5300747af51a3f` | Non vérifiée ; aucune validation fournisseur/production revendiquée. |

## Vérification locale de cette révision documentaire

Les commandes suivantes ont été exécutées dans le sandbox le 2026-11-10. Le code fonctionnel n'a pas changé depuis le SHA listé dans la matrice ; seuls les documents de cette mission sont modifiés.

| Commande | Résultat observé | Portée / limite |
| --- | --- | --- |
| `node --test tests/intake-v2.test.mjs tests/generator-v2.test.mjs tests/saas-launch-readiness.test.mjs tests/operations/operations.test.mjs tests/llm-local.test.mjs tests/local-speech.test.mjs` | 38/38 tests réussis, 0 échec/skip | Ciblé, incluant moteurs/poids simulés et backup/restauration synthétiques. |
| Parcours documenté `intake.mjs` → extraction de `generatorConfig` → génération dry-run → `--write` dans `/tmp` → `node --test` du smoke généré | Dry-run : 23 fichiers proposés, aucun répertoire de preview écrit ; smoke app : 4/4 réussi | Ne fait ni installation de dépendances, ni typecheck/build d'application générée, ni intégration fournisseur. |
| `npm test` | 532 réussis, 2 ignorés, 0 échec (534 au total) | Suite locale Node ; pas une preuve GitHub Actions. Node `v22.23.4`. |
| `node --test tests/*.test.cjs` | 156/156 réussis | Invocation CommonJS séparée aussi utilisée par le workflow ; pas une preuve de run GitHub. |
| `git diff --check` | Réussi avant mise à jour finale de ce fichier | À refaire sur le diff final. |
| CI GitHub pour le SHA de tête final | Non consultée | Aucun run ID/URL ou statut CI de cette session ne doit être inféré de tests locaux ou de la configuration de workflow. |

Le test d'opérations a observé un scénario synthétique (`Node v22.23.4`, `linux/x64`, 4 CPU rapportés, 16 760 344 576 octets mémoire rapportés, état synthétique 3 080 octets, environ 340 ms, RSS final 69 275 648 octets). C'est une seule mesure de fixtures simulées, non un benchmark, une capacité garantie ou une restauration de PostgreSQL réelle.

## Réconciliation des issues, PR et Project

Le backlog local attribue SFV3-RELEASE/#56 au profil `documentation-release`, déclare `Files:` et les dépendances #17, #54, #55, #43, #40, #41. Les contrats, composants ou tests associés à ces domaines sont présents localement. Le commit local `d33cd2bb47e80208dbf31bb43b5300747af51a3f` est une intégration PR #150 selon son sujet Git.

Les états GitHub courants des issues, PR liées, checks sur leurs SHA finaux, approbations, discussions et cartes Projects V2 **n'ont pas été consultés** lors de cet audit. La fusion locale de PR #150 ne prouve pas à elle seule l'acceptation d'une dépendance ou la clôture de #55. Vérifier les six dépendances et la mission #56 dans GitHub avant de considérer ce travail livré, fermer un jalon ou modifier le Project. La présence d'un test dans ce dépôt ne prouve pas qu'un élément correspondant est terminé dans le backlog. Le catalogue et `docs/FACTORY-REMAINING-BACKLOG.md` sont une vue de planification versionnée, pas une source live d'état GitHub.

La revue et décision historique de PR #14 sont conservées comme historique dans l'audit initial ; elles ne sont ni réinterprétées ni utilisées pour autoriser une fusion ou contourner une protection.

## Blocages, risques et conclusion

- CI GitHub de la tête finale, revue humaine, dépendances live et statut Projects à vérifier.
- Le build Next.js du profil généré v2 est explicitement bloqué par le typage de sa route API ; la matrice CI limite le build au minimal et ne doit pas masquer ce blocage.
- Aucun modèle LLM/ASR/TTS réel, aucune licence de poids/voix révisée dans cette mission, aucun budget CPU/RAM mesuré avec poids réels.
- Le test backup/restore de cette session utilise des outils simulés. Une qualification PostgreSQL réelle et la restauration dans une application SaaS générée n'ont pas eu lieu.
- Aucune qualification de production, revue de fournisseur, surveillance distante, opération financière, création de ressource ou déploiement.

La Factory contient des services locaux et des scaffolds testés, mais ces preuves n'établissent pas que le produit est « full-featured », prêt pour la production, ou que la mission V3 et ses dépendances sont livrées. Aucun module n'est promu `verified`. Aucun jalon ne doit être clôturé sur la seule base de ce rapport ou d'une CI verte.
