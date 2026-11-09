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
| `whisper.cpp` | 1.7.6 | MIT | poids Whisper au format ggml ; licence, version, taille et SHA-256 propres au fichier | ASR CPU ; segments horodatés |
| Piper (`piper-tts`) | 1.3.0 | GPL-3.0 | paire voix `.onnx` + métadonnées `.onnx.json` ; licence, version, taille et SHA-256 propres à la voix | TTS CPU ; pas d'horodatages |

Les licences des poids/voix sont distinctes de celles des moteurs et varient
selon chaque modèle. Aucune licence, taille ou empreinte de modèle n'est
présumée par le module. Avant activation, obtenir le fichier depuis la source
officielle du projet, relire sa licence, calculer sa taille et son SHA-256, puis
fournir ces valeurs exactes dans la configuration. Les valeurs sont comparées
au fichier local au premier usage; les liens symboliques, fichiers absents,
tailles incorrectes et empreintes différentes échouent sans repli.

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
    version: 'version-du-modele',
    license: 'licence-du-modele',
    sizeBytes: 1,
    sha256: 'a'.repeat(64),
  },
  languages: ['fr'],
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
  },
});
const speech = createLocalSpeechService({ asrEngine: asr, ttsEngine: tts });
```

Les tailles et empreintes de l'exemple sont des valeurs factices invalides en
production. Pour calculer les informations du modèle déjà installé :

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
