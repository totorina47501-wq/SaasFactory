# Runbook d'exploitation locale

## Portée et prérequis

Cette procédure exploite les modules Factory locaux ; elle ne décrit pas une
application SaaS déployée. Elle n'active aucun fournisseur et n'envoie aucune
donnée à un service de monitoring. L'exercice d'intégration utilise uniquement
des identifiants, archives et contenus synthétiques.

Prérequis : Node.js `>=22.12.0 <27` et les sources du dépôt. Docker Compose et les
outils PostgreSQL sont nécessaires uniquement à l'intégration PostgreSQL réelle
optionnelle. Ne passez à ces outils qu'avec le conteneur local de
`modules/database/compose.yaml`, jamais avec une base distante.

```sh
node --version
node --test tests/operations/operations.test.mjs
npm test
```

Le premier test est autonome et hors réseau. Il sauvegarde/restaure une base
synthétique par exécuteur simulé, copie l'état local des jobs, de l'index et des
journaux, puis vérifie la reprise d'un job, une recherche indexée, la rotation et
la purge. Il simule une archive corrompue, `ENOSPC` et des dépassements contrôlés
de budgets CPU/RAM. Il ne remplit pas réellement un disque et ne sature pas la
machine. Le test PostgreSQL réel existant est distinct et ignoré sans
`DATABASE_URL` strictement local : voir
[opérations PostgreSQL](../modules/database-operations.md#tests-locaux).

## Diagnostic

1. **Vérifier le processus et l'environnement.** Inspecter la version de Node,
   `environmentDiagnostics()` et `liveness()` du module
   `modules/observability/`. La liveness ne certifie pas l'accès aux dépendances.
2. **Vérifier les dépendances locales.** Pour le conteneur de test uniquement :

   ```sh
   docker compose -f modules/database/compose.yaml ps
   docker compose -f modules/database/compose.yaml logs --tail=100 postgres
   ```

   Un conteneur sain doit réussir son `pg_isready` local. Examiner les codes
   d'erreur applicatifs et `readiness()` ; cette dernière retourne seulement
   l'état `ok`/`unavailable` de la base et des jobs. Ne pas journaliser URL,
   mot de passe, contenu de job, payload ou trace de pilote.
3. **Vérifier la file.** Employer `jobs.list()` et `jobs.events()` dans le contexte
   tenant autorisé. Les payloads ne sont pas retournés. `CORRUPT_QUEUE`,
   `STORAGE_LIMIT`, `QUEUE_BUSY` ou `LOCK_RECOVERY_REQUIRED` sont des états à
   diagnostiquer ; ne pas éditer `jobs-v1.json` à la main.
4. **Vérifier l'index et l'audit.** Refaire une requête locale synthétique par le
   service de recherche et vérifier le statut autorisé des documents. Une erreur
   `CORRUPT_INDEX` ne déclenche pas de reconstruction silencieuse. Les événements
   d'audit sont tenant-scopés et l'accès de lecture doit être explicitement
   autorisé.
5. **Comparer les versions.** Relever les versions de modules et de contrats
   exportées par les modules concernés et les versions/checksums enregistrées
   dans `manifest.json` de sauvegarde. Une sauvegarde incompatible doit échouer
   fermée ; ne pas la modifier pour contourner cette vérification.

`observabilityContract.remoteMonitoring` est `false`. Les diagnostics disponibles
sont locaux ; aucun agent, exporteur tiers, collecte à distance ou endpoint
public de métriques n'est requis.

## Arrêt propre et reprise des workers

1. Arrêter les nouvelles requêtes et nouvelles écritures par le superviseur local
   de l'application.
2. Demander l'arrêt aux workers avec leur `AbortSignal`, attendre la fin des
   handlers coopératifs et confirmer qu'aucun job n'est encore actif. Un handler
   synchrone bloquant ou ignorant le signal n'est pas tué de force par le module.
3. Fermer les pools de base applicatifs et laisser PostgreSQL arrêter ses
   transactions. Ne pas supprimer un lease ou verrou possédé.
4. Sauvegarder la base ainsi que les répertoires locaux persistants pertinents,
   après arrêt des écritures. Garder les sources intactes jusqu'à validation de la
   restauration.
5. Pour le conteneur PostgreSQL local de test seulement, `docker compose ... stop
   postgres` l'arrête sans supprimer son volume. `down -v` est destructif et ne
   convient qu'à une réinitialisation explicitement voulue de cette base jetable.

Après reprise, redémarrer les services, vérifier la readiness, inspecter les
jobs en attente/expirés, puis lancer un petit job idempotent explicitement
autorisé. Un job repris peut avoir déjà produit un effet avant le crash : les
handlers doivent être idempotents.

## Mise à niveau et rollback

### Modules

1. Relever les versions de module/contrat, la configuration et les limites en
   vigueur. Ne pas mettre à niveau implicitement un contrat ou une dépendance.
2. Arrêter les writers, créer une sauvegarde vérifiée et exécuter au minimum :

   ```sh
   node --test tests/operations/operations.test.mjs
   node --test tests/database-operations.test.mjs tests/jobs.test.mjs \
     tests/observability.test.mjs tests/rag-search.test.mjs
   ```
3. Valider sur une copie restaurée. Garder les répertoires et la configuration
   antérieurs en lecture seule jusqu'au feu vert explicite.
4. En cas d'échec, arrêter les workers et remettre le code/configuration du module
   précédent avec ses contrats compatibles ; restaurer les fichiers persistants
   dans un nouveau répertoire plutôt que d'écraser la source.

### Base et migrations

Les migrations appliquées sont immuables et il n'existe pas de downgrade
automatique. Avant une migration, sauvegarder et restaurer dans une base neuve,
puis vérifier les versions/checksums et tests applicatifs. Si la migration échoue,
la transaction doit être annulée. Si elle a réussi mais que l'application ne
fonctionne pas, revenir au code compatible et garder la base migrée préservée ;
ne pas exécuter une migration descendante. Pour revenir aux données précédentes,
restaurer le backup vérifié dans un nom de base inédit, valider, puis basculer
explicitement la configuration. Les anciennes bases ne sont supprimées qu'après
décision opérateur distincte.

## Purge et rétention

- Les journaux d'audit tournent par taille, nombre de segments et durée configurés
  dans `modules/observability/`. `cleanup()` purge seulement ce que ces limites
  autorisent. L'exercice confirme un maximum de trois segments et purge des
  événements arrivés à échéance.
- Les jobs terminaux et leurs clés d'idempotence persistent. La limite de stockage
  produit `STORAGE_LIMIT`; la purge du répertoire jobs est une action manuelle
  destructive qui efface aussi l'historique et l'idempotence. Arrêter les workers
  et faire un backup avant toute purge.
- La durée de conservation des données applicatives n'est pas universelle : fixer
  les paramètres pour l'application indépendante, les exigences légales et les
  sauvegardes avant toute utilisation réelle. Le présent exercice ne manipule
  aucune donnée réelle.

Les budgets par défaut et la mesure d'une exécution synthétique sont détaillés
dans [budgets matériels](resource-budgets.md). Les limites CPU/RAM des jobs sont
des alertes de dépassement observé, non des quotas OS ni un mécanisme d'arrêt.
