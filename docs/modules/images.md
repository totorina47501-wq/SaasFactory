# Images locales v1

`modules/images/index.mjs` expose `createImageService` (contrat v1,
module `1.0.0`). Le module traite les fichiers en mémoire avec des limites
explicites et délègue toute persistance, isolation tenant, déduplication,
suppression et rétention à une instance existante de
`modules/private-storage/index.mjs`. Il ne crée ni chemin de stockage, ni index,
ni moteur d’upload persistant supplémentaire.

## Initialisation

```js
import { createPrivateStorageService } from './modules/private-storage/index.mjs';
import { createImageService } from './modules/images/index.mjs';

const storage = await createPrivateStorageService({
  directory: '/var/lib/my-saas/private-storage',
  tenancy,
  audit,
});
const images = await createImageService({ storage });
```

Le service de stockage doit respecter le contrat v1 et accepter des objets PNG
au moins aussi grands que `maxOutputBytes`. Les opérations d’upload réutilisent
son flux d’écriture borné et sa validation finale. Toute erreur d’accès, de
quota, d’audit ou de stockage est propagée ; elle n’est pas transformée en
succès partiel.

## API

- `upload({cookieHeader, tenantId, requestId, fileName, contentType, stream, resize?, compressionLevel?, signal?})`
  authentifie d’abord le tenant avec le stockage, lit un flux binaire borné,
  valide/décode puis produit un PNG optimisé avant de le transmettre au stockage.
  `resize` est `{width, height}` ; l’image conserve son ratio, ne s’agrandit pas
  et tient dans ces dimensions. `compressionLevel` est un entier zlib de 0 à 9
  (défaut 6). Le retour comprend l’identifiant et les métadonnées du stockage,
  ainsi que largeur, hauteur et format.
- `get({cookieHeader, tenantId, requestId, objectId, signal?})` réutilise
  l’export privé, valide et décode l’objet ; le retour ajoute ses dimensions et
  un flux PNG.
- `list({cookieHeader, tenantId, requestId})`, `delete(...)` et
  `purgeExpired(...)` délèguent directement les métadonnées et le cycle de vie au
  stockage privé.
- `createThumbnail({cookieHeader, tenantId, requestId, objectId, width, height, compressionLevel?, signal?})`
  lit un objet accessible, génère un dérivé PNG borné et l’enregistre par le même
  service privé. Le retour conserve `sourceId`; aucune relation persistante
  supplémentaire n’est créée.
- `createCarousel({cookieHeader, tenantId, requestId, imageIds, activeIndex?, signal?})`
  valide 1 à 20 identifiants distincts du tenant courant et retourne les
  métadonnées, dimensions et indices précédent/suivant. Le carrousel est une
  projection en mémoire, pas une nouvelle base de données.

## Formats, métadonnées et limites

La v1 accepte uniquement des PNG statiques non entrelacés, 8 bits par canal,
couleur RGB ou RGBA. La signature et le CRC de chaque chunk sont vérifiés ; les
dimensions, le nombre de pixels et le volume décompressé sont bornés avant toute
allocation dépendant de l’image. Les filtres PNG standards 0 à 4 sont décodés.
Le redimensionnement utilise un rééchantillonnage bilinéaire et l’encodage produit
un PNG RGBA. Les signatures JPEG, WebP, GIF, SVG et tout autre format, les PNG
animés, les palettes, les profondeurs non prises en charge, les chunks
auxiliaires/inconnus et les contenus corrompus sont refusés ; la v1 ne convertit
pas de JPEG ou de SVG. Le MIME déclaré doit être exactement `image/png` et ne
remplace jamais la détection par signature.

La politique EXIF est explicite : aucune métadonnée EXIF n’est lue ou conservée.
Un chunk PNG `eXIf` est rejeté comme chunk non pris en charge ; la sortie ne
contient que `IHDR`, `IDAT` et `IEND`. Les autres métadonnées d’entrée ne sont pas
conservées non plus. Les dimensions sont recalculées depuis les pixels décodés,
et les empreintes privées restent dans le stockage.

Limites par défaut et plafonds configurables :

| Budget | Défaut | Maximum |
| --- | ---: | ---: |
| Flux entrant | 8 MiB | 20 MiB |
| Image de sortie | 8 MiB | 20 MiB |
| Pixels par image | 8 Mpx | 16 Mpx |
| Dimension maximale | 4096 px | 4096 px |
| Mémoire réservée par image active | 192 MiB | 1 GiB |
| Octets entrants simultanés réservés | 16 MiB | 128 MiB |
| Uploads simultanés | 2 | 8 |
| Éléments par carrousel | 20 | 50 |
| Durée d’upload | 60 s | 5 min |

Le budget mémoire réserve 24 octets par pixel maximal et par opération active
pour couvrir les buffers décodés, rééchantillonnés et encodés. Les limites
doivent satisfaire `maxWorkingBytes >= maxPixels * 24` et
`maxInFlightBytes >= maxInputBytes * maxConcurrentUploads`; les opérations qui
ne peuvent réserver leur budget échouent avec `IMAGE_BUSY`. La limite effective
de sortie peut être plus basse que `maxOutputBytes` si le stockage privé est
configuré plus strictement. Aucun téléchargement, service distant ou dépendance
native n’est utilisé.

Les erreurs `ImagesError` ont des codes stables : `INVALID_INPUT`,
`INVALID_CONFIGURATION`, `CONTENT_TYPE_MISMATCH`, `INVALID_IMAGE`,
`UNSUPPORTED_FORMAT`, `PIXEL_LIMIT`, `IMAGE_TOO_LARGE`, `IMAGE_BUSY`,
`IMAGE_TIMEOUT`, `INTERRUPTED`, `UPLOAD_FAILED`, `IMAGE_PROCESSING_FAILED` et
`IMAGE_NOT_FOUND`. Les erreurs du stockage sous-jacent conservent leurs codes
`PrivateStorageError`.

Tests offline : `node --test tests/images.test.mjs`. Aucun fichier utilisateur,
contenu de fixture, hash ou donnée d’image n’est écrit dans la documentation ;
les tests construisent leurs PNG synthétiques à l’exécution.
