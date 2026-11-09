# Factory Runtime local — contrat v1

**Statut :** normatif pour les interfaces communes. **Version :** `contractVersion: 1`. Ce contrat définit des frontières, pas des services déjà déployés ou une capacité métier implémentée.

## Architecture et source de vérité

- **Factory Core** valide les entrées, les descripteurs et les chemins ; sélectionne des fichiers de modèle approuvés ; puis produit un manifeste déterministe. Il n'exécute aucun contenu fourni par un descripteur.
- **Un module** déclare ses métadonnées et ses interfaces. Ses fichiers d'implémentation proviennent d'un catalogue de sources revues, jamais du manifeste.
- **Le projet généré** est un projet neuf, autonome, avec son propre dépôt/configuration et ses propres dépendances. Il ne dépend pas du dépôt Factory au runtime et ne reçoit ni secrets, données ni historique de ce dépôt.
- **Le runtime local** regroupe les services locaux qu'un projet généré choisit explicitement. Les contrats ci-dessous n'installent, ne démarrent et ne configurent aucun fournisseur. Réseau, stockage distant, paiement et modèle distant sont désactivés par défaut.

Le générateur existant reste régi par son propre contrat v1 : `schemaVersion: 1`, `dry-run` par défaut, écriture seulement avec `--write` dans une destination neuve. Ce contrat de runtime ne change pas cette interface.

## Interfaces communes

Les signatures TypeScript sont publiées dans [`factory/contracts/index.d.ts`](../../factory/contracts/index.d.ts). Les méthodes asynchrones retournent une `Promise`; une opération échoue par rejet, jamais par résultat partiel silencieux. Les erreurs d'entrée du validateur sont des `ContractError` (`UNKNOWN_FIELD`, `INVALID_VERSION`, `INVALID_INPUT`). Les implémentations de services peuvent ajouter des codes documentés : `TENANT_CONTEXT_REQUIRED`, `TENANT_MISMATCH`, `NOT_FOUND`, `CONFLICT`, `LIMIT_EXCEEDED`, `UNAVAILABLE`, `UNSUPPORTED`. Aucun appel ne doit transformer un refus ou une indisponibilité en autorisation.

| Interface | Entrées et sorties communes | Garanties et erreurs |
| --- | --- | --- |
| `TenantContext` | Objet exact `{ contractVersion: 1, tenantId, requestId }`; `assertTenantContext(unknown)` retourne un contexte vérifié immuable. | Contexte absent, nul, incomplet, versionné autrement ou avec champ inconnu : refus avant accès. Pas de contexte système implicite. |
| `LocalStorage` | `get(context, key) → {value, version} \| undefined`; `put(context, key, JSON, expectedVersion?) → version`; `delete(context, key, expectedVersion?) → boolean`. | Toutes les opérations exigent un contexte ; clé et version optimiste sont locales au tenant. Ne pas exposer une requête sans filtre tenant. Pas de sérialisation d'objet exécutable. |
| `JobQueue` | `enqueue(context, job) → jobId`; `claim(context, workerId, leaseMs) → job \| undefined`; `complete(context, jobId, result?)`; `fail(context, jobId, failure)`. | Chaque job est étiqueté tenant et tenant-séparé à l'enqueue, claim et finalisation. `maxAttempts` et `leaseMs` sont bornés par l'implémentation ; aucun retry infini. ID inconnu ou tenant incorrect : refus. |
| `AuditSink` | `append(context, event) → {eventId, recordedAt}`. | Ajout seulement, tenant et requête associés, aucune mutation/suppression via cette interface. Ne jamais journaliser secrets ou contenu complet d'un modèle. |
| `EntitlementProvider` | `check(context, featureId) → {allowed, reason?, limits?}`. | Décision locale explicite ; absence, erreur ou fonctionnalité inconnue équivaut à refus. Les limites sont numériques finies et ne constituent pas une autorisation d'effet distant. |
| `LocalModelAdapter` | `generate(context, {input, maxOutputTokens}) → {output, inputTokens, outputTokens, modelId}`. | Adaptateur local uniquement, budgets bornés par l'implémentation, entrée/sortie tenant-séparées. Modèle manquant ou budget dépassé : erreur ; aucun téléchargement ni appel réseau implicite. |

`ModuleDescriptor` et `TenantContext` sont les seules structures validées à l'exécution par la présente version. Les autres interfaces sont des contrats de types et d'architecture, sans implémentation de stockage, queue, audit, entitlements ou modèle dans ce lot.

## Règles d'isolation communes

1. Une opération de données, job, audit, entitlements ou modèle reçoit `TenantContext` comme premier argument ; elle refuse un contexte absent avant tout effet de bord.
2. Le tenant est pris du contexte authentifié établi par l'appelant, jamais d'un payload, d'une clé ou d'un argument de manifeste. Chaque lecture, mutation, claim et finalisation est cloisonnée avec cette valeur.
3. Les identifiants de ressource sont aussi vérifiés sous le même tenant ; un identifiant valide d'un autre tenant ne révèle pas son existence.
4. Les retours d'erreur et journaux ne divulguent pas les charges utiles, secrets, jetons ou données d'un autre tenant.
5. Aucun contrat n'autorise l'exécution de commandes, scripts, callbacks, plugins chargés par chemin, migrations distantes ou code provenant d'une entrée utilisateur.

## Compatibilité et rollback

`contractVersion` et `configuration.schemaVersion` sont des entiers exacts. Champ inconnu ou version non prise en charge : rejet fail-closed. Un changement incompatible exige une nouvelle version majeure de ce contrat, une note de migration et une compatibilité explicite ; ne pas interpréter une valeur inconnue comme un défaut.

Le lot est sans état persistant et n'altère pas le générateur. Son rollback consiste à retirer `factory/contracts/` et les contrats v1 associés ; aucun service externe, fichier généré ou migration n'est activé par ce contrat.

## Tests d'acceptation

`node --test tests/runtime-contracts.test.mjs` exerce les descripteurs valides, clés inconnues, versions, bornes, chemins non fiables, preuves de maturité, contextes tenant absents/invalides et gel de copie. Les interfaces de services sont contractuelles et leurs fournisseurs restent hors périmètre de ces tests.
