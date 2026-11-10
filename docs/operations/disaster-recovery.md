# Plan de reprise après incident — local

## Objectif, limites et données

Le plan restaure dans un emplacement neuf, sans écrasement ni suppression de la
source. Il couvre la base PostgreSQL via `database-operations@1.0.0` et les
répertoires persistants locaux choisis par l'application (jobs, index, audit ou
stockage privé). Le dépôt ne fournit pas un orchestrateur de backup applicatif :
la sélection et la copie cohérente de ces répertoires restent propres à chaque
application. N'inclure ni secrets, ni données client dans l'exercice synthétique.

L'acceptance `tests/operations/operations.test.mjs` exerce cette procédure avec
un dump synthétique et un exécuteur PostgreSQL simulé, une copie de fichiers,
une file/job et un index de recherche persistants. Cela vérifie le contrat local,
pas une base PostgreSQL réelle, un déploiement, un SLA ou une restauration
production. Pour une intégration réelle, utiliser uniquement le conteneur
jetable local décrit dans
[le contrat PostgreSQL](../modules/database-operations.md#tests-locaux).

Les objectifs RPO/RTO ne sont pas définis ni mesurés par le dépôt. Le propriétaire
de l'application doit les décider, mesurer la taille réelle, la durée de dump et
restauration et l'espace temporaire disponible avant de publier un plan de service.

## Sauvegarde cohérente

1. Arrêter l'admission des écritures et les workers ; attendre la fin des handlers
   et transactions. Garder la configuration précédente.
2. Appeler `createBackup()` avec une connexion locale (`localhost`, `127.0.0.1`
   ou `::1`), un schéma connu et un répertoire neuf. Le contrat refuse les
   destinations existantes/symlinks et produit un manifeste contrôlé et une
   archive PostgreSQL privée (`0700`/`0600`).
3. Copier les répertoires persistants (jobs, index et audit, plus les données
   privées de l'application si elles existent) vers un répertoire de sauvegarde
   neuf, chiffré/protégé selon la politique locale. L'opération doit se faire
   pendant que leurs writers sont arrêtés. Le répertoire jobs inclut les états,
   leases, événements et clés d'idempotence ; l'index doit rester cohérent avec
   ses sources.
4. Vérifier les fichiers, permissions, checksum de l'archive et inventaire des
   modules/configuration. Conserver l'ensemble base + fichiers comme un même point
   de restauration ; une archive DB seule ne contient pas l'état fichiers.
5. Redémarrer les services uniquement après une sauvegarde complète ou un
   abandon explicite de l'opération.

Ne pas modifier `manifest.json`, renommer une archive ou relancer par-dessus une
destination. Une nouvelle sauvegarde prend un nouveau chemin. Protéger les
copies comme des données sensibles, restreindre leurs permissions et appliquer
une rétention décidée par le propriétaire.

## Restauration contrôlée

1. Déclarer l'incident, arrêter les écritures/workers et préserver tous les
   répertoires et bases sources. Ne pas lancer deux récupérations concurrentes.
2. Contrôler la compatibilité versions/contrats, permissions, manifeste, taille et
   SHA-256. `restoreBackup()` vérifie aussi l'archive puis crée une base cible
   neuve. Choisir un identifiant inédit ; ne jamais restaurer dans la base source.
3. Restaurer les répertoires d'application depuis la même sauvegarde vers des
   chemins neufs, privés et vides. Ne pas copier par-dessus un répertoire actif.
   Une archive fichier seule ne garantit pas la cohérence si les workers n'étaient
   pas arrêtés pendant sa capture.
4. Lancer les vérifications hors trafic : migrations/checksums, readiness,
   intégrité queue/index, nombre d'éléments synthétiques attendus et recherche de
   citation. Vérifier qu'un job en attente reprend une seule fois du point de vue
   de son effet idempotent.
5. Basculer explicitement l'application vers la nouvelle base et les nouveaux
   répertoires seulement après validation. Conserver les sources intactes jusqu'à
   la décision de clôture.

La restauration d'une sauvegarde de jobs peut remettre en file un job déjà exécuté
après l'instant sauvegardé. Les handlers doivent être idempotents et tout effet
externe doit être vérifié avant reprise. Si une restauration s'interrompt, la
transaction de PostgreSQL est annulée mais la base cible neuve peut rester vide ;
inspecter cette cible puis choisir un autre nom pour un nouvel essai. Ne jamais
la supprimer automatiquement.

## Échecs et reprise

| Signal | Réponse |
| --- | --- |
| `BACKUP_INTEGRITY_FAILED`, `INVALID_BACKUP`, `INCOMPATIBLE_BACKUP` | Arrêter avant import, préserver la source, rechercher une autre sauvegarde vérifiée ; ne pas éditer le manifeste. |
| `ENOSPC` / `BACKUP_FAILED` | Libérer ou provisionner explicitement de l'espace, vérifier la suppression du répertoire partiel, puis relancer vers un chemin neuf. |
| `RESTORE_FAILED` / outil PostgreSQL absent | Vérifier les outils et versions localement, permissions et logs locaux ; ne pas exposer les diagnostics contenant données ou secrets. |
| `CORRUPT_QUEUE`, `CORRUPT_INDEX` | Échouer fermé. Restaurer la copie vérifiée ou reconstruire l'index depuis les sources vérifiées au moyen du module prévu ; ne pas éditer JSON ou ignorer l'erreur. |
| `STORAGE_LIMIT`, `job.resource-budget-exceeded` | Stopper les nouvelles charges, examiner la limite et les diagnostics locaux. L'événement CPU/RAM est indicatif et ne coupe pas le handler. |
| Lease expiré ou handler interrompu | Vérifier l'absence de worker actif, vérifier l'idempotence des effets, puis laisser le module reprendre selon le nombre de tentatives autorisé. |

Une migration appliquée n'est jamais inversée automatiquement. En cas de
régression applicative, garder la base migrée, revenir au code compatible, ou
restaurer dans une base neuve le backup vérifié puis basculer après recette. Toute
purge de source, de backup ou de base est une décision opérateur séparée.

## Exercice reproductible et preuves

Depuis la racine du dépôt, sur Node.js `>=22.12.0 <27` :

```sh
node --test tests/operations/operations.test.mjs
node --test tests/database-operations.test.mjs tests/jobs.test.mjs \
  tests/observability.test.mjs tests/rag-search.test.mjs
```

Le premier test affiche sa version Node, plateforme, capacité CPU/RAM rapportée
par Node, volume synthétique, durée et variation de RSS observées. Les faux
exécuteurs rendent les cas `ENOSPC` et corruption déterministes sans altérer un
disque. Les tests ne contactent ni service distant, ni monitoring tiers, ni
fournisseur payant. Une réussite ne constitue pas une preuve de reprise
PostgreSQL réelle ou de production ; la CI doit aussi être verte sur le commit
final avant toute décision humaine.
