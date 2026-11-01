# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Distributed under terms of the GNU AGPLv3 license.

"""How alike two genres are: a hierarchy plus weighted lateral links.

A radio that says "more of what I like in this family, a little further each
time" needs a NUMBER for "a little further". That number is the similarity here,
0..1, between any two genres of the vocabulary (``analysis.known_genres()``).

Two kinds of knowledge, written as data, because no audio can tell you that
frenchcore is the child of gabber and the cousin of uptempo:

- the TREE (``TREE``): each genre under the genre it grew out of or is filed
  under. Structural nodes that are not themselves a label ("Hard dance") exist
  only to group; a track is never tagged with one.
- the LINKS (``LINKS``): lateral ties the tree cannot express — hardstyle took
  gabber's kick and trance's breakdowns, trap crossed hip-hop with EDM. Each is
  weighted by how often a listener of one is also a listener of the other.

Similarity is the best path between the two through both kinds of edge, the
product of the weights along it (so it decays with every step, and a path of
strong ties beats a short path of weak ones). Computed once per genre and kept.

SOURCES (read for the ties; the weights are judgement, not measurement, and are
meant to be adjusted by what the user actually plays — see ``radio.py``):
technomag.fr "Hardcore: an analysis & the different sub-genres of hard techno";
6AM Group "Diving through hardcore techno subgenres"; the electronic-guide
genre index (gabber, uptempo hardcore); Wikipedia on Frenchcore, Hardstyle and
Hardcore (EDM); Every Noise at Once (Spotify) for which genres share listeners.
Sources disagree on parentage and on tempo ranges; where they do, the tie is
given a middling weight rather than a side.
"""

from __future__ import annotations

import heapq
import re
import threading

#: Weight of a parent<->child edge. A child is very close to its parent; two
#: siblings are therefore TREE_W**2 apart, a cousin TREE_W**4 …
TREE_W = 0.8

#: Indented, two spaces per level. A genre appears exactly once.
TREE = """
Électronique
  Hard dance
    Hardcore
      Gabber
        Terrorcore
        Extratone
        Doomcore
        Industrial hardcore
      UK hardcore
        Happy hardcore
        Makina
      Speedcore
      Frenchcore
      Uptempo
        Deutscher Krach
        Pieep
        Zaag
      Indus
    Hardtek
      Hardtekk
      Tekk
      Tribe
      Raggatek
      Acidcore
      Hard pingpong
    Hardstyle
      Euphoric hardstyle
      Rawstyle
      Rawphase
      Bouncy
    Hard techno
    Hard house
    Hardbass
    Jumpstyle
    German party
  Techno
    Minimal
    Detroit
    Acid techno
    Schranz
    Industrial techno
    Peaktime
    Dub techno
    EBM
    Darksynth
  House
    Deep house
    Tech house
    Prog house
    Melodic house
    Bigroom
    Electro house
    French house
    Ghetto house
    Afro house
    Amapiano
    Gqom
    Disco / funk
      Italo disco
      Nu disco
      Boogie
      Funk
    Dance / EDM
      Eurodance
  Trance
    Uplifting trance
    Prog trance
    Vocal trance
    Hard trance
    Psytrance
      Goa
      Full on
      Darkpsy
      Hitech
      Forest
      Psydub
  Bass music
    Drum & bass
      Liquid DnB
      Neurofunk
      Jump up
      Jungle
      Darkstep
      Drumfunk
    Dubstep
      Brostep
      Riddim
      Melodic dubstep
    UK garage
      Two step
      Speed garage
      Bassline
      Grime
    Breakbeat
      Big beat
      Nu breaks
      Breakcore
        Lolicore
        Crossbreed
    Future bass
    Trap EDM
    Hard trap
    Jersey club
    Moombahton
    Glitch hop
  Électronique expérimentale
    IDM
    Glitch
    Experimental
    Noise
    Chiptune
    Eightbit
  Synthwave
    Retrowave
    Outrun
    Vaporwave
    Future funk
    Synthpop
    Darkwave
    Coldwave
    Gothic
    Witch house
  Ambient
    Dark ambient
    Drone
    New age
    Minimalism
    Downtempo
    Chillout
    Trip hop
    Dub
Hip-hop
  Rap
    Boom bap
    G funk
    Cloud rap
    Emo rap
    Lofi hiphop
    Drill
      UK drill
  Trap
    Phonk
  Lo-fi
    Chillhop
Rock et dérivés
  Rock
    Garage rock
    Psych rock
    Prog rock
    Grunge
    Indie
    Shoegaze
    Hard rock
  Punk
    Hardcore punk
    Post punk
    Pop punk
    Ska punk
    Emo
  Metal
    Heavy metal
    Thrash
    Death / brutal
      Death metal
      Deathcore
    Black metal
    Doom
    Sludge
    Metalcore
    Djent
    Nu metal
    Power metal
    Symphonic metal
Pop
  Pop / chanson
    Chanson
    Schlager
    Singer songwriter
  Dream pop
  Hyperpop
  K-pop
  J-pop
  City pop
  Latin pop
R&B / soul
  Soul
    Neo soul
    Motown
    Gospel
Jazz et blues
  Jazz / acoustique
    Bebop
    Swing
    Big band
    Smooth jazz
    Jazz fusion
  Blues
    Delta blues
Folk et terroirs
  Folk
    Celtic
    Bluegrass
  Country
  Flamenco
  Tango
  Bollywood
  Arabic
Caraïbes et Afriques
  Reggae
    Rocksteady
    Ska
    Dancehall
  Reggaeton
    Dembow
  Afrobeats
    Afroswing
    Afrobeat
    Highlife
    Kizomba
  Salsa
  Cumbia
  Samba
    Bossa nova
Classique
  Cordes / classique
    Classical
    Orchestral
    Baroque
    Romantic
    Piano
    Opera
    Choral
    Film score
    Soundtrack
"""

#: (a, b, weight): lateral ties. Order inside a pair does not matter.
LINKS = """
Gabber | Hardstyle | 0.55
Gabber | Hardtek | 0.45
Gabber | Industrial techno | 0.4
Gabber | Hard techno | 0.5
Gabber | Breakcore | 0.4
Frenchcore | Uptempo | 0.85
Frenchcore | Hardtek | 0.5
Frenchcore | Hardstyle | 0.45
Frenchcore | Gabber | 0.7
Uptempo | Speedcore | 0.6
Uptempo | Rawstyle | 0.5
Zaag | Hardtekk | 0.45
Pieep | Frenchcore | 0.55
Deutscher Krach | Hard techno | 0.5
Deutscher Krach | Hard pingpong | 0.5
Hardtekk | Tribe | 0.75
Hardtekk | Hard techno | 0.5
Hard pingpong | Hardtekk | 0.7
Hard pingpong | Hardbass | 0.45
Hardtekk | Psytrance | 0.35
Tribe | Psytrance | 0.35
Hardstyle | Trance | 0.4
Hardstyle | Hard trance | 0.6
Hardstyle | Bigroom | 0.35
Rawstyle | Hard techno | 0.4
Hard techno | Techno | 0.65
Hard techno | Schranz | 0.8
Hard techno | Industrial techno | 0.7
Hard techno | Hard house | 0.5
Hard house | House | 0.55
Hard house | Hardbass | 0.5
Hardbass | Jumpstyle | 0.55
Jumpstyle | Hardstyle | 0.45
German party | Hard house | 0.4
German party | Schlager | 0.4
German party | Eurodance | 0.45
Happy hardcore | Eurodance | 0.5
Happy hardcore | Uplifting trance | 0.4
Makina | Hard trance | 0.4
Techno | House | 0.6
Techno | Trance | 0.5
Techno | EBM | 0.45
Techno | Électronique | 0.5
Industrial techno | Indus | 0.6
Indus | EBM | 0.55
Indus | Industrial hardcore | 0.6
Industrial hardcore | Gabber | 0.7
Tech house | Techno | 0.65
Tech house | House | 0.8
Deep house | Dub techno | 0.5
Deep house | Downtempo | 0.4
Prog house | Prog trance | 0.6
Prog trance | Trance | 0.8
Uplifting trance | Trance | 0.8
Goa | Trance | 0.5
Psytrance | Techno | 0.35
Darkpsy | Dark ambient | 0.25
Psydub | Dub | 0.4
Bigroom | Electro house | 0.7
Electro house | Dubstep | 0.4
Electro house | Dance / EDM | 0.75
House | Dance / EDM | 0.7
Disco / funk | House | 0.65
Nu disco | Disco / funk | 0.7
French house | Disco / funk | 0.55
Afro house | Afrobeats | 0.45
Amapiano | Afro house | 0.7
Amapiano | Gqom | 0.6
Gqom | Ghetto house | 0.5
Drum & bass | Jungle | 0.75
Drum & bass | Breakbeat | 0.55
Neurofunk | Darkstep | 0.6
Neurofunk | Techno | 0.3
Liquid DnB | Chillout | 0.3
Jungle | Dancehall | 0.4
Jungle | Reggae | 0.35
Dubstep | UK garage | 0.55
Dubstep | Grime | 0.5
Dubstep | Trap EDM | 0.5
Dubstep | Drum & bass | 0.5
Brostep | Metal | 0.2
Riddim | Dubstep | 0.8
Trap | Trap EDM | 0.6
Trap | Hard trap | 0.7
Trap EDM | Hard trap | 0.7
Trap | Drill | 0.65
Trap | Phonk | 0.6
Phonk | Hard trap | 0.4
Drill | UK drill | 0.9
UK drill | Grime | 0.5
Rap | Trap | 0.7
Rap | Boom bap | 0.8
Boom bap | Lofi hiphop | 0.55
Lofi hiphop | Chillhop | 0.85
Lofi hiphop | Lo-fi | 0.8
Chillhop | Downtempo | 0.55
Hip-hop | Rap | 0.9
Hip-hop | R&B / soul | 0.55
Hip-hop | Funk | 0.4
G funk | Funk | 0.5
Cloud rap | Emo rap | 0.6
Emo rap | Emo | 0.35
Future bass | Dance / EDM | 0.6
Future bass | Hyperpop | 0.4
Hyperpop | Pop / chanson | 0.4
Moombahton | Reggaeton | 0.55
Moombahton | House | 0.35
Jersey club | UK garage | 0.35
Jersey club | House | 0.4
Garage rock | Punk | 0.55
Speed garage | House | 0.5
Two step | R&B / soul | 0.35
Breakcore | Speedcore | 0.45
Breakcore | IDM | 0.45
Lolicore | Speedcore | 0.4
Crossbreed | Raggatek | 0.5
Big beat | Rock | 0.25
Big beat | House | 0.4
Glitch hop | Glitch | 0.6
Glitch hop | Hip-hop | 0.35
IDM | Ambient | 0.4
IDM | Downtempo | 0.4
Trip hop | Hip-hop | 0.45
Trip hop | Downtempo | 0.7
Downtempo | Chillout | 0.8
Chillout | Ambient | 0.65
Ambient | Drone | 0.7
Ambient | New age | 0.65
Dark ambient | Industrial techno | 0.3
Dark ambient | Doom | 0.3
New age | Classical | 0.35
Minimalism | Classical | 0.5
Minimalism | Minimal | 0.3
Dub | Reggae | 0.7
Dub techno | Dub | 0.6
Dub techno | Minimal | 0.55
Minimal | Techno | 0.7
Detroit | House | 0.6
Peaktime | Techno | 0.85
Acid techno | Techno | 0.8
Darksynth | Synthwave | 0.6
Darksynth | Industrial techno | 0.4
Synthwave | Synthpop | 0.5
Synthwave | Retrowave | 0.9
Retrowave | Outrun | 0.85
Vaporwave | Future funk | 0.6
Vaporwave | Lo-fi | 0.5
Future funk | Disco / funk | 0.6
Synthpop | Pop / chanson | 0.65
Synthpop | Darkwave | 0.45
Darkwave | Coldwave | 0.8
Darkwave | Gothic | 0.7
Darkwave | Post punk | 0.55
Coldwave | Post punk | 0.65
Witch house | Darkwave | 0.4
EBM | Industrial techno | 0.55
EBM | Darkwave | 0.45
Chiptune | Eightbit | 0.95
Chiptune | Synthwave | 0.35
Eurodance | Pop / chanson | 0.4
Eurodance | Dance / EDM | 0.7
Italo disco | Eurodance | 0.55
Italo disco | Synthpop | 0.45
Boogie | Funk | 0.6
Funk | Soul | 0.6
Funk | Disco / funk | 0.7
Soul | R&B / soul | 0.8
Neo soul | R&B / soul | 0.7
Motown | Soul | 0.8
Gospel | Soul | 0.6
Pop / chanson | Pop | 0.9
Pop | Dance / EDM | 0.5
Pop | R&B / soul | 0.5
Pop | Rock | 0.4
Pop | Indie | 0.45
Chanson | Folk | 0.4
Singer songwriter | Folk | 0.65
Singer songwriter | Pop / chanson | 0.55
Dream pop | Shoegaze | 0.7
Dream pop | Indie | 0.55
K-pop | J-pop | 0.55
K-pop | Pop | 0.55
City pop | J-pop | 0.6
City pop | Disco / funk | 0.45
Latin pop | Reggaeton | 0.55
Latin pop | Pop | 0.6
Reggaeton | Dembow | 0.8
Reggaeton | Dancehall | 0.55
Dancehall | Reggae | 0.7
Dancehall | Afroswing | 0.4
Afroswing | Afrobeats | 0.85
Afrobeats | Afrobeat | 0.55
Afrobeats | Dancehall | 0.45
Afrobeats | R&B / soul | 0.4
Ska | Reggae | 0.55
Ska | Punk | 0.35
Ska | Ska punk | 0.85
Rocksteady | Reggae | 0.8
Highlife | Afrobeat | 0.6
Kizomba | Samba | 0.3
Kizomba | R&B / soul | 0.35
Salsa | Cumbia | 0.5
Samba | Bossa nova | 0.7
Bossa nova | Jazz / acoustique | 0.55
Tango | Flamenco | 0.4
Flamenco | Folk | 0.45
Celtic | Folk | 0.8
Bluegrass | Country | 0.75
Country | Folk | 0.65
Country | Blues | 0.45
Blues | Rock | 0.5
Blues | Jazz / acoustique | 0.55
Blues | Soul | 0.5
Delta blues | Blues | 0.85
Bebop | Jazz / acoustique | 0.85
Swing | Big band | 0.8
Swing | Jazz / acoustique | 0.75
Smooth jazz | Jazz fusion | 0.55
Smooth jazz | R&B / soul | 0.4
Jazz fusion | Prog rock | 0.35
Jazz fusion | Funk | 0.45
Boom bap | Jazz / acoustique | 0.3
Classical | Orchestral | 0.8
Classical | Film score | 0.5
Orchestral | Film score | 0.75
Film score | Soundtrack | 0.9
Soundtrack | Ambient | 0.3
Baroque | Classical | 0.8
Romantic | Classical | 0.8
Piano | Classical | 0.7
Opera | Choral | 0.6
Opera | Classical | 0.65
Symphonic metal | Orchestral | 0.4
Symphonic metal | Power metal | 0.7
Rock | Hard rock | 0.8
Hard rock | Heavy metal | 0.7
Heavy metal | Metal | 0.9
Heavy metal | Thrash | 0.7
Thrash | Hardcore punk | 0.5
Thrash | Death metal | 0.7
Death metal | Death / brutal | 0.9
Death metal | Black metal | 0.55
Death metal | Deathcore | 0.7
Metalcore | Deathcore | 0.7
Metalcore | Hardcore punk | 0.6
Metalcore | Emo | 0.35
Djent | Metalcore | 0.55
Djent | Prog rock | 0.35
Doom | Sludge | 0.7
Doom | Heavy metal | 0.55
Sludge | Hardcore punk | 0.5
Nu metal | Hip-hop | 0.35
Nu metal | Metal | 0.7
Grunge | Rock | 0.7
Grunge | Punk | 0.45
Psych rock | Prog rock | 0.6
Psych rock | Psytrance | 0.15
Prog rock | Rock | 0.7
Garage rock | Rock | 0.8
Indie | Rock | 0.6
Indie | Shoegaze | 0.5
Pop punk | Punk | 0.8
Pop punk | Emo | 0.6
Pop punk | Pop | 0.35
Post punk | Punk | 0.6
Hardcore punk | Punk | 0.8
Hardcore punk | Gabber | 0.2
Hardcore punk | Speedcore | 0.25
Gothic | Dark ambient | 0.3
Schlager | Pop / chanson | 0.5
Arabic | Bollywood | 0.3
Bollywood | Pop | 0.35
Experimental | Noise | 0.6
Experimental | Glitch | 0.55
Noise | Industrial techno | 0.3
Noise | Speedcore | 0.3
Électronique | House | 0.5
"""

_SPLIT = re.compile(r"[^a-z0-9]+")


def key(name: str) -> str:
    """A genre name folded for lookup: lower case, accents and punctuation gone."""
    import unicodedata

    s = unicodedata.normalize("NFKD", str(name or "")).encode("ascii", "ignore").decode()
    return _SPLIT.sub("", s.lower())


_lock = threading.Lock()
_graph = None  # {"names": {key: label}, "parent": {key: key}, "adj": {key: {key: w}}}
_reach = {}  # key -> {key: similarity}


def _parse_tree():
    names, parent, stack = {}, {}, []
    for raw in TREE.splitlines():
        if not raw.strip():
            continue
        depth = (len(raw) - len(raw.lstrip(" "))) // 2
        label = raw.strip()
        k = key(label)
        stack = stack[:depth]
        if k in names:
            raise ValueError(f"genre placed twice in TREE: {label}")
        if k not in names:
            names[k] = label
            if stack:
                parent[k] = stack[-1]
        stack.append(k)
    return names, parent


def _build():
    names, parent = _parse_tree()
    adj = {k: {} for k in names}

    def tie(a, b, w):
        if a == b:
            return
        if w > adj[a].get(b, 0):
            adj[a][b] = adj[b][a] = w

    for child, par in parent.items():
        tie(child, par, TREE_W)
    for line in LINKS.strip().splitlines():
        a, b, w = (x.strip() for x in line.split("|"))
        ka, kb = key(a), key(b)
        if ka not in names or kb not in names:
            raise ValueError(f"link names an unknown genre: {line}")
        tie(ka, kb, float(w))
    return {"names": names, "parent": parent, "adj": adj}


def graph():
    global _graph
    if _graph is None:
        with _lock:
            if _graph is None:
                _graph = _build()
    return _graph


def known(name) -> bool:
    return key(name) in graph()["names"]


def label(name):
    """The graph's spelling of a genre, or None."""
    return graph()["names"].get(key(name))


def parent_of(name):
    g = graph()
    p = g["parent"].get(key(name))
    return g["names"][p] if p else None


def lineage(name):
    """The genre then its ancestors up to the root: ["Frenchcore", "Hardcore", …]."""
    g = graph()
    k, out = key(name), []
    while k in g["names"]:
        out.append(g["names"][k])
        k = g["parent"].get(k)
        if k is None:
            break
    return out


def family_of(name):
    """The top-level branch a genre sits under ("Électronique" is too wide, so
    its children are the families)."""
    chain = lineage(name)
    if not chain:
        return None
    if chain[-1] == "Électronique" and len(chain) >= 2:
        return chain[-2]
    return chain[-1]


def children_of(name):
    g = graph()
    k = key(name)
    return sorted(g["names"][c] for c, p in g["parent"].items() if p == k)


def _reach_from(k):
    hit = _reach.get(k)
    if hit is not None:
        return hit
    adj = graph()["adj"]
    best = {k: 1.0}
    heap = [(-1.0, k)]
    while heap:
        neg, cur = heapq.heappop(heap)
        sim = -neg
        if sim < best.get(cur, 0):
            continue
        for nxt, w in adj[cur].items():
            s = sim * w
            if s > best.get(nxt, 0.0):
                best[nxt] = s
                heapq.heappush(heap, (-s, nxt))
    with _lock:
        if len(_reach) > 512:
            _reach.clear()
        _reach[k] = best
    return best


def similarity(a, b) -> float:
    """0..1; 1 for the same genre, 0 for an unknown one or no path."""
    ka, kb = key(a), key(b)
    if ka == kb:
        return 1.0 if ka in graph()["names"] else 0.0
    if ka not in graph()["names"] or kb not in graph()["names"]:
        return 0.0
    return _reach_from(ka).get(kb, 0.0)


def neighbours(name, floor=0.05):
    """``{label: similarity}`` of every genre at least ``floor`` like this one,
    the genre itself included at 1.0."""
    k = key(name)
    names = graph()["names"]
    if k not in names:
        return {}
    return {names[o]: s for o, s in _reach_from(k).items() if s >= floor}


def expand(seeds, spread=0.0):
    """Weights over genres for a radio seeded on ``seeds``.

    Every seed counts 1.0 (and, with it, the sub-genres under it at 0.9 — asking
    for "Hardcore" means its whole branch). ``spread`` in 0..1 is how far to
    reach: 0 keeps the seeds and their branches, 1 lets genres as weak as 0.3
    in. A genre's weight is its best similarity to ANY seed, so two seeds widen
    the pool instead of averaging it down.
    """
    g = graph()
    spread = min(1.0, max(0.0, float(spread)))
    floor = 1.0 - spread * 0.7  # 1.0 (exact) .. 0.3 (far cousins, never strangers)
    out = {}
    for seed in seeds:
        k = key(seed)
        if k not in g["names"]:
            continue
        branch = [k]
        for child, par in g["parent"].items():
            c = child
            while c is not None:
                if c == k:
                    branch.append(child)
                    break
                c = g["parent"].get(c)
        for b in branch:
            out[g["names"][b]] = max(out.get(g["names"][b], 0.0), 1.0 if b == k else 0.9)
        for o, s in _reach_from(k).items():
            lab = g["names"][o]
            if s >= min(floor, 0.9) and s > out.get(lab, 0.0):
                out[lab] = s
    return out
