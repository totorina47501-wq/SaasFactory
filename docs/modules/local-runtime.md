# Runtime local — contrat v1

Le module fournit une configuration stricte par application, des diagnostics locaux et des modèles Compose/Docker neutres. Il ne lance pas de conteneur, ne télécharge pas de modèle, n'appelle aucun fournisseur et ne prépare aucun compte, DNS ou déploiement.

## Configuration

`validateLocalRuntimeConfig(value)` accepte exclusivement ce schéma versionné :

```js
{
  contractVersion: 1,
  appSlug: 'atelier-demo',
  appPort: 3000,
  postgres: { hostPort: 55432 },
  optional: { media: false, localModel: false, cache: false }
}
```

Le slug utilise uniquement des lettres minuscules ASCII, chiffres et tirets simples. Les ports doivent être des entiers de 1024 à 65535. Les champs absents, inconnus, de type invalide ou les versions non prises en charge provoquent `LocalRuntimeError` (`INVALID_CONFIGURATION`) avant toute action. Le résultat est une copie immuable. PostgreSQL est le service local de base; les ports de `appPort` et `postgres.hostPort` correspondent aux variables Compose `APP_PORT` et `POSTGRES_PORT`.

## Diagnostics

`diagnoseLocalRuntime(config, options?)` retourne un rapport versionné sans stdout/stderr ni détails d'erreur sensibles. Node est vérifié contre la plage prise en charge (22.12 à 26.x). FFmpeg/FFprobe sont vérifiés uniquement si `optional.media` est explicitement activé. PostgreSQL est sondé uniquement à `127.0.0.1` sur le port configuré par `pg_isready`, sans mot de passe ni shell. Les sondes peuvent être remplacées pour tests hors réseau. Un modèle n'est jamais chargé ni téléchargé : `optional.localModel` est faux par défaut et, lorsqu'il est activé, nécessite une `modelProbe` locale fournie par l'application.

Les services optionnels Redis et moteur de modèle exigent les profils Compose `cache` et `local-model`; aucun modèle n'est inclus ou téléchargé. Un cache activé est signalé `not-checked` par les diagnostics, qui ne prétendent pas vérifier sa disponibilité. Les limites CPU/mémoire sont fixées dans le Compose. Les volumes nommés ne montent aucun dossier hôte et le réseau est interne. Les ports publiés sont exclusivement bindés à `127.0.0.1`.

## Artefacts d'application

Copier `compose.yaml`, `Dockerfile` et `.dockerignore` dans l'application indépendante. Fournir `APP_SLUG`, `DATABASE_URL` avec l'hôte `postgres`, et `POSTGRES_PASSWORD` local uniquement dans l'environnement Compose ou un fichier `.env` local ignoré par le contrôle de version. Encoder les caractères spéciaux du mot de passe dans l'URL de connexion. Les valeurs sont injectées au lancement et aucune valeur secrète n'est `ARG`, `ENV` ou copiée dans l'image. Le Dockerfile exige un `package-lock.json`, construit l'application et l'exécute comme utilisateur `node` non-root. Le service app doit exposer un endpoint local `/health` conforme au health check.

Pour démarrer les services de base, exécuter manuellement `docker compose up --build`; les profils optionnels ne démarrent pas sans activation explicite. Pour inspecter les fichiers Compose sans démarrage, `docker compose config --quiet` ne requiert pas de connexion réseau mais attend la configuration locale requise. Aucun test de ce module ne lance Compose ou n'accède au réseau.

## Effets, erreurs et rollback

Le module est sans état et ses appels de configuration/diagnostic ne lancent ni génération, ni migration, ni déploiement. Un schéma ou une valeur invalide échoue fermé. Le rollback consiste à retirer les artefacts copiés et, si nécessaire, supprimer manuellement les volumes Compose après vérification : cette opération destructive n'est jamais automatisée.
