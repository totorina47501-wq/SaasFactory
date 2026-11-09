# Stockage privé local v1

`modules/private-storage/index.mjs` fournit un module local versionné
(`contractVersion: 1`, `moduleVersion: 1.0.0`). Il ne contacte aucun service
externe et n’ajoute pas automatiquement le stockage aux applications générées.
Le contrat exporté `privateStorageContract` annonce uniquement le format PNG
statique et la déduplication limitée au tenant.

## Initialisation

```js
import {
  createPrivateStorageService,
  createStorageRetentionHandler,
} from './modules/private-storage/index.mjs';

const storage = await createPrivateStorageService({
  directory: '/var/lib/my-saas/private-storage',
  tenancy,
  audit,
  limits: {
    maxUploadBytes: 10 * 1024 * 1024,
    maxTenantBytes: 100 * 1024 * 1024,
    maxTenantFiles: 1000,
    maxTemporaryBytes: 80 * 1024 * 1024,
    maxConcurrentUploads: 8,
    retentionMs: 30 * 24 * 60 * 60 * 1000,
  },
});
```

Le dossier de stockage doit être absolu, canonique, sans symlink, sur un système
de fichiers local et accessible uniquement au compte du service (`0700` pour
les dossiers, `0600` pour les fichiers). Le module peut créer uniquement le
dernier composant du chemin ; son parent doit exister. `tenancy.resolveTenantContext`
et `audit.append` sont requis. Une erreur ou un refus de l’un de ces services
bloque l’opération (`TENANT_ACCESS_DENIED` ou `AUDIT_UNAVAILABLE`).

L’index atomique privé `metadata-v1.json` contient les identifiants, tenant,
taille, date d’expiration et SHA-256. Les données sont rangées sous
`objects/<tenant UUID>/<UUID généré par le serveur>.png`. Un objet identique
est réutilisé uniquement à l’intérieur du même tenant : aucune donnée ni
empreinte n’est partagée entre tenants. Le SHA-256 ne figure ni dans les retours
publics ni dans les événements d’audit.

## API

Chaque entrée est un objet strict : les champs inconnus, getters et prototypes
non simples sont refusés. Les opérations utilisateur reçoivent
`cookieHeader`, `tenantId` et `requestId`; le module relance
`tenancy.resolveTenantContext` et vérifie le contexte retourné avant tout accès.
Un identifiant d’objet appartenant à un autre tenant se comporte comme un
identifiant inexistant (`NOT_FOUND`).

- `upload({cookieHeader, tenantId, requestId, fileName, contentType, stream, signal?})`
  écrit le flux vers un fichier temporaire privé et borné, calcule son SHA-256,
  puis ne publie l’objet qu’après validation complète. `fileName` est vérifié,
  jamais utilisé comme chemin ni conservé. `contentType` ne sert jamais à
  reconnaître le format : il doit simplement correspondre au format détecté.
  Le flux doit émettre des chunks binaires (`Buffer` ou `Uint8Array`) ; les
  chunks texte ou objets sont refusés avant écriture.
  Une même empreinte du même tenant retourne le même ID avec
  `deduplicated: true`.
- `list({cookieHeader, tenantId, requestId})` retourne uniquement les
  métadonnées du tenant courant.
- `export({cookieHeader, tenantId, requestId, objectId})` revalide l’ACL,
  l’intégrité et le format avant de retourner un flux. Il ne révèle pas le
  chemin local et fixe `Content-Disposition` en pièce jointe ainsi que
  `X-Content-Type-Options: nosniff`. L’application appelante doit conserver ces
  en-têtes lors de la réponse HTTP.
- `delete({cookieHeader, tenantId, requestId, objectId})` supprime uniquement
  un objet du tenant autorisé.
- `purgeExpired({cookieHeader, tenantId, requestId})` supprime les objets
  expirés de ce tenant et nettoie les temporaires/quarantaines périmés.

Le gestionnaire `createStorageRetentionHandler(storage)` s’enregistre, par
exemple, comme handler local du type de job `storage.retention`. Il accepte le
`tenantContext` fourni par le worker Jobs : ce contexte ne doit provenir que de
la file Jobs locale déjà validée, jamais du payload du client. L’opération
efface uniquement les objets expirés de ce tenant ; le nettoyage global ne
retourne aucune métadonnée de quarantaine.

## Formats, bornes et erreurs

L’allowlist v1 contient uniquement le PNG statique non entrelacé. Le parseur
vérifie la signature, les limites de dimensions, l’ordre des chunks, les CRC,
les données zlib et la taille décodée. Il refuse les chunks auxiliaires ou
d’animation, les archives, le contenu malformé et tout type actif ; aucun
fichier ZIP/TAR n’est extrait. JPEG, PDF, SVG, texte et autres formats sont
refusés jusqu’à l’ajout explicite d’un validateur dédié.

Valeurs par défaut :

| Limite | Valeur |
| --- | ---: |
| Upload | 10 MiB |
| Taille décodée PNG | 64 MiB |
| Dimensions PNG | 4096 × 4096 |
| Quota par tenant | 100 MiB / 1000 objets |
| Stockage total | 1 GiB / 10 000 objets |
| Uploads en cours | 8 simultanés / 80 MiB réservés |
| Rétention | 30 jours |
| Délai maximal d’upload | 5 minutes |
| Temporaires incomplets | nettoyage après 1 heure |
| Quarantaine rejetée | 64 MiB / 100 fichiers, nettoyage après 24 heures |

Les limites sont configurables uniquement dans leurs bornes documentées par
`validateLimits`; les tailles d’upload et de tenant ne peuvent dépasser
respectivement 20 MiB et 10 GiB. La rétention est bornée à 365 jours. Une
limite atteinte échoue sans publication partielle (`FILE_TOO_LARGE`,
`QUOTA_EXCEEDED` ou `STORAGE_LIMIT`). Une annulation supprime le temporaire et
renvoie `INTERRUPTED`. Les fichiers rejetés pour contenu invalide ou MIME
incohérent sont mis en quarantaine privée ; les uploads incomplets ou trop
volumineux sont supprimés sans quarantaine. Le contenu de quarantaine n’est
jamais exportable via cette API.

Avant le premier octet, un verrou local réserve atomiquement un emplacement
d’upload et jusqu’à `maxUploadBytes` d’espace temporaire. Le nombre d’uploads
concurrents et la somme des réservations sont plafonnés ; un nouvel upload
échoue avec `UPLOAD_BUSY` si l’un des budgets est atteint. La réservation est
libérée au succès, à l’échec ou à l’annulation ; après un crash, son TTL est
supérieur au timeout d’upload et permet au nettoyage explicite de la récupérer.

Les erreurs publiques exposent un code stable dans `PrivateStorageError` :
`INVALID_INPUT`, `INVALID_CONFIGURATION`, `INVALID_PATH`, `INVALID_FILENAME`,
`INVALID_TENANT_CONTEXT`, `TENANT_ACCESS_DENIED`, `NOT_FOUND`,
`CONTENT_TYPE_MISMATCH`, `INVALID_FILE`, `CORRUPT_STORAGE`, `CORRUPT_INDEX`,
`FILE_TOO_LARGE`, `QUOTA_EXCEEDED`, `STORAGE_LIMIT`, `STORAGE_BUSY`,
`UPLOAD_BUSY`, `STORAGE_UNAVAILABLE`, `UNSAFE_STORAGE`, `AUDIT_UNAVAILABLE`, `INTERRUPTED`,
`UPLOAD_TIMEOUT`, `UPLOAD_FAILED` et `TIME_RANGE`. Les erreurs ne recopient ni
nom de fichier ni contenu fourni.

Les entrées d’audit indiquent l’action et, quand connu, l’ID d’objet et la
taille. Elles ne contiennent ni fichier, nom utilisateur, hash ou secret. Elles
sont émises avant l’opération ; si l’audit échoue, l’opération ne commence pas.
Un événement d’intention peut donc subsister si une validation ultérieure
refuse l’upload.

## Exploitation et rollback

Les temporaires et fichiers rejetés sont isolés dans des dossiers privés,
nommés par UUID serveur et nettoyés par le passage explicite de rétention.
Après un arrêt brutal, les appels de rétention retirent les fichiers dont le
TTL est dépassé. Si le processus s’arrête en tenant `metadata-v1.lock`, les
mutations échouent avec `STORAGE_BUSY` ; vérifier qu’aucun processus n’utilise
le stockage avant de retirer manuellement ce verrou. Ne pas supprimer un verrou
actif.

Le module vise un seul hôte et un système de fichiers local. Il ne fournit ni
réplication, ni chiffrement au repos, ni antivirus, ni sauvegarde, ni garantie
de disponibilité. La suppression de fichiers et des entrées d’index est un
effacement logique au niveau du système de fichiers. Elle ne garantit pas
l’effacement physique d’un SSD, d’un instantané, d’une sauvegarde ou d’un média
à nivellement d’usure ; aucun effacement matériel n’est promis. Protéger les
sauvegardes et appliquer leur propre politique de rétention.

Rollback : arrêter les workers, sauvegarder si nécessaire, retirer l’intégration
du module et ses fichiers dans une PR. Ne pas supprimer automatiquement les
données ; leur effacement reste une action opérateur explicite après validation
de la politique de conservation.

Tests offline : `node --test tests/private-storage.test.mjs`.
