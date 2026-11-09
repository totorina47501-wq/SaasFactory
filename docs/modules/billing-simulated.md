# Commerce simulé — contrat v1

**Version :** `1.0.0` · **API :** `createBillingService`,
`createPostgresBillingStore`, `runBillingMigrations` · **Statut :** simulation
locale uniquement.

Ce module ne réalise aucune transaction, ne collecte aucun moyen de paiement,
n'émet aucune facture légale et n'appelle aucun fournisseur. Les tarifs et toutes
les factures sont des données de démonstration. La valeur USD ne représente ni
un prix commercial ni une créance.

## Préparation locale

Le magasin PostgreSQL conserve abonnements, événements, factures et historique
dans la base locale de l'application. Appliquer d'abord les migrations Database,
Auth et Tenancy, puis Billing, au même schéma applicatif. Utiliser un pool local
avec un rôle d'exécution limité, et non le propriétaire du schéma ou un rôle
`BYPASSRLS`.

```js
import { randomBytes } from 'node:crypto';
import {
  createBillingService,
  createPostgresBillingStore,
  runBillingMigrations,
} from '../modules/billing-simulated/index.mjs';

// `pool` and `tenancy` sont déjà initialisés selon les contrats Database et Tenancy.
await runBillingMigrations(pool, 'atelier_app');

const billing = createBillingService({
  store: createPostgresBillingStore({ pool, schemaName: 'atelier_app' }),
  tenancy,
  signingKey: process.env.LOCAL_BILLING_SIMULATION_KEY ?? randomBytes(32).toString('hex'),
});
```

In an application, provision `LOCAL_BILLING_SIMULATION_KEY` as a private local
configuration value; do not commit or log it. The fallback above is process
local and will not verify events signed by another process or after restart.
`createMemoryBillingStore()` is intended for isolated tests and short-lived
demos only; its state is not durable. PostgreSQL migrations are additive and
immutable; rollback means stopping billing writes and retaining the tables, not
dropping billing history.

## API et portail local

Every tenant operation accepts the session cookie, a tenant selector and a
request ID. The module resolves a fresh `TenantContext` through the Tenancy
service and rejects a mismatch or unauthorized tenant before reading or writing
billing state. The tenant selector is not proof of access.

| Méthode | Entrée en plus de `cookieHeader`, `tenantId`, `requestId` | Garantie |
| --- | --- | --- |
| `listPlans()` | — | Renvoie Free, Pro et Business, marqués `simulated`. |
| `startSubscription()` | `planId`, `idempotencyKey`, `trial?` | Crée une seule souscription par tenant ; Pro/Business peuvent commencer un essai de 14 jours. |
| `getSubscription()` | — | Renvoie la souscription autorisée, ou `null`. |
| `listInvoices()` | — | Renvoie seulement les factures de démonstration du tenant. |
| `getHistory()` | — | Renvoie l'historique local du tenant, y compris les événements reçus en retard. |
| `cancelSubscription()` | — | Programme l'arrêt à la fin de la période courante ; la prochaine échéance ne crée pas de facture. |
| `renewSubscription()` | `idempotencyKey` | Simule un renouvellement seulement si l'échéance est atteinte. Une exécution concurrente ne renouvelle qu'une seule fois. |
| `processEvent()` | événement signé et signature | Traite un événement local signé, une seule fois, sans route réseau fournie. |

Les montants du catalogue sont des exemples fixes (`Free` 0, `Pro` 12 USD,
`Business` 49 USD) arrondis en cents. Une facture porte `status: "demo"`,
`simulated: true` et `paymentRequired: false`. Aucun état ne prétend qu'un
paiement a été autorisé ou encaissé.

États v1 : `trialing`, `active`, `past_due`, `canceled`. Il n'y a pas de tâche
de fond : un appel explicite à `renewSubscription()` à l'échéance d'un essai le
fait passer à `active` et produit une facture factice si le plan est payant. Une
annulation reste active jusqu'à la fin de la période ; l'appel de renouvellement
à cette échéance la fait passer à `canceled`. Les horodatages sont des
millisecondes Unix UTC. `clock` peut être injectée pour des tests reproductibles.

Le portail d'administration peut présenter le catalogue, l'état courant, la
date de fin d'essai/période, les factures fictives et l'historique au moyen de
ces méthodes. Les boutons d'essai, renouvellement et annulation appellent le
service local ; aucune URL de paiement, redirection ou opération distante
n'existe dans cette version.

## Événements simulés et idempotence

Le corps v1 est un objet strict, sans champ supplémentaire :

```js
{
  version: 1,
  id: 'evt_local_001',
  type: 'subscription.past_due',
  tenantId: '11111111-1111-4111-8111-111111111111',
  subscriptionId: '22222222-2222-4222-8222-222222222222',
  occurredAt: 1800000000000,
}
```

Types autorisés : `subscription.active`, `subscription.past_due` et
`subscription.canceled`. Calculer la signature côté serveur avec
`signBillingEvent(event, signingKey)`, puis transmettre cette signature à
`processEvent`. Le module vérifie un HMAC-SHA-256 hexadécimal en temps constant.
Une répétition identique est sans effet ; réutiliser un ID avec un contenu
différent échoue avec `EVENT_ID_CONFLICT`. Un événement plus ancien que le
dernier changement d'état est conservé dans l'historique comme obsolète, sans
régression de l'état.

`processEvent` est une frontière interne serveur-à-serveur, pas un endpoint
public. Ne jamais exposer la clé de signature au navigateur ni accepter un
événement non signé. Il n'y a pas de webhook de fournisseur dans cette version.

## Stockage et compatibilité

`billingContract.version` vaut `1`. L'API du magasin est volontairement séparée
du contrat du futur adaptateur de commerce : un futur adaptateur devra utiliser
un nouveau contrat versionné et rester explicitement désactivé tant qu'il n'a
pas reçu une approbation séparée. Ne pas brancher de fournisseur ou ajouter des
tarifs réels pour rendre ce module opérationnel.

Le magasin PostgreSQL emploie les tables `simulated_billing_*`, des transactions,
une clé de verrouillage locale par tenant, des clés d'idempotence uniques et
RLS forcée par `app.tenant_id`. L'historique et les factures ne contiennent ni
identifiant de compte fournisseur ni moyen de paiement. RLS protège contre les
erreurs de filtrage applicatives ; ce n'est pas une frontière contre du SQL
arbitraire sous le rôle runtime, conformément au contrat Database.

Erreurs stables : `INVALID_INPUT`, `INVALID_CONFIGURATION`, `INVALID_SESSION`,
`INVALID_TENANT_CONTEXT`, `TENANT_ACCESS_DENIED`, `INVALID_PLAN`,
`INVALID_TRIAL`, `SUBSCRIPTION_EXISTS`, `IDEMPOTENCY_CONFLICT`,
`EVENT_ID_CONFLICT`, `INVALID_EVENT`, `INVALID_SIGNATURE`,
`INVALID_TRANSITION`, `NOT_FOUND`, `NOT_DUE` et `UNAVAILABLE`. Les erreurs du
driver ne sont pas exposées.

## Budgets et limites v1

- Trois plans prédéfinis, une souscription par tenant, essais de 14 jours et
  périodes de 30 jours ; aucun changement de plan n'est simulé.
- Identifiants de requête, clés d'idempotence et IDs d'événement : 1 à 128
  caractères ASCII sûrs. Les clés d'idempotence sont distinctes par opération.
  Les clés locales de signature ont au moins 16 octets.
- Le corps d'événement est fixe et borné par ses champs, sans payload libre,
  fichier ou pièce jointe.
- Le module ne purge pas automatiquement factures et historique durables.
  Leur volume dépend de l'usage local ; l'opérateur doit surveiller et budgéter
  le disque PostgreSQL local, les sauvegardes et la rétention. Aucun événement
  ou facture n'est supprimé silencieusement.

## Vérification hors réseau

```sh
node --test tests/billing-simulated.test.mjs
npm test
```

Les tests utilisent une horloge injectée et le magasin mémoire pour vérifier les
transitions, les renouvellements concurrents, les signatures, les rejouements,
les événements réordonnés et l'isolation tenant. Ils ne constituent pas une
preuve d'exécution PostgreSQL ou d'intégration avec un fournisseur.
