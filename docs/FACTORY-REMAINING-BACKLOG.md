# Backlog complet restant — SaaSFactory V3

État au 2026-11-06. **40 nouvelles missions contractuelles** et reprise de la mission existante #6 / PR #16. Ce document est un plan autorisé, pas une déclaration de fonctionnalités terminées. Source machine : [factory-backlog-v1.json](catalog/factory-backlog-v1.json).

## Objectif et architecture d'exécution

Le propriétaire a explicitement demandé le mode full auto puis un backlog complet. Les missions ci-dessous sont autorisées dans leurs périmètres, avec priorités, dépendances, rôle unique et critères d'acceptation dans chaque issue. La source de vérité des livraisons reste GitHub : PR fusionnée avec CI/revue automatisée finale, preuves et tests de l'application générée. Une issue créée, affectée ou fermée non livrée n'est pas une fonctionnalité disponible.

Réutiliser Factory Core et modules existants, puis composer un SaaS indépendant Next.js/TypeScript, PostgreSQL et moteurs locaux optionnels. Tous les fichiers applicatifs restent en Factory uniquement comme sources réutilisables ; chaque génération sort dans une destination indépendante. Aucun transfert de code/données métier Project3, secret, corpus ou prompt MIA.

Les contrats détaillés, périmètres et critères de sortie sont portés par les issues ; leur exécution autonome est limitée au catalogue versionné ci-dessous.

## Automatisation : état réel et bootstrap

- **Déjà vérifié** : PR #15 fusionnée à `04d438c56348b7fbc7dc6856960569552b283128`, CI main verte ; dispatch [42186962425](https://github.com/totorina47501-wq/SaasFactory/actions/runs/42186962425) réussi, Copilot affecté à #6 et PR #16 créée.
- **À implémenter** : [#17](https://github.com/totorina47501-wq/SaasFactory/issues/17) complète le dispatcher existant pour promouvoir les dépendances livrées, contrôler les PR et fusionner automatiquement les seules missions du catalogue. Ce mécanisme n'existe pas encore et n'est pas annoncé comme actif par la création des issues.
- Les 40 issues ont été créées avec `agent:planned`. Après publication de ce catalogue sur main, seule la mission bootstrap [#17](https://github.com/totorina47501-wq/SaasFactory/issues/17) reçoit `agent:approved` et entre dans la file existante. Son affectation doit être confirmée par API. Les autres attendent son coordinateur.
- Ne pas attribuer `agent:blocked` à toutes les attentes : l'ancien dispatcher compte ce label comme capacité occupée. Une dépendance attendue est `agent:planned`, jamais un travail actif fictif.
- Le dépôt n'a pas `allow_auto_merge` activé. La mission autonome utilisera l'API de fusion sous contrôles et SHA attendu, sans modifier les réglages ni les protections. Le bootstrap lui-même demande une intégration automatisée contrôlée par l'agent de session tant que son propre coordinateur n'est pas fusionné.
- Capacité inchangée : deux missions actives, une affectation par passage, six contrôles par heure au mieux selon le planning GitHub. Pas de promesse de six développements par heure.
- Reprises CI : réutiliser #6 / #16, deux tentatives PR/SHA maximum, arrêt et rapport ensuite ; ne pas activer un déclencheur Copilot non vérifié.

## Refus d'autorisation et résolution externe observée

La fusion de #14 a été refusée par la revue automatique d'autorisation pendant cette préparation. Aucune nouvelle tentative n'a été effectuée ici. Lors de la vérification ultérieure, GitHub a indiqué #14 fusionnée indépendamment, avec `merge_commit_sha: e7dfdfa03bad6af2f824cbfacb995387fd62feb9`. L'intake et l'audit existants sont donc désormais sur main ; aucune implémentation concurrente n'est créée.

Le catalogue conserve le refus comme historique avec `active:false`, `status:resolved-externally` et le SHA observé. Le coordinateur ne peut pas lever un refus actif ; il peut constater via GitHub qu'une dépendance est déjà fusionnée. La dépendance #14 est désormais livrée, les dépendances entre missions continuent à s'appliquer. Le mode autonome ne modifie pas les protections GitHub.

## Plan des missions

| ID | Issue | Priorité | Spécialiste | Dépendances |
| --- | --- | --- | --- | --- |
| SFV3-AUTO | [#17](https://github.com/totorina47501-wq/SaasFactory/issues/17) | P0 | platform-engineer | Aucune |
| SFV3-ARCH | [#18](https://github.com/totorina47501-wq/SaasFactory/issues/18) | P0 | product-architect | [#17](https://github.com/totorina47501-wq/SaasFactory/issues/17) |
| SFV3-REG | [#19](https://github.com/totorina47501-wq/SaasFactory/issues/19) | P0 | generator-engineer | [#17](https://github.com/totorina47501-wq/SaasFactory/issues/17), [#18](https://github.com/totorina47501-wq/SaasFactory/issues/18), #14 |
| SFV3-GEN | [#20](https://github.com/totorina47501-wq/SaasFactory/issues/20) | P0 | generator-engineer | [#17](https://github.com/totorina47501-wq/SaasFactory/issues/17), [#19](https://github.com/totorina47501-wq/SaasFactory/issues/19) |
| SFV3-INTAKE | [#21](https://github.com/totorina47501-wq/SaasFactory/issues/21) | P0 | product-architect | [#17](https://github.com/totorina47501-wq/SaasFactory/issues/17), [#20](https://github.com/totorina47501-wq/SaasFactory/issues/20), #14 |
| SFV3-DB | [#22](https://github.com/totorina47501-wq/SaasFactory/issues/22) | P0 | generator-engineer | [#17](https://github.com/totorina47501-wq/SaasFactory/issues/17), [#20](https://github.com/totorina47501-wq/SaasFactory/issues/20) |
| SFV3-AUTH | [#23](https://github.com/totorina47501-wq/SaasFactory/issues/23) | P0 | security-engineer | [#17](https://github.com/totorina47501-wq/SaasFactory/issues/17), [#22](https://github.com/totorina47501-wq/SaasFactory/issues/22) |
| SFV3-TENANT | [#24](https://github.com/totorina47501-wq/SaasFactory/issues/24) | P0 | security-engineer | [#17](https://github.com/totorina47501-wq/SaasFactory/issues/17), [#23](https://github.com/totorina47501-wq/SaasFactory/issues/23) |
| SFV3-MFA | [#25](https://github.com/totorina47501-wq/SaasFactory/issues/25) | P1 | security-engineer | [#17](https://github.com/totorina47501-wq/SaasFactory/issues/17), [#24](https://github.com/totorina47501-wq/SaasFactory/issues/24) |
| SFV3-BACKUP | [#26](https://github.com/totorina47501-wq/SaasFactory/issues/26) | P1 | platform-engineer | [#17](https://github.com/totorina47501-wq/SaasFactory/issues/17), [#22](https://github.com/totorina47501-wq/SaasFactory/issues/22), [#24](https://github.com/totorina47501-wq/SaasFactory/issues/24) |
| SFV3-JOBS | [#27](https://github.com/totorina47501-wq/SaasFactory/issues/27) | P0 | platform-engineer | [#17](https://github.com/totorina47501-wq/SaasFactory/issues/17), [#22](https://github.com/totorina47501-wq/SaasFactory/issues/22), [#24](https://github.com/totorina47501-wq/SaasFactory/issues/24) |
| SFV3-STORAGE | [#30](https://github.com/totorina47501-wq/SaasFactory/issues/30) | P0 | security-engineer | [#17](https://github.com/totorina47501-wq/SaasFactory/issues/17), [#24](https://github.com/totorina47501-wq/SaasFactory/issues/24), [#27](https://github.com/totorina47501-wq/SaasFactory/issues/27) |
| SFV3-INGEST | [#34](https://github.com/totorina47501-wq/SaasFactory/issues/34) | P0 | generator-engineer | [#17](https://github.com/totorina47501-wq/SaasFactory/issues/17), [#30](https://github.com/totorina47501-wq/SaasFactory/issues/30) |
| SFV3-RETRIEVAL | [#38](https://github.com/totorina47501-wq/SaasFactory/issues/38) | P0 | generator-engineer | [#17](https://github.com/totorina47501-wq/SaasFactory/issues/17), [#34](https://github.com/totorina47501-wq/SaasFactory/issues/34) |
| SFV3-RAGLIFE | [#42](https://github.com/totorina47501-wq/SaasFactory/issues/42) | P0 | generator-engineer | [#17](https://github.com/totorina47501-wq/SaasFactory/issues/17), [#38](https://github.com/totorina47501-wq/SaasFactory/issues/38), [#27](https://github.com/totorina47501-wq/SaasFactory/issues/27) |
| SFV3-LLM | [#46](https://github.com/totorina47501-wq/SaasFactory/issues/46) | P1 | generator-engineer | [#17](https://github.com/totorina47501-wq/SaasFactory/issues/17), [#42](https://github.com/totorina47501-wq/SaasFactory/issues/42) |
| SFV3-VIDEO | [#36](https://github.com/totorina47501-wq/SaasFactory/issues/36) | P1 | generator-engineer | [#17](https://github.com/totorina47501-wq/SaasFactory/issues/17), [#30](https://github.com/totorina47501-wq/SaasFactory/issues/30), [#27](https://github.com/totorina47501-wq/SaasFactory/issues/27) |
| SFV3-AUDIO | [#39](https://github.com/totorina47501-wq/SaasFactory/issues/39) | P1 | generator-engineer | [#17](https://github.com/totorina47501-wq/SaasFactory/issues/17), [#36](https://github.com/totorina47501-wq/SaasFactory/issues/36) |
| SFV3-SPEECH | [#43](https://github.com/totorina47501-wq/SaasFactory/issues/43) | P2 | generator-engineer | [#17](https://github.com/totorina47501-wq/SaasFactory/issues/17), [#39](https://github.com/totorina47501-wq/SaasFactory/issues/39) |
| SFV3-IMAGE | [#37](https://github.com/totorina47501-wq/SaasFactory/issues/37) | P1 | generator-engineer | [#17](https://github.com/totorina47501-wq/SaasFactory/issues/17), [#30](https://github.com/totorina47501-wq/SaasFactory/issues/30) |
| SFV3-DOCUMENTS | [#40](https://github.com/totorina47501-wq/SaasFactory/issues/40) | P2 | generator-engineer | [#17](https://github.com/totorina47501-wq/SaasFactory/issues/17), [#37](https://github.com/totorina47501-wq/SaasFactory/issues/37), [#34](https://github.com/totorina47501-wq/SaasFactory/issues/34) |
| SFV3-BILLING | [#29](https://github.com/totorina47501-wq/SaasFactory/issues/29) | P1 | generator-engineer | [#17](https://github.com/totorina47501-wq/SaasFactory/issues/17), [#24](https://github.com/totorina47501-wq/SaasFactory/issues/24) |
| SFV3-ENTITLEMENTS | [#32](https://github.com/totorina47501-wq/SaasFactory/issues/32) | P1 | generator-engineer | [#17](https://github.com/totorina47501-wq/SaasFactory/issues/17), [#29](https://github.com/totorina47501-wq/SaasFactory/issues/29) |
| SFV3-NOTIFY | [#33](https://github.com/totorina47501-wq/SaasFactory/issues/33) | P1 | generator-engineer | [#17](https://github.com/totorina47501-wq/SaasFactory/issues/17), [#24](https://github.com/totorina47501-wq/SaasFactory/issues/24), [#27](https://github.com/totorina47501-wq/SaasFactory/issues/27) |
| SFV3-API | [#35](https://github.com/totorina47501-wq/SaasFactory/issues/35) | P1 | security-engineer | [#17](https://github.com/totorina47501-wq/SaasFactory/issues/17), [#24](https://github.com/totorina47501-wq/SaasFactory/issues/24), [#32](https://github.com/totorina47501-wq/SaasFactory/issues/32) |
| SFV3-OBS | [#31](https://github.com/totorina47501-wq/SaasFactory/issues/31) | P1 | platform-engineer | [#17](https://github.com/totorina47501-wq/SaasFactory/issues/17), [#24](https://github.com/totorina47501-wq/SaasFactory/issues/24), [#27](https://github.com/totorina47501-wq/SaasFactory/issues/27) |
| SFV3-ANALYTICS | [#41](https://github.com/totorina47501-wq/SaasFactory/issues/41) | P2 | generator-engineer | [#17](https://github.com/totorina47501-wq/SaasFactory/issues/17), [#31](https://github.com/totorina47501-wq/SaasFactory/issues/31), [#35](https://github.com/totorina47501-wq/SaasFactory/issues/35) |
| SFV3-UX | [#28](https://github.com/totorina47501-wq/SaasFactory/issues/28) | P1 | ux-accessibility | [#17](https://github.com/totorina47501-wq/SaasFactory/issues/17), [#20](https://github.com/totorina47501-wq/SaasFactory/issues/20), [#24](https://github.com/totorina47501-wq/SaasFactory/issues/24) |
| SFV3-I18N | [#44](https://github.com/totorina47501-wq/SaasFactory/issues/44) | P1 | ux-accessibility | [#17](https://github.com/totorina47501-wq/SaasFactory/issues/17), [#28](https://github.com/totorina47501-wq/SaasFactory/issues/28) |
| SFV3-ADMIN | [#45](https://github.com/totorina47501-wq/SaasFactory/issues/45) | P1 | ux-accessibility | [#17](https://github.com/totorina47501-wq/SaasFactory/issues/17), [#28](https://github.com/totorina47501-wq/SaasFactory/issues/28), [#29](https://github.com/totorina47501-wq/SaasFactory/issues/29), [#33](https://github.com/totorina47501-wq/SaasFactory/issues/33) |
| SFV3-MEDIAUI | [#47](https://github.com/totorina47501-wq/SaasFactory/issues/47) | P1 | ux-accessibility | [#17](https://github.com/totorina47501-wq/SaasFactory/issues/17), [#28](https://github.com/totorina47501-wq/SaasFactory/issues/28), [#39](https://github.com/totorina47501-wq/SaasFactory/issues/39), [#37](https://github.com/totorina47501-wq/SaasFactory/issues/37) |
| SFV3-CHATUI | [#50](https://github.com/totorina47501-wq/SaasFactory/issues/50) | P1 | ux-accessibility | [#17](https://github.com/totorina47501-wq/SaasFactory/issues/17), [#28](https://github.com/totorina47501-wq/SaasFactory/issues/28), [#46](https://github.com/totorina47501-wq/SaasFactory/issues/46) |
| SFV3-PRIVACY | [#48](https://github.com/totorina47501-wq/SaasFactory/issues/48) | P1 | security-engineer | [#17](https://github.com/totorina47501-wq/SaasFactory/issues/17), [#42](https://github.com/totorina47501-wq/SaasFactory/issues/42), [#33](https://github.com/totorina47501-wq/SaasFactory/issues/33), [#29](https://github.com/totorina47501-wq/SaasFactory/issues/29), [#31](https://github.com/totorina47501-wq/SaasFactory/issues/31) |
| SFV3-RUNTIME | [#49](https://github.com/totorina47501-wq/SaasFactory/issues/49) | P1 | platform-engineer | [#17](https://github.com/totorina47501-wq/SaasFactory/issues/17), [#20](https://github.com/totorina47501-wq/SaasFactory/issues/20), [#22](https://github.com/totorina47501-wq/SaasFactory/issues/22), [#27](https://github.com/totorina47501-wq/SaasFactory/issues/27), [#31](https://github.com/totorina47501-wq/SaasFactory/issues/31) |
| SFV3-PROFILE | [#52](https://github.com/totorina47501-wq/SaasFactory/issues/52) | P1 | generator-engineer | [#17](https://github.com/totorina47501-wq/SaasFactory/issues/17), [#21](https://github.com/totorina47501-wq/SaasFactory/issues/21), [#25](https://github.com/totorina47501-wq/SaasFactory/issues/25), [#26](https://github.com/totorina47501-wq/SaasFactory/issues/26), [#32](https://github.com/totorina47501-wq/SaasFactory/issues/32), [#33](https://github.com/totorina47501-wq/SaasFactory/issues/33), [#35](https://github.com/totorina47501-wq/SaasFactory/issues/35), [#31](https://github.com/totorina47501-wq/SaasFactory/issues/31), [#44](https://github.com/totorina47501-wq/SaasFactory/issues/44), [#45](https://github.com/totorina47501-wq/SaasFactory/issues/45), [#47](https://github.com/totorina47501-wq/SaasFactory/issues/47), [#50](https://github.com/totorina47501-wq/SaasFactory/issues/50), [#48](https://github.com/totorina47501-wq/SaasFactory/issues/48), [#49](https://github.com/totorina47501-wq/SaasFactory/issues/49), [#43](https://github.com/totorina47501-wq/SaasFactory/issues/43), [#40](https://github.com/totorina47501-wq/SaasFactory/issues/40), [#41](https://github.com/totorina47501-wq/SaasFactory/issues/41) |
| SFV3-QA | [#53](https://github.com/totorina47501-wq/SaasFactory/issues/53) | P0 | qa-engineer | [#17](https://github.com/totorina47501-wq/SaasFactory/issues/17), [#52](https://github.com/totorina47501-wq/SaasFactory/issues/52) |
| SFV3-SECURITY | [#54](https://github.com/totorina47501-wq/SaasFactory/issues/54) | P0 | security-engineer | [#17](https://github.com/totorina47501-wq/SaasFactory/issues/17), [#53](https://github.com/totorina47501-wq/SaasFactory/issues/53) |
| SFV3-OPERATIONS | [#55](https://github.com/totorina47501-wq/SaasFactory/issues/55) | P1 | platform-engineer | [#17](https://github.com/totorina47501-wq/SaasFactory/issues/17), [#53](https://github.com/totorina47501-wq/SaasFactory/issues/53), [#26](https://github.com/totorina47501-wq/SaasFactory/issues/26), [#49](https://github.com/totorina47501-wq/SaasFactory/issues/49) |
| SFV3-RELEASE | [#56](https://github.com/totorina47501-wq/SaasFactory/issues/56) | P1 | documentation-release | [#17](https://github.com/totorina47501-wq/SaasFactory/issues/17), [#54](https://github.com/totorina47501-wq/SaasFactory/issues/54), [#55](https://github.com/totorina47501-wq/SaasFactory/issues/55), [#43](https://github.com/totorina47501-wq/SaasFactory/issues/43), [#40](https://github.com/totorina47501-wq/SaasFactory/issues/40), [#41](https://github.com/totorina47501-wq/SaasFactory/issues/41) |
| SFV3-PROJECTS | [#51](https://github.com/totorina47501-wq/SaasFactory/issues/51) | P1 | platform-engineer | [#17](https://github.com/totorina47501-wq/SaasFactory/issues/17) |

## Contrat commun et cycle de livraison

- Autorisation propriétaire : mode full auto demandé dans cette session le 2026-11-06 ; exécution limitée au périmètre et aux critères de cette mission. Aucun nouveau consentement humain requis par la politique documentaire pour les tâches du catalogue, sous réserve des protections et refus explicites d'autorisation.
- Avant de coder : lire AGENTS.md, README.md, contrats et audit ; comparer issues/PR ouvertes et respecter tous les Files. Réutiliser modules/services existants ; aucune logique métier, migration, corpus, prompt ou donnée Project3.
- Tout fonctionne localement après installation initiale open source ; aucun OpenAI/Anthropic/Stripe réel/Supabase Cloud/auth hébergée/stockage distant/email distant/modèle téléchargé en tests. Pas de déploiement, activation fournisseur, opération financière ou changement de secrets.
- Produire contrat et API versionnés, erreurs fail-closed, tests unitaires/intégration du module et tests dans app générée, docs FR et budgets/limites. Pas de fonctionnalité annoncée disponible si simple placeholder.
- Écrire les tests d'échec pertinents, implémenter, exécuter tests ciblés puis npm test et CI. Branche/PR unique avec Fixes #<cette issue>, scope vérifié et preuves SHA. Aucune fusion si CI rouge, contrôle manquant ou review non concluante.
- Le module publie un descripteur conforme au registre et ses fichiers de génération sous son propre périmètre ; migration DB propre au module. Ne pas modifier les fichiers partagés d'une autre mission : utiliser les contrats et déclarer un besoin de modification plutôt que dupliquer.
- Rollbacks : revert PR/retrait du module via configuration ; migrations données avec stratégie réversible documentée, jamais effacement silencieux. API indisponible/dépendance absente => état non prêt et preuve, pas de faux succès.
- Dépendances : seul le coordinateur SFV3-AUTO peut promouvoir cette mission prévue par le catalogue. agent:planned n'est pas agent:blocked : les attentes ne doivent pas occuper une place active.
- Arrêt : deux tentatives PR/SHA maximum de correction CI selon #6 ; blocage documenté ensuite. Ne pas contourner protections GitHub ni exécuter du code PR avec privilèges. Le refus de fusion #14 reste explicitement retenu, aucun contournement par ce catalogue.

Chaque mission suit ce cycle concret :

1. Relire les contrats, issues/PR et dépendances ; vérifier que `Files:` ne chevauche aucun travail actif. Consommer les interfaces versionnées de ARCH et GEN.
2. Écrire les tests ciblant les critères de son issue et constater leur échec initial ; fixtures synthétiques, modèles déterministes de démonstration explicitement séparés de l'inférence réelle.
3. Implémenter le module réutilisable, descripteur, migrations propres, génération, tests et documentation dans les seuls fichiers déclarés. Ne pas dupliquer les services communs.
4. Exécuter tests ciblés puis suite Factory et installation/typecheck/build/tests d'un SaaS généré ; tests PostgreSQL/FFmpeg réels lorsque requis, aucune API tierce au runtime et aucun poids téléchargé pour tester.
5. Ouvrir une seule PR avec `Fixes #<issue>`, preuves de commandes/SHA/CI, revue automatique du SHA final et limites explicites. Contrôler absence de données sensibles dans code/rapports.
6. Fusion par API uniquement lorsque tous les contrôles et dépendances sont prouvés, avec SHA attendu et protections normales ; refus fermé si revue/API/check incomplet. Réconcilier l'état livré et promouvoir les successeurs éligibles.
7. Rollback : revert revu/testé ou retrait de module ; données restaurables et migrations documentées, jamais suppression silencieuse. Après deux reprises CI infructueuses : blocage documenté, pas de boucle.

## Couverture de la demande V3

| Domaine demandé | Missions / travail existant |
| --- | --- |
| Audit initial, intake existant, Master Prompt | #14 existante ; INTAKE ; RELEASE |
| Architecture et registry | ARCH, REG, GEN |
| Auth, sessions, CSRF, RBAC, tenants, TOTP | AUTH, TENANT, MFA |
| PostgreSQL, migrations, seeds, backup/restore | DB, BACKUP, OPERATIONS |
| RAG local sans LLM | INGEST, RETRIEVAL, RAGLIFE |
| LLM local, chat et sources | LLM, CHATUI |
| Vidéo et FFmpeg/FFprobe | VIDEO, JOBS, STORAGE, MEDIAUI |
| Audio, ASR/TTS, sous-titres, waveform | AUDIO, SPEECH, MEDIAUI |
| Images, OCR, PDF et documents | IMAGE, DOCUMENTS, INGEST |
| Facturation simulée, quotas, flags | BILLING, ENTITLEMENTS |
| Notifications/email local | NOTIFY |
| API/OpenAPI/keys/webhooks | API |
| UX, dashboard, admin, onboarding, FR/EN/SEO | UX, ADMIN, I18N |
| Observabilité, analytics et vie privée | OBS, ANALYTICS, PRIVACY |
| Génération indépendante et starter complet | GEN, PROFILE, RUNTIME |
| Tests unitaires/intégration/Playwright/sécurité | Tests dans chaque contrat ; QA, SECURITY |
| Copilot, dépendances, fusion, reprises CI | AUTO ; #6/PR #16 ; autorisation #15 livrée |
| Projects V2 existant, rapports et traçabilité | PROJECTS, AUTO ; reporting existant conservé |
| Artefacts de déploiement inactifs | RUNTIME, RELEASE ; aucun déploiement |
| Licences/versions/tailles/exigences modèles | RETRIEVAL, LLM, SPEECH, DOCUMENTS, RELEASE |

## Validation du backlog et limites

`tests/factory-backlog.test.mjs` vérifie les 40 identités, rôles et permissions de planification, limites de concurrence/reprises, graphes de dépendances sans cycle, références existantes réutilisées, chemins et maintien du refus #14. Cela ne valide ni les futurs modules ni l'orchestrateur qui reste à développer.

Chaque issue porte son périmètre exact et ses critères ; les mises à jour du catalogue requièrent une PR avec CI verte. Les projets générés restent production-oriented, jamais production-ready par défaut. Aucun service externe, fournisseur, modèle lourd, dépense ou déploiement n'est activé par ce backlog.

La demande initiale reçue s'arrêtait à « Isolat » dans la section 19 ; les exigences de tests explicites et l'isolation décrite ailleurs sont couvertes. Toute suite non reçue devra être réconciliée sans prétendre avoir été auditée.

