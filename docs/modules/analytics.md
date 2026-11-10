# Analytics produit respectueux de la confidentialité — contrat v1

**Version :** `1.0.0` · **API :** `createAnalyticsService`,
`createMemoryAnalyticsStore`, `analyticsContract` · Module local, sans SDK ni
requête réseau. Il n'ajoute pas de route HTTP : l'application fournit au
dashboard UX le résultat agrégé de `dashboard(context)`.

## Initialisation

```js
import {
  createAnalyticsService,
  createMemoryAnalyticsStore,
} from './modules/analytics/index.mjs';

const analytics = createAnalyticsService({
  store: createMemoryAnalyticsStore(),
  features: ['reports', 'search'],
  authorize: async ({ context, action, subjectKey }) =>
    authorizationService.allows(context, action, subjectKey),
  checkConsent: async ({ context, subjectKey }) =>
    consentStore.hasAnalyticsConsent(context.tenantId, subjectKey),
  setConsent: async ({ context, subjectKey, granted }) =>
    consentStore.setAnalyticsConsent(context.tenantId, subjectKey, granted),
});
```

Le service requiert les fonctions `authorize`, `checkConsent` et `setConsent`;
une absence, une exception ou toute réponse autre que `true` refuse l'opération.
`setConsent` doit persister dans la même source consultée par `checkConsent` et
ne renvoyer `true` qu'après confirmation. Le `TenantContext` v1 doit être créé côté serveur avec
`tenancy.resolveTenantContext`, jamais désérialisé depuis une requête. Sa
validation de forme dans Analytics n'est pas une autorisation. `authorize`
vérifie l'accès au tenant et l'action (`analytics.track`, `.read`, `.export`,
`.delete`, `.consent` ou `.retention`) ; pour un export, il doit aussi vérifier
que le sujet demandé appartient à l'utilisateur ou à un opérateur habilité.
La source de consentement reste un registre explicite, distinct d'Analytics.

## Événement v1

`track({ context, subjectKey, event })` accepte seulement les champs ci-dessous.
Les clés inconnues, champs libres, types d'événement non autorisés, features
hors allowlist, horodatages non canoniques, événements futurs ou plus anciens
que la rétention échouent sans écriture.

```js
await analytics.track({
  context,
  subjectKey: keyedDigest,
  event: {
    schemaVersion: 1,
    eventId: '00000000-0000-4000-8000-000000000001',
    eventType: 'feature.used',
    featureId: 'reports',
    occurredAt: new Date().toISOString(),
  },
});
```

`subjectKey` est un digest pseudonyme stable de 64 caractères hexadécimaux,
calculé côté serveur à partir d'une identité authentifiée et d'une clé propre à
l'application. Ne jamais fournir un email, un identifiant brut, le contenu d'un
document ou d'un prompt. Le module ne reçoit aucun payload libre. Les événements
sont versionnés (`schemaVersion: 1`), identifiés de façon idempotente et limités
à `feature.used`, `visit`, `signup` et `trial`. Les événements de parcours
peuvent inclure un `source` code au format limité ; aucune dimension libre
n'est acceptée.

Un ID rejoué avec le même événement est une réussite idempotente. Le même ID
avec d'autres valeurs échoue avec `IDEMPOTENCY_CONFLICT`. `revokeConsent`
enregistre le retrait dans la source de consentement avant de supprimer les
événements ; `grantConsent` enregistre une nouvelle autorisation explicite.
La collecte échoue tant que `checkConsent` ne confirme pas le consentement.

## Agrégats, limites et suppression

`dashboard({ context })` renvoie les compteurs tenant-scoped et un funnel
`visit/signup/trial` sur les 90 derniers jours. Le funnel réutilise
`aggregateGrowth` de Growth Core ; les attributions par canal ne sont pas
exposées ici. Le dashboard n'accepte ni filtre temporel ni dimension fournie
par l'appelant, pour limiter les attaques par différenciation. Le total est
exposé seulement si au moins `minGroupSize` sujets distincts sont représentés ;
sinon il est `null`. Les groupes par événement et feature, ainsi que chaque
compteur du funnel, exigent aussi ce nombre de sujets distincts dans leur propre
fenêtre. Si un groupe feature est supprimé, le total et le compteur funnel
correspondant sont aussi supprimés pour éviter leur reconstruction par
soustraction. `suppressed` indique alors cette suppression complémentaire.
Répéter un événement pour un seul sujet ne permet donc pas de franchir le seuil.

| Méthode | Entrée | Sortie |
| --- | --- | --- |
| `track` | `{ context, subjectKey, event }` | `{ accepted, duplicate }`, sans événement ni sujet en sortie. |
| `dashboard` | `{ context }` | `{ schemaVersion, tenantId, generatedAt, suppressed, totalEvents, features, growthFunnel }`. |
| `exportSubject` | `{ context, subjectKey }` | Événements du sujet dans la rétention. |
| `revokeConsent` | `{ context, subjectKey }` | Nombre d'événements supprimés après révocation persistée du consentement. |
| `grantConsent` | `{ context, subjectKey }` | `true` après enregistrement et relecture du consentement explicite. |
| `cleanup` | `{ context }` | Nombre d'événements expirés supprimés. |

| Limite | Défaut | Bornes |
| --- | ---: | ---: |
| Rétention | 30 jours | 1–365 jours |
| Taille minimale d'un groupe exposé | 5 | 5–1 000 |
| Événements par tenant et jour | 10 000 | 1–100 000 |
| Événements conservés par tenant | 10 000 | 1–10 000 |

`exportSubject` retourne uniquement les événements du sujet, après autorisation.
`revokeConsent` persiste d'abord le retrait via `setConsent`, puis supprime les
événements ; l'Analytics store ne conserve pas de tombstone sujet. Cette source
de consentement doit rester la source de vérité afin que les prochains appels
`track` continuent d'échouer jusqu'à une autorisation explicite via
`grantConsent`.
`cleanup({ context })` purge les événements au-delà de la rétention et exige
l'autorisation `analytics.retention`.

## Stockage et exploitation

`createMemoryAnalyticsStore` est un adaptateur local de référence, borné par
tenant et sérialisé par tenant/sujet dans un seul processus. Les données
événementielles sont volatiles et disparaissent au redémarrage ; cet adaptateur
n'est pas un stockage durable ni multi-instance. Une application qui doit
conserver des événements doit fournir son propre stockage local compatible avec
`append`, `list`, `exportSubject`, `deleteSubject`, `prune`, `withSubjectLock` et
`withTenantLock` :

- `append(record, { now, limits })` retourne `{ accepted, duplicate }` et
  sérialise par tenant la déduplication et les quotas.
- `list(tenantId)` et `exportSubject(tenantId, subjectKey)` retournent des
  événements v1 sans contenu libre.
- `deleteSubject(tenantId, subjectKey)` supprime les événements du sujet ;
  `prune(now, retentionMs)` supprime les événements expirés.
- `withSubjectLock(tenantId, subjectKey, operation)` sérialise la vérification
  du consentement avec la collecte et la révocation. Un adaptateur durable doit
  coordonner cela avec sa source de consentement entre processus.
- `withTenantLock(tenantId, operation)` maintient une vue cohérente du dashboard
  pendant son agrégation, vis-à-vis des insertions et suppressions du tenant.

L'adaptateur doit préserver ces garanties atomiquement et de manière durable ;
aucune migration ou implémentation de stockage distant n'est incluse ici.

Le service ne démarre pas de tâche, serveur, exporteur, tracker tiers ou
connexion réseau. Les erreurs publiques sont `AnalyticsModuleError` avec des
codes stables (`INVALID_INPUT`, `INVALID_CONFIGURATION`,
`INVALID_TENANT_CONTEXT`, `INVALID_SUBJECT`, `FORBIDDEN`,
`CONSENT_REQUIRED`, `CONSENT_UNAVAILABLE`, `IDEMPOTENCY_CONFLICT`,
`QUOTA_EXCEEDED`, `UNAVAILABLE`).

Pour revenir en arrière, retirer les appels explicites au service et au
stockage local. Aucune migration ni action distante n'est requise. Les données
de l'adaptateur mémoire ne survivent pas au processus ; avant de retirer un
adaptateur durable créé par l'application, appliquer sa propre procédure
d'export et de suppression.

## Vérification hors ligne

```sh
node --test tests/analytics.test.mjs
npm test
```

Les tests vérifient consentement, autorisations, séparation tenant, événement
versionné et déduplication, quotas, agrégation Growth réutilisée, suppression
des petits groupes, export, révocation, rétention et refus des champs de contenu.
