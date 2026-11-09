# Entitlements tenant — contrat v1

**Version :** `1.0.0` · **API :** `createEntitlementsService`,
`createMemoryEntitlementsStore`, `createPostgresEntitlementsStore`,
`runEntitlementsMigrations` · **Statut :** module local implémenté.

Le module décide localement des fonctionnalités et budgets d'un tenant. Il ne
réalise aucun paiement, n'appelle aucun fournisseur et n'impose pas de limite
matérielle à un processus.

## Initialisation locale

Appliquer d'abord les migrations Database et Tenancy, puis les migrations
Entitlements au même schéma local que Billing :

```js
import {
  createEntitlementsService,
  createPostgresEntitlementsStore,
  runEntitlementsMigrations,
} from '../modules/entitlements/index.mjs';

await runEntitlementsMigrations(pool, 'atelier_app');

const entitlements = createEntitlementsService({
  store: createPostgresEntitlementsStore({ pool, schemaName: 'atelier_app' }),
  resolveSubscription: async context => {
    const subscription = await trustedBillingLookup(context);
    return subscription && {
      planId: subscription.planId,
      status: subscription.status,
      periodStartAt: subscription.currentPeriodStartAt,
      periodEndAt: subscription.currentPeriodEnd,
    };
  },
  authorizeOverride: async ({ context, kind, targetId, value }) =>
    await trustedAdminPolicy(context, { kind, targetId, value }),
});
```

`resolveSubscription` est une frontière serveur de confiance : elle reçoit un
`TenantContext` déjà authentifié et retourne `null` ou exactement
`{ planId, status, periodStartAt, periodEndAt }`. Ne jamais lui transmettre un
plan choisi par le navigateur. Une erreur ou une réponse mal formée bloque
l'opération (`UNAVAILABLE` / `INVALID_SUBSCRIPTION`) ; elle ne revient pas au
plan gratuit.

Chaque méthode reçoit le `TenantContext` v1 exact
`{ contractVersion: 1, tenantId, requestId }`. Le contexte doit avoir été établi
par le service Tenancy ou une frontière serveur équivalente. Les champs inconnus,
un tenant non valide et une version inconnue sont refusés avant le stockage.

`createMemoryEntitlementsStore()` convient seulement aux tests isolés et aux
démos éphémères. En local durable, utiliser PostgreSQL avec un rôle d'exécution
limité, sans `BYPASSRLS`. Les tables appliquent une RLS forcée par
`app.tenant_id` et toutes les transactions définissent ce contexte tenant.

## Plans et API

Les limites ci-dessous sont des budgets locaux d'exemple associés aux plans
simulés de Billing ; elles ne sont ni des prix ni une offre commerciale.

| Quota métier par période | Free | Pro | Business | Unité |
| --- | ---: | ---: | ---: | --- |
| `api.requests` | 1 000 | 10 000 | 100 000 | requêtes |
| `ai.tokens` | 0 | 100 000 | 1 000 000 | tokens réservés |
| `storage.bytes` | 100 MiB | 5 GiB | 50 GiB | octets |
| `jobs.business-units` | 100 | 10 000 | 100 000 | unités métier |

| Méthode | Garantie |
| --- | --- |
| `check(context, featureId)` | Implémente `EntitlementProvider.check`; une fonctionnalité inconnue renvoie `allowed: false, reason: "unknown"`. `limits` fournit les budgets associés, pas une mesure d'usage. |
| `reserve(context, quotaId, amount, idempotencyKey)` | Réserve atomiquement un budget disponible et retourne un ID stable lors d'une répétition identique. Un dépassement renvoie `LIMIT_EXCEEDED`. |
| `consume(context, reservationId)` | Déplace une réservation vers l'usage consommé. La répétition est sans effet. |
| `refund(context, reservationId)` | Libère une réservation ou rembourse une consommation après échec. La répétition est sans effet. |
| `setFeatureOverride(context, featureId, enabled)` | Modifie un flag du tenant uniquement si `authorizeOverride` autorise l'action. |
| `setQuotaOverride(context, quotaId, limit)` | Modifie le budget du tenant uniquement si `authorizeOverride` autorise l'action. La limite est un entier non négatif. |
| `clearOverride(context, targetId)` | Retire l'override feature/quota après autorisation. |

Plans v1 : `free`, `pro` et `business`. Flags : `api.access`,
`ai.generation`, `storage.private` et `jobs.queue`. Les limites sont définies
dans `entitlementsContract` et les inconnues échouent sans valeur de repli.
Un plan `active` ou `trialing` utilise la période de souscription renvoyée par
Billing. Une souscription annulée conserve ses droits jusqu'à la fin de période ;
une souscription `past_due`, absente ou expirée est ramenée au plan Free. Sans
souscription, la période Free est le mois calendaire UTC.

Les bornes de période sont des millisecondes Unix UTC. La timezone du serveur,
du client ou de la requête n'intervient jamais dans le calcul ; une période
Billing renouvelée ouvre un nouveau compteur. Un downgrade applique
immédiatement les nouvelles limites aux réservations suivantes sans effacer
l'usage existant.

## Réserver puis consommer ou rembourser

Une intégration vérifie le flag puis réserve avant d'exécuter l'opération.
Consommer seulement après succès ; rembourser en cas d'échec :

```js
const access = await entitlements.check(context, 'ai.generation');
if (!access.allowed) throw new Error('FEATURE_DISABLED');

const reservation = await entitlements.reserve(
  context, 'ai.tokens', estimatedTokenBudget, idempotencyKey,
);
try {
  const result = await runLocalOperation();
  await entitlements.consume(context, reservation.id);
  return result;
} catch (error) {
  await entitlements.refund(context, reservation.id);
  throw error;
}
```

L'identifiant d'idempotence est limité à 128 caractères ASCII sûrs et est
scopé par tenant, quota et période. La même clé avec une autre requête échoue
(`IDEMPOTENCY_CONFLICT`). Une réservation n'est jamais transférable à un autre
tenant. Si l'opération peut survivre au processus qui l'a créée, son intégration
doit restaurer ou rembourser explicitement ses réservations abandonnées.

Les quotas `jobs.business-units` sont des budgets produit, pas des limites CPU,
RAM, workers ou durée. Le module Jobs conserve ses contrôles matériels et
opérationnels ; un quota de plan ne remplace ni leurs bornes ni un superviseur
du système d'exploitation.

## Erreurs, sécurité et rollback

Erreurs stables : `INVALID_INPUT`, `INVALID_CONFIGURATION`,
`INVALID_TENANT_CONTEXT`, `INVALID_SUBSCRIPTION`, `UNKNOWN_FEATURE`,
`UNKNOWN_QUOTA`, `FEATURE_DISABLED`, `LIMIT_EXCEEDED`,
`IDEMPOTENCY_CONFLICT`, `RESERVATION_NOT_FOUND`, `RESERVATION_FINALIZED`,
`FORBIDDEN` et `UNAVAILABLE`. Les erreurs du pilote SQL ne sont pas exposées.

`authorizeOverride` doit vérifier une autorité administrateur de confiance pour
chaque mutation et retourner strictement `true`; une absence, exception ou
réponse différente refuse l'accès. Ne pas exposer les méthodes d'override
directement à un client ni considérer la sélection d'un tenant comme preuve
d'autorisation. Le magasin PostgreSQL conserve séparément les overrides,
compteurs et réservations par tenant, avec RLS forcée. Les lectures échouées ou
les dépendances indisponibles ne valent jamais autorisation.

Les tables Entitlements sont additives et durables ; le rollback consiste à
arrêter les appels au module et retirer sa sélection côté application. Ne pas
supprimer ses tables ou son historique implicitement. Une restauration doit
conserver les compteurs et réservations correspondants pour éviter de réutiliser
un budget déjà consommé.

## Vérification hors réseau

```sh
node --test tests/entitlements.test.mjs
npm test
```

Les tests ciblés utilisent le magasin mémoire, une horloge et des abonnements
synthétiques. Ils couvrent concurrence, rejouements, remboursements, changement
de période, downgrade, timezone, autorisation et isolation tenant. Ils ne
constituent pas une preuve d'exécution PostgreSQL ou d'intégration de bout en
bout dans une application générée.
