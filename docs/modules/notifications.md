# Notifications locales — contrat v1

`modules/notifications/index.mjs` fournit des notifications persistantes par
membre, des préférences, des templates email échappés et une inbox de
prévisualisation strictement locale. Le contrat exporté
`notificationsContract.version` est `1`. Aucune connexion SMTP ou API email
n'est intégrée.

## Initialisation et flux jobs

Le service dépend des contrats v1 d'Auth, Tenancy et Jobs. Son répertoire doit
être un chemin absolu dont le parent existe. Le service crée un répertoire privé
`0700`, conserve `notifications-v1.json` en `0600` et sérialise les écritures
locales avec un verrou privé. Un verrou abandonné après un crash n'est pas
supprimé automatiquement : après avoir arrêté les workers et vérifié qu'aucun
processus ne l'utilise, l'opérateur peut supprimer uniquement
`notifications-v1.lock`.

```js
import { createNotificationsService } from './modules/notifications/index.mjs';

const notifications = await createNotificationsService({
  directory: '/var/lib/my-saas/notifications',
  auth,
  tenancy,
  jobs,
  limits: {
    maxNotifications: 10000,
    maxEmailInbox: 10000,
    retentionMs: 30 * 24 * 60 * 60 * 1000,
  },
});

await notifications.setPreferences({
  cookieHeader,
  tenantId,
  requestId,
  inAppEnabled: true,
  emailEnabled: false,
});

await notifications.send({
  cookieHeader,
  tenantId,
  requestId,
  idempotencyKey: 'workspace-ready-123',
  title: 'Espace prêt',
  body: 'Votre espace de travail est prêt.',
});
```

Le membre et le tenant sont résolus depuis la session via Auth et Tenancy.
L'API v1 limite le destinataire au membre authentifié ; aucun identifiant de
destinataire fourni par l'appelant n'est accepté. Les préférences sont propres
au couple tenant/membre. Par défaut, l'inbox interne est activée et l'email
désactivé. Si les deux canaux sont désactivés, `send()` retourne
`{ suppressed: true }` sans stocker le contenu.

Quand l'email est activé, `send()` inscrit un job `notifications.email.preview`
dans le service Jobs déjà configuré. Le payload du job ne contient que les IDs
de notification et tenant, jamais le contenu, l'adresse ou le template.
`notifications.jobHandlers()` fournit le handler à enregistrer auprès du worker
Jobs :

```js
await jobs.runOnce({ handlers: notifications.jobHandlers() });
```

La boîte email est une inbox locale de prévisualisation accessible avec
`listEmailInbox()`. Le nombre de tentatives et le backoff relèvent uniquement
des limites du module Jobs : ce module ne crée pas de seconde file ni de boucle
de retry. L'idempotence de la notification et celle du job empêchent les appels
répétés de créer des doublons. Si l'ajout du job échoue après persistance,
`send()` renvoie `JOBS_UNAVAILABLE`; répéter le même appel et la même clé
d'idempotence reprend l'ajout du job sans recréer la notification.

## API

Toutes les méthodes utilisateur prennent des objets exacts avec
`cookieHeader`, `tenantId` et `requestId`. Les champs inconnus, getters,
contextes de tenant invalides et accès inter-membre ou inter-tenant échouent
fermés.

| Méthode | Champs additionnels | Résultat |
| --- | --- | --- |
| `send(input)` | `idempotencyKey`, `title`, `body` | Crée une notification pour le membre courant ; clé unique par tenant/membre. |
| `list(input)` | — | Notifications actives du membre, les plus récentes d'abord. |
| `markRead(input)` | `notificationId` | Marque la notification du membre comme lue ; répétition idempotente. |
| `delete(input)` | `notificationId` | Supprime logiquement la notification et retire son email de l'inbox locale. |
| `getPreferences(input)` | — | Retourne les préférences du membre sans données de contact. |
| `setPreferences(input)` | `inAppEnabled`, `emailEnabled` | Met à jour les deux préférences du membre. |
| `listEmailInbox(input)` | — | Prévisualisations email du seul membre courant. |
| `purgeExpired()` | — | Efface les notifications, dédupliquants et prévisualisations expirés ; réservé au code de maintenance de confiance. |

`renderEmailTemplate({ templateVersion: 1, subject, body })` retourne du texte
et un document HTML encodé contextuellement. Le template n'accepte ni HTML
arbitraire, ni en-têtes email, ni clé inconnue. La valeur de `subject` ne peut
pas contenir de CR/LF.

Erreurs stables de `NotificationsModuleError` : `INVALID_INPUT`,
`INVALID_CONFIGURATION`, `INVALID_SESSION`, `TENANT_ACCESS_DENIED`,
`INVALID_TEMPLATE`, `IDEMPOTENCY_CONFLICT`, `NOT_FOUND`, `TIME_RANGE`,
`STORAGE_BUSY`, `STORAGE_LIMIT`, `STORAGE_UNAVAILABLE`, `UNSAFE_STORAGE`,
`CORRUPT_STORAGE`, `JOBS_UNAVAILABLE` et `UNAVAILABLE`. Les erreurs du
fournisseur Jobs sont ramenées à `JOBS_UNAVAILABLE`; les valeurs d'entrée,
contenus de notifications et détails techniques ne sont pas ajoutés aux
erreurs ni journalisés par le module.

## Limites, conservation et exploitation

Les limites par défaut sont de 10 000 notifications, 10 000 prévisualisations
email, 16 MiB de JSON, 4 000 caractères par corps (configurable jusqu'à
16 000), 30 jours de conservation et 5 secondes d'attente de verrou. Les valeurs
sont configurables dans les bornes v1 ; les données expirées sont purgées à
l'accès suivant ou par `purgeExpired()`. La suppression par l'utilisateur est
logique afin de préserver la clé d'idempotence jusqu'à expiration ; l'email
correspondant est retiré immédiatement.

Le fichier local n'est pas une base multi-machine. N'utilisez pas le même
répertoire depuis plusieurs hôtes, un montage réseau, ou comme remplacement
d'une base de données. Le stockage persiste les corps, adresses du membre et
préférences ; protégez les sauvegardes comme des données privées. Les événements
Jobs et erreurs de ce module ne doivent jamais être enrichis avec ces valeurs.
La restauration d'une ancienne sauvegarde peut réintroduire des notifications
expirées ou supprimées : exécuter la purge après restauration et avant de
reprendre les workers. Aucun mécanisme de migration descendante ou d'écrasement
automatique n'est fourni.

## Vérification hors ligne

```sh
node --test tests/notifications.test.mjs
npm test
```

Les tests utilisent des répertoires temporaires et des doubles locaux pour
Auth/Tenancy ; les tentatives de livraison utilisent le module Jobs local. Ils
ne sollicitent ni réseau, ni SMTP, ni fournisseur distant.
