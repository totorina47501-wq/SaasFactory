# Extension GTM du backlog — 7 novembre 2026

L'index `docs/FACTORY-REMAINING-BACKLOG.md` décrit le snapshot **initial** de 40 missions daté du 6 novembre. Le catalogue machine V1 est étendu à **45 missions** par cinq nouvelles tâches : #64 Market Validation, #65 Acquisition, #66 Attribution, #70 CRM, #71 Autonomous Growth.

Leurs labels restent `agent:planned`, chaque mission a son rôle, ses fichiers uniques et ses dépendances prouvables. Le socle `growth/core/` livré séparément en #69 n'est pas le module final de production et ne doit pas être recréé. Les dépendances explicites dans le catalogue commencent toujours par #17 ; l'issue #59 de certification Full Auto reste un garde-fou opérationnel global, et non un sous-module artificiel du catalogue.

Aucune nouvelle tâche ne doit être promue avant validation du catalogue sur main et satisfaction des dépendances ; vérifier les projets et les PR pour éviter un travail concurrent. Le test `tests/factory-backlog.test.mjs` vérifie la couverture et les scopes.
