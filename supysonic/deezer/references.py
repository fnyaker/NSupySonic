# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Distributed under terms of the GNU AGPLv3 license.

"""Well-known recordings per genre, to start a genre's training set from.

A genre wants eight tagged tracks before the head can learn anything from it,
and the first eight are the hardest to find in a library that was never sorted
by genre. So the studio offers, per genre, a few recordings that are a genre's
textbook examples — the kind a history of the style names.

The rule this list is held to: **nothing in it is a guess.** Every pair is a
recording that exists under that artist and that title, and that the genre's
own literature names as one of its examples. Where no such list could be
written with certainty — the young, local scenes this app cares most about
(Pieep, Deutscher Krach, Hardtekk, Zaag, Uptempo, Frenchcore…), whose canon is
nowhere written down — there is NO list rather than a plausible-looking one,
and the studio says so. For some of those, the scene's established artists
are offered instead (``SCENE_ARTISTS``): an artist page to listen through and
tag in bulk (with its review), not a track put forward as the genre.

Nothing here is imported blindly either. Each pair is looked up on Deezer at
the moment it is shown, a hit must match the artist AND the title (``match``),
and the admin listens before anything is tagged. A pair Deezer does not carry
is shown as "introuvable", never replaced by whatever the search returned.
"""

from __future__ import annotations

import re
import unicodedata

#: Genre label (as the studio's vocabulary spells it) -> (artist, title) pairs.
#: The title may be a distinctive fragment: a classical recording's full title
#: differs from one edition to the next ("Piano Sonata No. 14 … 'Moonlight'").
REFERENCES: dict[str, tuple[tuple[str, str], ...]] = {
    # -- the engine's families ------------------------------------------------
    "Ambient": (("Brian Eno", "1/1"), ("Brian Eno", "An Ending (Ascent)"), ("The Orb", "Little Fluffy Clouds")),
    "Cordes / classique": (("Samuel Barber", "Adagio for Strings"), ("Johann Pachelbel", "Canon")),
    "Jazz / acoustique": (("Miles Davis", "So What"), ("The Dave Brubeck Quartet", "Take Five"), ("John Coltrane", "Giant Steps")),
    "Pop / chanson": (("Michael Jackson", "Billie Jean"), ("Édith Piaf", "La vie en rose")),
    "R&B / soul": (("Marvin Gaye", "What's Going On"), ("Aretha Franklin", "Respect")),
    "Hip-hop": (("The Notorious B.I.G.", "Juicy"), ("Dr. Dre", "Still D.R.E."), ("Nas", "N.Y. State of Mind")),
    "House": (("Frankie Knuckles", "Your Love"), ("Robin S", "Show Me Love"), ("Mr. Fingers", "Can You Feel It")),
    "Techno": (("Jeff Mills", "The Bells"), ("Joey Beltram", "Energy Flash"), ("Underworld", "Born Slippy")),
    "Trance": (("Robert Miles", "Children"), ("ATB", "9 PM (Till I Come)"), ("Darude", "Sandstorm")),
    "Dance / EDM": (("Avicii", "Levels"), ("Swedish House Mafia", "Don't You Worry Child")),
    "Drum & bass": (("Goldie", "Inner City Life"), ("Roni Size", "Brown Paper Bag"), ("Pendulum", "Tarantula")),
    "Dubstep": (("Skream", "Midnight Request Line"), ("Benga", "Night")),
    "Disco / funk": (("Chic", "Le Freak"), ("Bee Gees", "Stayin' Alive"), ("Donna Summer", "I Feel Love")),
    "Psytrance": (("Infected Mushroom", "Becoming Insane"), ("Astrix", "Deep Jungle Walk"), ("Vini Vici", "The Tribe")),
    "Hardstyle": (("Headhunterz", "Dragonborn"), ("Brennan Heart", "Lose My Mind")),
    "Rock": (("Led Zeppelin", "Whole Lotta Love"), ("The Rolling Stones", "(I Can't Get No) Satisfaction")),
    "Metal": (("Metallica", "Master of Puppets"), ("Iron Maiden", "The Trooper"), ("Black Sabbath", "Paranoid")),
    "Death / brutal": (("Death", "Pull the Plug"), ("Cannibal Corpse", "Hammer Smashed Face")),
    "Rap": (("Eminem", "Lose Yourself"), ("Kendrick Lamar", "HUMBLE."), ("IAM", "Je danse le mia"), ("MC Solaar", "Bouge de là")),
    "Trap": (("Migos", "Bad and Boujee"), ("Future", "Mask Off"), ("Travis Scott", "SICKO MODE")),
    "Reggaeton": (("Daddy Yankee", "Gasolina"), ("J Balvin", "Mi Gente")),
    "Amapiano": (("Focalistic", "Ke Star"),),
    "UK garage": (("Artful Dodger", "Re-Rewind"), ("Sweet Female Attitude", "Flowers"), ("MJ Cole", "Sincere")),
    "Breakbeat": (("The Prodigy", "Out of Space"),),
    "Dancehall": (("Sean Paul", "Get Busy"), ("Beenie Man", "Who Am I")),
    "Reggae": (("Bob Marley & The Wailers", "Is This Love"), ("Peter Tosh", "Legalize It")),
    "Synthwave": (("Kavinsky", "Nightcall"),),
    "Funk": (("James Brown", "Get Up (I Feel Like Being a) Sex Machine"), ("Parliament", "Give Up the Funk")),
    "Lo-fi": (("Nujabes", "Feather"),),
    "Pop": (("Michael Jackson", "Billie Jean"), ("Madonna", "Like a Prayer"), ("Dua Lipa", "Levitating")),
    "Soul": (("Otis Redding", "(Sittin' On) The Dock of the Bay"), ("Sam Cooke", "A Change Is Gonna Come")),
    "Blues": (("B.B. King", "The Thrill Is Gone"), ("Muddy Waters", "Hoochie Coochie Man")),
    "Country": (("Johnny Cash", "Ring of Fire"), ("Dolly Parton", "Jolene")),
    "Folk": (("Bob Dylan", "Blowin' in the Wind"), ("Simon & Garfunkel", "The Sound of Silence")),
    "Punk": (("Ramones", "Blitzkrieg Bop"), ("Sex Pistols", "Anarchy in the U.K.")),
    "Indie": (("Arctic Monkeys", "I Bet You Look Good on the Dancefloor"), ("The Strokes", "Last Nite")),
    "Hard rock": (("AC/DC", "Back in Black"), ("Guns N' Roses", "Welcome to the Jungle")),
    "Phonk": (("Kordhell", "Murder in My Mind"), ("DVRST", "Close Eyes")),
    "Électronique": (("Kraftwerk", "Trans-Europe Express"),),
    # -- the studio's sub-genres ------------------------------------------------
    "Minimal": (("Plastikman", "Spastik"),),
    "Detroit": (("Rhythim Is Rhythim", "Strings of Life"), ("Inner City", "Good Life"), ("Cybotron", "Clear")),
    "Acid techno": (("Hardfloor", "Acperience 1"), ("Josh Wink", "Higher State of Consciousness")),
    "EBM": (("Front 242", "Headhunter"), ("Nitzer Ebb", "Join in the Chant")),
    "IDM": (("Aphex Twin", "Windowlicker"), ("Autechre", "Gantz Graf"), ("Boards of Canada", "Roygbiv")),
    "Deep house": (("Fingers Inc.", "Mystery of Love"),),
    "Tech house": (("Green Velvet", "La La Land"), ("FISHER", "Losing It")),
    "Prog house": (("deadmau5", "Strobe"), ("Eric Prydz", "Opus")),
    "Melodic house": (("RÜFÜS DU SOL", "Innerbloom"),),
    "Bigroom": (("Martin Garrix", "Animals"), ("Hardwell", "Spaceman")),
    "Electro house": (("Benny Benassi", "Satisfaction"),),
    "French house": (("Daft Punk", "Around the World"), ("Stardust", "Music Sounds Better with You"), ("Modjo", "Lady (Hear Me Tonight)")),
    "Gqom": (("Distruction Boyz", "Omunye"),),
    "Italo disco": (("Gazebo", "I Like Chopin"), ("Ryan Paris", "Dolce Vita")),
    "Nu disco": (("Purple Disco Machine", "Hypnotized"),),
    "Boogie": (("Shalamar", "A Night to Remember"),),
    "Eurodance": (("Haddaway", "What Is Love"), ("2 Unlimited", "No Limit"), ("Eiffel 65", "Blue (Da Ba Dee)")),
    "Jumpstyle": (("Jeckyll & Hyde", "Freefall"),),
    "Two step": (("Craig David", "Fill Me In"),),
    "Bassline": (("T2", "Heartbroken"),),
    "Big beat": (("The Chemical Brothers", "Block Rockin' Beats"), ("Fatboy Slim", "The Rockafeller Skank"), ("The Prodigy", "Firestarter")),
    "Moombahton": (("Major Lazer", "Lean On"),),
    "Liquid DnB": (("High Contrast", "If We Ever"),),
    "Neurofunk": (("Noisia", "Machine Gun"),),
    "Jungle": (("Shy FX", "Original Nuttah"), ("M-Beat", "Incredible")),
    "Brostep": (("Skrillex", "Scary Monsters and Nice Sprites"),),
    "Future bass": (("Flume", "Never Be Like You"),),
    "Trap EDM": (("Baauer", "Harlem Shake"), ("RL Grime", "Core")),
    "Uplifting trance": (("Paul van Dyk", "For an Angel"), ("Gouryella", "Gouryella")),
    "Vocal trance": (("Delerium", "Silence"), ("Armin van Buuren", "This Is What It Feels Like")),
    "Goa": (("Hallucinogen", "LSD"), ("Astral Projection", "People Can Fly")),
    "Gabber": (("Rotterdam Termination Source", "Poing"),),
    "Happy hardcore": (("Paul Elstak", "Luv U More"), ("Charly Lownoise & Mental Theo", "Wonderfull Days")),
    "Euphoric hardstyle": (("Headhunterz", "Dragonborn"),),
    "Breakcore": (("Venetian Snares", "Szamár Madár"),),
    "Boom bap": (("Gang Starr", "Mass Appeal"), ("Nas", "N.Y. State of Mind")),
    "Drill": (("Chief Keef", "Love Sosa"), ("Pop Smoke", "Dior")),
    "UK drill": (("Tion Wayne", "Body"),),
    "Cloud rap": (("Yung Lean", "Ginseng Strip 2002"),),
    "Emo rap": (("Lil Peep", "Star Shopping"), ("XXXTENTACION", "Jocelyn Flores")),
    "G funk": (("Warren G", "Regulate"), ("Snoop Dogg", "Gin and Juice")),
    "Lofi hiphop": (("Nujabes", "Aruarian Dance"), ("J Dilla", "Time: The Donut of the Heart")),
    "Grime": (("Dizzee Rascal", "I Luv U"), ("Skepta", "Shutdown")),
    "Afrobeats": (("Wizkid", "Essence"), ("Burna Boy", "Last Last")),
    "Afroswing": (("J Hus", "Did You See"),),
    "Garage rock": (("The White Stripes", "Seven Nation Army"), ("The Sonics", "Psycho")),
    "Psych rock": (("Jefferson Airplane", "White Rabbit"), ("Tame Impala", "Let It Happen")),
    "Prog rock": (("Pink Floyd", "Money"), ("Yes", "Roundabout")),
    "Hardcore punk": (("Black Flag", "Rise Above"), ("Minor Threat", "Straight Edge")),
    "Post punk": (("Joy Division", "Love Will Tear Us Apart"), ("Gang of Four", "Damaged Goods")),
    "Pop punk": (("blink-182", "All the Small Things"), ("Green Day", "Basket Case")),
    "Ska punk": (("Reel Big Fish", "Sell Out"),),
    "Ska": (("The Specials", "Ghost Town"), ("Madness", "One Step Beyond")),
    "Grunge": (("Nirvana", "Smells Like Teen Spirit"), ("Soundgarden", "Black Hole Sun")),
    "Emo": (("Jimmy Eat World", "The Middle"), ("My Chemical Romance", "Welcome to the Black Parade")),
    "Shoegaze": (("My Bloody Valentine", "Only Shallow"), ("Slowdive", "Alison")),
    "Heavy metal": (("Judas Priest", "Breaking the Law"), ("Iron Maiden", "The Trooper")),
    "Thrash": (("Slayer", "Raining Blood"), ("Megadeth", "Holy Wars")),
    "Death metal": (("Cannibal Corpse", "Hammer Smashed Face"), ("Death", "Pull the Plug")),
    "Black metal": (("Mayhem", "Freezing Moon"), ("Emperor", "I Am the Black Wizards")),
    "Doom": (("Black Sabbath", "Black Sabbath"), ("Candlemass", "Solitude")),
    "Metalcore": (("Killswitch Engage", "My Last Serenade"),),
    "Deathcore": (("Suicide Silence", "You Only Live Once"),),
    "Djent": (("Meshuggah", "Bleed"), ("Periphery", "Icarus Lives")),
    "Nu metal": (("Linkin Park", "In the End"), ("Korn", "Freak on a Leash")),
    "Power metal": (("DragonForce", "Through the Fire and Flames"), ("Helloween", "I Want Out")),
    "Symphonic metal": (("Nightwish", "Nemo"), ("Within Temptation", "Ice Queen")),
    "Synthpop": (("Depeche Mode", "Enjoy the Silence"), ("a-ha", "Take On Me")),
    "Dream pop": (("Beach House", "Myth"), ("Cocteau Twins", "Heaven or Las Vegas")),
    "Hyperpop": (("100 gecs", "money machine"), ("SOPHIE", "Immaterial")),
    "K-pop": (("PSY", "Gangnam Style"), ("BTS", "Dynamite")),
    "J-pop": (("Kyary Pamyu Pamyu", "PONPONPON"),),
    "City pop": (("Mariya Takeuchi", "Plastic Love"),),
    "Latin pop": (("Luis Fonsi", "Despacito"), ("Shakira", "Hips Don't Lie")),
    "Chanson": (("Jacques Brel", "Ne me quitte pas"), ("Charles Aznavour", "La bohème"), ("Édith Piaf", "La vie en rose")),
    "Schlager": (("Helene Fischer", "Atemlos durch die Nacht"),),
    "Neo soul": (("Erykah Badu", "On & On"), ("D'Angelo", "Untitled (How Does It Feel)")),
    "Motown": (("The Temptations", "My Girl"), ("The Supremes", "Where Did Our Love Go")),
    "Gospel": (("The Edwin Hawkins Singers", "Oh Happy Day"), ("Kirk Franklin", "Stomp")),
    "Downtempo": (("Bonobo", "Kerala"), ("Thievery Corporation", "Lebanese Blonde")),
    "Trip hop": (("Massive Attack", "Teardrop"), ("Portishead", "Glory Box")),
    "Chillout": (("Air", "La femme d'argent"), ("Zero 7", "In the Waiting Line")),
    "Dub": (("Augustus Pablo", "King Tubbys Meets Rockers Uptown"),),
    "Retrowave": (("FM-84", "Running in the Night"),),
    "Darksynth": (("Perturbator", "Future Club"), ("Carpenter Brut", "Turbo Killer")),
    "Gothic": (("Bauhaus", "Bela Lugosi's Dead"), ("The Sisters of Mercy", "Lucretia My Reflection")),
    "New age": (("Enya", "Orinoco Flow"),),
    "Minimalism": (("Philip Glass", "Metamorphosis One"), ("Arvo Pärt", "Spiegel im Spiegel")),
    "Bebop": (("Charlie Parker", "Ko-Ko"), ("Dizzy Gillespie", "Salt Peanuts")),
    "Swing": (("Benny Goodman", "Sing, Sing, Sing"), ("Glenn Miller", "In the Mood")),
    "Big band": (("Count Basie", "One O'Clock Jump"), ("Duke Ellington", "Take the \"A\" Train")),
    "Smooth jazz": (("Kenny G", "Songbird"), ("Grover Washington Jr.", "Just the Two of Us")),
    "Jazz fusion": (("Weather Report", "Birdland"), ("Herbie Hancock", "Chameleon")),
    "Delta blues": (("Robert Johnson", "Cross Road Blues"),),
    "Bluegrass": (("Bill Monroe", "Blue Moon of Kentucky"), ("Flatt & Scruggs", "Foggy Mountain Breakdown")),
    "Singer songwriter": (("Joni Mitchell", "Both Sides Now"), ("Leonard Cohen", "Hallelujah")),
    "Celtic": (("Clannad", "Theme from Harry's Game"),),
    "Flamenco": (("Paco de Lucía", "Entre dos aguas"),),
    "Tango": (("Astor Piazzolla", "Libertango"), ("Carlos Gardel", "Por una cabeza")),
    "Salsa": (("Héctor Lavoe", "El Cantante"), ("Celia Cruz", "La vida es un carnaval")),
    "Samba": (("Jorge Ben", "Mas que nada"),),
    "Bossa nova": (("Stan Getz & João Gilberto", "The Girl from Ipanema"),),
    "Rocksteady": (("The Paragons", "The Tide Is High"),),
    "Afrobeat": (("Fela Kuti", "Zombie"),),
    "Classical": (("Ludwig van Beethoven", "Symphony No. 5"), ("Wolfgang Amadeus Mozart", "Eine kleine Nachtmusik")),
    "Orchestral": (("Gustav Holst", "Mars, the Bringer of War"),),
    "Opera": (("Giacomo Puccini", "Nessun dorma"), ("Georges Bizet", "Habanera")),
    "Choral": (("Carl Orff", "O Fortuna"), ("Gregorio Allegri", "Miserere")),
    "Baroque": (("Johann Pachelbel", "Canon"), ("Johann Sebastian Bach", "Brandenburg Concerto No. 3")),
    "Romantic": (("Frédéric Chopin", "Op. 9 No. 2"), ("Sergei Rachmaninoff", "Piano Concerto No. 2")),
    "Piano": (("Erik Satie", "Gymnopédie"), ("Claude Debussy", "Clair de lune"), ("Ludovico Einaudi", "Nuvole bianche")),
    "Film score": (("Hans Zimmer", "Time"), ("John Williams", "Hedwig's Theme")),
    "Soundtrack": (("Vangelis", "Chariots of Fire"), ("Ennio Morricone", "The Ecstasy of Gold")),
    "Chiptune": (("Anamanaguchi", "Endless Fantasy"),),
}

#: For scenes whose canon is not written down anywhere trustworthy, the
#: producers the scene itself is built around — an artist page to listen
#: through, not a track put forward as the genre.
SCENE_ARTISTS: dict[str, tuple[str, ...]] = {
    "Frenchcore": ("Dr. Peacock", "Sefa"),
    "Hardstyle": ("Headhunterz", "Wildstylez", "Brennan Heart", "Da Tweekaz"),
    "Rawstyle": ("Radical Redemption", "Warface", "Sub Zero Project"),
    "Hardcore": ("Angerfist", "Neophyte", "Paul Elstak"),
    "Gabber": ("Paul Elstak", "Neophyte"),
}

_WS = re.compile(r"[^0-9a-z]+")
_ARTIST_SPLIT = re.compile(r"\s*(?:&|,| and | feat\.? | ft\.? | x | with )\s*", re.I)
# A version the reference did not ask for: a live take, a remix, a cover.
_VARIANT = re.compile(r"\b(live|remix|mix|edit|karaoke|cover|instrumental|acoustic|remaster(?:ed)?|version|rework|bootleg)\b")


def fold(s) -> str:
    """Case, accents and punctuation dropped: "Édith Piaf" == "edith piaf"."""
    s = unicodedata.normalize("NFKD", str(s or ""))
    s = "".join(c for c in s if not unicodedata.combining(c)).lower()
    s = s.replace("ø", "o").replace("æ", "ae").replace("œ", "oe").replace("ß", "ss")
    return _WS.sub(" ", s).strip()


def _artists_of(candidate) -> list[str]:
    names = []
    art = candidate.get("artist") or {}
    if art.get("name"):
        names.append(art["name"])
    for c in candidate.get("contributors") or []:
        if isinstance(c, dict) and c.get("name"):
            names.append(c["name"])
    return [fold(n) for n in names if fold(n)]


def _artist_ok(ref_artist, candidate) -> bool:
    theirs = _artists_of(candidate)
    for part in _ARTIST_SPLIT.split(ref_artist):
        p = fold(part)
        if not p:
            continue
        for name in theirs:
            # At a word start, either way round: "Snoop Dogg" is who "Snoop
            # Doggy Dogg" became, "Shy FX" is the first of "Shy FX & UK Apachi".
            if p == name or _at_word_start(p, name) or _at_word_start(name, p):
                return True
    return False


def _at_word_start(needle, hay) -> bool:
    return bool(re.search(r"(?:^| )" + re.escape(needle), hay))


def _title_ok(ref_title, candidate) -> bool:
    ref = fold(ref_title)
    if not ref:
        return False
    for key in ("title_short", "title"):
        cand = fold(candidate.get(key))
        # The reference at a word start: "Gymnopédie" finds "Gymnopédies: No. 1",
        # "Time" does not find "Sometimes".
        if cand == ref or _at_word_start(ref, cand):
            return True
    return False


def match(ref_artist: str, ref_title: str, results) -> dict | None:
    """The search result that IS the reference, or None.

    Both the artist and the title must match; among the results that do, the
    one that is not a variant the reference did not name (live, remix, cover)
    comes first, then Deezer's own order. A result that matches only one of
    the two is never offered: it is how a search turns "Jolene" into a cover.
    """
    wanted_variant = bool(_VARIANT.search(fold(ref_title)))
    best = None
    for i, cand in enumerate(results or []):
        if not isinstance(cand, dict) or not cand.get("id"):
            continue
        if not (_artist_ok(ref_artist, cand) and _title_ok(ref_title, cand)):
            continue
        variant = bool(_VARIANT.search(fold(cand.get("title")))) and not wanted_variant
        rank = (variant, i)
        if best is None or rank < best[0]:
            best = (rank, cand)
    return best[1] if best else None


def first_artist(ref_artist: str) -> str:
    """The name a search is best asked with ("Stan Getz" of "Stan Getz &
    João Gilberto")."""
    parts = [p for p in _ARTIST_SPLIT.split(ref_artist) if p.strip()]
    return parts[0].strip() if parts else ref_artist


def genres_with_references() -> list[str]:
    return sorted(set(REFERENCES) | set(SCENE_ARTISTS))
