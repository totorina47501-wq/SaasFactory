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
d'audit sont append-only. Le journal de migration stocke version, identifiant
et SHA-256 ; une migration appliquée modifiée, inconnue ou en échec bloque la
transaction entière.

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
`BYPASSRLS`, avec les seuls droits nécessaires. N'utilisez jamais le rôle de
migration/propriétaire au runtime. Les migrations d'extension sont fournies
uniquement comme SQL local statique et relu via `extensionMigrations`, avec des
versions entières uniques contiguës après le schéma commun ; ne les construisez
jamais à partir de la configuration utilisateur ou du réseau.

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
DATABASE_URL="postgres://factory_test:${POSTGRES_PASSWORD}@127.0.0.1:55432/factory_test" \
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
