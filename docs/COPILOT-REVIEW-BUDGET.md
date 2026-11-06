# Review Copilot économique

La CI PR doit être verte avant la demande, le PR non brouillon et créé par Copilot. Le workflow lit seulement `main`, réserve sa demande par commentaire avant l'appel API, et n'émet aucune seconde revue sur la même PR (même après push). Toute erreur API ambiguë bloque sans nouvelle demande payante.

Le coordinateur existant conserve la vérification de la revue sur le SHA final, ainsi que la CI, les scopes, les dépendances et les protections. **Un nouveau push après la revue peut donc bloquer la fusion**; la limite stricte d'une seule revue et un cycle de corrections arbitraire sont incompatibles.

Choisir **Lite** dans les paramètres GitHub Copilot Code Review du compte/repository (la requête REST standard ne fixe pas ce mode); contrôler la mention Lite dans la PR. Vérifier les autres déclencheurs automatiques personnels et le déploiement d'une PR réelle avant de déclarer Full Auto certifié. Liens : #67 et #59.
