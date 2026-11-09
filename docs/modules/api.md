# API REST locale versionnée — contrat v1

**Version :** `1.0.0` · **API :** `createApiService`,
`createMemoryApiStore`, `createPostgresApiStore`, `runApiMigrations` ·
**Statut :** implémentation locale, sans serveur HTTP ni fournisseur distant.

## Portée et préconditions

Le module expose un dispatcher HTTP indépendant du framework. L’application
locale adapte une requête HTTP à `dispatch({ method, path, headers, query,
body, requestId })` et sérialise la réponse `{ status, headers, body }`. Les
champs inconnus sont refusés ; `method`, `path` et `headers` sont requis.
`requestId` est facultatif et généré localement s’il est absent. Toutes les
réponses d’erreur ont la forme stable `{ error: { code } }`, sans détails du
stockage ni valeurs soumises.

Avant le module API, exécuter Database, Auth, Tenancy et Entitlements sur le
même schéma PostgreSQL local :

```js
import { createApiService, createPostgresApiStore, runApiMigrations } from './modules/api/index.mjs';

await runApiMigrations(pool, 'atelier_app');
const api = createApiService({
  store: createPostgresApiStore({ pool, schemaName: 'atelier_app' }),
  auth,
  entitlements,
  authorize: async ({ actorId, tenantId, permission }) =>
    await localTenantAuthorization({ actorId, tenantId, permission }),
  listMembers: async ({ tenantId, actorId, limit, cursor, requestId }) =>
    await tenancyMemberPage({ tenantId, actorId, limit, cursor, requestId }),
  origin: 'http://localhost:3000',
  webhookSecret: process.env.LOCAL_WEBHOOK_SECRET,
});
```

Le secret HMAC local doit contenir au moins 32 octets et n’est jamais écrit
dans la base, la réponse, ni les journaux. Il n’est ni fourni par ce dépôt ni
communiqué à un service distant. Les magasins mémoire sont réservés aux tests
et aux démonstrations éphémères ; ils ne fournissent pas de rate limiting ou
d’anti-rejeu persistant entre processus.

`authorize` est une frontière serveur de confiance : elle retourne strictement
`true` après avoir vérifié l’appartenance actuelle au tenant et la permission
demandée. Une erreur ou autre réponse refuse l’opération. `listMembers` doit
réutiliser la vérification d’appartenance/ACL de Tenancy, filtrer toutes les
requêtes par tenant, et respecter la limite et le curseur reçus. Ces fonctions
ne doivent jamais faire confiance à un `actorId`, rôle ou contexte fourni par
un client. Le module rejette les schémas de réponse inattendus.

`origin` est l’origine canonique exacte de l’application cliente (HTTPS, ou
HTTP uniquement sur loopback local). Les mutations authentifiées par cookie
exigent un en-tête `Origin` égal à cette valeur. Le GET de métadonnées accepte
l’absence d’`Origin` pour les navigateurs same-origin, mais rejette toute
valeur présente qui ne correspond pas. Les contrôles SameSite du cookie ne
remplacent pas cette vérification CSRF.

## Routes REST v1 et OpenAPI

Le document JSON servi par `GET /v1/openapi.json` est construit depuis le même
catalogue de routes que le dispatcher. Les schémas de requête/réponse
interdisent les propriétés supplémentaires ; le document décrit les
authentifications, statuts et limites.

| Méthode et route | Authentification | Comportement |
| --- | --- | --- |
| `GET /v1/openapi.json` | Aucune | Document OpenAPI 3.1 local. |
| `GET /v1/tenants/{tenantId}/members?limit=&cursor=` | Clé `members:read` | Page de membres via le callback ACL Tenancy ; `limit` entre 1 et 100, défaut 50. |
| `GET /v1/tenants/{tenantId}/api-keys` | Session Auth, permission `api.keys.manage` | Métadonnées des clés créées par l’acteur, jamais le secret. |
| `POST /v1/tenants/{tenantId}/api-keys` | Session Auth, permission `api.keys.manage` | Crée une clé, retourne le jeton une seule fois. Corps exact : `name`, `scopes`, `expiresAt`. |
| `DELETE /v1/tenants/{tenantId}/api-keys/{keyId}` | Session Auth, permission `api.keys.manage` | Révoque uniquement une clé appartenant à l’acteur courant et au tenant. Répétable. |
| `POST /v1/tenants/{tenantId}/webhooks/simulate` | Clé `webhooks:simulate` | Retourne un événement local signé ; aucun appel HTTP ni livraison n’est exécuté. |
| `POST /v1/webhooks/verify` | Clé `webhooks:verify` | Vérifie la signature, la fenêtre temporelle et consomme le nonce une seule fois. |

Une clé a un identifiant UUID public et un secret aléatoire de 256 bits. Seul
le SHA-256 du jeton complet est conservé. Le jeton est de la forme
`sfk_<id>.<secret>`, ne peut être lu à nouveau, et ne doit pas être journalisé.
Les scopes autorisés sont `members:read`, `webhooks:simulate` et
`webhooks:verify` ; chaque scope est accordé seulement si `authorize` valide
la permission correspondante lors de la création **et** de chaque utilisation.
Une clé appartient à un acteur et un tenant, expire au plus tard un an après sa
création (ou peut être sans expiration avec `null`) et est refusée après
expiration ou révocation. L’appartenance et les permissions sont revalidées à
chaque requête, donc une révocation de rôle prend effet sans recréer la clé.

Les appels authentifiés vérifient le flag `api.access` et réservent/consomment
`api.requests` par l’API Entitlements. Toute erreur d’entitlement échoue en
mode fermé. Le rate limit persistant est de 120 appels par clé ou session et
par fenêtre glissante de 60 secondes par défaut ; `rateLimit` peut le régler
entre 1 et 10 000. Le compteur PostgreSQL est atomique entre processus. Les
appels OpenAPI ne sont pas authentifiés ni comptabilisés.

## Webhooks simulés

Le simulateur n’accepte aucun endpoint, URL, hôte, port ni callback réseau :
une donnée comme `http://127.0.0.1` reste uniquement une donnée de payload et
n’est jamais interprétée ou contactée. L’événement est un JSON de profondeur
maximale 16 et de taille maximale 64 KiB, sérialisé canoniquement (clés
triées). La signature est HMAC-SHA-256 du JSON UTF-8 produit par
`JSON.stringify([tenantId, timestamp, nonce, event, payloadCanonical])`,
préfixée par `sha256=`. Le tableau ordonné rend les champs non ambigus.

La vérification compare les MAC en temps constant, n’accepte qu’un écart
temporel maximal de cinq minutes, puis inscrit atomiquement
`(tenantId, nonce)` dans le magasin. Une vérification répétée échoue avec
`WEBHOOK_REPLAYED`. Les nonces expirés sont nettoyés en lots bornés. Ces
événements ne constituent pas une livraison à un consommateur externe.

## Erreurs et compatibilité

Codes stables : `INVALID_INPUT`, `INVALID_CONFIGURATION`,
`INVALID_SESSION`, `INVALID_API_KEY`, `API_KEY_REVOKED`, `API_KEY_EXPIRED`,
`FORBIDDEN`, `ORIGIN_REJECTED`, `NOT_FOUND`, `RATE_LIMITED`, `FEATURE_DISABLED`,
`LIMIT_EXCEEDED`, `INVALID_WEBHOOK`, `WEBHOOK_REPLAYED` et `UNAVAILABLE`.
Les statuts HTTP correspondants sont définis par le module. Les erreurs
inconnues et les erreurs des callbacks sont ramenées à `UNAVAILABLE`.

Les tables `api@1` sont additives : `api_keys`, `api_rate_limits` et
`api_webhook_replays`. Les requêtes clés sont paramétrées, le schéma SQL est
validé et les lectures/mutations de clés filtrent explicitement par tenant et
acteur. Utiliser un rôle PostgreSQL runtime local limité. Le rollback consiste
à arrêter l’adaptateur API ; conserver les tables et leurs données, ne pas
supprimer les clés, compteurs ou marqueurs anti-rejeu implicitement.

## Vérification hors ligne

```sh
node --test tests/api.test.mjs
npm test
```

Les tests utilisent des magasins et services locaux simulés. Ils ne prouvent
pas une exécution réelle de PostgreSQL, une intégration dans un serveur HTTP,
ni une livraison de webhook ; aucun réseau tiers n’est utilisé.
