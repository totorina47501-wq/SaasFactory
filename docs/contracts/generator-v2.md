# Générateur composable — contrat v2

**Version d'entrée :** `schemaVersion: 2` · **Registre :** `moduleRegistryVersion: 1` · **API :** `generateProject`, `generateProjectV2` et `migrateV1Config` dans `generate.mjs`.

La v2 ajoute une entrée et un rapport sans changer les validations, l'API v1 ni le manifeste produit pour `schemaVersion: 1`. Le CLI sélectionne le contrat à partir du `schemaVersion` ; une valeur inconnue n'est jamais ramenée à v1.

## Entrée

Objet JSON UTF-8 strict, clés sensibles à la casse, sans clé inconnue, manquante ou répétée :

```json
{
  "schemaVersion": 2,
  "productName": "Atelier Exemple",
  "projectSlug": "atelier-exemple",
  "domain": "atelier.example",
  "modules": [
    {"id": "ai-disabled", "version": "1.0.0"},
    {"id": "auth", "version": "1.0.0"}
  ],
  "acceptedLimitations": [
    {"id": "ai-disabled", "version": "1.0.0", "limitations": ["disabled-by-design"]},
    {"id": "auth", "version": "1.0.0", "limitations": ["injected-boundary-only"]}
  ],
  "prerequisites": [],
  "permissions": [],
  "offline": true,
  "languages": ["fr-FR"],
  "defaultLanguage": "fr-FR",
  "deploymentTarget": "none"
}
```

Les champs communs (`productName`, `projectSlug`, `domain`, `languages`, `defaultLanguage`, `deploymentTarget`) suivent les mêmes règles et limites que v1. `modules` est non vide, sans doublons, et contient des paires ID/version exactes inscrites au registre local ; `ai-disabled@1.0.0` est requis. `acceptedLimitations` doit correspondre exactement aux limitations des versions résolues, y compris les dépendances transitives ; les valeurs absentes, partielles, inconnues ou superflues sont refusées. `prerequisites` et `permissions` sont des listes explicites ; ils ne sont jamais accordés par le générateur. `offline` est un booléen requis et est contrôlé par le résolveur.

Les descripteurs du registre sont des métadonnées uniquement. Le manifeste v2 de sources approuvées associe chaque module et version à des chemins précis dans les modèles Factory ; `generatedFiles` n'autorise jamais une source supplémentaire. Seules les versions `1.0.0` et les sources actuellement présentes dans cette allowlist sont composables.

## Migration v1 → v2

La migration est une décision explicite et ne s'exécute pas implicitement lors d'une génération :

```js
import { migrateV1Config } from './generate.mjs';

const configV2 = migrateV1Config(configV1, {
  acceptedLimitations: [
    { id: 'ai-disabled', version: '1.0.0', limitations: ['disabled-by-design'] }
  ],
  prerequisites: [],
  permissions: [],
  offline: true
});
```

L'exemple suppose que `configV1.modules` ne contient que `ai-disabled`. Pour chaque autre module v1, fournir également son acceptation complète de limitation. Les quatre décisions de migration sont obligatoires. Les modules sans version exacte au registre, les limitations non reconnues et les objets non JSON sont refusés. La migration ne promeut aucune maturité.

## Sortie et rapport

Le manifeste retourné conserve le mode `dry-run` ou `write`, la destination, les versions et maturités des modules sélectionnés, leurs limitations, la liste triée des fichiers, les hashes SHA-256 triés, les exclusions et les contrôles exécutés. `factory-manifest.json` reprend les versions, limitations et hashes des fichiers rendus avant le rapport ; il exclut explicitement son propre hash et celui de `docs/installation-report.md` afin d'éviter une référence circulaire. Le rapport d'installation rappelle que les scaffolds ne sont pas des capacités de production.

Les fichiers communs, tests, configuration et documentation sont réutilisés depuis le rendu v1 validé. Les modules présents dans le registre v1 ne déclarent aucune migration de base de données ; la v2 ne crée donc ni migration vide ni migration implicite. Aucune commande, hook, script ou contenu exécutable fourni par un descripteur n'est lancé. Aucun appel réseau, fournisseur, dépôt Git ou déploiement n'est effectué.

## Effets, erreurs et sécurité

- Sans `--write`, la génération n'écrit rien. `--write` exige `--output-root` et un nouveau dossier `<projectSlug>` ; les destinations présentes, collisions de casse, liens symboliques, chemins absolus, séparateurs hostiles et segments parent sont refusés.
- Toute validation, résolution, composition, vérification de secrets et construction du rapport intervient avant la première écriture. Les fichiers proviennent seulement du rendu local v1 et sont hachés après composition. Les chemins déclarés sont vérifiés contre l'allowlist, sans import dynamique.
- Les fichiers rendus sont contrôlés contre les sentinelles d'exclusion v1 et les motifs locaux connus de secrets. L'analyse est une mesure défensive, pas une preuve de détection exhaustive.
- Le résolveur échoue fermé sur les modules ou versions inconnus, dépendances absentes/cycliques, incompatibilités, prérequis, permissions, limitations ou contraintes offline non satisfaits. Les erreurs de configuration n'incluent pas le contenu fourni comme secret.
- La répétition vers une destination déjà créée échoue sans écrasement. Une erreur de validation ne crée aucun répertoire ; un résultat partiel n'est jamais présenté comme succès.

## Validation offline

`node --test tests/generator-v2.test.mjs tests/generator.test.mjs` couvre les contrats v1/v2, la migration explicite, les hashes stables, les 32 combinaisons de modules/cibles avec smoke tests, les champs inconnus, limitations, versions, secrets, traversal, collisions de casse, symlinks, dry-run, écriture et refus d'écrasement. `npm test` inclut ces tests v2.
