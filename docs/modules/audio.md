# Audio local v1

`modules/audio/index.mjs` expose `createAudioService` (`contractVersion: 1`,
`moduleVersion: 1.0.0`) pour la validation locale d'audio, sa conversion en WAV
PCM mono 16 kHz, et les brouillons de transcription éditables avec exports SRT
et WebVTT. Il ne contient pas de moteur de reconnaissance vocale : le texte
vient d'une édition humaine ou d'un moteur local intégré explicitement par
l'application. Aucune opération ne démarre sans appel explicite.

## Initialisation et usage

Prérequis : Node.js 22.12+, `ffprobe` et `ffmpeg` installés localement. Le
répertoire parent doit exister. Chaque chemin d'exécutable est un seul nom ou
chemin d'exécutable ; aucun argument libre ni shell n'est accepté.

```js
import { createAudioService } from './modules/audio/index.mjs';

const audio = await createAudioService({
  directory: '/var/lib/my-saas/private-audio',
  tenancy,
  audit,
  videoService,
});

const item = await audio.ingest({
  cookieHeader,
  tenantId,
  requestId,
  consent: true,
  audio: boundedAudioBuffer,
});

const normalized = await audio.normalize({ cookieHeader, tenantId, requestId, audioId: item.id });
const bytes = await audio.readAudio({
  cookieHeader, tenantId, requestId, audioId: item.id, normalized: true,
});
```

`ingest` n'accepte qu'un `Buffer` ou un `Uint8Array` déjà borné en mémoire ; un
handler HTTP doit donc imposer ses limites avant de construire le buffer. Le
consentement explicite est requis. L'application doit aussi vérifier les droits
sur le fichier avant de le soumettre. Toute lecture, édition, validation,
exportation et suppression repasse par Tenancy et l'audit ; les intégrations
doivent réserver les méthodes d'édition et `validateTranscript` aux personnes
autorisées. Les erreurs d'autorisation ou d'audit arrêtent l'opération.

`ingestVideoAudio({…, consent, videoId})` réutilise `videoService.extractAudio`
et `videoService.readArtifact`, puis valide à nouveau le WAV extrait par FFprobe.
Il n'accepte pas un chemin de fichier ni des octets d'artefact fournis directement
par le client. `normalize({…, audioId, signal?})` produit une piste WAV PCM
mono à 16 kHz ; `readAudio({…, audioId, normalized?})` retourne le média original
ou le WAV normalisé. Les deux moteurs sont invoqués sans shell, avec protocoles
`file,pipe`, délais, annulation et budgets de sortie bornés. Les erreurs
publiques ne contiennent ni stderr ni contenu média.

## Formats, métadonnées et limites

Le format est déterminé par les octets et confirmé par le conteneur et le codec
retournés par FFprobe ; le nom de fichier et un MIME client ne sont jamais
utilisés. Allowlist v1 :

| Conteneur reconnu par signature | MIME calculé | Codecs audio |
| --- | --- | --- |
| WAV / RIFF | `audio/wav` | PCM s16le, s24le, s32le ou f32le |
| MP3, avec ID3 valide ou trame MPEG | `audio/mpeg` | MP3 |
| FLAC | `audio/flac` | FLAC |
| Ogg | `audio/ogg` | Vorbis ou Opus |
| M4A / ISO BMFF (`ftyp`) | `audio/mp4` | AAC |

Un conteneur, une piste, un codec, une durée, une fréquence ou un nombre de
canaux inattendu est refusé. FFprobe fournit la durée, le codec, la fréquence
d'échantillonnage, les canaux et le débit quand il est disponible.

Budgets configurables (valeur par défaut / plafond) :

| Limite | Défaut | Maximum |
| --- | ---: | ---: |
| Fichier entrant | 50 MiB | 100 MiB |
| Durée | 600 s | 3600 s |
| Sortie normalisée | 24 MiB | 64 MiB |
| Fichiers / octets par tenant | 100 / 512 MiB | 100 000 / 10 GiB |
| Fichiers / octets du stockage | 1000 / 5 GiB | 100 000 / 10 GiB |
| Jobs actifs | 2 | 8 |
| Délai FFprobe/FFmpeg | 120 s | 30 min |
| Rétention | 7 jours | 365 jours |
| TTL des temporaires | 1 h | 365 jours |

Les quotas comptent les sources, métadonnées et transcriptions enregistrées.
L'instance doit être unique pour un même répertoire dans un processus ; le
verrouillage des opérations est en mémoire et ne remplace pas un verrou disque
inter-processus. Aucun résultat n'est écrit hors du répertoire local. Une erreur
moteur, une annulation ou un dépassement ne publie pas de résultat incomplet.

## Transcription, validation et RAG

Le modèle de transcription est versionné (`contractVersion: 1`). Chaque segment
contient exactement `startSeconds`, `endSeconds` et `text`. Le service fournit
`createTranscript`, `editTranscript` avec `expectedVersion`, puis
`validateTranscript` avec la même vérification de version. Les segments doivent
être triés, non chevauchants, non vides, sans caractères de contrôle ou retours
à la ligne, compris dans la durée et limités à 1000 segments / 2000 caractères
par segment. Un conflit de version ou une donnée hors limites est refusé.
Modifier un transcript validé le remet en brouillon.

Les exports `exportSubtitles({…, transcriptId, format: 'srt' | 'vtt'})` ne sont
disponibles qu'après validation humaine ; le texte de cue échappe `&`, `<` et
`>`. L'export inclut les timestamps au milliseconde et n'accepte aucun format
arbitraire. `getRagDocument` est le seul adaptateur RAG fourni et refuse lui aussi
les brouillons ; l'appelant doit passer ce résultat au module RAG et ne jamais
indexer directement les segments retournés par l'édition.

Il n'y a pas de reconnaissance automatique, de téléchargement de modèle, de
service distant ou d'interface utilisateur dans ce module. Une application doit
construire une UI d'édition avec des contrôles d'accès adaptés. L'absence de
FFprobe/FFmpeg échoue explicitement (`ENGINE_UNAVAILABLE`) plutôt que de
retourner des métadonnées simulées.

## Erreurs, rétention et rollback

Codes stables : `INVALID_INPUT`, `INVALID_CONFIGURATION`, `INVALID_PATH`,
`UNSAFE_STORAGE`, `STORAGE_UNAVAILABLE`, `AUDIT_UNAVAILABLE`,
`TENANT_ACCESS_DENIED`, `INVALID_TENANT_CONTEXT`, `NOT_FOUND`,
`CONSENT_REQUIRED`, `INVALID_MEDIA`, `UNSUPPORTED_CONTAINER`,
`UNSUPPORTED_CODEC`, `DURATION_LIMIT`, `FILE_TOO_LARGE`, `OUTPUT_TOO_LARGE`,
`INVALID_ENGINE_OUTPUT`, `ENGINE_UNAVAILABLE`, `ENGINE_FAILED`,
`ENGINE_TIMEOUT`, `INTERRUPTED`, `JOB_LIMIT`, `QUOTA_EXCEEDED`,
`STORAGE_LIMIT`, `CORRUPT_STORAGE`, `ALREADY_NORMALIZED`,
`INVALID_VIDEO_ARTIFACT`, `VIDEO_UNAVAILABLE`, `INVALID_TRANSCRIPT`,
`TRANSCRIPT_NOT_VALIDATED`, `VERSION_CONFLICT` et `TIME_RANGE`.

`deleteAudio` supprime aussi les transcriptions liées ; `deleteTranscript`
supprime uniquement une transcription. `purgeExpired` doit être appelé
explicitement avec un contexte autorisé ; le service ne lance pas de rétention
en arrière-plan. Les répertoires sont privés (`0700`) et les fichiers créés
lisibles uniquement par le propriétaire (`0600`). Le module ne fournit pas de
chiffrement au repos, sauvegarde, antivirus, sandbox OS ni garantie d'effacement
physique.

```sh
node --test tests/audio.test.mjs
npm test
```

Les tests sont hors réseau, synthétisent les conteneurs et remplacent FFprobe et
FFmpeg par des exécutables locaux déterministes. Pour rollback, arrêter les
handlers qui déclenchent ce module et retirer son intégration dans une PR ; les
fichiers existants ne sont pas supprimés automatiquement.
