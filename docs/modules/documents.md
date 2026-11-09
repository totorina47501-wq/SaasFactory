# Documents locaux v1

`modules/documents/index.mjs` expose `createDocumentsService` et le contrat
`documentsContract` (contrat v1, module `1.0.0`). Le module exporte des PDF
neutres générés directement, peut reconnaître le texte d'une image PNG privée
avec un moteur local explicitement installé, et transmet le résultat validé au
module d'ingestion RAG existant. Il n'ouvre aucun chemin fourni par l'appelant,
ne rend pas de HTML et ne fait aucun accès réseau.

## Initialisation

Le service réutilise `images.get` pour lire une image au moyen de son stockage
privé tenant-scoped et `ragIngestion.ingest` pour conserver le texte OCR. Ces
adaptateurs doivent être les services locaux existants ; les deux vérifient de
nouveau le contexte du tenant.

```js
import {
  createDocumentsService,
  createLocalOcrEngine,
} from './modules/documents/index.mjs';

const documents = createDocumentsService({
  images,
  ragIngestion,
  ocrEngine: createLocalOcrEngine({ languages: ['fra', 'eng'] }),
});

const pdf = documents.exportPdf({
  title: 'Rapport',
  paragraphs: ['Texte neutre à exporter.'],
});
```

Sans `ocrEngine`, l'OCR est désactivé et `recognizeImage` / `ingestImageText`
échouent avec `OCR_UNAVAILABLE`. L'export PDF reste disponible. Le module
Storage v1 accepte uniquement les PNG : le PDF est donc rendu dans un `Buffer`
et renvoyé comme `application/pdf`; aucune persistance PDF ni extension
silencieuse du contrat de stockage n'est effectuée.

## API et formats

- `exportPdf({title, paragraphs, template?})` accepte uniquement du texte brut
  encodé en Latin-1/WinAnsi, au plus 500 paragraphes. `template`, s'il est
  fourni, doit être `neutral-text-v1`. Le résultat contient `data`,
  `contentType`, `fileName`, `pageCount` et la version de contrat. Les chaînes
  sont encodées comme texte PDF ; les URL restent du texte sans action de lien.
  Les balises HTML ne sont jamais interprétées. Aucun moteur HTML, moteur PDF
  externe, police téléchargée, annotation ou lien externe n'est utilisé.
- `recognizeImage({cookieHeader, tenantId, requestId, imageId})` lit uniquement
  une image PNG déjà accessible via `images.get`; aucun chemin ou flux fourni
  directement par l'appelant n'est accepté. La sortie contient le texte
  normalisé et sa provenance : identifiant et SHA-256 de l'objet source, format,
  moteur OCR et modèles déclarés.
- `ingestImageText(...)` reconnaît l'image, puis appelle le service RAG avec
  UTF-8 `txt`, un `sourceId` égal à l'identifiant de l'image et le nom de fichier
  `<imageId>.ocr.txt`. Il renvoie ensemble le document RAG et la provenance OCR.
  Les erreurs d'ingestion ne sont pas transformées en réussite.
- `createLocalOcrEngine({languages, timeoutMs?, maxInputBytes?,
  maxOutputBytes?})` utilise l'exécutable local `tesseract` sans shell, via
  stdin/stdout. Les codes langue doivent être explicitement déclarés parmi
  `deu`, `eng`, `fra`, `ita`, `nld`, `por` et `spa`; le module n'installe ni ne
  télécharge l'exécutable ou les données de langue.

`createLocalOcrEngine` utilise Tesseract (Apache-2.0) s'il est installé. Les
fichiers de données linguistiques sont fournis séparément par l'opérateur et
peuvent avoir leurs propres licences ; vérifier leur origine et licence avant
installation. Un moteur stub injecté dans les tests est explicitement déclaré
`test-stub` et ne constitue pas un moteur OCR réel.

## Budgets et erreurs

| Budget | Défaut | Maximum configurable |
| --- | ---: | ---: |
| Texte PDF | 500 000 unités de code | 2 000 000 |
| Pages PDF | 40 | 200 |
| PDF exporté | 10 MiB | 50 MiB |
| Image OCR | 10 MiB | 20 MiB |
| Pixels OCR | 8 Mpx | 16 Mpx |
| Mémoire de travail OCR estimée | 256 MiB | 1 GiB |
| Texte OCR | 2 MiB | 10 MiB |
| Durée OCR | 30 s | 5 min |

L'admission OCR plafonne les dimensions/pixels et réserve une estimation de
32 octets par pixel avant de lancer le moteur. Le délai tue le processus
Tesseract en dépassement et les flux d'entrée/sortie sont bornés. Cette
estimation est une limite applicative, pas une limite mémoire imposée par le
noyau : utiliser les limites de ressources du système d'exploitation pour
contenir un moteur installé dans un environnement partagé.

Les erreurs publiques utilisent des codes stables : `INVALID_INPUT`,
`INVALID_CONFIGURATION`, `UNSUPPORTED_TEMPLATE`, `PDF_UNSUPPORTED_TEXT`,
`PDF_TEXT_LIMIT`, `PDF_PAGE_LIMIT`, `PDF_TOO_LARGE`, `OCR_UNAVAILABLE`,
`OCR_ENGINE_UNAVAILABLE`, `OCR_FAILED`, `OCR_TIMEOUT`, `OCR_INPUT_LIMIT`,
`OCR_OUTPUT_LIMIT`, `OCR_MEMORY_LIMIT`, `OCR_INVALID_OUTPUT`, `DOCUMENT_NOT_FOUND`
et `INVALID_IMAGE`. Les erreurs du module RAG conservent leurs codes. Aucun
texte de document ni sortie de moteur n'est inclus dans les messages d'erreur.

## Tests, rollback et limites

```sh
node --test tests/documents.test.mjs
npm test
```

Les tests génèrent un PDF synthétique en mémoire et utilisent un stub OCR marqué
distinct du moteur Tesseract. Ils ne nécessitent ni modèle, ni binaire OCR, ni
service distant. Le module ne transforme pas les documents PDF en image et ne
fait pas l'OCR de PDF : il réutilise les PNG produits/servis par le module Images
et l'ingestion textuelle RAG. Pour un rollback, désactiver l'injection du moteur
OCR et retirer les appels au module ; les documents déjà transmis au RAG suivent
la politique de conservation/suppression de l'ingestion et du stockage existants.
