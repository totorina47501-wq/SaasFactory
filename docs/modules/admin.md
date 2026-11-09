# Administration locale — contrat v1

`modules/admin/index.mjs` expose `createAdminService` et `adminContract` (version
`1`). Le module compose Auth, Tenancy, Billing simulé, Entitlements, Jobs et
Notifications existants. Il n'ajoute ni stockage, migration, transport distant,
fournisseur de paiement ni identité globale. L'application doit instancier les
services existants puis les fournir à `createAdminService` :

```js
import { createAdminService } from './modules/admin/index.mjs';

const admin = createAdminService({
  auth,
  tenancy,
  billing,
  entitlements,
  jobs,
  notifications,
});
```

Les six services sont obligatoires. Une dépendance absente ou une méthode
incomplète refuse l'initialisation (`INVALID_CONFIGURATION`) : l'administration
ne bascule pas sur un faux succès ni sur un compte superadmin.

## Session, tenant et autorisations

Chaque opération vérifie la session avec `auth.currentUser()` et, pour une
organisation, retrouve le rôle dans la liste des appartenances obtenue via
`tenancy.listMembers()`. Le rôle, l'identité et le contexte transmis par le
client ne sont jamais acceptés. Chaque opération sensible revalide ensuite son
accès dans le service métier existant. Les identifiants de tenant et de requête
sont validés avant délégation ; les clés d'entrée inconnues sont refusées.

| Opération | Rôle minimum |
| --- | --- |
| Créer une organisation, lister ses organisations, accepter une invitation | Session authentifiée |
| Lire les membres, gérer ses préférences | Membre de l'organisation |
| Modifier l'organisation, inviter, retirer un membre | `owner` ou `admin` |
| Changer le rôle d'un membre | `owner` |
| Lire le portail de facturation simulée et le dashboard | `owner` ou `admin` |
| Démarrer ou annuler un abonnement simulé | `owner` |

Tenancy reste l'autorité finale pour les invariants de membres et les invitations :
le propriétaire ne peut pas être retiré ou rétrogradé, une promotion en `owner`
n'est pas offerte par l'API v1, et les changements qui supprimeraient le dernier
administrateur échouent (`LAST_ADMIN`). Les invitations sont locales ; le jeton
retourné ne doit être transmis que par un canal privé local, jamais inclus dans
une réponse publique ou un journal.

## API

Les méthodes emploient des objets stricts. Les opérations d'organisation et de
facturation prennent `cookieHeader`, `tenantId`, `requestId`; la création
d'organisation et l'acceptation d'invitation prennent une session et un
`requestId`. Les champs spécifiques reprennent les API des services délégués.

| Méthode | Garantie |
| --- | --- |
| `createOrganization`, `listOrganizations`, `acceptInvitation` | Onboarding et accès aux organisations par la session Auth. |
| `listMembers`, `updateOrganization`, `inviteMember`, `changeMemberRole`, `removeMember` | Gestion des membres soumise au RBAC serveur et aux transactions Tenancy. |
| `getPreferences`, `setPreferences` | Préférences Notifications du seul membre connecté dans le tenant validé. |
| `getBillingPortal` | Plans, état, factures et historique simulés, sans paiement réel. |
| `startSubscription`, `cancelSubscription` | Actions simulées, réservées au propriétaire et déléguées à Billing. |
| `getDashboard` | Limites Entitlements, états Jobs et nombre de notifications propres au membre connecté. |

`getDashboard()` renvoie `status: "ready"` après la réussite de toutes les sources.
Les quotas déclarent explicitement `usageReported: false` : Entitlements expose
les autorisations et limites, pas la consommation. Jobs fournit des compteurs par
état et au plus 50 jobs récents, sans payload. Le compteur de notifications est
celui du membre connecté, pas un accès administrateur aux contenus ou aux boîtes
des autres membres. Une source indisponible fait échouer toute la lecture avec
`UNAVAILABLE`; aucune section partielle n'est présentée comme complète.

Le consommateur d'interface gère l'état initial `loading`, l'état retourné
`ready` et l'état `error` produit par un rejet (`AdminModuleError.code`). Il doit
annoncer chargement et erreurs aux technologies d'assistance (par exemple,
`aria-busy` et une région `aria-live`), conserver un ordre de focus prévisible et
ne pas afficher de données périmées comme actuelles. Ce module fournit l'API
serveur, pas une page React ni une route générée ; une intégration visuelle doit
être réalisée et vérifiée dans le périmètre UI correspondant.

## Erreurs et limites

Les erreurs publiques sont `AdminModuleError` avec un code stable :
`INVALID_CONFIGURATION`, `INVALID_INPUT`, `INVALID_SESSION`, `INVALID_TENANT`,
`FORBIDDEN`, `NOT_FOUND`, `ALREADY_MEMBER`, `INVITATION_PENDING`,
`INVITATION_INVALID`, `LAST_ADMIN`, `TENANT_ACCESS_DENIED` et `UNAVAILABLE`.
Les messages et détails des modules de stockage ne sont jamais relayés.

Le service ne conserve aucun état propre, n'envoie aucun email et ne démarre pas
de worker. Les budgets de jobs, de stockage, de rétention, les limites de quotas
et la simulation de facturation restent ceux des modules sources. La vérification
des rôles au niveau Admin complète, mais ne remplace jamais, les contrôles
transactionnels de Tenancy, Jobs et Billing.

## Vérification hors ligne et retrait

```sh
node --test tests/admin.test.mjs
npm test
```

Les tests utilisent des doubles en mémoire et ne contactent aucun service distant.
Le module n'ayant ni table ni migration, le rollback consiste à retirer sa
composition et ses appels, sans modifier ou supprimer les données gérées par les
modules délégués.
