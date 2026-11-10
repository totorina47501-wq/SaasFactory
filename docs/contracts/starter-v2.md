# Starter composé — contrat v2

**Version du profil :** 1 · **Entrée du générateur :** `schemaVersion: 2` · **API :** `generateStarterProfile` dans `factory/starter-profile.mjs`.

Le profil orchestre le générateur et son registre/composer existants. Il n'ajoute pas de deuxième moteur de templates et ne copie pas le code des modules vers la Factory. Le résultat est un starter Next.js indépendant ; ce n'est ni un service déployé ni une déclaration de préparation à la production.

## Utilisation

```js
import { readFile } from 'node:fs/promises';
import { generateStarterProfile } from './factory/starter-profile.mjs';

const report = generateStarterProfile({
  configText: await readFile('examples/saas-starter-v2.json', 'utf8'),
  outputRoot: '/tmp/saas-starter',
});
```

Le mode par défaut est `dry-run`. Pour créer un répertoire neuf, transmettre `write: true` et un `outputRoot` sûr. L'API retourne un rapport versionné avec le manifeste du générateur, les capacités et leurs versions, fichiers, limites, prérequis, permissions et exigences offline. Les résultats, capacités, fichiers et listes du rapport sont triés de manière déterministe. Aucun rapport n'est écrit hors des sorties gérées par le générateur.

L'entrée est le schéma strict v2 documenté dans [le contrat générateur v2](generator-v2.md). Les champs supplémentaires, modules inconnus ou versions non reconnues échouent sans repli. `examples/saas-starter-v2.json` sélectionne les cinq modules actuellement composables : `ai-disabled`, `api`, `auth`, `billing-test` et `media`. Le registre est la source de vérité des limitations et métadonnées rapportées ; tous les modules du profil de démonstration sont des scaffolds, pas des capacités de production. Les services du dépôt qui ne disposent pas d'une source de génération autorisée dans le compositeur ne sont pas inclus ni réécrits par ce profil.

## Intégration i18n/SEO optionnelle

`integrations: ['i18n-seo']` réutilise `integrateNeutralI18nSeo` et exige `origin` HTTPS public. L'adaptateur est uniquement compatible avec `ai-disabled@1.0.0`, les deux langues `fr-FR` et `en`, `offline: true`, sans permissions/prérequis, et `deploymentTarget: "none"`. Toute combinaison avec auth, API, média ou facturation est refusée : les pages/routes sont intégrées après génération, elles ne sont pas installées à l'aveugle dans un starter avec modules serveur.

Les pages localisées sont des brouillons sans indexation ; le sitemap produit est intentionnellement vide. Le rapport identifie l'adaptateur par son contrat v1 et conserve ses limites. Il n'affirme ni publication SEO ni déploiement.

## Sécurité, effets et erreurs

- `generateProject` valide l'entrée stricte, résout les modules et limitations, compose uniquement les sources autorisées, vérifie les secrets et garantit une destination neuve ; le profil réutilise ces contrôles.
- Aucun hook ou commande de module n'est exécuté. Aucune API réseau, IA/LLM/ASR, GPU, fournisseur d'authentification, stockage distant, paiement, dépôt ou déploiement n'est activé.
- Les configurations produites sont locales et sans secret. La cible de l'exemple est `none`.
- Un `dry-run` ne crée pas de fichier. L'écriture explicite refuse les destinations existantes et ne les remplace jamais.
- La sortie du moteur reste la source de vérité pour `factory-manifest.json`, hashes et rapport d'installation. Le rapport de profil retourné ajoute les détails de capacité et les chemins de l'intégration i18n ; il ne réécrit pas le manifeste du moteur.
- Avec l'adaptateur i18n optionnel, le profil résout d'abord le contrat v2 strict, puis matérialise la base neutre compatible v1 requise par l'adaptateur. Cela évite de laisser des hashes v2 périmés après le déplacement du layout/de la page et la mise à jour du smoke test ; le rapport distingue `resolution` v2 du manifeste `generator` réellement écrit.
- Une erreur de sélection, de prérequis, de permission, d'origine ou de collision échoue fermée. Rollback : supprimer uniquement le répertoire indépendant créé par cette génération ou régénérer dans une nouvelle destination ; ne pas réutiliser un dossier modifié.

## Validation

`node --test tests/starter-v2.test.mjs` couvre le dry-run déterministe, les capacités du registre, l'écriture et les tests smoke générés, les refus de configuration, ainsi que l'adaptateur i18n neutre en mode preview/écriture. La génération n'exécute pas de build Next.js ; la validation de démarrage/build réel de l'application reste la porte QA dédiée.
