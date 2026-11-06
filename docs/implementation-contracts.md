# Contrats d'implémentation — SaaSFactory

**Statut : normatif (processus interne)** · **Version : 1.0** · **Périmètre :** modules réutilisables, tâches agents, workflows CI et intégrations GitHub.

Ce document complète sans remplacer [le contrat du générateur](generator-contract.md), [l'orchestration Copilot](agent-orchestration.md), et [la synchronisation Projects V2](projects-v2-status-sync.md). Il ne modifie pas leurs interfaces en production.

## 1. Modèle de responsabilité

| Domaine | Responsable | Contrat | Interdictions |
| --- | --- | --- | --- |
| Product Owner | Propriétaire du dépôt | Approuve la portée et les critères d'acceptation des missions | Aucune approbation implicite par carte Projects |
| Agent Copilot | Contributeur implémentation | Un seul périmètre de fichiers, PR traçable, preuves CI | Ne fusionne ni ne déploie ; aucun changement de secret |
| Dispatcher / coordinateur | `.github/scripts/agent-dispatch.cjs`, `.github/scripts/factory-orchestration.cjs` | Affectation après coordination ; maximum deux missions actives et une affectation par passage ; promotion et fusion seulement pour une mission autorisée au catalogue et après preuves vérifiées | Aucun contournement de protection, d'autorisation ou de périmètre |
| Sync Projects V2 | `.github/scripts/projects-v2-sync.cjs` | Réconcilie le champ `Status` des cartes déjà présentes | Ne crée pas de carte, d'issue ou de PR ; n'assigne aucun agent |
| CI | `.github/workflows/ci.yml` | Tests reproductibles sur PR et sur `main` | Ne prouve pas un déploiement réel |
| Sécurité | Mainteneur habilité | Contrôle du risque, secrets et droits minimaux | Secrets en logs, code, prompts, commentaires ou artefacts |

## 2. Contrat d'une mission : de l'approbation à la livraison

Chaque mission significative possède une **fiche d'implémentation** conforme au [modèle versionné](templates/implementation-contract.md) et référencée depuis l'issue et la PR. Une modification documentaire mineure peut s'appuyer sur la fiche directement dans la description de PR, mais les obligations de sécurité restent applicables.

**Préconditions** :
- Une issue unique avec besoin métier, propriétaire de la décision, priorité `P0/P1/P2`, limites du périmètre et liens vers travaux existants.
- `Files: path1, path2` sur une ligne de l'issue pour le dispatcher ; refuser les recouvrements.
- Le label `agent:approved` autorise l'affectation. Seul le coordinateur peut promouvoir `agent:planned`, et uniquement depuis le catalogue v1 chargé du SHA `main` de l'événement après vérification des métadonnées et dépendances. Le statut `Approved` de Projects V2 n'est qu'une représentation visuelle.
- Contrôler les issues et PR ouvertes, les docs, les tests et les fonctionnalités avant création : réutiliser ou compléter plutôt que dupliquer.

**Postconditions** :
- PR reliée à l'issue ; changements strictement dans `Files:` ou extension explicitement revue.
- API, flux de données, sources de vérité, erreurs, rollback et compatibilité décrits.
- Tests nouveaux ou réutilisés avec preuve de leur exécution ; absence de régression sur le générateur et le dispatcher.
- Documentation mise à jour et **preuves GitHub** (SHA, CI, revue) ; pas de prétention de validation externe non observée.

**Transitions** : Backlog → Approved → Assigned → Coding / In Progress → PR Review → Done. `CI Blocked` n'est défini que lorsqu'une preuve d'échec et un marqueur explicite existent. Une PR fermée non fusionnée n'est pas `Done`. Ne pas déplacer une carte en considérant qu'un vert CI équivaut à une revue humaine.

## 3. Contrats d'interface et compatibilité

Chaque composant changeant publie : (a) entrée et schéma, (b) sortie et garanties, (c) effets de bord, (d) erreurs, (e) sécurité et (f) tests. Les modifications incompatibles imposent une version de contrat nouvelle, un plan de migration et l'approbation du mainteneur. Les comportements non décrits sont refusés par défaut.

- **Générateur** : `schemaVersion: 1`, manifeste déterministe, `dry-run` par défaut, écriture explicite `--write` uniquement vers un répertoire neuf. Voir [contrat existant](generator-contract.md).
- **Dispatcher** : état GitHub des issues/PR comme source de vérité ; quotas et périmètres de fichiers vérifiés avant affectation. Voir [orchestration existante](agent-orchestration.md).
- **Synchroniseur Projects V2** : le champ `Status` est une projection des états GitHub. Le contrat exact de lecture et écriture est dans [le contrat Projects V2](contracts/projects-v2-sync-v1.md).

## 4. Definition of Ready (DoR)

Une mission est éligible au dispatch seulement si : objectif testable, fichiers autorisés, dépendances déclarées, risque classé, critères de validation écrits, absence de doublon confirmé, approbation explicite et capacité restante. Les champs du modèle complètent les garde-fous effectifs du dispatcher ; ils ne sont pas tous actuellement contrôlés par du code.

## 5. Definition of Done (DoD)

Une livraison ne peut être déclarée terminée que si : critères d'acceptation prouvés, tests CI pertinents verts sur le SHA final, revue/approbations requises respectées, docs et changelog impactés mis à jour, absence de secrets et de code externe, PR fusionnée conformément aux protections, et liens de preuve archivés. Un workflow **sans mutation** réussi ne prouve que les permissions en lecture.

## 6. Risques et règles de sécurité

- Droits minimaux : `GITHUB_TOKEN` lecture pour le synchroniseur ; PAT Projects V2 isolé dans `SAASFACTORY_PROJECTS_V2_TOKEN` et jamais exposé ; rotation et expiration documentées.
- Aucune mutation Projects V2 tant que `SAASFACTORY_PROJECTS_V2_SYNC_ENABLED=true` n'est pas défini après inspection d'un dry-run.
- Les labels pilotent l'autorisation et la progression ; GitHub Projects ne remplace jamais GitHub Issues, Reviews, checks, ni les garde-fous de branche.
- La fusion humaine reste le défaut. La fusion automatique est limitée aux missions autorisées au catalogue v1, aux PR Copilot vers `main`, au périmètre exact, aux checks CI authentifiés sur le SHA courant et à une revue finale automatisée vérifiant les fichiers modifiés et l'absence de fils non résolus. Elle utilise le SHA attendu et n'active pas `allow_auto_merge` ni ne modifie les protections. Aucun changement de secrets, déploiement, transfert de données d'un autre dépôt, paiement ou activation fournisseur.
- Les lectures REST et la mutation GitHub ne sont pas atomiques : une issue, une revue, une dépendance ou la branche de base peut changer entre la dernière vérification et la fusion. Une SHA attendue protège la tête de PR, pas l'état de l'issue ou la base ; les protections de branche restent nécessaires. Pour les missions du catalogue autorisées en full auto par le propriétaire, la revue automatisée finale s'applique ; aucune validation humaine supplémentaire n'est imposée par ce contrat.
- Incident : désactiver la variable d'écriture, interrompre les exécutions concernées si nécessaire, consulter les résumés Actions, corriger par PR revue, puis relancer en dry-run.

## 7. Traçabilité et gestion du changement

Toute nouvelle fonctionnalité doit relier **Issue → Contrat → PR → Commit → Tests → Décision**. Une nouvelle version de contrat décrit les différences et leur impact sur les éléments existants. Ne pas recréer de fichier, workflow, projet ou statut déjà présent sans justification écrite. Le [modèle](templates/implementation-contract.md) doit être complété, et la [checklist PR](../.github/PULL_REQUEST_TEMPLATE.md) sert de rappel, non de preuve automatique.
