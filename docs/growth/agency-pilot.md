# Pilote autonome Marketing & Sales — sans remplacement de stack

Le gain prioritaire n'est pas une deuxième flotte de robots mais le **contrat de transmission** entre Intake, Product Architect, Generator Engineer, spécialistes GitHub et Revenue Operations.

## Modules compatibles

1. `growth/core/market.mjs` transforme les hypothèses Intake en plan de lancement.
2. `growth/core/crm.mjs` sert de modèle de pipeline local; sa persistance et sa sécurité sont à implémenter dans #70.
3. `growth/core/metrics.mjs` calcule des agrégats consentis, avec revenus **simulés**.
4. `recommendNextActions` suggère les pistes; les missions ne sont **pas créées automatiquement**.
5. `.github/skills/` permet de transmettre méthodes, limites et livrables aux agents Copilot existants.

## Inspiration des frameworks

- **TheAgency**: handoffs, décisions et mémoire de mission vers une piste GitHub durable (issues/PR/MD), sans importer son runtime.
- **Opensoul / Paperclip**: rôles CMO, SDR, Revenue Ops, budget d'expérience et reporting; à évaluer dans un bac à sable **non déployé**, pas d'orchestration parallèle installée.
- **Activepieces, Twenty, Umami, listmonk**: connecteurs *facultatifs* envisagés après tests de conformité, d'hébergement et de licence, sans dépendance de génération.

## Garde-fous

- État par défaut `draft-only`; aucun email, DM, achat publicitaire, communication externe ou dépense de crédits additionnels implicite.
- Les communications vers de vrais prospects exigent une base légale documentée, des oppositions respectées, des plafonds d'envoi, un journal et une autorisation de campagne. Vérifier RGPD/CNIL avant activation.
- Les nouvelles fonctionnalités doivent être inscrites au catalogue et porter role, priorité, `Files:`, dépendances et critères de preuve. Aucune duplication de la file GitHub.
- Le système ne doit pas inférer des revenus, du CAC/ROAS ou du product-market fit sans données vérifiables.
- Les recommandations automatiques restent **des drafts** tant que le dispatcher #59 et la politique de review #67 ne sont pas certifiés sur un cycle réel.

## Test du saut de maturité (à faire plus tard)

Comparer trois SaaS fictifs avec / sans cette couche : retouches de briefs, réussite CI au premier essai, débordement de portée, temps de préparation de lancement, exactitude des métriques, coûts Copilot par PR. Aucun résultat non mesuré n'est présenté comme économie réalisée.
