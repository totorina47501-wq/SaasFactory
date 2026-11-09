# Extension GTM du backlog — 7 novembre 2026

L'index `docs/FACTORY-REMAINING-BACKLOG.md` décrit le snapshot **initial** de 40 missions daté du 6 novembre. Le catalogue machine V1 est étendu à **45 missions** par cinq nouvelles tâches : #64 Market Validation, #65 Acquisition, #66 Attribution, #70 CRM, #71 Autonomous Growth.

Leurs labels restent `agent:planned`, chaque mission a son rôle, ses fichiers uniques et ses dépendances prouvables. Le socle `growth/core/` livré séparément en #69 n'est pas le module final de production et ne doit pas être recréé. Les dépendances explicites dans le catalogue commencent toujours par #17 ; l'issue #59 de certification Full Auto reste un garde-fou opérationnel global, et non un sous-module artificiel du catalogue.

Aucune nouvelle tâche ne doit être promue avant validation du catalogue sur main et satisfaction des dépendances ; vérifier les projets et les PR pour éviter un travail concurrent. Le test `tests/factory-backlog.test.mjs` vérifie la couverture et les scopes.

## Orientation « communauté → feedback → amélioration » du 9 novembre 2026

La mission **#71 SFV3-AUTOGROWTH**, déjà inscrite au catalogue machine, devient le point de coordination de la boucle de retours du marché ; ses sous-lots G0–G5 et critères de qualité sont définis dans [autonomous.md](autonomous.md). **Ne pas créer de nouvelle issue Growth** : #65 fournit les brouillons/positionnement (PR #98 et #102), #66 les mesures consenties, #70 la gestion des interactions et #71 la synthèse/priorisation. Les modifications spécifiques à MentionCheck relèvent de [Project3 #102](https://github.com/totorina47501-wq/Project3/issues/102).

L'issue #71 reste planifiée et dépend de #17/#64/#65/#66/#70. Son développement complet ne doit pas être promu tant que le coordinateur n'a pas démontré les dépendances et les permissions. **Les annonces, sources sociales et améliorations GitHub restent en brouillon jusqu'à autorisation explicite.** Voir aussi [Growth Agency Pilot](agency-pilot.md).
