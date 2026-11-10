# SaaSFactory — gel IA et procédure de reprise

**Décision du 10 novembre 2026 : PAUSE des agents SaaSFactory afin de concentrer les crédits et les efforts sur MentionCheck.** Ce dépôt n'est pas MentionCheck. Aucune action sur MentionCheck.

## Coupe-circuit conservateur
Les cinq workflows ci-dessous conservent leur code, mais leurs déclencheurs automatiques (`schedule`, `workflow_run`, `pull_request_target`) sont supprimés et chaque job reçoit un garde-fou littéral `false &&`. Même un `workflow_dispatch` manuel ne peut plus lancer les agents :
- `.github/workflows/saas-factory-agent-dispatch.yml`
- `.github/workflows/saas-factory-agent-ci-recovery.yml`
- `.github/workflows/saas-factory-post-main-ci-wake.yml`
- `.github/workflows/saas-factory-copilot-ci-wake.yml`
- `.github/workflows/saas-factory-copilot-ready-wake.yml`

Ainsi, plus de dispatch toutes les 10 minutes, de réveil à la CI verte, ni de commentaire de correction automatique `@copilot`. Aucune réécriture du générateur, aucun changement de secret, aucune augmentation de permission ou de quota. La CI déterministe `.github/workflows/ci.yml` **reste active**. Les workflows `saas-factory-final-review.yml`, `saas-factory-agent-report.yml`, `saasfactory-projects-v2-sync.yml` et `factory-quality-integrations.yml` avaient déjà été ramenés à un déclenchement manuel.

Le contrôle de revue Copilot payante peut aussi exister dans les **paramètres GitHub du compte ou de l'organisation** hors YAML. Le ruleset de dépôt #26648915 ne comportait au contrôle que les règles anti-suppression et anti-force-push. Ne pas attribuer à ce seul commit la désactivation de paramètres tiers ou l'arrêt de sessions déjà démarrées.

## Snapshot à préserver
- **Codex** : issue [#129](https://github.com/totorina47501-wq/SaasFactory/issues/129) et PR draft [#130](https://github.com/totorina47501-wq/SaasFactory/pull/130), dernier head `0421365e3e78740d41a89d17d92ceac81713275a`. CI PR #42774997835 réussie; Golden Path qualification #42774997683 réussie, rapport artifact #13743632174. Réinspecter le rapport de preuves et le SHA exact avant toute validation ou fusion.
- **Copilot** : issue [#70](https://github.com/totorina47501-wq/SaasFactory/issues/70) et PR draft [#145](https://github.com/totorina47501-wq/SaasFactory/pull/145) (0 fichier changé à la vérification). Ne jamais fusionner une PR vide.
- **Blocage Full Auto** : issue [#59](https://github.com/totorina47501-wq/SaasFactory/issues/59), toujours ouverte. La preuve issue→assignation→PR→CI→merge→mission suivante reste à produire.
- **Growth** : #64 / #65 / #66 / #71 restent en attente des dépendances et de #59. #67 concerne la politique de review à coût réduit ; ne pas réactiver les reviews payantes par défaut.

La mise en pause opérationnelle retire l'assignation `Codex` de #129 et #130, `Copilot` de #70 et #145, et retire les labels `agent:in-progress` de #129 et #70; elle conserve le propriétaire, les PR, branches, commentaires, CI existantes et les droits du dépôt. Ces modifications de tickets ne sont pas un substitut à l'arrêt d'une éventuelle session GitHub coding-agent déjà active : vérifier l'interface GitHub et arrêter manuellement toute session qui serait toujours en cours.

## Réactivation rapide — un lot, sans bypass
1. **Demander une autorisation explicite** au propriétaire et confirmer budget Codex/Copilot disponible, contrôle des sessions et réglages GitHub Copilot review (compte, organisation et repo).
2. Depuis le dernier `main`, créer **une branche et une PR de revert du commit unique de pause** portant le message `ops: pause SaaSFactory AI agents and document safe resume`; ne jamais force-push. Vérifier les diffs et conflits depuis le gel; garder les protections et les tests. La CI PR doit réussir sur le SHA de tête final.
3. Après fusion autorisée, revérifier que les cinq workflows récupèrent leurs déclencheurs initiaux et guards actifs ; le dispatcher a normalement son cron `*/10 * * * *`. Ne pas modifier le secret `COPILOT_DISPATCH_TOKEN` si non nécessaire.
4. Revalider #129/#130 et #70/#145 puis réassigner Codex/Copilot **seulement** sur les missions autorisées, en respectant la limite globale de 4 agents. Réexaminer aussi #52/#53 et le starter v2. Ne pas créer de doublons.
5. Prouver sur GitHub un cycle de bout en bout réel : dispatch planifié → assignation confirmée par API → PR avec changements → CI + revue gratuite du SHA exact → fusion conforme → mission suivante. Ne clore #59 qu'après les preuves. Ne reprendre les missions Growth que lorsque leurs dépendances sont réellement satisfaites.

### Risques résiduels et vérification
- Les exécutions déjà en cours ou en file au moment de la fusion du coupe-circuit peuvent se terminer : vérifier GitHub Actions et sessions coding-agent.
- Le YAML ne peut pas désactiver les réglages auto-review hors dépôt. À vérifier sur [GitHub Copilot settings](https://github.com/settings/copilot) et [Repository settings](https://github.com/totorina47501-wq/SaasFactory/settings).
- Une CI verte standard ne consomme pas à elle seule des crédits de coding-agent.
- Lors du restart, le revert de code ne réassigne pas automatiquement les issues gelées; les labels/assignations sont volontairement restaurés dans un second temps, après validation du budget et des prérequis.
