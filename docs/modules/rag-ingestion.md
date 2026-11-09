# Ingestion documentaire RAG locale v1

`modules/rag-ingestion/index.mjs` extrait localement du texte, le normalise,
calcule son SHA-256, le découpe de façon déterministe et stocke ses versions
avec leurs chunks. Le contrat `ragIngestionContract` est versionné
`contractVersion: 1`, `moduleVersion: 1.0.0`. Le module ne calcule pas
d'embeddings, ne fait pas de recherche, n'appelle aucun LLM et ne transcrit pas
de média. Il n'est pas ajouté automatiquement aux applications générées.

## Initialisation et prérequis

Le service requiert le module Tenancy et un `LocalStorage` local tenant-scoped
respectant `get(context, key) → {value, version} | undefined` et
`put(context, key, JSON, expectedVersion?) → version`. `put` doit comparer
atomiquement `expectedVersion`, incrémenter une version entière positive et
signaler un conflit avec `error.code === "CONFLICT"`. Chaque opération de
stockage doit faire respecter le `TenantContext`; le backend ne doit pas être
réseau ou distant. L'ingestion refuse un conflit après le nombre borné de
reprises ou toute panne de stockage. Le contexte est toujours résolu par
`tenancy.resolveTenantContext`; un `tenantId` du payload seul n'autorise jamais
l'accès.

```js
import { createRagIngestionService } from './modules/rag-ingestion/index.mjs';

const ragIngestion = createRagIngestionService({
  tenancy,
  store,
});

const document = await ragIngestion.ingest({
  cookieHeader,
  tenantId,
  requestId,
  sourceId: 'handbook',
  fileName: 'handbook.pdf',
  format: 'pdf',
  data: pdfBytes,
});
```

Le service ne lit aucun chemin fourni par l'appelant, n'écrit pas le fichier
source et ne réalise aucune requête réseau. Il persiste l'index JSON et le texte
extrait/chunké sous la clé fixe `rag-ingestion-v1/index`, à travers le backend
tenant-scoped fourni. Le backend doit appliquer ses propres permissions de
fichiers et limites disque. Ne jamais utiliser un store qui ignore le contexte,
une identité tenant fournie par le client, ou une adresse de stockage distante.

## Entrée, sortie et comportement

`ingest(input)` accepte exactement les champs suivants :

| Champ | Règles |
| --- | --- |
| `cookieHeader` | Chaîne d'au plus 8 KiB transmise au module Tenancy. |
| `tenantId` | UUID de tenant, ensuite autorisé par Tenancy. |
| `requestId` | 1–128 caractères ASCII sûrs pour la corrélation. |
| `sourceId` | Identifiant stable de source ASCII, 1–128 caractères ; pas un chemin ni une donnée personnelle. |
| `fileName` | Métadonnée d'affichage de 1–255 caractères ; les séparateurs et contrôles sont refusés. |
| `format` | Valeur exacte `txt`, `markdown`, `html`, `pdf` ou `docx`. |
| `data` | `Buffer` ou `Uint8Array`; le contenu est reconnu par le format choisi, jamais par un MIME déclaré. |

Les propriétés inconnues, accesseurs, objets d'entrée non simples, autres
formats, données vides et textes UTF-8 invalides échouent sans écriture.

La sortie contient `id` (UUID serveur), `sourceId`, `fileName`, `format`,
`version`, `sha256` des octets sources, `pageCount`, `createdAt`, le texte
normalisé, les chunks et `deduplicated`. Chaque chunk contient son index,
`sourceId`, `fileName`, page (`null` pour TXT/Markdown/HTML), offsets de début et
de fin, SHA-256 du document et texte. Les offsets sont des unités de code UTF-16
dans le texte normalisé concaténé avec un saut de ligne entre pages. Un chunk
ne traverse pas une limite de page. Le découpage utilise une taille fixe en
points de code et le chevauchement configuré.

La normalisation applique NFC, fins de ligne LF, retrait des contrôles et des
espaces de fin de ligne, réduction de longues séries de lignes vides et trim
final. Les chunks, leur contenu et leurs offsets sont déterministes pour des
octets, limites et version de module identiques.

Une empreinte identique pour le même `sourceId` dans le même tenant retourne la
version précédente avec `deduplicated: true` sans nouvel écrit. Un contenu
modifié pour cette source reçoit une version monotone suivante. L'isolement
multi-tenant dépend du `TenantContext` et du contrat appliqué par le store ; la
déduplication ne compare jamais des tenants différents ni des sources
différentes. Les identifiants de document sont opaques et générés par le
serveur.

## Formats, limites et refus

Limites par défaut (configurables uniquement dans leurs bornes validées par le
module) :

| Budget | Valeur par défaut |
| --- | ---: |
| Octets source | 10 MiB |
| Octets décompressés totaux | 32 MiB |
| Ratio maximal d'expansion archive/flux PDF | 100:1 |
| Pages PDF/DOCX | 100 |
| Entrées DOCX ZIP | 128 |
| Texte extrait | 2 Mi code units |
| Taille chunk / chevauchement | 1 000 / 150 points de code |
| Chunks par document | 5 000 |
| Documents conservés par tenant | 1 000 |
| Index sérialisé par tenant | 32 MiB |
| Reprises CAS d'écriture | 3 |

- TXT et Markdown : décodage UTF-8 strict ; le Markdown reste du texte brut, il
  n'est ni rendu ni exécuté.
- HTML : extraction de texte uniquement. Les scripts, styles, contenus intégrés
  et balises sont écartés ; les entités usuelles sont décodées. Le résultat
  n'est pas du HTML assaini à réafficher comme balisage.
- DOCX : lecture en mémoire des entrées ZIP `store` et `deflate`, contrôle
  central/local, CRC, chemins, fichiers actifs, nombre d'entrées, taille et
  expansion. Aucun fichier ZIP n'est extrait sur disque. Le texte vient de
  `word/document.xml`; DTD/entités externes, macros, liens, objets embarqués,
  méthodes ZIP non prises en charge et XML malformé ne sont pas interprétés.
  Les sauts de page Word présents dans le XML sont des indications de page,
  pas une pagination garantie par un moteur de rendu.
- PDF : extraction des opérateurs textuels `Tj` et `TJ` de pages classiques,
  avec flux sans filtre ou FlateDecode et longueur directe. PDF chiffrés,
  Object Streams, longueurs indirectes, filtres non pris en charge, OCR,
  encodages de polices propriétaires et structure malformée ne sont pas
  interprétés comme s'ils étaient du texte fiable.
- Audio, vidéo, images seules, OCR, transcription et documents chiffrés ne sont
  pas pris en charge. Aucun moteur ou modèle n'est téléchargé.

Les erreurs publiques exposent un code stable sans recopier le contenu :
`INVALID_INPUT`, `INVALID_CONFIGURATION`, `INVALID_TENANT_CONTEXT`,
`TENANT_ACCESS_DENIED`, `UNSUPPORTED_FORMAT`, `UNSUPPORTED_DOCUMENT_FEATURE`,
`INVALID_ENCODING`, `INVALID_DOCUMENT`, `EMPTY_DOCUMENT`, `FILE_TOO_LARGE`,
`TEXT_TOO_LARGE`, `PAGE_LIMIT_EXCEEDED`, `EXPANSION_LIMIT_EXCEEDED`,
`CHUNK_LIMIT_EXCEEDED`, `DOCUMENT_LIMIT_EXCEEDED`, `STORAGE_LIMIT`,
`CORRUPT_INDEX`, `STORAGE_UNAVAILABLE` et `STORAGE_BUSY`.

Le module ne journalise pas le contenu ni les empreintes. L'application doit
protéger les documents sensibles selon sa politique locale et ne pas envoyer
leurs contenus ou erreurs dans des logs ou services externes.

## Dépendances, tests et rollback

Le module n'ajoute aucune dépendance tierce. Il s'appuie uniquement sur les API
intégrées à Node.js (`node:crypto`, `node:zlib`, `TextDecoder`); aucun code
externe n'est embarqué. Aucun service ou réseau n'est requis pour les tests.
La licence applicable aux API intégrées est celle de la distribution Node.js
installée ; le module ne copie pas de bibliothèque tierce.

```sh
node --test tests/rag-ingestion.test.mjs
npm test
```

L'index conserve le texte et tous les chunks des versions antérieures jusqu'à
la limite configurée. Cette v1 ne fournit pas de suppression, rétention ou
restauration automatique. Pour un rollback, arrêter les écritures, sauvegarder
le store local si nécessaire, retirer l'intégration et appliquer une procédure
opérateur explicite à la clé `rag-ingestion-v1/index`. Ne pas supprimer
automatiquement les documents ou versions.
