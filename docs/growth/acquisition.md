# Growth #65 — MVP offline indépendant

Ce sous-lot prépare le Growth Engine sans terminer ni clôturer #65. Il réutilise Growth Core #69 et la validation Intake existante : pas de nouveau parseur ni de second outil de dispatch.

## Contrat
Entrée : texte Intake JSON validé, startDate YYYY-MM-DD explicite, locale fr-FR ou en.
Sortie déterministe : ICP et problème à confirmer, trois pages SEO en brouillon, calendrier de six contenus datés, deux lead magnets sans collecte, funnel SEO → lead magnet → activation → démonstration → conversion, proposition d'expérience A/B non activée, exports JSON/Markdown.

Module : growth/acquisition/mvp.mjs
Fonctions : createAcquisitionMvp(rawIntake,{startDate,locale}) et exportAcquisitionMvp(plan,'json'|'markdown').
Exemple : node --input-type=module -e "import {readFileSync} from 'node:fs'; import {createAcquisitionMvp,exportAcquisitionMvp} from './growth/acquisition/mvp.mjs'; const p=createAcquisitionMvp(readFileSync('examples/intake-sample.json','utf8'),{startDate:'2026-11-09',locale:'fr-FR'}); process.stdout.write(exportAcquisitionMvp(p,'markdown'));"

## Garde-fous
Le plan reste draft-only : aucune publication, collecte de leads, emailing, achat média, intégration automatique, paiement, IA payante ni appel réseau. Les claims, la base légale et la conformité ne sont pas prouvés. Les calendriers sont des brouillons de planning et non des campagnes programmées.

La livraison complète #65 demeure soumise aux dépendances #44 (SEO/i18n), #41 (analytics consentis) et aux contrôles du coordinateur #59. Ce sous-lot ne doit pas modifier les dépendances du catalogue ni faire passer #65 directement à agent:approved. Il ne crée aucune nouvelle issue et ne modifie ni générateur, ni publication ni infrastructure.

MentionCheck Project3 #102 pourra consommer ce contrat depuis un Intake MentionCheck validé, avec adaptation et vérification des affirmations propres au produit. Aucune fonctionnalité n'est déclarée automatiquement déployée dans Project3.

Tester : npm test (tests/growth-acquisition.test.mjs et non-régressions existantes).

## Adaptateur SEO neutre (suite du MVP, dépendance #44)

Le fichier growth/acquisition/seo-preview.mjs constitue le pont de **prévisualisation hors réseau** avec modules/i18n-seo/index.mjs. Appel : createGrowthSeoPreview(rawIntake,{startDate,locale,origin}) puis exportGrowthSeoPreview(plan,'json' ou 'markdown').

Ce pont associe les idées Growth problem / solution / demo aux pages **neutres** autorisées /, /features et /about du contrat SEO #44. Les métadonnées indexables produites sont génériques et ne reprennent pas les hypothèses ou promesses commerciales non vérifiées du produit. Les titres du brief sont conservés uniquement en brouillon interne, avec requiresReview=true, publicationAllowed=false et contentApproved=false.

L'export comporte les huit URLs du sitemap public FR/EN, les directives robots de sécurité, les canonicals et alternates, ainsi que les indicateurs explicites : analytics non intégré, aucune collecte, aucune publication et aucun suivi automatique.

**Ce n'est pas une intégration Next.js ni un déploiement.** Les vrais chemins d'URL et la traduction doivent être branchés par l'adaptateur de l'app générée, puis vérifiés en CI/E2E. Le marketing MentionCheck reste propre à Project3 #102. La livraison complète de #65 conserve ses dépendances #44 et #41.

Tests supplémentaires : trois scénarios dans tests/growth-acquisition.test.mjs (FR/EN, séparation des affirmations non vérifiées, sécurité des origines et échecs fermés).
