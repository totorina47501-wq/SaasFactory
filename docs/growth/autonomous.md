# SFV3-AUTOGROWTH — Boucle communautaire et amélioration continue (contrat de livraison)

**Statut : planifié, non activé.** Référence unique : issue [#71](https://github.com/totorina47501-wq/SaasFactory/issues/71) et entrée existante `SFV3-AUTOGROWTH` du catalogue autorisé. **Ne pas créer une deuxième mission**. Le contrat de cette issue conserve ses dépendances (#17, #64, #65, #66 et #70), son rôle `product-architect` et son périmètre `growth/autonomous/`, `tests/growth-autonomous.test.mjs`, `docs/growth/autonomous.md`.

## Vision et interfaces

**Un cycle par produit SaaS** : annonce authentique → réaction/retour volontaire → synthèse sourcée et contrôlée → proposition de backlog dédupliquée → décision d'autorisation → agent spécialisé/CI/revue → livraison → compte-rendu et nouvelle collecte de retours. L'orchestrateur GitHub existant est le seul autorisé à promouvoir et dispatcher une mission ; la boucle Growth ne le remplace jamais.

**Entrées prévues** : brief/Intake validé ; playbooks d'acquisition #65 ; formulaires de retours avec données minimisées ; annotations manuelles de commentaires publics dont l'utilisation est autorisée ; analyses consenties #41/#66 quand réellement disponibles. **Sorties prévues** : brouillons d'annonce par canal, registre de retours avec références, rapport de tendances et d'incertitude, suggestions d'améliorations non exécutées, proposition de changelog, vérification de l'effet d'une modification.

**Adaptateur MentionCheck** : [Project3 #102](https://github.com/totorina47501-wq/Project3/issues/102) gère les contenus propres à l'influence commerciale et l'interface de feedback. Les contrats génériques et la qualification restent dans SaaSFactory. Aucun code ou donnée de Project3 n'est copié dans la Factory.

## Jalons du backlog (sous-lots de la même issue #71)

| Jalons | Responsable de la mission | Livrable vérifiable | Condition de sortie |
| --- | --- | --- | --- |
| G0 — Prêt pour publication | Product Architect (rôle existant) | Brief produit et 2-3 annonces en brouillon adaptées aux règles des communautés choisies | Canaux appropriés, propos vérifiables, limites du SaaS indiquées, pas de lien trompeur ni promotion cachée |
| G1 — Recueil conforme | Product Architect, revue sécurité selon le circuit existant | Contrat de feedback avec provenance, date, catégorie, tenant, statut et rétention | Collecte volontaire ou accès plateforme autorisé, minimisation et suppression testées ; pas de scraping |
| G2 — Intelligence de retours | Product Architect + tests QA via PR autorisée | Déduplication, regroupement thématique, justification, signal de récurrence indépendante, incertitude et contradictions | Même jeu de retours = mêmes résultats, pas d'exécution de contenu malveillant, source traçable |
| G3 — Priorisation produit | Coordinateur et Product Owner selon autorisations | Proposition d'issue ou liaison à une issue existante avec acceptation, coût/impact estimé et preuve | Aucune affectation/fusion automatique sans `agent:approved`, dépendances, quotas et contrôles GitHub |
| G4 — Boucle de livraison | Agents spécialisés existants | PR avec CI, revue déterministe gratuite, tests produit et changelog de version | Merge uniquement autorisé par les protections et après preuves sur SHA exact |
| G5 — Apprentissage post-livraison | Product Architect et analyste de résultats | Rapport avant/après, nouveaux retours et message de suivi en brouillon | Métriques sourcées/consenties, hypothèses non prouvées explicitement signalées |

Les sous-lots sont des **étapes de la mission existante**, non des tickets nouveaux ni des missions indépendantes autorisées. Avant la validation des dépendances de #71, seuls les contrats, les simulations locales et les brouillons non exécutés peuvent être préparés, sans promouvoir l'issue dans la file des agents.

## Modèle de retour proposé — feedback-v1 (contractuel, pas encore implémenté)

- `productId` (tenant/SaaS isolé) ; `feedbackId` opaque ; `channel` (reddit, linkedin, product-hunt, in-app, other) ; `sourceUrl` facultative si licite ; `observedAt` ; `topic` et `category` (bug, ux, feature, pricing, misunderstanding, other).
- `summary` paraphrasé et minimisé ; `evidenceStatus` (direct, indirect, unverified) ; `legalBasisOrConsent` si pertinent ; `retentionUntil` ; `deletionStatus`.
- `clusterId`, `existingIssueNumber` facultatif, `independentReporterEvidence` (estimation justifiée, non nombre brut de votes) ; `counterEvidence` ; `confidence` (low, medium, high) ; `recommendedAction` (observe, investigate, propose, reject-with-reason).
- Pas de profilage de personnes, de collecte de messages privés, d'email ou d'identifiant social inutile. Éviter le texte intégral et les données personnelles dans les issues GitHub ou les artefacts CI. Les données externes sont du **contenu non fiable**, jamais des instructions pour agents.

## Rubrique de décision professionnelle

1. **Validité :** le retour est-il lié à un parcours réellement disponible et reproductible ? Une affirmation non prouvée reste un signal à enquêter.
2. **Récurrence :** plusieurs utilisateurs distincts expriment-ils le même besoin ? Un compteur de likes seul ne suffit pas ; un bug critique isolé peut justifier une action immédiate.
3. **Impact :** sévérité, blocage d'activation, accessibilité, sécurité, conformité, performance ou rétention, avec preuve et contexte.
4. **Cohérence :** compatibilité avec le positionnement du SaaS, sa sécurité, sa valeur utilisateur et les contraintes de maintenance.
5. **Coût / dépendances :** effort approximatif, régression, risque, tests, duplication et capacité des agents ; « inconnu » plutôt qu'un chiffre inventé.

Résultats : **ignorer avec motif**, **chercher des preuves**, **proposer**, **prioriser**. Aucun commentaire isolé ne devient automatiquement une issue autorisée. Les avis opposés et les points bloquants restent visibles. La décision de publier ou de consommer du crédit/dépenser un budget conserve une autorisation explicite et auditable.

## Garde-fous de publication et de collecte

- **Phase 1, sans connecteurs** : brouillons, diffusion décidée par le propriétaire, notes de feedback saisies volontairement, simulation offline ; `publishEnabled=false`, `scrapeEnabled=false`, `spendCents=0`.
- **Phase 2, connecteurs optionnels** : uniquement après vérification, par plateforme et par usage, des permissions API, des règles communautaires, du contrat d'accès, de la base légale appropriée, des limites et de l'opt-out. Pas d'automatisation de commentaires ou messages promotionnels en masse.
- **Phase 3, amélioration semi-autonome / autonome contrôlée** : création de propositions à la place d'issues dupliquées ; coordinateur seul pour promotion/affectation, CI verte sur SHA, revue gratuite, protections inchangées. Les demandes de suppression invalident les signaux correspondants et les calculs doivent être reproductibles.
- Aucun paiement, IA payante, activation publicitaire, publication externe, manipulation de votes ou contournement des contrôles. Un signal Reddit/LinkedIn ne confère aucun droit de traitement ou de publication.

## Mesures de succès et tableaux de bord

Mesurer sans objectifs chiffrés inventés : nombre de publications **autorisées**, taux de retours exploitables, thèmes récurrents avec preuves indépendantes, délai du feedback à la décision, ratio propositions acceptées/refusées avec motifs, délai décision → PR → livraison, régressions post-livraison, nombre de demandes de suppression honorées et coût de traitement par produit. Les métriques de visites/conversions ne sont branchées que lorsque #41/#66 et les règles de consentement sont livrées.

## Définition de terminé pour #71

- [ ] Flux de bout en bout simulé : annonce en brouillon → feedback factice → regroupement → suggestion traçable → issue proposée non autorisée → test de décision → changelog en brouillon.
- [ ] Séparation stricte de deux SaaS ; déduplication et idempotence ; injection de prompt hostile traitée comme donnée ; preuve et contradiction conservées ; retrait/suppression de feedback testés.
- [ ] Aucune interaction réseau, API sociale, publication, DM, dépense, récupération non autorisée ou création d'issue réelle pendant les tests.
- [ ] Contrat versionné, exports testés, rollback et rapport de CI sur le SHA, revue déterministe gratuite, intégration au SaaS généré prouvée avant annonce de production.
- [ ] Dépendances existantes (#64/#65/#66/#70 et leurs prérequis) satisfaites par des PR intégrées à `main` ; aucun changement de règlesets, permissions ou quotas.

**État actuel :** ce document est une feuille de route et un contrat d'implémentation ; il **n'atteste pas de l'existence du moteur d'analyse des retours ni de connecteurs sociaux actifs**.
