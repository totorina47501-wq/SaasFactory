# Contrat du générateur de projets SaaS

## Portée

Ce document spécifie les entrées, sorties et contrôles attendus d’un futur générateur. Il ne l’implémente pas et n’autorise ni création automatique de dépôt, ni déploiement, ni activation d’un fournisseur. La source est une sélection explicite de fichiers neutres, relue et maintenue séparément ; ce n’est jamais une copie de an existing application.

Le format ci-dessous est versionné indépendamment du générateur. Une modification incompatible exige une nouvelle valeur de `schemaVersion` et une migration explicite des configurations.

## Schéma d’entrée v1

L’entrée est un objet JSON UTF-8. Les clés sont sensibles à la casse ; les propriétés inconnues, valeurs nulles et clés dupliquées sont refusées. Tous les champs ci-dessous sont requis.

```json
{
  "schemaVersion": 1,
  "productName": "Atelier Exemple",
  "projectSlug": "atelier-exemple",
  "domain": "atelier.example",
  "modules": ["ai-disabled", "auth", "api"],
  "languages": ["fr-FR", "en"],
  "defaultLanguage": "fr-FR",
  "deploymentTarget": "none"
}
```

| Champ | Type et règles |
| --- | --- |
| `schemaVersion` | Entier, exactement `1`. |
| `productName` | Chaîne de 2 à 80 caractères après suppression des espaces de bord. Nom d’affichage ; ne sert jamais de chemin ni de code. |
| `projectSlug` | Chaîne ASCII de 1 à 48 caractères, minuscules, chiffres et tirets simples ; motif `^[a-z0-9]+(?:-[a-z0-9]+)*$`. Ni point, slash, antislash, espace, ni tiret initial/final. Doit être unique dans le répertoire de destination et utilisable comme nom de dépôt GitHub. |
| `domain` | Nom DNS ASCII en minuscules, sans schéma, port, chemin, wildcard ni point final ; chaque label a au plus 63 caractères, commence et finit par une lettre ou un chiffre et ne contient que lettres, chiffres et tirets ; longueur totale au plus 253 caractères. Les noms réservés à l’exemple comme `.example` conviennent aux tests. |
| `modules` | Tableau non vide, sans doublons, composé uniquement de `auth`, `billing-test`, `ai-disabled`, `api` et `media`. `ai-disabled` est obligatoire en v1 : aucune intégration IA réelle n’est générée. `billing-test` ne configure que des parcours de test et n’inclut aucun tarif ou secret. |
| `languages` | Tableau non vide, sans doublons ; chaque valeur est une balise de langue BCP 47 canonique (par ex. `fr-FR`, `en`). |
| `defaultLanguage` | Balise BCP 47 canonique présente dans `languages`. |
| `deploymentTarget` | Valeur explicite `none` ou `cloudflare-opennext`. `none` n’ajoute aucune configuration fournisseur ; la cible Cloudflare ne contient aucune identité de compte ni configuration secrète héritée. |

Une entrée valide passe les contraintes de type, limites de longueur, listes fermées et règles croisées du tableau. Toute option de module ou cible nouvelle nécessite une revue et une évolution explicite de ce contrat ; aucune valeur inconnue n’est ignorée.

## Validation des chemins et des noms

- `projectSlug` est validé avant toute résolution de chemin. Il est utilisé comme seul composant de répertoire contrôlé par l’appelant ; les chemins relatifs arbitraires ne sont pas acceptés en entrée.
- Rejeter les séparateurs `/` et `\`, les segments `.` et `..`, les caractères de contrôle ou NUL, les formes encodées ou doublement encodées de ces caractères, les préfixes de lecteur, les chemins absolus, les noms de périphérique et les variantes normalisées qui pourraient devenir un séparateur ou un segment parent.
- Résoudre le répertoire de sortie et vérifier que sa forme canonique reste strictement sous la racine autorisée. Refuser les répertoires ou fichiers existants qui sortent de cette racine, les liens symboliques, les collisions de casse et toute destination déjà existante ou non vide ; la v1 ne propose pas de remplacement.
- Ne jamais faire confiance au nom d’affichage, au domaine ou à une chaîne de configuration pour construire un chemin, une commande shell ou une URL de clonage. Échapper ces valeurs dans leurs contextes de sortie.
- Copier uniquement des fichiers inscrits dans un manifeste de sources autorisées et versionné. Ne pas suivre les liens symboliques du modèle. Toute source non déclarée est refusée par défaut.
- Une erreur de validation arrête l’opération avant la première écriture. L’échec ne doit jamais poursuivre en mode dégradé ni écrire hors du répertoire cible.

## Exclusions impératives

La génération part d’un modèle générique revu, jamais d’un export ou d’une copie récursive de an existing application. Exclure explicitement :

- tous les secrets, clés, certificats, jetons, cookies, identifiants, fichiers `.env`, `.dev.vars`, clés privées et valeurs réelles de configuration ; seul un `.env.example` avec noms et valeurs factices clairement marquées peut être produit ;
- données clients, comptes, fixtures non synthétiques, journaux, reçus, sauvegardes, dumps, fichiers locaux et URL signées ;
- marque, textes, domaine, comptes de service, identifiants Supabase/Cloudflare, stockage, variables, règles DNS ou configuration de déploiement propres à an existing product ;
- Mia, RAG, embeddings, index, corpus et contenus juridiques, historique de conversation, prompts, algorithmes et règles métier de conformité ;
- migrations, politiques RLS, schémas ou données métier de Project3, ainsi que tout contenu ou test dérivé de données privées ;
- dépendances ou services payants activés par défaut. Les adaptateurs éventuels restent désactivés et nécessitent une configuration propre, créée et validée par le propriétaire du nouveau projet.

Le résultat est contrôlé contre le manifeste d’exclusion et un scanner de secrets avant toute proposition de dépôt. Une détection bloque la génération ; elle n’est pas transformée silencieusement en valeur vide.

## Structure de sortie attendue

Chaque exécution réussie produit un seul répertoire neuf `<projectSlug>/` contenant une base neutre et minimale. Le manifeste versionné précise chaque fichier autorisé et les options qui le sélectionnent.

```text
<projectSlug>/
├── .github/
│   └── workflows/ci.yml       # CI générique, sans secrets ni déploiement
├── app/
│   └── page.tsx               # page d’accueil neutre
├── docs/
│   └── setup.md               # configuration du nouveau projet
├── public/
│   └── .gitkeep
├── tests/
│   └── smoke.test.ts          # test de démarrage généré
├── .env.example               # noms de variables et placeholders uniquement
├── .gitignore
├── README.md                  # nom, domaine, langues, modules et cible choisis
├── next.config.ts
├── package.json
├── tsconfig.json
└── …
```

Les fichiers optionnels sont limités aux modules sélectionnés : leurs chemins sont prédéfinis dans le manifeste, pas composés depuis l’entrée. Le module `auth` ajoute uniquement un squelette sans comptes ni clés ; `api` ajoute un exemple neutre et documenté ; `media` ajoute des exemples synthétiques sans stockage distant ; `billing-test` ajoute des points de configuration explicitement réservés au mode test. Le support multilingue ne produit que les ressources des langues choisies et définit la langue par défaut. Aucune migration n’est copiée ; un nouveau schéma éventuel doit être conçu pour le projet indépendant.

Le générateur n’écrit pas de fichier `.env`, de dépôt `.git`, de clé d’API, de configuration de compte, ni de secret CI. Les identifiants et valeurs privées sont fournis plus tard par le propriétaire dans l’environnement approprié.

## Mode `dry-run`

Le mode `dry-run` est sans effet de bord et constitue le comportement par défaut du futur outil. Il valide toute l’entrée et affiche un manifeste déterministe : chemins qui seraient créés, modules activés, cible choisie, fichiers refusés/exclus et erreurs éventuelles. Il ne crée ni répertoire/fichier, ni dépôt distant, ne lance aucune commande de fournisseur, ne contacte aucun service réseau et ne demande ni ne lit de secret.

L’exécution effective doit exiger une option distincte, une destination explicite et une confirmation avant toute écriture. Elle réutilise les validations du `dry-run`, refuse les collisions et doit produire le même manifeste à entrée et version de modèle identiques. Une génération répétée ne remplace jamais silencieusement un résultat existant.

## Tests d’acceptation

La future implémentation devra démontrer au minimum ces cas, hors réseau et sans fournisseur :

1. Une entrée valide génère uniquement les chemins du manifeste ; les modules et langues présents correspondent exactement à la sélection.
2. Refus des clés inconnues, champs manquants, valeurs de mauvais type, doublons, modules non autorisés, `ai-disabled` absent, langue par défaut non déclarée et version de schéma inconnue.
3. Refus des slugs contenant `/`, `\`, `..`, points, `%2e`/variantes encodées, NUL, préfixes de lecteur, séparateurs Unicode trompeurs, ainsi que des destinations à travers un lien symbolique ou une collision de casse.
4. Les essais de chemins malveillants ne créent, ne lisent et ne modifient aucun fichier hors du répertoire autorisé ; une erreur avant écriture laisse la destination inchangée.
5. Pour chacune des cibles et chacun des modules permis, les fichiers de configuration attendus sont présents sans identifiants hérités ; les choix inconnus échouent sans configuration de repli.
6. La recherche de chaînes sentinelles correspondant aux secrets, noms de marque/domaine et identifiants interdits dans le modèle de test ne trouve aucune valeur dans la sortie ; les `.env.example` ne contiennent que des placeholders.
7. Le `dry-run` produit un manifeste stable entre deux exécutions et ne modifie aucun fichier, ne crée aucun dépôt et ne fait aucun accès réseau.
8. La génération effective sur une destination neuve passe les contrôles de secrets, lint/typecheck et tests de démarrage prévus par le modèle ; la répétition sur cette destination échoue sans écraser les fichiers.

## Création d’un dépôt SaaS indépendant

La création du dépôt distant est une étape manuelle, distincte de la génération. Après un `dry-run` relu, le propriétaire choisit le nom, la visibilité et l’organisation du nouveau dépôt, puis crée un dépôt GitHub vide par l’interface ou un outil autorisé. Le générateur n’appelle pas l’API GitHub, ne crée pas de dépôt, ne pousse pas de commit et ne reçoit pas de jeton GitHub.

Générer dans un répertoire isolé, inspecter l’arborescence et le diff, exécuter les contrôles locaux sans secrets, puis initialiser un historique Git neuf uniquement après validation humaine. Ne jamais copier le `.git` ou l’historique de Project3. Relier le dépôt vide et publier le premier commit sont des actions explicites du propriétaire ; les secrets de CI, l’intégration des fournisseurs et tout déploiement sont configurés et validés séparément. La réussite de la génération ou de la CI ne vaut ni création de dépôt, ni mise en production, ni recette de production.
