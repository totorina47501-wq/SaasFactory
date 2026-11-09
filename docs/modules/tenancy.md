# Organisations et appartenance multi-tenant — contrat v1

**Version :** `1.0.0` · **API :** `createTenancyService`,
`createPostgresTenancyStore`, `runTenancyMigrations` · **Statut :**
implémentation locale PostgreSQL. Le module ne configure aucun fournisseur
distant et n'ajoute pas de dépendance npm.

Le service dépend des modules Auth et Database locaux. L'application fournit un
`auth` issu de `createAuthService` et un `store` issu de
`createPostgresTenancyStore`. Le pool doit utiliser le rôle runtime dédié et
limité du module Database, jamais un propriétaire de schéma, superuser ou rôle
`BYPASSRLS`.

## Initialisation locale

Exécuter séparément les migrations Database, Auth puis Tenancy sur le même
schéma d'application et le même pool local :

```js
import { Pool } from 'pg';
import {
  createAuthService,
  createPostgresAuthStore,
  runAuthMigrations,
} from './modules/auth/index.mjs';
import {
  createPostgresTenancyStore,
  createTenancyService,
  runTenancyMigrations,
} from './modules/tenancy/index.mjs';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
await runAuthMigrations(pool, 'atelier_app');
await runTenancyMigrations(pool, 'atelier_app');

const auth = createAuthService({
  store: createPostgresAuthStore({ pool, schemaName: 'atelier_app' }),
  origin: 'http://localhost:3000',
  localResetChannel: { kind: 'local', deliver: async message => localResetInbox.write(message) },
});
const tenancy = createTenancyService({
  auth,
  store: createPostgresTenancyStore({ pool, schemaName: 'atelier_app' }),
});
```

`runAuthMigrations` applies the shared Database migrations first; calling
`runTenancyMigrations` after it applies the immutable `tenancy@1.0.0` extension.
No destructive or down migration is provided. Back up and verify restoration
before an upgrade; rollback means stopping tenancy writes and retaining the
tables, not dropping them.

Auth IDs are the UUID primary keys of `auth_users`. On organization creation or
invitation acceptance, the module creates the matching `users` profile in the
shared Database schema from that authenticated account's email. A conflicting
profile fails closed. Applications must not substitute a request-provided user
ID or email.

## Session boundary and TenantContext

Every public operation takes the session cookie and uses
`auth.currentUser({ cookieHeader })` to obtain the authenticated user ID. The
service rejects unknown input keys and does not accept a user ID, role, or
TenantContext from the request. A requested `tenantId` is only a workspace
selector: the server checks the current user's persisted membership before
returning a context or performing an operation. Unknown and unauthorized
tenants both fail with `NOT_FOUND`.

`resolveTenantContext({ cookieHeader, tenantId, requestId })` returns a frozen,
exact Runtime v1 context:

```js
{ contractVersion: 1, tenantId, requestId }
```

Resolve it on each authenticated request. Pass it only to trusted server-side
database, document, job and export services that apply tenant filtering; never
deserialize it from a client payload or reuse a caller-supplied context.
Tenancy operations recheck membership in their own database transaction.
PostgreSQL transactions set `app.tenant_id` and (for authenticated operations)
`app.user_id` locally, and every tenant query has an explicit tenant filter.
The RLS self-membership policy exists only to support listing a user's
workspaces before one tenant is selected. As documented by Database v1, custom
PostgreSQL settings and RLS are defense against application mistakes, not a
boundary against arbitrary SQL under the runtime role.

## API and permissions

All methods use exact object inputs. `requestId` is required for traceable
operations; identifiers, names, email, roles, and token lengths are validated
before storage access.

| Method | Input (in addition to `cookieHeader`) | Result / authorization |
| --- | --- | --- |
| `createOrganization` | `name`, `requestId` | Creates a server-ID workspace and its first `owner` membership atomically. |
| `listOrganizations` | `requestId` | Lists only organizations with a persisted membership for the session user. |
| `resolveTenantContext` | `tenantId`, `requestId` | Returns a context only after membership verification. |
| `listMembers` | `tenantId`, `requestId` | Any current member. |
| `updateOrganization` | `tenantId`, `requestId`, `name` | `owner` or `admin`. |
| `inviteMember` | `tenantId`, `requestId`, `email`, `role` | `owner` or `admin`; only `owner` can invite an `admin`. |
| `acceptInvitation` | `requestId`, `token` | Authenticated account email must match; token is one-use and expires after seven days. |
| `changeMemberRole` | `tenantId`, `requestId`, `memberId`, `role` | `owner` only; only `admin` or `member` roles can be assigned. |
| `removeMember` | `tenantId`, `requestId`, `memberId` | `owner` or `admin`; an admin can remove members, not admins. |

The explicit permission matrix is exported as `tenancyContract.permissions`:

| Permission | Owner | Admin | Member |
| --- | --- | --- | --- |
| `organization.read` | yes | yes | yes |
| `organization.update` | yes | yes | no |
| `member.read` | yes | yes | yes |
| `member.invite` | yes | yes | no |
| `member.role.change` | yes | no | no |
| `member.remove` | yes | yes | no |

The owner cannot be removed or demoted through this v1 API. Membership changes
lock the organization row; demoting or removing an administrator checks that at
least one owner/admin remains. Role changes and organization, invitation,
acceptance, and membership administration append an audit event in the same
transaction. Audit entries contain actor and resource identifiers only, never
session cookies, invitation tokens, passwords or invitation email contents.

## Invitations, errors and transaction guarantees

Invitations use a random 256-bit secret. The returned local token has a
non-secret tenant selector and the random secret; only the SHA-256 digest of the
secret is stored. The invite is bound to the normalized email in the
authenticated account, can be accepted once, and is rejected at or after its
expiration. A unique pending invitation per tenant/email prevents duplicates.
Removing or demoting an inviter revokes its pending invitations, and acceptance
revalidates that the inviter still has permission. No email or other remote
delivery is configured: the application must deliver the returned token only
through a private local channel and must never put it in a public response,
logs, audit details or analytics.

PostgreSQL writes (workspace creation, invitation issue/acceptance,
organization updates, role changes and removals) run in explicit transactions;
audit failure rolls back the operation. Organization locks serialize
membership/role changes and invitation acceptance. Invitations and memberships
are tenant-scoped by composite keys, foreign keys and RLS. The append-only
Database audit table records successful state changes.

Errors are `TenancyModuleError` with stable codes: `INVALID_INPUT`,
`INVALID_CONFIGURATION`, `INVALID_SESSION`, `INVALID_TENANT`, `INVALID_ROLE`,
`INVALID_CONTEXT`, `FORBIDDEN`, `NOT_FOUND`, `ALREADY_MEMBER`,
`INVITATION_PENDING`, `INVITATION_INVALID`, `LAST_ADMIN`,
`IDENTITY_CONFLICT`, and `UNAVAILABLE`. Driver details and submitted values are
never copied into public errors.

## Offline verification

```sh
node --test tests/tenancy.test.mjs
npm test
```

Tests use local fakes for transaction and authorization behavior; they do not
prove PostgreSQL provider behavior. The optional Database PostgreSQL integration
tests must use a disposable local Compose database. No network service,
hosted identity, external email, deployment or provider account is used.
