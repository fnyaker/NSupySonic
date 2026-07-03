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

### 1.3 À confirmer par capture — gw-light (`www.deezer.com/ajax/gw-light.php`, transport de `deezerpy/gw.py`)

Noms très probables (conventions du player web), **non confirmés publiquement** :

| Usage | Méthode candidate | Args candidats |
|---|---|---|
| Page show | `deezer.pageShow` | `{SHOW_ID, lang, nb, start}` |
| Épisodes d'un show | `episode.getListByShow` | `{SHOW_ID, NB, START}` |
| Un épisode (avec URL de flux + token) | `episode.getData` | `{EPISODE_ID}` |
| Favoris (liste) | `deezer.pageProfile` | `{USER_ID, tab: "podcasts", nb}` |
| Favori add/remove | `show.addFavorite` / `show.deleteFavorite` (?) | `{SHOW_ID}` |
| Recherche shows/épisodes | `search.music` | `{output: "SHOW" / "EPISODE", ...}` |
| Scrobble épisode | `log.listen` | `media.type = "episode"` (?) |

**Procédure de confirmation** (dans l'ordre de coût) :

1. `ARL=... python tools/deezer_explore/probe.py --show <id>` — les sondes podcast
   read-only ci-dessus sont maintenant dans le probe ; il extrait tout seul un
   `EPISODE_ID` si `deezer.pageShow` répond.
2. Si le probe ne suffit pas (favoris add/remove, requête audio réelle, scrobble) :
   capture HAR devtools selon `tools/deezer_explore/README.md`, en couvrant
   spécifiquement : ouvrir un show, **lancer la lecture d'un épisode** (c'est la
   requête audio qui nous dit URL directe vs `media.deezer.com` et chiffré ou pas),
   ajouter/retirer un show des favoris, onglet Podcasts du profil, recherche d'un
   show, puis `python tools/deezer_explore/har_to_catalog.py capture.har`.

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
    `description`, `duration`, `publish_date`, `path` (nullable tant que pas
    archivé), `size`, `bitrate`, `suffix`/`mimetype`,
    `status` (`new | downloading | completed | error` — vocabulaire Subsonic).
- `supysonic/deezer/ids.py` : `NS_SHOW`, `NS_EPISODE` + `show_uuid()`,
  `episode_uuid()` (uuid5, même schéma déterministe → imports idempotents).

## 3. Couche Deezer

- **`deezerpy/api.py`** : `get_podcast`, `get_podcast_episodes`, `get_episode`,
  `search_podcast`, `get_genre_podcasts` (5 one-liners, §1.1).
- **`deezerpy/gw.py`** (après confirmation §1.3) : `get_show_page`,
  `get_show_episodes` (pagination `NB`/`START`, prévoir le pattern `nb:-1` ou boucle —
  même piège que les tracklists d'albums), `get_episode`,
  `add_show_to_favorites` / `remove_show_from_favorites`, `get_user_shows`.
- **`supysonic/deezer/provider.py`** :
  - délégations métadonnées (`get_show`, `get_show_episodes`, `get_episode_info`) ;
  - `resolve_episode(episode_id)` → `(url, fmt, needs_decrypt)` :
    `EPISODE_DIRECT_STREAM_URL` si présent (direct, pas de Blowfish), sinon
    `TRACK_TOKEN` → `dz.get_track_url(token, "MP3_128"→"MP3_64"→"MP3_32")` ;
  - `download_episode_to(url, dest)` : téléchargement direct (mutualiser avec
    `download_to`, en sautant le déchiffrement).
- **`supysonic/deezer/archive.py`** : `ensure_episode_archived(provider, episode)` —
  même contrat qu'`ensure_archived` (idempotent, lock par id, `.part` atomique,
  statut `downloading`→`completed`/`error`), chemin
  `archive_dir/Podcasts/<Show>/<YYYY-MM-DD - Titre>.mp3`.
  **Adaptation de la règle FLAC** : la source podcast est du MP3 ; on archive la
  source telle quelle et le transcodage Opus à la demande passe par le pipeline
  existant. La règle « ne jamais streamer directement depuis Deezer » reste :
  on archive d'abord, on sert ensuite.
- **`supysonic/deezer/importer.py` + `scheduler.py`** : `sync_podcasts()` — favoris
  Deezer → upsert channels + N derniers épisodes (métadonnées seules, audio à la
  demande). Config : `sync_podcasts = yes`, `podcast_episodes = 30`.
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
  Icônes via `Icon.svelte`. Option v2 : mémorisation de la position de lecture
  (long-form) — nécessite une table/colonne dédiée, hors v1.

## 6. Tests

- `tests/test_podcast.py` : MockGW/MockApi étendus (fixtures `deezer.pageShow`,
  `episode.getData`, payload public `/podcast`), couvrant : sync favoris,
  `getPodcasts`/`getNewestPodcasts`/`createPodcastChannel`, interception stream
  (mock du download), routes `/api/podcast*`, purge/suppression.
- `tests/net/` : une sonde live optionnelle (CI only) sur `api.deezer.com/podcast`.

## 7. Ordre de livraison

1. **Phase 0 — validation endpoints** (probe --show, sinon HAR) → fige les noms gw.
2. Phase 1 — deezerpy (api + gw) + provider (`resolve_episode`).
3. Phase 2 — DB + ids + migrations.
4. Phase 3 — archive + importer/scheduler/CLI.
5. Phase 4 — `/rest` podcast + interception stream + tests.
6. Phase 5 — `/api` webui + pages Svelte.
7. Phase 6 — push favoris, `downloadPodcastEpisode`/prefetch, config.sample + docs.

Chaque phase est mergeable indépendamment ; seule la phase 1 dépend de la phase 0.
