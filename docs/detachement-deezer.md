# Se détacher de Deezer : Deezer comme pure source de sons

Objectif (demande du propriétaire, 18/10/2026) : Deezer ne doit plus être qu'un **fournisseur de
fichiers FLAC** et de **faits sur ces fichiers**. Un titre archivé depuis Deezer doit être, pour le
reste de l'application, **un fichier comme un autre, comme si l'utilisateur l'avait uploadé**. On
ne dépend plus des **algorithmes** de Deezer (Flow, mixes, radios, recommandations, classements),
et on arrête de synchroniser nos playlists et nos favoris vers le compte Deezer.

**Ce qu'on garde de Deezer, et ce qu'on cherche ailleurs** (précision du propriétaire, 18/10/2026).
La ligne de partage est la fiabilité :

- **Les faits déterministes, qui ne dépendent pas de la plateforme, viennent de Deezer** comme
  aujourd'hui : titre, album, artistes (et featurings), pochette, numéros de piste et de disque,
  **date de sortie**, ISRC, durée, label, crédits de l'enregistrement, et **le BPM quand Deezer en
  publie un** (utile comme étiquette pour entraîner et évaluer nos modèles).
- **Ce qui n'est pas fiable chez Deezer est cherché ailleurs** : les **paroles** (LRCLIB, D11), le
  **genre** (nos mesures et nos étiquettes, D13 — Deezer ne donne qu'un genre d'album très large),
  et ce que Deezer **calcule** plutôt qu'il ne constate, comme le gain (mesuré par nous, D9).
- **Nos algorithmes doivent fonctionner sans aucune de ces données** : la normalisation, le tempo,
  le genre, les recommandations donnent un résultat juste sur un upload qui n'a que son audio. Une
  donnée importée peut les aider quand elle est là ; elle n'est jamais une condition.

L'« IMDb de la musique » évoqué par le propriétaire existe : c'est **MusicBrainz**. Il est évalué
en D19, comme complément là où Deezer ne dit rien (les uploads surtout) et comme recoupement, pas
comme remplaçant des faits Deezer.

Ce document est un **inventaire**, pas une implémentation. Chaque section `D<n>` est un chantier
indépendant, qui peut devenir sa propre tâche et sa propre PR. Les dépendances entre chantiers
sont indiquées ; l'ordre conseillé est en fin de document.

## La performance d'abord : règle transversale

**Exigence du propriétaire (18/10/2026)** : se détacher de Deezer ne doit rien coûter en
réactivité. **Chaque clic de l'utilisateur est la priorité maximale et son action doit être faite
au plus vite.** Cette règle s'applique à tous les chantiers et elle passe avant les autres : un
chantier qui rend une action plus lente n'est pas fini, même s'il fait ce qu'il doit.

Ce que ça veut dire concrètement, pour chaque chantier :

1. **Le clic d'abord, le reste après.** Une action de l'utilisateur (étoiler, créer ou éditer une
   playlist, lancer un titre, ouvrir une page) fait son travail local et répond ; tout ce qui en
   découle (archivage, enrichissement, re-mesure) part en arrière-plan **après** la réponse.
   Retirer un appel à Deezer d'une route est l'occasion de la rendre plus rapide, pas seulement
   d'y mettre autre chose à la place.
2. **Aucun appel réseau tiers dans le fil d'une requête de l'utilisateur**, sauf quand l'action
   en a besoin par nature : jouer un titre pas encore archivé, une recherche de catalogue. Ni
   MusicBrainz, ni LRCLIB, ni AcoustID, ni Deezer pour une métadonnée.
3. **L'arrière-plan cède toujours la place.** Tout nouveau travail de fond (l'enrichissement de
   D19, les migrations de D8, la re-mesure du gain de D9, les voisins par embeddings de D6) passe
   par les mécanismes qui existent déjà pour ça : la file à priorités (`workload.Priority`, en
   `BULK`), `workload.renice`, `quiet_wait` tant qu'une action de l'utilisateur est en cours,
   `X-NS-Background` côté client, et au plus un quart des fils du serveur. Un job de fond ne tient
   jamais un fil de requête.
4. **L'interface répond avant le serveur.** Un clic se voit à l'écran dans la même image
   (mise à jour optimiste, comme `upsertPlaylistLocal` ou `resolvedUnavailable` aujourd'hui) ;
   une erreur serveur la défait ensuite.
5. **Mesuré, pas supposé.** Chaque chantier qui touche une route ou un écran relève ses chiffres
   avant et après avec les outils existants — `tools/perf_api.py` (temps médian, nombre de requêtes
   SQL et octets par route, sur une bibliothèque de 8 000 titres, Deezer coupé) et
   `webapp/test/ui/run.mjs` (temps du fil principal dans Chromium) — et les écrit dans la PR. Un
   test compte les requêtes SQL ou les appels réseau là où c'est possible (règle « compter, pas
   chronométrer » des tests existants).

Budgets communs, sauf mention contraire dans le chantier :
- **un clic se voit à l'écran en moins de 100 ms** (une image d'interface, rien n'attend le
  serveur) ;
- **une route locale ne devient jamais plus lente** que sa mesure actuelle par `perf_api.py`, et
  une route qui perd son appel à Deezer doit répondre au temps de sa version « Deezer coupé » ;
- **un titre archivé démarre aussi vite qu'aujourd'hui**, et aucun travail de fond ne doit se voir
  pendant qu'il démarre.

Chaque chantier ci-dessous se termine par une ligne **Latence** qui dit ce que la règle veut dire
pour lui.

## Ce que Deezer continue de faire

Pour que la liste ci-dessous soit lisible, voici la frontière visée :

| Reste chez Deezer | Pourquoi |
|---|---|
| L'ARL, la connexion, le jeton de média, le téléchargement et le déchiffrement du FLAC (`provider.py`, `deezerpy/`, `archive.ensure_archived`) | C'est la source des sons. |
| La **recherche de catalogue** (`/api/search`, côté Deezer) et la lecture d'une page album / artiste / playlist **pour trouver** des sons à récupérer | Il faut bien savoir quoi télécharger. Ces pages servent à choisir, pas à recommander. |
| La pochette d'album (téléchargée une fois, stockée en `cover.jpg`) | Un fait sur la sortie. |
| Titre, album, artistes et featurings (noms et ids), numéros de piste et de disque, durée | Des faits sur le fichier. |
| La **date de sortie**, l'**ISRC**, le label, le copyright, les crédits (`SNG_CONTRIBUTORS` : auteur, compositeur, producteur…) | Des faits, les mêmes sur toutes les plateformes. L'ISRC est en plus la clé la plus sûre vers MusicBrainz (D19). |
| Le **BPM publié par Deezer**, quand il existe | Gardé comme étiquette de référence (entraînement, évaluation, `bpm-audit`). Nos algorithmes savent s'en passer : Deezer n'en publie presque pas en hard dance (2 fichiers sur 3 462 ici). Voir D13. |
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

**Latence** : Créer, renommer, réordonner ou supprimer une playlist ne fait plus aucun aller-retour vers Deezer : la route répond après la seule écriture en base (aujourd'hui elle attend `gw.create_playlist`). Mesurer `POST /api/playlists` et `POST /api/playlist/<id>/tracks` avant et après ; la playlist apparaît dans la barre latérale dans l'image du clic.

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

**Latence** : Étoiler répond après une écriture en base, sans réseau ; l'archivage déclenché par le favori part après la réponse, en priorité `BULK`. Le cœur se remplit dans l'image du clic.

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

**Latence** : `/api/listen` et la sauvegarde de position des podcasts répondent sans réseau. Moins d'appels au total, donc moins de fils occupés pour les autres requêtes.

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

**Latence** : `/me/favorites` et `/me/favorite-ids` ne lisent plus que la base : elles doivent tomber au temps mesuré aujourd'hui Deezer coupé (19 ms pour les ids sur 4 000 étoiles d'après le CLAUDE.md). L'import ponctuel est un job de fond qui ne tient aucun fil de requête.

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

**Latence** : Rien à l'écran ; la synchro nocturne devient plus courte.

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

**Latence** : C'est le chantier le plus exposé. Les voisins par embeddings sont **précalculés** en arrière-plan (index mis à jour quand un vecteur arrive), jamais calculés pendant la requête : `/api/radio/...` et l'accueil répondent depuis la base en un temps comparable aux autres listes (`perf_api.py`). La suite automatique de la file est prête **avant** la fin du titre en cours, comme aujourd'hui (`ensureUpcoming` avec trois titres d'avance).

## D7. Explorer

État actuel : `/api/explore`, `/explore/genre/<id>`, `/explore/countries`, `routes/Explore.svelte` :
entièrement les classements et genres éditoriaux de l'API publique Deezer.

À faire : décision du propriétaire nécessaire, deux options :
1. **Choix par défaut** : retirer l'écran (et son lien dans `Sidebar.svelte` / `MobileNav.svelte`),
   l'exploration du catalogue passant par la recherche.
2. Le réécrire sur la bibliothèque locale (par genre servi, par décennie, par artiste).

Fini quand : l'écran n'existe plus, ou ne lit plus que la base.

**Latence** : Si l'écran est réécrit sur la base, il suit les budgets des autres listes ; s'il est retiré, rien.

## D8. Ce qu'on écrit sur disque à l'archivage : les faits, pas les calculs ni les jetons

État actuel :
- `metadata.meta_from_gw` + `tag_file` écrivent dans le FLAC : titre, artistes, album,
  albumartist, piste, disque, date, ISRC, **un ReplayGain dérivé du `GAIN` Deezer** (`TXXX`,
  `REPLAYGAIN_TRACK_GAIN`), paroles embarquées.
- `library.save_track_metadata` écrit `<track>.json` avec un bloc `gw` de `_KEEP_FIELDS` : `ISRC`,
  `GAIN`, `EXPLICIT_LYRICS`, `COPYRIGHT`, `LYRICS_ID`, `PROVIDER_ID`, `RANK_SNG`,
  `SNG_CONTRIBUTORS`, `LABEL_NAME`, dates de sortie…
- `library.refresh_track_metadata` « améliore » la ligne depuis `song.getData` (gain, année…).
- Le BPM Deezer n'est **pas** gardé sur disque : `analysis.tempo_hints` le met en cache un jour.

À faire :
- Garder dans les tags et le sidecar tous les faits du tableau en tête, **BPM Deezer compris**
  (dans le sidecar, sous un nom qui dit sa source : `deezer_bpm`, jamais dans le tag `BPM`, qui
  est celui que lisent les autres lecteurs et que notre mesure remplit, voir D13).
- Retirer ce qui est un **calcul ou un signal de plateforme** : le ReplayGain dérivé de `GAIN`
  (remplacé par notre mesure, D9), `RANK_SNG` (popularité Deezer), `PROVIDER_ID`, `LYRICS_ID`.
- Les paroles Deezer ne sont plus embarquées (D11).
- Migration de l'existant : un job (bouton + CLI, reprise sur checkpoint comme les autres
  backfills) qui met les sidecars et les tags des archives déjà présentes au nouveau format, sans
  retélécharger l'audio, et qui va chercher le BPM des titres qui n'en ont pas encore dans leur
  sidecar (une requête publique par titre, au rythme de la file de fond). Le tag est réécrit hors
  du fichier publié puis remplacé (même règle que `archive._tag_archive`).

Dépend de : D9 (gain), D11 (paroles).

Fini quand : une archive porte ses faits et rien de calculé par Deezer, et un upload tagué
proprement passe exactement par le même code.

**Latence** : La migration de l'existant tourne en `BULK`, `renice`, et se met en pause (`quiet_wait`) dès qu'une action de l'utilisateur est en cours ; un titre en cours de migration reste jouable. Le tag d'une archive est toujours écrit avant publication, jamais sous un fichier servi.

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

**Latence** : `/api/gains` ne répond plus que depuis la base (une requête), donc aussi vite qu'aujourd'hui Deezer coupé. La mesure du gain se fait dans la passe d'analyse déjà existante, sans ffmpeg supplémentaire.

## D10. Crédits : ceux de Deezer restent, sans aller les chercher en direct

État actuel : `supysonic/webui/credits.py` (`/api/track/<id>/credits`) lit `SNG_CONTRIBUTORS`,
`LABEL_NAME`, ISRC, copyright dans le sidecar, sinon **demande à Deezer** et réécrit le sidecar.
`NowPlayingMore.svelte` affiche le panneau.

Les crédits sont des faits : ils restent importés de Deezer. Ce qui change :
- ils sont pris **à l'archivage** (le payload `song.getData` les a déjà), donc la route n'a plus
  besoin d'appeler Deezer pour un titre archivé ;
- un upload lit les siens dans ses **tags** (compositeur, parolier, label…), et MusicBrainz (D19)
  peut compléter ce qui manque aux deux ;
- pour un titre pas encore archivé, l'appel à Deezer peut rester (c'est un fait, mis en cache).

Petit chantier, à faire avec D8.

**Latence** : Pour un titre archivé, `/api/track/<id>/credits` lit le sidecar et ne parle plus à personne : réponse en lecture de fichier.

## D11. Paroles : cherchées ailleurs que chez Deezer

Les paroles Deezer ne sont pas fiables (souvent absentes, parfois d'une autre version) : elles
font partie de ce qu'on cherche autrement.

État actuel : `supysonic/deezer/lyrics.py` cherche d'abord les paroles **de Deezer**
(`provider.get_lyrics`), puis LRCLIB ; `/api/lyrics/<id>` interroge Deezer en direct pour un titre
pas encore archivé ; les paroles sont embarquées dans les tags (`embed_lyrics`).

À faire :
- **LRCLIB** en première source (déjà utilisé en second choix, `lyrics.fetch_lrclib`) : base
  ouverte et sans clé, cherchée par titre, artiste, album et durée, ce qui la rend utilisable pour
  les uploads aussi (qui n'ont pas de paroles aujourd'hui). Les paroles synchronisées restent
  préférées au texte brut.
- Une version d'un titre (remix, live, edit) ne prend jamais les paroles d'une autre : la durée
  doit concorder à quelques secondes près.
- Mesurer la couverture sur la bibliothèque réelle (part des titres avec paroles synchronisées,
  brutes, ou rien) avant de décider s'il faut une autre source.
- Le CLI `deezer lyrics` devient `supysonic-cli lyrics`.

Rien ne dépend des paroles : la ligne de paroles du lecteur s'affiche quand il y en a, et aucun
algorithme ne les lit.

Décisions du propriétaire possibles, avec leur choix par défaut :
- Deezer en **dernier recours** quand LRCLIB n'a rien ? **Non**, à rouvrir si la couverture
  mesurée est trop faible.
- Retirer les paroles Deezer déjà archivées ? **Non**, un `.lrc` est un fichier à nous ; on le
  remplace seulement si LRCLIB a une version synchronisée et que celle de Deezer ne l'était pas.

Fini quand : le module ne lit plus de paroles chez Deezer.

**Latence** : Aucune requête LRCLIB dans le fil de `/api/lyrics` pour un titre archivé : les paroles sont cherchées à l'archivage, en arrière-plan, et la route lit le `.lrc`. Pour un titre pas encore archivé, une seule requête bornée (le délai par défaut) et « pas de paroles » plutôt qu'une attente.

## D12. Dates de sortie : celles de Deezer, complétées pour les uploads

La date de sortie est un fait : elle reste importée de Deezer (`PHYSICAL_RELEASE_DATE` /
`DIGITAL_RELEASE_DATE`, aujourd'hui réduite à l'année dans `Track.year` par `normalize_track`).

À faire :
- Garder la date **complète** (AAAA-MM-JJ, parfois seulement AAAA) en plus de l'année, pour
  l'affichage et le tri (migration de schéma) ; préférer la date physique quand elle est plus
  ancienne que la numérique (une réédition numérique tardive n'est pas la sortie).
- Un upload prend la date de ses tags, et MusicBrainz (D19) la complète quand il n'y en a pas.
- Option à évaluer avec D19 : la **date de première sortie** de MusicBrainz pour un titre qu'on a
  sur une compilation ou une réédition, où la date Deezer est celle de la compilation.

Aucun algorithme ne lit la date. Petit chantier.

**Latence** : Lire ou trier par date est une colonne en base : aucun coût. La migration de schéma ne bloque pas le démarrage plus que les migrations actuelles.

## D13. Tempo et genre : nos algorithmes savent s'en passer

État actuel (`supysonic/deezer/analysis.py`) :
- `tempo_hints` / `provisional_payload` : le BPM publié par Deezer est servi comme tempo
  **provisoire** au premier passage, avant que le fichier soit mesuré.
- `_deezer_bpm` + `_reconcile_tracked` : le BPM Deezer sert de **témoin d'octave** à la mesure
  (23/26 disques exacts sans le témoin, 26/26 avec, sur l'éval de `tools/tempo_eval.py`).
- `supysonic-cli deezer bpm-audit` compare le BPM Deezer à notre mesure, par style.
- Le genre ne vient jamais de Deezer : nos mesures, les étiquettes de l'utilisateur, le modèle du
  studio, et le genre écrit dans les tags d'un upload (`file_genre`, appliqué aux fichiers locaux
  seulement, parce que les archives Deezer portent le genre large de l'album).

Le BPM Deezer est un fait et reste importé ; le genre Deezer n'est pas fiable et reste ignoré. Ce
qui change :
- **Garder le BPM Deezer durablement** (sidecar et base, voir D8) au lieu d'un cache d'un jour, et
  l'**offrir au studio comme étiquette** : une colonne de référence pour évaluer et entraîner nos
  modèles de tempo et de genre (le studio lit aujourd'hui le tempo mesuré, `log2(bpm/120)`), avec
  sa source affichée.
- **Prouver que l'analyse s'en passe** : l'éval et les tests du tempo tournent aussi sans aucun BPM
  Deezer et les chiffres sont écrits à côté de ceux avec. Le témoin d'octave et le tempo
  provisoire restent, puisqu'ils aident quand le chiffre existe, mais ne doivent jamais être la
  seule chose qui rend un résultat juste.
- `bpm-audit` reste (c'est exactement l'outil qui dit si le chiffre de Deezer mérite confiance).
- Les archives ne portent pas le genre d'album Deezer (D8) ; `file_genre` peut alors s'appliquer à
  tous les fichiers, et ne lira que ce qu'un utilisateur a tagué lui-même.
- `references.py` / `/genre/references` / `/genre/sounds` utilisent la recherche Deezer pour
  **trouver** des enregistrements : c'est de la recherche de catalogue, ça reste.

Fini quand : le BPM Deezer est disponible au studio, et l'éval prouve, chiffres à l'appui, que
l'analyse est juste sans lui.

**Latence** : Le BPM Deezer gardé sur disque supprime la requête de `tempo_hints` au premier passage pour les titres déjà vus : moins de travail au démarrage d'un titre, jamais plus.

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

**Latence** : C'est un chantier de structure ; il ne doit coûter **rien** à l'exécution : même nombre de requêtes SQL par liste (les tests de `test_webui_lists.py` le comptent), même taille de réponse à quelques octets près, et la migration des données du navigateur se fait une fois, en arrière-plan, sans bloquer le premier écran. Vérifier avec `webapp/test/ui/run.mjs` (ouvrir les favoris, taper, trier) qu'aucun chiffre ne remonte.

## D15. Pages album, artiste et playlist : la base d'abord

État actuel : `/api/album/<id>` et `/api/artist/<id>` demandent d'abord **Deezer** et ne lisent la
base qu'en repli (« Deezer disabled/unreachable »). `/api/artist/<id>/tracks`,
`/artist/<id>/discography` : Deezer seulement. Une playlist Deezer non importée est lue en direct.

À faire : une entité présente en base est servie depuis la base (titres archivés ou référencés,
pochette locale) ; la page Deezer n'est demandée que pour **compléter** une entité du catalogue
qu'on n'a pas encore (afficher ce qu'on peut télécharger) ; on n'en garde que les faits du tableau
en tête, jamais ses rangées de recommandations. La discographie d'un artiste de la bibliothèque = ses albums en base, plus une
section « disponible sur Deezer » optionnelle.

Dépend de : D14 (les ids de page).

Fini quand : avec Deezer coupé, toute page d'une entité de la bibliothèque est identique à ce
qu'elle est Deezer allumé, hors section « disponible sur Deezer ».

**Latence** : Une page album ou artiste de la bibliothèque s'affiche depuis la base, sans attendre Deezer : son temps devient celui de la version « Deezer coupé » d'aujourd'hui. La section « disponible sur Deezer » se charge après, sans repousser le reste de la page.

## D16. Le planificateur ne synchronise plus le compte

État actuel : `supysonic/deezer/scheduler.py` lance chaque nuit `importer.sync` (playlists, favoris,
podcasts, recommandations), puis le balayage d'archivage `backfill.sweep_for`, puis le scan local.

À faire : une fois D4 et D5 faits, il ne reste que le rafraîchissement des épisodes de podcasts et
le scan local. `sweep_for` (filet de sécurité de l'archivage) reste mais ne se fonde plus sur le
contenu du compte Deezer, seulement sur ce qui est en base et pas encore sur disque. Les options
`sync_playlists`, `sync_favorites`, `import_*`, `smart_tracklists` disparaissent ; `sync_user`,
`sync_at`, `sync_interval` sont à renommer ou documenter pour ce qui reste.

Dépend de : D4, D5.

**Latence** : Le planificateur fait moins de travail ; ce qui reste suit la règle 3 (priorité `BULK`, pause pendant une action de l'utilisateur).

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

**Latence** : Moins de code chargé : vérifier que le bundle principal de la SPA ne grossit pas (`npm run build`), et qu'il diminue si des écrans sont retirés.

**Fait (lot I).** Les huit options (`push_to_deezer`, `report_listens`, `sync_playlists`,
`sync_favorites`, `import_new_releases`, `import_flow`, `import_new_albums`, `smart_tracklists`)
ne sont plus dans `config.py`, `config.sample`, `config/supysonic.conf.example`, `.env.example`,
`docker-compose.yml` ni `docker/entrypoint.sh` ; un ancien fichier qui les nomme est lu sans erreur
et elles sont ignorées (`tests/test_detach_i.py`). Supprimés : `deezer/push.py`,
`deezerpy/graphql.py`, les écritures du fournisseur et de `gw` (favoris, playlists, `log_listen`,
signets d'épisodes), les lectures du compte dont plus rien ne se sert (`get_user_radio`,
`get_smart_tracklist`, `get_module_page`, `get_user_albums/artists`, `get_my_favorite_tracks`),
`importer.sync_smart_tracklists/sync_flow/sync_new_albums/sync_recommendations`, les routes
`/api/flow/clusters`, `/api/smarttracklist/<id>`, `/api/recommendations`, leurs entrées de
`api.js` / `apicache.js` / `remote.py#POLICY` et le réglage « Personnaliser » du Flow
(`FlowTuner.svelte`). Les playlists « Deezer · … » déjà écrites par l'ancienne synchronisation
restent, comme des playlists ordinaires : rien n'est supprimé. Bundle principal de la SPA :
561,9 → 559,2 kB (193,8 → 192,9 kB en gzip).

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

**Latence** : Inchangé : ces chemins sont déjà ceux qui servent la musique, et c'est eux que la règle 3 protège.

**Garde-fou (lot I).** `tests/test_detach_guard.py` remplace le client Deezer par un espion, visite
chaque route de `/api` avec chacune de ses méthodes, et échoue si l'espion entend un appel hors de
la liste `ALLOWED` (son, recherche, pages de catalogue). Seule l'importation ponctuelle du compte
lit le compte, et par deux appels nommés. Ajouter un appel Deezer, c'est l'ajouter à cette liste
en justifiant qu'il récupère du son ou un fait de catalogue.

## D19. MusicBrainz, l'« IMDb de la musique » : évaluation et usage

C'est le complément pour ce que Deezer ne sait pas, surtout pour les **uploads**, qui n'ont que
leurs tags, et le recoupement des faits Deezer quand on doute. Un module neuf (`supysonic/enrich/`,
hors de `supysonic/deezer/` puisqu'il sert aussi aux uploads), en arrière-plan comme le reste : un
titre est mis en file à l'archivage ou à l'upload, un seul worker suit le rythme imposé par chaque
service, et un bouton + un CLI rattrapent la bibliothèque (reprise sur checkpoint, causes d'échec
comptées). Rien n'attend ce module.

Évaluation (conditions relevées sur leur documentation le 18/10/2026) :

| Source | Ce qu'on en tire | Conditions | Fiabilité |
|---|---|---|---|
| **MusicBrainz** (`/ws/2/`) | Identifiant stable de l'enregistrement, de l'œuvre et de la sortie ; date de première sortie ; label ; crédits (compositeur, parolier, producteur…) ; ISRC | Pas de clé ; **1 requête/s par IP en moyenne** (au-delà, 503 pour toute l'IP) ; User-Agent obligatoire au format `NSupySonic/<version> ( contact )` ; données principales en **CC0** ; usage non commercial gratuit ; recherche par ISRC (`/ws/2/isrc/<isrc>`) | C'est bien l'équivalent d'IMDb : une base encyclopédique éditée par une communauté avec relecture, où chaque entité a un identifiant permanent. Couverture excellente sur la pop, le rock et les grands labels, plus inégale sur les scènes hard dance : à mesurer sur la bibliothèque avant d'en faire plus. |
| **AcoustID** (`api.acoustid.org/v2/lookup`) | Identification **par l'audio lui-même** (empreinte Chromaprint calculée avec `fpcalc` sur le fichier) → identifiant MusicBrainz, ISRC | **Clé d'application** gratuite (à fournir par l'opérateur, jamais committée) ; **3 requêtes/s** maximum ; **usage non commercial uniquement** | La seule méthode qui ne dépend d'aucune métadonnée : le bon recours pour un upload mal tagué. |
| **LRCLIB** | Paroles (D11) | Pas de clé, déjà utilisé | Base ouverte participative ; la recherche par durée évite les mauvaises versions. |
| **Cover Art Archive** | Pochette pour un upload qui n'en a pas | Pas de limite de débit annoncée ; licence des images à vérifier | Exacte quand l'identifiant MusicBrainz l'est. |
| Discogs | Label, numéro de catalogue, sorties vinyle et petits labels | Jeton pour le débit haut : 60 req/min authentifié, 25 sinon ; une partie seulement des données en CC0 | Très bonne sur l'électronique indépendante, rapprochement plus fragile (pas d'ISRC). **Choix par défaut** : pas dans la première version. |

Rapprochement, du plus sûr au moins sûr : l'**ISRC** (de Deezer ou des tags) ; l'**empreinte
AcoustID** si l'opérateur a une clé ; une **recherche** titre + artiste + durée (± 3 s), acceptée
seulement si le titre réduit (`_core_title`) et l'artiste principal concordent exactement. Rien
n'est écrit sans correspondance sûre. Chaque valeur garde sa source dans le sidecar ; un fait venu
de Deezer ou des tags n'est jamais écrasé, MusicBrainz ne remplit que ce qui manque (exception
possible : la date de première sortie, D12).

À découper en PR : (a) le socle et MusicBrainz par ISRC, pour les uploads d'abord ; (b) l'empreinte
AcoustID et la recherche ; (c) le rattrapage de la bibliothèque, avec la mesure de couverture par
source.

Fini quand : le job rapporte la part des titres complétés par source et par méthode, et un
échantillon vérifié à la main ne contient pas de mauvaise correspondance.

**Latence** : L'enrichissement ne passe jamais devant un clic : un seul worker en `BULK`, `renice`, pause dès qu'un archivage de l'utilisateur ou une requête de premier plan est en cours, débit des services respecté (1 req/s pour MusicBrainz) **sans** jamais tenir un fil de requête pendant l'attente. Aucune route ne l'attend : une donnée pas encore enrichie s'affiche simplement vide, et apparaît à la visite suivante.

---

## Ordre conseillé

La règle de performance vaut pour chaque étape ; les chantiers qui **retirent** un appel réseau
d'une route (D1 à D4, D10, D15) sont aussi ceux qui rendent l'app plus rapide : ce sont les
premiers gains à aller chercher.

1. **D1, D2, D3** : couper toutes les écritures vers Deezer. Indépendants les uns des autres,
   petits, et c'est la partie demandée explicitement.
2. **D4, D5** puis **D16** : couper la synchronisation entrante.
3. **D9, D11, D13** : notre gain, les paroles hors Deezer, le BPM gardé comme référence
   (indépendants).
4. **D8** avec **D10** et **D12** : ce qui est écrit sur disque, et la migration de l'existant.
5. **D14** puis **D15** : l'identité unique, puis les pages.
6. **D6** (en trois PR) et **D7** : remplacer les algorithmes.
7. **D19** : MusicBrainz, quand le reste tient debout (c'est un complément).
8. **D17** : le ménage final.

Décisions à confirmer par le propriétaire (un choix par défaut est indiqué dans chaque section) :
sort des playlists « Deezer · » existantes (D5), écran Explorer (D7), paroles Deezer en dernier
recours et paroles déjà archivées (D11), date de première sortie MusicBrainz plutôt que celle de
Deezer pour les compilations (D12), Discogs (D19).
