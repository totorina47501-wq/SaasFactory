# Golden Path Delivery Qualification

Cette documentation couvre la qualification P0 des produits générés via `delivery/golden-path.mjs`.

## Objectif

Prouver de manière automatisée, traçable et bornée :
- génération réelle de trois apps saisonnières (`promo-flash`, `cadeaux-zen`, `noel-memory`),
- tests/typecheck/build effectifs des apps générées,
- qualification Docker/Compose d'un SaaS minimal via le moteur existant,
- rapport d'évidence lisible (Markdown) + exploitable machine (JSON).

## Commandes

Depuis la racine du dépôt :

```sh
# Dry-run strict (aucune écriture ni installation)
node delivery/golden-path.mjs

# Qualification complète avec écriture dans une destination neuve
node delivery/golden-path.mjs \
  --write \
  --verify \
  --output-root /tmp/saas-factory-golden-path \
  --report-dir /tmp/saas-factory-golden-path-report
```

## Statuts du rapport

- `PASS` : preuve complète disponible dans le périmètre demandé.
- `FAIL` : échec effectif d'une étape obligatoire.
- `INCOMPLETE` : étape non prouvable dans l'environnement courant (ex: Docker indisponible), sans promotion artificielle en succès.

## Limites explicites

- Aucun déploiement réel, aucune publication registre/container, aucune API externe.
- `docker compose config` est validé localement sans `up`.
- Les interactions UX saisonnières sont vérifiées de manière ciblée (smoke runtime + assertions métier) sans dupliquer la matrice QA large de #53.

## Artefacts CI

Le workflow `.github/workflows/golden-path.yml` publie l'artefact `golden-path-report` contenant :
- `golden-path-report.json`
- `golden-path-report.md`

La rétention est bornée et le workflow reste en permissions lecture seule.
