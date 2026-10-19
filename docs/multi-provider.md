# Passer au multi-fournisseur : plusieurs sources de sons, une seule bibliothèque

Objectif (demande du propriétaire, 19/10/2026) : une fois détachée de Deezer (plan
`docs/detachement-deezer.md`, lots A à I fusionnés), l'application ne doit plus être « un proxy
Deezer avec un repli YouTube » mais **une bibliothèque locale alimentée par plusieurs fournisseurs**,
avec :

- une **manière standard d'ajouter un fournisseur** et d'en implémenter les fonctions : recherche,
  récupération du son, pages catalogue, playlists, profil utilisateur ;
- un **classement des fournisseurs par qualité** ;
- une **gestion propre des doublons** : le même enregistrement proposé par plusieurs plateformes
  est un seul titre, avec plusieurs sources, et la meilleure qualité est préférée.

Le plan est un inventaire. Le découpage en lots exécutables (un lot = un agent, une branche, une
PR) est dans `/mnt/project-files/multi-provider/besoins.md`.

## Ce qui est déjà acquis (point de départ)

Le détachement a posé l'essentiel : un titre archivé est **une ligne de base + un fichier**
identifiés par un UUID ; le fournisseur n'est plus qu'une source de **son** et de **faits de
catalogue**. Concrètement, le code actuel a déjà deux fournisseurs écrits à la main, sans interface
commune :

| | Deezer | YouTube |
|---|---|---|
| Code | `supysonic/deezer/provider.py`, `archive.py`, `library.py` | `supysonic/deezer/youtube.py`, `webui/youtube.py` |
| Identité en base | `track/album/artist/playlist.deezer_id` | `track.youtube_id` (titre seulement) |
| Recherche | `deezerpy/api.py`, route `/search` | route dédiée, case « YouTube » |
| Son | FLAC déchiffré, Opus à la demande | Opus d'origine, remuxé, jamais ré-encodé |
| Santé | `check_login()` (`"arl"` / `"network"`), disjoncteur par hôte | `held()` (réseau 1 min, refus 15 min) |
| Rôle | source principale | **repli**, demandé par une personne |

Chaque fonctionnalité est donc écrite deux fois ou n'existe que pour l'un. Le multi-fournisseur
consiste à **extraire ce qu'ils ont en commun** et à y brancher les deux, puis un troisième.

## Principes (hérités, à ne pas casser)

1. **Le clic d'abord** (règle du détachement) : aucune route ne fait d'appel tiers sauf jouer un
   titre non archivé ou chercher dans les catalogues. Ajouter des fournisseurs ne ralentit aucune
   liste : un fournisseur de plus coûte une requête réseau **parallèle** dans la recherche, **zéro**
   requête SQL de plus dans les listes.
2. **La base locale et l'UUID sont la vérité.** Un fournisseur est optionnel au fonctionnement :
   tout ce qui est sur disque joue, se parcourt et se range à pleine vitesse quand **tous** sont
   injoignables. Échouer à joindre un fournisseur n'est **jamais un verdict** sur le titre.
3. **La frontière** (`tests/test_detach_guard.py`) s'étend à chaque fournisseur : rien de ce que
   fait la personne n'est écrit sur un compte de fournisseur ; la seule lecture d'un compte est
   l'**import ponctuel**, qui ajoute et ne retire jamais.
4. **Une mise à jour ne casse rien** : ids UUID, ids Subsonic, chemins de fichiers, configuration
   (`[deezer]`, `DEEZER_ARL`, `Meta`), favoris, playlists, historique restent valides tels quels.
5. **Les secrets restent des secrets** : un identifiant de compte n'est jamais renvoyé par l'API
   (masqué), jamais journalisé, jamais écrit dans un sidecar.

## 1. L'interface d'un fournisseur

Un module `supysonic/providers/` (nouveau) :

- `base.py` — la classe `Provider` et les types échangés ;
- `errors.py` — les erreurs, qui portent la règle « pas de verdict sans réponse » ;
- `quality.py` — l'échelle de qualité (§3) ;
- `registry.py` — l'enregistrement, l'activation et l'ordre (§5) ;
- `deezer.py`, `youtube.py`, `local.py` — les trois premiers adaptateurs ;
- `fake.py` — un fournisseur de test déterministe (sert à tout tester sans réseau).

### Identité et capacités

Un fournisseur déclare un `id` court et stable (`deezer`, `youtube`, `jamendo`… : minuscules,
chiffres, ≤ 16 caractères — c'est une clé de base), un nom affichable, un **rôle** (`main` ou
`fallback` : un repli n'est interrogé que si la personne le demande, comme YouTube aujourd'hui) et
un ensemble de **capacités** : un fournisseur n'implémente que ce qu'il sait faire, et l'application
masque le reste.

| Capacité | Méthodes que le fournisseur doit alors fournir |
|---|---|
| `SEARCH` | `search(query, kinds, limit) -> SearchResult` (pistes, albums, artistes, playlists ; chaque hit = un dict normalisé, voir plus bas) |
| `AUDIO` | `offers(ref) -> [Offer]`, `fetch(ref, offer, dest)` / `open_stream(ref, offer)` ; `fetch_cover(ref, size)` |
| `CATALOG` | `get_track(ref)`, `get_album(ref)` (**avec la liste complète des pistes**), `get_artist(ref)`, `get_artist_albums(ref)`, `get_playlist(ref)` (idem) |
| `ACCOUNT` | `account()` (nom, statut), `import_account()` (générateur de playlists et favoris, **lecture seule**) |
| `LINKS` | `parse_link(url) -> Ref | None` (le fournisseur sait lire ses propres liens de partage) |
| `PODCASTS` | `search_shows`, `get_show`, `get_episodes` (seul Deezer au départ ; hors du cœur du plan) |

Communes à tous : `available() -> bool` (instantané, sans réseau, comme `DeezerProvider.available()`),
`health(force=False) -> Health` (`ok` / `auth` / `network`, avec `retry_in`, mis en cache : le
`check_login` d'aujourd'hui, généralisé), `config_schema()` (les champs que la personne remplit :
type, secret ou non, aide) et `trust` (la fiabilité par type de fait : date, ISRC, BPM, genre, voir §6).

### Les types échangés

Ils sont **normalisés** : un dict de forme fixe, que l'application sait ranger sans connaître le
fournisseur (c'est exactement le rôle de `library.normalize_track` pour Deezer et de
`youtube.normalize_hit` pour YouTube aujourd'hui, mais en un seul schéma).

- `Ref` = `(provider, kind, ref)` ; `kind` ∈ `track | album | artist | playlist | show`. `ref` est une
  chaîne opaque ≤ 128 caractères, **validée par le fournisseur** (l'id vient du client ou d'un lien :
  jamais de confiance).
- `TrackHit` : `ref`, `title`, `artists[]` (nom + ref), `album` (titre + ref), `duration`, `isrc`,
  `number`, `disc`, `release_date`, `cover_url`, `explicit`, `offers[]` quand la recherche les connaît.
- `Offer` : `quality` (§3), `fmt` (`flac`, `opus`, `m4a`, `mp3`…), `bitrate` (kbit/s), `lossless`,
  `bit_depth`, `sample_rate` — **ce que le fournisseur peut livrer pour ce titre**, pas ce qu'on a.
- `SearchResult` : `tracks[]`, `albums[]`, `artists[]`, `playlists[]`, chacun avec son `ref`.

### Les erreurs : la règle de la panne, généralisée

Reprise de CLAUDE.md (« Resilience rules ») : un échec réseau ne condamne rien.

- `ProviderUnavailable` — transport (délai, DNS, disjoncteur ouvert, 5xx). **Aucun verdict.**
- `ProviderAuth` — l'identifiant est mort ; action de la personne, pas un verdict sur le titre.
- `ProviderHeld` — le fournisseur nous a refusés (limite, « confirmez que vous n'êtes pas un robot ») :
  on le laisse tranquille (`held`, comme YouTube : 1 min réseau, 15 min refus).
- `NotFound(ref)` / `Gone(ref)` — **le fournisseur a répondu** que la chose n'existe plus : seul cas
  qui peut marquer une **source** indisponible (jamais directement le titre, voir §4).

Le disjoncteur par hôte (`deezerpy/_circuit.py`) devient un service commun : chaque adaptateur y
enregistre ses hôtes, et toute session HTTP d'un fournisseur passe par un `_Session` à délai par
défaut. Aucun `requests.Session()` nu.

## 2. Identité : un titre, plusieurs sources

Aujourd'hui `track.deezer_id` et `track.youtube_id` sont deux colonnes ; un troisième fournisseur
n'en fait pas une troisième. Modèle cible (**une seule migration**, `SCHEMA_VERSION` → `20261020`) :

- **`track_source`** : `track` (FK, cascade), `provider`, `ref`, `quality` (note, §3), `fmt`,
  `bitrate`, `added`, `seen` (dernière fois que le fournisseur l'a confirmée), `unavailable`
  (horodatage de verdict, comme `Track.unavailable`). Clé primaire `(provider, ref)` : un
  enregistrement d'un fournisseur ne peut appartenir qu'à un titre ; index sur `track`.
- **`entity_ref`** : `kind` (`album|artist|playlist|show`), `provider`, `ref`, `entity` (UUID de la
  ligne) ; clé primaire `(kind, provider, ref)`, index `(kind, entity)`. Générique (pas de FK : trois
  tables de plus pour presque rien) ; les suppressions nettoient via `refs.drop_entity`, et un
  orphelin est inoffensif (la recherche d'un UUID inexistant répond « inconnu »).
- **`provider_account`** : `provider`, `user` (FK, null = compte du serveur), `label`, `secret`,
  `status`, `checked`. Unique `(provider, user)`.
- Réglages en `Meta` (clé ≤ 32 caractères) : `prov.order` (liste ordonnée d'ids), `prov.<id>.on`
  (actif), plus les règles de qualité du §3.

**Les colonnes existantes restent.** `deezer_id` / `youtube_id` sont conservées, lues comme avant
et **écrites en double** (un seul point d'écriture, `sources.attach`) ; la migration remplit
`track_source` / `entity_ref` depuis elles par un `INSERT … SELECT` (une instruction, pas de boucle
Python). Rien ne s'en retire dans ce plan : les retirer est un autre chantier, sans urgence.

**Les UUID ne changent pas.** Les fonctions d'`ids.py` pour Deezer restent exactement ce qu'elles
sont (même espace de noms : les ids Subsonic, les lecteurs, les caches hors ligne, les soirées
d'écoute et les télécommandes en dépendent). Un nouveau fournisseur reçoit un espace de noms dérivé
(`uuid5(NS, "<provider>:<kind>:<ref>")`) : l'UUID d'un enregistrement jamais vu est donc **connu
avant d'exister en base** (c'est ce qui fait marcher « un résultat de recherche se joue sans ligne »,
aujourd'hui `youtube_track_uuid`).

Mais avec les doublons (§4) **l'UUID du titre n'est plus toujours celui de la source** : une
recherche qui trouve l'enregistrement déjà possédé doit répondre avec **l'UUID existant**. Le
résolveur devient donc `resolve_ref(provider, kind, ref)` : `entity_ref` / `track_source` d'abord,
sinon l'UUID déterministe du fournisseur (ligne « souche » à venir). `webui/refs.py#resolve_track`
(le B1 du détachement) l'appelle pour les ids numériques ou préfixés.

**La SPA** : D14 a mis les titres sur l'UUID ; il reste **albums, artistes, playlists, spectacles et
résultats de recherche**, encore clés sur `deezer_id`. Le multi-fournisseur les passe tous sur l'UUID
(l'URL d'un album ne doit pas changer de forme selon qui le fournit) ; les ids bruts de fournisseur
restent acceptés en entrée par le serveur.

## 3. Classer par qualité

Une **note de qualité** comparable entre fournisseurs et entre formats : un couple
`(classe, débit effectif)`, comparé dans l'ordre.

| Classe | Contenu |
|---|---|
| 50 `hires` | sans perte > 16 bits ou > 48 kHz |
| 40 `lossless` | sans perte 16 bits / 44,1-48 kHz (FLAC Deezer, Qobuz, Tidal) |
| 30 `high` | avec perte, débit effectif ≥ 192 kbit/s |
| 20 `medium` | avec perte, 96 à 192 |
| 10 `low` | en dessous |

Le **débit effectif** corrige le codec (Opus ×1,5, AAC ×1,3, Vorbis ×1,2, MP3 ×1 : l'Opus 133k de
YouTube se range en `high`, pas en `medium`). Les coefficients sont dans `quality.py`, écrits
avec leur raison, et un test les tient. La note est celle de l'**offre** (ce qu'on pourrait
obtenir) avant l'archivage et celle du **fichier** (`track_source.quality`, lue du fichier
réellement archivé) après.

Deux ordres, qui ne se confondent pas :

- **Quelle source pour un titre** : la meilleure note d'offre ; à note égale, l'**ordre des
  fournisseurs** choisi par l'administrateur (`prov.order`, glisser-déposer) ; une source marquée
  indisponible, un fournisseur coupé ou en `held` sont sautés. Si la meilleure échoue sans verdict
  (réseau), on **essaie la suivante** : on n'attend jamais un fournisseur mort quand un autre a le titre.
- **Quel fournisseur interroger en premier / afficher en tête** : l'ordre des fournisseurs seul
  (la qualité d'un titre n'est connue qu'une fois la recherche faite).

La règle centrale de CLAUDE.md devient : **archiver le meilleur sans perte que le fournisseur offre ;
sans perte disponible, archiver l'original tel quel (jamais de ré-encodage avec perte vers avec perte),
et transcoder en Opus à la demande vers le bas.** Ne jamais streamer directement depuis un fournisseur
reste vrai.

## 4. Les doublons

« Le même enregistrement sur Deezer et chez un autre » doit donner **un titre**, pas deux lignes.
Trois niveaux, du plus sûr au plus prudent :

1. **ISRC identique** : même enregistrement (sûr). Fusion automatique.
2. **Titre « noyau » + artiste principal + durée à ±3 s, sans mot de version en trop** (remix, live,
   edit, acoustic…) : mêmes critères que le remplacement actuel (`availability.match_score`,
   `closeness`, `PLAUSIBLE`, `_core_title`), qui sont déjà mesurés sur des cas réels. Fusion
   automatique si `match_score`, sinon **proposition** (« À vérifier »).
3. **Rien de sûr** : deux lignes distinctes. Un mauvais morceau vaut pire qu'un doublon (règle de
   l'import de playlist).

Ces fonctions sortent de `webui/availability.py` dans `supysonic/matching.py` (le module les
ré-importe, rien ne change pour ses appelants) : la recherche, l'import de playlist, le remplacement et
la fusion en sont tous clients.

Ce qu'une fusion fait :

- **À la matérialisation** (une personne joue, étoile ou ajoute un résultat) : si un titre de la base
  correspond, la source est **attachée** à ce titre (`sources.attach`) au lieu de créer une ligne. La
  réponse porte l'UUID existant. Coût : une requête indexée par ISRC ou par clé de titre.
- **Sur l'existant** : un outil d'administration (aperçu puis application, travail de fond, point de
  reprise) cherche les doublons déjà en base (ISRC identique entre une ligne Deezer, une ligne YouTube
  et un envoi) et les fusionne avec `availability.replace_everywhere` (même code que le remplacement
  d'une personne : playlists, favoris, compteurs d'écoute, position conservés). Jamais sans aperçu.
- **Une source ne remplace jamais un fichier en silence.** Qu'un fournisseur de meilleure qualité
  apparaisse n'est pas une raison de toucher un fichier que la personne écoute.

### Améliorer la qualité d'un titre déjà archivé

Règle `upgrade` (Réglages → Sources, stockée dans `Meta`, **désactivée par défaut** : une mise à jour
ne doit pas déclencher des téléchargements massifs) : `off`, `lossless` (de avec perte vers sans perte
seulement), `better` (toute classe supérieure). Elle s'applique :

- à la demande : bouton « Chercher de meilleures sources » sur un titre, un album, une playlist ou la
  bibliothèque (travail de fond `BULK`, point de reprise, échecs avec leur cause) ;
- à l'événement : quand une source meilleure est **découverte** (une recherche qui la voit sur un
  titre possédé en moins bien), elle est notée dans `track_source` ; le téléchargement ne part que si
  la règle l'autorise.

Le nouveau fichier est écrit à côté, vérifié (`looks_like_audio`), tagué, puis publié **atomiquement** à
la place de l'ancien (même UUID, même ligne, `last_modification` mis à jour) ; la mesure d'analyse
(tempo, genre, gain) est refaite en arrière-plan puisque le fichier a changé. L'ancien est supprimé
**après** la publication. Le nettoyage (`cleanup.py`) reste le seul code qui supprime de l'audio
archivé sinon.

## 5. Registre, activation, configuration

- Un fournisseur s'**enregistre** (`registry.register(ProviderClass)`) ; les intégrés le font à la
  création de l'application (`web.py#create_application`), les tiers par le groupe d'entrée
  (`entry_points`) `supysonic.providers`, ce qui permet d'ajouter un fournisseur **sans modifier ce
  dépôt**. Ajouter un fournisseur = un fichier + une ligne ; le gabarit (`docs/providers.md`, écrit au
  lot J) le montre de bout en bout.
- `current_app.providers` (le registre) remplace `current_app.deezer`, qui **reste** et pointe sur le
  fournisseur `deezer` pendant toute la transition (une cinquantaine d'appelants).
- Configuration : `[provider.<id>]` dans `supysonic.conf` ; l'ancienne section `[deezer]`, les
  variables `DEEZER_*` et les clés `Meta` (ARL) restent lues par l'adaptateur Deezer **sans migration**
  des valeurs. Un fournisseur sans identifiant requis est actif par défaut ; un fournisseur à
  identifiants l'est une fois les identifiants validés.
- Ordre et activation : `prov.order`, `prov.<id>.on` ; **un seul interrupteur général** (comme
  `yt.enabled`, généralisé) ; couper un fournisseur n'efface rien : ce qui est archivé joue.
- Le **flux de connexion** est déclaré par le fournisseur (`config_schema()` : `arl-cookie`, `token`,
  `oauth`, `form`). L'aide Android (`DeezerLoginActivity`, `lib/nativeDeezer.js`) devient générique :
  un WebView sur la page de connexion du fournisseur, le cookie ou jeton nommé par le fournisseur lu
  et rendu à Réglages, **le mot de passe ne traverse jamais**.

## 6. Faits, paroles, genre : qui est cru sur quoi

Le sidecar `<track>.json` garde déjà `facts` avec `{value, source}` et un ordre de confiance
(`tags > deezer > musicbrainz > acoustid`). Il se généralise : chaque fournisseur déclare sa
**confiance par type de fait** (`trust = {"date": 3, "isrc": 3, "bpm": 2, "genre": 0}` : 0 = ignorer),
et `update_track_facts` range par ce barème, plus un ordre fixe de noms. Les paroles (LRCLIB) et
l'enrichissement (MusicBrainz) ne sont **pas** des fournisseurs de sons : ce sont des **sources de
faits**, qui restent à part (même registre, genre `facts`, hors de ce plan).

## 7. Le parcours de chaque fonction

| Fonction | Aujourd'hui | Cible |
|---|---|---|
| **Recherche** | `/search` : Deezer (5 appels parallèles) + local ; YouTube à part | `/search` : local d'abord, puis tous les fournisseurs actifs **en parallèle** avec une échéance (`?only=local` répond tout de suite pour que l'écran se peigne) ; hits fusionnés par `matching`, chacun avec `sources[]` ; un fournisseur lent ou en panne est omis sans retarder les autres ; réponse complète seule mise en cache 10 min |
| **Jouer** | `/stream` : Deezer ou YouTube selon la ligne | `sources.pick()` : meilleure source jouable, repli sur la suivante, un seul code pour `/stream`, Subsonic `stream`/`download`, le partage et la pré-charge |
| **Archiver** | `archive.ensure_archived(provider, track)`, file à priorités | idem, **avec des créneaux par fournisseur** (chacun a ses limites) ; la file reste unique et ordonnée (`USER` > `PREFETCH` > `BULK`) |
| **Pages catalogue** | album/artiste/playlist : base d'abord, Deezer pour compléter | base d'abord ; « disponible chez … » par fournisseur, requête séparée chargée après |
| **Playlists / favoris** | locaux (D1, D2) ; import ponctuel Deezer | locaux ; import ponctuel **par fournisseur** (`import_account`), même contrat : ajoute, ne retire jamais |
| **Profil** | Réglages → Compte Deezer | Réglages → Sources : une carte par fournisseur (état, identifiants masqués, test, import, « se déconnecter ») |
| **Liens collés** | `linkimport.py` : quatre services en dur | `parse_link` par fournisseur ; Spotify et Apple restent lecteurs de liens (sans son) |
| **Indisponible** | `Track.unavailable` sur verdict Deezer | **par source** (`track_source.unavailable`) ; `Track.unavailable` n'est posé que quand **toutes** les sources sont mortes (la règle « les deux sources » devenue « toutes ») ; `verify_gone` les revérifie toutes au moment de la suppression |
| **Santé** | `deezerhealth.js` : un seul fournisseur | `providerhealth.js` : un avis par fournisseur, jamais bloquant pour les autres |
| **Subsonic** | lignes ordinaires | inchangé : les lignes sont des lignes |

## 8. Performance

Mesurée comme le reste (`tools/perf_api.py` avant/après, requêtes SQL comptées, jamais le temps) :

- **Les listes ne lisent pas `track_source`.** Aucun lot ne l'ajoute à `_db_track_rows` ni aux cartes
  (une jointure par ligne était l'erreur que le détachement a payée). `sources[]` n'apparaît que sur les
  hits de recherche, la fiche d'un titre et le menu « Sources ». Test : nombre d'instructions SQL
  identique avant et après sur favoris, playlist de 4 000 titres, accueil.
- **La recherche est le seul endroit où N fournisseurs coûtent N appels**, et ils sont parallèles, avec
  échéance et disjoncteur par fournisseur ; la fusion est un passage sur des clés de hachage (O(n)).
- **La résolution d'un lot d'ids** (`resolve_tracks`) reste ≤ 2 requêtes quel que soit le nombre de
  fournisseurs (les `ref` d'un lot sont groupés par fournisseur dans un `IN`).
- **L'arrière-plan cède** : améliorations de qualité, recherche de doublons, import de compte passent
  par `workload.Priority.BULK`, `renice`, `quiet_wait`.

## 9. Mise à jour d'un serveur existant

Chaque lot qui touche au schéma ou à la configuration le teste :

- une base créée à `20261019` avec des titres Deezer, des titres YouTube, des envois, des playlists
  et des favoris monte à `20261020` ; **tous les UUID, ids Subsonic, chemins, favoris et playlists
  sont identiques** avant et après, et `track_source` contient exactement une source par
  `deezer_id` / `youtube_id` ;
- une configuration d'avant (`[deezer] arl`, `DEEZER_ARL`, `Meta`) démarre sans changement et le
  fournisseur Deezer se connecte ;
- l'ancien SPA en cache (service worker) parle encore au nouveau serveur : les ids bruts de Deezer
  restent acceptés par toutes les routes, `deezer_id` reste dans les réponses tant que la SPA n'a pas
  fini de basculer ;
- aucun téléchargement ne démarre de lui-même après la montée (la règle `upgrade` est à `off`).

## 10. Décisions prises par défaut (à corriger si besoin)

1. **Un titre = une ligne**, plusieurs `track_source` ; les colonnes `deezer_id`/`youtube_id` restent
   (double écriture) au lieu d'être migrées puis supprimées : moins risqué, réversible.
2. **Le module `supysonic/deezer/` n'est pas renommé** (le renommage toucherait presque tous les
   fichiers et entrerait en conflit avec chaque lot) ; les nouveaux fournisseurs vivent dans
   `supysonic/providers/`.
3. **La règle d'amélioration de qualité est désactivée par défaut** et l'ordre des fournisseurs est
   l'ordre d'enregistrement (Deezer d'abord, YouTube repli).
4. **YouTube reste un repli opt-in** (rôle `fallback`), pas un fournisseur de premier rang, même s'il
   passe par la même interface.
5. **Les secrets sont stockés comme aujourd'hui** (clair en base, masqués à l'API, jamais journalisés) ;
   un chiffrement au repos est une option du lot H, pas un prérequis.
6. **Le premier vrai fournisseur supplémentaire est Jamendo** (API ouverte, licences libres, FLAC
   disponible) : il prouve l'interface sans dépendre d'un abonnement. Qobuz, Tidal, SoundCloud,
   Bandcamp ou un autre serveur Subsonic suivent le même gabarit ; **le choix du suivant est à la
   personne**, pas à ce plan.

## 11. Ce que ce plan ne fait pas

Pas de réécriture de la SPA hors des écrans nommés, pas de renommage de package, pas de suppression
des colonnes héritées, pas de nouvelle source de faits (MusicBrainz/LRCLIB restent comme elles sont),
pas de synchronisation vers un compte de fournisseur.
