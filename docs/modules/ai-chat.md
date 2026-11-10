# Chat local — contrat v1

`modules/ai-chat/index.mjs` ajoute des sessions de conversation locales et
persistantes au service `llm-local` et à `rag-search`. Le contrat et le module
sont versionnés `1.0.0`. Le module n'installe ni modèle ni fournisseur, ne fait
aucun appel réseau et reste utilisable avec la génération désactivée.

## Initialisation

Le service réutilise les interfaces locales existantes : `tenancy` fournit
`resolveTenantContext`, `store` fournit `get`/`put` avec comparaison de version,
`ragSearch` fournit `search` et `assistant` est le service
`createLocalLlmService`.

```js
import { createAiChatService } from './modules/ai-chat/index.mjs';

const chat = createAiChatService({
  enabled: localAssistant.enabled,
  tenancy,
  store,
  ragSearch,
  assistant: localAssistant,
  appId: 'exemple',
  promptVersions: ['1.0.0'],
});

const session = await chat.createSession({
  cookieHeader,
  tenantId,
  requestId,
});

for await (const event of chat.streamMessage({
  cookieHeader,
  tenantId,
  requestId,
  sessionId: session.id,
  question: 'Où est décrite la politique d’accès ?',
  promptVersion: '1.0.0',
  signal: requestSignal,
})) {
  // Transmettre les événements au client uniquement depuis le serveur.
}
```

Sans `enabled: true`, la génération est désactivée et `streamMessage` échoue
avec `DISABLED`. La création, la liste, la lecture et la suppression de sessions
restent disponibles. Lorsque la génération est activée, l’application doit
fournir une version de prompt explicite, présente à la fois dans
`promptVersions` et dans le service LLM local.

Le contexte tenant est toujours résolu à partir du cookie et du tenant par
`tenancy`; l’identifiant du tenant passé en entrée n'est pas une autorisation.
Les handlers de l’application doivent obtenir les cookies et contexte de
requête côté serveur, puis vérifier l’accès via cette interface. Une erreur ou
un contexte tenant différent bloque l’opération avant l’accès au stockage.

## API

- `createSession({cookieHeader, tenantId, requestId, title?})` crée une
  conversation, avec un titre neutre par défaut.
- `listSessions({cookieHeader, tenantId, requestId})` retourne uniquement les
  métadonnées des conversations du tenant courant.
- `getSession({cookieHeader, tenantId, requestId, sessionId})` retourne
  l’historique après revalidation des sources citées avec les droits courants.
- `deleteSession({cookieHeader, tenantId, requestId, sessionId})` supprime une
  conversation sous le tenant courant.
- `retrieve({cookieHeader, tenantId, requestId, query, topK?})` retourne les
  extraits et citations autorisés par RAG sans appeler le LLM.
- `streamMessage({... sessionId, question, promptVersion, signal?})` est un
  générateur asynchrone d’événements versionnés. Une génération normale émet
  `status: "generating"` puis `message`; une reprise idempotente émet
  `status: "replaying"` puis le message déjà enregistré.

Une réutilisation du même `requestId` dans une session ne rejoue une réponse que
si la question et la version de prompt correspondent exactement ; sinon le
service refuse avec `IDEMPOTENCY_CONFLICT`.

Le LLM local v1 diffuse en interne ses fragments de génération. Le chat ne
publie toutefois qu’une réponse finale après validation du schéma et des
citations ; aucun fragment JSON ou résultat incomplet n’est envoyé au client.
Une annulation ou une erreur n’enregistre pas de tour partiel. L’API LLM v1
reçoit la question courante, pas l’historique comme contexte de génération ;
l’historique est conservé et affiché par session, mais un contexte multi-tours
nécessiterait une évolution versionnée du contrat LLM.

Avant l’enregistrement puis l’émission, ainsi que lors de `getSession` et des
reprises idempotentes, chaque citation est revalidée avec la recherche RAG
courante, le cookie courant et la question d’origine. Si une source a été
supprimée, réindexée ou n’est plus autorisée, la réponse entière est remplacée
par un avis de retrait et ses citations sont retirées. Une panne RAG échoue
fermé. Cette vérification conservatrice peut aussi retirer une réponse si une
source autorisée ne figure plus dans les résultats courants.

## Stockage et budgets

Les données sont enregistrées sous la clé constante
`ai-chat-v1/sessions`, dans le stockage local indexé par le `TenantContext`
vérifié. Chaque écriture utilise la version optimiste du stockage et un nombre
borné de reprises. Le document JSON ne dépasse pas 60 KiB ; aucune conversation
n’est écrite dans `localStorage`, aucun contenu n’est journalisé et aucune
migration n’est créée par ce module. Le stockage doit être durable et appliquer
ses propres sauvegardes.

| Limite | Défaut | Maximum |
| --- | ---: | ---: |
| Sessions par tenant | 10 | 100 |
| Tours par session | 20 | 100 |
| Question | 4 000 caractères | 4 000 |
| Réponse | 10 000 caractères | 10 000 |
| Sources par réponse | 8 | 20 |
| Réessais d’écriture CAS | 3 | 10 |
| État sérialisé par tenant | 60 KiB | fixe |

Une taille de stockage dépassée ou des conflits répétés provoquent une erreur ;
aucune partie d’un tour n’est enregistrée.

## Présentation et sécurité

`renderChatInterface` fournit un formulaire HTML local avec libellé lié,
messages dans une liste annoncée, statut accessible, contrôles natifs au clavier
et commandes désactivées quand la génération est indisponible. Le formulaire
n’accepte qu’une URL locale. Les messages, noms de source et fichiers sont
échappés en texte : aucun Markdown ni HTML de modèle ou de document n’est
interprété et les citations n’exposent pas de lien arbitraire. Les consommateurs
de `retrieve` doivent également rendre le texte retourné comme texte, jamais
comme HTML. Une réponse d’abstention est affichée avec un avis explicite, sans
fabriquer de réponse ni de source.

Codes d’erreur stables : `DISABLED`, `ENGINE_TIMEOUT`, `GENERATION_FAILED`,
`IDEMPOTENCY_CONFLICT`, `INPUT_LIMIT`, `INVALID_CONFIGURATION`, `INVALID_INPUT`, `INVALID_RESPONSE`,
`PROMPT_NOT_FOUND`, `SESSION_LIMIT`, `SESSION_NOT_FOUND`,
`SOURCE_UNAVAILABLE`, `STORAGE_BUSY`, `STORAGE_LIMIT`,
`STORAGE_UNAVAILABLE`, `TENANT_ACCESS_DENIED`, `TURN_LIMIT`, `UNAVAILABLE` et
`CORRUPT_SESSION`. Les erreurs internes de moteur, de stockage ou d’autorisation
ne sont pas exposées avec leur message d’origine.

Le module n’ajoute pas de route Next.js ni de mécanisme de cookie/CSRF. Dans une
application générée, raccorder les méthodes à des handlers serveur protégés et
transmettre `signal` lorsque le client annule sa requête. La vérification
manuelle clavier/lecteur d’écran reste à effectuer dans l’application générée ;
les tests du module ne prétendent pas valider un rendu navigateur.

## Tests et rollback

Tests hors réseau, sans poids ni fournisseur :

```sh
node --test tests/ai-chat.test.mjs
npm test
```

Les tests vérifient l’isolation des sessions, les refus tenant, le stockage
versionné, l’abstention par retrieval seul, l’annulation sans tour partiel, la
révocation de source, les limites et l’échappement HTML/Markdown. Un test avec
double local ne prouve ni disponibilité d’un modèle ni qualité d’une réponse.

Pour désactiver la génération, omettre `enabled: true` ou retirer l’adaptateur
LLM ; aucune réponse de substitution n’est produite. Pour retirer le module,
arrêter les accès applicatifs puis sauvegarder ou supprimer explicitement la
clé locale `ai-chat-v1/sessions` du tenant concerné selon la politique de
rétention. Le rollback ne contacte aucun service et ne supprime pas de données
automatiquement.
