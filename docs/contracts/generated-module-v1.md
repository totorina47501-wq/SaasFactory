# Module généré indépendant — contrat v1

**Portée :** frontière entre Factory Core, module sélectionné, projet généré neuf et runtime local. Ce document ne transforme aucun scaffold en produit implémenté.

## Composition et génération

1. Le Core reçoit uniquement une configuration déjà validée et un ensemble explicite de modules. Il valide leurs `ModuleDescriptor`, versions, dépendances et incompatibilités avant génération ; aucune sélection implicite.
2. Un descripteur fournit des métadonnées, paramètres typés, permissions déclarées et chemins attendus. Il ne contient jamais un script, une commande shell, un hook de cycle de vie, un import ou le corps de fichiers.
3. Les seuls contenus générés proviennent de sources locales de modèles auditées et listées dans le manifeste de confiance du générateur. Le manifeste ne peut pas ajouter une source, un chemin d'import, une commande, un hook ou une dépendance.
4. Le comportement actuel demeure `dry-run` par défaut ; l'écriture exige `--write`, une destination explicite neuve, des chemins confinés et le refus des collisions/liens symboliques. Le projet reste autonome, sans `.git`, secret, compte fournisseur, déploiement ou appel réseau.
5. Les valeurs de configuration sont validées contre le schéma fermé du module, puis échappées à leur contexte. Elles ne servent jamais à former un chemin, commande, code source, nom de paquet dynamique ou URL.

Les fichiers optionnels sont issus d'un allowlist Factory revu ; `generatedFiles` est une déclaration, pas une autorisation. Un fichier qui n'a pas de source approuvée est refusé. Un module `scaffold` est étiqueté comme incomplet dans le projet et sa documentation ; il n'est pas présenté comme disponible.

## Runtime local et indépendance

Le projet résultant a sa propre configuration, cycle de vie, tests et migrations. Les interfaces communes v1 sont décrites dans [Factory Runtime](factory-runtime-v1.md). Le projet ne charge pas de module depuis le dépôt SaaSFactory et ne partage pas son stockage, secrets, identité, historique git, compte fournisseur ou état d'exécution.

Une implémentation locale peut utiliser uniquement les services installés et configurés dans le projet indépendant. Pas de réseau distant, modèle téléchargé, email, paiement, authentification hébergée ou déploiement implicite. Une fonctionnalité dépendante d'une ressource absente échoue explicitement, plutôt que de retourner une simulation présentée comme réelle.

## Migrations appartenant au module

- Un module qui exige un schéma possède exclusivement `modules/<module-id>/migrations/` dans le projet généré. Ses migrations ne sont ni copiées d'un autre produit ni ajoutées au dépôt Factory comme schéma métier.
- Les noms sont ordonnés et stables : `NNNN_<slug>.sql`, avec séquence croissante et slug ASCII minuscule. Un identifiant déjà appliqué ne se modifie pas ; toute évolution est un nouveau fichier.
- Chaque migration appartient à un seul module. Elle ne modifie pas une table ou namespace d'un autre module et n'inclut ni donnée réelle ni secret. Les noms de tables/objets métier sont décidés et documentés par le projet généré, jamais imposés par ce contrat générique.
- La migration reste du contenu déclaratif pré-approuvé, pas un hook JavaScript/shell. Tout futur runner doit valider l'identifiant et le checksum, arrêter au premier échec, et ne jamais résoudre des migrations depuis le manifeste ou le réseau.
- Le module documente les prérequis, l'ordre, la compatibilité, les effets de bord, et une stratégie de rollback/restore testée avant tout statut `verified`. Une migration destructive sans récupération documentée est refusée.

Aucun schéma métier Project3, politique RLS, migration ou modèle de données spécifique n'est défini ni incorporé ici.

## Tests et erreurs

Chaque module généré inclut ses tests déclarés dans son catalogue de sources et teste au minimum les paramètres invalides, les refus d'accès, les limites et l'isolation tenant applicable. Une absence de TenantContext bloque l'opération avant toute lecture/écriture. La génération n'exécute pas de tests, scripts, hooks ou code déclarés dans un descripteur ; l'exécution des tests générés demeure un contrôle explicite du projet.

Les erreurs de schéma/chemin bloquent la génération sans écriture partielle. En cas d'échec de génération, aucun résultat existant n'est remplacé ; le rollback du présent contrat est la suppression de sa sélection/version et de son code local, sans migration automatique ni effet distant.

## Vérification de maturité

Un module ne peut se déclarer `verified` que si ses preuves explicites sont associées à sa version exacte et à sa portée. Vérifier séparément tests, contrôles tenant, génération indépendante, limites, migration et retour arrière pertinents. Tests simulés, disponibilité d'un fournisseur, succès CI ou simple présence d'un fichier ne prouvent pas à eux seuls une capacité de production.
