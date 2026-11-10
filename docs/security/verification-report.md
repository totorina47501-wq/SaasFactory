# Rapport de vérification sécurité

**Date :** 2026-11-10
**Mission :** SFV3-SECURITY / issue #54
**Portée des changements :** tests adversariaux et documentation seulement; aucun
module de production, workflow, contrôle d'accès ou secret n'a été modifié.

## Tests réalisés

| Commande / preuve | Résultat | Ce que cela établit |
| --- | --- | --- |
| `node --test tests/security/adversarial-boundaries.test.mjs` | Réussi, 3/3 tests | Fuzz déterministe de 32 archives DOCX malformées sans écriture partielle; URL loopback comme donnée d'un webhook simulé sans requête réseau; chaîne de substitution shell traitée comme argument avec faux exécutable local. |
| `npm test` | Réussi : 529 tests passés, 2 ignorés, 0 échec (531 au total). | Suite locale Node complète, incluant des tests unitaires avec adaptateurs simulés. |
| `node --test tests/*.test.cjs` | Réussi : 156/156. | Tests CommonJS invoqués séparément par le workflow CI. |
| `git diff --check` | Réussi. | Aucun espace blanc/conflict marker détecté dans le diff vérifié. |
| Vérification des formats communs de secrets dans les fichiers modifiés | Aucun motif correspondant trouvé. | Contrôle limité à quelques formats connus; ce n'est pas un scanner exhaustif. |
| CI GitHub | Non vérifiée dans cette session. | Aucun résultat CI, SHA de run, revue GitHub ou protection de branche n'est revendiqué. |
| CodeQL | Non exécuté : outil/checker non exposé dans cet environnement. | Aucun résultat d'analyse statique CodeQL n'est revendiqué. |

Le test SSRF porte sur le simulateur API qui n'accepte aucune destination HTTP.
Il n'existe pas de fonction générale d'accès URL testée ici. Le test ne doit pas
être interprété comme une garantie contre SSRF dans une future fonction de fetch.

## Couverture préexistante à réutiliser

- `tests/auth.test.mjs:189-238,240-350` : sessions, CSRF/Origin, révocation,
  reset, limites de tentative et entrées hostiles.
- `tests/tenancy.test.mjs:242-318,520-560` : session et contexte tenant,
  contrôles RBAC horizontaux/verticaux et entrées hostiles.
- `tests/api.test.mjs:102-220,228-294` : hash/révocation des clés, autorisation,
  Origin, quotas, rejeu et webhooks simulés.
- `tests/private-storage.test.mjs:159-249,251-371` : noms/symlinks, uploads
  corrompus, quarantaine, quotas, annulation, suppression, rétention et
  corruption du stockage.
- `tests/rag-ingestion.test.mjs:204-274` : taille, pages, expansion DOCX,
  traversal et corruption; `tests/rag-lifecycle.test.mjs:360-410` : suppression
  de document et retrait de vecteurs/caches.
- `tests/llm-local.test.mjs:96-184,195-328` : modèle désactivé par défaut,
  intégrité, erreurs, délais, annulation, injections, citations et isolation.
- `tests/observability.test.mjs:63-162` : filtrage logs/diagnostics et erreurs
  bornées. `tests/intake-v2.test.mjs:123-140` teste quelques formats synthétiques
  de secrets, sans prétendre couvrir tous les secrets.
- `.github/workflows/ci.yml:9-44` déclare des permissions de lecture au workflow
  et au job de revue déterministe; cela ne prouve pas la configuration du dépôt
  GitHub en production.

Ces tests utilisent généralement des adaptateurs simulés et des données
synthétiques. Ils ne constituent pas une qualification PostgreSQL/RLS réelle,
une revue dynamique du binaire LLM ou une certification de production.

## Non réalisés et risques restants

- Pas d'instance PostgreSQL réelle, pas de test d'application générée complète,
  pas d'exercice multi-processus/multi-hôte, pas de moteur/modèle réel ni
  d'évaluation manuelle, pas de mesure mémoire/CPU.
- CodeQL n'était pas disponible dans l'environnement de cette session.
- Pas d'analyse exhaustive de toutes les valeurs de secrets dans l'historique,
  les variables GitHub, les artefacts ou les environnements.
- Issues/PR ouvertes, état des dépendances #17/#53 et runs GitHub non consultés
  depuis cette session faute d'outil GitHub disponible. Les écarts ne sont donc
  pas associés à de nouveaux numéros d'issues; vérifier et réutiliser les
  issues existantes avant d'en créer une.
- L'ingestion RAG v1 ne supprime pas ses versions; la suppression doit être
  coordonnée avec le module de cycle de vie et le stockage réellement branché.
- Il n'y a pas de contrôle SSRF générique parce qu'aucun client de fetch URL
  n'est présent dans le périmètre examiné. Toute future capacité réseau devra
  introduire une politique et des tests de refus des destinations locales.

## Commandes de reproductibilité

```sh
node --test tests/security/adversarial-boundaries.test.mjs
npm test
node --test tests/*.test.cjs
```
