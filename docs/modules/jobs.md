# Module Jobs local v1

## Portée et limites

`modules/jobs/index.mjs` fournit une file persistante locale pour des tâches
explicitement déclenchées. La création du service et l'ajout d'un job ne
démarrent aucun traitement. L'appelant doit lancer `runOnce()` ou `run()` et
fournir une table explicite de handlers. Aucune commande, tâche coûteuse,
connexion réseau ou exécution de payload n'est lancée automatiquement.

Le contrat exporté `jobsContract` est version `1`. L'état est conservé dans
`jobs-v1.json`, remplacé atomiquement après chaque mutation sous verrou local.
Le répertoire doit être un chemin absolu, existant ou créable comme dernier
composant, canonique, sans lien symbolique et privé (`0700`). Le fichier et le
verrou sont privés (`0600`). La file, ses payloads et ses événements ne doivent
pas être partagés entre machines, montés sur un système de fichiers réseau, ni
utilisés comme substitut à une base de données multi-région.

Les payloads sont des objets JSON bornés. Les champs inconnus de l'API, les
accès par getters, les clés évoquant des secrets et les payloads trop grands
sont refusés. Les erreurs persistées sont des codes sans message ni trace
technique. Les notifications ne contiennent ni payload, ni tenant, ni message
d'erreur. Un payload métier ne doit pas contenir de secret, donnée personnelle
ou information qui n'est pas nécessaire au handler.

## API

```js
import { createJobsService } from './modules/jobs/index.mjs';

const jobs = createJobsService({
  directory: '/var/lib/my-saas/jobs',
  tenancy, // service du module tenancy, avec resolveTenantContext()
  limits: {
    maxQueueSize: 500,
    maxWorkers: 2,
    leaseMs: 30_000,
    maxAttempts: 3,
  },
});

const job = await jobs.enqueue({
  cookieHeader,
  tenantId,
  requestId,
  type: 'report.generate',
  idempotencyKey: 'report-request-123',
  payload: { reportId: 'local-report-1' },
});

await jobs.runOnce({
  handlers: {
    'report.generate': async ({ payload, tenantContext, signal, attempt, limits }) => {
      // Handler local explicitement enregistré ; respecter signal et idempotence.
    },
  },
});
```

Le service appelle `tenancy.resolveTenantContext()` avant chaque lecture,
création ou annulation. Le tenant est pris du contexte validé par le module
tenancy, jamais du seul ID demandé. Les lectures, clés d'idempotence et
annulations sont isolées par tenant. Un job d'un autre tenant se comporte comme
un job inexistant (`NOT_FOUND`). Le handler reçoit le contexte de tenant
persisté ; il doit réautoriser toute nouvelle action ou écriture à travers les
modules correspondants.

- `enqueue(input)` : crée un job `queued`. La clé d'idempotence est unique dans
  un tenant ; même clé/type/payload canonique retourne le job existant, mais un
  contenu différent renvoie `IDEMPOTENCY_CONFLICT`.
- `get(input)` et `list(input)` : renvoient uniquement les métadonnées, jamais le
  payload.
- `events(input)` : retourne les événements du tenant, sans tenant ID ni payload.
- `cancel(input)` : annule un job en attente ou demande l'annulation d'un job
  actif via `AbortSignal`.
- `runOnce({handlers, type?})` : réclame et exécute au plus un job disponible.
- `run({handlers, concurrency?, pollIntervalMs?, signal?})` : démarre une boucle
  de workers jusqu'à l'abort du signal. Cette méthode n'est jamais appelée par
  `createJobsService` ou `enqueue`.
- `subscribe(listener)` et l'option `notify(event)` : reçoivent les mêmes
  événements minimaux après persistance. Une erreur de notification ne modifie
  pas le résultat de la file.

Les états v1 sont `queued`, `running`, `succeeded`, `failed` et `cancelled`.
Les erreurs publiques ont un `code` stable sur `JobsModuleError` :
`INVALID_INPUT`, `INVALID_CONFIGURATION`, `INVALID_TENANT_CONTEXT`,
`TENANT_ACCESS_DENIED`, `NOT_FOUND`, `INVALID_PAYLOAD`, `PAYLOAD_TOO_LARGE`,
`IDEMPOTENCY_CONFLICT`, `QUEUE_FULL`, `QUEUE_BUSY`, `CORRUPT_QUEUE`,
`UNSAFE_STORAGE`, `UNSAFE_STORAGE_DIRECTORY`, `STORAGE_LIMIT`,
`STORAGE_UNAVAILABLE`, `LOCK_RECOVERY_REQUIRED`, `TIME_RANGE`, `JOB_TIMEOUT`
et `JOB_FAILED`. `HANDLER_UNAVAILABLE` et `LEASE_EXPIRED` sont des codes
d'erreur persistés sur les jobs.

## Bornes, reprise et garanties

Les limites configurables ont des valeurs bornées par défaut : 1 000 jobs
actifs, 2 workers, 3 tentatives, payload de 64 KiB, 1 000 événements conservés
et 64 MiB de stockage JSON. Les leases et délais de retry sont plafonnés à un
jour, et le timeout par défaut à cinq minutes. Toute limite atteinte refuse la
nouvelle opération sans écraser l'état. Les jobs terminaux et leurs clés
idempotentes restent persistés ; l'atteinte de la limite disque requiert une
sauvegarde puis une purge opérateur explicite du répertoire, ce qui réinitialise
aussi l'historique d'idempotence.

Une réclamation crée un lease à jeton aléatoire et un heartbeat prolonge le
lease durant un handler asynchrone. Après crash, un autre worker réactive un job
dont le lease a expiré, dans la limite de `maxAttempts`. Le backoff est
exponentiel, déterministe et plafonné. Un job peut donc être exécuté plusieurs
fois après crash ou lease expiré : les handlers doivent être idempotents. Le
jeton de lease empêche un ancien worker de modifier l'état après sa reprise,
mais ne peut pas annuler un effet externe déjà parti. L'annulation et le timeout
envoient un signal coopératif ; le handler doit le surveiller et s'arrêter
proprement. Un handler synchrone bloquant ou qui ignore le signal ne peut pas
être arrêté de façon portable par ce module.

La récupération des leases est indépendante du verrou de transaction local. Si
un processus s'arrête pendant l'étroite section de récupération d'un verrou
stale, le verrou `.reaper` est laissé intact et les appels échouent
`LOCK_RECOVERY_REQUIRED` plutôt que de risquer deux propriétaires. Arrêter les
workers, vérifier que le processus propriétaire n'existe plus, puis supprimer
manuellement uniquement le fichier `.reaper` abandonné avant de reprendre.

`maxWorkers`, la taille de file, la taille du payload et la taille du stockage
sont des contrôles effectifs entre processus locaux utilisant ce même
répertoire. Le budget CPU est mesuré au niveau du processus Node et le budget
mémoire compare le RSS du processus ; les deux mesures sont approximatives et
peuvent inclure d'autres jobs. Leur dépassement produit
`job.resource-budget-exceeded`, sans interrompre le handler. Le timeout émet
un signal coopératif, pas une terminaison forcée. Le module ne détecte ni ne
configure de quota CPU/RAM du système d'exploitation ou du conteneur :
`jobsContract.limitEnforcement` le déclare explicitement. Les limites OS
nécessitent un superviseur externe configuré séparément.

## Tests, exploitation et rollback

Les tests `node --test tests/jobs.test.mjs` n'ont besoin ni réseau, ni base,
ni fournisseur. Ils couvrent l'idempotence et la reprise depuis disque, les
leases expirés, les jobs corrompus, les limites, le tenant, les tentatives,
l'annulation et les notifications.

Pour une sauvegarde ou un rollback, arrêter les workers, copier le répertoire
privé complet vers une sauvegarde locale protégée, puis restaurer ce répertoire
après avoir arrêté tous les workers. Ne jamais éditer le JSON actif à la main :
une corruption est refusée (`CORRUPT_QUEUE`) et ne déclenche pas de réparation
ou d'écrasement automatique. Une sauvegarde ancienne peut réintroduire des jobs
déjà exécutés ; vérifier les effets idempotents avant reprise. La suppression
du répertoire est une action destructive et explicite, et efface également les
clés d'idempotence et l'historique.
