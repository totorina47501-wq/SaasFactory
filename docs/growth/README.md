# SaaS Factory — Growth & Revenue Foundation v1

> Statut **prototype local**. Ce lot ne constitue pas une CRM de production, une solution d'envoi ni un système de facturation réel.

## Architecture réutilisable (Node 22, TypeScript/Next.js compatible)

| Couche | Livrable actuel | Limite |
| --- | --- | --- |
| Market validation | `growth/core/market.mjs` depuis l'Intake validé | Hypothèses **non vérifiées**, pas de recherche web |
| Acquisition | Plans SEO/contenu/outreach **en brouillon**, budget zéro | Aucun CMS ni fournisseur activé |
| Sales | `growth/core/crm.mjs` : leads pseudonymes, étapes, oppositions, brouillons | **En mémoire uniquement**, pas de messagerie ni base persistante |
| Revenue / Analytics | `growth/core/metrics.mjs` : événements consentis, déduplication, first/last touch, 90 jours | **Revenus simulés**, pas de paiement réel |
| Growth optimization | `recommendNextActions` : suggestions non exécutées | Pas de véritable expérimentation ou de signification statistique |
| Agents | `.github/skills/*` : instructions transférables à Copilot | Pas de nouveau rôle de dispatch ni de runtime Paperclip/Opensoul |

## Exécuter sans réseau

```sh
npm test
node growth/cli.mjs --input examples/intake-sample.json
node growth/cli.mjs --input examples/intake-sample.json --events examples/growth-events.json --as-of 2026-11-07T12:00:00.000Z
```

CLI **lecture seule**, stdout JSON uniquement, aucune écriture de fichier ni issue GitHub. Le validateur Intake existant est la source de vérité ; pas de modification de `generate.mjs` ni d'ajout fictif au starter.

Pour une utilisation dans un SaaS généré, ces modules sont **bibliothèques de référence** destinées à être intégrées après mise en place d'Auth, du multi-tenant, du stockage durable et du registre. Leur présence dans ce dépôt **ne signifie pas qu'ils sont embarqués automatiquement**. Leurs extensions sont suivies par #64, #65, #66, #70, #71, sous dépendances strictes.

## Confidentialité et sécurité

- Aucune synchronisation de prospects, collecte de cookies, pixel, email ou canal payant ; **aucun connecteur externe**.
- Les leads portent des identifiants pseudonymes et des segments, sans champs de coordonnées. Le CRM permet les oppositions et refuse tout champ non reconnu.
- L'analytics accepte uniquement des identifiants pseudonymes, rejette les événements d'autres tenants, ignore le défaut de consentement, annule les métriques pour un sujet opposé et borne les données à 90 jours.
- Les données d'opposition doivent être conservées par un module de production persistant avant toute activation d'une campagne ; la démonstration actuelle n'assure **aucune persistance**.
- Une activité B2B peut justifier d'autres bases légales que le consentement en fonction du contexte. La **base légale et la preuve** doivent être évaluées, et les destinataires informés, avant une campagne ; cette librairie n'autorise jamais un envoi.
- Aucune intégration Paperclip, Opensoul, Twenty, Activepieces, Umami ou listmonk installée ni activée.

## Réutilisation et coûts

Les hypothèses, messages et expériences se préparent sans appels LLM supplémentaires. Les compétences agent améliorent les consignes des sept spécialistes déjà définis, mais n'accordent **aucun droit** supplémentaire. CI, revue Copilot finale et dispatch se conforment aux garde-fous déjà en place.

## Mesures de validation

Exécuter des fixtures hors réseau puis fournir : SHA, tests, comparaison du nombre de crédits Copilot/mission, taux de première CI verte, coût du runtime, doublons de missions, exactitude des métriques. Le backlog n'est pas une preuve de disponibilité.

Voir également [pilote](agency-pilot.md) et les issues #59/#67 (Full Auto et coût review).
