# Cycle de vie RAG v1

`modules/rag-lifecycle/index.mjs` orchestre les indexations initiales et
incrémentales, les réindexations, les rotations de modèle et les suppressions.
Son API est `ragLifecycleContract` (`contractVersion: 1`,
`moduleVersion: 1.0.0`). Elle réutilise Tenancy, le module Jobs, la sortie
Documents/Ingestion et un dépôt transactionnel fourni par l'application.
Elle ne contacte aucun service réseau et ne télécharge aucun modèle.

## Préconditions et intégration

```js
import { createRagLifecycleService } from './modules/rag-lifecycle/index.mjs';

const lifecycle = createRagLifecycleService({
  tenancy,
  store,                 // get(context, key), put(context, key, value, expectedVersion)
  jobs,                  // createJobsService(...) ; démarrage explicite
  repository,            // adaptateur transactionnel décrit ci-dessous
  loadDocument,          // relit un document déjà ingéré, sans le mettre dans le job
  authorize,             // retourne strictement true
  models: [localEmbedder],
});
```

Le stockage d'état utilise la clé tenant-scoped constante
`rag-lifecycle-v1/state` et le compare-and-swap `store.put`. Le module Jobs doit
utiliser Tenancy et une file locale durable séparée. Le payload du job ne contient
que l'identifiant d'opération ; texte, ACL, cookie, vecteur et secret ne sont pas
placés dans la file ni dans l'état de cycle de vie.

`loadDocument({tenantContext, documentId, version, signal})` retourne le document
déjà persisté par Ingestion ainsi que `metadata` et l'ACL courante. Identifiant,
source, version, SHA-256, chunks, offsets et provenance sont validés avant
traitement. Le corps du document reste en mémoire pendant les lots uniquement.
Les modèles doivent être explicitement installés et inscrits dans `models`.
Chaque descripteur déclare version, empreinte SHA-256, dimensions, licence,
runtime `local` ou `test` et CPU ; l'embedder doit retourner uniquement des
vecteurs locaux finis aux dimensions déclarées. Les poids de modèle ne sont pas
fournis.

Le dépôt (`repository`) est une précondition de sécurité, pas un callback
facultatif. Il implémente :

- `writeBatch({tenantContext, documentId, generationId, fencingToken,
  batchNumber, model, chunks})` : écrit un lot de staging atomiquement,
  idempotent par génération/numéro de lot, sans le rendre consultable ; refuse
  toute clôture obsolète.
- `activateGeneration({...})` : une transaction compare la clôture courante,
  bascule atomiquement vers la génération complète et enregistre source, modèle,
  ACL et provenance. Elle retire les générations et caches spécifiques au
  document devenus inutiles.
- `discardGeneration({...})` : retire le staging de cette génération sans
  supprimer une génération active ni une génération plus récente.
- `deleteDocument({tenantContext, documentId, fencingToken, operationId})` :
  une seule transaction établit le tombstone et révoque l'ACL, retire tous les
  chunks, vecteurs, générations en staging et caches propres au document.
  L'opération est idempotente et refuse une clôture périmée.
- `getStats({tenantContext})` : retourne exactement les entiers non négatifs
  `{documents, chunks, vectors, caches}`.

Le chercheur doit lire la même génération active et vérifier l'ACL depuis cette
même source de vérité. Les lecteurs concurrents et la suppression doivent être
linéarisés par le dépôt (transaction/snapshot ou revalidation avant restitution).
Un adaptateur qui écrit séparément l'index, les vecteurs, les caches et l'ACL ne
peut pas garantir une suppression atomique ni l'absence de résultats obsolètes.
Ce module ne prétend pas rendre transactionnel un adaptateur qui ne l'est pas.

## API et reprise

- `indexDocument(input)` planifie l'indexation initiale ou la mise à jour d'une
  nouvelle version/source. `modelId` est facultatif et sélectionne par défaut
  le premier modèle configuré.
- `reindexDocument(input)` planifie une nouvelle génération complète, notamment
  pour une version/empreinte/dimension de modèle différente. L'ancienne
  génération reste active jusqu'à la bascule atomique ; aucun mélange de
  vecteurs de modèles n'est permis.
- `deleteDocument({cookieHeader, tenantId, requestId, documentId,
  idempotencyKey})` enregistre une clôture supérieure, enfile le job, puis
  applique immédiatement le tombstone et la purge atomique. Le job persistant
  répète l'opération idempotente après redémarrage ou panne.
- `runOnce()` réclame au plus un job `rag.lifecycle`. Aucun job ne démarre à la
  création du service ou à l'enqueue ; un worker doit appeler explicitement
  `runOnce()` ou orchestrer les workers Jobs.
- `getOperation(...)` expose un résumé sans contenu, payload ni message
  technique. `stats(...)` agrège les compteurs du dépôt, opérations en attente,
  échecs et erreurs enregistrées.

Chaque opération a une clé d'idempotence unique par tenant. Un retry avec le
même contenu retourne le même job ; la réutilisation de la clé avec un contenu
différent échoue (`IDEMPOTENCY_CONFLICT`). Les lots sont identifiés de façon
stable ; après interruption, ils peuvent être rejoués sans doubler les vecteurs.
Un numéro de clôture croissant par document empêche un indexeur en retard de
réactiver un document supprimé ou remplacé. L'état conserve les identifiants,
versions, empreintes, état, compteurs et codes d'erreur, jamais le contenu.
L'historique est borné par `maxOperations` et n'est pas purgé silencieusement.
Une file Jobs ayant épuisé ses tentatives requiert une action opérateur explicite.

Erreurs stables : `INVALID_INPUT`, `INVALID_CONFIGURATION`,
`INVALID_TENANT_CONTEXT`, `TENANT_ACCESS_DENIED`, `ACCESS_DENIED`,
`UNKNOWN_MODEL`, `INVALID_SOURCE`, `INVALID_EMBEDDING`,
`EMBEDDING_UNAVAILABLE`, `SOURCE_UNAVAILABLE`, `JOB_QUEUE_UNAVAILABLE`,
`DELETE_PENDING`, `OPERATION_NOT_FOUND`, `IDEMPOTENCY_CONFLICT`,
`OPERATION_LIMIT`, `CORRUPT_STATE`, `STORAGE_UNAVAILABLE`, `STORAGE_BUSY`,
`INVALID_JOB_PAYLOAD`, `INDEX_UNAVAILABLE`, `CORRUPT_INDEX_STATS` et
`PROCESSING_FAILED`. L'erreur publique conserve un code, jamais un message du
document ou d'un fournisseur.

## Budgets, tests et rollback

| Budget | Défaut | Maximum |
| --- | ---: | ---: |
| Chunks par lot | 32 | 256 |
| Chunks par document | 5 000 | 100 000 |
| Opérations conservées par tenant | 10 000 | 100 000 |
| Reprises CAS d'état | 3 | 10 |
| Tentatives Jobs par opération | 3 | 10 |
| Modèles configurés | 1–16 | 16 |

`node --test tests/rag-lifecycle.test.mjs` s'exécute hors réseau avec des
adaptateurs en mémoire et Jobs local. Les scénarios couvrent le crash/retry au
milieu d'un lot, l'idempotence, suppression concurrente, tombstone/clôture,
rotation de modèle, compteurs, erreur assainie, conservation de provenance et
état persistant corrompu. Les adaptateurs de production doivent tester leurs
propres transactions et leur lecture concurrente ; les tests en mémoire ne
constituent pas une preuve de propriétés ACID d'une base externe.

Pour rollback, arrêter les workers, sauvegarder séparément le stockage lifecycle,
la file Jobs et le dépôt, puis restaurer ces sauvegardes cohérentes. Ne pas
supprimer ou éditer manuellement les états actifs. Après restauration, vérifier
les clôtures, générations et tombstones avant de reprendre les workers ; une
sauvegarde ancienne peut réintroduire des opérations à rejouer. Toute purge
opérateur reste explicite.
