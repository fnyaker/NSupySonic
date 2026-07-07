# Plan — audit de bugs : app Android + web UI

> **Statut : audit terminé, corrections à faire.**
> Relecture complète de `webapp/src` (SPA Svelte), `webapp/public/sw.js` (PWA),
> `supysonic/webui/` (backend `/api` + SPA serving) et `android/` (app native +
> `nsshim.js`). Chaque entrée donne le symptôme, la cause (fichier:ligne) et le
> correctif proposé. Priorités : **P1** = cassant / fort impact utilisateur,
> **P2** = bug fonctionnel réel, **P3** = robustesse / cas limite / UX mineure.
> Règle du repo : tout correctif côté `/api` ou proxy s'accompagne d'un test
> (`tests/test_webui.py`) ; côté SPA/Android, vérification manuelle décrite.

---

## P1 — cassants / fort impact

### 1.1 [web] Le bouton plein écran du mini-player est caché sur mobile (sélecteur CSS mort)

- **Symptôme** : sur téléphone, la barre du bas ne montre plus aucun bouton du
  cluster « extras » — y compris le bouton plein écran que le commentaire CSS
  dit explicitement vouloir garder (« le bouton plein écran doit rester
  accessible »).
- **Cause** : `webapp/src/components/Player.svelte:1403` — la media query
  mobile fait `.extra > :not(.fs) { display: none; }`, mais **aucun élément ne
  porte la classe `fs`** ; le bouton plein écran a les classes `sm max`
  (`Player.svelte:1124`). Tout est donc masqué.
- **Correctif** : remplacer `:not(.fs)` par `:not(.max)` (et vérifier le `gap`
  de `.extra` une fois le bouton visible). Aujourd'hui seul le tap sur la zone
  « en lecture » ouvre le plein écran — le bouton prévu doit revenir.

### 1.2 [web/PWA] Le service worker met en cache des réponses d'erreur → app brickée

- **Symptôme** : après un seul 502/504 transitoire (reboot serveur, proxy) sur
  un asset hashé, l'app ne charge plus jamais (asset en *cache-first*, l'erreur
  est servie pour toujours). Une navigation qui tombe sur un 404/503 (ex. page
  « Web UI not built » en 503) peut aussi être enregistrée comme *shell* et
  servie hors-ligne indéfiniment.
- **Cause** : `webapp/public/sw.js:73-79` (assets : `c.put(request, copy)` sans
  vérifier `res.ok`) et `sw.js:88-91` (navigations : `c.put("/app/", copy)`
  sans vérifier `res.ok`). `Cache.put` stocke volontiers les 404/5xx.
- **Correctif** : ne mettre en cache que si `res.ok` (voire `res.status === 200`
  pour exclure les réponses partielles) dans **les trois** branches fetch
  (assets, navigations, autres GET). Bump `CACHE` en `nsupysonic-shell-v4` pour
  purger les caches empoisonnés existants.

### 1.3 [web] Impossible de se déconnecter sur mobile

- **Symptôme** : le seul bouton « Déconnexion » vit dans la sidebar
  (`Sidebar.svelte:100`), qui est `display: none` sous 640 px
  (`Sidebar.svelte:114-118`). La page Réglages n'a aucune section compte. Sur
  téléphone il n'existe donc aucun chemin de déconnexion.
- **Correctif** : ajouter une section « Compte » dans
  `webapp/src/routes/Settings.svelte` (nom d'utilisateur + bouton Déconnexion,
  même logique que `Sidebar.logout()` : `api.logout()` puis `user.set(null)`).

### 1.4 [app] Changer de serveur dans les réglages n'a aucun effet tant que l'app n'est pas tuée

- **Symptôme** : ouvrir les réglages depuis l'app (`openServerSettings` /
  bouton), changer l'hôte, valider → la WebView continue d'afficher l'ancien
  serveur. Le nouveau réglage n'est pris en compte qu'après avoir tué la tâche.
- **Cause** : `MainActivity` est `launchMode="singleTask"`
  (`AndroidManifest.xml:39`) ; `SetupActivity.proceed()`
  (`SetupActivity.kt:87-91`) fait `startActivity(MainActivity)` qui **réutilise
  l'instance existante** ; `onNewIntent` n'est pas surchargé et rien ne
  recharge `prefs.appUrl()`.
- **Correctif** : surcharger `onNewIntent()` dans `MainActivity` et recharger
  l'URL si `prefs.appUrl()` ≠ URL courante (ou plus simple : flag extra
  « settings-changed » posé par SetupActivity → `webView.loadUrl(prefs.appUrl())`).

---

## P2 — bugs fonctionnels

### 2.1 [web] Hors-ligne, les fichiers « locaux » (serveur) sont considérés comme jouables

- **Symptôme** : en mode avion, lancer une liste contenant des fichiers locaux
  (importés côté serveur) les met en file alors qu'ils streament depuis le
  serveur → échec de lecture / parking réseau, exactement ce que le filtre
  devait éviter.
- **Cause** : `webapp/src/lib/playfilter.js:15-17` — `available()` inclut
  `t.local`, mais « local » = disque **du serveur**, pas de l'appareil.
- **Correctif** : `available = isDownloaded(id) || isCached(id)` uniquement.

### 2.2 [web] Cœur « favori » jamais initialisé sur les pages Album / Artiste

- **Symptôme** : un album/artiste déjà en favoris s'affiche cœur vide ; le
  premier clic « ré-ajoute » (toast « Ajouté ») au lieu de retirer. Impossible
  de connaître ou corriger l'état réel.
- **Cause** : `webapp/src/routes/Album.svelte:17` et `Artist.svelte:17` —
  `fav = false` en dur ; le backend ne renvoie pas `is_favorite` pour ces
  entités (`supysonic/webui/__init__.py:_album/_artist/_album_api/_artist_api`),
  contrairement aux playlists (`_playlist` lit `IS_FAVORITE`).
- **Correctif** : backend — exposer `is_favorite` sur `/api/album` (la page gw
  `pageAlbum` renvoie `FAVORITE`/`IS_FAVORITE` dans DATA ; sinon croiser avec
  les favoris du compte) et `/api/artist` (gw `artist.getData` ou liste des
  artistes suivis) ; front — initialiser `fav` depuis la réponse. Test dans
  `tests/test_webui.py` (MockGW).

### 2.3 [web] Le menu contextuel d'un épisode de podcast propose des actions cassées

- **Symptôme** : depuis le player (barre ou plein écran), le menu « ⋯ » d'un
  épisode propose « Ajouter aux favoris » (→ 400, rollback + toast erreur),
  « Lancer la radio » (→ erreur), « Ajouter à une playlist » (échec),
  « Aller à l'artiste/l'album » (→ « Artiste introuvable ») : l'épisode a un
  `deezer_id` UUID que ces endpoints ne connaissent pas.
- **Cause** : `webapp/src/lib/actions.js:buildTrackMenu` ne distingue pas les
  épisodes (le backend les marque pourtant `podcast: true`,
  `supysonic/webui/__init__.py:1388`).
- **Correctif** : dans `buildTrackMenu` (et `Player.trackMenu`), si
  `track.podcast` → menu réduit : Lire ensuite / Ajouter à la file /
  Télécharger / Ouvrir le podcast (`/podcast/<channel_id>`).

### 2.4 [web] Durées ≥ 1 h affichées « 92:15 » (pas de format heures)

- **Symptôme** : épisodes de podcast (souvent > 1 h), total d'une playlist ou
  d'un album long : `fmtDuration` affiche des minutes > 60.
- **Cause** : `webapp/src/lib/format.js:1-6` ne gère que mm:ss.
- **Correctif** : format `h:mm:ss` quand `sec >= 3600`. Impacte
  `Show.svelte:137`, les totaux `Playlist/Album/Mix`, les seek bars (durée
  affichée), `TrackRow`.

### 2.5 [web] Un échec de chargement des playlists est mis en cache définitivement

- **Symptôme** : si le premier `GET /me/playlists` échoue (boot hors-ligne,
  serveur pas encore prêt), la sidebar / le picker / l'onglet « Mes playlists »
  restent vides même une fois le réseau revenu — jusqu'à ce qu'une édition de
  playlist invalide le cache par hasard.
- **Cause** : `webapp/src/lib/actions.js:65-74` — le `catch` fait
  `playlistCache = []`, mémorisant l'échec comme résultat valide (la sidebar
  rappelle `userPlaylists()` à chaque navigation mais reçoit le cache).
- **Correctif** : en cas d'erreur, retourner `[]` **sans** renseigner
  `playlistCache` (le prochain appel refetch).

### 2.6 [api] `/api/flow` et `/api/radio/track/<id>` peuvent répondre 500 brut

- **Symptôme** : Deezer injoignable → ces deux routes lèvent (aucun try/except,
  contrairement à toutes les routes voisines) → 500 HTML Flask au lieu d'un
  JSON d'erreur propre ; le front (autoplay/radio, `ensureUpcoming`) encaisse,
  mais les logs serveur se remplissent de stacktraces non maîtrisées.
- **Cause** : `supysonic/webui/__init__.py:1110` (`provider.get_flow()`) et
  `:1195` (`provider.get_track_mix(track_id)`).
- **Correctif** : try/except → `502 {"error": ...}` (ou `{"tracks": []}` pour
  flow). Tests MockGW en erreur.

### 2.7 [api] La synchro manuelle peut tourner en même temps que la synchro planifiée

- **Symptôme** : `/api/sync` pendant la fenêtre de sync du scheduler (boot +20 s
  ou 04:00) → **deux** `DeezerImporter.sync` concurrents (doublons de travail,
  risques d'écritures concurrentes) ; et `/api/sync/status` répond
  `running: false` pendant une sync auto (spinner UI incohérent).
- **Cause** : le verrou de `supysonic/webui/__init__.py:1848-1881` ne couvre
  que le thread manuel ; `supysonic/deezer/scheduler.py:_run_sync/_loop` n'a
  aucun verrou partagé.
- **Correctif** : un `threading.Lock` (ou flag) module-level dans
  `scheduler.py` acquis par `_run_sync` (non bloquant : skip si déjà en cours),
  utilisé aussi par `/api/sync` et reflété par `/api/sync/status`.

### 2.8 [api] Les favoris admin ignorent `push_to_deezer` et perdent les étoiles non poussées

- **Symptôme** : (a) même avec `push_to_deezer = false`, un favori posé depuis
  la web UI écrit dans le compte Deezer ; (b) pour l'admin,
  `/me/favorite-ids` + `/me/favorites` ne lisent que Deezer quand il répond —
  une étoile locale dont le push a échoué (ou désactivé) disparaît des cœurs
  et de la bibliothèque.
- **Cause** : `supysonic/webui/__init__.py:1583-1591` (pas de check config) ;
  `:1280-1293` et `:1323-1338` (la branche live ignore les `StarredTrack`
  Deezer de l'admin).
- **Correctif** : honorer `push_to_deezer` dans `/api/favorite` ; côté lecture,
  fusionner les ids/tracks Deezer étoilés en DB avec la liste live (dédup par
  id). Tests.

### 2.9 [app] `Prefs.baseUrl()` casse les URLs avec chemin (reverse-proxy sous sous-chemin)

- **Symptôme** : hôte saisi « mondomaine.tld/musique » + port « 5722 » →
  `https://mondomaine.tld/musique:5722` (port collé après le chemin, URL
  invalide). Le port n'est pas non plus ajouté si le **chemin** contient « : ».
- **Cause** : `android/app/src/main/java/org/nsupysonic/app/Prefs.kt:29-35` —
  détection du port par `substringAfter("://").contains(":")` sur toute la
  chaîne, et concaténation en fin de chaîne complète.
- **Correctif** : parser via `android.net.Uri`/`java.net.URI` (schéma, host,
  port, path séparés) et reconstruire `scheme://host[:port][path]`.

### 2.10 [app] Les réglages sont écrasés avant validation dans SetupActivity

- **Symptôme** : ouvrir les réglages, faire une faute de frappe dans l'hôte,
  taper « Se connecter » → échec de la sonde → choisir « Réessayer » puis
  quitter (back) : les **mauvais** réglages sont déjà persistés ; au prochain
  lancement l'app pointe sur l'hôte cassé.
- **Cause** : `SetupActivity.kt:62-64` — `prefs.host/port/verifySsl` écrits
  avant la sonde, `proceed()` ne fait que `configured = true`.
- **Correctif** : sonder avec des valeurs temporaires (surcharge de
  `probe(url)` construite à partir des champs) et ne persister qu'au
  `proceed()`.

### 2.11 [app] Crash possible `ForegroundServiceStartNotAllowedException`

- **Symptôme** : appuyer sur lecture et mettre l'app en arrière-plan dans la
  seconde (le premier état « playing » arrive throttlé ~1 s par le shim) →
  `startForegroundService` depuis le background (Android 12+) → crash.
- **Cause** : `MainActivity.kt:231` — l'appel n'est pas protégé (contrairement
  à `PlayerService.goForeground` qui, lui, catch).
- **Correctif** : try/catch autour de `startForegroundService` dans
  `handleState` ; en cas d'échec garder `serviceStarted = false` pour retenter
  au prochain état (app revenue au premier plan).

---

## P3 — robustesse, cas limites, UX mineure

### Web UI

- **3.1 Fantôme audio si la piste courante quitte la file** —
  `stores.js:471-481` (`removeAt`) laisse `playing: true` avec `index: -1`, et
  `Player.svelte:355` n'a aucune branche « `$current` devenu null » (l'élément
  audio continue de jouer, l'UI affiche « Rien en lecture »). Aujourd'hui
  inatteignable depuis l'UI (le bouton retirer n'existe que pour `i > idx`,
  `NowPlaying.svelte:69-71`), mais tout futur appelant déclenchera le bug.
  Correctif : `removeAt` coupe `playing` quand la file se vide + teardown dans
  Player quand `$current` est null (`pause()` + `removeAttribute("src")` +
  `curId = null`).
- **3.2 AudioContext suspendu = lecture muette indétectable** — une fois le
  visualiseur ouvert, `visualizer.js` route tout l'audio via un
  `MediaElementSource` permanent (`analyserWanted` jamais remis à false). Si
  l'OS suspend l'AudioContext (onglet mobile en arrière-plan, iOS), l'élément
  « joue » (currentTime avance, le watchdog ne voit rien) mais le son est coupé
  jusqu'au retour au premier plan. Correctif minimal : dans `Player.onTime`,
  si `ctx.state === "suspended"` → `resumeAudio()` ; documenter la limite.
- **3.3 `playQueue(tracks, start)` : l'index visé glisse après `clean()`** —
  `stores.js:366-374` — `startTrack` est choisi **après** filtrage des entrées
  sans `deezer_id` : si la liste affichée en contenait, le tap lit le mauvais
  titre. Correctif : capturer `tracks[start]` avant `clean()`.
- **3.4 Crash au clic artiste sur un album sans artiste** —
  `Album.svelte:80` : `data.album.artist.deezer_id` sans `?.` (le libellé
  l'utilise juste en dessous). Correctif : garde `data.album.artist &&`.
- **3.5 Deep-link recherche : `decodeURIComponent` peut jeter** —
  `Search.svelte:21` — un `%` mal formé dans le hash crashe le composant.
  Correctif : try/catch autour du décodage.
- **3.6 BackButton absent de la page podcast** —
  `BackButton.svelte:18` : `DETAIL` ne contient pas `"/podcast/"` alors que
  `/podcast/:id` est une page de détail comme les autres.
- **3.7 Sidebar : « Rechercher » non surligné sur `/search/:q`** —
  `Sidebar.svelte:54` compare en égalité stricte (MobileNav fait un préfixe).
- **3.8 Raccourcis clavier actifs sur un `<select>`** — `App.svelte:127-131` ne
  garde que input/textarea/contentEditable : taper « s » dans le sélecteur de
  tri toggle le shuffle. Ajouter `select` à la garde.
- **3.9 Menu carte : « Ajouter aux favoris » toujours `on=true`** —
  `actions.js:322-334` — pas de retrait possible, et re-favoriter un favori
  affiche un faux succès. À croiser avec 2.2 (état réel).
- **3.10 `req()` : les headers passés par un appelant écrasent Content-Type** —
  `api.js:61-65` — `...opts` est spread **après** `headers:` ; latent (aucun
  appelant ne passe de headers aujourd'hui). Correctif : merger les headers en
  dernier.
- **3.11 Dernière écoute jamais rapportée à la fermeture** — `flushListen`
  n'est pas appelé sur `pagehide` (le `keepalive: true` de `reportListen` le
  permettrait pourtant). Perte de télémétrie uniquement.
- **3.12 « Télécharger la liste » compte 0 sur des listes 100 % locales** —
  `TrackBrowser.downloadAll` envoie aussi les UUID locaux ; le backend les
  filtre → toast « Téléchargement de 0 titres lancé ». Filtrer côté client
  (`/^\d+$/`) et adapter le message.
- **3.13 Code mort** — `stores.js:601` (`upNext` exporté, jamais importé),
  `Icon.svelte:6-7` (`FILLED`/`filled` calculés, jamais utilisés dans le
  template). À supprimer.
- **3.14 [à discuter] PodcastCard : tout clic = abonnement** —
  `PodcastCard.svelte:29` — cliquer une carte de résultat s'abonne
  immédiatement (pas de prévisualisation possible). Si c'est voulu (pas de
  page show avant import), au minimum un `window.confirm` ou un libellé clair.

### Backend `/api`

- **3.15 Durcissement des entrées playlist** —
  `webui/__init__.py:1764` (`int(i)` → ValueError → 500 sur un index non
  numérique) et `:1692` (`title.strip()` → AttributeError si `title` n'est pas
  une chaîne). Valider et répondre 400.
- **3.16 `/api/sync/status` visible admin uniquement** : cohérent, mais le
  front appelle `syncStatus()` en boucle après `sync()` — si la session admin
  expire pendant le poll, `runDeezerSync` résout sur le 401 (ok). Rien à faire,
  noté pour mémoire.

### App Android / shim

- **3.17 Notification zombie sur bouton média parasite** — casque/BT « play »
  alors que l'app est fermée → `MediaButtonReceiver` démarre `PlayerService`,
  `onStartCommand` fait `goForeground()` (`PlayerService.kt:144-147`) →
  notification « NSupySonic » inerte (commandSink null, WebView morte).
  Correctif : si `state == null && commandSink == null`, satisfaire le contrat
  (`startForeground`) puis `stopSelf()` immédiatement.
- **3.18 `shouldOverrideUrlLoading` : préfixe trop permissif** —
  `MainActivity.kt:143` — `url.startsWith(prefs.baseUrl())` matche
  `https://host.tld.evil.com` quand `baseUrl` n'a pas de port/slash final.
  Comparer schéma + host + port parsés.
- **3.19 `MIXED_CONTENT_ALWAYS_ALLOW` inconditionnel** —
  `MainActivity.kt:102` — le contenu http sur page https est autorisé même
  quand l'utilisateur a laissé « vérifier SSL » coché. Le conditionner à
  `!prefs.verifySsl` (ou passer en `COMPATIBILITY_MODE`).
- **3.20 La notification n'est jamais nettoyée quand l'état devient inactif** —
  `MainActivity.handleState` (`:221`) et `PlayerService.update` (`:174`)
  ignorent `active == false` : après déconnexion / file vidée côté web, la
  notification garde les métadonnées du dernier titre (dismissible car en
  pause, mais trompeuse). Correctif : sur `active=false` après un état actif,
  `stopForeground(REMOVE)` + reset `notifKey`.

---

## Non-bugs vérifiés (pour mémoire)

- Le wakelock 4 h (`PlayerService.kt:355`) est bien ré-acquis : le shim publie
  ~1×/s pendant la lecture (throttle `nsshim.js:44`), donc l'expiration est
  couverte au prochain update.
- Rotation d'écran : `configChanges` couvre orientation/screenSize
  (`AndroidManifest.xml:40`) — pas de destruction de WebView en rotation.
- Icônes : tous les noms utilisés existent dans `Icon.svelte` (vérif croisée).
- Types d'ids : le backend renvoie systématiquement `deezer_id` en `str` ; les
  comparaisons strictes du front (`currentId === track.deezer_id`) sont sûres.
- Reorder/remove de playlist : la sérialisation FIFO + coalescing de
  `Playlist.svelte` est correcte (l'ordre en attente est bien flushé avant un
  remove, y compris en changeant de page).

---

## Ordre de bataille proposé

1. **Lot 1 (P1, rapide)** : 1.1 (CSS), 1.2 (sw.js + bump cache), 1.3 (logout
   Settings), 1.4 (onNewIntent). Petites diffs, gros impact.
2. **Lot 2 (P2 web)** : 2.1, 2.4, 2.5, 3.4, 3.5 (pur front) puis 2.2 et 2.3
   (front + petites évolutions `/api` + tests `test_webui.py`).
3. **Lot 3 (P2 api)** : 2.6, 2.7, 2.8, 3.15 — avec tests MockGW/MockApi.
4. **Lot 4 (P2/P3 app)** : 2.9, 2.10, 2.11, puis 3.17–3.20 (build
   `gradle -p android assembleRelease` pour valider).
5. **Lot 5 (P3 web restants)** : 3.1–3.3, 3.6–3.13 au fil de l'eau.

Chaque lot = un commit (ou une PR) indépendant, testable isolément :
`python -m unittest tests.test_webui` pour le backend, `npm run build` +
vérification manuelle mobile/desktop pour la SPA, build Gradle pour l'app.
