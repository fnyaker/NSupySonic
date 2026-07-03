# Plan — support des podcasts Deezer

État des lieux : **rien n'existe** côté podcasts. Supysonic n'implémente aucun endpoint
`getPodcasts*` (ils ne sont même pas dans `unsupported.py`), il n'y a pas de table
podcast en base, et `deezerpy` n'expose que `get_chart_podcasts` (`deezerpy/api.py:121`).
Deezer appelle les podcasts des **shows** en interne (`SHOW_ID`, `EPISODE_ID`).

## 1. Endpoints Deezer

### 1.1 Vérifié — API publique `api.deezer.com` (transport existant : `deezerpy/api.py`)

Mêmes conventions que le reste (GET, pagination `index`/`limit`) :

| Endpoint | Donne |
|---|---|
| `GET /podcast/{id}` | show : `id, title, description, available, fans, link, picture{,_small,_medium,_big,_xl}` |
| `GET /podcast/{id}/episodes?index=&limit=` | épisodes : `id, title, release_date, duration, picture` (pas d'URL de flux) |
| `GET /episode/{id}` | un épisode + son objet `podcast` imbriqué (pas d'URL de flux) |
| `GET /search/podcast?q=` | recherche de shows |
| `GET /genre/{id}/podcasts` | shows par genre |
| `GET /chart/{genre_id}/podcasts` | déjà vendored (`get_chart_podcasts`) |
| `GET /user/{id}/podcasts` | favoris — **OAuth uniquement**, inutilisable avec l'ARL → passer par la gateway |

→ suffit pour **parcourir/chercher/importer les métadonnées**, mais pas pour streamer
ni pour lire/écrire les favoris.

### 1.2 Vérifié dans du code tiers — gateway *mobile* (`d-fi-core` 1.4.0, `dist/api/api.js`)

`POST https://api.deezer.com/1.0/gateway.php?method=mobile.pageShow` avec body
`{SHOW_ID, NB, START}` → `{DATA: <show>, EPISODES: {data: [...], total}}`.
Champs épisode observés (`dist/types/show.d.ts`) — c'est la forme qui nous intéresse :

```
EPISODE_ID, EPISODE_TITLE, EPISODE_DESCRIPTION, EPISODE_STATUS, AVAILABLE,
SHOW_ID, SHOW_NAME, SHOW_ART_MD5, DURATION, EPISODE_PUBLISHED_TIMESTAMP,
EPISODE_DIRECT_STREAM_URL, SHOW_IS_DIRECT_STREAM,
TRACK_TOKEN, TRACK_TOKEN_EXPIRE, FILESIZE_MP3_32, FILESIZE_MP3_64, MD5_ORIGIN
```

Deux modes de flux se déduisent des champs :

- **`SHOW_IS_DIRECT_STREAM = 1`** (la grande majorité des podcasts) :
  `EPISODE_DIRECT_STREAM_URL` = MP3 servi par l'hébergeur du podcast ou le CDN —
  téléchargement direct, **pas de Blowfish**.
- **shows hébergés/exclusifs Deezer** : `TRACK_TOKEN` + `FILESIZE_MP3_32/64` →
  résolution via `media.deezer.com` comme les pistes (`dz.get_track_url(token, "MP3_64")`).
  Chiffrement à confirmer (probablement aucun, mais à vérifier en capture).

Cette gateway mobile exige une clé API mobile que le repo n'a pas ; on ne l'utilisera
pas telle quelle. Elle sert de **référence de forme** : la gw-light du player web
renvoie les mêmes structures.

### 1.3 CONFIRMÉ par capture HAR (gw-light `www.deezer.com/ajax/gw-light.php`, transport de `deezerpy/gw.py`)

Capture du player web du 2026-07-03 (show `1002156761`, épisode `897955951`).
Toutes les méthodes ci-dessous sont **observées et vérifiées** :

| Usage | Méthode | Body (JSON) | Réponse |
|---|---|---|---|
| Page show **+ épisodes** | `deezer.pageShow` | `{show_id, country:"FR", lang:"en", nb:40, start:0, user_id}` | `{DATA:<show>, FAVORITE_STATUS:bool, EPISODES:{data:[…], count, total}}` |
| Ajouter aux favoris | `show.addFavorite` | `{SHOW_ID, CTXT:{id, t:"show_page"}}` | `true` |
| Retirer des favoris | `show.deleteFavorite` | `{SHOW_ID, CTXT:{id, t:"show_page"}}` | `true` |
| Position de lecture (resume) | `episode.bookmarkSet` | `{EPISODE_ID, OFFSET:<sec>, DURATION:<float>, ISHEARD:0/1}` | `true` |
| Scrobble épisode | `log.listen` | `media.type="talk"`, `format="EXTERNAL"`, `ctxt.t="talk_show_page"` | — |

Points confirmés qui changent le design :

- **Une seule méthode suffit** : `deezer.pageShow` renvoie le show **et** la liste
  d'épisodes paginée (`nb`/`start`, avec `total`). Pas besoin d'un
  `episode.getListByShow`/`episode.getData` séparé. Piège habituel : `nb:40` par
  défaut → pour tout récupérer, boucler sur `start` jusqu'à `total` (ou tenter
  `nb:-1`).
- **`media.type` du scrobble = `"talk"`** (pas `"episode"`), `format="EXTERNAL"`.
- **`episode.bookmarkSet`** = synchro de position de lecture côté Deezer, gratuite
  → on peut alimenter/lire le resume long-form (§5) au lieu de le garder purement
  local. Le player l'appelle ~toutes les 30 s (`OFFSET` croissant) + une fois à la
  fin avec `ISHEARD:1`.

Objet **épisode** (clés réelles observées) :

```
EPISODE_ID, EPISODE_TITLE, EPISODE_DESCRIPTION, EPISODE_STATUS, AVAILABLE,
SHOW_ID, SHOW_NAME, SHOW_ART_MD5, SHOW_DESCRIPTION, SHOW_IS_EXPLICIT,
DURATION, EPISODE_PUBLISHED_TIMESTAMP, EPISODE_PUBLISHED_TS,
EPISODE_UPDATE_TIMESTAMP, EPISODE_IMAGE_MD5,
EPISODE_DIRECT_STREAM_URL, SHOW_IS_DIRECT_STREAM,
MD5_ORIGIN, FILESIZE_MP3_32, FILESIZE_MP3_64, TRACK_TOKEN, TRACK_TOKEN_EXPIRE
```

Objet **show** (`DATA`) : `SHOW_ID, SHOW_NAME, SHOW_DESCRIPTION, SHOW_ART_MD5,
SHOW_IS_EXPLICIT, SHOW_IS_DIRECT_STREAM, LABEL_NAME, AVAILABLE, SHOW_STATUS`.

### 1.4 CONFIRMÉ — le streaming audio : MP3 direct, sans auth, sans Blowfish

Pour ce show (`SHOW_IS_DIRECT_STREAM=1`, cas de la quasi-totalité des podcasts),
`EPISODE_DIRECT_STREAM_URL` pointe vers **l'hébergeur du podcast**, pas Deezer.
Chaîne observée :

```
GET content.rss.com/episodes/.../xxx.mp3        Range: bytes=0-   → 307
 → rsscom.pdn.tritondigital.com/v1/download/…    → 302
 → rsscom.pdn.tritondigital.com/…?session_id=…   → 206  audio/mpeg
```

La requête audio ne porte **aucun cookie, aucun `Authorization`** — juste
`Referer: https://www.deezer.com/` et un `Range`. Donc côté proxy :

- **Pas de déchiffrement Blowfish** (contrairement aux pistes musicales).
- Le downloader se contente de **suivre les redirections** (comportement `requests`
  par défaut) et d'ajouter le `Referer` ; Range/206 supportés.
- `MD5_ORIGIN`/`FILESIZE_MP3_32/64` sont vides/0 ici → pas de copie Deezer-hostée.
  Le `TRACK_TOKEN` reste présent mais **inutile pour les shows direct-stream** ;
  on ne le mobilise que si un show exclusif Deezer se présente (`SHOW_IS_DIRECT_STREAM=0`,
  non rencontré dans la capture — fallback `media.deezer.com` via token à traiter le
  jour où on en croise un).

### 1.5 Reste une seule inconnue — lister les shows favoris de l'utilisateur

La capture ouvre un show directement ; elle **ne contient pas** l'appel qui liste
« mes podcasts abonnés ». Deux voies, sans re-capture obligatoire :

- **Contourner** : notre DB est la source de vérité des abonnements
  (`createPodcastChannel` → `show.addFavorite` **et** ligne `PodcastChannel` locale).
  Le sync se contente alors de rafraîchir les épisodes des channels connus. Suffisant
  pour la v1.
- **Import initial des shows déjà en favori** (confort) : à confirmer par une petite
  sonde — candidats `deezer.pageProfile {USER_ID, tab:"podcasts"}` ou un
  `page.get PAGE="favorites"`. Non bloquant.

La recherche de podcasts passe côté player par le GraphQL `pipe.deezer.com`
(`SearchFull`, `Show(id)`) ; le gw `search.music` avec `output:"SHOW"/"EPISODE"`
est l'alternative probable mais non capturée. À sonder au besoin.

## 2. Modèle de données

Les épisodes ne sont **pas** des pistes (pas d'artiste/album, statuts de download,
purge) → tables dédiées plutôt que de matérialiser en albums, et mapping direct sur
le modèle podcast de l'API Subsonic.

- `supysonic/db.py` : deux modèles peewee, `SCHEMA_VERSION` bumpé + migrations
  `{sqlite,postgres,mysql}` :
  - **PodcastChannel** : `id` (UUID pk), `deezer_id` (nullable, unique), `url`
    (lien deezer.com/show/… ; garde la porte ouverte à du RSS générique plus tard),
    `title`, `description`, `cover_art_md5`, `last_fetched`, `error_message`,
    `user` (FK, propriétaire de l'abonnement).
  - **PodcastEpisode** : `id` (UUID pk), `channel` (FK), `deezer_id`, `title`,
    `description`, `duration`, `publish_date` (depuis `EPISODE_PUBLISHED_TS`),
    `stream_url` (l'`EPISODE_DIRECT_STREAM_URL` — stocké pour rejouer le
    téléchargement sans re-fetch de la page show), `image_md5`
    (`EPISODE_IMAGE_MD5`, cover propre à l'épisode), `path` (nullable tant que pas
    archivé), `size`, `bitrate`, `suffix`/`mimetype`,
    `status` (`new | downloading | completed | error` — vocabulaire Subsonic),
    `play_offset` (position de lecture, alimentée par `episode.bookmarkSet` §1.3).
- `supysonic/deezer/ids.py` : `NS_SHOW`, `NS_EPISODE` + `show_uuid()`,
  `episode_uuid()` (uuid5, même schéma déterministe → imports idempotents).

## 3. Couche Deezer

- **`deezerpy/api.py`** : `get_podcast`, `get_podcast_episodes`, `get_episode`,
  `search_podcast`, `get_genre_podcasts` (5 one-liners, §1.1 — pour la recherche/
  découverte publique, images typées).
- **`deezerpy/gw.py`** (méthodes confirmées §1.3) :
  - `get_show_page(show_id, nb=40, start=0)` → `deezer.pageShow` ; renvoie show +
    épisodes. `get_show_episodes(show_id)` : boucle sur `start` jusqu'à
    `EPISODES.total` pour tout récupérer.
  - `add_show_to_favorites(show_id)` / `remove_show_from_favorites(show_id)` →
    `show.addFavorite` / `show.deleteFavorite` (body `{SHOW_ID, CTXT:{id, t:"show_page"}}`).
  - `set_episode_bookmark(episode_id, offset, duration, is_heard)` →
    `episode.bookmarkSet`.
  - `log_listen` étendu pour accepter `media.type="talk"` / `format="EXTERNAL"`
    (scrobble épisode).
- **`supysonic/deezer/provider.py`** :
  - délégations métadonnées (`get_show`, `get_show_episodes`) ;
  - `resolve_episode(episode)` → `url` : renvoie directement
    `EPISODE_DIRECT_STREAM_URL` pour les shows direct-stream (cas nominal, §1.4).
    Fallback token `media.deezer.com` gardé en réserve pour un éventuel show
    `SHOW_IS_DIRECT_STREAM=0` (non rencontré).
  - `download_episode_to(url, dest)` : GET **direct, sans Blowfish**, en suivant les
    redirections et avec `Referer: https://www.deezer.com/` (mutualise l'écriture
    atomique `.part` de `download_to`, sans l'étape de déchiffrement).
  - `set_episode_position` / scrobble épisode (best-effort, comme `report_listen`).
- **`supysonic/deezer/archive.py`** : `ensure_episode_archived(provider, episode)` —
  même contrat qu'`ensure_archived` (idempotent, lock par id, `.part` atomique,
  statut `downloading`→`completed`/`error`), chemin
  `archive_dir/Podcasts/<Show>/<YYYY-MM-DD - Titre>.mp3`.
  **Adaptation de la règle FLAC** : la source podcast est un MP3 externe (pas de
  FLAC disponible, §1.4) ; on archive la source telle quelle, le transcodage Opus à
  la demande passe par le pipeline existant. La règle « ne jamais streamer
  directement depuis Deezer » reste respectée dans l'esprit : on archive d'abord,
  on sert le fichier local ensuite — on ne proxifie jamais le flux distant en direct.
- **`supysonic/deezer/importer.py` + `scheduler.py`** : `sync_podcasts()` — pour
  chaque `PodcastChannel` connu (notre DB = source de vérité, §1.5), rafraîchir les
  métadonnées + les N derniers épisodes (audio à la demande). Config :
  `sync_podcasts = yes`, `podcast_episodes = 30`. (Import initial des shows déjà
  favoris = amélioration optionnelle, dépend de la sonde §1.5.)
- **CLI** : `supysonic-cli deezer import https://deezer.com/…/show/<id>` (et
  `/episode/<id>`) — étendre le parseur d'URL de `archive.py`.
- **`push.py`** : abonnement/désabonnement Subsonic → favori show Deezer
  (fail-soft, gardé par `push_to_deezer`).

## 4. API Subsonic (`/rest`)

Nouveau `supysonic/api/podcast.py`, réponses conformes au XSD 1.16.0
(déjà dans `tests/assets/`) :

- `getPodcasts` (`includeEpisodes`, `id`) — channels + épisodes (`status`,
  `streamId`, `publishDate`…).
- `getNewestPodcasts` (`count`) — derniers épisodes tous shows confondus.
- `refreshPodcasts` — déclenche `sync_podcasts()` (admin ou `podcastRole`).
- `createPodcastChannel` (`url`) — URL deezer.com/show → favori + import.
  URL RSS non-Deezer : erreur explicite en v1 (extension générique possible après).
- `deletePodcastChannel`, `deletePodcastEpisode` (supprime le fichier archivé,
  repasse `status=new`... ou supprime la ligne, au choix Subsonic : ligne supprimée).
- `downloadPodcastEpisode` — pré-archive en tâche de fond (worker de `prefetch.py`).
- **Streaming** : `stream?id=<episode>` — dans `media.py`, quand l'id ne résout pas
  en `Track`, tenter `PodcastEpisode` → `ensure_episode_archived` → chemin
  transcode/cache/`send_file` inchangé.
- `db.py:482` : exposer `podcastRole` (True pour admin, ou colonne dédiée).

## 5. Web UI (`/api` + Svelte)

- Routes (`supysonic/webui/__init__.py`, mêmes gardes `login_required` +
  validation id numérique) : `GET /api/podcasts` (abonnements),
  `GET /api/podcast/<id>` (show + épisodes), `POST/DELETE /api/podcast/<id>/favorite`,
  `GET /api/podcast/episode/<id>/stream` (même pipeline opus),
  recherche : section `podcasts` dans `/api/search`.
- Svelte : page Podcasts (cartes, cohérent avec la home), page show
  (liste d'épisodes avec durée/date/description), lecture via le player existant.
  Icônes via `Icon.svelte`.
- **Reprise de lecture (resume)** : la colonne `play_offset` est déjà remplie par
  `episode.bookmarkSet` (§1.3) — le player reprend là où on s'est arrêté, et pousse
  la position vers Deezer (best-effort, gardé par `push_to_deezer`). Réalisable en
  v1 puisque la synchro Deezer est confirmée, pas besoin d'infra dédiée.

## 6. Tests

- `tests/test_podcast.py` : MockGW/MockApi étendus (fixtures `deezer.pageShow`,
  `episode.getData`, payload public `/podcast`), couvrant : sync favoris,
  `getPodcasts`/`getNewestPodcasts`/`createPodcastChannel`, interception stream
  (mock du download), routes `/api/podcast*`, purge/suppression.
- `tests/net/` : une sonde live optionnelle (CI only) sur `api.deezer.com/podcast`.

## 7. Ordre de livraison

**Phase 0 (validation endpoints) — FAITE** : capture HAR du 2026-07-03 traitée,
méthodes gw et flux audio confirmés (§1.3–1.4). Seul reste optionnel : sonder la
liste des shows favoris (§1.5), non bloquant.

1. Phase 1 — deezerpy (api + gw) + provider (`resolve_episode`, `download_episode_to`).
2. Phase 2 — DB + ids + migrations.
3. Phase 3 — archive + importer/scheduler/CLI.
4. Phase 4 — `/rest` podcast + interception stream + tests.
5. Phase 5 — `/api` webui + pages Svelte (dont resume via `play_offset`).
6. Phase 6 — push favoris + bookmark, `downloadPodcastEpisode`/prefetch,
   config.sample + docs.

Chaque phase est mergeable indépendamment. Fixtures de test disponibles : les formes
de payload réelles sont dans ce document (§1.3) et dans la capture traitée.
