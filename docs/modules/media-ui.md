# Interface média locale v1

`modules/media-ui/index.mjs` expose des adaptateurs sans framework UI, des
fragments HTML accessibles et une forme d’onde locale bornée. Il orchestre les
services v1 déjà présents ; il ne possède ni stockage, ni ACL, ni moteur média,
ni routes HTTP. Il n’effectue aucune requête réseau.

## Initialisation et responsabilités

```js
import { createMediaUiService } from './modules/media-ui/index.mjs';

const mediaUi = createMediaUiService({
  audio: audioService,
  video: videoService,
  images: imageService,
  jobs: jobsService,
  limits: { maxUploadBytes: 50 * 1024 * 1024 },
});
```

`audio` et `video` sont les instances des modules existants
`modules/audio/index.mjs` et `modules/video/index.mjs`. `images` et `jobs` sont
facultatifs. Le module vérifie les méthodes nécessaires à son intégration mais
laisse chaque opération à son service d’origine : ces services revérifient
l’identité du tenant et l’audit sur chaque lecture ou mutation. Les erreurs
ACL/audit sont propagées, jamais remplacées par un succès UI. Aucun chemin
fourni par l’interface n’est utilisé directement par ces adaptateurs.

## Upload et lecteurs

- `upload({cookieHeader, tenantId, requestId, mediaType, consent, data, signal?})`
  n’accepte que `audio` ou `video`, `consent: true` et un `Buffer` ou
  `Uint8Array` binaire. Les octets sont bornés avant délégation (50 MiB par
  défaut, jusqu’à 100 MiB). L’instance audio/vidéo effectue sa propre validation
  de format, limites, consentement, audit et stockage privé. Un handler HTTP doit
  aussi borner le corps avant de le mettre en mémoire.
- `renderMediaPlayer({mediaType, src, title, captionsSrc?, captionsLanguage?,
  captionsLabel?})` produit un lecteur HTML natif avec contrôles clavier et
  préchargement des seules métadonnées. Les URL de média et de captions doivent
  être des chemins locaux de même origine ; les URL externes sont refusées. La
  route d’application qui sert le média ou le VTT doit appliquer la même ACL
  privée et ne servir qu’une transcription validée.
- En l’absence de captions, le lecteur signale explicitement leur indisponibilité.
  Une piste fournie utilise `kind="captions"` et sa langue/son libellé déclarés.
  Le module ne transforme pas un brouillon en fichier de captions.
- `createWaveform(wav, {maxInputBytes?, maxBars?})` n’accepte que du WAV PCM
  mono 16 kHz / 16 bits, normalement retourné par `audio.readAudio` avec
  `normalized: true`. Le buffer est limité à 24 MiB et la sortie à 128 barres
  maximum. `renderWaveform(bars)` produit un SVG décoratif caché des lecteurs
  d’écran ; les commandes audio natives restent le moyen d’écoute et de
  navigation.

## Transcriptions, images et jobs

- `createTranscript`, `editTranscript`, `validateTranscript`, `exportSubtitles`,
  `getRagDocument`, `deleteTranscript` et `deleteAudio` délèguent leurs appels
  avec le contexte d’autorisation au service audio. Les révisions optimistes
  (`expectedVersion`), règles de segment, validation humaine et exports SRT/VTT
  restent définis par ce service. `getRagDocument` conserve la provenance audio
  et ne retourne que la version validée.
- `renderTranscriptEditor` affiche des champs étiquetés pour les temps et le
  texte, une version attendue, des boutons distincts pour sauvegarder le brouillon
  ou le valider, et une région d’état. L’application doit parser le formulaire,
  appliquer sa protection CSRF et appeler les méthodes correspondantes ; la
  validation du module audio reste obligatoire.
- `carousel` réutilise `images.createCarousel`, qui vérifie l’accès tenant aux
  objets privés. `renderImageCarousel` affiche une image alternative et des
  contrôles précédent/suivant au clavier. L’application associe les métadonnées
  autorisées à des URL locales et vérifie l’ACL sur ses routes POST et image.
- `jobStatus`, `jobProgress` et `cancelJob` utilisent les méthodes tenant-scoped
  de Jobs. L’historique est filtré par identifiant de tâche et limité aux 50
  événements les plus récents ; il n’inclut aucun payload. `renderJobProgress`
  expose l’état dans une région live et les échecs dans une alerte.

Avant `deleteAudio`, le client qui possède l’élément média appelle
`stopMediaPlayback(element)` : pause, retrait des sources audio/track et
rechargement libèrent la lecture locale avant suppression. Le module vidéo
actuel ne publie pas d’API de suppression immédiate de source ; cette UI ne
simule donc pas la suppression vidéo. Les sources vidéo restent gérées par la
rétention explicite du service vidéo, jusqu’à évolution de son contrat.

## Contrat, erreurs et rollback

Contrat `contractVersion: 1`, `moduleVersion: 1.0.0`. L’API accepte uniquement
les champs documentés ; champs inconnus, mauvais contexte, données invalides,
URL externes et formats/caps inconnus échouent sans mode dégradé. Erreurs UI
propres : `INVALID_CONFIGURATION`, `INVALID_INPUT`, `CONSENT_REQUIRED`,
`FILE_TOO_LARGE`, `INTERRUPTED`, `INVALID_AUDIO`, `FEATURE_UNAVAILABLE` et
`INVALID_JOB`. Les erreurs du stockage, de Tenancy, d’audit, du moteur audio/vidéo
et des jobs conservent leurs codes du module source. Aucun message moteur,
contenu de média ou payload de job n’est ajouté au rendu.

Tests hors réseau : `node --test tests/media-ui.test.mjs` et `npm test`.
Pour rollback, retirer les adaptateurs et fragments UI de l’application ; ne
pas effacer automatiquement les médias. La suppression des médias reste une
opération explicite du service autorisé et sa rétention reste celle du module
source.
