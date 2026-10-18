# Se détacher de Deezer : Deezer comme pure source de sons

Objectif (demande du propriétaire, 18/10/2026) : Deezer ne doit plus être qu'un **fournisseur de
fichiers FLAC**. Un titre archivé depuis Deezer doit être, pour le reste de l'application, **un
fichier comme un autre, comme si l'utilisateur l'avait uploadé** : l'audio, la pochette, le titre,
l'album, le nom (et l'id) de l'artiste. Rien d'autre ne vient de Deezer : ni ses algorithmes
(Flow, mixes, radios, recommandations, classements), ni ses données pré-calculées (gain, BPM,
genre, crédits, paroles, label… : celles qu'on veut garder viennent d'ailleurs, voir D19), ni la synchronisation de nos playlists et favoris vers
le compte Deezer.

**Précision du propriétaire (18/10/2026)** : les informations utiles au-delà de ces cinq champs —
**la date de sortie et les paroles** en premier lieu — doivent quand même être importées, mais
**depuis des sources fiables autres que Deezer**, et **aucun de nos algorithmes ne doit en
dépendre**. D'où deux règles qui s'appliquent à tous les chantiers ci-dessous :

1. **L'enrichissement est une couche à part** (D19) : il arrive après l'archivage, en arrière-plan,
   il peut échouer ou ne rien trouver, et rien d'autre ne l'attend.
2. **Nos algorithmes ne lisent que ce que nous mesurons ou ce que l'utilisateur a choisi** : la
   normalisation, le tempo, le genre, les recommandations fonctionnent à l'identique sur un fichier
   sans aucune métadonnée enrichie. Les données enrichies servent à l'affichage, au tri et à la
   recherche.

Ce document est un **inventaire**, pas une implémentation. Chaque section `D<n>` est un chantier
indépendant, qui peut devenir sa propre tâche et sa propre PR. Les dépendances entre chantiers
sont indiquées ; l'ordre conseillé est en fin de document.

## Ce que Deezer continue de faire

Pour que la liste ci-dessous soit lisible, voici la frontière visée :

| Reste chez Deezer | Pourquoi |
|---|---|
| L'ARL, la connexion, le jeton de média, le téléchargement et le déchiffrement du FLAC (`provider.py`, `deezerpy/`, `archive.ensure_archived`) | C'est la source des sons. |
| La **recherche de catalogue** (`/api/search`, côté Deezer) et la lecture d'une page album / artiste / playlist **pour trouver** des sons à récupérer | Il faut bien savoir quoi télécharger. Ces pages servent à choisir ; elles n'alimentent plus la bibliothèque au-delà des cinq champs. |
| La pochette d'album (téléchargée une fois, stockée en `cover.jpg`) | Explicitement gardée. |
| Le titre, l'album, le nom et l'id de l'artiste (et les artistes crédités en featuring, qui sont des noms d'artistes) | Explicitement gardés. |
| L'**ISRC** (code international d'un enregistrement), lu une fois à l'archivage | Ce n'est pas une donnée Deezer mais l'identifiant de l'industrie, et c'est la clé la plus sûre pour retrouver l'enregistrement dans MusicBrainz (D19). Gardé dans le sidecar, jamais lu par un algorithme. |
| Le numéro de piste et de disque | **Choix par défaut** : gardés, car c'est ce qu'un fichier uploadé porte dans ses tags et l'ordre d'un album en dépend. À retirer si le propriétaire en décide autrement. |
| `Track.deezer_id` et les ids déterministes (`ids.py`) | Ils ne sont plus une identité exposée (voir D14), seulement la « référence de source » qui permet de re-télécharger un fichier supprimé par le nettoyage. |
| Les podcasts (shows / épisodes) | Hors périmètre de la demande ; seule la **réécriture vers Deezer** est coupée (D3). |

---

## D1. Arrêter de pousser les playlists vers Deezer

**Demandé explicitement.** Aujourd'hui toute création, modification ou suppression de playlist
est répercutée sur le compte Deezer.

État actuel :
- `supysonic/deezer/push.py` : `reconcile_playlist` (crée la playlist sur Deezer au premier push,
  puis diffuse ajouts / retraits), `delete_playlist`.
- Appelants : `supysonic/webui/__init__.py` (`create_playlist` crée la playlist **sur Deezer
  d'abord** puis clé la ligne locale par `uuid5(deezer_id)` ; `_push_async("delete_playlist")` ;
  `push.reconcile_playlist` après chaque édition), `supysonic/api/playlists.py` (`createPlaylist`,
  `updatePlaylist`, `deletePlaylist` Subsonic), `supysonic/webui/availability.py` (miroir du
  remplacement / de la suppression d'un titre dans les playlists Deezer de l'admin,
  `provider.add_songs_to_playlist` / `remove_songs_from_playlist`).
- Option `push_to_deezer` dans `supysonic/config.py` (vraie par défaut).

À faire :
- Une playlist créée dans l'app est une ligne locale avec un UUID local (`uuid4`), jamais créée sur
  Deezer ; `create_playlist` ne doit plus exiger le provider.
- Supprimer les appels de `reconcile_playlist` / `delete_playlist` dans les trois fichiers, et le
  miroir Deezer des remplacements / suppressions dans `availability.py`.
- Les playlists déjà liées gardent leur `deezer_id` en lecture seule (pour l'import, voir D4) mais
  ne sont plus jamais écrites côté Deezer.
- `PATCH /api/playlist/<id>` : retirer `provider.edit_playlist`.

Fini quand : aucun appel `gw.create_playlist`, `add_songs_to_playlist`, `remove_songs_from_playlist`,
`delete_playlist`, `edit_playlist` n'est atteignable depuis une route ; un test compte zéro appel
au faux gateway pendant un cycle créer / éditer / réordonner / supprimer, en Subsonic comme en `/api`.

## D2. Arrêter de pousser les favoris vers Deezer

État actuel :
- `push.push_favorite` (titres, albums, artistes), appelé depuis `supysonic/api/annotation.py`
  (`star` / `unstar` Subsonic).
- `/api/favorite` (titres) : `provider.dz` + `invalidate_favorites_cache`.
- `/api/favorite/<kind>` (album, artiste, playlist) : **n'existe que côté Deezer**, il n'y a aucune
  étoile locale pour ces trois types (`provider.add_favorite_album`… puis `backfill.archive_entity`).
- `availability.py` : miroir des favoris lors d'un remplacement.

À faire :
- Une étoile est une ligne locale, point. Retirer tous les appels `add_*_to_favorites` /
  `remove_*_from_favorites`.
- Albums, artistes, playlists favoris : les stocker localement (`StarredAlbum`, `StarredArtist`
  existent déjà dans le schéma supysonic ; pour les playlists, une table ou un drapeau à ajouter,
  avec migration). L'archivage déclenché par le favori (`backfill.archive_entity`) reste : c'est
  l'archivage d'une source de sons.
- L'état « favori » d'une page album / artiste ne doit plus venir de la page Deezer
  (`is_favorite`) mais de la base.

Fini quand : étoiler / désétoiler n'importe quoi ne parle jamais à Deezer, et l'état est le même
après redémarrage, Deezer coupé.

## D3. Arrêter les autres écritures vers le compte Deezer

État actuel :
- `/api/listen` → `provider.report_listen` (option `report_listens`, désactivée par défaut) :
  nourrit les recommandations Deezer.
- Podcasts : `/api/podcasts` POST → `provider.add_favorite_show`, DELETE → `remove_favorite_show`,
  `/api/podcast/progress` → `provider.set_episode_position` (`episode.bookmarkSet`), et les mêmes
  côté Subsonic (`supysonic/api/podcast.py`, gardés par `push_to_deezer`).
- `/flow/clusters` POST → `provider.set_flow_clusters` (GraphQL `UpdateFlowConfig`).

À faire : supprimer ces écritures et l'option `report_listens`. Le compteur d'écoutes local
(`_record_play`) reste. Les abonnements et positions de podcasts sont déjà locaux
(`PodcastChannel`, `PodcastProgress`), il suffit de ne plus les recopier.

Fini quand : `push.py` n'a plus d'appelant et peut être supprimé, avec `push_to_deezer`
(voir D17).

## D4. Synchronisation entrante : une importation ponctuelle, plus une source de vérité

État actuel (`supysonic/deezer/importer.py`, lancé par `scheduler.py` chaque nuit) :
- `sync_playlists` réécrit chaque nuit les playlists locales depuis celles du compte Deezer.
- `sync_favorites` **supprime** les étoiles locales des titres Deezer qui ne sont plus favoris sur
  Deezer (`stale` : la base suit Deezer).
- `/api/me/favorites` (admin) fusionne la liste **en direct** des favoris Deezer
  (`provider.get_my_favorite_tracks`) ; `/api/me/favorite-ids` fait l'union avec
  `gw.get_user_favorite_ids`.
- `sync_podcasts` ajoute les shows favoris côté Deezer (`get_user_shows`).

À faire :
- Transformer `sync_playlists` / `sync_favorites` en **import ponctuel** (bouton dans Réglages →
  Compte Deezer, et `supysonic-cli deezer import-account`) : il ajoute, il ne retire jamais rien,
  et il n'est plus lancé par le planificateur.
- `/me/favorites` et `/me/favorite-ids` ne lisent plus que la base.
- `sync_podcasts` ne lit plus les favoris Deezer, seulement les abonnements locaux (le
  rafraîchissement des épisodes reste).
- Le fil « import de playlists partagées » (Deezer / Spotify / YouTube / Apple Music) est traité
  ailleurs ; ce chantier peut s'appuyer sur lui pour l'import ponctuel, mais n'en dépend pas.

Fini quand : retirer un favori ou une playlist sur Deezer ne change rien chez nous ; le
planificateur ne lit plus rien du compte.

## D5. Retirer les playlists algorithmiques importées (Flow, mixes, nouveautés)

État actuel : `importer.sync_recommendations` matérialise chaque nuit en playlists locales
« Deezer · <mix> » (`sync_smart_tracklists`, options `import_new_releases` /
`smart_tracklists`), « Deezer · Flow » (`sync_flow`, `import_flow`) et « Deezer · Nouveautés en
vrac » (`sync_new_albums`, `import_new_albums`). Ce sont des choix de l'algorithme Deezer qui
deviennent des playlists de la bibliothèque.

À faire : arrêter ces imports et les options correspondantes. Les playlists déjà créées : **choix
par défaut**, les laisser comme playlists ordinaires (elles deviennent figées et éditables, rien
n'est perdu) plutôt que de les supprimer ; une migration retire le préfixe-convention
« Deezer · » du code qui le traite à part (`push.reconcile_playlist`, `_db_mix_for`, `home`).

Fini quand : le planificateur n'appelle plus aucune de ces fonctions.

## D6. Accueil et lecture continue sans les algorithmes Deezer

État actuel :
- `/api/home` : cartes des smart tracklists Deezer (`provider.get_smart_tracklist`).
- `/api/smarttracklist/<sid>`, `routes/Mix.svelte`.
- `/api/flow`, `/api/flow/clusters` (GraphQL, `deezerpy/graphql.py`) et leurs réglages.
- `/api/recommendations` : sorties éditoriales et classements (`get_editorial_releases`,
  `get_chart_artists`, `get_chart_playlists`) sur `routes/Home.svelte`.
- `/api/radio/track/<id>` (`get_track_mix`) et `/api/radio/artist/<id>` : la lecture automatique à
  la fin de la file (`Player.svelte#ensureUpcoming`, contexte `flow` ou radio) et la rangée
  « titres qui sonnent pareil » sous le lecteur plein écran (`NowPlayingMore.svelte`, dont le
  commentaire dit déjà « jusqu'à ce qu'on puisse les calculer avec notre propre analyse »).
- `/api/artist/<id>` : « artistes similaires » (`get_artist_related`) et « top » (`get_artist_top`,
  le classement de popularité Deezer).

À faire : remplacer par du calcul local, à partir de ce que le serveur sait déjà :
- **Radio / lecture continue / titres similaires** : plus proches voisins dans les embeddings
  (`embedding.py`, vecteurs déjà stockés) pondérés par tempo et genre servis (`track_analysis`),
  restreints à la bibliothèque archivée ; repli sur même artiste / même genre quand un titre n'a
  pas de vecteur.
- **Accueil** : rangées locales (récemment ajoutés, beaucoup écoutés, oubliés depuis longtemps,
  « mix » par genre servi ou par grappe d'embeddings), à la place des smart tracklists.
- **Flow** : un « flow » local = radio sur l'historique d'écoute récent ; supprimer la
  configuration de grappes GraphQL.
- **Page artiste** : « top » = titres les plus écoutés localement ; « similaires » = voisins par
  embeddings agrégés par artiste (ou retiré tant que ce n'est pas fait).
- Ce chantier se découpe naturellement en trois PR : radio / lecture continue, accueil, page
  artiste.

Fini quand : aucune de ces routes n'appelle Deezer, et le lecteur continue une file en mode avion
sur la bibliothèque archivée.

## D7. Explorer

État actuel : `/api/explore`, `/explore/genre/<id>`, `/explore/countries`, `routes/Explore.svelte` :
entièrement les classements et genres éditoriaux de l'API publique Deezer.

À faire : décision du propriétaire nécessaire, deux options :
1. **Choix par défaut** : retirer l'écran (et son lien dans `Sidebar.svelte` / `MobileNav.svelte`),
   l'exploration du catalogue passant par la recherche.
2. Le réécrire sur la bibliothèque locale (par genre servi, par décennie, par artiste).

Fini quand : l'écran n'existe plus, ou ne lit plus que la base.

## D8. Ce qu'on écrit sur disque à l'archivage : cinq champs, pas plus

État actuel :
- `metadata.meta_from_gw` + `tag_file` écrivent dans le FLAC : titre, artistes, album,
  albumartist, piste, disque, **date, ISRC, ReplayGain dérivé du `GAIN` Deezer** (`TXXX`,
  `REPLAYGAIN_TRACK_GAIN`), paroles embarquées.
- `library.save_track_metadata` écrit `<track>.json` avec un bloc `gw` de `_KEEP_FIELDS` : `ISRC`,
  `GAIN`, `EXPLICIT_LYRICS`, `COPYRIGHT`, `LYRICS_ID`, `PROVIDER_ID`, `RANK_SNG`,
  `SNG_CONTRIBUTORS`, `LABEL_NAME`, dates de sortie…
- `library.refresh_track_metadata` « améliore » la ligne depuis `song.getData` (gain, année…).

À faire :
- Tags à l'archivage : titre, artiste(s), album, artiste de l'album, piste / disque (voir le choix
  par défaut en tête), pochette, ISRC. Plus de date Deezer, de gain Deezer.
- Sidecar : réduit aux ids de source (`deezer_id`, `artist_deezer_id`, `album_deezer_id`), à
  l'ISRC et aux cinq champs ; plus de bloc `gw`. L'enrichissement (D19) y ajoute ensuite une
  section `enrich` à lui (identifiants MusicBrainz, date de sortie, label, crédits, avec la source
  et la date de chaque valeur) et réécrit les tags correspondants dans le fichier.
- `refresh_track_metadata` ne garde que ces champs.
- Migration de l'existant : un job (bouton + CLI, reprise sur checkpoint comme les autres
  backfills) qui réécrit les sidecars et retire les tags superflus des archives déjà présentes,
  sans retélécharger l'audio. Le tag doit être réécrit hors du fichier publié puis remplacé
  (même règle que `archive._tag_archive`).

Dépend de : D9 (gain), D10 (crédits), D11 (paroles), D12 (date), D19 (enrichissement) pour savoir
ce qui remplace chaque champ retiré.

Fini quand : une archive neuve et une archive migrée portent exactement les mêmes champs qu'un
upload tagué proprement, et l'enrichissement de D19 s'applique aux deux de la même façon.

## D9. Normalisation du volume mesurée par nous, pour tout le monde

État actuel : `Track.gain` vient du `GAIN` Deezer (import, `/api/gain/<id>`, `/api/gains` qui
appelle `provider.get_tracks` pour les inconnus). Les uploads **n'ont aucun gain** (« locals have
no ReplayGain » dans `track_gain`) et ne sont donc pas normalisés.

À faire : l'analyse serveur mesure déjà la sonie intégrée (`ebur128`, `lufs` dans
`track_analysis`). En dériver le gain (cible −18 LUFS comme ReplayGain, ou la référence que le
lecteur suppose aujourd'hui : à vérifier dans `lib/gaincache.js` / `graph.js` pour garder le même
niveau d'écoute), le stocker dans `Track.gain` à la mesure, pour les archives **et** les uploads.
`/api/gains` ne répond plus que depuis la base ; un titre pas encore mesuré n'a pas de gain (comme
aujourd'hui un titre inconnu). Re-mesure de la bibliothèque existante via le backfill d'analyse.
`/api/gain/<id>` et `/api/gains` acceptent les UUID (voir D14).

Attention : la règle « la normalisation est statique, jamais changée sous un titre qui joue »
(`gaincache.js`) reste ; le premier passage d'un titre jamais archivé n'aura pas de gain, c'est le
prix (à mesurer : l'analyse tourne juste après l'archivage).

Fini quand : aucun gain ne vient de Deezer, et un upload est normalisé comme une archive.

## D10. Crédits : performeurs depuis nos données, le reste depuis les tags du fichier

État actuel : `supysonic/webui/credits.py` (`/api/track/<id>/credits`) lit `SNG_CONTRIBUTORS`,
`LABEL_NAME`, ISRC, copyright dans le sidecar, sinon **demande à Deezer** et réécrit le sidecar.
`NowPlayingMore.svelte` affiche le panneau.

À faire : garder les artistes crédités (`TrackArtist`, ce sont des noms d'artistes) ; le reste
(auteur, compositeur, producteur, label, copyright) vient, par ordre de préférence, des **tags du
fichier** (cas d'un upload tagué), puis de **MusicBrainz** via l'enrichissement de D19 (relations
`composer`, `lyricist`, `producer`… de l'enregistrement et de l'œuvre, label de la sortie). Plus
jamais de Deezer : retirer l'appel réseau. Le panneau masque ce qui manque.

Dépend de : D19 pour la partie MusicBrainz (la route peut être coupée de Deezer avant).

Fini quand : la route ne touche plus le provider.

## D11. Paroles : toujours importées, depuis LRCLIB

État actuel : `supysonic/deezer/lyrics.py` cherche d'abord les paroles **de Deezer**
(`provider.get_lyrics`), puis LRCLIB ; `/api/lyrics/<id>` interroge Deezer en direct pour un titre
pas encore archivé ; les paroles sont embarquées dans les tags (`embed_lyrics`).

À faire : les paroles restent importées (demande explicite), mais depuis **LRCLIB**, déjà utilisé
en second choix (`lyrics.fetch_lrclib`) : une base ouverte et sans clé, cherchée par titre,
artiste, album et durée — exactement les champs qu'on garde, ce qui la rend utilisable pour les
uploads aussi (qui n'ont pas de paroles aujourd'hui). La synchronisation à la ligne reste préférée
au texte brut. Le `.lrc` déjà archivé reste. Le CLI `deezer lyrics` devient `supysonic-cli lyrics`.

Rien d'autre ne dépend des paroles : la ligne de paroles du lecteur s'affiche quand il y en a, et
aucun algorithme ne les lit.

Décision du propriétaire possible : garder Deezer en **dernier recours** quand LRCLIB n'a rien ?
**Choix par défaut** : non, pour respecter le détachement ; à rouvrir si la couverture mesurée
de LRCLIB sur la bibliothèque est trop faible (le job de D19 compte les titres sans paroles).

Décision du propriétaire possible : retirer aussi les paroles déjà archivées venant de Deezer ?
**Choix par défaut** : non, un `.lrc` est un fichier à nous, on le garde.

Fini quand : le module ne référence plus le provider.

## D12. Dates de sortie : toujours importées, depuis MusicBrainz

État actuel : `Track.year` vient de `PHYSICAL_RELEASE_DATE` / `DIGITAL_RELEASE_DATE` Deezer
(`normalize_track`), et la date est écrite dans les tags.

À faire : la date reste importée (demande explicite), mais par l'enrichissement de D19 :
- la date de la **première sortie** de l'enregistrement (`first-release-date` de MusicBrainz), qui
  est celle qu'on veut pour un titre réédité ou compilé ; la date de la sortie précise (l'album
  joué) en second, pour la page album ;
- la date d'un upload vient d'abord de ses tags ;
- colonne `Track.year` gardée, et la date complète (AAAA-MM-JJ, parfois seulement AAAA) stockée
  à part pour l'affichage (migration de schéma).

Les données existantes venant de Deezer : **choix par défaut**, gardées jusqu'à ce que
l'enrichissement trouve mieux, et marquées comme venant de Deezer dans le sidecar pour que le job
les remplace. Aucun algorithme ne lit la date.

## D13. Tempo et genre : uniquement mesurés ou choisis par nous

État actuel (`supysonic/deezer/analysis.py`) :
- `tempo_hints` / `provisional_payload` : le BPM publié par Deezer est servi comme tempo
  **provisoire** au premier passage.
- `_deezer_bpm` + `_reconcile_tracked` : le BPM Deezer sert de **témoin d'octave** à la mesure.
- `supysonic-cli deezer bpm-audit`.
- `file_genre` n'est appliqué qu'aux fichiers locaux, parce que les archives Deezer « portent le
  genre large de l'album » : une fois D8 fait, elles n'en portent plus.

À faire :
- Retirer le tempo provisoire et le témoin d'octave ; garder les autres règles d'octave (doublement
  par les kicks, garde-fou du saut de demi-temps). Re-mesurer l'éval (`tools/tempo_eval.py`, 28
  disques) et écrire les chiffres avant / après : le CLAUDE.md dit 23/26 exacts sans le témoin et
  26/26 avec, la perte est attendue sur 3 disques et doit être chiffrée.
- `bpm-audit` supprimé.
- `file_genre` appliqué à toutes les pistes (il ne lira rien sur les archives, ce qui est correct).
- `ANALYSIS_VERSION` à incrémenter (re-mesure au démarrage, comme d'habitude).
- `references.py` / `/genre/references` / `/genre/sounds` (sons par défaut du studio) utilisent la
  recherche Deezer pour **trouver** des enregistrements : c'est de la recherche de catalogue, ça
  reste ; ils doivent seulement passer par la création de ligne minimale de D8.

Fini quand : `analysis.py` n'importe plus le provider.

## D14. Une seule identité : l'UUID de la ligne, pour l'API et la SPA

C'est le chantier le plus large, et celui qui fait vraiment d'une archive « un fichier comme un
upload ».

État actuel : la SPA identifie les titres Deezer par leur **id Deezer** (`deezer_id` apparaît 295
fois dans 58 fichiers de `webapp/src`), et des routes ne les acceptent que sous cette forme :
`/stream/<deezer_id>`, `/favorite`, `/listen`, `/gains`, `/gain/<id>`, `/lyrics/<id>`, `/cover/<id>`,
`/download`, `/radio/track/<id>`… Les uploads passent par un autre chemin (UUID,
`/localcover/<id>`, `/local/<id>`). Les réponses pour une ligne Deezer pointent la pochette vers le
**CDN Deezer** (`_image("cover", md5)` dans `_db_track_rows`, `my_playlists`) même quand
`cover.jpg` est sur disque.

À faire, en deux étapes :
1. Serveur : toute route accepte l'UUID d'une ligne, quelle que soit sa source (la plupart le font
   déjà à moitié) ; chaque titre sérialisé porte `id` (UUID) et une `cover` locale
   (`/api/cover/<uuid>`), jamais une URL du CDN Deezer pour une ligne existante. `deezer_id` reste
   dans la réponse pour les résultats de **recherche de catalogue** pas encore en base.
2. SPA : tout clé sur `id` (file, favoris, cache hors ligne, `gaincache`, `analysis.js#verdictId`,
   `coverKey`, la télécommande, la soirée d'écoute). Migration des données du navigateur
   (IndexedDB, localStorage : la file et la session persistées, les téléchargements hors ligne) :
   relire une ancienne clé Deezer et la convertir via `ids.track_uuid`, qui est déterministe.

Points de vigilance : la télécommande (`remote.py#POLICY`) et la soirée (`party.py`) valident des
ids ; les tests `tests/test_webui_lists.py` comparent les deux chemins de sérialisation et doivent
suivre.

Fini quand : la SPA ne lit `deezer_id` que pour les résultats de recherche de catalogue, et un
upload et une archive suivent exactement le même code de lecture, de pochette, de gain et de
favori.

## D15. Pages album, artiste et playlist : la base d'abord

État actuel : `/api/album/<id>` et `/api/artist/<id>` demandent d'abord **Deezer** et ne lisent la
base qu'en repli (« Deezer disabled/unreachable »). `/api/artist/<id>/tracks`,
`/artist/<id>/discography` : Deezer seulement. Une playlist Deezer non importée est lue en direct.

À faire : une entité présente en base est servie depuis la base (titres archivés ou référencés,
pochette locale) ; la page Deezer n'est demandée que pour **compléter** une entité du catalogue
qu'on n'a pas encore (afficher ce qu'on peut télécharger), et ce qu'elle renvoie au-delà des cinq
champs est ignoré. La discographie d'un artiste de la bibliothèque = ses albums en base, plus une
section « disponible sur Deezer » optionnelle.

Dépend de : D14 (les ids de page).

Fini quand : avec Deezer coupé, toute page d'une entité de la bibliothèque est identique à ce
qu'elle est Deezer allumé, hors section « disponible sur Deezer ».

## D16. Le planificateur ne synchronise plus le compte

État actuel : `supysonic/deezer/scheduler.py` lance chaque nuit `importer.sync` (playlists, favoris,
podcasts, recommandations), puis le balayage d'archivage `backfill.sweep_for`, puis le scan local.

À faire : une fois D4 et D5 faits, il ne reste que le rafraîchissement des épisodes de podcasts et
le scan local. `sweep_for` (filet de sécurité de l'archivage) reste mais ne se fonde plus sur le
contenu du compte Deezer, seulement sur ce qui est en base et pas encore sur disque. Les options
`sync_playlists`, `sync_favorites`, `import_*`, `smart_tracklists` disparaissent ; `sync_user`,
`sync_at`, `sync_interval` sont à renommer ou documenter pour ce qui reste.

Dépend de : D4, D5.

## D17. Ménage : configuration, code mort, documentation

À faire, quand les chantiers précédents sont fusionnés :
- `supysonic/config.py`, `config.sample`, `config/supysonic.conf.example`, `.env.example`,
  `docker/entrypoint.sh` : retirer `push_to_deezer`, `report_listens`, `sync_playlists`,
  `sync_favorites`, `import_new_releases`, `import_flow`, `import_new_albums`, `smart_tracklists`
  (une option inconnue dans un ancien fichier de conf doit être ignorée, pas faire planter).
- Code mort : `push.py`, `deezerpy/graphql.py` (n'alimente que le Flow configurable),
  `provider.get_flow`, `flow_clusters`, `set_flow_clusters`, `get_smart_tracklist`,
  `get_new_release_albums`, `report_listen`, les `add/remove_favorite_*`, les écritures de
  playlist, `gw.get_module_page`, les routes `/flow*`, `/smarttracklist/*`, `/recommendations`,
  `/explore*` et leurs écrans / entrées de `api.js` / `apicache.js`.
- Mocks de test (`tests/test_webui.py` `MockGW` / `MockApi`) allégés en conséquence.
- `CLAUDE.md` : la section Architecture décrit encore les trois transports et leurs usages, les
  règles « Deezer favorites », le témoin d'octave, etc. La réécrire autour de la nouvelle frontière
  (tableau en tête de ce document).
- Écran Réglages → Compte Deezer : ne garder que l'ARL, l'état de connexion, la qualité et
  l'import ponctuel de D4.

## D18. Ce qui reste volontairement dépendant de Deezer (à ne pas casser)

Pour mémoire, ces parties appellent Deezer mais **pour récupérer des sons**, et restent :
- `archive.py`, `prefetch.py`, `backfill.py` (téléchargement, file prioritaire, archivage d'un album
  / d'une discographie mis en favori ou d'une playlist).
- `availability.py` : la sonde et la vérification « disparu des deux sources » ne concernent que
  les titres pas encore archivés ; une archive ne dépend plus jamais de Deezer, c'était déjà la
  règle.
- `automatch.py` / `audiomatch.py` : la seule référence d'un titre mort est l'extrait de 30 s de
  Deezer ; c'est de l'audio, pas une métadonnée. À garder tel quel.
- `cleanup.py` : il ne supprime que des lignes avec `deezer_id`, parce qu'elles sont
  re-téléchargeables ; cette règle reste vraie et reste la seule différence de traitement entre une
  archive et un upload.
- Toutes les règles de résilience du CLAUDE.md (disjoncteur, budgets, `_dz_api` / `_dz_live`) :
  elles concernent désormais moins de routes, pas moins de rigueur.

## D19. Enrichissement des métadonnées depuis des sources ouvertes

C'est la réponse à « importer quand même les infos pertinentes, depuis quelque chose de fiable ».
Un module neuf (`supysonic/enrich/`, hors de `supysonic/deezer/` puisqu'il sert aussi aux
uploads), event-driven comme le reste : un titre est mis en file à l'archivage ou à l'upload, un
seul worker traite la file au rythme imposé par chaque service, et un bouton + un CLI rattrapent
la bibliothèque existante (reprise sur checkpoint, causes d'échec comptées, comme les autres
backfills).

Sources retenues (conditions relevées sur leur documentation le 18/10/2026) :

| Source | Ce qu'on en tire | Conditions | Fiabilité |
|---|---|---|---|
| **MusicBrainz** (`/ws/2/`) | Identifiant de l'enregistrement, date de première sortie, date et label de la sortie, crédits (compositeur, parolier, producteur…), ISRC | Pas de clé ; **1 requête/s par IP en moyenne** (au-delà, 503 pour toute l'IP) ; User-Agent obligatoire au format `NSupySonic/<version> ( contact )` ; données principales en **CC0** ; usage non commercial gratuit | La référence ouverte, éditée par une communauté avec relecture. Couverture excellente sur la pop, le rock et les grands labels, plus inégale sur les scènes hard dance : à mesurer sur la bibliothèque. |
| **AcoustID** (`api.acoustid.org/v2/lookup`) | Identification **par l'audio lui-même** (empreinte Chromaprint calculée avec `fpcalc` sur le FLAC) → identifiant MusicBrainz de l'enregistrement, ISRC | **Clé d'application** gratuite (à fournir par l'opérateur, comme l'ARL, jamais committée) ; **3 requêtes/s** maximum ; **usage non commercial uniquement** | La seule méthode qui ne dépend d'aucune métadonnée : elle reconnaît le fichier, ce qui en fait le meilleur recours pour les uploads mal tagués et pour vérifier une correspondance douteuse. |
| **LRCLIB** | Paroles synchronisées ou brutes (D11) | Pas de clé, déjà utilisé dans `lyrics.py` | Base ouverte participative ; la recherche par durée évite la plupart des mauvaises versions. |
| **Cover Art Archive** | Pochette en haute définition quand on n'en a pas (upload sans image) | Pas de limite de débit annoncée ; licence des images à vérifier avant de s'en servir | Liée à MusicBrainz, donc exacte quand l'identifiant l'est. Optionnel : la pochette Deezer reste la source par défaut des archives. |
| Discogs | Label, numéro de catalogue, dates pour les sorties vinyle et les petits labels | Jeton obligatoire pour avoir le débit haut : 60 req/min authentifié, 25 sinon ; une partie des données seulement en CC0 | Très bonne sur l'électronique indépendante, mais rapprochement plus fragile (pas d'ISRC). **Choix par défaut** : pas dans la première version, à ajouter si MusicBrainz couvre mal la bibliothèque. |

Comment on retrouve l'enregistrement, du plus sûr au moins sûr :
1. **ISRC** gardé à l'archivage (ou lu dans les tags d'un upload) → `GET /ws/2/isrc/<isrc>` ; un
   ISRC peut pointer plusieurs enregistrements, on garde celui dont la durée et l'artiste
   collent.
2. **Empreinte AcoustID**, quand il n'y a pas d'ISRC ou que l'ISRC est ambigu, si l'opérateur a
   fourni une clé.
3. **Recherche** par titre + artiste + durée (± 3 s), acceptée seulement si le titre réduit
   (`_core_title` existe déjà pour ça) et l'artiste principal concordent exactement.

Rien n'est écrit sans correspondance sûre : mieux vaut un champ vide qu'une date fausse. Chaque
valeur garde sa source et sa date dans le sidecar, une valeur venant des tags d'un upload n'est
jamais écrasée, et une correspondance se ré-essaie après un délai (une entrée MusicBrainz peut
être créée plus tard). Ni l'archivage, ni la lecture, ni aucun algorithme n'attendent ce module, et
il obéit aux mêmes règles de résilience que les appels Deezer (délai par défaut, disjoncteur par
hôte, un échec réseau n'est jamais un verdict sur le titre).

À découper en PR : (a) le socle (file, worker, sidecar `enrich`, MusicBrainz par ISRC) ; (b) la
recherche par titre et l'empreinte AcoustID ; (c) les dates (D12) et les crédits (D10) branchés
dessus ; (d) le rattrapage de la bibliothèque et l'écran de suivi dans Réglages.

Fini quand : sur la bibliothèque réelle, le job rapporte la part des titres enrichis par source et
par méthode de rapprochement, et une vérification à la main d'un échantillon ne trouve pas de
mauvaise correspondance.

---

## Ordre conseillé

1. **D1, D2, D3** : couper toutes les écritures vers Deezer. Indépendants les uns des autres,
   petits, et c'est la partie demandée explicitement.
2. **D4, D5** puis **D16** : couper la synchronisation entrante.
3. **D9, D11, D13** : remplacer chaque donnée pré-calculée par la nôtre (indépendants), et
   **D19** en parallèle : l'enrichissement depuis MusicBrainz, AcoustID et LRCLIB.
4. **D10, D12** sur D19, puis **D8** : réduire ce qui est écrit sur disque et migrer l'existant.
5. **D14** puis **D15** : l'identité unique, puis les pages.
6. **D6** (en trois PR) et **D7** : remplacer les algorithmes.
7. **D17** : le ménage final.

Décisions à confirmer par le propriétaire (un choix par défaut est indiqué dans chaque section) :
numéro de piste / disque (tableau en tête), sort des playlists « Deezer · » existantes (D5), écran
Explorer (D7), paroles Deezer déjà archivées et Deezer en dernier recours pour les paroles (D11),
dates Deezer existantes (D12), Discogs (D19). La date de sortie et les paroles, elles, sont
importées : c'est tranché.
