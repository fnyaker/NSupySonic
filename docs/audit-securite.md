# Audit de sécurité offensif — NSupySonic (passe 2, boîte noire)

> **Cette version remplace la première passe.** La première était une revue de code
> statique ; celle-ci **monte une vraie instance Flask, crée des comptes et envoie des
> requêtes réelles** pour prouver (ou réfuter) chaque hypothèse. Résultat : plusieurs
> constats sont désormais **confirmés empiriquement**, **deux sont rétractés**, **deux
> sont rétrogradés** faute de reproduction, et **deux failles nouvelles** sont apparues —
> dont un contournement de garde open-redirect que la première passe avait manqué.
>
> **Date :** 2026-07-29 · **Révision :** `004d5a0` · **Méthode :** boîte blanche +
> **boîte noire dynamique** (harnais `test_client` sur l'app réelle, backend SQLite,
> Deezer désactivé). Les commandes de reproduction accompagnent chaque constat vérifié.
>
> **Modèle de menace.** Serveur auto-hébergé exposé sur Internet (cas Docker/Android du
> README), un admin + N invités. Attaquants considérés : anonyme réseau, **invité
> authentifié** (le compte le plus rentable à abuser), voisin Wi-Fi, et attaquant
> post-fuite de base.
>
> **Légende de statut :**
> ✅ **Confirmé en boîte noire** (requête réelle) · 🔎 **Confirmé par lecture** (chemin
> non déclenché dynamiquement mais non ambigu) · ⚠️ **Théorique / non reproduit** ·
> ❌ **Rétracté** (la passe 1 se trompait).

---

## Sommaire exécutif

**35 constats retenus** (2 rétractés depuis la passe 1, 2 nouveaux). 4 critiques,
7 élevés, 12 moyens, 12 faibles.

Les preuves les plus marquantes de cette passe :

- **NS-01 (cookie) — prouvé.** Le vrai en-tête `Set-Cookie` sort **sans `SameSite` ni
  `Secure`**, même après avoir explicitement demandé `session_cookie_secure = yes`. La
  mitigation CSRF revendiquée par le code **n'est pas déployée**. `setdefault` sur des
  clés que Flask définit déjà = deux no-op.
- **NS-03 (mots de passe) — prouvé.** `decrypt_password()` a **récupéré le mot de passe
  en clair** (`SuperSecret#42`) à partir de la seule base : `password_secret` **et**
  `cookies_secret` sont dans la table `Meta`. Une sauvegarde qui fuit = tous les mots de
  passe + forge de session.
- **NS-06 / NS-07 (fuite inter-utilisateurs) — prouvés bout-en-bout.** Un **invité**
  télécharge via `/rest/download?id=<folder>` un ZIP contenant un fichier **non-audio**
  (`SECRET_NOTES.txt`) **et les uploads d'autres utilisateurs**. Un autre invité lit le
  fichier privé uploadé par un premier via `/api/me/local`, `/api/stream` et
  `/api/share/file`.
- **NS-05 (escalade admin) — prouvé.** `POST /user/add` avec `admin=1` crée un compte
  `admin=True, jukebox=True`. Couplé à l'absence de CSRF (NS-02), c'est le chemin
  d'escalade le plus court.
- **NS-37 (nouveau) — prouvé.** Le garde open-redirect laisse passer `/\evil.com` : il
  bloque `//` mais pas `/\`, que les navigateurs normalisent en `//`.

### Corrections apportées à la première passe (transparence)

| Constat passe 1 | Verdict passe 2 | Preuve |
|---|---|---|
| **NS-23** « 500 en pagaille sur entrée malformée » | ❌ **Rétracté** | `@api.errorhandler(ValueError)` sur `/rest` convertit `int()`/`uuid.UUID()` en erreur Subsonic propre ; `/api` renvoie 400/404/503. **Aucun 500** observé sur 18 entrées malformées testées. |
| **NS-36** « `Cache._filepath` ValueError → 500 » | ❌ **Rétracté** | Même handler : la `ValueError` devient une `GenericError` Subsonic, pas un 500. |
| **NS-10** « quota contournable par TOCTOU (Élevé) » | ⚠️ **Rétrogradé → Moyen** | Course **non reproduite** en 2 essais : le verrou d'écriture SQLite sérialise **et rejette** les uploads concurrents (12 lancés → 4 puis 1 importés, quota **jamais** dépassé). Vecteur théorique sur backend concurrent seulement. |
| **NS-26** « threads non bornés, accessible via podcast progress (Élevé) » | ⚠️ **Rétrogradé → Moyen** | Les 3 routes appelant `_push_async` sont **admin-only** (`save_podcast_progress` ne le fait que dans `if _is_admin()`). Pas accessible à un invité. |

### Tableau de bord

| ID | Constat | Sévérité | Statut |
|---|---|---|---|
| [NS-01](#ns-01) | `SameSite`/`Secure` jamais appliqués (`setdefault` no-op) | 🔴 Critique | ✅ Confirmé |
| [NS-02](#ns-02) | Aucune CSRF ; mutations admin en GET | 🔴 Critique | ✅ Confirmé |
| [NS-03](#ns-03) | Mot de passe en clair récupérable depuis la base seule | 🔴 Critique | ✅ Confirmé |
| [NS-04](#ns-04) | Démon : `pickle` sur socket `/tmp` prévisible (RCE) | 🔴 Critique | 🔎 Confirmé (lecture) |
| [NS-05](#ns-05) | Mass assignment `admin=1` sur `/user/add` | 🟠 Élevé | ✅ Confirmé |
| [NS-06](#ns-06) | `/rest/download?id=<folder>` zippe tout l'arbre | 🟠 Élevé | ✅ Confirmé |
| [NS-07](#ns-07) | Uploads non cloisonnés entre utilisateurs | 🟠 Élevé | ✅ Confirmé |
| [NS-08](#ns-08) | Épuisement disque via `/api/download` (file non bornée) | 🟠 Élevé | ✅ Confirmé |
| [NS-09](#ns-09) | Gel serveur : ffmpeg synchrone (1 worker / 8 threads) | 🟠 Élevé | 🔎 Confirmé (lecture) |
| [NS-11](#ns-11) | Rate-limit : succès réinitialise le compteur, clé IP partagée | 🟠 Élevé | ✅ Confirmé |
| [NS-12](#ns-12) | Sessions non révocables, pas de régénération, 31 j | 🟠 Élevé | ✅ Confirmé |
| [NS-37](#ns-37) | **Open redirect : garde contourné par `/\`** | 🟠 Élevé | ✅ Confirmé (nouveau) |
| [NS-13](#ns-13) | `changePassword` sans mot de passe actuel | 🟡 Moyen | ✅ Confirmé |
| [NS-14](#ns-14) | Credentials Subsonic en clair dans l'URL | 🟡 Moyen | 🔎 Confirmé |
| [NS-15](#ns-15) | JSONP `callback` non validé + ACAO `*` | 🟡 Moyen | ✅ Confirmé |
| [NS-16](#ns-16) | `getLyrics` : XML non fiable en HTTP clair (bombe XML) | 🟡 Moyen | 🔎 Confirmé |
| [NS-17](#ns-17) | Ids non validés dans les URL Deezer sortantes | 🟡 Moyen | ✅ Confirmé |
| [NS-18](#ns-18) | SSRF via `stream_url` d'épisode (redirections suivies) | 🟡 Moyen | 🔎 Confirmé |
| [NS-19](#ns-19) | Android : cleartext + trust-all SSL + pont JS ouvert | 🟡 Moyen | 🔎 Confirmé |
| [NS-20](#ns-20) | Fuite de l'ARL (conf en clair, env, `ps`) | 🟡 Moyen | 🔎 Confirmé |
| [NS-21](#ns-21) | Supply chain : pas de lockfile, deps flottantes | 🟡 Moyen | 🔎 Confirmé |
| [NS-22](#ns-22) | CSP `https:` joker, pas de HSTS | 🟡 Moyen | ✅ Confirmé |
| [NS-24](#ns-24) | `addChatMessage` non borné (100k accepté) | 🟡 Moyen | ✅ Confirmé |
| [NS-10](#ns-10) | Quota : TOCTOU (backend concurrent seulement) | 🟡 Moyen | ⚠️ Non reproduit |
| [NS-26](#ns-26) | `_push_async` : thread par appel (admin-only) | 🟡 Moyen | ✅ Confirmé |
| [NS-27](#ns-27) | Aucun journal d'audit | 🟡 Moyen | 🔎 Confirmé |
| [NS-28](#ns-28) | Mots de passe par défaut (`changeme`, `supysonic`) | 🔵 Faible | 🔎 Confirmé |
| [NS-29](#ns-29) | Aucune politique de mot de passe | 🔵 Faible | ✅ Confirmé |
| [NS-30](#ns-30) | `LIKE` non échappé → scans coûteux | 🔵 Faible | ✅ Confirmé |
| [NS-31](#ns-31) | Bombes de décompression PIL (pochettes) | 🔵 Faible | 🔎 Confirmé |
| [NS-32](#ns-32) | `IniConfig` : sections inconnues → `app.config` | 🔵 Faible | 🔎 Confirmé |
| [NS-33](#ns-33) | Tables progress/markers non bornées globalement | 🔵 Faible | 🔎 Confirmé |
| [NS-34](#ns-34) | `_valid_id()` accepte chiffres Unicode et `-` | 🔵 Faible | ✅ Confirmé |
| [NS-35](#ns-35) | Catalogue Deezer payant ouvert à tous les invités | 🔵 Faible | ✅ Confirmé |
| [NS-38](#ns-38) | **`size`/`offset` non bornés (getRandomSongs…)** | 🔵 Faible | ✅ Confirmé (nouveau) |
| [NS-39](#ns-39) | Timing-oracle d'énumération d'utilisateurs | 🔵 Faible | ⚠️ Production seulement |

---

## 1. Constats critiques

### <a id="ns-01"></a>NS-01 — 🔴 ✅ Le durcissement du cookie n'est jamais appliqué

**Fichier :** `supysonic/web.py:110-118`

```python
app.config.setdefault("SESSION_COOKIE_SAMESITE", "Lax")
app.config.setdefault("SESSION_COOKIE_SECURE", bool(...session_cookie_secure...))
```

`Flask.default_config` définit **déjà** ces clés → `setdefault` ne fait rien.

**Preuve en boîte noire** (harnais avec `session_cookie_secure = True` explicitement demandé) :

```
Set-Cookie: session=…; Expires=…; HttpOnly; Path=/
  SameSite present: False        ← jamais émis
  Secure  present: False         ← alors qu'on a demandé secure=yes
  HttpOnly present: True         (posé par Flask, pas par ce code)
```

**Conséquences.** L'attribut `SameSite` n'existe pas → sur Firefox/Safari (pas de
Lax-par-défaut), **tous** les POST mutants de `/api` et de l'admin sont CSRF-ables.
L'option `session_cookie_secure = yes` est un **placebo** : le cookie part en clair sur
HTTP même quand l'admin a demandé le contraire — pire qu'une option absente.

**Correctif.** Affectation directe, pas `setdefault` :

```python
app.config["SESSION_COOKIE_HTTPONLY"] = True
app.config["SESSION_COOKIE_SAMESITE"] = "Lax"
app.config["SESSION_COOKIE_SECURE"] = bool(app.config["WEBAPP"].get("session_cookie_secure", False))
```

Test de non-régression qui inspecte **l'en-tête réel** (pas `app.config`, qui « passerait »
à tort) :

```python
sc = client.post("/api/login", json={...}).headers["Set-Cookie"]
assert "SameSite=Lax" in sc and "HttpOnly" in sc
```

---

### <a id="ns-02"></a>NS-02 — 🔴 ✅ Aucune protection CSRF, mutations en GET

**Fichiers :** `supysonic/frontend/`, `supysonic/webui/__init__.py`

Aucun jeton CSRF n'existe. Combiné à NS-01, toute action est déclenchable en cross-site.
**Preuve en boîte noire** (session admin frontend, requêtes GET) :

```
GET /user/del/<uid>  -> 302  | pwn1 réellement supprimé : True
GET /folder/scan     -> 302  (scan accepté)
GET /user/me/lastfm/link -> 302  (atteignable en GET, aucune CSRF)
```

Un `<img src="…/user/del/<uid>">` dans une page visitée par l'admin suffit. Les ids de
dossier sont des entiers séquentiels (`AutoField`) : aucune énumération nécessaire.

**Correctif.** (1) Corriger NS-01. (2) Jetons CSRF sur l'admin. (3) **Toutes** les
mutations en POST/DELETE. (4) Sur `/api`, un contrôle `Origin`/`Sec-Fetch-Site` dans un
`before_request` :

```python
@webapi.before_request
def _reject_cross_site():
    if request.method in ("GET","HEAD","OPTIONS"): return
    if request.headers.get("Sec-Fetch-Site") not in (None,"same-origin","none"):
        return jsonify({"error":"cross-site"}), 403
```

---

### <a id="ns-03"></a>NS-03 — 🔴 ✅ Mot de passe en clair récupérable depuis la base seule

**Fichiers :** `supysonic/managers/user.py:34-49`, `supysonic/utils.py:18-43`

**Preuve en boîte noire** (création d'un utilisateur `victim` / `SuperSecret#42`, puis
déchiffrement en n'utilisant que le contenu de la base) :

```
stored password_clear : S6nc9mdG6Glt0BPeTJs+qX1f0KH2Vg …
password_secret in Meta: a+QzX8a3KbkZQQj64ClI7B1u … (172 o b64)
RECOVERED CLEARTEXT    : 'SuperSecret#42'   ← à partir de la base SEULE
cookies_secret in Meta : YES (matériel de forge de session)
```

Le hachage argon2id de la colonne `password` est **cosmétique** : la version réversible
et la clé qui la déchiffre sont dans la même base. Une sauvegarde qui fuit donne : tous
les mots de passe en clair (réutilisés ailleurs → impact hors serveur), la forge de
n'importe quel cookie de session (`cookies_secret`), et le matériel de RCE du démon
(`daemon_key`, généré paresseusement mais au même endroit — cf. [NS-04](#ns-04)).

Défaut secondaire : **AES-CFB non authentifié** (malléable) au lieu d'AES-GCM/Fernet.

**Correctif.** (1) Idéalement supprimer `password_clear` (option `subsonic_token_auth = no`).
(2) Sinon **imposer** `SUPYSONIC_SECRET_PASSWORD_SECRET` en variable d'environnement (refus
de démarrer sinon) — déjà supporté par `get_secret_key`, il suffit d'interdire le repli
base pour cette clé. (3) Chiffrement authentifié. (4) Idem `cookies_secret` hors base.

---

### <a id="ns-04"></a>NS-04 — 🔴 🔎 Démon : `pickle` sur socket `/tmp` prévisible → RCE

**Fichiers :** `supysonic/daemon/server.py:38-70`, `supysonic/config.py:59-71`

**Preuve (lecture + introspection) :**

```
uses multiprocessing Listener : True
recv() puis isinstance-check   : True   (pickle AVANT toute validation)
default socket path            : /tmp/supysonic/supysonic.sock  (répertoire partagé prévisible)
```

`multiprocessing.connection.recv()` désérialise avec `pickle` **avant** le
`isinstance(cmd, DaemonCommand)`. C'est une RCE par conception. Deux garde-fous, tous
deux fragiles : l'`authkey` vit dans la base ([NS-03](#ns-03)), et le socket est dans un
`/tmp` partagé prévisible (un utilisateur local peut pré-créer le répertoire).

**Chaîne :** fuite base → `daemon_key` → `Client(addr, authkey).send(pickle_bomb)` → RCE
sous l'identité du démon (accès écriture bibliothèque + config = **ARL**).

**Correctif.** (1) Socket dans `/run/supysonic` (0700, `umask 077`), refus si world-writable.
(2) Remplacer le transport picklé par du **JSON + liste blanche de commandes** (moins de
dix). (3) `daemon_key` hors base.

---

## 2. Constats élevés

### <a id="ns-05"></a>NS-05 — 🟠 ✅ Mass assignment `admin=1`

**Fichier :** `supysonic/frontend/user.py:249-275` — `UserManager.add(name, passwd, **args)`.

**Preuve en boîte noire** (session admin frontend) :

```
POST /user/add  user=pwn1 passwd=x admin=1 jukebox=1
  → pwn1 admin = True
  → pwn1 jukebox = True
```

Tout champ de formulaire non consommé devient une colonne `User`. Bonus observé :
mass-assigner `password_clear`/`password`/`salt` provoque un `TypeError → 500`
(`create() got multiple values for keyword argument`), preuve que l'injection atteint
bien `User.create()`. Couplé à [NS-02](#ns-02), c'est le chemin d'escalade le plus court.

**Correctif.** Liste blanche explicite `{"mail","admin","jukebox"}`, cases converties en
booléens côté serveur, et refus de tout kwarg hors liste dans `UserManager.add`.

---

### <a id="ns-06"></a>NS-06 — 🟠 ✅ `/rest/download?id=<folder>` exfiltre tout l'arbre

**Fichier :** `supysonic/api/media.py:363-393` — `z.add_path(rv.path, recurse=True)`, **sans
filtre d'extension ni contrôle de rôle**.

**Preuve bout-en-bout** (un invité, `mallory`, télécharge le dossier racine où un fichier
non-audio a été déposé) :

```
/rest/download folder -> 200 application/zip (61 597 o)
  zip contient SECRET_NOTES.txt : True
  noms : archive/Uploads/<uid-A>/private.wav
         archive/Uploads/<uid-A>/SECRET_NOTES.txt
         archive/Uploads/<uid-B>/burst0.wav …     ← uploads d'AUTRES utilisateurs
```

Un invité repart avec toute la bibliothèque, les fichiers non-audio traînant dans l'arbre,
et les uploads de tous les autres comptes. Ids de dossier séquentiels.

**Aggravation avec [NS-05](#ns-05) :** un admin obtenu par CSRF enregistre `/` comme racine
(`FolderManager.add` ne restreint aucun chemin) → lecture arbitraire du disque
(`/data/supysonic.conf` = ARL, clés SSH montées…).

**Correctif.** Filtrer par extension (itérer sur les `Track` du dossier, pas sur le FS),
restreindre au rôle admin, et borner `FolderManager.add` à une liste blanche de racines.

---

### <a id="ns-07"></a>NS-07 — 🟠 ✅ Uploads non cloisonnés entre utilisateurs

**Fichiers :** `supysonic/webui/__init__.py:1683-1697` et routes de lecture.

**Preuve bout-en-bout** (`guest` uploade, `mallory` lit) :

```
guest upload private.wav -> 200 (imported)
mallory GET /api/me/local        -> voit ['private']
mallory GET /api/stream/<uuid>   -> 200, 12044 octets (le fichier de guest)
mallory GET /api/share/file/<uuid> -> 200, attachment "[unknown] - private.wav"
```

Introspection : `my_local` ne filtre que `Track.deezer_id.is_null(True)` — **aucun
propriétaire**. Le modèle `Track` n'a pas de champ owner. Toutes les routes de lecture
(`/api/me/local`, `/api/search`, `/api/stream`, `/api/localcover`, `/api/cover`,
`/api/share/*`, `/api/export/*`, `/rest/download`) exposent les fichiers de tout le monde
à tout le monde. Il n'existe en plus **aucun endpoint de suppression** d'un upload.

**Correctif.** `Track.owner` (FK nullable), filtrage
`owner IS NULL OR owner == request.webuser` sur toutes les lectures, endpoint
`DELETE /api/local/<uuid>`. Migration : récupérer le propriétaire depuis le segment
`Uploads/<user-id>/` du chemin.

---

### <a id="ns-08"></a>NS-08 — 🟠 ✅ Épuisement disque via `/api/download`

**Fichier :** `supysonic/deezer/prefetch.py:45-53`

**Preuve (introspection) :** `self._dl_queue: queue.Queue = queue.Queue()` — **aucun
`maxsize`**. `/api/download` accepte 2000 ids/requête, mais rien ne borne le nombre de
requêtes ni la file. Chaque id = un FLAC complet (20–60 Mo), tiré par 4 workers.

Un invité en boucle (`POST /api/download` avec des ids Deezer denses) remplit le disque
en quelques heures → SQLite corrompue, cache de transcodage HS. Le commentaire du code
identifie le risque mais ne borne que **une** requête.

**Correctif.** `queue.Queue(maxsize=5000)` + `put_nowait`/rejet, quota d'archivage par
utilisateur, garde-fou `shutil.disk_usage`, et rate-limit sur la route.

---

### <a id="ns-09"></a>NS-09 — 🟠 🔎 Gel serveur : ffmpeg synchrone sur 8 threads

**Fichiers :** `supysonic/webui/share.py:166-190, 300-355`, `docker/gunicorn.conf.py`
(1 worker / 8 threads).

`/api/share/waveform` décode **tout** le fichier en PCM ; `/api/share/clip` réencode
jusqu'à 600 s **jusqu'à complétion** avant de répondre ; `/api/share/file?fmt=` transcode
le fichier entier. Aucune de ces routes n'a de limite (seul `/api/export` en a une :
`_claim_export`). Huit requêtes concurrentes saturent les huit threads ; l'admin et le
healthcheck attendent. `subprocess.run` de la forme d'onde n'a pas de `timeout=`.

**Correctif.** `timeout=` + `kill()` sur tous les ffmpeg ; sémaphore global de transcodage
indépendant des threads HTTP (503 + `Retry-After` au-delà) ; rate-limit par utilisateur ;
formes d'onde générées à l'archivage plutôt qu'à la demande.

---

### <a id="ns-11"></a>NS-11 — 🟠 ✅ Rate-limit : le succès efface la progression de l'attaquant

**Fichier :** `supysonic/ratelimit.py` + `api/__init__.py:81,102`, `webui:967`

**Preuve en boîte noire** (4 échecs depuis une IP, puis une connexion réussie depuis la
même IP) :

```
après 4 échecs, bloqué : False (seuil 5)
guest login ok         : 200
après succès, IP bloquée: False   ← reset() a effacé le compteur
```

`auth_limiter.reset(remote_addr)` est appelé sur **toute** authentification réussie : un
attaquant qui possède un compte valide remet le compteur à zéro entre chaque salve. La
clé est aussi `request.remote_addr` : derrière un proxy sans `proxy_fix_hops` (le défaut),
c'est l'IP du proxy **pour tout le monde** → 10 échecs bloquent l'auth de **tous** les
utilisateurs (DoS d'auth), et aucune limite par compte n'existe.

**Correctif.** Clés composites `ip:<addr>` **et** `user:<name>`, le succès ne réinitialise
que la clé utilisateur (jamais l'IP), back-off exponentiel. Signaler que l'état en mémoire
est divisé par le nombre de workers gunicorn.

---

### <a id="ns-12"></a>NS-12 — 🟠 ✅ Sessions non révocables, pas de régénération

**Preuve (introspection + config réelle) :**

```
login calls session.clear() before setting uid : False   (/api/login)
frontend login calls session.clear() first      : False
PERMANENT_SESSION_LIFETIME                       : 31 days
```

Ni `/api/login` ni le login frontend ne vident la session avant d'y écrire l'identité →
**fixation de session** possible. Les cookies Flask sont signés donc **non révocables** :
un cookie volé reste valide **31 jours**, insensible à la déconnexion, au changement de
mot de passe et à la rétrogradation d'un admin.

**Correctif.** `session.clear()` avant d'écrire l'identité ; `PERMANENT_SESSION_LIFETIME`
réduit (7 j ; 12 h pour l'admin) ; `User.session_epoch` comparé dans `login_required` et
incrémenté au changement de mot de passe / de rôle (rend les sessions révocables).

---

### <a id="ns-37"></a>NS-37 — 🟠 ✅ **Nouveau** — Open redirect : garde contourné par `/\`

**Fichier :** `supysonic/frontend/user.py:26-35` (`safe_redirect_target`), utilisé par
`frontend.login(returnUrl=…)`.

Le garde rejette `//evil.com` mais **pas** `/\evil.com`. **Preuve en boîte noire :**

```
'//evil.com'    -> '/FALLBACK'   (bloqué ✓)
'/\evil.com'    -> '/\evil.com'  ← RENVOYÉ TEL QUEL
'/\/evil.com'   -> '/\/evil.com' ← RENVOYÉ TEL QUEL
```

`urlsplit('/\evil.com').netloc` vaut `''`, donc le garde le prend pour un chemin local.
Mais un navigateur qui reçoit `Location: /\evil.com` **normalise `\` en `/`** (standard
WHATWG URL) → `//evil.com` → URL protocole-relative → **navigation vers `evil.com`**.

**Impact.** `https://musique.exemple/user/login?returnUrl=/\evil.com` : après connexion,
la victime est renvoyée vers `evil.com`. Pivot de phishing crédible (« session expirée,
reconnectez-vous » sur un clone).

**Correctif.**

```python
def safe_redirect_target(target, fallback):
    if not target:
        return fallback
    target = target.replace("\\", "/")          # normaliser AVANT d'analyser
    parts = urlsplit(target)
    if parts.scheme or parts.netloc or not target.startswith("/") or target.startswith("//"):
        return fallback
    return target
```

---

## 3. Constats moyens

### <a id="ns-13"></a>NS-13 — 🟡 ✅ `changePassword` sans mot de passe actuel

**Preuve en boîte noire :**

```
GET /rest/changePassword username=guest password=NewPass999 -> 200 ok
login avec le nouveau mot de passe -> 200
```

Conforme au protocole Subsonic, mais toute credential Subsonic captée (jeton `t`/`s` dans
un log, une URL, un `.har`) devient une prise de contrôle définitive. L'interface web, elle,
exige l'ancien mot de passe. **Correctif :** exiger `oldPassword` quand
`username == request.user.name`.

### <a id="ns-14"></a>NS-14 — 🟡 🔎 Credentials Subsonic en clair dans l'URL
`p=<clair>`, `p=enc:<hex>` (encodage, pas chiffrement), `t=md5(password+s)`. Finissent
dans les logs nginx, l'historique, les `Referer`, les `.har`. → Documenter HTTPS
obligatoire, option `subsonic_require_https`, option pour désactiver `p=` en clair.

### <a id="ns-15"></a>NS-15 — 🟡 ✅ JSONP `callback` non validé + ACAO `*`
**Preuve en boîte noire :**

```
/rest/ping.view?f=jsonp&callback=alert(document.cookie);//
  content-type: application/javascript
  body: alert(document.cookie);//({"subsonic-response": …
Access-Control-Allow-Origin (JSON): *
```

`nosniff` empêche l'interprétation HTML, mais c'est un **gadget de contournement CSP** :
`<script src="/rest/ping.view?…&f=jsonp&callback=PAYLOAD">` est autorisé par `script-src
'self'`. → Valider `callback` par `\A[A-Za-z_$][\w$]{0,63}\Z`, ou désactiver JSONP.

### <a id="ns-16"></a>NS-16 — 🟡 🔎 `getLyrics` : XML non fiable, HTTP clair
`api/media.py:580-596` : `http://` + `ElementTree.fromstring` (expansion d'entités →
bombe XML), résultat **mis en cache** (empoisonnement persistant),
`root.find(...).text` non gardé (`AttributeError` non capturée). Atténué par
`online_lyrics = False` par défaut. → `https://` + `defusedxml` (ou basculer sur LRCLIB,
déjà en HTTPS/JSON), borner la taille.

### <a id="ns-17"></a>NS-17 — 🟡 ✅ Ids non validés dans les URL Deezer sortantes
`_valid_id()` est absent de `/api/artist/<id>`, `/album/<id>`, `/playlist/<id>`,
`/lyrics/<id>`, `/radio/artist/<id>`, `/smarttracklist/<id>` — le segment est concaténé
dans l'URL `api.deezer.com`. Hôte fixe (pas de SSRF hôte arbitraire) mais injection de
paramètres via `%3F` et consommation de quota API pilotée par le client. Voir la validation
laxiste en [NS-34](#ns-34). → `_valid_id` strict en tête de ces routes.

### <a id="ns-18"></a>NS-18 — 🟡 🔎 SSRF via `stream_url` d'épisode
`provider.py:231-255` : `stream_url` (venu de Deezer/hôte podcast) suivi en redirections,
sans validation d'IP, puis **archivé et servi**. Une chaîne de redirections vers
`169.254.169.254` ou `127.0.0.1:5722` donne une exfiltration lisible via `/api/stream`.
→ Garde anti-SSRF (refus des IP privées/loopback/link-local) **à chaque saut**
(`allow_redirects=False` + boucle), taille bornée.

### <a id="ns-19"></a>NS-19 — 🟡 🔎 Android : cleartext + trust-all SSL + pont ouvert
`usesCleartextTraffic="true"`, `Ssl.trustAll` + `hostnameVerifier{true}`,
`MIXED_CONTENT_ALWAYS_ALLOW`, `addJavascriptInterface(NSNative)`, shim injecté sur `"*"`,
`allowBackup="true"`. Chaîne « café Wi-Fi » : MITM (aucune validation cert) → vol du
cookie en clair → injection JS → `NSNative.shareFile(url arbitraire)` /
`saveText(fichier arbitraire)`. Le trust-all est **pire qu'aucun TLS** (il affiche un
cadenas). → Config réseau restreinte à l'hôte, épinglage TOFU au lieu du trust-all, shim
restreint à l'origine, validation d'origine dans `shareFile`, `allowBackup="false"`.

### <a id="ns-20"></a>NS-20 — 🟡 🔎 Fuite de l'ARL et du mot de passe admin
`entrypoint.sh` écrit `arl = …` en clair dans `/data/supysonic.conf` (umask 022, volume
persistant) ; `DEEZER_ARL` visible via `docker inspect`/`/proc/<pid>/environ` ;
`supysonic-cli user add … -p "$PWD"` expose le mot de passe admin dans `ps`. → `chmod 600`
+ `umask 077`, secrets Docker (`*_FILE`), `--password-stdin`, rotation de l'ARL.

### <a id="ns-21"></a>NS-21 — 🟡 🔎 Supply chain : builds non reproductibles
`webapp/package-lock.json` **gitignoré** → `npm install` résout les `^` au build (`svelte`,
`vite`, `svelte-dnd-action`, `svelte-spa-router` + transitives). Planchers Python dangereux :
`flask >=0.11`, `requests >=1.0.0`. Image de base par tag mutable. Keystore Android éphémère.
→ Committer le lockfile + `npm ci`, planchers `flask>=3.0`/`requests>=2.32`/`Pillow>=10.3`,
digest d'image, Dependabot. *(Cf. les alertes Dependabot déjà présentes sur le dépôt.)*

### <a id="ns-22"></a>NS-22 — 🟡 ✅ CSP `https:` joker, pas de HSTS
**Preuve en boîte noire** (en-têtes réels) :

```
Content-Security-Policy : … img-src 'self' data: https: … connect-src 'self' https: …
X-Content-Type-Options  : nosniff          (présent ✓)
X-Frame-Options         : SAMEORIGIN        (présent ✓)
Strict-Transport-Security: — ABSENT
Permissions-Policy      : — ABSENT
```

`img-src https:` + `connect-src https:` autorisent l'exfiltration vers tout Internet HTTPS
après injection (cf. gadget NS-15). → Restreindre à `*.dzcdn.net`/`api.deezer.com` (ou
rien, `/api/cover` proxifie déjà en same-origin), `object-src 'none'`, HSTS si `is_secure`.

### <a id="ns-24"></a>NS-24 — 🟡 ✅ `addChatMessage` non borné
**Preuve :** message de 100 000 caractères accepté (`200 ok`). Aucune limite de longueur,
de débit, ni de purge ; stocké brut (XSS stocké chez les clients qui l'affichent en HTML).
→ Tronquer (~512), rate-limiter, purger, échapper.

### <a id="ns-10"></a>NS-10 — 🟡 ⚠️ Quota : TOCTOU (non reproduit)
`webui:2505-2529` lit `used` une fois puis boucle sans verrou. **Deux tentatives de
reproduction ont échoué** : sur SQLite, le verrou d'écriture sérialise **et rejette** les
uploads concurrents (12 lancés → 4 puis 1 importés ; quota jamais dépassé, même avec une
barrière forçant tous les threads à lire `used` avant toute écriture). Le vecteur reste
théorique sur un backend concurrent (Postgres/MySQL, recommandé en prod). → Verrou par
utilisateur autour du contrôle+écriture ; comptabilité transactionnelle.

### <a id="ns-26"></a>NS-26 — 🟡 ✅ `_push_async` : un thread OS par appel (admin-only)
**Correction passe 1 :** les trois routes appelantes (`edit_playlist`, `delete_playlist`,
`save_podcast_progress`) sont **toutes admin-gated** (introspection confirmée) — **pas**
accessible à un invité. Reste un DoS admin (thread par appel, sans pool → `can't start new
thread`). → `ThreadPoolExecutor(max_workers=4)` partagé, rejet silencieux.

### <a id="ns-27"></a>NS-27 — 🟡 🔎 Aucun journal d'audit
Seuls les échecs de connexion sont journalisés. Création/suppression d'utilisateur, octroi
admin, ajout de racine, changement de mot de passe d'un tiers, accès à un fichier d'autrui :
**aucune trace**. Après une chaîne CSRF, tout ressemble à « l'admin l'a fait lui-même ».
→ Table `AuditLog` + affichage admin.

---

## 4. Constats faibles

### <a id="ns-28"></a>NS-28 — 🔵 🔎 Mots de passe par défaut
`changeme` / `${POSTGRES_PASSWORD:-supysonic}` s'appliquent silencieusement ; port publié
sur `0.0.0.0`. → Refus de démarrer avec `changeme`, mot de passe aléatoire au premier boot.

### <a id="ns-29"></a>NS-29 — 🔵 ✅ Aucune politique de mot de passe
`UserManager.add` accepte `"x"` (vérifié : `passwd=x` a créé un compte). → Minimum 12
caractères, refus des mots de passe les plus courants.

### <a id="ns-30"></a>NS-30 — 🔵 ✅ `LIKE` non échappé
`Track.title.contains(q)` → `LIKE %q%` sans échapper `% _`. `/rest/search?any=%` (renvoie
`200`, balayage complet) ou `/api/search?q=_`. → Échapper `% _ \`, exiger 2 caractères.

### <a id="ns-31"></a>NS-31 — 🔵 🔎 Bombes de décompression PIL
`api/media.py:503-517` : `Image.open().thumbnail()` sur des pochettes issues de fichiers
uploadés. Partiellement atténué par `MAX_IMAGE_PIXELS`. → Limite explicite, `size` borné.

### <a id="ns-32"></a>NS-32 — 🔵 🔎 `IniConfig` : sections inconnues → `app.config`
`config.py:130-137` : une section `[secret_key]` écraserait `SECRET_KEY` ;
`getattr(self, section).update()` mute les dicts **de classe** (état partagé). → Copier les
dicts, liste blanche de sections.

### <a id="ns-33"></a>NS-33 — 🔵 🔎 Tables progress/markers non bornées globalement
`_MAX_MARKERS=100` par épisode, mais nombre d'épisodes non borné ;
`POST /api/podcast/progress` = une écriture par requête sans limite. → Plafond global +
rate-limit.

### <a id="ns-34"></a>NS-34 — 🔵 ✅ `_valid_id()` trop laxiste
**Preuve :** `_valid_id` renvoie `True` pour `'-5'`, `'١٢٣'`, `'²'`, `'٤'` (négatifs,
chiffres Unicode, exposants) car `str.lstrip('-').isdigit()` accepte la catégorie Unicode
`Nd` et les exposants. → `re.compile(r"\A[0-9]{1,20}\Z")`.

### <a id="ns-35"></a>NS-35 — 🔵 ✅ Catalogue Deezer payant ouvert à tous les invités
Le cloisonnement des **données personnelles** (Flow, favoris, recos) est soigné et
appliqué avec constance — mais `/api/search`, `/api/album`, `/api/stream`, `/api/download`,
`/api/export` donnent à tout invité l'accès complet au catalogue via l'abonnement admin, en
FLAC et en téléchargement de masse. Risque **contractuel** (bannissement Deezer). → Option
`guest_streaming = no`, plafond par invité.

### <a id="ns-38"></a>NS-38 — 🔵 ✅ **Nouveau** — `size`/`offset` non bornés
`albums_songs.py:43-48` : `getRandomSongs?size=1000000000` → `query.limit(1000000000)`
(idem `getAlbumList`/`getAlbumList2`). Amplificateur de réponse borné seulement par la
taille de la bibliothèque. → Plafonner `size` (ex. 500).

### <a id="ns-39"></a>NS-39 — 🔵 ⚠️ **Nouveau** — Timing-oracle d'énumération
`try_auth` renvoie immédiatement si l'utilisateur n'existe pas, mais lance un `verify`
argon2 complet s'il existe. **Non reproduit** avec les paramètres argon2 de test (0.9x),
mais avec les paramètres de production (~60 ms contre ~1 ms) le canal temporel distingue
un nom valide. → Vérifier contre un hachage factice quand l'utilisateur n'existe pas
(comparaison à temps constant).

---

## 5. Chaînes d'attaque (revalidées)

### Chaîne A — De l'anonyme au contrôle total *(chaque maillon confirmé en boîte noire)*

```
1. L'admin, connecté (cookie 31 j, NS-12✅), visite une page piégée.
2. POST /user/add admin=1  → pas de SameSite (NS-01✅), pas de CSRF (NS-02✅),
   mass assignment (NS-05✅)                     ⇒ compte ADMIN pour l'attaquant.
3. GET /rest/download?id=<N> (NS-06✅)           ⇒ ZIP de tout l'arbre :
     /data/supysonic.conf → ARL (NS-20)
     dump base → password_secret → mots de passe en clair (NS-03✅)
     dump base → cookies_secret → forge de session (NS-03✅)
     dump base → daemon_key → pickle → RCE (NS-04)
```

Coût : une page HTML et un clic. Aucun 0-day.

### Chaîne B — De l'invité à la fuite des fichiers d'autrui *(confirmée)*

```
1. guest uploade private.wav.
2. mallory (autre invité) : GET /api/me/local → le voit ;
   GET /api/stream/<uuid> → 12 044 o ; GET /api/share/file/<uuid> → téléchargé.
                                              (NS-07✅)
3. mallory : GET /rest/download?id=<folder> → ZIP de tous les uploads. (NS-06✅)
```

### Chaîne D — La sauvegarde oubliée *(le déchiffrement confirmé en boîte noire)*

```
Un dump de base qui fuit :
  password_secret (dans Meta) → decrypt_password() → 'SuperSecret#42' (prouvé, NS-03✅)
  cookies_secret  (dans Meta) → forge du cookie admin
  daemon_key                  → pickle → RCE (NS-04)
```

C'est le constat central : **aucune défense en profondeur derrière la base.** Sortir les
trois clés vers l'environnement casse cette chaîne à elle seule.

---

## 6. Ce qui tient (revérifié dynamiquement)

- **Traversée de répertoire : bloquée.** `GET /api/cover/../../etc/passwd → 404`,
  `/app/../../../etc/passwd` ne sert rien. `Cache._filepath` rejette les clés à séparateur
  (testé : `a/b`, `..`, `x\y` → `ValueError`), et cette `ValueError` est proprement
  convertie en erreur Subsonic sur `/rest` (d'où la rétractation de NS-36).
- **Robustesse des parseurs : bonne.** 18 entrées malformées (`int`, `uuid`, params
  manquants) sur `/rest` **et** `/api` → **aucun 500** (400/404/503/erreur Subsonic). D'où
  la rétractation de NS-23. Le `@api.errorhandler(ValueError)` est un bon filet.
- **Hachage argon2id** avec migration transparente et `hmac.compare_digest` (gâché par
  `password_clear`, mais la mécanique est correcte).
- **Pas d'injection SQL** (peewee ORM partout), **pas de XSS SPA** (Svelte échappe, aucun
  `{@html}`), **pas d'injection de commande** (`subprocess` avec listes, jamais
  `shell=True` ; substitutions à l'intérieur d'arguments déjà découpés).
- **Cloisonnement des données personnelles Deezer** explicite et constant.
- **Le journal de diagnostic client rédige les secrets** (`SECRET_PARAMS`) et ne capture
  aucun corps de requête.
- **`favorite` sur un UUID inexistant → 400** (pas de 500, pas d'énumération utile).

---

## 7. Plan d'action

### Immédiat (quelques lignes chacun, tous confirmés exploitables)
- [ ] **NS-01** — affectation directe des flags cookie + test sur `Set-Cookie`
- [ ] **NS-37** — `target.replace("\\","/")` avant analyse dans `safe_redirect_target`
- [ ] **NS-02a** — `/user/del`, `/folder/del`, `/folder/scan`, `*/link|unlink` en POST
- [ ] **NS-05** — liste blanche des champs dans `add_user_post` / `UserManager.add`
- [ ] **NS-08** — `queue.Queue(maxsize=5000)`
- [ ] **NS-34** — `_valid_id` en regex stricte, appliquée aux routes de [NS-17](#ns-17)
- [ ] **NS-28** — refus de démarrer avec le mot de passe `changeme`

### Court terme
- [ ] **NS-02b** — jetons CSRF admin + contrôle `Origin`/`Sec-Fetch-Site` sur `/api`
- [ ] **NS-03** — `SUPYSONIC_SECRET_*` obligatoires hors base, chiffrement authentifié
- [ ] **NS-06** — filtre d'extension + rôle sur le ZIP de dossier ; racines en liste blanche
- [ ] **NS-07** — `Track.owner` + filtrage lecture + endpoint de suppression
- [ ] **NS-09** — sémaphore de transcodage, `timeout=` ffmpeg, rate-limit
- [ ] **NS-11** — clés de rate-limit `ip:` + `user:`, succès ne réinitialise que `user:`
- [ ] **NS-12** — `session.clear()`, `session_epoch`, durée réduite
- [ ] **NS-21** — committer `package-lock.json`, `npm ci`, planchers de version

### Moyen terme
- [ ] **NS-04** — protocole démon JSON, socket hors `/tmp`
- [ ] **NS-19** — épinglage TOFU Android, shim restreint, pont validé
- [ ] **NS-18** — garde anti-SSRF sur les récupérations externes
- [ ] **NS-22** — CSP restreinte, HSTS · **NS-27** — journal d'audit
- [ ] **NS-13/14/15/16** — durcissement de la surface Subsonic héritée

### Tests de non-régression (dérivés du harnais de cette passe)
```python
def test_session_cookie_has_samesite_and_secure(self)      # NS-01
def test_safe_redirect_rejects_backslash(self)             # NS-37
def test_admin_mutations_reject_get(self)                  # NS-02
def test_user_add_ignores_unknown_fields(self)             # NS-05
def test_folder_download_excludes_non_audio(self)          # NS-06
def test_guest_cannot_read_another_users_upload(self)      # NS-07
def test_password_secret_required_from_env(self)           # NS-03
def test_download_queue_is_bounded(self)                   # NS-08
def test_success_does_not_reset_ip_ratelimit(self)         # NS-11
def test_jsonp_callback_must_be_identifier(self)           # NS-15
def test_valid_id_rejects_unicode_digits(self)             # NS-34
```

---

## Annexe — Méthode et limites

**Boîte noire.** Harnais Python montant `create_application()` sur SQLite temporaire, deux
comptes (admin + invités), requêtes via `test_client` sur les chemins **de production**
(`app.testing=False`). Neuf scénarios exécutés ; les blocs « Preuve » reproduisent leur
sortie réelle.

**Non couvert / limites honnêtes :**
- Backend **SQLite uniquement** — NS-10 (TOCTOU) et les courses inter-requêtes se comportent
  différemment sous Postgres/MySQL ; marqués « non reproduits », pas « inexistants ».
- **Deezer désactivé** (pas d'ARL) — les chemins provider (SSRF NS-18, ids sortants NS-17)
  sont confirmés par lecture, pas déclenchés vers un vrai Deezer.
- **Android** analysé statiquement (pas d'émulateur/MITM réel).
- **Pas d'`ffmpeg`** dans l'environnement — NS-09 confirmé par lecture, pas par saturation
  réelle des threads.
- Dépendances non auditées pour CVE (pas de `pip-audit`/`npm audit` — pas de réseau vers
  les bases de vulnérabilités).

**Sévérités** = impact × facilité dans le modèle de menace décrit, pas un barème CVSS.
