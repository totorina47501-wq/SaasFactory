# Opérations PostgreSQL locales — contrat v1

**Module :** `database-operations@1.0.0` · **Contrat :** `1`  
**API :** `createBackup`, `restoreBackup` · **Format :** archive PostgreSQL custom, avec manifeste JSON versionné.

Le module utilise les outils PostgreSQL locaux `psql`, `pg_dump`, `createdb` et
`pg_restore`. Il n'ajoute pas de pilote, ne contacte aucun service distant et
refuse toute connexion dont l'hôte n'est pas `localhost`, `127.0.0.1` ou `::1`.
Les sauvegardes peuvent contenir toutes les données du schéma choisi : elles
doivent être traitées comme des données sensibles et conservées dans un
emplacement protégé.

## Préconditions et API

Le schéma doit avoir été migré par `modules/database/` et contenir les journaux
`schema_migrations` et `module_migrations`. Les appels refusent les propriétés
inconnues, les identifiants PostgreSQL dangereux, les chemins relatifs, les
liens symboliques, les destinations déjà présentes et les restaurations dans la
base source.

```js
import {
  createBackup,
  restoreBackup,
} from './modules/database-operations/index.mjs';

const connection = {
  host: '127.0.0.1',
  port: 55432,
  user: 'factory_test',
  password: process.env.POSTGRES_PASSWORD,
  database: 'factory_test',
};

const backup = await createBackup({
  connection,
  schemaName: 'atelier_app',
  destination: '/var/tmp/atelier-app-backup-2026-11-09',
});

await restoreBackup({
  connection,
  backupDirectory: backup.destination,
  targetDatabase: 'atelier_app_restore_20261109',
});
```

Le répertoire de sauvegarde doit être neuf et son parent doit exister. Il est
créé en mode `0700`; l'archive et le manifeste sont en `0600`. Le mot de passe
n'est ni placé dans les arguments de processus, ni inclus dans les métadonnées
ou les erreurs. Il est écrit temporairement dans un fichier `pgpass` privé
(`0600`), puis supprimé. Les sorties d'erreur des outils PostgreSQL sont
ignorées ; les erreurs publiques ont des codes stables via
`DatabaseOperationsError.code`.

Une sauvegarde contient uniquement `backup.pgdump` et `manifest.json`. Le
manifeste comprend les versions du contrat et du module, la version du serveur,
le schéma source, l'horodatage UTC, les versions/checksums des migrations core et
modules, ainsi que la taille et le SHA-256 de l'archive. Les migrations sont
lues avant et après `pg_dump`; si leur historique évolue pendant l'opération,
la sauvegarde est refusée et le répertoire partiel supprimé.

## Restauration, intégrité et compatibilité

La restauration vérifie les permissions, le format du manifeste, la version de
contrat/module, la taille et le SHA-256, puis demande à `pg_restore` de valider
l'archive. Elle crée une **nouvelle base PostgreSQL** au nom demandé ; `createdb`
refuse une base déjà existante. Le schéma sauvegardé garde son nom d'origine.
La restauration utilise `--single-transaction`, `--no-owner` et `--no-acl` ; elle
n'utilise jamais `--clean`, `--create`, `dropdb` ou une migration descendante.
Les données existantes ne sont ni remplacées ni supprimées.

La restauration n'exécute pas de migration. La version majeure du client
PostgreSQL doit être compatible avec l'archive et le serveur ; toute incompatibilité
ou erreur d'outil échoue sans révéler ses détails. Une interruption de sauvegarde
supprime son répertoire partiel. Une interruption de restauration ne supprime
pas la base cible : la transaction d'import est rollbackée par PostgreSQL, mais
la base créée peut rester vide. Inspectez-la avant toute action manuelle ; ne
réutilisez pas son nom pour une nouvelle tentative.

## Procédure de rollback

1. Arrêter les écritures de l'application et préserver la base source.
2. Créer une sauvegarde et restaurer dans un nom de base inédit.
3. Vérifier les migrations, les données synthétiques attendues et les tests du
   module/application contre cette base isolée.
4. Basculer explicitement la configuration de l'application uniquement après
   validation.
5. Garder la base précédente intacte jusqu'à la décision explicite de fin de
   rollback. Sa suppression est une opération distincte, jamais exécutée par
   ce module.

Les migrations du module `database` restent immuables : ajouter une migration
nécessite un backup vérifié et des tests de restauration. En cas d'échec,
revenir à la configuration de base précédente ; ne pas tenter de « downgrade »
automatique.

## Tests locaux

Les tests unitaires utilisent des exécuteurs factices et des archives synthétiques
pour vérifier le manifeste, l'intégrité, les permissions, les migrations, les
chemins, les erreurs, les répétitions et les interruptions. L'intégration
PostgreSQL réelle est activée seulement avec une base **jetable** explicitement
locale, dotée des privilèges `CREATE DATABASE` et `DROP DATABASE` :

```sh
export POSTGRES_PASSWORD=local-test-only
docker compose -f modules/database/compose.yaml up -d --wait
DATABASE_URL="postgres://factory_test@127.0.0.1:55432/factory_test" \
  PGPASSWORD="$POSTGRES_PASSWORD" \
  node --test tests/database-operations.test.mjs
docker compose -f modules/database/compose.yaml down -v
unset POSTGRES_PASSWORD
```

Sans `DATABASE_URL` local, le test PostgreSQL est ignoré ; aucun serveur ou
fournisseur distant n'est utilisé par les tests.
