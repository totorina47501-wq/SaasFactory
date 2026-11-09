# Authentification locale — contrat v1

**Version :** `1.0.0` · **API :** `createAuthService`, `createPostgresAuthStore`,
`runAuthMigrations` · **Statut :** implémenté pour le stockage PostgreSQL local
injecté et les flux de compte/session ; aucune authentification hébergée ni
notification distante n'est configurée.

Le module utilise uniquement les API cryptographiques intégrées à Node.js et le
pool PostgreSQL fourni par l'application. Il n'ouvre aucune connexion réseau,
n'ajoute aucune dépendance à la racine Factory et ne crée aucun compte au
démarrage. L'application doit fournir une origine canonique et un canal local
de reset explicitement contrôlé.

## Contrat et limites

`createAuthService({ store, origin, localResetChannel, clock? })` refuse les
options inconnues. `store` doit implémenter l'interface persistante ci-dessous ;
le service ne conserve aucun compte, session, jeton ou compteur de tentative en
mémoire. Les erreurs sont des `AuthModuleError` avec codes stables et messages
identiques aux codes ; aucun message de pilote, mot de passe, email, cookie ou
jeton n'est ajouté aux erreurs ou écrit dans un journal.

L'API versionnée fournit :

- `register({ email, password, origin, rateLimitActor })` : crée un compte à
  email normalisé en minuscules ; un doublon retourne le même `{ accepted: true }`
  que la création ;
- `login({ email, password, origin, rateLimitActor })` : renvoie un identifiant
  public minimal, un jeton CSRF et une valeur `setCookie` à écrire uniquement
  dans l'en-tête HTTP `Set-Cookie` (ne jamais sérialiser l'objet complet en JSON) ;
- `currentUser({ cookieHeader })` : renvoie `{ id }` ou `null` ;
- `rotateSession({ cookieHeader, csrfToken, origin })` et
  `logout({ cookieHeader, csrfToken, origin })` : vérifient origine et CSRF ;
  la rotation atomique invalide l'ancien cookie et logout le révoque ;
- `requestPasswordReset({ email, origin, rateLimitActor })` : répond toujours
  `{ accepted: true }`, y compris si le compte n'existe pas ou est limité ; le
  jeton est transmis uniquement au canal local ;
- `completePasswordReset({ token, newPassword, origin, rateLimitActor })` :
  consomme atomiquement le jeton valide, change le mot de passe et révoque tous
  les resets et sessions de ce compte.

Les origines des opérations mutantes doivent correspondre exactement à l'origine
configurée. HTTPS impose le cookie `__Host-sf_session; Path=/; Secure`; HTTP
n'est accepté qu'en loopback (`localhost`, `127.0.0.1`, `[::1]`) et utilise
`sf_session` sans attribut `Secure`. Dans les deux modes, le cookie est
`HttpOnly; SameSite=Strict`, sans `Domain`. Les tokens de session et reset sont
des valeurs opaques aléatoires de 256 bits ; seules leurs empreintes SHA-256
sont persistées. Les sessions durent 12 heures, les resets 30 minutes.

Les mots de passe exigent 12 à 1024 octets UTF-8 et sont hachés via
`scrypt(N=32768, r=8, p=1, keyLength=64, maxmem=67108864)` avec sel aléatoire
de 16 octets. L'opération de hachage est plafonnée à quatre calculs concurrents
par processus. Toute hausse de paramètres ou limite nécessite une nouvelle
version de contrat et des mesures de capacité.

Les limites persistantes sont fixes sur des fenêtres de 15 minutes : création
5 par email / 20 par acteur réseau, login 8 / 50, demande de reset 4 / 20 et
validation de reset 10 par acteur. `rateLimitActor` doit provenir d'une frontière
de confiance (adresse du pair ou proxy explicitement approuvé) ; ne faites pas
confiance à un en-tête `X-Forwarded-For` fourni directement par un client. Les
identifiants de limite stockés sont des empreintes, jamais l'email ou l'adresse
en clair. Une limitation de login renvoie `RATE_LIMITED`; une demande de reset
limitée conserve sa réponse générique.

## Stockage PostgreSQL local

`createPostgresAuthStore({ pool, schemaName })` fournit le stockage persistant.
Le schéma est validé avant interpolation ; toutes les valeurs SQL restent des
paramètres liés. `runAuthMigrations(pool, schemaName)` s'appuie sur le module
database v1 : il exécute ses migrations communes et ajoute la migration
immuable `auth@1.0.0` avec contraintes d'unicité d'email, références, indexes,
empreintes de tokens et compteurs. Les opérations de rotation et de reset sont
transactionnelles ; la consommation de jeton est atomique. Le pool doit utiliser
un rôle runtime dédié aux droits minimaux, et non le rôle de migration ou un
superuser. Cette migration ajoute uniquement les tables `auth_*` ; elle ne
modifie pas les tables ni les migrations du module database.

Exemple d'intégration dans l'application indépendante (le pilote `pg` doit être
installé/configuré séparément par cette application) :

```js
import { Pool } from 'pg';
import {
  createAuthService,
  createPostgresAuthStore,
  runAuthMigrations,
} from './modules/auth/index.mjs';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
await runAuthMigrations(pool, 'atelier_app');
const auth = createAuthService({
  store: createPostgresAuthStore({ pool, schemaName: 'atelier_app' }),
  origin: 'http://localhost:3000',
  localResetChannel: {
    kind: 'local',
    async deliver(message) {
      await localPrivateResetInbox.write(message);
    },
  },
});
```

Le reset channel est une capacité privilégiée fournie par l'application :
`kind: 'local'` ne valide pas le transport du callback. Celui-ci doit remettre
le lien dans une boîte locale privée et contrôlée, jamais répondre avec le jeton,
l'imprimer dans les logs ou le transmettre à un email/API distante. L'application
doit également rendre `csrfToken` uniquement au contexte de même origine et
l'envoyer dans les opérations mutantes authentifiées. Le module ne décide pas
des rôles, appartenances, autorisations métier, MFA ou politique de verrouillage
du compte.

## Interface minimale du magasin

Le magasin fourni à `createAuthService` implémente exactement les comportements
suivants (les noms de méthodes sont normatifs) :

| Méthode | Garantie |
| --- | --- |
| `findUserByEmail(email)` / `findUserById(id)` | Retourne `null` ou `{ id, email, passwordHash }`. |
| `createUser(user)` | Insert atomique avec email unique insensible à la casse ; retourne un booléen. |
| `createSession(session)` / `findSessionByTokenHash(hash)` | Persiste la session ; la lecture ne renvoie que `userId`, `csrfHash`, `expiresAt`. |
| `deleteSessionByTokenHash(hash)` / `deleteSessionsByUserId(id)` | Révocation effective. |
| `rotateSession(oldHash, session)` | Remplacement atomique : une seule session reste utilisable. |
| `createResetToken(reset)` / `revokeResetToken(hash)` | Persiste / révoque uniquement l'empreinte du jeton. |
| `completePasswordReset({ tokenHash, passwordHash, now })` | Un unique gagnant consomme le jeton non expiré, change le hash, supprime tous les resets et révoque toutes les sessions, dans une transaction. |
| `consumeRateLimit(key, limit, windowMs, now)` | Incrémente atomiquement un compteur persistant et retourne le booléen d'autorisation. |

Un magasin volatil ou non atomique ne satisfait pas ce contrat. Les tests Factory
utilisent un magasin local synthétique conservé entre instances de service ;
l'intégration d'application doit utiliser l'adaptateur PostgreSQL ou un magasin
persistant équivalent avec les mêmes garanties.

## Erreurs, validation, rollback

Les codes publics comprennent `INVALID_INPUT`, `INVALID_CONFIGURATION`,
`ORIGIN_REJECTED`, `RATE_LIMITED`, `AUTHENTICATION_FAILED`, `INVALID_SESSION`,
`RESET_INVALID`, `INVALID_STORE`, `INVALID_RESET_CHANNEL` et `UNAVAILABLE`.
Les échecs de login inconnus et mauvais mots de passe sont identiques ; les
jetons reset inconnus, expirés et rejoués sont indistinguables. Aucune API ne
retourne un hash de mot de passe. Le module n'émet pas de logs.

Les comptes et données auth sont des données de l'application : sauvegardez le
schéma avant application d'une migration et validez la restauration dans un
schéma jetable. Il n'y a pas de migration descendante destructive. En cas de
rollback applicatif, arrêtez les écritures auth et conservez les tables ; ne
supprimez ni sessions ni comptes pour revenir en arrière.

Tests hors réseau et sans dépendance PostgreSQL :

```sh
node --test tests/auth.test.mjs
npm test
```

Les tests PostgreSQL optionnels du module database restent séparés et ne doivent
être exécutés que contre une base locale jetable. Aucune validation externe ou
qualification de production n'est revendiquée par les tests Factory.
