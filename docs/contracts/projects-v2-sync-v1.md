# Contrat technique — GitHub Projects V2 Status Sync

**ID :** `SF-PROJECTS-SYNC` · **Version :** `1.0.0` · **Statut :** implémentation candidate (PR #10, non fusionnée au moment de la rédaction).

## Objet et frontière de responsabilité

Projeter les états vérifiables des issues et PR de `totorina47501-wq/SaasFactory` dans le champ **Status** du Project V2 personnel existant #2, `SaaSFactory — Agents`. Ce composant ne change **jamais** le statut GitHub des issues/PR, l'affectation Copilot, les labels, la CI ni les règles de fusion. L'ajout de cartes reste confié au workflow GitHub Projects **Auto-add to project** existant.

## Interface d'entrée

- Exécution : `schedule` toutes les 10 minutes UTC (six contrôles/heure), ou `workflow_dispatch` manuel.
- Permission dépôt : `contents: read` ; secret Actions `SAASFACTORY_PROJECTS_V2_TOKEN`, avec permission GitHub Projects V2.
- Garde d'environnement : `GITHUB_REPOSITORY=totorina47501-wq/SaasFactory`.
- Identité du projet : login `totorina47501-wq`, numéro `2`, titre attendu `SaaSFactory — Agents`.
- Lecture : GraphQL `user.projectV2`, champ `Status`, pagination des `items`, contenus typés `Issue`/`PullRequest`, labels, assignees, état de clôture/fusion.
- Activation des écritures : variable repo `SAASFACTORY_PROJECTS_V2_SYNC_ENABLED=true` ; les exécutions manuelles exigent également `apply=true`. Sans ce double accord, **dry-run**.

## Résultat et invariants

- Une seule écriture `updateProjectV2ItemFieldValue` par carte dont la valeur diffère de l'état cible.
- Aucune écriture pour une carte conforme, un contenu externe, un contenu absent, un élément sans transition justifiée ou une PR fermée non fusionnée.
- Une issue ouverte `agent:approved` sans marqueur de progression est `Approved`; une issue assignée Copilot sans marqueur de travail est `Assigned`.
- Une issue ouverte `agent:planned` reste dans l'option existante `Backlog`; le rapport JSON différencie `planned` de `waiting` selon la déclaration et la preuve de ses dépendances.
- `agent:in-progress` → `In Progress`; `agent:review` → `PR Review`; `agent:coding` → `Coding`; `agent:blocked` → `CI Blocked`.
- Une PR ouverte (y compris draft) → `PR Review` ; issue fermée avec `stateReason=COMPLETED` ou PR fusionnée → `Done`. Une issue `NOT_PLANNED` ou dont la raison de fermeture n'est pas reconnue revient à `Backlog`, jamais à `Done`.
- Les dépendances `Depends-On:` sont affichées sans créer de cartes. Une issue dépendante n'est livrée que si elle est fermée comme `COMPLETED` et qu'une PR fusionnée du projet la référence via `closingIssuesReferences`; une dépendance PR doit être fusionnée. Une carte absente, une déclaration invalide, un doublon ou une preuve API incomplète reste non résolue.
- Le statut `Approved` n'autorise **jamais** un agent : seul le label `agent:approved` est interprété par le dispatcher séparé.
- Le rapport `cards` contient le statut projet courant, l'état opérationnel (`planned`, `waiting`, `assigned`, `review`, `CI blocked`, `done`, etc.), l'état de résolution des dépendances et les dépendances reconnues. Il n'inclut ni corps d'issue ni secret.

## Préconditions et échecs

- Arrêt avant mutation si : projet/titre incorrect, option `Status` manquante, réponse ou pagination incomplète/incohérente, plus de 500 cartes ou plus de 100 changements prévus, doublon d'identité de carte.
- Les changements sont arrêtés si l'API renvoie une erreur ou ne confirme pas la carte mutée ; GitHub GraphQL ne garantit pas de transaction multi-cartes : une relance idempotente reprend les cartes manquantes après correction.
- Les logs et résumés peuvent exposer identifiants d'issues et transitions de statut, **jamais** la valeur des jetons.
- Un échec de contrôle CI ne place pas automatiquement une carte en `CI Blocked` : le label `agent:blocked` est un prérequis contrôlé indépendamment.

## Matrice d'acceptation

| ID | Scénario | Résultat attendu | Preuve automatisée |
| --- | --- | --- | --- |
| PV2-01 | Issue approuvée, sans assignee | `Approved` | Test de mapping |
| PV2-02 | Issue affectée à Copilot | `Assigned` | Test de mapping |
| PV2-03 | PR draft ouverte | `PR Review`, jamais `Done` | Test de mapping |
| PV2-04 | PR fusionnée ou issue fermée comme `COMPLETED` | `Done` | Test de mapping |
| PV2-05 | Statut déjà conforme | 0 mutation | Test d'idempotence |
| PV2-06 | Doublon dans les cartes | Arrêt avant écriture | Test fail-closed |
| PV2-07 | Projet extérieur | Aucune mutation | Test d'isolation |
| PV2-08 | Pagination multi-pages | Toutes les pages traitées | Test pagination |
| PV2-09 | Exécution non activée | 0 mutation | Test dry-run |
| PV2-10 | Issue `NOT_PLANNED` ou closure inconnue | Jamais `Done` | Tests de mapping |
| PV2-11 | Dépendance issue sans PR fusionnée de clôture | Affichée non résolue / `waiting` | Test de dépendance |
| PV2-12 | Réponse API partielle ou mutation non acquittée | Arrêt fail-closed | Tests d'échec |

La preuve de **lecture** du Project V2 est le diagnostic vert `SaaSFactory Projects V2 connection check`. Le passage en écriture doit être vérifié séparément sur `main`, après revue du dry-run et activation autorisée ; un accusé API prouve uniquement la mutation concernée. Les tests hors réseau ne prouvent pas les permissions GitHub réelles. L'Auto-add natif est la seule voie d'ajout de cartes ; le synchroniseur ne peut pas détecter une issue absente du Project ni la créer.

## Déploiement et rollback

1. Tester la PR et vérifier l'absence de doublon avec les workflows existants.
2. Fusionner uniquement après revue exigée et CI verte.
3. Déclencher une exécution manuelle **dry-run** et contrôler les transitions proposées.
4. Définir `SAASFACTORY_PROJECTS_V2_SYNC_ENABLED=true` pour autoriser les écritures planifiées.
5. En incident : désactiver immédiatement la variable ; inspecter les résumés et corriger par PR. Ne pas réécrire l'historique GitHub.

**Version future :** tout nouveau statut ou mutation supplémentaire nécessite un amendement de contrat, un test négatif et une revue.
