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

## Diagnostic CI du 10 novembre 2026 (PR #130)

Le run Golden Path a généré un rapport **4 PASS / 0 FAIL / 0 INCOMPLETE** en environ 3 minutes, mais le processus CLI a continué à vivre jusqu'au timeout de 60 minutes. Les logs de nettoyage identifient des processus `next-server` orphelins. Le smoke HTTP ferme maintenant le groupe de processus POSIX de `npm run start`, y compris ses descendants, avec une fenêtre SIGTERM bornée et un repli SIGKILL. Un test local vérifie la libération du port après le smoke. Aucun contrôle de qualification n'est désactivé.

Preuve à revérifier sur le SHA de correction : `npm test`, la CI standard et le workflow Golden Path terminé en succès, avec artefact `golden-path-report`. Un rapport PASS sans conclusion CI success n'est pas une preuve suffisante.
