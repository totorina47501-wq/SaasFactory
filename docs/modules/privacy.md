# Confidentialité : export, effacement et rétention

Module local versionné `privacy-v1`, sans appel réseau ni règle juridique intégrée.
Il coordonne uniquement les sources explicitement configurées ; il ne crée pas
d’adaptateur implicite et ne prétend pas traiter une source désactivée.

## Contrat et configuration

Importer `createPrivacyService`, `PrivacyError` et `privacyContract` depuis
`modules/privacy/index.mjs`. La configuration est un objet strict : les
propriétés inconnues sont refusées.

```js
createPrivacyService({
  auth,                  // auth.currentUser({ cookieHeader })
  tenancy,               // tenancy.resolveTenantContext({ cookieHeader, tenantId, requestId })
  authorize,             // async ({ tenantContext, userId, action, target }) => true | false
  store,                 // get(context, key); put(context, key, value, expectedVersion)
  jobs,                  // enqueue(...), get(...), runOnce({ type, handlers })
  sources: [
    { id: 'documents', enabled: true, export: exportDocuments, erase: eraseDocuments,
      prune: pruneDocuments },
  ],
  retention: [{ sourceId: 'documents', retentionMs: 30 * 24 * 60 * 60 * 1000 }],
});
```

Le magasin doit être durable et appliquer atomiquement `expectedVersion` :
incrémenter sa version après l’écriture ou lever une erreur avec `code:
'CONFLICT'`. Il est partitionné par `tenantContext`; la clé utilisée est
`privacy-v1/state`. Le service n’inclut pas de magasin mémoire de production.
La file doit être persistante, tenant-scopée et idempotente ; elle doit proposer
les méthodes du module `jobs`. `runOnce()` passe le traitement
`privacy.erasure` à cette file, sans démarrer de worker automatiquement.

Chaque source a un identifiant unique correspondant à `^[a-z][a-z0-9-]{0,31}$`.
Une source activée exige les deux fonctions réelles `export({ tenantContext,
target })` (tableau de données JSON) et `erase({ tenantContext, target,
operationId })` (nombre entier d’éléments supprimés). Une source de rétention
exige aussi `prune({ tenantContext, cutoff })` (nombre entier supprimé). Les
fonctions doivent appliquer l’isolation tenant côté stockage, retourner une
erreur en cas de résultat incertain et, pour `erase`, être idempotentes. Elles
ne doivent jamais marquer la suppression réussie avant d’avoir confirmé
l’absence des données concernées, notamment des chunks et vecteurs de l’index.

`authorize` doit retourner exactement `true` pour les actions tenant suivantes :
`privacy:export`, `privacy:erase`, `privacy:retention:run` et
`privacy:operation:read`. Un export ou effacement `scope: 'user'` ne peut viser
que l’utilisateur authentifié. Les opérations tenant (`scope: 'tenant'`) sont
toujours contrôlées par `authorize`. La session, le contexte tenant et la
requête sont vérifiés à chaque appel public ; les erreurs d’autorisation ou de
résolution ne basculent jamais vers un accès moins strict.

## API

- `exportData({ cookieHeader, tenantId, requestId, scope, subjectId? })` renvoie
  un export JSON en mémoire. `scope` vaut `user` ou `tenant`; `subjectId` est
  accepté uniquement pour `user` et doit être l’identifiant de la session.
- `requestErasure({ cookieHeader, tenantId, requestId, scope, subjectId?,
  idempotencyKey })` crée un travail d’effacement coordonné et idempotent.
- `getOperation({ cookieHeader, tenantId, requestId, operationId })` renvoie
  l’état d’une opération du tenant autorisé.
- `retryErasure({ cookieHeader, tenantId, requestId, operationId })` reprend une
  opération dont le travail est en échec terminal ; les étapes déjà confirmées
  ne sont pas rejouées.
- `runOnce()` exécute un travail disponible dans la file existante.
- `runRetention({ cookieHeader, tenantId, requestId, now? })` applique les
  règles de rétention configurées pour ce tenant. `now` est un instant Unix en
  millisecondes destiné aux tests ou à une exécution contrôlée.

Les statuts d’opération sont `queued`, `running`, `retrying`, `succeeded` et
`failed`. Chaque source a une étape persistée (`pending`, `running` ou
`succeeded`). Après une panne entre l’effet externe et l’enregistrement de son
achèvement, l’adaptateur peut être rappelé : son idempotence est donc une
précondition, pas une optimisation. Une clé d’idempotence réutilisée avec une
cible différente est refusée.

L’export contient `contractVersion`, `tenantId`, `target`, un inventaire de
toutes les sources déclarées, les données activées et
`integrity: { algorithm: 'sha256', digest }`. Chaque entrée d’inventaire active
contient un nombre d’enregistrements et le SHA-256 de son JSON normalisé ; le
digest global couvre le manifeste et les données, hors champ `integrity`.
Les clés d’objets sont normalisées par ordre lexical. Limites par défaut :
2 Mio JSON et 10 000 enregistrements au total ; les valeurs sont configurables
avec des plafonds de sécurité dans le contrat. L’export est retourné à l’appelant
et n’est pas écrit sur disque, envoyé par courriel ou conservé par le module.

Les erreurs publiques utilisent `PrivacyError.code`. Les entrées inconnues,
résultats d’adaptateur invalides, conflits d’idempotence, données d’export non
JSON, accès inter-tenant, corruption d’état et indisponibilités de stockage,
source ou file échouent sans succès partiel annoncé.

## Rétention, conservation et sauvegardes

Une règle `retention` définit uniquement une durée en millisecondes par source
activée, plafonnée à dix ans. L’adaptateur reçoit `cutoff = now - retentionMs`
et reste responsable de n’effacer que les données antérieures à ce seuil. Il
doit également exclure atomiquement les données retenues par une obligation de
conservation qu’il connaît ; le module ne définit ni la nature ni la durée d’une
obligation légale. Une source sans règle de rétention n’est pas purgée par cette
API. Aucun planificateur n’est activé automatiquement.

L’effacement des magasins actifs ne supprime pas les copies de sauvegarde et ne
garantit pas l’effacement physique de supports flash. L’exploitant doit définir
la durée et le contrôle d’accès des sauvegardes, conserver un registre de
suppressions adapté à son stockage, et appliquer/rejouer ces suppressions à une
restauration avant de rendre les données restaurées accessibles. Ces opérations
de sauvegarde/restauration sont hors du périmètre de ce module. Pour un rollback,
suspendre les travailleurs de rétention/effacement, préserver l’état durable des
opérations, corriger l’adaptateur et reprendre avec `retryErasure` ; ne pas
réactiver une source dont le résultat de suppression n’est pas vérifié.

## Tests

Depuis la racine du dépôt :

```sh
node --test tests/privacy.test.mjs
npm test
```

Les tests utilisent des adaptateurs et une file synthétiques, sans réseau ni
fournisseur. Ils vérifient le hachage d’export, les ACL utilisateur/tenant,
l’effacement effectif de vecteurs, l’isolation inter-tenant, la reprise après
interruption et les seuils de rétention. Ces tests ne remplacent pas la
validation de chaque adaptateur de stockage ni une procédure réelle de
restauration de sauvegarde.
