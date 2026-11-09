# MFA locale — contrat v1

**Version :** `1.0.0` · **API :** `createMfaService`, `createPostgresMfaStore`,
`runMfaMigrations` · **Statut :** module local implémenté ; il n'est pas
automatiquement raccordé aux sessions ou à l'écran de connexion d'une
application générée. Aucun fournisseur d'identité, service distant ou secret
d'exemple n'est inclus.

## Contrat et prérequis

Le service utilise les API cryptographiques intégrées à Node.js et le PostgreSQL
local déjà utilisé par le module `auth`. `runMfaMigrations(pool, schemaName)`
enregistre les migrations auth et MFA ensemble dans le registre versionné du
module database, et crée les tables dépendantes dans le même schéma. Les deux
modules doivent utiliser le même schéma. Les migrations n'ont pas de migration
descendante destructive.

`createMfaService({ store, encryptionKey, reauthenticate, clock? })` refuse les
options inconnues. `encryptionKey` doit être un `Buffer` de 32 octets fourni
par l'application. Il n'existe ni clé par défaut ni clé de démonstration. La
clé doit être générée aléatoirement et conservée séparément de la base locale ;
une perte ou une rotation non coordonnée rend les secrets TOTP existants
illisibles. Ne la placez jamais dans le dépôt, les journaux ou la base.
`reauthenticate({ userId, password })` doit vérifier le mot de passe du compte
concerné depuis la source d'identité faisant autorité et renvoyer exactement
`true` ; une erreur ou toute autre valeur refuse l'opération.

Toutes les entrées sont strictes : UUID d'utilisateur, champs supplémentaires
refusés et acteur de limite issu d'une frontière de confiance (comme pour
`auth.rateLimitActor`, ne faites pas confiance à un `X-Forwarded-For` fourni
directement par le client). Les erreurs sont des `MfaModuleError` aux codes
stables ; les erreurs de stockage et de déchiffrement échouent sans divulguer
leur contenu.

## API v1

- `beginEnrollment({ userId, password, rateLimitActor })` exige une
  réauthentification, génère un secret TOTP de 160 bits, et ne persiste que sa
  forme chiffrée AES-256-GCM. Renvoie le secret et l'URI `otpauth://` une seule
  fois afin que l'application puisse afficher un QR code localement.
- `confirmEnrollment({ userId, password, code, rateLimitActor })` exige à
  nouveau une réauthentification et un TOTP valide. L'activation et
  l'enregistrement atomique des empreintes de dix codes de récupération sont
  faits ensemble ; les codes bruts sont renvoyés une seule fois.
- `verify({ userId, code, rateLimitActor })` vérifie soit un TOTP, soit un code
  de récupération. Un succès consomme atomiquement le pas TOTP ou le code de
  récupération, et renvoie le facteur utilisé.
- `disable({ userId, password, code, rateLimitActor })` exige une
  réauthentification ainsi qu'un facteur valide ; l'opération supprime la
  configuration active et tous les codes de récupération de façon atomique.

Une application doit demander à son utilisateur de conserver les codes de
récupération en lieu sûr et ne doit ni les journaliser ni les renvoyer dans des
réponses ultérieures. Le module n'émet pas de logs et ne retourne jamais les
empreintes stockées. Les codes sont des valeurs aléatoires de 128 bits ; seule
leur empreinte SHA-256 est persistée. La suppression SQL `DELETE ... RETURNING`
garantit qu'une utilisation concurrente a un gagnant unique.

## TOTP, rejeu et limitation

Le contrat utilise TOTP RFC 6238 avec HMAC-SHA1, six chiffres et une période de
30 secondes. Une dérive maximale d'un pas avant ou après l'horloge locale est
acceptée. Le pas accepté est mis à jour par une écriture conditionnelle en base ;
le même code ne peut donc pas être accepté deux fois, y compris par des appels
concurrents. Une horloge invalide ou un secret chiffré illisible fait échouer
l'opération.

Les appels d'enrôlement, de confirmation, de vérification et de désactivation
utilisent chacun deux limites persistantes, sur des empreintes d'identité et
d'acteur : respectivement 5, 8, 8 et 8 tentatives par fenêtre de 15 minutes et
par identité ; la limite acteur est quatre fois plus élevée. Les compteurs
réutilisent `auth_rate_limits`, avec des buckets SHA-256 et une mise à jour SQL
atomique. Un dépassement renvoie `RATE_LIMITED`.

Codes d'erreur principaux : `INVALID_INPUT`, `INVALID_CONFIGURATION`,
`INVALID_STORE`, `REAUTH_FAILED`, `RATE_LIMITED`, `MFA_ALREADY_ENABLED`,
`ENROLLMENT_NOT_FOUND`, `MFA_NOT_ENABLED`, `INVALID_CODE` et `UNAVAILABLE`.
Les facteurs invalides, expirés, déjà consommés ou inconnus sont indistinguables.

## Intégration locale

L'application fournit le pool PostgreSQL, une clé propre et la fonction de
réauthentification. Générez la clé dans l'environnement local de l'application
(par exemple avec `randomBytes(32)`), placez-la dans un stockage local privé, et
ne copiez jamais sa valeur dans le code ou les exemples.

```js
import { createMfaService, createPostgresMfaStore, runMfaMigrations } from './modules/mfa/index.mjs';

await runMfaMigrations(pool, 'atelier_app');
const mfa = createMfaService({
  store: createPostgresMfaStore({ pool, schemaName: 'atelier_app' }),
  encryptionKey: appOwnedMfaKey,
  reauthenticate: async ({ userId, password }) => verifyCurrentPassword(userId, password),
});
```

Le service n'établit aucune connexion, ne contacte aucun réseau, et ne démarre
aucune migration à l'import. L'application doit elle-même décider où présenter
l'enrôlement, où stocker temporairement le secret renvoyé et comment exiger
`verify` avant de créer une session authentifiée. `verify` est un contrôle de
facteur, pas une création de session ni une autorisation métier ; ne le traitez
pas comme une intégration complète du parcours de connexion.

Le magasin implémente `beginEnrollment`, `getAuthenticator`,
`activateEnrollment`, `consumeTotpStep`, `consumeRecoveryCode`, `disableMfa` et
`consumeRateLimit`. L'adaptateur PostgreSQL valide le schéma avant toute
interpolation et lie les valeurs en paramètres SQL. Les tables MFA dépendent
des tables locales `auth_users` et `auth_rate_limits`.

## Tests et rollback

Les tests hors réseau et sans dépendance PostgreSQL :

```sh
node --test tests/mfa.test.mjs
npm test
```

Ils couvrent les vecteurs RFC, le chiffrement, la dérive temporelle, le rejeu,
les tentatives limitées, la récupération concurrente, l'isolation d'utilisateur,
la réauthentification, la révocation et les requêtes SQL. Ils ne constituent pas
une qualification d'un déploiement ou d'un fournisseur.

Pour revenir en arrière au niveau applicatif, arrêtez les écritures MFA et
conservez les tables et la clé afin de permettre une restauration. Ne supprimez
pas la migration ou les données en production et n'effectuez aucune rotation de
clé sans migration explicite des secrets chiffrés.
