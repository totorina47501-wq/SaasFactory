# Vidéo locale v1

`modules/video/index.mjs` expose un service local versionné
(`contractVersion: 1`, `moduleVersion: 1.0.0`) pour inspecter une vidéo, créer
une frame ou une miniature PNG et extraire sa piste audio en WAV PCM. Le module
ne s'active pas au démarrage : chaque traitement est déclenché par un appel
explicite. Il ne contacte aucun service distant.

## Initialisation et usage

Prérequis d'exécution : Node.js 22.12+ et FFmpeg avec `ffprobe` et `ffmpeg`
installés localement. Les options `ffprobePath` et `ffmpegPath` désignent
uniquement l'exécutable ; elles ne permettent pas de transmettre des arguments
supplémentaires.

```js
import { createVideoService } from './modules/video/index.mjs';

const video = await createVideoService({
  directory: '/var/lib/my-saas/private-video',
  tenancy,
  audit,
});

const inspected = await video.ingest({
  cookieHeader,
  tenantId,
  requestId,
  consent: true,
  video: boundedVideoBuffer,
});

const thumbnail = await video.thumbnail({
  cookieHeader,
  tenantId,
  requestId,
  videoId: inspected.id,
  atSeconds: 2,
  width: 320,
});
const result = await video.readArtifact({
  cookieHeader,
  tenantId,
  requestId,
  artifactId: thumbnail.id,
});
```

`ingest` n'accepte qu'un `Buffer` ou `Uint8Array` déjà borné en mémoire. Le
module ne reçoit ni chemin de fichier ni commande client. Une intégration HTTP
doit imposer ses propres limites de réception avant de construire ce buffer.
`consent: true` est obligatoire pour l'ingestion et l'audit doit réussir avant
le traitement. Les appels suivants réautorisent le tenant avec
`tenancy.resolveTenantContext`; le contexte doit annoncer le même tenant, la
même requête et `contractVersion: 1`. Un identifiant d'un autre tenant se
comporte comme inexistant.

Les autres méthodes sont `frame({…, videoId, atSeconds, signal?})`,
`extractAudio({…, videoId, signal?})`, `readArtifact({…, artifactId})` et
`purgeExpired({cookieHeader, tenantId, requestId})`. `thumbnail` accepte aussi
`width` (16–1024 pixels, valeur par défaut 320). `frame` et `thumbnail`
renvoient un identifiant d'artefact, son type MIME, sa taille, son SHA-256 et
son expiration ; `readArtifact` revalide l'autorisation, la taille et le hash
avant de retourner les octets. Les chemins locaux ne sont jamais retournés.

## Validation et moteur

`ffprobe` est lancé réellement, sans shell, avec une sélection limitée des
champs et une sortie JSON plafonnée à 16 KiB. Le service dérive le MIME du
conteneur inspecté ; il ne fait pas confiance à un MIME fourni par le client.
L'allowlist v1 accepte les conteneurs MP4/MOV, Matroska et WebM, et les codecs
vidéo H.264, HEVC, VP9, AV1 et MPEG-4. Les pistes audio acceptées sont AAC, MP3,
Opus, Vorbis, AC-3, E-AC-3, FLAC et PCM s16le ; zéro ou une piste audio est
autorisée.

Une durée ou résolution hors limites, un format non reconnu, une piste
inattendue ou un codec interdit est refusé avant tout traitement FFmpeg. Les
commandes FFmpeg sont composées exclusivement par le module : frame à une
position donnée, miniature redimensionnée, ou extraction mono PCM 16 kHz. Les
protocoles sont limités à `file,pipe`, les traitements vidéo utilisent un
thread et les arguments client ne sont jamais propagés. Les sorties sont lues
depuis stdout avec un budget strict ; stderr est ignoré et n'est pas renvoyé au
client.

Le service ne décode rien lors de sa création. Les appels vidéo occupent un
budget de jobs en mémoire, limité par instance et par tenant. Ce n'est pas une
file persistante ; pour une exécution différée, l'appelant doit déclencher ce
service depuis son worker local après validation de son propre payload. Un
répertoire de stockage ne doit être utilisé que par une seule instance du
service dans un processus.

## Stockage, quotas et erreurs

Le parent du répertoire doit exister. Le module crée son répertoire racine et
les sous-répertoires nécessaires avec le mode `0700`, refuse les liens
symboliques et stocke les sources, métadonnées et artefacts avec le mode
`0600`. Les sources et sorties sont isolées par ID de tenant serveur. Le hash
de source reste privé et est vérifié avant chaque traitement ; le hash d'un
artefact est vérifié avant lecture. Le SHA-256 ne permet pas de déduplication
entre tenants.

Limites par défaut et plafonds configurables :

| Limite | Défaut | Maximum |
| --- | ---: | ---: |
| Entrée vidéo | 50 MiB | 100 MiB |
| Durée | 600 s | 3600 s |
| Largeur / hauteur | 3840 × 2160 | 8192 × 8192 |
| Jobs actifs (global / tenant) | 2 | 8 |
| Sortie d'un job | 24 MiB | 64 MiB |
| Fichiers par tenant / total | 100 / 1000 | 100 000 |
| Stockage par tenant / total | 512 MiB / 5 GiB | 10 GiB |
| Timeout FFprobe/FFmpeg | 120 s | 30 min |
| Rétention source/artefacts | 7 jours | 365 jours |
| Temporaires incomplets | 1 h | 365 jours |

Les quotas de fichiers et octets comptent les sources et artefacts conservés ;
les réservations en mémoire couvrent les opérations concurrentes de la même
instance. Le budget de sortie borne également la mémoire consommée par un job.
Un dépassement, un échec d'audit ou d'autorisation, un média invalide, une erreur
moteur, une annulation ou un timeout échoue sans publier d'artefact. Les
fichiers temporaires créés par l'appel sont supprimés dans un bloc `finally`.
Une interruption du processus peut laisser des temporaires privés, nettoyés
uniquement par l'appel explicite à `purgeExpired`.

Codes stables de `VideoModuleError` : `INVALID_INPUT`, `INVALID_CONFIGURATION`,
`INVALID_PATH`, `UNSAFE_STORAGE`, `STORAGE_UNAVAILABLE`, `AUDIT_UNAVAILABLE`,
`TENANT_ACCESS_DENIED`, `INVALID_TENANT_CONTEXT`, `NOT_FOUND`,
`CONSENT_REQUIRED`, `INVALID_MEDIA`, `UNSUPPORTED_CONTAINER`,
`UNSUPPORTED_CODEC`, `DURATION_LIMIT`, `RESOLUTION_LIMIT`, `FILE_TOO_LARGE`,
`QUOTA_EXCEEDED`, `STORAGE_LIMIT`, `JOB_LIMIT`, `TIME_RANGE`,
`ENGINE_UNAVAILABLE`, `ENGINE_FAILED`, `ENGINE_TIMEOUT`, `OUTPUT_TOO_LARGE`,
`INVALID_ENGINE_OUTPUT`, `AUDIO_UNAVAILABLE`, `INTERRUPTED` et
`CORRUPT_STORAGE`. Les messages, sorties stderr et données média ne sont pas
propagés comme erreurs publiques.

`purgeExpired` exige l'autorisation et un audit pour le tenant visé. Il supprime
ses seules sources et sorties expirées, puis les fichiers temporaires privés
dont le TTL est dépassé. La création du service et les opérations normales ne
déclenchent pas de rétention automatique.

## Tests et rollback

`node --test tests/video.test.mjs` et `npm test` sont hors réseau et ne
nécessitent pas les exécutables FFmpeg : les tests génèrent localement un petit
conteneur synthétique et utilisent de faux exécutables pour vérifier les
arguments, limites, erreurs, délais et sorties du protocole enfant. Cela ne
remplace pas une validation d'intégration avec les versions FFmpeg installées
sur l'hôte d'exploitation.

Pour désactiver le module, arrêter les appels/handlers qui le déclenchent puis
retirer son intégration dans une PR. Les sources et artefacts existants restent
sur disque jusqu'à leur purge explicite ou une suppression opérateur validée ;
ne pas effacer automatiquement les données lors du rollback. Ce module ne
fournit ni sandbox OS, ni quota CPU/RAM système, ni chiffrement au repos,
réplication, antivirus, sauvegarde ou mécanisme de suppression physique.
