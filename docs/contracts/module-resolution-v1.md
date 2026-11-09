# Registre et résolution des modules — contrat v1

**Version :** `moduleRegistryVersion: 1` · **API :** `contractVersion: 1` des `ModuleDescriptor`.  
Ce contrat choisit et ordonne des métadonnées locales. Il n'exécute pas de module, n'écrit aucun fichier et n'active aucun fournisseur.

## Catalogue et disponibilité

`docs/catalog/saas-capabilities-v1.json` conserve `capabilities` comme inventaire historique de références. Ces identifiants sont des demandes de conception, pas des modules sélectionnables ; leurs statuts `scaffold`, `missing` ou `proposed` ne créent aucune disponibilité.

Le champ séparé `modules` est l'unique allowlist opérationnelle v1. Chaque entrée a exactement :

```json
{
  "descriptor": {"contractVersion": 1},
  "limitations": [
    {"id": "example-only", "description": "Limitation documentée"}
  ]
}
```

Le descripteur complet respecte [Module Registry v1](module-registry-v1.md). Les limitations ont des identifiants stables, font partie du contrat versionné et sont obligatoires pour toute maturité différente de `verified`. Un module `reference` ne peut pas être publié dans l'allowlist opérationnelle. La v1 publie une seule version exacte par ID ; la version SemVer demandée doit correspondre. Les dépendances désignent cet ID unique et sont résolues transitivement. Aucun intervalle ni version implicite n'est interprété.

Les modules actuellement inscrits (`ai-disabled`, `api`, `auth`, `billing-test`, `media`) sont tous `scaffold`. Ils exigent chacun l'acceptation explicite de leur limitation ; ce statut ne les promeut pas à `implemented` ou `verified`. En particulier, les références historiques `auth-rbac`, `subscriptions` et `private-media-storage` ne sont pas sélectionnables par ces identifiants.

Les chemins `generatedFiles` et `tests` sont informatifs. Ils ne constituent pas une autorisation d'écriture ou un manifeste de sources : la génération reste soumise au manifeste de confiance du générateur.

## API locale

`factory/module-registry.mjs` exporte `createModuleRegistry(catalog)`, `moduleRegistry` et `ModuleRegistryError`. Le registre valide une copie de données JSON fermée, puis expose une liste immuable de descripteurs et limitations. Les clés inconnues, valeurs non JSON, accesseurs, cycles de données, descripteurs invalides, IDs/version en double et maturité `reference` sont refusés.

`factory/module-resolver.mjs` exporte `resolveModules(registry, selection)`. L'objet de sélection exige exactement les propriétés suivantes :

```json
{
  "modules": [{"id": "auth", "version": "1.0.0"}],
  "acceptedLimitations": [
    {"id": "auth", "version": "1.0.0", "limitations": ["injected-boundary-only"]}
  ],
  "prerequisites": [],
  "permissions": [],
  "offline": true
}
```

- `modules` est une liste non vide d'IDs uniques avec version exacte. Tous les modules ajoutés transitivement doivent aussi avoir leurs limitations acceptées.
- `acceptedLimitations` doit nommer chaque limitation déclarée de chaque module résolu, avec l'ID et la version exacts. Une acceptation partielle, inconnue ou superflue échoue. Une maturité non `verified` sans acceptation échoue ; aucune maturité n'est modifiée.
- `prerequisites` fournit les prérequis effectivement satisfaits par l'appelant. Tout prérequis de module absent bloque la résolution.
- `permissions` représente les permissions explicitement accordées par l'appelant. Les permissions déclarées des modules ne confèrent aucun droit ; une permission requise manquante bloque la résolution.
- `offline` est obligatoire. En mode `true`, un module qui ne supporte pas l'offline ou requiert le réseau bloque la résolution. Le résultat agrège les états hors-ligne ; en mode `false`, ces métadonnées restent visibles sans prétendre qu'un test réseau a eu lieu.

## Résolution, sorties et erreurs

Les racines et dépendances sont parcourues par ID dans un ordre lexical stable ; la sortie est un ordre topologique déterministe, dépendances avant dépendants. Les cycles, dépendances absentes, incompatibilités, versions inconnues, prérequis manquants, permissions non accordées, état offline incompatible, limitations non acceptées et toute entrée inconnue font échouer toute la résolution. Aucun résultat partiel n'est retourné.

Le succès retourne `{registryVersion, modules, permissions, limitations, offline}`. Les descripteurs, tableaux et structures de sortie sont immuables. Les erreurs sont des `ModuleRegistryError` avec un `code` stable (`INVALID_INPUT`, `INVALID_CATALOG`, `INVALID_MODULE_DESCRIPTOR`, `DUPLICATE_MODULE`, `INVALID_REGISTRY`, `INVALID_SELECTION`, `MODULE_NOT_FOUND`, `UNSUPPORTED_VERSION`, `MISSING_DEPENDENCY`, `DEPENDENCY_CYCLE`, `INCOMPATIBLE_MODULES`, `MISSING_PREREQUISITE`, `PERMISSION_DENIED`, `LIMITATION_NOT_ACCEPTED`, `OFFLINE_UNSUPPORTED`). Le message ne recopie aucune valeur fournie par l'appelant.

## Sécurité, effets et rollback

Le registre est local, déterministe et sans accès réseau, chargement dynamique, exécution de commande, effet de bord ou lecture de secret. Les descripteurs proviennent uniquement du catalogue Factory versionné et sont validés par `validateModuleDescriptor`. Une entrée n'autorise ni source, ni import, ni fichier au-delà du manifeste de génération de confiance. Les erreurs ferment la résolution sans divulguer la configuration.

Le lot ne modifie pas `generate.mjs` et n'active aucune capacité du générateur. Son rollback consiste à retirer l'allowlist `modules` et les deux API ; l'inventaire historique `capabilities` demeure séparé. Toute modification incompatible de sélection ou de diagnostic exige une nouvelle version du contrat et une migration explicite.

## Vérification

Tests ciblés : `node --test tests/module-registry.test.mjs tests/module-resolver.test.mjs`. Ils couvrent l'isolation du catalogue historique, les descripteurs malveillants, la sélection stable, les versions, dépendances transitives, cycles, incompatibilités, prérequis, permissions, limitations et états offline.
