# Module PostgreSQL local — contrat v1

**Version du module :** `1.0.0` · **API :** `runMigrations`, `seedSynthetic`,
`createDatabaseAdapter` · **Statut :** `implemented` pour l'adaptateur et les
migrations locales ; l'application doit fournir son propre pool PostgreSQL.

Ce module est une source Factory isolée. Il ne configure ni ne contacte un
service distant, n'ajoute pas de dépendance à la racine Factory et ne génère pas
de compte, mot de passe ou donnée réelle. Le projet qui l'intègre choisit son
propre schéma PostgreSQL, son pool et son cycle de vie.

## Migrations et données

Les migrations immuables sont dans `modules/database/migrations/` et suivent
`NNNN_<slug>.sql`. La version 1 crée les organisations, utilisateurs,
appartenances et événements d'audit ; la version 2 ajoute le stockage local,
l'espace de données namespacé des modules et les règles RLS. Les tables
d'appartenance ont des clés étrangères et une clé primaire composite. Les
emails sont uniques sans distinction de casse dans un schéma. Les événements
d'audit sont append-only. Les journaux `schema_migrations` du schéma commun et
`module_migrations` des extensions stockent versions, identifiants et SHA-256.
Modifier une migration appliquée, omettre une extension déjà migrée ou
rencontrer une erreur bloque la transaction entière. Les anciennes lignes
d'extension présentes dans `schema_migrations` sont reconnues par version,
identifiant et checksum, puis transférées de façon atomique au journal des
modules.

Chaque déploiement choisit un `schemaName` neuf, en minuscules ASCII et
distinct des schémas système. Les identifiants sont validés avant leur
interpolation SQL ; les valeurs sont toujours des paramètres liés. L'isolation
des lignes est appliquée par tenant au moyen de `app.tenant_id`, défini avec
`SET LOCAL` dans la transaction. L'adaptateur filtre aussi toutes ses requêtes
par tenant. `TenantContext` reprend le contrat runtime v1 :
`{ contractVersion: 1, tenantId, requestId }`; tout contexte absent, invalide ou
avec champ supplémentaire est refusé avant l'accès à la base.

RLS protège contre les erreurs d'accès accidentelles, pas contre une injection
SQL ou un client arbitraire pouvant définir son propre `app.tenant_id`. Le rôle
runtime doit être un rôle dédié, non propriétaire, non-superuser et sans
`BYPASSRLS`, avec les seuls droits nécessaires, sans privilège `TRUNCATE` sur
`audit_events`. N'utilisez jamais le rôle de migration/propriétaire au runtime.
Les migrations d'extension sont fournies uniquement comme SQL local statique
et relu via `extensionMigrations`, avec `{ moduleId, version, id, sql }`.
Chaque module possède sa séquence d'entiers contigus indépendante, commençant
à `1` ; deux modules peuvent donc évoluer sans collision avec le schéma commun
ou entre eux. Pour reprendre l'ancien format sans `moduleId`, conservez sa
séquence globale commençant après le schéma commun (`3`) ; elle est enregistrée
sous `legacy-extension`. Ne construisez jamais les migrations à partir de la
configuration utilisateur ou du réseau.

`targetVersion` borne les migrations du schéma commun ; une cible inférieure à
la version commune courante n'exécute aucune nouvelle migration d'extension.
À la cible commune courante, toutes les migrations d'extension fournies sont
appliquées par défaut. `extensionTargets` peut borner chaque module par son ID
et sa version maximale (une cible `0` n'en applique aucune) ; une cible
d'extension non nulle exige que le schéma commun soit à sa version courante.
Une cible plus basse n'annule jamais une version déjà appliquée.

`seedSynthetic` insère des données fixes et idempotentes (`.invalid`, aucun
secret). Il ne met jamais à jour ou ne remplace un enregistrement existant.
L'adaptateur implémente `LocalStorage` (`get`, `put`, `delete`) avec versions
optimistes ainsi que `AuditSink.append`. Les valeurs sont du JSON borné et les
champs/données d'audit qui ressemblent à des secrets sont refusés. Les erreurs
renvoyées sont des `DatabaseModuleError` avec codes stables, sans SQL, valeur
fournie ni message du pilote.

## Exemple d'intégration

L'application indépendante installe et configure son pilote (`pg` par exemple)
séparément ; le module ne l'importe pas :

```js
import { createDatabaseAdapter, runMigrations } from './modules/database/index.mjs';
import { Pool } from 'pg';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
await runMigrations(pool, 'atelier_app');
const storage = createDatabaseAdapter({ pool, schemaName: 'atelier_app' });
const context = {
  contractVersion: 1,
  tenantId: 'tenant-atelier',
  requestId: 'request-123',
};
await storage.put(context, 'preferences', { language: 'fr-FR' });
```

Le contexte doit provenir d'une frontière d'authentification fiable ; le module
ne fournit pas l'authentification et ne transforme pas une valeur de requête
client en tenant autorisé. Le pool doit utiliser TLS uniquement lorsqu'il se
connecte à un serveur configuré séparément ; aucune connexion distante n'est
créée par ce dépôt.

## PostgreSQL local optionnel

Docker Compose démarre uniquement PostgreSQL 16, publié sur `127.0.0.1:55432`.
Utilisez un mot de passe jetable pour cette base locale :

```sh
export POSTGRES_PASSWORD=local-test-only
docker compose -f modules/database/compose.yaml up -d --wait
DATABASE_URL="postgres://factory_test@127.0.0.1:55432/factory_test" \
PGPASSWORD="$POSTGRES_PASSWORD" \
  node --test tests/database.test.mjs
docker compose -f modules/database/compose.yaml down -v
unset POSTGRES_PASSWORD
```

Sans `DATABASE_URL` vers `localhost`, la suite reste hors réseau et ignore
explicitement le test PostgreSQL. L'intégration utilise un schéma et un rôle
aléatoires dédiés qu'elle supprime à la fin ; ne la lancez que sur la base de
test jetable Compose. Commandes sans base locale :

```sh
node --test tests/database.test.mjs
npm test
```

## Échec, rollback et compatibilité

Les migrations s'exécutent en transaction avec verrou consultatif par schéma ;
un échec provoque un rollback avant tout succès déclaré. Le runner ne propose
aucune migration descendante automatique : supprimer des tables pourrait
détruire des données. Avant une évolution, sauvegardez et vérifiez la
restauration dans un schéma neuf. En cas d'incident, arrêtez les écritures,
restaurez la sauvegarde vérifiée dans un nouveau schéma puis basculez
explicitement la configuration après validation. Ne modifiez jamais un fichier
de migration déjà appliqué ; ajoutez une nouvelle version.
