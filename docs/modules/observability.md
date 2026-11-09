# Observabilité locale — contrat v1

**Version :** `1.0.0` · **API :** `createObservabilityService` ·
**Statut :** module local implémenté dans Factory ; il n'est pas installé dans
une application générée. Aucune dépendance de monitoring SaaS n'est utilisée.

Le module fournit des logs JSON structurés, des diagnostics sans secrets, des
health checks locaux, des compteurs et un audit local. Il ne démarre aucun
serveur, worker, timer ou exporteur réseau. L'application doit appeler
explicitement les fonctions et raccorder ses propres contrôles de santé.

## Configuration et API

```js
import { createObservabilityService } from './modules/observability/index.mjs';

const observability = createObservabilityService({
  directory: '/var/lib/my-saas/observability',
  checks: {
    database: async () => database.ping(),
    jobs: async () => jobsHealthCheck(),
  },
  authorizeAuditRead: context => canReadAudit(context),
});

observability.log({
  level: 'info',
  event: 'request.completed',
  requestId,
  operation: 'account.read',
  status: 'ok',
  durationMs: 14,
});
```

Les options et les objets d'entrée sont fermés : les propriétés inconnues,
accesseurs et prototypes non simples sont refusés. `directory` doit être un
chemin absolu normalisé, sans lien symbolique ; les dossiers créés sont privés
(`0700`). Les répertoires ou fichiers d'audit existants avec permissions
group/monde accessibles sont refusés.

### Logs et erreurs

`log({ level, event, requestId?, operation?, status?, code?, durationMs?, count?, ... })`
écrit un enregistrement JSON en une ligne sur `stdout` par défaut. Un
`writeLog(record)` local peut remplacer ce canal. Les valeurs sont limitées à
des champs et formats précis ; les champs inconnus ou sensibles (cookies,
autorisations, secrets, email, téléphone, payload, message, stack, etc.) sont
omis et le nombre omis est indiqué par `redactedFields`. Les champs texte
acceptés doivent être des codes statiques de l'application, jamais des valeurs
fournies par un utilisateur. Aucun message d'erreur, trace, contenu de requête,
cookie, token ou PII n'est écrit. Un `requestId` qui n'est pas un UUID est
remplacé par un UUID généré.

`recordError({ code, requestId? })` conserve seulement un code stable au format
`A-Z0-9_` et un ID de corrélation UUID. Toute autre valeur devient `OTHER`.
`metrics()` expose des compteurs du processus et au plus `maxRecentErrors`
entrées d'erreurs récentes ; ce stockage en mémoire est perdu au redémarrage.

### Health checks et diagnostics

- `liveness()` retourne seulement `{ status: "ok" }`.
- `readiness()` appelle séquentiellement les fonctions `checks.database` et
  `checks.jobs` configurées. Un résultat autre que `true`, une exception ou un
  timeout donne `unavailable`, sans message technique. La limite par défaut est
  1 seconde, configurable de 1 à 5 secondes. Sans contrôle configuré, la réponse
  est prête avec un objet `checks` vide ; elle ne certifie pas les dépendances
  qui n'ont pas été enregistrées.
- `environmentDiagnostics()` expose uniquement version Node, plateforme,
  architecture, un `NODE_ENV` parmi `development`, `test`, `production` et la
  durée du processus. Il ne retourne pas l'environnement complet.

Aucun de ces appels ne crée de route HTTP : l'application doit publier les
réponses selon son propre contrat local.

### Métriques

`metrics()` retourne les compteurs en mémoire `requests_total`,
`errors_total`, `readiness_failures_total`, `audit_events_total` et
`cleanup_runs_total`, les erreurs par code et un historique d'erreurs borné.
Il n'y a pas de labels à cardinalité libre, de scraping distant ni d'export.

### Interface d'audit commune

L'interface `audit.append(context, event)` accepte un contexte exact
`{ contractVersion: 1, tenantId, requestId }` et un événement sans contenu libre
`{ action, outcome, resourceType, resourceId?, actorId? }`. Les identifiants
doivent être des UUID ; `outcome` est `success`, `failure` ou `denied`.
L'événement persisté contient l'ID d'événement généré, l'heure, le tenant, la
requête et les champs validés. Il ne contient ni payload, ni cookie, ni message.

Les événements sont ajoutés en JSONL dans `audit/`, fichiers `0600`. La lecture
est uniquement disponible via `audit.read(context)` après autorisation
asynchrone explicite de `authorizeAuditRead(context) === true` ; les résultats
sont isolés par tenant et limités aux 1 000 plus récents. L'interface n'expose
aucune modification ou suppression. Le stockage est borné par rotation :

| Limite | Défaut | Bornes |
| --- | ---: | ---: |
| Taille maximale par fichier | 256 KiB | 512 B–1 MiB |
| Fichiers conservés, fichier courant inclus | 10 | 2–20 |
| Rétention des segments archivés | 30 jours | 0–365 jours |
| Erreurs récentes en mémoire | 50 | 1–100 |

`cleanup()` supprime les segments archivés expirés ou excédant la limite et les
entrées d'erreurs récentes expirées. Le fichier courant n'est pas supprimé.
`createCleanupHandler()` fournit un handler compatible avec `modules/jobs`.
`scheduleCleanup({ jobs, authorization, intervalMs })` ajoute un job
`observability.cleanup` idempotent par fenêtre, sur la file Jobs locale. Une
invocation périodique de cette méthode relève de l'application ; le module ne
crée pas de scheduler et ne démarre pas le worker. `jobs.run()` ou `runOnce()`
reste un démarrage explicite suivant le contrat Jobs. Le cookie sert uniquement
à l'autorisation de l'enqueue et n'est ni retourné ni journalisé.

## Erreurs, limites et exploitation

Les erreurs publiques ont un code stable (`INVALID_INPUT`,
`INVALID_CONFIGURATION`, `UNSAFE_STORAGE`, `AUDIT_READ_DENIED`, `AUDIT_LIMIT`,
`AUDIT_UNAVAILABLE`, `JOBS_UNAVAILABLE`, `INTERRUPTED`, `UNAVAILABLE`). Les
erreurs des vérifications DB/Jobs et de la file sont rendues génériques ; leur
message ou leur trace n'est jamais conservé par le module.

L'implémentation sérialise les ajouts pour une instance du service dans un
processus Node local. Elle ne fournit ni verrou distribué, ni garantie contre
la modification par un administrateur local, ni chaîne de hachage/signature
anti-altération. Restreindre l'accès OS au répertoire et ne pas partager le
répertoire entre machines. Une panne de lecture/écriture d'audit échoue sans
réponse partielle silencieuse. Les notifications/logs ne changent pas le résultat
de l'application, mais l'API d'audit retourne une erreur si la persistance échoue.

Pour revenir en arrière, arrêter le consommateur Jobs local et retirer
l'intégration explicite du service ; conserver ou archiver le répertoire
d'audit conformément à la politique locale avant toute suppression. Le rollback
ne nécessite aucune migration ni action distante.

## Tests

Les tests sont hors réseau et sans fournisseur :

```sh
node --test tests/observability.test.mjs
npm test
```

Ils couvrent la redaction des secrets/cookies/PII, les IDs de corrélation, les
health checks DB/Jobs défaillants et expirés, les diagnostics, les compteurs
d'erreurs bornés, l'isolation et les permissions de lecture d'audit, la rotation,
la rétention, l'enqueue Jobs idempotent et les chemins avec lien symbolique.
