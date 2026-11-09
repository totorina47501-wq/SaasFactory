# Transcription et synthèse vocales locales v1

`modules/local-speech/index.mjs` expose des adaptateurs opt-in pour ASR avec
`whisper.cpp` et TTS avec Piper (`contractVersion: 1`, `moduleVersion: 1.0.0`).
Ils exécutent des moteurs CPU locaux hors ligne, vérifient l'empreinte du modèle
à chaque opération, utilisent des arguments fixes sans shell et limitent entrée,
sortie, durée et temps de calcul. Le module n'installe ni moteur ni modèle et ne
télécharge aucun poids. Sans modèle configuré, l'application démarre normalement.

## Installation explicite

L'installation des exécutables et des poids est une action d'exploitation
manuelle, hors démarrage de l'application et hors test. N'installez que des
versions et modèles dont les licences conviennent au produit. Versions de
référence documentées :

| Moteur | Version | Licence du moteur | Modèle requis | Capacité |
| --- | --- | --- | --- | --- |
| [`whisper.cpp`](https://github.com/ggml-org/whisper.cpp/tree/v1.7.6) | 1.7.6 | MIT | poids Whisper au format ggml ; licence, version, taille et SHA-256 propres au fichier | ASR CPU ; segments horodatés |
| [`piper-tts`](https://github.com/OHF-Voice/piper1-gpl/tree/v1.3.0) | 1.3.0 | GPL-3.0-or-later | paire voix `.onnx` + métadonnées `.onnx.json` ; licence, version, taille et SHA-256 propres à chaque fichier | TTS CPU ; pas d'horodatages |

Référence concrète pour l'ASR anglais : `ggml-tiny.en.bin` depuis le dépôt
[`ggerganov/whisper.cpp` à la révision `6034871ec87c84e342efab769d4c5c06cd126db3`](https://huggingface.co/ggerganov/whisper.cpp/tree/6034871ec87c84e342efab769d4c5c06cd126db3).
Le fichier fait **77 704 715 octets**, a pour licence déclarée **MIT** et SHA-256
`921e4cf8686fdd993dcd081a5da5b6c365bfde1162e72b08d75ac75289920b1f`.
Le dépôt amont estime environ **390 MB de mémoire** pour ce modèle; c'est une
estimation, pas une garantie. `tiny.en` ne prend en charge que l'anglais. La
licence et les valeurs de toute autre version de modèle doivent être revérifiées.

Références d'installation opt-in : [build et CLI whisper.cpp](https://github.com/ggml-org/whisper.cpp/blob/v1.7.6/examples/cli/README.md),
[instructions CLI Piper](https://github.com/OHF-Voice/piper1-gpl/blob/v1.3.0/docs/CLI.md),
[licences des voix Piper](https://github.com/OHF-Voice/piper1-gpl/blob/v1.3.0/docs/VOICES.md).
Pour installer explicitement la distribution Python Piper dans un environnement
isolé, utiliser par exemple `python -m pip install 'piper-tts==1.3.0'`. Installer
`whisper.cpp` en suivant les instructions de build du tag v1.7.6. Ces opérations
sont à la charge de l'opérateur, jamais exécutées par l'application ou les tests.

Les licences des poids/voix sont distinctes de celles des moteurs et varient
selon chaque modèle. Aucune licence, taille ou empreinte de modèle n'est
présumée par le module. Avant activation, obtenir le fichier depuis la source
officielle du projet, relire sa licence, calculer sa taille et son SHA-256, puis
fournir ces valeurs exactes dans la configuration. Les valeurs sont comparées
au fichier local au premier usage; les liens symboliques, fichiers absents,
tailles incorrectes et empreintes différentes échouent sans repli.

Aucune voix Piper n'est activée ou recommandée par défaut : vérifier les droits
des poids eux-mêmes dans la fiche de la voix, et ne pas assimiler la licence du
jeu de données à celle des poids dérivés. Enregistrer et vérifier séparément
l'empreinte, la taille et la licence déclarée du `.onnx` et de son `.onnx.json`.
Les projets upstream ne spécifient pas de minimum CPU/RAM portable pour chaque
voix ; renseigner le budget mémoire mesuré pour chaque modèle et machine cible.

Exemple de configuration (chemins et valeurs à remplacer par des artefacts
installés et vérifiés explicitement) :

```js
import {
  createLocalSpeechService,
  createPiperTtsEngine,
  createWhisperCppAsrEngine,
} from './modules/local-speech/index.mjs';

const asr = createWhisperCppAsrEngine({
  executable: '/opt/local-speech/whisper-cli',
  runtimeVersion: '1.7.6',
  model: {
    path: '/opt/local-speech/ggml-model.bin',
    version: 'ggml-tiny.en-6034871',
    license: 'MIT',
    sizeBytes: 77704715,
    sha256: '921e4cf8686fdd993dcd081a5da5b6c365bfde1162e72b08d75ac75289920b1f',
    minimumMemoryBytes: 390000000,
  },
  languages: ['en'],
});
const tts = createPiperTtsEngine({
  executable: '/opt/local-speech/piper',
  runtimeVersion: '1.3.0',
  model: {
    path: '/opt/local-speech/voice.onnx',
    version: 'version-de-la-voix',
    license: 'licence-de-la-voix',
    sizeBytes: 1,
    sha256: 'b'.repeat(64),
    minimumMemoryBytes: 1,
    voiceConfig: {
      path: '/opt/local-speech/voice.onnx.json',
      version: 'version-de-la-configuration',
      license: 'licence-de-la-configuration',
      sizeBytes: 1,
      sha256: 'c'.repeat(64),
      minimumMemoryBytes: 1,
    },
  },
});
const speech = createLocalSpeechService({ asrEngine: asr, ttsEngine: tts });
```

Les chemins sont des exemples : pour le modèle ASR cité, ils doivent désigner le
fichier téléchargé depuis la révision épinglée. Les valeurs de l'exemple Piper
sont factices et invalides en production. Pour chaque artefact, renseigner un
`minimumMemoryBytes` réaliste selon les exigences du modèle et la mémoire de
pointe mesurée avec le moteur/version choisis. Le module publie cette exigence
dans ses métadonnées et refuse une valeur inférieure à la taille du fichier. Les
exigences CPU/RAM dépendent du modèle et ne peuvent pas être déduites uniquement
de sa taille sur disque. Pour calculer la taille et l'empreinte d'un fichier
installé :

```sh
stat -c '%s' /opt/local-speech/ggml-model.bin
sha256sum /opt/local-speech/ggml-model.bin
```

`whisper.cpp` prend un WAV préparé localement, un modèle et une langue
allowlistée. L'entrée attend un WAV PCM mono 16 kHz normalisé par
`modules/audio/`; sa durée doit aussi être fournie et reste bornée. Piper reçoit
le texte par stdin et produit un WAV temporaire dans un répertoire privé. Les
temporaires sont supprimés après succès ou erreur. Les erreurs publiques ne
révèlent pas stderr ni le contenu.

## API, consentement et intégration audio

Chaque requête `transcribe` et `synthesize` requiert `consent: true`. Le
consentement ne remplace ni l'autorisation utilisateur ni les contrôles du
module `audio` : l'application authentifie et autorise la demande, lit le média
via `audio.readAudio`, puis demande le consentement avant de transmettre les
octets à `speech.transcribe`. Le résultat est toujours un brouillon non validé.
L'application peut le convertir explicitement en segments d'un transcript
`audio.createTranscript` / `audio.editTranscript`; seule une validation humaine
via `audio.validateTranscript` rendra l'export ou l'ingestion RAG possible.
La sortie TTS peut être remise à `audio.ingest` avec consentement explicite si
elle doit être conservée.

Les objets d'entrée refusent les champs inconnus. Les segments ASR sont
revalidés, bornés à 1000 éléments, triés, non chevauchants et inclus dans la
durée annoncée. Les modèles et fichiers texte/audio sont bornés; les sorties
invalides ne sont jamais présentées comme réussies.

| Limite | Défaut | Maximum |
| --- | ---: | ---: |
| WAV ASR | 24 MiB | 100 MiB |
| Texte TTS | 20 000 caractères | 100 000 |
| Sortie | 24 MiB | 64 MiB |
| Durée ASR | 600 s | 3600 s |
| Délai moteur | 120 s | 30 min |
| Segments | 1000 | 1000 |

Le moteur ne lance aucun traitement au chargement du module. Les outils
exécutables configurés sont appelés avec argv construit localement et
`shell: false`. Timeout et annulation tuent le sous-processus. Une installation
ou un modèle manquant produit `ENGINE_UNAVAILABLE` / `MODEL_UNAVAILABLE` ;
aucun moteur distant ou modèle de démonstration n'est utilisé en remplacement.

## Démonstration, erreurs et rollback

`createDeterministicSpeechDemo()` renvoie seulement une chaîne fixe étiquetée
`DEMONSTRATION — NOT A TRANSCRIPTION OR SYNTHESIS`. Elle n'accepte pas d'audio,
n'est pas un adaptateur moteur, ne peut pas être fourni à
`createLocalSpeechService` et ne doit pas apparaître comme capacité ASR/TTS
réelle.

Codes stables : `INVALID_INPUT`, `INVALID_CONFIGURATION`, `CONSENT_REQUIRED`,
`INVALID_AUDIO`, `INVALID_TEXT`, `INPUT_LIMIT`, `UNSUPPORTED_LANGUAGE`,
`MODEL_UNAVAILABLE`, `MODEL_INTEGRITY_FAILED`, `ENGINE_UNAVAILABLE`,
`ENGINE_FAILED`, `ENGINE_TIMEOUT`, `INTERRUPTED`, `INVALID_ENGINE_OUTPUT` et
`TTS_UNAVAILABLE`.

Installation et activation sont séparées : retirer la configuration désactive
les moteurs sans modifier les données audio. Aucun installateur automatique,
téléchargement, stockage persistant, service réseau ou changement de générateur
n'est inclus.

```sh
node --test tests/local-speech.test.mjs
npm test
```

Les tests utilisent des poids synthétiques et de faux exécutables locaux; ils ne
téléchargent ni moteur ni modèle.
