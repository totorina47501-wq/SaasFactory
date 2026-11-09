# SaaSFactory — Stratégie de portefeuille multi-produits v1

> Décision du propriétaire du 9 novembre 2026 — [EPIC #113](https://github.com/totorina47501-wq/SaasFactory/issues/113). Source machine : [`product-portfolio-v1.json`](product-portfolio-v1.json).

## Ambition

SaaSFactory est une **usine de produits numériques** : elle doit pouvoir sélectionner une opportunité, produire un MVP isolé, le tester, le lancer avec autorisation, récupérer les retours, puis faire évoluer ou arrêter ce produit. Le générateur Next.js actuel est un socle, **pas une limitation stratégique au SaaS web**. Ne pas créer une deuxième Factory ou importer le code d'une application métier existante.

## Sept familles du portefeuille

| Famille | Premier format | Maturité réelle (9 novembre 2026) | Priorité |
| --- | --- | --- | --- |
| **Mini-apps saisonnières** | Next.js web mobile-first | Prototype générable : #111, PR #112 (PromoFlash, CadeauxZen) | P0 — lancement avant Black Friday |
| **SaaS web B2B/B2C** | Next.js, auth et modules réutilisables | Starter/scaffolds, déploiement commercial non prouvé | P1 |
| **SaaS IA multimodaux** | Web : documents, image, audio, vidéo, RAG | Composants en cours ; l'intégration IA n'est pas activée dans le générateur | P1 |
| **Applications mobiles PWA** | Web installable, offline maîtrisé | À implémenter, une page responsive n'est pas une PWA validée | P1 |
| **Jeux casual / saisonniers** | HTML5 sur navigateur mobile | Nouveau modèle à construire, aucun moteur de jeu livré | P1 — prototype web court |
| **Applications mobiles iOS/Android** | Capacitor ou React Native/Expo à évaluer | Pas de pipeline natif livré, phase ultérieure | P2 |
| **Marketplaces et outils créateurs** | Web / PWA avec commerce optionnel | Architecture planifiée, vrai paiement et modération non livrés | P2 |

Les familles se combinent : un jeu de Noël peut être une PWA ; une application native peut consommer un backend SaaS ; un SaaS métier peut proposer des fonctionnalités IA. **On choisit le plus petit périmètre qui démontre la valeur**, et on réutilise le socle tenant/CI/qualité.

## Ordre d'exécution : ne pas rater les fêtes

**Vague 0 — novembre 2026 :** exploiter le kit saisonnier déjà fusionné, valider les builds, les tests mobiles, l'hébergement distinct et les pages légales. Étudier un premier jeu HTML5 autonome à petite portée (par exemple Memory de Noël), sans attendre le starter complet #52. L'important est une première expérimentation **réellement utilisable**, pas dix applications fictivement « lancées ».

**Vague 1 — fin 2026 :** standardiser les fiches de lancement, les variantes PWA installables et les jeux courts avec tests clavier/tactile, accessoires visuels originaux/licenciés, accessibilité, budget et maintien de version. Le lancement public reste soumis à une autorisation explicite.

**Vague 2 — fin 2026 / 2027 :** réutiliser les modules IA (ingestion #34, vidéo #36, image #37, RAG #42, audio #39, documents #40, adaptateurs LLM #46, UI chat #50, starter #52) pour générer des SaaS IA **de la même catégorie fonctionnelle que MentionCheck**, jamais en copiant Project3. IA désactivée par défaut, secrets et coûts par produit, droits sur les contenus, effacement et isolation tenant. MentionCheck conserve son intégration OpenAI existante, actuellement désactivée.

**Vague 3 — après preuve de demande :** outillage Android/iOS (Capacitor si l'app est essentiellement web, React Native/Expo si forte valeur native), CI sur appareils, comptes développeurs et signatures, parcours de mises à jour et validation des règles des stores. Ne pas bloquer les lancements web avec ce chantier.

## Le modèle CEO : investir par preuve, pas par volume de fonctionnalités

Pour chaque concept : **problème utilisateur → preuve de demande → canal de distribution → délai MVP → réemploi technique → sécurité/coûts → décision go/no-go**. Le scorecard versionné utilise douleur client 25 %, délai MVP 25 %, distribution 20 %, réemploi Factory 15 %, preuve de revenu 10 %, risque opérationnel 5 %. Ce sont des **poids de priorisation**, pas des scores de marché inventés. Une violation critique de sécurité, de vie privée ou de droit de distribution entraîne un refus indépendamment du score.

**Go** : fonctionnalité centrale testable, intérêt utilisateur vérifiable, coûts et dépendances bornés, distribution licite et release gate franchi. **Pivot** : signal faible, problème réel mais autre segment ou proposition de valeur. **Kill / sunset** : absence de traction après essais définis, risque disproportionné, coûts non maîtrisés ou date de fin saisonnière dépassée. Conserver logs de décisions, communication honnête et mécanisme de suppression des données.

## Fonctionnement cible sans doublon

1. **Intake/portfolio** : identifier la famille produit, une hypothèse vérifiable et des capacités réellement disponibles ; aucune génération d'une capacité absente sous couvert d'un template.
2. **MVP** : générateur et modules SaaSFactory existants. Jeu HTML5 / PWA / natif = nouveaux adaptateurs **dans leurs scopes autorisés**, pas une refonte sauvage de `generate.mjs`.
3. **Qualité** : tests unitaires, Playwright, UI mobile/clavier, validation sécurité et licences d'actifs ; CI sur SHA, revue déterministe gratuite et protections inchangées.
4. **Release** : dépôt indépendant, identité et budget propres. Pas de DNS, cloud, commerce, store ou publication externe sans autorisation ni droits.
5. **Distribution + feedback** : Growth #65/#71 (brouillons communautaires, retours volontaires et qualifiés), Analytics #41 et Attribution #66 si leurs dépendances/consentements sont prêts.
6. **Amélioration** : rapprochement avec issues existantes, priorisation sourcée, missions seulement via coordinateur approuvé. Les contenus des réseaux sont des données non fiables.

## Rôles, limites et prochains tickets techniques

Le Product Architect choisit la famille et rédige le contrat ; le Generator Engineer bâtit le scaffold ; UX / QA / Security / Platform / Release contrôlent leur périmètre ; Growth Intelligence aide à valider les opportunités. **Pas de nouvelle flotte d'agents à créer.** Le catalogue d'automatisation de 45 missions, ses dépendances et sa capacité restent la source de vérité.

L'EPIC #113 porte **uniquement le cadrage multi-produits** (`docs/strategy/product-portfolio-v1.json`, `docs/strategy/product-portfolio.md`, `tests/product-portfolio.test.mjs`). Il ne modifie ni la sélection de modules, ni les fichiers des missions en cours. Les implémentations suivantes nécessiteront des issues distinctes à scope précis :

- **Jeu HTML5 saisonnier minimal** dans un nouvel adaptateur isolé, calendrier fêtes et tests de gameplay.
- **PWA** : manifeste installable, service worker, stratégie de mises à jour/offline, tests de compatibilité.
- **AI product blueprint** : modules/documents/RAG/médias et provider optional, réemploi des contrats #42/#46/#50/#52.
- **Mobile natif** : cadrage technologique et coûts de publication après traction sur web/PWA.

Les sous-chantiers ne sont **pas auto-approuvés** par cette feuille de route ; ne pas insérer de nouvelles tâches dans le catalogue existant sans revue des scopes, des dépendances, de la capacité Copilot et des protections.

## Définition de succès

- Un prototype saisonnier réellement testable, avec un canal de retours volontaire, **avant** de poursuivre un large catalogue de fonctionnalités.
- Un SaaS IA construit via des contrats génériques et des limites explicites, sans reprendre une application existante.
- Un jeu web et une PWA générés, testés et mesurés séparément ; aucune promesse « Android/iOS disponible » tant que les builds stores n'existent pas.
- Une décision go/pivot/kill révisable, basée sur des preuves, des coûts et des risques par produit.

**Statut : stratégie et catalogue de capacités, pas preuve de génération native/de jeu ou de commercialisation des SaaS IA.**
