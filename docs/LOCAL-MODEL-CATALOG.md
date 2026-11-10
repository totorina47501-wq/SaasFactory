# Catalogue des modèles locaux

**État au 2026-11-10 :** aucun poids de modèle n'est livré, téléchargé ou installé par Factory ou par ses tests. Ce catalogue distingue les seules références documentées des artefacts effectivement vérifiés. Aucun moteur/modèle n'est déclaré `verified` : aucune recette n'a été exécutée avec un poids réel sur un SaaS généré.

## Références documentées, pas une approbation produit

| Usage / artefact | Version et licence connues | Taille et SHA-256 documentés | CPU / RAM | Statut |
| --- | --- | --- | --- | --- |
| LLM : familles Qwen2.5 Instruct GGUF citées comme pistes | Version de fichier non épinglée ; Apache-2.0 déclarée pour la famille, à revalider pour le dépôt, la quantification et le fichier précis | Non établis | CPU seulement côté adaptateur ; taille et budget RAM de chaque fichier non établis | Non approuvé, pas de téléchargement ou recommandation de poids ; voir [contrat LLM local](modules/llm-local.md). |
| ASR : `ggml-tiny.en.bin`, révision amont `6034871ec87c84e342efab769d4c5c06cd126db3` | Fichier déclaré MIT ; moteur `whisper.cpp` v1.7.6, MIT | 77 704 715 octets ; `921e4cf8686fdd993dcd081a5da5b6c365bfde1162e72b08d75ac75289920b1f` | CPU ; environ 390 MB de mémoire estimés par l'amont, non mesurés ici. Anglais seulement. | Référence précise documentée dans [le contrat local de parole](modules/local-speech.md#installation-explicite), mais non installée ni exécutée dans cette mission. Vérifier de nouveau source/licence/hash avant usage. |
| TTS : voix Piper (`.onnx` + `.onnx.json`) | Moteur `piper-tts` v1.3.0, GPL-3.0-or-later ; aucune voix ni licence de poids approuvée | Dépend de chaque fichier ; aucune empreinte ni taille catalogue | Pas de minimum portable publié ici ; mesurer chaque voix et sa configuration | Pas de voix sélectionnée ou installée ; voir [contrat local de parole](modules/local-speech.md). |

Une référence, un nom de famille, une valeur d'exemple ou un test synthétique n'est pas une validation. Les données exemple avec valeurs répétées/factices dans les contrats sont des placeholders, pas des empreintes à copier.

## Installation explicite et inventaire à conserver

1. Décider séparément de l'usage, la langue, la licence et la version autorisés. Lire la licence du fichier précis, y compris les conditions de distribution de la quantification, des poids ou de la voix.
2. Installer le moteur localement en suivant ses instructions versionnées. Pour ASR, le contrat épingle les instructions de `whisper.cpp` v1.7.6 et l'exemple ci-dessus. Pour LLM ou Piper, choisir et vérifier soi-même une version et ses instructions amont ; Factory n'en installe aucune.
3. Récupérer manuellement le modèle depuis sa source choisie, dans un répertoire local privé hors du dépôt. Ne pas placer les poids, modèles ou licences propres au projet dans Factory, les tests, les rapports ou un dépôt partagé.
4. Relever les métadonnées sur les fichiers installés, puis comparer leur origine/licence aux termes applicables :

   ```sh
   stat -c '%s' /absolute/path/to/model-file
   sha256sum /absolute/path/to/model-file
   ```

5. Pour chaque artefact (y compris les fichiers JSON d'une voix), consigner dans la configuration locale : chemin absolu, ID/version exacte, licence, taille en octets, SHA-256 et mémoire minimale mesurée/prévue. Noter également la version du moteur, son empreinte/provenance, CPU/OS, mémoire de pointe et date de vérification. La valeur de version déclarée n'est pas détectée automatiquement.
6. Vérifier modèle et moteur avec les tests d'intégration propres au projet, données synthétiques, budgets de délai/mémoire, annulation et cas d'échec. Ne pas activer le service tant que l'inventaire et la licence ne sont pas validés. Le retrait de sa configuration désactive l'intégration.

Les modules contrôlent l'existence, la taille et le SHA-256 des modèles configurés et refusent les artefacts manquants ou altérés ; ils ne vérifient pas la légitimité de provenance ou l'interprétation d'une licence. Les limites mémoire sont déclaratives et ne remplacent pas une limite OS. L'adaptateur LLM emploie le CPU (`--n-gpu-layers 0`) et a par défaut un plafond de 8 GiB pour la valeur mémoire déclarée, non mesurée.

## Tests sans poids

```sh
node --test tests/llm-local.test.mjs tests/local-speech.test.mjs
npm test
```

Ces tests créent de petits fichiers synthétiques et des exécutables factices locaux ; ils ne téléchargent ni ne chargent de poids réels et ne qualifient pas `llama.cpp`, `whisper.cpp`, Piper, un modèle, une licence ou la performance matérielle d'une application. L'installation de tout moteur/poids reste une action explicite de l'opérateur, hors test et hors génération.
