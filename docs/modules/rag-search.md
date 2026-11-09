# Recherche RAG locale v1

`modules/rag-search/index.mjs` ajoute un index durable de chunks, des vecteurs
locaux et une recherche lexicale, vectorielle ou hybride. Le contrat exposé est
`ragSearchContract` (`contractVersion: 1`, `moduleVersion: 1.0.0`). Le module ne
lit aucun chemin, n'ouvre aucun socket, ne télécharge aucun poids et n'appelle
aucune API externe. L'index est un document JSON écrit via le stockage local
tenant-scoped, et non un service vectoriel distant.

## Initialisation et prérequis

`tenancy.resolveTenantContext` doit authentifier la session et vérifier son
appartenance au tenant. `store.get(context, key)` retourne
`{value, version} | undefined` et `store.put(context, key, value,
expectedVersion?)` applique atomiquement le compare-and-swap et retourne une
version positive ; un conflit porte `error.code === "CONFLICT"`. Le stockage
doit être local, durable et isolé par `TenantContext`. Le module refuse un
contexte invalide, les conflits répétés et toute panne de stockage.

Un adaptateur d'embeddings injecté implémente uniquement `embedBatch(texts)` et
déclare exactement :

```js
{
  contractVersion: 1,
  modelId: 'org/model-name',
  modelVersion: '1.2.3',
  dimensions: 384,
  fingerprint: '<sha256 du bundle local exact>',
  license: 'Apache-2.0',
  runtime: 'local',
  embedBatch: async texts => vectors
}
```

Le runtime doit charger un modèle déjà installé sur la machine. L'adaptateur
doit vérifier la version et l'empreinte du bundle avant de servir, rester sur
CPU si c'est la cible choisie, et ne jamais effectuer de téléchargement ou
d'appel réseau. Le module valide la forme, les dimensions et les valeurs des
vecteurs, puis les normalise L2. Un changement de modèle, version, empreinte ou
dimension refuse l'index existant (`EMBEDDING_MODEL_MISMATCH`) au lieu de
mélanger des espaces vectoriels.

```js
import { createRagSearchService } from './modules/rag-search/index.mjs';

const ragSearch = createRagSearchService({
  tenancy,
  store,
  embedder: localEmbedder,
  authorizeDocument: async ({ tenantContext, cookieHeader, document, operation }) =>
    localAcl.authorize({ tenantContext, cookieHeader, document, operation }),
});

await ragSearch.indexDocument({
  cookieHeader,
  tenantId,
  requestId,
  document: await ragIngestion.ingest(ingestionInput),
  metadata: { category: 'guide' },
  acl: { readerIds: [userId], roles: [] },
});

const answerSources = await ragSearch.search({
  cookieHeader,
  tenantId,
  requestId,
  query: 'contrôle des accès',
  filters: { category: 'guide' },
  topK: 5,
  mode: 'hybrid',
});
```

Le contrat d'ingestion est accepté directement ; ses chunks conservent
identifiant, version, empreinte, source, fichier, page et offsets. L'index est
remplacé pour un même identifiant uniquement par une version strictement plus
récente. Réindexer la même version/empreinte est idempotent ; une version
ancienne ou un conflit de version échoue. La suppression/rétention est hors de
ce module et reste au contrat RAG Lifecycle.

## Sécurité, ACL et restitution

Chaque écriture et chaque recherche résout le contexte auprès de Tenancy avant
de lire ou modifier l'index. Le store reçoit uniquement ce contexte vérifié et
une clé constante `rag-search-v1/index`. Le `tenantId` du payload ne constitue
pas une autorisation.

Chaque document possède une ACL obligatoire fermée :
`{readerIds: UUID[], roles: string[]}`. Les deux listes sont uniques et au
moins une entrée doit exister. `authorizeDocument` est obligatoire, reçoit
l'ACL du document, le contexte authentifié, l'opération (`index` ou `search`)
et retourne strictement `true` pour autoriser. Une exception, un refus ou une
valeur indéterminée bloque l'opération. En recherche, l'autorisation est
vérifiée avant le filtrage, le ranking et la restitution ; le texte d'un
document refusé n'est jamais inclus dans la réponse. Le module ne décide pas
comment l'application résout l'identité utilisateur ou les rôles : le callback
doit faire cette vérification sans faire confiance à des identifiants fournis
par le client. Ne pas journaliser les cookies, contenus, vecteurs ou réponses
du callback.

Les filtres sont des égalités exactes sur des métadonnées scalaires déclarées à
l'indexation. Une citation restitue uniquement la provenance du chunk retenu :
identifiants du document/source, version, fichier, format, SHA-256, chunk, page,
offsets, métadonnées et score. Une recherche sans résultat au-dessus du seuil
retourne `results: []` ; le module ne fabrique pas de réponse ni de citation.

## API et ranking

- `indexDocument({cookieHeader, tenantId, requestId, document, metadata, acl})`
  valide le document d'ingestion, autorise l'indexation, calcule les embeddings
  par lots, puis écrit l'index avec CAS.
- `search({cookieHeader, tenantId, requestId, query, filters?, topK?, mode?,
  minScore?})` retourne `{contractVersion: 1, results}`.
- `mode` est `hybrid` (défaut), `lexical` ou `vector`. Le ranking lexical
  utilise un TF/IDF borné de type BM25. Le mode hybride combine à poids égaux le
  score lexical normalisé et la similarité cosinus positive. Le mode vectoriel
  classe par similarité cosinus. Les scores et seuils aident à ordonner des
  candidats ; ils ne sont pas une mesure de vérité métier.
- `topK` vaut 1–100, défaut 5 ; `minScore` est dans `[0, 1]`, défaut 0.12.
- Les erreurs sont des `RagSearchError` à code stable : `INVALID_INPUT`,
  `INVALID_CONFIGURATION`, `INVALID_TENANT_CONTEXT`,
  `TENANT_ACCESS_DENIED`, `DOCUMENT_ACCESS_DENIED`, `INVALID_DOCUMENT`,
  `EMBEDDING_UNAVAILABLE`, `INVALID_EMBEDDING`,
  `EMBEDDING_MODEL_MISMATCH`, `DOCUMENT_VERSION_CONFLICT`,
  `STALE_DOCUMENT_VERSION`, `DOCUMENT_LIMIT_EXCEEDED`, `STORAGE_LIMIT`,
  `CORRUPT_INDEX`, `STORAGE_UNAVAILABLE` et `STORAGE_BUSY`. Les erreurs ne
  recopient pas le contenu documentaire.

Budgets par défaut configurables dans leurs bornes :

| Budget | Valeur |
| --- | ---: |
| Textes par lot d'embeddings | 32 |
| Cache LRU par service | 2 048 textes par tenant/modèle |
| Chunks par document | 5 000 |
| Documents indexés par tenant | 1 000 |
| Métadonnées par document ou filtre | 32 |
| Requête | 4 000 code units |
| Index sérialisé par tenant | 32 MiB |
| Reprises CAS | 3 |

Un service conserve son cache d'embeddings en mémoire ; un redémarrage ne perd
pas l'index durable, mais vide ce cache. Le stockage est à fournir par
l'application locale et doit appliquer ses propres quotas disque et sauvegardes.

## Modèles locaux optionnels

Le module ne fournit pas de poids ni de runtime de modèle. Pour une intégration
explicite, `sentence-transformers/all-MiniLM-L6-v2` est un exemple de modèle
compact de 384 dimensions, publié sous Apache-2.0 selon sa fiche modèle, avec
environ 91 MB de poids. Le CPU est possible ; prévoir au minimum 1 GiB de RAM
pour modèle, runtime et marge, à confirmer par mesure sur le matériel cible.
Ces tailles et budgets sont des estimations, pas des garanties de latence ou de
qualité. Le responsable du déploiement doit épingler une révision immuable,
vérifier le SHA-256 du bundle et la licence effectivement distribuée, puis
installer explicitement le bundle et un runtime local compatible. Aucun
téléchargement n'est effectué par Factory, ce module ou ses tests.

L'export `createDeterministicTestEmbedder()` est un moteur de test synthétique
par hachage de tokens. Il est explicitement `runtime: 'test'`, limité à des IDs
`test/...`, non sémantique et interdit comme qualité de recherche réelle. Il ne
remplace pas un modèle entraîné et ne doit pas être fourni dans une application
utilisateur.

## Tests et rollback

Les tests utilisent un petit corpus synthétique, un moteur déterministe et
aucun poids téléchargé. Ils vérifient le ranking mesuré sur ce corpus, filtres,
ACL, isolation tenant, cache/batch, vecteurs invalides, dimensions incompatibles,
index corrompu et absence de source pertinente. Cela ne qualifie pas un modèle
sémantique ni un corpus de production.

```sh
node --test tests/rag-search.test.mjs
npm test
```

Pour rollback, arrêter les écritures, sauvegarder si nécessaire le store local,
retirer l'intégration et appliquer une procédure opérateur à la clé
`rag-search-v1/index`. Aucune suppression de données ou réindexation inverse
n'est lancée automatiquement.
