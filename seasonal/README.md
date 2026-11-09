# Seasonal Fast-Track — mini-apps de fêtes (novembre–décembre 2026)

**Urgence du propriétaire :** exploiter dès maintenant le générateur existant pour préparer des applications éphémères, sans attendre les 45 missions SaaSFactory. Suivi : [issue #111](https://github.com/totorina47501-wq/SaasFactory/issues/111).

## Trois produits expérimentaux immédiatement générables

| Preset | Application | Proposition de valeur | Limite |
| --- | --- | --- | --- |
| `promo-flash` | **PromoFlash** | Calculateur de remises Black Friday/Cyber Monday sur prix saisis manuellement | Ne recherche pas de prix, ne valide aucune promotion |
| `cadeaux-zen` | **CadeauxZen** | Budget cadeaux Noël modifiable dans le navigateur | Les données ne persistent pas après rechargement ; pas de compte |
| `noel-memory` | **Noël Memory** | Jeu Memory de Noël mobile-first (clavier/tactile), mélange déterministe et métriques de victoire | Données en mémoire locale de session, pas de compte ni stockage distant |

Les sorties sont des **applications Next.js indépendantes** construites par le générateur SaaSFactory existant, avec une page interactive et un style mobile-first. La bibliothèque `ai-disabled` reste active et il n'y a ni IA, ni paiement, ni scraping, ni transmission d'informations personnelles.

## Commandes à exécuter (Node 22.12+)

```sh
node seasonal/launch.mjs --list
node seasonal/launch.mjs --preset promo-flash --output-root /tmp/mes-apps
node seasonal/launch.mjs --preset promo-flash --output-root /tmp/mes-apps --write
node seasonal/launch.mjs --preset cadeaux-zen --output-root /tmp/mes-apps --write
node seasonal/launch.mjs --preset noel-memory --output-root /tmp/mes-apps --write
cd /tmp/mes-apps/promo-flash
npm install --ignore-scripts --no-audit --no-fund
npm test
npm run typecheck
npm run build
npm run dev
```

Pour Noël Memory :

```sh
cd /tmp/mes-apps/noel-memory
node --test
npm run typecheck
npm run build
```

- **Sans `--write` : dry-run sans fichier créé** ; `--write` ne fonctionne qu'avec une nouvelle destination. Une seconde génération vers le même chemin est refusée.
- Option `--target cloudflare-opennext` : ajoute uniquement la configuration de build de la cible, **pas un déploiement**.
- Les domaines `*.example` sont des exemples non publics. Avant publication, choisir un vrai nom de domaine, créer un **dépôt indépendant** par application, vérifier les obligations légales et les informations de confidentialité, puis configurer l'hébergement avec les droits nécessaires. Ces opérations **ne sont pas automatisées** par ce lot.
- Après génération, un `npm install` sera nécessaire pour le lancement local, le typecheck et le build. Les tests `node --test` générés restent exécutables sans dépendances externes.
- Le calculateur n'atteste pas que le prix de référence est légalement valide. Ne pas annoncer de faux prix barrés ou de garanties de meilleure offre. Aucun lien affilié ou contrat commercial n'est configuré.
- Pour la promotion, préparer des annonces authentiques et inviter les utilisateurs à donner leur avis volontairement ; suivre les règles des plateformes et le contrat Growth #65/#71. Ne pas activer d'API sociale sans autorisation.

## Calendrier de décision cible (non garanti)

1. **9–12 novembre** : code du kit et CI, premier test local interactif ; examiner la date du Singles Day du 11/11 sans promettre un lancement non prêt.
2. **13–18 novembre** : choisir un domaine/dépôt séparé, effectuer build/typecheck/E2E et essais mobiles ; vérifier le cadrage juridique.
3. **19–23 novembre** : lancement public autorisé si sécurité/hosting/qualité prouvés, avant le Black Friday du **27 novembre** et le Cyber Monday du **30 novembre**.
4. **Début décembre** : adapter CadeauxZen et les contenus Noël pour le **25 décembre** ; journaliser les retours volontaires et préparer des améliorations sans déploiement automatique.

Le site final, la monétisation et le raccordement au moteur Growth seront des lots séparés, explicitement autorisés. Ce prototype ne constitue pas une preuve de production.
