# Adaptateur LLM local et assistant sourcé v1

`modules/llm-local/index.mjs` expose un adaptateur local CPU pour le CLI
`llama.cpp` et un assistant qui s'appuie exclusivement sur le module
`rag-search`. Contrat `contractVersion: 1`, module `1.0.0`. Le module est
désactivé par défaut ; il n'installe ni moteur ni modèle, ne télécharge aucun
poids, ne contacte aucun service et n'exécute aucune action demandée par un
document.

## Installation explicite

L'opérateur installe lui-même une version de `llama.cpp` avec son CLI
`llama-cli`, ainsi qu'un modèle GGUF compatible avec son modèle de conversation.
Les deux éléments doivent être présents localement avant activation. Le code
appelle le CLI avec argv fixe, `shell: false`, `--n-gpu-layers 0` et une limite
de tokens. Le `runtimeVersion` configuré est une déclaration d'exploitation,
pas une détection du binaire.

Exemples de familles de modèles à évaluer, sans poids ni version préinstallés :

| Famille | Nomenclature amont | Licence à vérifier pour la révision choisie |
| --- | --- | --- |
| Qwen2.5 Instruct GGUF | `Qwen2.5-0.5B-Instruct-GGUF`, `Qwen2.5-1.5B-Instruct-GGUF` | Apache-2.0 déclarée par la famille ; vérifier le dépôt, la quantification et les fichiers exacts |

Ces noms sont des pistes, pas des modèles validés par le module. Avant chaque
activation, examiner la provenance et la licence du fichier précis, puis
enregistrer son chemin absolu, sa version, sa licence, sa taille en octets, son
SHA-256 et une exigence mémoire mesurée. L'adaptateur vérifie taille et SHA-256
à chaque requête ; un fichier absent, modifié ou de taille
incorrecte fait échouer la requête.

```js
import {
  createLlamaCppAdapter,
  createLocalLlmService,
} from './modules/llm-local/index.mjs';

const adapter = createLlamaCppAdapter({
  contractVersion: 1,
  executable: '/opt/llama.cpp/build/bin/llama-cli',
  runtimeVersion: 'version-installée-par-l-operateur',
  model: {
    path: '/opt/models/model.gguf',
    version: 'qwen2.5-0.5b-instruct-q4_k_m-r1',
    license: 'licence-vérifiée',
    sizeBytes: 123456789,
    sha256: 'a'.repeat(64),
    minimumMemoryBytes: 2_000_000_000,
  },
});

const assistant = createLocalLlmService({
  enabled: true,
  adapter,
  ragSearch,
  prompts: [{
    appId: 'exemple',
    version: '1.0.0',
    systemPrompt: 'Répondre en français avec des faits concis.',
  }],
});

const response = await assistant.answer({
  cookieHeader,
  tenantId,
  requestId,
  appId: 'exemple',
  promptVersion: '1.0.0',
  question: 'Où est décrite la politique d’accès ?',
  signal: requestSignal,
});
```

Le service délègue recherche, authentification, ACL et résolution du contexte
tenant à `rag-search`, en lui transmettant le cookie, le tenant et l'identifiant
de requête de l'appelant. Il n'accepte qu'une version explicite de prompt pour
chaque application. Les extraits sont passés comme données JSON distinctes du
prompt système ; ils restent du contenu non fiable. Le modèle ne reçoit aucun
outil ni mécanisme d'action. Sans résultat, le service renvoie immédiatement
`{ answer: '', citations: [], abstain: true }` sans lancer le moteur.

La réponse du modèle doit être un objet JSON conforme à
`llmLocalContract.outputSchema` :

```json
{
  "answer": "Réponse appuyée par les extraits.",
  "sourceIndexes": [0],
  "abstain": false
}
```

Les index sont bornés aux résultats de la recherche, uniques, puis convertis
par le service en citations provenant de ces résultats. Des clés inconnues,
JSON invalide, références hors liste, ou réponse sans citation en mode non
abstention provoquent `INVALID_MODEL_OUTPUT`. L'API `answer()` ne publie la
réponse qu'après validation ; l'adaptateur `stream()` expose les fragments
locaux en flux asynchrone et son consommateur doit traiter les fragments comme
non validés tant que l'itération ne se termine pas sans erreur.

## Budgets et erreurs

| Limite | Défaut | Maximum |
| --- | ---: | ---: |
| Prompt envoyé au moteur | 32 KiB | 256 KiB |
| Sortie générée | 128 KiB | 2 MiB |
| Sources RAG | 8 | 20 |
| Tokens générés | 512 | 8192 |
| Délai moteur | 60 s | 15 min |
| Mémoire minimale déclarée | 8 GiB | 64 GiB |

Les limites sont configurables dans les bornes, et `minimumMemoryBytes` ne peut
pas dépasser `maxMemoryBytes`. Elles bornent l'entrée, la sortie, le nombre de
sources, le budget de génération et le temps du sous-processus ; la mémoire
minimale reste une exigence déclarée par l'opérateur, pas une mesure imposée par
le système. Une annulation tue le processus. Le prompt de requête passe par un
fichier temporaire privé supprimé à la fin ; il n'est pas placé dans argv.
stderr et les messages internes du moteur ne sont ni retournés ni journalisés.

Codes stables : `DISABLED`, `INVALID_INPUT`, `INVALID_CONFIGURATION`,
`PROMPT_NOT_FOUND`, `INPUT_LIMIT`, `OUTPUT_LIMIT`, `MODEL_UNAVAILABLE`,
`MODEL_INTEGRITY_FAILED`, `ENGINE_UNAVAILABLE`, `ENGINE_FAILED`,
`ENGINE_TIMEOUT`, `INTERRUPTED`, `SOURCE_UNAVAILABLE`, `INVALID_MODEL_OUTPUT`
et `TEMPORARY_DATA_CLEANUP_FAILED`. Aucun basculement vers un modèle distant,
une réponse factice ou une réponse non sourcée n'est effectué.

## Évaluation manuelle avec un moteur réel

Les tests automatisés emploient de petits fichiers synthétiques et un faux
exécutable local ; ils ne requièrent pas de poids. Avant toute mise en service,
l'opérateur doit :

1. Installer explicitement une version vérifiée de `llama.cpp` et un GGUF dont
   la licence, la révision, la quantification et le modèle de conversation sont
   acceptables.
2. Vérifier le binaire et les fichiers avec les outils locaux (`llama-cli
   --version`, `stat`, `sha256sum`) et renseigner les valeurs réelles dans la
   configuration. Ne pas reprendre les valeurs d'exemple.
3. Mesurer mémoire de pointe, latence, débit, comportement d'annulation et
   résultats sur le CPU et le jeu de prompts cibles. Tester réponses sourcées,
   sources insuffisantes, documents injectant des instructions, refus de
   citations inventées et accès entre tenants.
4. Documenter modèle, version moteur, licence, SHA-256, machine, prompts
   versionnés, limites et résultats. Ne pas enregistrer de questions, extraits
   privés ou sorties contenant des données sensibles dans les rapports.

Désactivation et rollback : omettre `enabled: true` ou retirer la configuration
locale. Le service désactivé refuse les requêtes avec `DISABLED` ; aucun index,
document ou paramètre de tenant n'est modifié par ce module.

Tests hors réseau et sans poids :

```sh
node --test tests/llm-local.test.mjs
npm test
```
