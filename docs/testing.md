# Stratégie de test

## Suite Factory

`npm test` délègue la découverte à `node --test` sans filtre de chemin. Node découvre ainsi les suites `.test.mjs` et `.test.cjs`, y compris les tests ajoutés sous `tests/generated-app/`. Les tests des modules Factory couvrent les services hors ligne avec des données synthétiques ; ils ne signifient pas que chaque service est déjà inclus dans l'application générée.

## Profils générés

La CI valide deux profils depuis des destinations temporaires neuves :

- `examples/minimal.json` : génération v1 minimale ;
- `examples/saas-starter-v2.json` : profil v2 complet des modules actuellement générables.

Pour chacun, elle installe les dépendances open source et exécute les tests générés et le typecheck. Le profil minimal passe aussi le build Next.js et le smoke Playwright sur son serveur local. Les dépendances d'installation sont le seul accès réseau prévu. Les tests et le serveur applicatif n'appellent aucun fournisseur, service tiers, paiement ou modèle externe.

Pour exécuter manuellement les vérifications du profil minimal depuis la racine :

```sh
repo_root=$PWD
node generate.mjs --config examples/minimal.json --output-root /tmp/saas-factory-qa --write
cd /tmp/saas-factory-qa/atelier-exemple
npm install --ignore-scripts --no-audit --no-fund
npm test
npm run typecheck
NEXT_TELEMETRY_DISABLED=1 npm run build
cd "$repo_root"
npm install --ignore-scripts --no-audit --no-fund --package-lock=false
npx playwright install chromium
FACTORY_APP_DIR=/tmp/saas-factory-qa/atelier-exemple npm run test:acceptance
```

Le config Playwright refuse un chemin applicatif qui n'est pas un build sous `RUNNER_TEMP` ou le répertoire temporaire système. Il démarre uniquement ce build sur `127.0.0.1`; le scénario vérifie le rendu sémantique sans appel tiers.

## Limites fonctionnelles explicites

Les modules du profil v2 sont des scaffolds avec les limitations décrites dans `factory-manifest.json` : l'authentification est une frontière injectée, la facturation est simulée et le média est une fixture locale synthétique. Le profil ne génère pas d'interface de signup/login/reset/RBAC/organisation, de flux RAG ou de quotas. Ne pas présenter les tests des services Factory (`tests/auth.test.mjs`, `tests/tenancy.test.mjs`, `tests/billing-simulated.test.mjs`, `tests/rag-*.test.mjs`, `tests/entitlements.test.mjs`) comme des parcours navigateur de l'application générée.

La suite navigateur est donc un contrôle smoke/accessibilité sémantique minimal du build actuel, pas une recette de ces parcours absents. Aucune session authentifiée n'est injectée ou réutilisée. Les intégrations futures devront ajouter ces parcours lorsqu'elles seront réellement générées et maintenir les limites hors ligne. La matrice ne prétend pas valider une cible Cloudflare, une migration/restauration de base générée, un déploiement, ni un produit prêt pour la production.

Le build du profil v2 est actuellement bloqué : `next build` échoue lors de la génération des types de route pour `app/api/example/route.js` (« Could not find a declaration file »). La CI conserve les tests générés et le typecheck v2 mais ne masque pas cette erreur en ignorant les erreurs TypeScript ; son build restera hors matrice jusqu'à une correction approuvée du générateur/API, qui n'est pas dans le périmètre de fichiers QA.

## Couverture

Le workflow manuel `factory-quality-integrations.yml` exécute toute la suite Factory sous la couverture native de Node et conserve un rapport LCOV comme artefact pendant 14 jours. Il n'envoie le rapport vers Codecov qu'après activation explicite de `CODECOV_ENABLED`; l'upload externe n'est pas requis pour les tests. Les workflows de PR gardent `contents: read`, aucun secret fournisseur, et des délais d'exécution bornés.
