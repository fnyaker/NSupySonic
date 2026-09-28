# TODO

Fonctions de Spotify et d'Apple Music qui manquent encore à NSupySonic, classées par difficulté
d'ajout. `[x]` = fait, `[ ]` = à faire. Les notes sous chaque ligne disent sur quoi s'appuyer dans
le code.

> Subsonic est désormais une fonction secondaire : le lecteur web (`/app`) est la référence. On ne
> se contraint plus à rester compatible avec le modèle Subsonic quand une fonction demande de
> s'en écarter (dossiers de playlists, historique, etc.).

---

## Niveau 1 — quelques heures, surtout côté interface

- [x] **Modifier la file d'attente** — réordonner par glisser-déposer, vider la file.
  Le store `player` n'a que `removeAt`, `playNext`, `addToQueue` : il manque `move` et `clear`.
  Le glisser-déposer existe déjà dans `Playlist.svelte` (mode édition). La file est une liste
  virtualisée (`VirtualList`) : le glisser doit fonctionner sans monter toutes les lignes.
- [x] **Minuteur de sommeil** — arrêt après N minutes, ou à la fin du titre / de l'album en cours,
  avec un fondu sur les dernières secondes. À porter par le store `player` pour que la
  télécommande (`lib/remote`) et le lecteur natif Android restent cohérents.
- [x] **Vitesse de lecture pour les podcasts** — 0,5× à 3×, mémorisée par émission. Le lecteur
  lit `playbackRate` mais ne le règle jamais. Penser à `preservesPitch`, aux marqueurs et à la
  reprise de position (les positions sont en secondes de média, pas en temps réel).
- [ ] **Mono et balance gauche/droite** — accessibilité. Un `StereoPanner` et une sommation mono
  dans `lib/audio/graph.js` ; réglages dans `AudioEffects.svelte`. Attention à la chaîne
  d'analyse rythmique : elle doit continuer à voir le signal stéréo d'origine.
- [ ] **Mode voiture** — écran plein format, très gros boutons (précédent / lecture / suivant,
  file, favori), lisible d'un coup d'œil et sans geste fin.
- [ ] **Panneau « sous le lecteur »** — dans le lecteur plein écran, glisser vers le haut fait
  monter une page (fait pour les titres similaires et l'artiste ; les crédits attendent
  les crédits complets) :
  - [x] titres similaires (via l'API Deezer aujourd'hui — `/radio/track/<id>` ; à terme via nos
    propres embeddings, voir « Lecture aléatoire intelligente ») ;
  - [x] à propos de l'artiste (photo, fans, titres populaires, artistes similaires — l'API
    publique de Deezer ne donne pas de biographie) ;
  - [ ] crédits du titre, quand les crédits complets seront là.

## Niveau 2 — une journée, un petit endpoint ou un petit écran

- [x] **Mode exploration** (Spotify « Parcourir », Apple « Explorer ») — classements, genres,
  ambiances. `deezerpy` sait déjà faire `get_chart*`, `get_genres`, `get_channels`,
  `get_editorial*` ; il manque l'endpoint `/api` et l'écran.
- [ ] **Radios** — stations par genre. `get_radios_genres` et `get_genre_radios` existent côté
  client ; à brancher sur la file (comme `/radio/track`).
- [ ] **Vrai historique d'écoute** — un journal de chaque écoute (titre, date, durée écoutée,
  contexte), pas seulement `play_count` / `last_play`. **Prérequis du Récap** (niveau 3) : à faire
  avant, et à faire proprement (nouvelle table, migration `SCHEMA_VERSION`, purge possible).
  Écran « Historique » dans la bibliothèque.
- [ ] **Crédits complets** (compositeur, producteur, paroles…) — si la source le permet. Les rôles
  sont déjà dans le `<titre>.json` archivé à côté de chaque fichier ; il manque l'endpoint et le
  panneau. À vérifier : que le sidecar les porte bien pour tous les titres, sinon les demander à
  `song.getData`.
- [ ] **Phrase de paroles en carte image** — choisir une ou plusieurs lignes des paroles
  synchronisées et en tirer une image à partager (pochette + couleurs dérivées + texte). Rendu
  canvas dans le `ShareSheet` existant, à partir du `.lrc`.
- [ ] **Titres recommandés en bas d'une playlist** — suggestions à ajouter en un tap, à partir de
  la playlist entière comme graine. À terme via les embeddings locaux.

## Niveau 3 — quelques jours, avec migration de base de données

- [ ] **Récap** (type Spotify Wrapped / Apple Replay) — top titres, artistes, genres, minutes
  écoutées, par mois et par année, en « stories ». **Dépend du vrai historique d'écoute**
  (niveau 2). Les genres et le tempo déjà mesurés par le serveur donnent des statistiques plus
  riches que celles des services commerciaux.
- [ ] **Dossiers de playlists** — regrouper les playlists dans la barre latérale et la
  bibliothèque. Table locale (ni Deezer ni Subsonic n'ont ce concept), ordre libre.
- [ ] **Lien public en lecture seule vers une playlist** — même modèle de capacité que les liens
  de la listen party et du contrôle à distance (identifiant opaque, jeton signé, ne donne accès
  qu'à ce que le propriétaire a publié : la playlist, ses pochettes, ses extraits). À cadrer :
  ce qu'un invité peut écouter de Deezer.
- [ ] **Import de playlists** — depuis un lien ou un fichier, correspondance des titres par ISRC
  puis par artiste + titre, avec un écran de revue des titres non trouvés :
  - [ ] Spotify
  - [ ] Apple Music
  - [ ] Deezer (lien de playlist publique, en plus de l'import CLI existant)
  - [ ] YouTube / YouTube Music

## Niveau 4 — une à deux semaines, vraie conception

- [ ] **Lecture aléatoire intelligente** — intercaler des recommandations dans une lecture
  aléatoire, sans casser l'ambiance. **À faire quand le moteur de classification de genres est
  solide** (ou qu'un modèle est bien entraîné) : sans verdict fiable, l'aléatoire « intelligent »
  ne vaut pas mieux que l'aléatoire.
- [ ] **Mix par ambiance** (type Daylist) — mixes selon le moment de la journée, l'humeur, le
  tempo. Même prérequis : embeddings, BPM, genre et construction du morceau doivent être fiables.
  Sert aussi à remplacer l'API Deezer pour les titres similaires.
- [ ] **Playlists collaboratives** — *mis de côté.* Plusieurs comptes qui écrivent dans une même
  playlist. La difficulté est la synchronisation avec le miroir Deezer (`push.py`, réservé à
  l'admin) et les droits d'écriture.
- [ ] **Chapitres et transcription de podcasts** — chapitres quand l'épisode en porte
  (ID3 `CHAP`, ou `podcast:chapters`), transcription en texte avec recherche. Les épisodes
  arrivent de Deezer en MP3 brut, sans flux RSS : à voir d'où viennent les chapitres. La
  transcription demande un modèle de reconnaissance vocale.

---

## Écarté ou à réévaluer

Non retenu pour l'instant, à rediscuter si l'envie revient :

- Recherche dans les paroles, traduction des paroles, mode karaoké (atténuation de la voix).
- Concerts et dates de tournée (API tierce, clé et quotas).
- Vidéos musicales, Canvas : Deezer ne fournit aucune vidéo.
- Audio spatial / Dolby Atmos, Hi-Res 24 bits : le plafond de la source est le FLAC 16 bits.
- DJ vocal par IA, playlists générées par prompt.
- Android Auto (navigation dans la bibliothèque), livres audio.
