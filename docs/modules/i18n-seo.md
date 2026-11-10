# SFV3-I18N / #44 — localisation et SEO neutres

Statut : contrat de module réutilisable. Ceci n'est **pas une preuve de branchement automatique au générateur**. Aucune marque, donnée métier ni code Project3 copié.

## Interface (Node >=22, hors réseau)

Le fichier modules/i18n-seo/index.mjs expose une API pure : t, localeFromInput, countItems, formatDate, formatNumber, createLocalePreference, publicMetadata, privateMetadata, createSitemap, createRobots, marketingPage, checkDictionaryParity.

FR (fr-FR) et EN (en) avec parité des clés et paramètres, échappement HTML des interpolations, rejet des arguments inconnus et fallback explicite FR. Dates, nombres et pluriels sont formatés avec Intl.

La préférence utilise createLocalePreference(storage), un adaptateur injecté compatible getItem/setItem. Aucun cookie ou accès à une API navigateur depuis le module. L'application consommatrice peut injecter un stockage navigateur non sensible et doit fournir une UI accessible pour changer de langue.

## SEO public / privé

Liste blanche : /, /features, /pricing, /about. Chaque URL publique dispose d'un canonical HTTPS et d'alternates FR/EN. createSitemap produit les 8 URLs publiques déterministes. createRobots fournit des règles excluant notamment /dashboard, /api, /auth, /settings, /admin, /billing, /account et /_next. Ne pas déclarer qu'un fichier robots empêche à lui seul toute indexation : les routes privées doivent aussi envoyer des réponses adaptées, utiliser privateMetadata() et être protégées par authentification.

Le contenu marketing est strictement neutre et en brouillon, sans prix réel, marque ni promesse réglementaire. Les objets retournés par marketingPage indiquent publishEnabled=false ; aucun CMS, réseau ou fournisseur n'est déclenché.

Exemple :

    import {publicMetadata,createRobots,createSitemap} from './modules/i18n-seo/index.mjs';
    const origin='https://example.org';
    const meta=publicMetadata({origin,locale:'fr-FR',route:'/features'});
    const robots=createRobots({origin});
    const sitemap=createSitemap({origin});

## Intégration et dépendances

Le générateur doit explicitement adapter ces objets aux APIs Next.js et aux composants UI. La présence d'un module sous modules/i18n-seo/ ne prouve ni son inclusion dans un SaaS généré, ni le routage localisé, ni l'accessibilité clavier. Le catalogue peut garder le statut scaffold jusqu'à validation sur une application réellement générée.

Growth #65 pourra utiliser ce contrat pour des pages neutres, mais reste dépendant de #44 final et d'Analytics #41 pour la promotion complète. Le sous-lot Growth MVP #98 reste inchangé et ne doit pas être dupliqué.

## Tests, sécurité et rollback

Exécuter node --test tests/i18n-seo.test.mjs puis npm test ; la CI sur SHA exact fait autorité. Les tests couvrent la parité, injection/échappement, négociation locale, pluriels, dates et nombres, préférences sans cookie, whitelists de routes, canonical, sitemap, robots et pages neutres.

L'intégration à l'app générée et les tests E2E (navigation clavier, langue persistée côté interface, métadonnées rendues, exclusion réelle des pages privées) restent à compléter avant clôture #44. Aucun fichier partagé, secret, migration, déploiement ou prestataire. Rollback : retrait de l'import ou revert de la PR.

## Opt-in neutral generated-app localization (10 November 2026)

Module: modules/i18n-seo/generated-overlay.mjs, integrateNeutralI18nSeo({projectDir, origin, write}).
Preview without writes by default; explicit write:true only into an untouched independent ai-disabled starter.
Rejects symlinks, an existing Git repository, nonneutral app routes and unsafe HTTP origins.
Preserves the neutral root route under Next.js (default) route group, moves smoke test import,
creates eight FR/EN marketing routes with locale-specific root HTML lang, keyboard-native links,
canonical/hreflang metadata and private-route robots exclusions.
All generated marketing pages remain DRAFT ONLY and noindex; sitemap is intentionally empty.
No production publication, provider, payment or authentication enabled.

Tests: node --test tests/i18n-seo.test.mjs then npm test. A real Next.js build, browser E2E
and final integration into the assembled starter #52 remain additional gates (#53).
This overlay is opt-in; it is NOT installed by the core generator by default.
Rollback: regenerate a clean independent project, or revert this module PR.
