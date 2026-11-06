# Module Registry — contrat v1

**Statut :** schéma d'interface et frontière de validation, pas un registre/résolveur opérationnel. **Version de descripteur :** `contractVersion: 1`.

## `ModuleDescriptor`

Le validateur natif sans dépendances `factory/contracts/index.mjs` exporte `validateModuleDescriptor(unknown)`. Il refuse toute propriété inconnue, tout objet non simple, toute donnée non JSON, toute version inconnue et toute valeur hors limites. À succès, il retourne une copie structurée profondément gelée ; il n'exécute, n'importe, ne fusionne et ne conserve pas le descripteur source.

Tous les champs suivants sont requis, sauf `verification`, qui est requis pour `maturity: "verified"` :

| Champ | Format v1 |
| --- | --- |
| `contractVersion` | Entier exact `1`. |
| `id` | Identifiant stable `^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$`, max. 64 caractères. |
| `version` | Version `MAJOR.MINOR.PATCH` conforme à SemVer, suffixe préversion et métadonnées de build facultatifs, max. 64 caractères. |
| `description` | Texte non vide, max. 240 caractères. |
| `category` | `identity`, `storage`, `jobs`, `audit`, `entitlements`, `ai`, `media`, `api` ou `other`. |
| `maturity` | `reference`, `scaffold`, `implemented` ou `verified`. Un statut ne prétend pas à une capacité métier non livrée. |
| `prerequisites` | 0–32 identifiants lisibles, uniques. Conditions documentaires/préconditions. |
| `dependencies`, `incompatibilities` | 0–32 identifiants chacun, uniques, syntaxe d'ID ; le module ne peut se référencer lui-même. La résolution et la détection des cycles sont un lot séparé. |
| `configuration` | Schéma fermé `{schemaVersion: 1, type: "object", additionalProperties: false, required: string[], properties: object}`. Max. 64 propriétés ; types `string`, `boolean`, `number`, `integer`, `enum`; enum de 1–32 options. `minLength`/`maxLength` sont entiers pour `string` ; `minimum`/`maximum` sont numériques pour `number` ou entiers pour `integer`. Aucun `$ref`, évaluateur, motif regex ou champ extensible. |
| `permissions` | 0–32 chaînes uniques `namespace:action`, chacune max. 64 caractères. Une déclaration ne confère pas d'autorisation. |
| `generatedFiles` | 0–128 chemins relatifs uniques, max. 200 caractères, sans chemin absolu, séparateur Windows, point/parent, composant caché ou préfixe lecteur. Chemins informatifs : l'écriture exige une table de correspondance de sources maintenue côté Factory. |
| `tests` | 0–64 chemins relatifs sûrs et uniques, mêmes règles de chemin. |
| `hardware` | Objet fermé avec `cpuCores` (0–256), `memoryMiB` et `diskMiB` (0–1 048 576), nombres entiers sûrs. |
| `security` | Objet fermé `{dataClassification: "public" \| "tenant" \| "sensitive", handlesSecrets: boolean, permissionsReviewed: boolean}`. |
| `offline` | Objet fermé `{supported: boolean, networkRequired: boolean}` ; `supported: true` impose `networkRequired: false`. |
| `update`, `rollback` | Instructions descriptives non vides, max. 500 caractères chacune ; jamais exécutées. |
| `verification` | Liste 0–16 d'objets fermés `{kind: "test" \| "review" \| "ci" \| "measurement", reference: string, version: string, scope: "implementation" \| "isolation" \| "generation" \| "migration" \| "security" \| "hardware"}`. `version` doit correspondre exactement au descripteur. Une maturité `verified` exige au moins une preuve explicite non vide, liée à une portée ; les références restent à vérifier, pas une attestation automatique. |

Les limites de configuration optionnelles sont des nombres finis entre 0 et 1 000 000 ; minimum ne dépasse pas maximum, et minLength ne dépasse pas maxLength. Les clés `__proto__`, `prototype` et `constructor`, contrôles, chaînes avec espaces périphériques et formats courants de secrets reconnaissables sont rejetés sans être recopiés dans l'erreur. Ce filtre heuristique n'est pas un scanner exhaustif. Les tableaux ne contiennent pas de doublons.

### Exemple neutre

```json
{
  "contractVersion": 1,
  "id": "local-search",
  "version": "1.0.0",
  "description": "Recherche locale de référence",
  "category": "other",
  "maturity": "reference",
  "prerequisites": [],
  "dependencies": [],
  "incompatibilities": [],
  "configuration": {
    "schemaVersion": 1,
    "type": "object",
    "additionalProperties": false,
    "required": [],
    "properties": {}
  },
  "permissions": [],
  "generatedFiles": [],
  "tests": [],
  "hardware": {},
  "security": {
    "dataClassification": "public",
    "handlesSecrets": false,
    "permissionsReviewed": true
  },
  "offline": {
    "supported": true,
    "networkRequired": false
  },
  "update": "Revoir le contrat avant toute mise à jour.",
  "rollback": "Retirer la sélection avant génération."
}
```

## Maturité et résolution différée

- `reference` : documentation ou exemple, non générable.
- `scaffold` : squelette explicitement incomplet, non présenté comme fonctionnel.
- `implemented` : code livré avec tests du module, mais pas de preuve de vérification finale.
- `verified` : implémentation et preuve explicite dans `verification`, avec portée connue. La CI seule ne démontre ni intégration réelle ni disponibilité d'un fournisseur.

Ce contrat ne choisit pas les modules, ne calcule pas l'ordre, ne satisfait pas les dépendances, ne détecte pas les collisions entre descripteurs et ne génère pas les fichiers. Le futur registre doit résoudre ces points en fail-closed ; la valeur des métadonnées du manifeste ne peut autoriser des fichiers ou permissions non présents dans un catalogue de confiance.

## Erreurs et compatibilité

`ContractError` expose `code` : `UNKNOWN_FIELD`, `INVALID_VERSION` ou `INVALID_INPUT`. Une version future ne se rabat pas sur v1. Les changements incompatibles doivent incrémenter explicitement la version du contrat et inclure une migration ; aucun champ inconnu n'est ignoré.
