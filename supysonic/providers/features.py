# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Distributed under terms of the GNU AGPLv3 license.

"""What the application can ask a provider for, in detail (plan §15).

A FEATURE is finer than a capability: a capability is a group of methods a
provider implements, a feature is a service a person uses, with

- a SCOPE: ``shared`` (the answer does not depend on who asks, so an account
  can lend it) or ``personal`` (the data belongs to the account's holder: their
  favourites, their playlists; never lent);
- for an information feature, the FIELDS a provider may say it knows.

A provider declares, per feature, whether it needs an account (``"account"``)
or works anonymously (``"none"``), and for an information feature which fields
it gives: ``{"track_info": {"auth": "none", "fields": ["isrc", ...]}}``.
"""

from . import base

SHARED = "shared"
PERSONAL = "personal"

AUTH_NONE = "none"
AUTH_ACCOUNT = "account"

#: The whole account, in a grant: a row naming a feature overrides it for that
#: feature, so a feature added later inherits the account's setting.
ANY = "*"

#: id -> (French label, scope, capability that carries it, help)
CATALOGUE = {
    "search": ("Recherche dans le catalogue", SHARED, base.SEARCH, "Chercher des titres, albums et artistes chez le fournisseur."),
    "stream": ("Écoute et archivage", SHARED, base.AUDIO, "Écouter un titre qui n'est pas encore sur le serveur (il y est alors archivé)."),
    "browse": ("Pages du catalogue", SHARED, base.CATALOG, "Ouvrir un album, un artiste ou une playlist que le serveur n'a pas."),
    "podcasts": ("Podcasts", SHARED, base.PODCASTS, "Chercher des émissions et s'y abonner."),
    "links": ("Liens partagés", SHARED, base.LINKS, "Lire un lien collé vers ce fournisseur."),
    "related": ("Sorties et artistes proches", SHARED, base.RELATED, "Les nouveautés des artistes suivis et leurs voisins."),
    "track_info": ("Infos sur un titre", SHARED, base.INFO, "Des faits sur un enregistrement."),
    "artist_info": ("Infos sur un artiste", SHARED, base.INFO, "Des faits sur un artiste."),
    "album_info": ("Infos sur un album", SHARED, base.INFO, "Des faits sur une sortie."),
    "lyrics": ("Paroles", SHARED, base.INFO, "Les paroles, synchronisées quand c'est possible."),
    "my_tracks": ("Mes titres favoris", PERSONAL, base.LIBRARY, "Les titres aimés sur le compte."),
    "my_albums": ("Mes albums favoris", PERSONAL, base.LIBRARY, "Les albums enregistrés sur le compte."),
    "my_artists": ("Mes artistes favoris", PERSONAL, base.LIBRARY, "Les artistes suivis sur le compte."),
    "my_playlists": ("Mes playlists", PERSONAL, base.LIBRARY, "Les playlists du compte."),
    "my_shows": ("Mes podcasts", PERSONAL, base.LIBRARY, "Les émissions suivies sur le compte."),
}

#: The fields an information feature may declare, with their French label.
FIELDS = {
    "track_info": {
        "title": "titre",
        "artists": "artistes",
        "album": "album",
        "duration": "durée",
        "isrc": "ISRC",
        "release_date": "date de sortie",
        "first_release": "date de première sortie",
        "bpm": "tempo publié",
        "contributors": "contributeurs",
        "composer": "compositeur",
        "lyricist": "parolier",
        "producer": "producteur",
        "label": "label",
        "copyright": "copyright",
        "explicit": "explicite",
        "cover": "pochette",
        "preview": "extrait",
        "mbid": "identifiant MusicBrainz",
        "fingerprint": "reconnaissance par empreinte",
    },
    "artist_info": {
        "name": "nom",
        "picture": "photo",
        "fans": "fans",
        "top_tracks": "titres phares",
        "similar": "artistes proches",
        "discography": "discographie",
        "biography": "biographie",
        "mbid": "identifiant MusicBrainz",
    },
    "album_info": {
        "title": "titre",
        "cover": "pochette",
        "tracks": "liste des titres",
        "release_date": "date de sortie",
        "label": "label",
        "upc": "UPC",
        "genre": "genre",
    },
    "lyrics": {"plain": "texte", "synced": "synchronisées"},
}

#: A login mode's id -> French label. The provider adds its own fields and help.
AUTH_MODE_KINDS = {
    "browser": "Connexion sur la page du service",
    "arl": "Cookie de session (ARL)",
    "headers": "En-têtes d'un onglet connecté",
    "token": "Jeton",
    "key": "Clé d'API",
    "oauth": "OAuth",
    "password": "Identifiant et mot de passe",
}


def scope(feature):
    entry = CATALOGUE.get(feature)
    return entry[1] if entry else None


def is_personal(feature):
    return scope(feature) == PERSONAL


def declared(provider) -> dict:
    """The provider's features, normalised: ``{feature: {"auth", "fields"}}``.

    A provider that declares none (a third party written before §15, the test
    provider) gets every feature its capabilities carry, shared ones only and
    anonymous: what it could always do, said in the new words."""
    own = getattr(provider, "features", None)
    if own:
        out = {}
        for fid, spec in own.items():
            spec = dict(spec or {})
            out[fid] = {
                "auth": spec.get("auth") or AUTH_NONE,
                "fields": list(spec.get("fields") or ()),
            }
        return out
    caps = set(getattr(provider, "capabilities", ()) or ())
    return {
        fid: {"auth": AUTH_NONE, "fields": []}
        for fid, (_label, sc, cap, _help) in CATALOGUE.items()
        if sc == SHARED and cap in caps and cap != base.INFO
    }


def check(provider) -> None:
    """Refuse a malformed declaration: an unknown feature, a capability not
    declared, a personal feature said to work without an account, a field the
    catalogue does not know, an unknown login mode."""
    own = getattr(provider, "features", None) or {}
    caps = set(provider.capabilities)
    for fid, spec in own.items():
        if fid not in CATALOGUE:
            raise ValueError(f"{provider.id}: unknown feature {fid!r}")
        _label, sc, cap, _help = CATALOGUE[fid]
        if cap not in caps:
            raise ValueError(f"{provider.id}: {fid!r} needs the {cap!r} capability")
        spec = spec or {}
        auth = spec.get("auth") or AUTH_NONE
        if auth not in (AUTH_NONE, AUTH_ACCOUNT):
            raise ValueError(f"{provider.id}: {fid!r} auth must be 'none' or 'account'")
        if sc == PERSONAL and auth != AUTH_ACCOUNT:
            raise ValueError(f"{provider.id}: {fid!r} is personal, it needs an account")
        unknown = set(spec.get("fields") or ()) - set(FIELDS.get(fid, {}))
        if unknown:
            raise ValueError(f"{provider.id}: {fid!r} has unknown fields {sorted(unknown)}")
    for mode in getattr(provider, "auth_modes", ()) or ():
        if mode.get("id") not in AUTH_MODE_KINDS:
            raise ValueError(f"{provider.id}: unknown login mode {mode.get('id')!r}")


def describe(provider) -> dict:
    """What the settings screen shows of a provider: its features in the
    catalogue's order, with their labels, scope, what they need and their
    fields; its login modes; whether it needs an account at all."""
    mine = declared(provider)
    feats = []
    for fid, (label, sc, _cap, help_) in CATALOGUE.items():
        if fid not in mine:
            continue
        spec = mine[fid]
        labels = FIELDS.get(fid, {})
        feats.append(
            {
                "id": fid,
                "label": label,
                "scope": sc,
                "auth": spec["auth"],
                "help": help_,
                "fields": [{"id": f, "label": labels.get(f, f)} for f in spec["fields"]],
            }
        )
    modes = []
    for mode in getattr(provider, "auth_modes", ()) or ():
        modes.append(
            {
                "id": mode["id"],
                "label": mode.get("label") or AUTH_MODE_KINDS[mode["id"]],
                "help": mode.get("help") or "",
                "app_only": bool(mode.get("app_only")),
            }
        )
    return {
        "id": provider.id,
        "name": provider.name or provider.id,
        "role": provider.role,
        "features": feats,
        "auth_modes": modes,
        # Needs an account for everything, or works anonymously for something.
        "anonymous": any(f["auth"] == AUTH_NONE for f in feats),
        "account": any(f["auth"] == AUTH_ACCOUNT for f in feats),
    }
