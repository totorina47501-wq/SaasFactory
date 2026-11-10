# Sécurité du modèle local

## Frontière de confiance

Le module LLM est une option locale distincte, désactivée par défaut. Il ne
télécharge aucun modèle, n'appelle aucun fournisseur distant et ne réalise aucune
action. Son adaptateur lance le chemin absolu de `llama.cpp` configuré par
l'opérateur avec un tableau d'arguments fixe, `shell: false` et les couches GPU
désactivées. Le modèle est contrôlé par taille et SHA-256 à chaque requête. Voir
`modules/llm-local/index.mjs:115-130,165-177,219-229`.

Le chemin du modèle, l'exécutable et leur provenance sont des entrées de
configuration de confiance, pas des contenus utilisateurs. Le binaire externe
est un composant avec les mêmes droits OS que le processus appelant. Le module
ne fournit pas de sandbox, seccomp, conteneur, isolation réseau, limite CPU/RAM
effective ni validation cryptographique de provenance. Vérifier la révision,
licence et empreinte du binaire/modèle avant activation; utiliser un utilisateur
OS dédié et les protections du système de fichiers.

## Instructions et données non fiables

Les extraits RAG et la question restent des données non fiables. Les directives
du système interdisent de suivre les instructions des extraits ou d'invoquer des
outils (`modules/llm-local/index.mjs:23-29`). Le service n'expose aucun outil,
ne répond pas sans sources, n'accepte que des citations correspondant aux
résultats récupérés et valide strictement le JSON de sortie. Le test
`tests/llm-local.test.mjs:220-264` couvre injection de prompt, absence d'outil,
référence inventée et réponse non sourcée; la confidentialité tenant est
également testée dans `tests/llm-local.test.mjs:266-296`.

Ces mécanismes réduisent les capacités du modèle mais ne constituent pas une
garantie que le texte généré est vrai, inoffensif ou exempt d'instruction
malveillante. Une application doit traiter les réponses comme du contenu non
fiable, ne jamais les exécuter comme code/commande/HTML actif et exiger une
validation humaine pour toute décision conséquente. Les fragments de `stream()`
ne sont pas validés avant la fin réussie de l'itération.

## Sous-processus, fichiers temporaires et quotas

La question et les sources sont passées dans un fichier temporaire privé; le
prompt système reste un argument séparé. Le fichier est supprimé après usage.
Les erreurs stderr ne sont ni exposées ni journalisées. Délais, annulation,
taille du prompt/sortie, nombre de sources et tokens sont bornés par contrat.
Le test supplémentaire `tests/security/adversarial-boundaries.test.mjs` passe
un prompt avec substitution de commande à un faux exécutable synthétique et
vérifie que la chaîne reste un argument de données et ne crée pas de fichier.

Le test est une preuve de l'appel local à `spawn`, pas une preuve d'isolation du
binaire réel. Il ne télécharge ni ne lance un moteur ou modèle tiers. Les
limites mémoire ne sont pas imposées par l'OS et le modèle doit être vérifié par
l'opérateur.

## Validation manuelle avant activation

1. Installer explicitement un moteur local vérifié et un modèle dont la licence,
   révision et provenance sont acceptées; aucun poids n'est inclus dans le dépôt.
2. Vérifier versions, tailles et SHA-256 à l'aide d'outils locaux. Ne pas
   considérer les exemples documentaires comme des empreintes valides.
3. Tester localement les délais, l'annulation, la pression mémoire, des prompts
   adversariaux et la séparation tenant avec des fixtures synthétiques.
4. Désactiver le module par défaut et retirer la configuration pour rollback.

Les étapes manuelles ci-dessus n'ont pas été exécutées dans cette mission; aucun
vrai moteur, modèle ou fournisseur n'a été activé.
