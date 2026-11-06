# Autorisation du dispatch Copilot

## Contrat d'implémentation v1

- Demande : correction d'autorisation explicitement demandée par le propriétaire dans cette session ; priorité P0 pour débloquer l'orchestration. Profil responsable : Platform Engineer.
- Mission liée : [#6](https://github.com/totorina47501-wq/SaasFactory/issues/6), bloquée à l'affectation ; cette correction n'implémente pas sa reprise CI et ne la clôture pas.
- Doublons vérifiés : seule PR ouverte #14, consacrée à l'intake ; aucune PR d'autorisation concurrente observée. Le dispatcher existant est réutilisé sans modification de son algorithme.
- Portée : `.github/workflows/saas-factory-agent-dispatch.yml`, `tests/agent-dispatch.test.cjs`, `docs/agent-orchestration.md`, `docs/copilot-dispatch-authorization.md`.
- Entrée : secret utilisateur explicitement configuré par le propriétaire, événements et métadonnées GitHub existants. Sorties : rapport existant et au plus une affectation approuvée, après les contrôles existants.
- Effets de bord : uniquement ceux du dispatcher existant. Aucun secret créé automatiquement, aucune activation de fournisseur, aucun déploiement ni merge.
- Compatibilité : cadence, capacité, périmètres et sélection de spécialiste conservés ; configuration d'authentification explicitement modifiée, ancien `GITHUB_TOKEN` sans repli.
- Acceptation hors ligne : 11 tests de dispatch réussis dans le processus courant, dont un test nouveau observé en échec avant correction. CI complète sur SHA final et revue requises avant fusion.
- Acceptation externe : configuration et affectation réellement confirmée dans GitHub, encore à réaliser ; un workflow vert sans affectation n'est pas une preuve de résolution.
- Risque : le jeton utilisateur possède les droits nécessaires à l'API Copilot. Son accès est limité à ce dépôt et à une étape de code de `main` ; expiration et révocation relèvent du propriétaire.
- Rollback et diagnostic : sections ci-dessous. Le lien vers la PR porteuse assure la traçabilité du SHA et des runs.

## Cause vérifiée

Le [run du 6 novembre 2026](https://github.com/totorina47501-wq/SaasFactory/actions/runs/42182741565) reçoit HTTP 403 lors de `POST /repos/totorina47501-wq/SaasFactory/issues/6/assignees`. Le workflow utilise un `GITHUB_TOKEN` avec `issues: write` ; l'issue #6 porte déjà `agent:approved` et `agent:role:platform-engineer`, sans affectation.

La [documentation GitHub](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/cloud-agent/use-cloud-agent-via-the-api) exige un jeton utilisateur pour affecter Copilot. Ajouter simplement des permissions au `GITHUB_TOKEN` ne remplace pas cette identité. Le 403 seul ne permet pas de conclure à un problème d'abonnement, de quota ou d'activation Copilot.

## Configuration par le propriétaire

1. Vérifier que Copilot cloud agent est disponible pour le compte et pour **SaasFactory**, sans souscrire de nouvelle offre ni modifier la facturation. L'interface d'affectation de l'issue #6 doit proposer Copilot. La requête `suggestedActors` de la documentation officielle permet aussi de le vérifier avec une identité utilisateur autorisée.
2. Depuis [les jetons personnels GitHub](https://github.com/settings/personal-access-tokens/new), créer un **fine-grained personal access token**, avec expiration courte et accès uniquement à `totorina47501-wq/SaasFactory`. Ne pas utiliser un jeton classique global ni réutiliser le secret Projects V2.
3. Permissions documentées pour l'affectation Copilot : **Metadata: read** ; **Actions, Contents, Issues, Pull requests: read and write**. Aucun accès Administration, Secrets, Environments ou Workflows demandé. Ces droits sont ceux du jeton utilisateur ; le `GITHUB_TOKEN` du workflow reste en lecture. Si GitHub exige un droit supplémentaire, interrompre et réexaminer plutôt qu'élargir silencieusement.
4. Dans [Settings → Secrets and variables → Actions](https://github.com/totorina47501-wq/SaasFactory/settings/secrets/actions), ajouter le secret de dépôt **`COPILOT_DISPATCH_TOKEN`**. Coller sa valeur uniquement dans le formulaire GitHub. Ne jamais la transmettre dans le chat, une issue, un commentaire, un fichier ou une commande journalisée.
5. Après revue et CI verte de la correction, fusionner selon les protections normales, puis lancer **SaaS Factory agent dispatch** depuis `main`, ou attendre son prochain passage planifié. Aucun jeton n'a été créé ou secret configuré automatiquement par cette correction.

## Isolation et limites

- Le workflow ne répond qu'au planning et à `workflow_dispatch`, sur le dépôt attendu et `refs/heads/main`. Aucune exécution sur événement de PR ou code de PR.
- Le checkout charge `main` avec le jeton par défaut en lecture et `persist-credentials: false`. Le secret utilisateur est fourni uniquement à l'étape `actions/github-script` du dispatcher.
- Si le secret manque, arrêt explicite avant le checkout. Aucun repli vers `GITHUB_TOKEN`, aucune élévation de ses permissions et aucune tentative en boucle dans une exécution.
- Les garde-fous existants restent inchangés : mission approuvée, spécialiste unique, absence de conflits de fichiers, deux missions actives au maximum, une affectation par passage et confirmation via relecture API.
- Six contrôles par heure ne garantissent ni six missions ni une affectation. Ce correctif ne traite pas les reprises CI bornées de #6, ne modifie pas Projects et n'autorise aucune fusion automatique.

## Validation réelle attendue

Un test hors ligne vérifie le câblage du jeton, l'absence de repli, le checkout isolé et les garde-fous du workflow. Il ne prouve pas que le secret existe, qu'il est autorisé ou que Copilot est disponible.

Après configuration, vérifier le run et son artefact `agent-dispatch-report-<run_id>` : décision `assigned:#6`, spécialiste `platform-engineer`, puis présence réelle de Copilot dans les assignees de #6. Ne pas marquer la mission affectée si la relecture échoue. Conserver les liens vers le run et la future PR Copilot comme preuves ; ne pas reproduire de jeton dans les rapports.

Si HTTP 403 persiste : vérifier expiration, dépôt sélectionné, droits du jeton et disponibilité Copilot pour son propriétaire. Ne pas relancer aveuglément ni désactiver les contrôles.

## Révocation et rollback

En cas d'incident, désactiver le workflow de dispatch, annuler toute exécution active et révoquer le jeton dans les paramètres utilisateur. Supprimer ensuite le secret de dépôt. Revenir au code précédent uniquement par PR revue ; l'ancien `GITHUB_TOKEN` ne constitue pas une solution d'affectation Copilot. La suppression du secret fait échouer les futurs dispatchs explicitement, sans lancer de mission.
