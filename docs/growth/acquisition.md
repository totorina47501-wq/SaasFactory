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
