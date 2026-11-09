# Module UX — contrat v1

## Portée

Ce module fournit des composants neutres pour une application indépendante Next.js App Router, un contrat de routes et un adaptateur vers le service d'authentification locale de `modules/auth/`. Il n'ajoute pas de dépendance au dépôt Factory, ne crée pas les pages de l'application générée, et n'active aucun fournisseur distant. Importer explicitement les composants dans le projet généré et charger `design-system.css` depuis son point d'entrée.

Routes contractuelles : `/dashboard`, `/login`, `/signup`, `/reset-password`, `/reset-password/complete` et `/settings`. L'application consommatrice doit créer ses pages App Router et y fournir les actions serveur correspondantes. Les composants n'inventent aucun utilisateur, rôle ou résultat d'authentification.

Les pages `/dashboard` et `/settings` doivent être protégées côté serveur. La page des paramètres appelle `createUxSettingsActions(...).load()` et redirige vers `/login` si le résultat vaut `null`; elle ne doit pas accepter un utilisateur ou un rôle passé par le navigateur. Les routes de formulaire sont des composants et contrats à raccorder dans l'application générée, pas des pages générées automatiquement par ce module.

## Interfaces

- `UX_ROUTES` publie les cinq chemins stables.
- `LoginForm`, `SignupForm`, `PasswordResetRequestForm`, `PasswordResetCompleteForm` et `LogoutForm` prennent une action serveur compatible avec React `useActionState`. Les actions retournent `{ status: "success" | "error", message: string }` ; les erreurs visibles sont annoncées et les contrôles sont désactivés pendant l'envoi.
- `createUxAuthActions` exige une instance réelle du service auth local, l'origine configurée, un contexte serveur de limitation, la lecture de session/CSRF et des adaptateurs de cookies. Il appelle les méthodes locales `register`, `login`, `requestPasswordReset`, `completePasswordReset` et `logout`; il ne conserve aucun état d'identité côté client.
- `createUxSettingsActions` revalide la session locale pour chaque lecture et écriture. Le stockage fourni doit être local et persistant ; ses méthodes `loadForUser` et `saveForUser` reçoivent uniquement l'identifiant retourné par `auth.currentUser`, jamais une identité du formulaire. Une session absente retourne `null` à la lecture et bloque l'écriture avant accès au stockage.
- Les formulaires refusent les noms inconnus et dupliqués, les valeurs non textuelles, mal formées ou trop longues. Les diagnostics publics sont génériques et ne retournent ni erreur interne, ni mot de passe, ni jeton.

## Intégration et sécurité

Créer des Server Actions dans les pages du projet généré ; elles seules appellent les adaptateurs de ce module. Ne jamais transmettre l'instance auth, les cookies, le jeton CSRF, un identifiant d'utilisateur ou une fonction privilégiée au navigateur. `getCookieHeader`, `getCsrfToken`, `getRateLimitActor`, `setSessionCookies` et `clearSessionCookie` doivent lire/écrire le contexte de la requête côté serveur. Préserver les attributs de sécurité du cookie de session émis par le module auth (HttpOnly, SameSite et Secure selon l'origine) ; le jeton CSRF reste associé à la session et est fourni au serveur, pas au client.

`createUxSettingsActions` attend un magasin local dont les opérations sont indexées par l'identifiant authentifié ; le module ne fournit pas de magasin ni de migration de préférences. Une application doit fournir un stockage conforme ou ne pas proposer la page de préférences. Les valeurs d'authentification et paramètres sont échappés par le rendu React et ne sont jamais interpolés dans du HTML.

L'adaptateur de réinitialisation délègue au canal local déjà configuré dans le service auth. Aucun email distant, session simulée, secret, token prédéfini, compte de démonstration ou rôle client n'est fourni par ce module. Les erreurs de session et d'authentification échouent sans dégrader en utilisateur anonyme connecté.

## Accessibilité et présentation

Les composants fournissent des labels liés aux champs, des titres hiérarchiques, annonces `role=status`/`role=alert`, états de chargement, lien d'évitement, focus visible, menu mobile avec état ARIA et fermeture Échap, thèmes clair/sombre/système, grilles adaptatives et prise en compte de `prefers-reduced-motion`.

Vérification manuelle à réaliser dans l'application générée avant livraison : navigation complète au clavier et ordre de focus, ouverture/fermeture du menu mobile (dont Échap), zoom à 200 %, contraste mesuré sur les deux thèmes, annonces lecteur d'écran, et parcours d'erreur/chargement avec clavier. Ces vérifications manuelles ne sont pas déclarées effectuées par les tests du module.

## Erreurs, compatibilité et rollback

`createUxAuthActions` lève `UxActionError("INVALID_CONFIGURATION")` au démarrage si une dépendance requise manque ; les erreurs pendant les actions sont ramenées à des messages fermés. Une session invalide ou un magasin de préférences indisponible ne donne pas accès à des données. Les préférences valides sont limitées à `theme: system|light|dark` et `density: comfortable|compact`.

Le contrat v1 ne modifie pas les interfaces du service auth. Les chemins et types sont versionnés avec les sources Factory ; les changements incompatibles nécessitent un nouveau contrat et migration explicite. Le rollback consiste à retirer les imports UX et ses actions de l'application générée. Aucune donnée distante, migration ou modification du dépôt Factory n'est déclenchée.

## Preuves

`node --test tests/ux.test.mjs` vérifie les adaptateurs d'authentification et de préférences, l'absence de confiance dans un identifiant fourni par le client, le contrat de routes et des invariants structurels d'accessibilité/styles. Ces tests de sources ne remplacent ni un rendu navigateur ni une vérification automatique complète WCAG ; les tests clavier manuels ci-dessus restent à exécuter dans une application générée.
