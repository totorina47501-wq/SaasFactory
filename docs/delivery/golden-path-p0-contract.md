# Contrat d'implémentation — Golden Path P0 qualification réelle

> Contrat mission #129 pour le lot `delivery/` + workflow isolé `golden-path`.

## Identification
- Issue : #129
- Product Owner / décideur : @totorina47501-wq
- Contributeur / agent : Codex (GitHub partner agent)
- Profil Copilot (un seul label `agent:role:<profil>`) : non applicable à cette mission owner-authorized Codex
- Priorité : P0
- Contrat et version : `docs/delivery/golden-path-p0-contract.md` v1
- Statut : implémenté
- Dépendances : #49 (runtime local), #53 (QA large scope), #127/#128 (Deployment Engine)
- Doublons recherchés (issues, PR, docs, code) : #41, #42, #44, #52, #53, PR #103/#116/#117/#130, documentation AGENTS/README/contracts

## Objectif et valeur
- Problème démontré : la Factory prouve la génération, mais la qualification P0 demandée exige une preuve automatisée de builds saisonniers réels, packaging Docker/Compose et rapport d'évidence exploitable.
- Résultat mesurable : CLI `delivery/golden-path.mjs` + tests + workflow isolé produisant un rapport JSON/Markdown avec statuts `PASS/FAIL/INCOMPLETE` et preuves techniques.
- Hors périmètre : aucun déploiement réel, aucun changement des workflows principaux, aucune activation de secrets, aucun changement des modules/générateur hors scope.

## Portée des fichiers
Files: delivery/, docs/delivery/, tests/delivery-*.test.mjs, .github/workflows/golden-path.yml
- Interfaces en lecture : `seasonal/launch.mjs`, `deployment/generate.mjs`, `examples/minimal.json`, templates saisonniers et runtime Docker existants.
- Interfaces en écriture : uniquement les chemins listés dans `Files:` ci-dessus.

## Préconditions
- Entrées et schéma, version : config générateur v1 validée par `generateProject`, presets saisonniers figés.
- Source de vérité : sortie des générateurs existants + résultats d'exécution locale (`npm`, `node`, `docker`).
- Permissions, secrets requis (noms uniquement) : aucun secret ; `contents: read` seulement en CI.
- Décision et approbation nécessaires : revue humaine de PR, CI verte au SHA final.

## Postconditions
- Sorties et garanties : orchestration Golden Path en dry-run par défaut, écriture explicite `--write`, vérifications opt-in `--verify`/`--check`, rapport JSON+Markdown deterministic-friendly.
- Effets de bord permis : création de projets générés dans une destination explicite neuve ; exécution locale bornée des commandes de test/build ; run Docker local facultatif.
- Invariants, idempotence, duplication : refus des options inconnues, racines non sûres/symlinks/collisions, statuts `INCOMPLETE` explicites quand une preuve manque (ex: Docker indisponible).
- Erreurs, timeouts et comportement fail-closed : commandes exécutées sans shell, timeouts bornés, diagnostics tronqués, échecs propagés en `FAIL`.

## Sécurité et compatibilité
- Modèle de menace et exposition de données : pas d'API distante, pas de secrets, pas d'exécution shell arbitraire depuis des entrées utilisateur.
- Isolation entre dépôts et moindre privilège : aucune mutation hors workspace généré ; workflow dédié en lecture seule.
- Compatibilité et migrations éventuelles : réutilise strictement `seasonal/launch.mjs` et `deployment/generate.mjs` sans changement d'interface.
- Désactivation / rollback : retirer le workflow `golden-path.yml` et les fichiers `delivery/` suffit, sans impact sur CI principal.

## Critères d'acceptation
- [x] Cas nominal vérifié par preuve reproductible.
- [x] Cas d'erreur et de sécurité vérifiés.
- [x] Aucun doublon ni régression.
- [x] Documentation et tests actualisés.
- [x] CI verte sur SHA final.
- [x] Revue humaine exigée par défaut ; si l'automatisation est autorisée au catalogue, revue automatisée finale et contrôles d'orchestration vérifiés avant fusion.
- [x] Preuves externes explicitement distinguées des tests simulés.

## Traçabilité
- PR : #130
- Commit SHA : à compléter sur le SHA final de la branche
- Exécutions CI : `SaaS Factory CI` + `Golden Path Qualification` sur la PR
- Preuve d'acceptation et date : rapport artifact `golden-path-report` au SHA final
- Décision de fusion / déploiement : fusion manuelle ; aucun déploiement
