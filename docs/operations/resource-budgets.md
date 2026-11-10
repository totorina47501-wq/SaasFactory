# Budgets de ressources locaux

## Limites documentées par les modules

Ces valeurs sont les valeurs par défaut du code actuel, pas une promesse de
capacité d'une application générée ni un quota imposé au système d'exploitation.
Une configuration peut les réduire ou les augmenter dans les plafonds du contrat.

| Composant | Limite par défaut | Application et limite |
| --- | --- | --- |
| Jobs | 1 000 jobs actifs ; 2 workers ; 3 tentatives ; payload 64 KiB ; stockage JSON 64 MiB | File et stockage locaux bornés. CPU 60 s/job et RSS 512 MiB/job sont des mesures indicatives au niveau du processus. |
| Index RAG local | 1 000 documents ; 5 000 chunks/document ; stockage index 32 MiB | Le module refuse un index qui dépasse sa limite ; un embedder CPU local n'est pas téléchargé par les tests. |
| Audit local | segment 256 KiB ; 10 fichiers ; rétention par défaut 30 jours | Rotation/purge locales ; changer les paramètres seulement après décision de conservation. |
| PostgreSQL | Pas de taille maximale de dump configurée par ce module | Prévoir place pour l'archive, les fichiers temporaires et la base cible complète ; une erreur disque doit arrêter le backup et supprimer son résultat partiel. |

Les budgets jobs CPU/RAM produisent `job.resource-budget-exceeded` après mesure,
mais ne terminent pas le handler. Les timeouts sont des signaux coopératifs. Le
module ne configure ni ne détecte cgroups, quotas de conteneur ou limites de
processus OS. Ne pas présenter ces limites comme une protection contre une charge
non coopérative.

## Mesure synthétique reproductible

Exécution de référence effectuée le 2026-11-10 dans le sandbox local de la
Factory, sur Node.js `v22.23.4`, `linux/x64`. Mesure capturée par le test
`tests/operations/operations.test.mjs` :

| Mesure d'une exécution | Résultat observé |
| --- | ---: |
| Parallélisme rapporté par Node | 4 CPU |
| Mémoire totale rapportée par Node | 16 760 344 576 octets |
| État synthétique (dump + jobs + index) | 3 080 octets |
| Durée du scénario backup/restore et vérifications | 134,1 ms |
| RSS à la fin / variation depuis le départ du test | 69 218 304 / 17 461 248 octets |
| Segments d'audit conservés avant purge | 3 |
| Jobs repris / résultats de recherche restaurés | 1 / 1 |

Il s'agit d'une observation d'un seul test de petite taille, pas d'un benchmark,
pas d'une mesure PostgreSQL réelle et pas d'une capacité de production. Les
ressources disponibles dans un autre runner, OS, conteneur ou hôte diffèrent.
Relancer avec :

```sh
node --test tests/operations/operations.test.mjs
```

Le test journalise les mêmes mesures au format JSON dans la sortie TAP. Pour une
application indépendante, mesurer plusieurs charges synthétiques représentatives
et leurs p95/pics dans son propre environnement local avant de choisir des
budgets. Ne pas saturer physiquement un runner partagé : le test impose des seuils
jobs synthétiques de 1 ms et 1 octet, une allocation bornée de 1 MiB et une
simulation `ENOSPC`, sans épuiser le CPU, la RAM ou le système de fichiers de
l'hôte.

## Règles d'exploitation

- Respecter les limites actuelles d'abord ; augmenter une limite seulement avec
  tests de taille, espace temporaire suffisant et vérification de restauration.
- Réserver au moins la place nécessaire pour archive + base restaurée + marge
  temporaire et fonctionnement du système ; aucun ratio universel n'est garanti
  par les mesures synthétiques.
- Sur `STORAGE_LIMIT`, `ENOSPC` ou dépassement ressources, refuser de nouvelles
  charges et investiguer localement. Ne pas supprimer automatiquement les états
  ou backups.
- Faire tourner et purger les logs selon une rétention décidée ; sauvegarder
  avant la purge de la file, car celle-ci efface aussi les clés d'idempotence.
- Aucun monitoring tiers n'est requis. Utiliser les diagnostics exposés par les
  modules, les outils du système local et les logs expurgés ; ne pas exporter de
  secrets ou données utilisateur.
