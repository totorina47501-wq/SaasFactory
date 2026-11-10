# Modèle de menaces — SaaSFactory V3

**Statut :** audit documentaire et tests locaux, 2026-11-10
**Périmètre :** modules réutilisables de la Factory, tests associés et workflows
CI de ce dépôt. Ce dépôt n'est pas une application SaaS déployable. Ce modèle
ne qualifie ni une application générée ni un déploiement.

## Objectifs et limites de confiance

Protéger l'identité, les sessions, les données et fichiers privés par tenant,
les documents et index RAG, les secrets locaux, et l'intégrité de la chaîne de
tests. Les menaces considérées sont un utilisateur non authentifié, un membre
malveillant d'un tenant, un tenant tentant d'accéder aux données d'un autre, un
document ou prompt hostile, un fichier malformé, un exécutable/modèle local
compromis, et une contribution CI non fiable.

Les limites principales sont :

1. Entrées reçues par les services d'auth, API, médias et documents.
2. Session vérifiée → contexte tenant/RBAC → stores et adaptateurs.
3. Fichiers et index persistés sur le système de fichiers ou par les stores
   fournis par l'application.
4. Extraits RAG non fiables → adaptateur de modèle local → réponse structurée.
5. Commit/événement GitHub → workflow, job et jeton GitHub.

Les modules sont des bibliothèques. L'application qui les assemble doit fournir
les adaptateurs d'authentification, tenancy, stockage, droits, quotas et audit
conformes à leurs contrats. Un test avec un faux store ne prouve pas une
configuration PostgreSQL, une politique RLS réelle, un proxy HTTP ou un contrôle
du système hôte.

## Mesures et preuves disponibles

| Domaine | Contrôles présents et preuve automatisée | Limite de la preuve |
| --- | --- | --- |
| Auth, sessions et CSRF | Cookies sécurisés, session stockée sous forme de hash, contrôle Origin/CSRF, rotation et révocation, réinitialisation expirante et limitée (`tests/auth.test.mjs`, notamment tests des lignes 189–238 et 240–350). | Les parcours utilisent un faux store. Le test du store PostgreSQL vérifie le SQL via une interface simulée, pas un serveur PostgreSQL. |
| RBAC et tenants | Rôles explicites, revalidation des appartenances et permissions, refus des accès horizontaux/verticaux (`tests/tenancy.test.mjs:199-318`). Les stores et modules de données vérifient le contexte tenant. | Les tests de service tenancy utilisent des faux adaptateurs; le contrat tenancy précise que cela ne prouve pas le comportement de PostgreSQL (`docs/modules/tenancy.md:157-160`). |
| API | Schémas fermés, clés API hachées, permissions tenant-scoped, quotas, origine exacte pour mutation cookie, anti-rejeu HMAC (`tests/api.test.mjs:102-220,228-294`). | L'API est une interface locale de module, pas un serveur HTTP complet. Pas de test réseau contre un déploiement. |
| SSRF / réseau local | Le simulateur webhook n'accepte pas de destination ou callback réseau; une URL reste une donnée. Test de régression de boucle locale : `tests/security/adversarial-boundaries.test.mjs`. La documentation API le précise (`docs/modules/api.md:93-107`). | Aucun client HTTP ou URL-fetcher applicatif n'a été identifié dans le périmètre inspecté. Il n'existe donc pas de filtre SSRF générique à prouver; toute nouvelle capacité de fetch devra refuser loopback, link-local, réseaux privés et rebinding DNS avant connexion. |
| Stockage et médias | Isolation tenant, permissions filesystem, symlinks et noms dangereux refusés, PNG corrompus/quarantinés, quotas, annulation et suppression/retention (`tests/private-storage.test.mjs:124-371`). Les tests image couvrent contenu corrompu et bombes de pixels (`tests/images.test.mjs:158-335`); audio/vidéo couvrent signatures, paramètres FFmpeg/FFprobe, délais, annulation, quotas et suppression (`tests/audio.test.mjs:114-357`, `tests/video.test.mjs:138-309`). | Tests sur filesystem local temporaire, fixtures synthétiques et faux exécutables. Pas de tests sur FS réseau, concurrence multi-hôte ou moteurs média réels. |
| RAG / ingestion | Validation d'entrées, archives DOCX malformées/traversal, limites de taille/expansion/pages, corruption d'index, isolation (`tests/rag-ingestion.test.mjs:204-274`); fuzz déterministe supplémentaire dans le dossier security. | L'ingestion v1 ne fournit pas de suppression ni de rétention (`docs/modules/rag-ingestion.md:152-157`). Le cycle de vie distinct implémente la suppression et teste le retrait des vecteurs/caches (`tests/rag-lifecycle.test.mjs:360-410`); l'intégration complète entre les deux reste à vérifier. |
| LLM local | Désactivé par défaut; exécutable explicite, argv fixe et `shell: false`, hash/taille du modèle, prompt privé temporaire, CPU, délais/sorties bornés, pas d'outils, citations validées (`tests/llm-local.test.mjs:96-184,195-328` et `modules/llm-local/index.mjs:219-229`). Test argv adversarial ajouté dans `tests/security/`. | Le processus n'est pas isolé par sandbox OS/container. Les limites mémoire sont en partie déclaratives. L'opérateur contrôle le binaire et le modèle. Voir [sécurité du modèle local](local-model-security.md). |
| Diagnostics et secrets | Les diagnostics d'environnement sont minimaux et ne renvoient pas les erreurs sous-jacentes; logs structurés avec champs autorisés seulement (`tests/observability.test.mjs:63-162`). Des tests intake vérifient des formats synthétiques de secrets (`tests/intake-v2.test.mjs:123-140`). | Les détecteurs sont heuristiques et ne garantissent pas la détection de tous secrets. Aucun scan exhaustif de l'historique Git, des environnements ou des artefacts distants n'est réalisé par cette mission. |
| CI | Le workflow CI a `contents: read`, des délais de jobs et un contrôle de diff/chemins de secrets (`.github/workflows/ci.yml:9-44,45-76,96-123`). | Inspection statique seulement. Les permissions/règles de branche, secrets GitHub, actions externes, artefacts et derniers runs n'ont pas été vérifiés via GitHub dans cette session. Le scanner de chemins CI ne détecte pas toute valeur secrète dans le contenu. |

## Risques résiduels et traitements

- **Dépendances et intégration réelle :** absence de preuve sur un PostgreSQL réel,
  RLS activée, adaptateurs d'application, proxy/ingress ou système de fichiers
  multi-hôte. Exécuter les tests d'intégration dans un environnement local
  synthétique avant de revendiquer ces garanties.
- **Suppression RAG :** `rag-ingestion` conserve les versions et ne fournit pas
  son API de suppression; utiliser le service de cycle de vie prévu et établir
  une preuve d'intégration couvrant le store source, l'index, les caches et
  sauvegardes.
- **Modèle de menace évolutif :** aucun rejet SSRF générique n'est revendiqué
  tant qu'aucun client réseau n'existe. Ajouter une capacité de récupération
  d'URL exige un contrat versionné et des tests de résolution/connexion contre
  loopback, IP privées, link-local, IPv6, redirections et DNS rebinding.
- **Exécution locale :** l'exécutable configuré pour le modèle a les droits du
  processus parent. N'exécuter qu'un binaire vérifié, avec un compte OS à
  privilèges minimaux et un répertoire de données protégé.
- **État GitHub :** les issues/PR actives, l'état réel des dépendances #17/#53,
  les workflows récents, revues et protections de branche n'étaient pas
  interrogables avec les outils disponibles pendant cette session. Aucun
  doublon ni statut externe n'est déclaré vérifié.

## Règles de changement

Toute nouvelle entrée non fiable suit une validation stricte, bornée et
fail-closed; toute donnée est scopée par tenant après validation d'identité;
aucune instruction extraite d'un document ne devient une instruction système ou
une action; aucun appel réseau fournisseur n'est ajouté implicitement. Une
évolution réseau, subprocess, stockage, auth ou permission requiert des cas
négatifs et une mise à jour de ce modèle. Les protections existantes ne sont pas
affaiblies par ce lot.
