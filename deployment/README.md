# Deployment Engine v1 — packaging multiformat sans publication

> **Scope** : [issue #127](https://github.com/totorina47501-wq/SaasFactory/issues/127). Ceci **compose des fichiers de déploiement dans un nouveau projet autonome** ; ce n'est ni un service hébergé, ni un Docker Engine, ni un déploiement. Contrat v1, versionné avec les sources du dépôt.

## Pourquoi cette approche

Pour les outils Black Friday/Noël sans backend, la voie **static-export → CDN** évite d'exploiter inutilement un serveur et une base de données. Pour les SaaS avec API et processus Node, **Docker** offre un packaging reproductible. **Docker Compose** sert aux essais locaux de SaaS avec PostgreSQL et éventuellement Redis / modèle local. Le support **Cloudflare OpenNext** existant reste disponible pour des applications Next.js que la sortie statique ne couvre pas. Les apps mobiles natives restent des binaires installables, leur backend peut être conteneurisé séparément.

| Profil CLI | App générée | Prérequis / limites | Étape suivante manuelle |
| --- | --- | --- | --- |
| `static-export` | Next.js v1 limité à `ai-disabled` et `next.config.ts` contrôlé avec `output: 'export'` | **Pas** d'API/auth/media/billing, pas de serveur Node | `npm install`, tests, `npm run build`, puis héberger `out/` sur un CDN autorisé |
| `docker` | Next.js + **Dockerfile et .dockerignore réutilisés** de `modules/local-runtime/` | `package-lock.json` à générer et revoir ; npm/Docker disponibles **après** génération | `npm install --package-lock-only`, `docker build`, tests réels |
| `docker-compose` | Docker + `compose.yaml` existant | PostgreSQL local, volumes ; mot de passe et URL DB à fournir localement, services optionnels non activés | `docker compose config`, `docker compose up --build`, tests d'isolation/restore |
| `cloudflare-opennext` | Scaffolds de la cible Cloudflare du générateur existant | Ne constitue **pas** un export statique ni une publication | Build/adaptateur Cloudflare vérifiés, compte + déploiement explicitement autorisés |

**Ne pas confondre** : Docker prépare le **backend et les workers**, pas les binaires iOS/Android ; une image Docker n'est pas une application utilisable sur un mobile hors navigateur.

## Usage (Node.js 22.12+)

Depuis la racine de SaaSFactory :

```sh
# Aperçu, aucune écriture ni requête réseau
node deployment/generate.mjs --config examples/minimal.json --output-root /tmp/products --profile docker

# Génération dans un dossier neuf /tmp/products/<slug> (ne jamais remplacer un dossier existant)
node deployment/generate.mjs --config examples/minimal.json --output-root /tmp/products --profile docker --write

# Variante locale avec PostgreSQL (dans un root neuf différent)
node deployment/generate.mjs --config examples/minimal.json --output-root /tmp/products-compose --profile docker-compose --write

# Variante statique, strictement sans modules serveur (dans un root neuf)
node deployment/generate.mjs --config examples/minimal.json --output-root /tmp/products-static --profile static-export --write

# Variante Cloudflare : la config doit porter deploymentTarget=cloudflare-opennext
node deployment/generate.mjs --config examples/saas-starter.json --output-root /tmp/products-cf --profile cloudflare-opennext
```

Le contrat est strict : le drapeau `--write` est obligatoire pour créer, chaque produit a sa destination neuve et sûre, et un second passage sur un dossier existant est refusé. `--profile` ne force pas ni ne contourne le champ `deploymentTarget` de la configuration v1/v2. Pour Cloudflare, mettre la cible attendue dans le JSON (sans modifier le fichier d'exemple fourni en production). L'interface v1 du générateur et les modules v2 restent inchangés.

## Provenance et limites des artefacts Docker

`Dockerfile`, `.dockerignore`, `compose.yaml` sont **copiés à l'identique** depuis `modules/local-runtime/`. Aucun nouveau fork de runtime. Le Dockerfile hérité attend `package-lock.json`, qui n'est pas créé par le générateur offline. Pour une image reproductible, **générer et vérifier ce lockfile après génération** :

```sh
cd /tmp/products/<slug>
npm install --package-lock-only --ignore-scripts --no-audit --no-fund
npm install --ignore-scripts --no-audit --no-fund
npm test && npm run typecheck && npm run build
docker build -t local/mon-saas:reviewed .
```

La configuration Compose exige les variables locales (notamment `APP_SLUG`, `POSTGRES_PASSWORD`, `DATABASE_URL` pointant sur l'hôte Compose `postgres`). **Ne jamais renseigner ou committer une valeur secrète dans la Factory.** Le module local-runtime documente ports localhost, health checks, volumes et services optionnels : [docs/modules/local-runtime.md](../docs/modules/local-runtime.md). Un SaaS sans DB n'a pas besoin du profil Compose.

## CI et gates commercialisation

- **Démontré par tests du dépôt** : CLI et dry-run, générations sûres, protections contre liens symboliques et overwrite, incompatibilités static/serveur, absence d'activation de secrets, application générée avec tests smoke Node, copie exacte des sources Docker.
- **Non démontré par ces tests** : `docker build`, exécution OCI dans un runner, vrai build Next.js de chaque variante, `docker compose up`, base restaurée, scan CVE/SBOM et signature, déploiement GHCR/Northflank, mise en ligne publique.
- Avant lancement : image de base **épinglée par digest**, build dans CI produit, SBOM/scan, non-root, tests d'exécution et `/health`, quotas CPU/RAM, migration/restore, historique des images, rollback vérifié, domaine/TLS et revue conformité. Une image versionnée ou un conteneur vert ne prouvent ni sécurité commerciale ni disponibilité.
- Les workflows `.github/workflows/` et la mission QA #53 gardent la responsabilité du futur test en environnement OCI ; ne pas changer leurs scopes pour ce P1.

## Compatibilité, sécurité et rollback

Entrées : configuration generator v1/v2 validée par la **source de vérité** `generateProject()`, `profile` parmi quatre choix, `outputRoot` explicite, `write` booléen. Inconnu ou conflit de target : refus avant écriture. Les templates sont lus depuis une allowlist fixe de sources locales. Aucun script externe, npm, Docker, DNS, IAM, API, migration, publication GitHub ou paiement n'est exécuté par la Factory. Les fichiers de packaging sont écrits seulement dans le projet nouvellement créé.

Sorties : manifeste sec de prévisualisation, même destination sûre en mode write, `DEPLOYMENT.md` propre à chaque produit et artefacts validés. Les binaires et images ne sont pas produits par ce moteur. `static-export` modifie uniquement le `next.config.ts` neutre généré après vérification du contenu **exact** de la baseline. Si cette baseline change, l'opération échoue fermée ; supprimer manuellement le **nouveau** projet partiellement généré (jamais un dossier client existant), puis revoir le contrat.

**Prochaine étape après P1** : intégration supervisée dans le starter v2 (#52) et tests OCI/Playwright de l'app générée (#53), sous leurs scopes distincts. `cloudflare-opennext` existant ne doit pas être remplacé par un hébergeur imposé.
