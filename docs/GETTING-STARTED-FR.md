# Démarrage local — Français

## Prérequis et portée

Utilisez Node.js `>=22.12.0 <27` et un checkout indépendant de SaaSFactory. Aucun compte, secret, paiement, service hébergé ou modèle local n'est requis pour les commandes ci-dessous. Le générateur est local, déterministe et sans dépendance d'installation ; ses tests n'appellent aucun fournisseur. L'installation des dépendances open source de l'application générée peut nécessiter un accès réseau, mais les tests et l'application ne contactent aucun service distant.

Le projet généré est un point de départ de développement, non une application prête pour la production. Il reste séparé du dépôt Factory. Aucun dépôt GitHub, ressource cloud, fournisseur, DNS ou déploiement n'est créé ou activé.

## Parcours brief → manifeste → dry-run → application → tests

Depuis la racine du dépôt :

```sh
node --version
npm test
node intake.mjs --input examples/intake-v2.json > /tmp/atelier-plan.json
```

Le manifeste d'intake est un brief d'exemple révisable, pas un plan approuvé ni une mission autorisée. L'intake est en lecture seule : il ne crée ni application ni issue. Extraire uniquement sa configuration de génération validée :

```sh
node --input-type=module -e "import { readFile, writeFile } from 'node:fs/promises'; const plan = JSON.parse(await readFile('/tmp/atelier-plan.json', 'utf8')); await writeFile('/tmp/atelier-config.json', JSON.stringify(plan.generatorConfig, null, 2) + '\n');"
```

Prévisualiser la génération. Cette commande reste en `dry-run` et ne crée pas le chemin de sortie :

```sh
node generate.mjs --config /tmp/atelier-config.json --output-root /tmp/atelier-preview
test ! -e /tmp/atelier-preview
```

Relisez le manifeste, les maturités et les limitations acceptées. Pour écrire, choisissez une destination neuve et isolée, puis ajoutez explicitement `--write` :

```sh
node generate.mjs --config /tmp/atelier-config.json --output-root /tmp/atelier-output --write
cd /tmp/atelier-output/workshop-scheduler
```

La génération refuse les destinations existantes, les symlinks et les chemins non sûrs ; elle ne remplace jamais une sortie. Installez, si nécessaire, les dépendances open source de cette application, puis exécutez ses contrôles :

```sh
npm install --ignore-scripts --no-audit --no-fund
npm test
npm run typecheck
```

Le profil `examples/intake-v2.json` sélectionne des scaffolds et ne prouve pas une capacité métier. Au 2026-11-10, le build Next.js du profil v2 est bloqué par le typage de sa route API ; la CI le signale et ne le présente pas comme réussi. La CI construit le profil minimal v1, pas ce profil v2. Voir [état détaillé des tests](testing.md). Pour vérifier un build minimal, générez `examples/minimal.json` dans un autre dossier neuf, installez ses dépendances et lancez `npm run build`.

## Sauvegarde et restauration locales

Les services Factory ne sauvegardent pas automatiquement une application générée. Pour un exercice synthétique hors réseau et sans base PostgreSQL réelle :

```sh
node --test tests/operations/operations.test.mjs
```

Ce test utilise un dump et un exécuteur simulés ; il ne valide ni PostgreSQL réelle, ni restauration d'une application produite. Les procédures complètes, cohérence des fichiers persistants, base cible neuve, erreurs et limites sont dans le [plan de reprise après incident](operations/disaster-recovery.md) et le [contrat des opérations PostgreSQL locales](modules/database-operations.md). L'intégration PostgreSQL réelle est facultative et doit utiliser uniquement le conteneur local jetable documenté dans ce contrat, jamais une base distante.

## Limites avant tout usage réel

- Les profils générés et modules sont des scaffolds, exemples ou services locaux explicitement bornés. Voir chaque limitation dans `factory-manifest.json`.
- Les tests de module utilisent des fixtures synthétiques ou des exécutables simulés ; ils n'installent pas de modèle et n'attestent pas le comportement d'un moteur réel.
- Pas de qualification production, authentification hébergée, paiement réel, email distant, stockage distant, surveillance distante ou déploiement. La cible Cloudflare, si sélectionnée, n'est pas activée par la génération.
- Définissez séparément sécurité, isolation, rétention, objectifs RPO/RTO, licences, sauvegarde, restauration et exigences légales pour le projet indépendant. Ne placez aucune donnée client ni secret dans les rapports ou fixtures.
- Une CI verte ne remplace pas la revue humaine, une recette du projet généré, une validation des fournisseurs ni un déploiement explicitement autorisé.

Voir aussi le [catalogue des modèles locaux](LOCAL-MODEL-CATALOG.md), la [préparation de livraison](FACTORY-RELEASE-READINESS.md) et le [contrat du générateur](generator-contract.md).
