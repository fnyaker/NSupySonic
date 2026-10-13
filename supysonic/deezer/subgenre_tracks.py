# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic API server.
#
# Distributed under terms of the GNU AGPLv3 license.

"""Recordings per sub-genre, written by hand from what is published on the web.

Each list is the work of a search through DJ-magazine and label "essentials"
features, retrospectives, DJ tracklists and community rankings (the sources
are named in the comments beside each group). They are a starting set for the
genre studio, not a canon: a genre's picks disagree from one source to the
next, and where a source only named an album or an artist, no track is made
up for it.

Nothing here is trusted on its own. Like ``references.REFERENCES``, every pair
is looked up on Deezer when it is shown, must match the artist AND the title
(``references.match``), and is only tagged once the admin has listened to it.

Keys are the studio's own labels (``analysis.known_genres``). Groups under ten
pairs are as far as the web went for that genre, and are marked as such.
"""

SUBGENRE_TRACKS: dict[str, tuple[tuple[str, str], ...]] = {
    # --- techno & machines --------------------------------------------------
    # Mixmag (DJ Nikolina), Beatport "Schranz Movement" label, Hard Techno Hub 2025, sets, History of Schranz (2002)
    "Schranz": (
        ("Lightforce", "Join Me"), ("Jay P", "Free Murder"), ("Jay P", "This Is How We Party"),
        ("Lex Digital", "Rush"), ("Dstm", "Hellrave Machina"), ("RYX", "Alles Brennt"),
        ("NZGÛL", "In The Shadows"), ("TRIPTYKH", "Anomaly"), ("Psychotik", "Soulseeka"),
        ("TRIPTYKH", "Bass Keeps Going"), ("Mental Crush", "Bioshock"), ("Mental Crush", "Black Magic"),
        ("Chris Liebing", "Groove"), ("Michael Burkat", "Disorder"), ("Dominic Dilly", "Schranz"),
    ),
    # DJ Mag / Dummy / Electronic Beats / Serato. Acid house more than acid techno: 9 pairs only.
    "Acid techno": (
        ("Phuture", "Acid Tracks"), ("Adonis", "Too Far Gone"), ("Armando", "151"),
        ("Hardfloor", "Acperience 1"), ("Philippe Petit", "Attack"),
        ("Marcellus Pittman", "There's Somebody Out There"), ("Green Velvet", "Explorer"),
        ("Steve Poindexter", "Born To Freak"), ("Maurice Joshua", "This Is Acid"),
    ),
    # Plastikman: Sheet One / Consumed / Artifakts (BC) with Electronic Beats DJ picks, SoundOnSound
    "Minimal": (
        ("Plastikman", "Plasticity"), ("Plastikman", "Plasticine"), ("Plastikman", "Freek"),
        ("Plastikman", "Ask Yourself"), ("Plastikman", "Pakard"), ("Plastikman", "Rekall"),
        ("Plastikman", "Consumed"), ("Plastikman", "Psyk"),
    ),
    # Electronic Beats / Discogs / Wikipedia / Norman Records / AllMusic / RAG Music
    "Detroit": (
        ("Rhythim Is Rhythim", "Strings of Life"), ("Cybotron", "Clear"), ("Model 500", "No UFOs"),
        ("Model 500", "Night Drive"), ("Model 500", "Interference"), ("Model 500", "The Chase"),
        ("Inner City", "Good Life"), ("Fowlkes", "Goodbye Kiss"),
    ),
    # DJ Mag EBM 10 classics, Discogs, This Is Electronic Body Music
    "EBM": (
        ("DAF", "Der Mussolini"), ("DAF", "Verschwende Deine Jugend"), ("Front 242", "Headhunter"),
        ("Front 242", "Body to Body"), ("Front 242", "Operating Tracks"), ("Front 242", "Commando"),
        ("The Klinik", "Hours & Hours"), ("Nitzer Ebb", "Control"), ("Nitzer Ebb", "Hearts & Minds"),
        ("The Neon Judgement", "Chinese Black"), ("A Split-Second", "On Command"),
        ("Click Click", "Rorschach Testing"),
    ),
    # Plaid's list (Mixmag), Wikipedia (LP5), sources on Windowlicker
    "IDM": (
        ("Aphex Twin", "Windowlicker"), ("Aphex Twin", "Tha"), ("Squarepusher", "Do You Nnow Squarepusher"),
        ("Boards of Canada", "1969"), ("Autechre", "Drane2"),
    ),
    # DJ Brisk / Mixmag / Electronic Beats: Chicago, Dance Mania, French and Italian house lists below
    "Deep house": (
        ("Larry Heard", "Mystery of Love"), ("Larry Heard", "Can You Feel It"),
        ("Mr. White", "The Sun Can't Compare"), ("Chez Damier", "The Choice"),
        ("Kerri Chandler", "Bar-a-Thym"), ("Metro Area", "Miura"),
        ("Underground Resistance", "Timeline"), ("Hudson People", "Trip To Your Mind"),
        ("Black Rascals", "Keeping My Mind"), ("Schmoov!", "Playground"),
        ("Suba", "Felicidade"), ("Kink", "Bitter Sweet"),
    ),
    # Glitterbox / Roland / DJ Mag: French touch classics
    "French house": (
        ("Daft Punk", "Around the World"), ("Télépopmusik", "Breathe"), ("Together", "So Much Love To Give"),
        ("Bob Sinclar", "Gym Tonic"), ("Pepe Bradock", "Deep Burnt"), ("St. Germain", "Rose Rouge"),
        ("Modjo", "Lady (Hear Me Tonight)"), ("Alan Braxe & Fred Falke", "Intro"), ("Alex Gopher", "The Child"),
    ),
    # Steve Poindexter / Dance Mania (Ghetto Madness, Life in the Underground), Mixmag Chicago list
    "Ghetto house": (
        ("Steve Poindexter", "Work That Mutha Fucker"), ("DJ Deeon", "The Freaks"),
        ("Paul Johnson", "Give Me Ecstacy"), ("Tyree", "Nuthin' Wrong"), ("Parris Mitchell", "Ghetto Booty"),
    ),
    # OkayAfrica (DJ Lag & Rudeboyz), RA review of Citizen Boy & Mafia Boyz
    "Gqom": (
        ("DJ Lag", "iThuna"), ("DJ Lag", "Ice Drop"), ("Rudeboyz", "Japanese Sax"), ("Rudeboyz", "Get Down"),
        ("Citizen Boy & Mafia Boyz", "Night Cries"), ("Citizen Boy & Mafia Boyz", "Seasons"),
        ("Citizen Boy & Mafia Boyz", "WOZA"), ("Okmalumkoolkat", "Gqi"),
    ),
    # Complex / Red Bull / Glitterbox / Kraak & Smaak: Italo classics and Strut compilation
    "Italo disco": (
        ("Klein & MBO", "Dirty Talk"), ("Kano", "Another Life"), ("Baltimora", "Tarzan Boy"),
        ("Gazebo", "I Like Chopin"), ("Raf", "Self Control"), ("Helen", "Witch"), ("Charlie", "Spacer Woman"),
        ("Chrisma", "U (Part 2)"), ("Valentine", "Tina Are You Ready"), ("Number One Ensemble", "Flor De Coca"),
        ("Ryan Paris", "Dolce Vita"), ("Savage", "Don't Cry Tonight"), ("Ken Laszlo", "Tonight"),
    ),
    # Thomann / Complex / Snap! and Eurodance canon
    "Eurodance": (
        ("Darude", "Sandstorm"), ("Basshunter", "All I Ever Wanted"), ("Snap!", "Rhythm Is a Dancer"),
        ("Culture Beat", "Mr. Vain"), ("Haddaway", "What Is Love"), ("Mr. President", "Coco Jamboo"),
        ("ATC", "Around the World"), ("C+C Music Factory", "Gonna Make You Sweat (Everybody Dance Now)"),
        ("CeCe Peniston", "Finally"), ("Corona", "Rhythm of the Night"), ("La Bouche", "Be My Lover"),
        ("Dr. Alban", "It's My Life"),
    ),
    # Redbull Music Academy / Kraak & Smaak / Bandcamp / West End and Salsoul "Boogie Essentials"
    "Boogie": (
        ("D-Train", "Keep On"), ("Don Blackman", "Let Your Conscience Be Your Guide"), ("Chemise", "She Can't Love You"),
        ("Vaughan Mason & Crew", "Bounce, Rock, Skate, Roll"), ("Zapp", "Dance Floor"),
        ("D-Train", "You're the One for Me"), ("Evelyn Champagne King", "If You Want My Lovin'"),
        ("Steve Monite", "Only You"), ("Gwen Guthrie", "Seventh Heaven"), ("Prince", "Head"),
        ("Loose Ends", "Hanging on a String"),
    ),
    # Red Bull / Complex / Point Blank / Mixmag (UK garage essentials)
    "Two step": (
        ("Dem 2", "Destiny"), ("Tina Moore", "Never Gonna Let You Go"), ("MJ Cole", "Crazy Love"),
        ("Ms. Dynamite", "Booo!"), ("So Solid Crew", "21 Seconds"), ("Master Stepz", "Melody"),
        ("Groove Chronicles", "Stone Cold"), ("Active Minds", "Hobson's Choice"), ("Eliza Rose", "B.O.T.A."),
    ),
    # Vinyl Factory / Mixmag / Point Blank / Wikipedia (speed garage)
    "Speed garage": (
        ("187 Lockdown", "Gunman"), ("Double 99", "RIP Groove"), ("Tail Spin", "All Massive"),
        ("Livin' Large", "Feel Free"), ("49° South", "Love Somebody's Trigger Finger"),
        ("G.O.D", "Watch Ya Bass Bins"), ("G.O.D", "Unlimited"),
    ),
    # Plump DJs fan list (Discotech), Hybrid "Wide Angle", ILS
    "Nu breaks": (
        ("Plump DJs", "Nighthawk"), ("Plump DJs", "The Rub Off"), ("Plump DJs", "Scram"),
        ("Plump DJs", "Morning Sun"), ("Plump DJs", "Rocket Soul"), ("Plump DJs", "The Funk Hits the Fan"),
        ("Plump DJs", "System Addict"), ("Plump DJs", "You Will Remember My Name"), ("Plump DJs", "Soul Vibrates"),
    ),
    # Dummy (R3LL), Dancing Astronaut "10 Jersey Club Classics", FACT, Complex, NTS
    "Jersey club": (
        ("Dougie F & DJ Fire", "Back Up On It (Jasmine)"), ("DJ Tim Dolla", "Hey Ladies"),
        ("DJ Fresh", "Gitty Up"), ("DJ Frosty", "Ride That Wave"), ("Trippie Redd", "Love Scars"),
    ),
    # UKF, Serato, Dave Nada / DJ Ayres history
    "Moombahton": (
        ("Munchi", "Esta Noche"), ("Dillon Francis", "Masta Blasta"), ("Porter Robinson", "100% In The Bitch"),
    ),
    # Future bass: Emastered, Run The Trap, iSpy, Epidemic
    "Future bass": (
        ("Rustie", "After Light"), ("San Holo", "Light"), ("Louis The Child", "It's Strange"),
        ("RL Grime", "I Wanna Know"), ("Porter Robinson", "Sad Machine"), ("Marshmello", "Alone"),
        ("Flume", "Never Be Like You"),
    ),
    # Drum & bass / jungle --------------------------------------------------
    # DMY (Fabio), Mixmag (vocal liquid), Wikipedia (liquid DnB / High Contrast)
    "Liquid DnB": (
        ("Calibre", "Put That Woman First"), ("Marcus Intalex", "Temperance"), ("Calibre", "Mr Right On"),
        ("D.Kay", "It's On The Way"), ("Grooverider", "Charade"), ("Calibre", "Even If"),
        ("London Elektricity", "Just One Second"), ("Logistics", "The Trip"), ("Netsky", "Moving With You"),
        ("High Contrast", "If We Ever"), ("High Contrast", "Kiss Kiss Bang Bang"),
    ),
    # Red Bull, Time Out, Lee Gamble, UKF (jungle canon)
    "Jungle": (
        ("Dead Dred", "Dred Bass"), ("Tom & Jerry", "Maximum Style"), ("Renegade", "Terrorist"),
        ("Remarc", "RIP"), ("Dillinja", "The Angels Fell"), ("Splash", "Babylon"),
        ("Ed Rush", "The Force Is Electric (Remix)"), ("Randall", "Sound Control"),
        ("Origin Unknown", "Valley of the Shadows"), ("Wots My Code", "Dubplate"),
        ("Studio 2", "Who Jah Bless?"), ("Subnation", "Scottie"), ("DJ Crystl", "Warp Drive"),
        ("Dillinja", "Warrior"), ("Photek", "Rings Around Saturn"), ("Source Direct", "Snake Style"),
        ("Deep Blue & Blame", "Re-Transitions"), ("Andy C", "Cool Down"), ("Dillinja", "Sovereign Melody"),
        ("DJ Hype", "Dawn of the Fever"), ("Dope Skillz", "Yo Son"), ("Lennie De Ice", "We Are I.E."),
    ),
    # Serato DJ sets (frequency only, not a ranking)
    "Darkstep": (
        ("Noisia", "Dead Limit"), ("Noisia", "Dustup"), ("Noisia", "Anomaly"), ("Noisia", "Into Dust"),
        ("Noisia", "Incessant"), ("Current Value", "Act Up"), ("Current Value", "City Syndrome"),
        ("Current Value", "That Smile"), ("Current Value", "Reasonable Force"), ("Current Value", "Fuel Up"),
    ),
    # r/electronicmusic 2018 vote, Blog lists (Noisia / Black Sun Empire)
    "Neurofunk": (
        ("Black Sun Empire", "Arrakis"), ("Noisia", "Stigma"), ("Ed Rush", "Alien Girl"),
        ("Phace", "Cold Champagne"), ("Culprate", "Gaucho"), ("Phace", "Desert Orgy"),
    ),
    # Bass and dubstep ------------------------------------------------------
    # EDM.com / Magnetic: only three brostep tracks named: below ten.
    "Brostep": (
        ("Modestep", "Sunlight"), ("Knife Party", "Centipede"), ("Adventure Club", "Crave You"),
    ),
    # Source-named riddim tracks only: below ten.
    "Riddim": (
        ("Bommer & Crowell", "Yasuo"), ("Caspa & Rusko", "Riddem Again"), ("Jakes", "Doomsday Machina"),
        ("Phiso", "Jotaro"),
    ),
    # Glitch hop --------------------------------------------------------------
    "Glitch hop": (
        ("Tipper", "Ton Of Brix"), ("Savant", "Cult"), ("Pyramyth", "Cowbell Rock"),
    ),
    # Trance and psy --------------------------------------------------------
    # Karan Gill, Timewarp Records, Classic Goa Trax, Psynews
    "Goa": (
        ("Man With No Name", "Teleport"), ("Juno Reactor", "Pistolero (MWNN remix)"), ("Edi Mis", "The Big Glory"),
        ("GoAtma", "Listen"), ("Microdose", "Full Power"), ("Cosmic Dimension", "Voyage in the Universe"),
        ("Syrinx", "The Relief"), ("Andromeda", "Lifeform"),
        # Psynews "the best goa trance tracks - a list" (forum posts)
        ("Shakta", "Lepton Head"), ("Juno Reactor", "Masters of the Universe"), ("Juno Reactor", "Final Frontier"),
        ("Psykovsky", "Lastbus Madrus"), ("Hilight Tribe", "Shankara"), ("Filteria", "Wormhole"),
        ("Boris Blenn", "Electrogarden"), ("Pleiadians", "Starbase 11"), ("Astral Projection", "Visions of Nasca"),
        ("Astral Projection", "Mahadeva 99"), ("Electric Universe", "Nexus"), ("Electric Universe", "Electric Pulsation"),
        ("Material Music", "Divine Dance"), ("Doof", "Let's Turn On"), ("Tandu", "Alien Pump"),
        ("Infected Mushroom", "Facing"), ("Logic Bomb", "Mental Poison"), ("Psysex", "Experiental Procedure"),
    ),
    # t0x1c 2014 and Earthdance 2026 tracklists (fan sets, not a canon)
    "Hitech": (
        ("Virtuanoise", "Overload"), ("Arcek", "Dinamita"), ("Organoise", "Sky Tech"),
        ("Quantiko", "Synthwave"), ("Nibiru", "Neon"), ("Yatzee", "Awakening"),
    ),
    # Psynews forum threads ("give me your darkest darkpsy", "best dark psytrance with melodies"), Last.fm chart
    "Darkpsy": (
        ("Psykovsky", "Fungus Funk - Metropolis"), ("Cosmosis", "The Cave of Medusa"),
        ("Psykovsky", "P.S.Y. Love You"), ("Lexie Liu", "Deeper & Deeper"), ("Psykovsky", "Hellove Ja Wohl Yo"),
        ("Impaktronet", "Modulation"), ("Silent Horror", "Nemesis"), ("Xikwri", "Neyyra"), ("Bodhi", "13:20"),
        ("Osom", "Night Flirt"), ("Derango", "We're All Mad Here"), ("Xenomorph", "Shaari Avadon"),
        ("Terminator", "Triping Point"), ("Septagram", "Power Cell"), ("Cuboid Atom", "Mega Baffling"),
        ("Far East Ghost vs. Datakult", "Luciferian"), ("Psykovsky", "Wishful Sinful"),
        ("Dark Nebula", "Structural Failure"), ("Dark Nebula", "Cyber Cult"), ("Vegetal", "Free Thinkers are Dangerous"),
        ("Battle of the Future Buddhas", "Demonoizer"), ("Battle of the Future Buddhas", "Tigerhill"),
        ("Battle of the Future Buddhas", "Neuroglider"), ("Battle of the Future Buddhas", "Lord of the Dance"),
        ("Juno Reactor", "Children of the Night"), ("Encephalopaticys", "Psychotermic Meditation"),
    ),
    # Armada 100 Best Vocal Trance Classics, Mixmag 18, Armin van Buuren
    "Vocal trance": (
        ("Chakra", "Home"), ("Ascension", "Someone"), ("Armin van Buuren", "Sail"),
        ("Rui Da Silva", "Touch Me"), ("OceanLab", "Satellite"), ("Motorcycle", "As The Rush Comes"),
        ("York", "On The Beach"), ("Signum", "Coming On Strong"), ("Fragile", "Inertia"),
    ),
    # Armada / DJ Brisk / Anjunabeats playlist / Mixmag 15 (mid-90s)
    "Uplifting trance": (
        ("Chicane", "Saltwater"), ("System F", "Out of the Blue"), ("Delerium", "Silence"),
        ("Binary Finary", "1999"), ("Paul van Dyk", "For An Angel"), ("Robert Miles", "Children"),
        ("Energy 52", "Café Del Mar"), ("Da Hool", "Meet Her At The Love Parade"),
        ("Above & Beyond", "Blue Monday"), ("Angelic", "It's My Turn"),
    ),
    # Vinyl Factory (Nathan Micay), Mixmag, DJ Mag: prog trance from the early 90s
    "Prog trance": (
        ("Jam & Spoon", "The Age of Love"), ("Paul van Dyk", "For an Angel"), ("Josh Wink", "Higher State of Consciousness"),
        ("Sasha", "Xpander"), ("Vapourspace", "Gravitational Arch of 10"), ("Mystic Force", "Psychic Harmony"),
        ("Infected Mushroom", "Bust a Move"), ("Nathan Fake", "The Sky Was Pink"), ("Robert Miles", "Children"),
    ),
    # Gabber, hardcore, happy, industrial ------------------------------------
    # The Hard Data, DJ Mag, Wikipedia, CTM, Google Arts & Culture, Serato
    "Gabber": (
        ("Euromasters", "Amsterdam Waar Lech Dat Dan?"), ("Euromasters", "Alles Naar De Klote"),
        ("Rotterdam Termination Source", "Feyenoord Reactivate"), ("Rotterdam Termination Source", "Poing"),
        ("Human Resource", "Dominator"), ("Holy Noise", "James Brown is Still Alive"),
    ),
    # Angerfist: DJ Mag 2018, Wikipedia; Angerfist & Dr. Peacock: Serato
    "Terrorcore": (
        ("Angerfist", "Raise Your Fist For Angerfist"), ("Angerfist", "Pennywise"), ("Angerfist", "Knock Knock"),
        ("Angerfist", "Riotstarter"), ("Angerfist", "Dance with the Wolves"), ("Angerfist", "Messing With The Wrong Man"),
        ("Angerfist & Dr. Peacock", "Inframan"), ("Angerfist & Dr. Peacock", "Caveman"),
    ),
    # Last.fm frenchcore tag chart, sets 2023-2025
    "Frenchcore": (
        ("Dr. Peacock", "Trip to Valhalla"), ("Dr. Peacock", "Trip To Ireland"), ("Dr. Peacock", "Trip to Romania"),
        ("Dr. Peacock", "Take The Pills"), ("Sefa", "Dear God"), ("D-Sturb & Sefa", "Nothing Like The Old School"),
        ("Sefa & Crypton", "Nobody Knows"), ("Dr. Peacock & Sefa", "Everything Is A Lie"),
    ),
    # Serato sets, Deezer listing of Warface's album Rest In Pieces
    "Rawstyle": (
        ("Radical Redemption", "Cross of Blood"), ("Radical Redemption", "Brutal 4.0"),
        ("Radical Redemption", "Secret Syndicates"), ("Warface", "Down To Earth"), ("Warface", "LEVITATE"),
        ("Warface", "Sky Fall"), ("Warface", "Taste The Blade"),
    ),
    # Happy hardcore: DJ Brisk top 20, Retro Headz, Wikipedia, Beatport chart
    "Happy hardcore": (
        ("Hixxy & Sharkey", "Toy Town"), ("Dune", "Rainbow to the Stars"), ("DJ Stompy", "I Believe"),
        ("Force & Styles", "Apollo 13"), ("4 Tune Fairytales", "My Little Fantasy"), ("DJ Seduction", "So In Love"),
        ("SY & Unknown", "D-Day"), ("Eruption", "Let the Music"), ("DJ Codeine & Unknown", "Feel the Power"),
        ("DNA", "Go Insane"), ("Elysium", "Every Time I Close My Eyes"), ("Unknown & Temptation", "Feel It"),
        ("DJ Demand", "The Ultimate Seduction"),
    ),
    # Fan tracklists (Last.fm, Reddit-style): below ten
    "Crossbreed": (
        ("Crossbreed", "Seasons"), ("Crossbreed", "Underlined"), ("Crossbreed", "Pure Energy"),
        ("Crossbreed", "Severed"), ("Crossbreed", "Painted Red"), ("Crossbreed", "Machines"),
        ("Crossbreed", "Stem"), ("Crossbreed", "Release Me"),
    ),
    # Miro / Stickhead / Meta-Morph, Doomcore Records
    "Doomcore": (
        ("Miro", "Shining"), ("Stickhead & Don Demon", "Conquer The World"),
        ("Meta-Morph", "Through The Darkness Of Future Past"),
    ),
    # Mixmag (Schak's makina picks): below ten
    "Makina": (("Le Marrant", "Voulez Vous Un Rendez Vous (Happy Mix)"), ("Virthu", "All Rainbow")),
    # Djent, metal, hard rock ----------------------------------------------
    # Loudwire, Louder, Treble, metal reference lists
    "Death metal": (
        ("Sepultura", "Beneath the Remains"), ("Sepultura", "Inner Self"), ("Sepultura", "Mass Hypnosis"),
        ("Sepultura", "Primitive Future"), ("Entombed", "Left Hand Path"),
    ),
    # Mayhem / Emperor / Bathory / Burzum / Immortal / Darkthrone (WatchMojo, Loudwire, Heavy Music HQ)
    "Black metal": (
        ("Mayhem", "Freezing Moon"), ("Emperor", "I Am the Black Wizards"), ("Bathory", "Enter the Eternal Fire"),
        ("Burzum", "Dunkelheit"), ("Burzum", "Lost Wisdom"), ("Immortal", "The Sun No Longer Rises"),
        ("Darkthrone", "Transilvanian Hunger"), ("Darkthrone", "Skald av Satans Sol"),
        ("Samael", "Into the Pentagram"), ("Rotting Christ", "King of a Stellar War"),
    ),
    # Louder / Guitar World: heavy metal
    "Heavy metal": (
        ("Black Sabbath", "Iron Man"), ("Black Sabbath", "Planet Caravan"), ("Black Sabbath", "War Pigs"),
        ("Deep Purple", "Highway Star"), ("Metallica", "Master of Puppets"), ("Venom", "Breaking the Law"),
        ("Venom", "Living After Midnight"), ("Dio", "Rainbow in the Dark"), ("Dio", "Don't Talk to Strangers"),
        ("Iron Maiden", "The Trooper"), ("Megadeth", "Peace Sells"), ("Quiet Riot", "Cum On Feel the Noize"),
        ("Diamond Head", "Am I Evil?"),
    ),
    # Louder / TheTopTens / Loudwire thrash picks
    "Thrash": (
        ("Metallica", "For Whom the Bell Tolls"), ("Metallica", "Fade to Black"), ("Metallica", "Creeping Death"),
        ("Anthrax", "Caught in a Mosh"), ("Anthrax", "I Am the Law"), ("Testament", "Over the Wall"),
        ("Megadeth", "Hangar 18"), ("Megadeth", "Tornado of Souls"), ("Kreator", "Pleasure to Kill"),
        ("Sodom", "Nuclear Winter"), ("Dark Angel", "The Burning of Sodom"), ("Overkill", "Elimination"),
    ),
    # Noecho, Treble, Metal Injection doom picks
    "Doom": (
        ("Evoken", "A Caress of the Void"), ("Swallow the Sun", "The Ship"), ("The Fall of Every Season", "From Below"),
        ("Woods of Ypres", "Distractions of Living Alone"), ("Candlemass", "Dark Are the Veils of Death"),
        ("Candlemass", "Dark Reflections"), ("Black Sabbath", "Black Sabbath"),
    ),
    # Djent (Loudwire, Louder, TVTropes, Metal Music Archives)
    "Djent": (
        ("Meshuggah", "Soul Burn"), ("Meshuggah", "Bleed"), ("Meshuggah", "Closed Eye Visuals"),
        ("SikTh", "Hold My Finger"), ("SikTh", "Skies of the Millennium Night"), ("Textures", "Laments of an Icarus"),
        ("Periphery", "Zyglrox"), ("Chimp Spanner", "Bad Code"), ("The Algorithm", "Isometry"),
        ("Animals as Leaders", "Arithmophobia"), ("Destiny Potato", "Addict"), ("TesseracT", "Luminary"),
    ),
    # Metalcore / deathcore (The Agony Scene, Alt Press, VH1, Louder)
    "Metalcore": (
        ("Killswitch Engage", "The End of Heartache"), ("Killswitch Engage", "Fixation on the Darkness"),
        ("Hatebreed", "Proven"), ("Bleeding Through", "Love Lost in a Hail of Gunfire"),
        ("Poison the Well", "Meeting Again for the First Time"), ("Bullet for My Valentine", "Tears Don't Fall"),
        ("Zao", "Savannah"), ("Drop Dead, Gorgeous", "Dressed for Friend Requests"),
        ("Woe, Is Me", "[&] Delinquents"), ("Iwrestledabearonce", "Tastes Like Kevin Bacon"),
    ),
    # Louder / Metal Injection (Suicide Silence, Whitechapel)
    "Deathcore": (
        ("Suicide Silence", "No Pity for a Coward"), ("Suicide Silence", "Unanswered"),
        ("Whitechapel", "Breeding Violence"), ("Job for a Cowboy", "Entombment of a Machine"),
        ("Chelsea Grin", "Cheyne Srokes"), ("Chelsea Grin", "Crewcabanger"),
    ),
    # Power and symphonic metal (Louder, Impericon, Nuclear Blast, Loudwire)
    "Power metal": (
        ("Helloween", "Future World"), ("Helloween", "Halloween"), ("Helloween", "A Tale That Wasn't Right"),
        ("DragonForce", "Through The Fire And Flames"), ("DragonForce", "Operation Ground And Pound"),
        ("Avantasia", "Reach Out For The Light"), ("Avantasia", "Farewell"), ("Avantasia", "Sign Of The Cross"),
        ("Nightwish", "FantasMic"), ("Nightwish", "Wishmaster"),
    ),
    "Symphonic metal": (
        ("Nightwish", "Wish I Had an Angel"), ("Nightwish", "Amaranth"), ("Nightwish", "The Phantom of the Opera"),
        ("Nightwish", "Élan"), ("Nightwish", "Bye Bye Beautiful"), ("Nightwish", "Storytime"),
        ("Therion", "To Mega Therion"),
    ),
    # Melvins / Black Flag: Louder beginner guide and Treble
    "Sludge": (
        ("Melvins", "Hooch"), ("Melvins", "Honey Bucket"), ("Melvins", "Lizzy"), ("Melvins", "Eye Flys"),
        ("Black Flag", "Nothing Left Inside"), ("Black Flag", "Three Nights"), ("Black Flag", "Scream"),
    ),
    # Louder, Treble and Metal Hammer picks for nu metal: below ten
    "Nu metal": (
        ("Korn", "Blind"), ("Korn", "Freak on a Leash"), ("Korn", "Got the Life"),
        ("Deftones", "My Own Summer (Shove It)"), ("Deftones", "Mascara"),
        ("Disturbed", "Down With the Sickness"), ("Drowning Pool", "Bodies"),
        ("Linkin Park", "One Step Closer"), ("Slipknot", "Spit It Out"), ("Slipknot", "Wait and Bleed"),
        ("Limp Bizkit", "Break Stuff"), ("Coal Chamber", "Loco"), ("Crazy Town", "Butterfly"),
        ("Incubus", "Drive"), ("Machine Head", "Crashing Around You"), ("Soulfly", "Bleed"),
        ("Spineshank", "New Disease"), ("Taproot", "Poem"),
    ),
    # Louder / Metal Hammer / Treble guitar riff lists
    "Pop punk": (
        ("Blink-182", "All the Small Things"), ("Green Day", "Longview"), ("Paramore", "Misery Business"),
        ("Jimmy Eat World", "The Middle"), ("MxPx", "Punk Rawk Show"), ("All Time Low", "Dear Maria, Count Me In"),
        ("New Found Glory", "My Friend's Over You"), ("The Starting Line", "Best of Me"),
        ("Set Your Goals", "Mutiny!"), ("Four Year Strong", "Heroes Get Remembered, Legends Never Die"),
        ("The Ataris", "San Dimas High School Football Rules"), ("Fall Out Boy", "Sugar, We're Goin Down"),
        ("Ramones", "Blitzkrieg Bop"), ("Descendents", "Suburban Home"), ("Buzzcocks", "What Do I Get?"),
    ),
    # Rock and punk --------------------------------------------------------
    # Treble / BrooklynVegan / Stereogum / Paste grunge lists
    "Grunge": (
        ("Nirvana", "Smells Like Teen Spirit"), ("Nirvana", "Come As You Are"), ("Nirvana", "Blew"),
        ("Soundgarden", "Black Hole Sun"), ("Mother Love Bone", "Crown of Thorns"), ("Paw", "Jessie"),
        ("Mudhoney", "Touch Me I'm Sick"), ("Alice in Chains", "Down in a Hole"),
    ),
    # Loudersound / PopMatters / Far Out / Culture Catch
    "Prog rock": (
        ("Pink Floyd", "Money"), ("Pink Floyd", "Time"), ("Pink Floyd", "Us and Them"), ("Pink Floyd", "Fearless"),
        ("Yes", "And You and I"), ("Yes", "Siberian Khatru"), ("Yes", "Starship Trooper"),
        ("Genesis", "Firth of Fifth"), ("King Crimson", "21st Century Schizoid Man"), ("King Crimson", "Trio"),
        ("Gentle Giant", "The Advent of Panurge"),
    ),
    # American Songwriter, Far Out, Treble (psych 1967-68)
    "Psych rock": (
        ("Pink Floyd", "Interstellar Overdrive"), ("Tomorrow", "My White Bicycle"), ("Tintern Abbey", "Vacuum Cleaner"),
        ("The Jimi Hendrix Experience", "Purple Haze"), ("Jefferson Airplane", "White Rabbit"),
        ("The Doors", "Light My Fire"), ("Cream", "Sunshine of Your Love"), ("Pink Floyd", "Astronomy Domine"),
    ),
    # Garage rock: Paul Revere & the Raiders, The Belles, The Sonics, The Nashville Teens
    "Garage rock": (
        ("Paul Revere & the Raiders", "Kicks"), ("The Belles", "Melvin"), ("The Nashville Teens", "Tobacco Road"),
        ("The Del-Vetts", "Last Time Around"), ("The Sonics", "Strychnine"), ("The Sonics", "Psycho"),
        ("The Sonics", "The Witch"), ("13th Floor Elevators", "You're Gonna Miss Me"),
    ),
    # Minor Threat, Negative Approach, Dead Kennedys (xXx Fanzine, Treble, Miami New Times, Salt Lake City)
    "Hardcore punk": (
        ("Minor Threat", "Look Back and Laugh"), ("Minor Threat", "I Don't Want To Hear It"),
        ("Negative Approach", "Evacuate"), ("G.I.S.M.", "Endless Blockade For The Pussyfooter"),
        ("Jerry's Kids", "I Don't Belong"), ("Husker Du", "Real World"), ("Bad Brains", "Attitude"),
        ("Black Flag", "Rise Above"), ("Dead Kennedys", "Kill The Poor"), ("Dead Kennedys", "Drug Me"),
        ("Dead Kennedys", "Chemical Warfare"), ("The Germs", "Lexicon Devil"), ("Circle Jerks", "Question Authority"),
        ("Murphy's Law", "Sit Home and Rot"), ("Agent Orange", "Bloodstains"), ("Circle Jerks", "Wild In The Streets"),
        ("Adolescents", "I Hate Children"), ("Middle Class", "Out Of Vogue"), ("Suicidal Tendencies", "Fascist Pig"),
    ),
    # Post-punk: Far Out 40, Deezer playlist, Days of Punk, Rough Trade
    "Post punk": (
        ("Joy Division", "Love Will Tear Us Apart"), ("Joy Division", "Disorder"), ("Gang of Four", "Damaged Goods"),
        ("The Fall", "Totally Wired"), ("Talking Heads", "Once in a Lifetime"), ("The Cure", "A Forest"),
        ("Echo & the Bunnymen", "The Killing Moon"), ("New Order", "Ceremony"), ("Television", "Marquee Moon"),
        ("Siouxsie and the Banshees", "Spellbound"), ("Public Image Ltd.", "Public Image"),
        ("Bauhaus", "Bela Lugosi's Dead"),
    ),
    # Gothic and darkwave ---------------------------------------------------
    # Side-Line, Dark Entries (Josh Cheon), Treble, American Songwriter
    "Darkwave": (
        ("Depeche Mode", "Blasphemous Rumours"), ("Dead Can Dance", "Opium"), ("Molchat Doma", "Sudno"),
        ("Martin L. Gore", "Compulsion"), ("Clan of Xymox", "Call it Weird"), ("Ministry", "Revenge"),
        ("Cetu Javu", "Situations"),
    ),
    # American Songwriter / Treble on goth; Nick Cave / Christian Death
    "Gothic": (
        ("The Cure", "A Forest"), ("Bauhaus", "Bela Lugosi's Dead"), ("Type O Negative", "Haunted"),
        ("Christian Death", "Romeo's Distress"), ("Nick Cave", "The Mercy Seat"),
    ),
    # Pseudo Code / LTM Belgian coldwave (below ten)
    "Coldwave": (("Pseudo Code", "Around Midnight"), ("Coldreams", "Bulbs and Bubbles")),
    # Salem, oOoOO, White Ring, Balam Acab (NTS guide, r/electronicmusic vote)
    "Witch house": (
        ("Salem", "King Night"), ("Salem", "Better Off Alone"), ("Salem", "Asia"), ("Salem", "Not Much Of A Life"),
        ("oOoOO", "Hearts"), ("oOoOO", "Sirens"), ("White Ring", "King"), ("White Ring", "IxC999"),
        ("Crim3s", "Still Goin"), ("Crim3s", "Lost"), ("Holy Other", "Know Where"), ("Balam Acab", "See Birds (Moon)"),
        ("Purity Ring", "Fineshrine"),
    ),
    # Dark ambient and drone ------------------------------------------------
    # Reddit DarkAmbient wiki, forum picks; tracks only
    "Dark ambient": (
        ("Tangerine Dream", "Zeit"), ("Kammarheit", "Asleep And Well Hidden"), ("Stig Berg", "Passage Nacrastan"),
        ("Stig Berg", "Lilin"), ("Konau", "Contemplation"), ("Konau", "Crawling Darkness"),
    ),
    # Andrew Frost (The Art Life), Sonic State: tracks named in the search only
    "Drone": (("Pelt", "Empty Bell Ringing In The Sky"), ("Terry Riley", "Poppy Nogood and the Phantom Band")),
    # Serious minimalism -----------------------------------------------------
    "Minimalism": (
        ("Steve Reich", "Piano Phase"), ("Terry Riley", "In C"), ("Philip Glass", "Music in Fifths"),
        ("Philip Glass", "Music in Similar Motion"), ("Steve Reich", "Electric Counterpoint"),
    ),
    # Jazz, swing, blues, folk -----------------------------------------------
    # 100 Greatest Swing Era Songs, Berklee list, Amazon "Best of Big Bands" set
    "Swing": (
        ("Benny Goodman", "Sing, Sing, Sing"), ("Benny Goodman", "Don't Be That Way"), ("Glenn Miller", "In the Mood"),
        ("Tommy Dorsey", "Opus One"), ("Duke Ellington", "Take the 'A' Train"), ("Duke Ellington", "Caravan"),
        ("Count Basie", "One O'Clock Jump"), ("Ella Fitzgerald", "Tain't What You Do (It's the Way That You Do It)"),
        ("Cab Calloway", "Minnie the Moocher"), ("Django Reinhardt", "Minor Swing"), ("Django Reinhardt", "Swing 42"),
        ("Billie Holiday", "Summertime"), ("Billie Holiday", "God Bless the Child"), ("Louis Armstrong", "Mack the Knife"),
        ("Fats Waller", "Ain't Misbehavin'"), ("Judy Garland", "Over the Rainbow"),
    ),
    # Amazon "Best of Big Bands", Sony Essential Big Bands (1991), university playlist
    "Big band": (
        ("Benny Goodman", "Sing, Sing, Sing"), ("Glenn Miller", "In the Mood"), ("Glenn Miller", "A String of Pearls"),
        ("Duke Ellington", "Take the 'A' Train"), ("Count Basie", "One O'Clock Jump"), ("Artie Shaw", "Begin the Beguine"),
        ("Benny Goodman", "Blue Skies"), ("Woody Herman", "At the Woodchopper's Ball"), ("Woody Herman", "Four Brothers"),
        ("Duke Ellington", "Satin Doll"), ("Count Basie", "Squeeze Me"), ("Harry James", "Sugar Foot Stomp"),
        ("Charlie Barnet", "Skyliner"),
    ),
    # Playlists and editorial picks: below ten
    "Smooth jazz": (
        ("Sade", "Smooth Operator"), ("Bob James", "Since I Fell For You"), ("Incognito", "Pieces of a Dream"),
        ("Earl Klugh", "Acoustic Lady"), ("Earl Klugh", "Alicia"),
    ),
    # 33 1/3 / crowd list / Treble
    "Jazz fusion": (
        ("Miles Davis", "Pharoah's Dance"), ("Weather Report", "Birdland"), ("Freddie Hubbard", "Red Clay"),
        ("Pat Metheny Group", "Last Train Home"),
    ),
    # Bebop: Jazzadvice 30 tunes, Quora recordings
    "Bebop": (
        ("Charlie Parker", "Billie's Bounce"), ("Charlie Parker", "Ornithology"), ("Charlie Parker", "Scrapple from the Apple"),
        ("Charlie Parker", "Yardbird Suite"), ("Charlie Parker", "Confirmation"), ("Charlie Parker", "Donna Lee"),
        ("Dizzy Gillespie", "Groovin' High"), ("Thelonious Monk", "'Round Midnight"), ("Thelonious Monk", "Now's the Time"),
    ),
    # Mississippi Delta: AOL 25, Paste 15, Rough Guide to Legends
    "Delta blues": (
        ("Mississippi John Hurt", "Spike Driver Blues"), ("Charley Patton", "Mississippi Boweavil Blues"),
        ("Son House", "Walking Blues"), ("Elmore James", "Dust My Broom"), ("Geeshie Wiley", "Last Kind Words Blues"),
        ("Skip James", "Devil Got My Woman"), ("Tommy Johnson", "Cool Drink Of Water Blues"),
    ),
    # Essential Guide to Bluegrass, Totally Essential Bluegrass, American Songwriter
    "Bluegrass": (
        ("Flatt & Scruggs", "Foggy Mountain Breakdown"), ("Bill Monroe", "Blue Moon of Kentucky"),
        ("The Stanley Brothers", "Man of Constant Sorrow"), ("Eric Weissberg", "Dueling Banjos"),
        ("Bill Monroe", "Uncle Pen"), ("Bill Monroe", "Muleskinner Blues"), ("The Stanley Brothers", "Molly & Tenbrooks"),
        ("Bill Monroe", "In the Pines"), ("Flatt & Scruggs", "Foggy Mountain Special"), ("The Bailey Brothers", "John Henry"),
    ),
    # Louder / American Songwriter (singer-songwriter standards)
    "Singer songwriter": (
        ("Bob Dylan", "Lay Lady Lay"), ("Bob Dylan", "Tangled Up In Blue"), ("Bob Dylan", "Shelter From The Storm"),
        ("Simon & Garfunkel", "The Sound of Silence"), ("Simon & Garfunkel", "Mrs. Robinson"),
    ),
    # Latin, world and dance ----------------------------------------------
    # Gardel and Piazzolla in the 50 Essential Tangos and Songlines lists
    "Tango": (
        ("Carlos Gardel", "Volver"), ("Carlos Gardel", "Soledad"), ("Carlos Gardel", "Lejana Tierra Mia"),
        ("Astor Piazzolla", "Adiós Nonino"), ("Astor Piazzolla", "Vuelvo al Sur"), ("Astor Piazzolla", "Tanguedia 3"),
        ("Julio De Caro", "Flores Negras"), ("Julio De Caro", "Copacabana"),
    ),
    # Billboard (classic salsa), Al Día, Héctor Lavoe
    "Salsa": (
        ("Héctor Lavoe", "Periódico de Ayer"), ("Héctor Lavoe", "El Cantante"), ("Héctor Lavoe", "Mi Gente"),
        ("Fruko y Sus Tesos", "El Preso"), ("La Sonora Ponceña", "Fuego en el 23"),
        ("Kings of Salsa", "Sonido Bestial"), ("Grupo Niche", "Cali Pachanguero"), ("Celia Cruz", "La Negra Tiene Tumbao"),
    ),
    # Vinyl Factory 20 essential records, cumbia.fm 2026 playlist
    "Cumbia": (
        ("Los Palmeras", "El Pescador"), ("Los Ángeles Azules", "Nunca Es Suficiente"),
        ("Grupo Cañaveral de Humberto Pabón", "Amor de Lejos"), ("Los Ángeles Azules", "17 Años"),
        ("Los Ángeles Azules", "Como Te Voy a Olvidar"),
    ),
    # Brazilian samba lists (Culture Trip, Calpoly, Latino Life)
    "Samba": (
        ("Ary Barroso", "Aquarela do Brasil"), ("Jorge Ben Jor", "Mas Que Nada"), ("Demônios da Garoa", "Trem das Onze"),
        ("Alcione", "Não Deixe o Samba Morrer"), ("Beth Carvalho", "Ainda é Tempo pra Ser Feliz"),
        ("Reinaldo", "Retrato Cantado de um Amor"),
    ),
    # Rough Guide, Rocksteady compilations, classified mix
    "Rocksteady": (
        ("Hopeton Lewis", "Take It Easy"), ("The Paragons", "The Tide Is High"), ("Roy Shirley", "Hold Them"),
        ("Phyllis Dillon", "Don't Stay Away"), ("Keith & Tex", "Stop That Train"), ("Delroy Wilson", "I Don't Know Why"),
        ("Cliff & the Diamonds", "Mother Benge"), ("Alton Ellis", "Girl I've Got a Date"),
        ("The Melodians", "Last Train to Expo '67"),
    ),
    # Fela Kuti / Koola Lobitos from the Treble guide and Vinyl Factory (below ten)
    "Afrobeat": (("Koola Lobitos", "Highlife Time"), ("Fela Kuti", "Fight to Finish"), ("Fela Kuti", "Expensive Shit")),
    # Zikoko, Vinyl Factory, Songlines, Starr FM (Ghana)
    "Highlife": (
        ("Bobby Benson", "Taxi Driver"), ("Victor Olaiya", "Mofe Mu'yan"), ("Oliver De Coque", "Identity"),
        ("Chief Osita Osadebe", "Osondi Owendi"), ("Sir Victor Uwaifo", "Joromo"), ("Koo Nimo", "Yaa Amponsah"),
        ("Ebo Taylor", "Love and Death"), ("E.T. Mensah", "All For You"), ("F Kenya", "Nzema Kotoko"),
        ("Daddy Lumba", "Aben Wo Ha"),
    ),
    # Blog top-10, Deezer 100% Kizomba Vol. 1, DJ mixes
    "Kizomba": (
        ("Daniel Santacruz", "Lento"), ("Stony", "Danca Kizomba"), ("Djodje", "I.L.Y."), ("Master Jake", "Jajão"),
        ("Nelson Freitas", "You're So Hot"), ("Anselmo Ralph", "Como Te Sentes Tu?"), ("Johnny Ramos", "My Lady"),
        ("Anselmo Ralph", "Te Vais Lembrar de Mim"), ("Nelson Freitas", "Bo Tem Mel"), ("Nelson Freitas", "Essa Mboa"),
    ),
    # Umm Kulthum, Fairuz (Arabic canon from album-level sources)
    "Arabic": (
        ("Umm Kulthum", "Raqq Il-Habib"), ("Umm Kulthum", "Al-Atlal"), ("Fairuz", "Zahrat al-Mada'en"),
        ("Fairuz", "Habbaytak Bissayf"), ("Fairuz", "Biktub Ismak"), ("Fairuz", "Barda"),
    ),
    # Planxty, Clannad (Planète Celtique, ThistleRadio)
    "Celtic": (
        ("Planxty", "The Cliffs of Dooneen"), ("Planxty", "The Jolly Beggar"), ("Planxty", "As I Roved Out"),
        ("Clannad", "Newgrange"), ("Clannad", "Skellig"), ("Clannad", "Theme From Harry's Game"),
        ("Clannad", "The Lish Young Buy-a-Broom"),
    ),
    # Billboard, Rolling Stone and Remezcla lists
    "Latin pop": (
        ("Ricky Martin", "Livin' la Vida Loca"), ("Santana", "Oye Como Va"), ("Ritchie Valens", "La Bamba"),
        ("Gloria Estefan", "Conga"), ("Selena", "Como la Flor"), ("Luis Miguel", "La Incondicional"),
        ("Los del Río", "La Macarena"), ("Aventura", "Obsesión"), ("Shakira", "Hips Don't Lie"),
        ("Luis Fonsi", "No Me Doy Por Vencido"), ("Nicky Jam", "El Perdón"),
    ),
    # Edith Piaf, Aznavour, Montand, Chevalier, Brassens, Ferré (chartsinfrance 100)
    "Chanson": (
        ("Édith Piaf", "La Vie En Rose"), ("Édith Piaf", "Non, Je Ne Regrette Rien"), ("Édith Piaf", "Hymne À L'Amour"),
        ("Charles Aznavour", "Tu t'laisses aller"), ("Johnny Hallyday", "L'idole des jeunes"),
        ("Yves Montand", "Les feuilles mortes"), ("Maurice Chevalier", "Ça sent si bon la France"),
        ("Joséphine Baker", "C'est lui"), ("Bourvil", "A bicyclette"), ("Georges Brassens", "Les amoureux des bancs publics"),
        ("Léo Ferré", "Le pont Mirabeau"), ("Nino Ferrer", "Le sud"), ("Claude François", "Chanson populaire"),
    ),
    # Udo Jürgens, Roy Black, Helene Fischer and the German top-100 lists
    "Schlager": (
        ("Udo Jürgens", "Griechischer Wein"), ("Udo Jürgens", "Mit 66 Jahren"), ("Roy Black", "Ganz in Weiß"),
        ("Fred Bertelsmann", "Der lachende Vagabund"), ("Freddy Quinn", "Junge, komm bald wieder"),
        ("Daniel Gerard", "Butterfly"), ("Roy Black & Anita", "Schön ist es, auf der Welt zu sein"),
        ("Peter Maffay", "Du"), ("Nicole", "Ein bisschen Frieden"), ("Roland Kaiser", "Joana"),
        ("Dschinghis Khan", "Moskau"), ("Helene Fischer", "Atemlos durch die Nacht"),
        ("DJ Ötzi", "Ein Stern (der deinen Namen trägt)"), ("Michael Holm", "Mendocino"),
    ),
    # Hip-hop, R&B, funk, electronic and party ------------------------------
    # Rock the Bells, BrooklynVegan (Andrew Bailey's list), Serato classics
    "Boom bap": (
        ("Jeru the Damaja", "You Can't Stop the Prophet"), ("E.C. Illa", "On Ill"), ("Blahzay Blahzay", "Good Cop / Bad Cop"),
        ("Smif-n-Wessun", "Bucktown"), ("Souls of Mischief", "Cab Fare"),
    ),
    # Stormzy-era UK drill: Dummy (67), Capital XTRA, Gigwise, Vice
    "UK drill": (
        ("Stickz", "Let's Get It"), ("Grizzy", "Look Like You"), ("67", "Live Corn"), ("Young Teflon", "Nandos"),
        ("Loski", "Hazard"), ("Reekz", "War Spelt Backwards"), ("DigDat", "Air Force"), ("Headie One", "The Jugg"),
        ("M Huncho", "Take Away The Pain"), ("67", "Things & Stuff"), ("Loski", "Money and Beef"),
        ("Harlem Spartans", "Riders"), ("Digga D", "Woi"),
    ),
    # NTS guides, Serato, Mixmag: cloud rap canon
    "Cloud rap": (
        ("Lil B", "I'm God"), ("SpaceGhostPurrp", "R.I.P. Actavis"), ("Main Attrakionz", "Have Funds"),
        ("Xavier Wulf", "Kemuri"), ("Ecco2k", "HOLDMEDOWNLIKEGRAVITY"), ("A$AP Rocky", "Peso"), ("Yung Lean", "Hurt"),
        ("Yung Lean", "Gatorade"), ("Yung Lean", "Kyoto"), ("Bladee", "Into Dust"), ("Playboi Carti", "Middle of the Summer"),
    ),
    # The Hard Times, Tildes, XXL (emo-leaning rap)
    "Emo rap": (
        ("guccihighwaters", "Hurt Before"), ("Nothing, Nowhere", "Hammer"), ("Savage Ga$p", "Pumpkins Scream in the Dead of Night"),
        ("Convolk", "Get Lost"), ("XXXTentacion", "Jocelyn Flores"), ("Lil Uzi Vert", "XO Tour Llif3"),
        ("Trippie Redd", "Love Scars"), ("Post Malone", "I Fall Apart"), ("Juice WRLD", "Lucid Dreams"), ("Joji", "Will He"),
    ),
    # NTS guide, Dr Dre era: G-funk canon (OkayPlayer, FACT, FADER)
    "G funk": (
        ("Dr. Dre", "Nuthin' But a G Thang"), ("Warren G", "Regulate"), ("Dr. Dre", "Deep Cover"),
        ("Snoop Dogg", "Gin and Juice"), ("DJ Quik", "Tonite"), ("Nate Dogg", "Never Leave Me Alone"),
        ("Ice Cube", "You Know How We Do It"), ("Shade Sheist", "Where I Wanna Be"), ("Hostyle", "Friday Night"),
    ),
    # Grime: MusicTech, Stereogum, Highsnobiety, The Source
    "Grime": (
        ("Wiley", "Eskimo"), ("Dizzee Rascal", "I Luv U"), ("Kano", "P's & Q's"), ("XTC", "Functions on the Low"),
        ("Lethal Bizzle", "Pow"), ("Roll Deep", "When I'm 'Ere"), ("Musical Mob", "Pulse X"),
    ),
    # Dembow: Istituto Marangoni, AUB Graduate School list (Shabba Ranks, Nando Boom…)
    "Dembow": (
        ("Shabba Ranks", "Dem Bow"), ("Nando Boom", "Ellos Benia Dem Bow"), ("El General", "Te Ves Buena"),
        ("Ivy Queen", "Yo Quiero Bailar"), ("Lorna", "Papi Chulo"),
    ),
    # Electronic Beats / Odyssey / Richmond playlist / Dailylobo / Blog picks
    "Vaporwave": (
        ("Vaperror", "Pretty Beam (Computer Love)"), ("Vaperror", "Error on the Dance Floor"), ("Vaperror", "Krystal GB"),
        ("Blank Banshee", "Wavestep"), ("Blank Banshee", "Hyper Object"), ("Blank Banshee", "Dreamcast"),
        ("Blank Banshee", "LSD Polyphony"), ("Sunset Rollercoaster", "Villa"), ("Limes", "Jovial"),
        ("Desired", "Crystal Tokyo"), ("Hotel Pools", "Coast"), ("Windows96", "Rituals"),
        ("Memorex Memories", "Thanks For Listening"), ("Mariya Takeuchi", "Plastic Love"),
    ),
    # Plastic Love, Mayonaka no Door, Tatsuro Yamashita: City pop sources (Goosebumps Radio, Electronic Beats)
    "City pop": (
        ("Mariya Takeuchi", "Plastic Love"), ("Miki Matsubara", "Mayonaka no Door (Stay With Me)"),
        ("Tatsuro Yamashita", "Christmas Eve"), ("Tatsuro Yamashita", "Sparkle"), ("Junko Ohashi", "Telephone Number"),
        ("Junko Yagami", "Communication"), ("Kingo Hamada", "Machi No Dorufin"), ("Yumi Arai", "Chuo Freeway"),
    ),
    # Soul, R&B and pop ----------------------------------------------------
    # Capital FM 90s list, Trouvelagroove, Essence
    "Neo soul": (
        ("D'Angelo", "Brown Sugar"), ("D'Angelo", "Untitled (How Does It Feel)"), ("Erykah Badu", "On & On"),
        ("Erykah Badu", "Otherside of the Game"), ("Erykah Badu", "Bag Lady"), ("Maxwell", "Ascension (Don't Ever Wonder)"),
        ("Maxwell", "Sumthin Sumthin"), ("Jill Scott", "A Long Walk"), ("Jill Scott", "Doo Wop (That Thing)"),
        ("Jill Scott", "Ex-Factor"), ("Lauryn Hill", "Nothing Even Matters"), ("Joe", "All That I Am"),
        ("Anthony Hamilton", "Nobody Else"), ("Tony! Toni! Toné!", "Lay Your Head on My Pillow"),
    ),
    # UDiscover, USA Today, Essence Motown lists
    "Motown": (
        ("Marvin Gaye", "I Heard It Through the Grapevine"), ("The Supremes", "Baby Love"),
        ("Stevie Wonder", "Superstition"), ("Martha & The Vandellas", "Dancing in the Street"),
        ("The Temptations", "Papa Was a Rollin' Stone"), ("The Marvelettes", "Please Mr. Postman"),
        ("The Jackson 5", "I Want You Back"),
    ),
    # Synthpop: Treble 50, Synthtopia 25, Electrozombies, American Songwriter
    "Synthpop": (
        ("Kraftwerk", "The Model"), ("Donna Summer", "I Feel Love"), ("Gary Numan", "Cars"),
        ("The Human League", "Don't You Want Me"), ("New Order", "Blue Monday"), ("New Order", "True Faith"),
        ("Depeche Mode", "Just Can't Get Enough"), ("Visage", "Fade to Grey"), ("Yazoo", "Don't Go"),
        ("Eurythmics", "Sweet Dreams"), ("Blondie", "Heart of Glass"), ("OMD", "Electricity"),
        ("Jean-Michel Jarre", "Oxygène, Pt. 4"), ("Gershon Kingsley", "Popcorn"),
    ),
    # Cocteau Twins, The Church, Mazzy Star, Julee Cruise, The Sundays (blogs, reviews)
    "Dream pop": (
        ("Cocteau Twins", "Iceblink Luck"), ("Cocteau Twins", "I Wear Your Ring"), ("Cocteau Twins", "Wolf in the Breast"),
        ("This Mortal Coil", "Song to the Siren"), ("The Church", "Under the Milky Way"), ("Mazzy Star", "Ghost Highway"),
        ("Mazzy Star", "She Hangs Brightly"), ("Mazzy Star", "I'm Sailin'"), ("Julee Cruise", "Falling"),
        ("Julee Cruise", "Floating"), ("The Sundays", "Here's Where the Story Ends"), ("The Sundays", "Can't Be Sure"),
        ("Mojave 3", "Love Songs on the Radio"), ("A.R. Kane", "When You're Sad"), ("The Ocean Blue", "Ballerina Out of Control"),
        ("Saint Etienne", "California Snow Story"),
    ),
    # Treble, DJ Mag, SONY: hyperpop picks from articles and playlists
    "Hyperpop": (
        ("100 gecs", "money machine"), ("Hannah Diamond", "Drop FM"), ("SOPHIE", "Nothing More To Say"),
        ("Bladee", "Sun"), ("Gupi & Fraxiom", "Thos Moser"), ("M.I.A.", "XXXO"), ("Gwen Stefani", "Bubble Pop Electric"),
    ),
    # Marie Claire, Vox, Soompi, Digital Trends
    "K-pop": (
        ("Seo Taiji and Boys", "I Know"), ("H.O.T.", "Candy"), ("DBSK", "Hug"), ("DBSK", "Mirotic"),
        ("SHINee", "Sherlock"), ("SHINee", "Replay"), ("SHINee", "Lucifer"), ("miss A", "Bad Girl, Good Girl"),
        ("2NE1", "I Am The Best"), ("KARA", "Step"), ("Girls' Generation", "Into the New World"),
        ("PSY", "Gangnam Style"), ("Fin.K.L", "Eternal Love"), ("BoA", "No.1"), ("Jinusean", "Tell Me"),
    ),
    # Trip hop: Massive Attack and Portishead (Far Out, Treble, UDiscover, Reddit poll)
    "Trip hop": (
        ("Massive Attack", "Unfinished Sympathy"), ("Massive Attack", "Safe From Harm"),
        ("Massive Attack", "Hymn of the Big Wheel"), ("Massive Attack", "Protection"), ("Massive Attack", "Karmacoma"),
        ("Portishead", "Sour Times"), ("Portishead", "Glory Box"), ("Portishead", "Numb"),
        ("Portishead", "Wandering Star"), ("Tricky", "Daydreaming"),
    ),
    # Big beat: NPR 11 essential songs, Treble, Shazam, Wikipedia
    "Big beat": (
        ("The Dust Brothers", "Chemical Beats"), ("The Prodigy", "Firestarter"), ("The Chemical Brothers", "Block Rockin' Beats"),
        ("The Chemical Brothers", "Setting Sun"), ("Fatboy Slim", "The Rockafeller Skank"),
        ("Emergency Broadcast Network", "3:7:8"),
    ),
    # Time Out and Complex: below ten
    "Jump up": (("Urban Shakedown", "Arsonist"), ("Original Sin", "Therapy (Remix)")),
    # Gospel and sacred ----------------------------------------------------
    "Gospel": (
        ("Thomas A. Dorsey", "Precious Lord, Take My Hand"), ("Thomas A. Dorsey", "Peace in the Valley"),
        ("Hank Williams", "I Saw the Light"), ("Marvin Sapp", "Never Would Have Made It"), ("Kirk Franklin", "Stomp"),
        ("Mary Mary", "Shackles"), ("Donnie McClurkin", "Stand"), ("Richard Smallwood", "Total Praise"),
    ),
    # Choral and sacred masterworks (composer as artist, title as the work)
    "Choral": (
        ("Handel", "Messiah"), ("Bach", "Mass in B Minor"), ("Bach", "St Matthew Passion"),
        ("Beethoven", "Missa Solemnis"), ("Brahms", "Ein Deutsches Requiem"), ("Verdi", "Requiem"),
        ("Mozart", "Requiem"), ("Orff", "Carmina Burana"), ("Vaughan Williams", "A Sea Symphony"),
        ("Haydn", "The Creation"), ("Mendelssohn", "Elijah"),
    ),
    # Decca "Essential Baroque" (2006), Apple Music baroque
    "Baroque": (
        ("Handel", "Arrival of the Queen of Sheba"), ("Bach", "Sheep May Safely Graze"), ("Bach", "Italian Concerto"),
        ("Pachelbel", "Canon"), ("Purcell", "Rondeau"), ("Vivaldi", "Gloria"), ("Vivaldi", "Stabat Mater"),
        ("Handel", "Music for the Royal Fireworks"), ("Bach", "Jesu, Joy of Man's Desiring"),
        ("Vivaldi", "The Four Seasons"),
    ),
    # Gramophone, Songlines, Opera Sense and Classic FM top arias
    "Opera": (
        ("Giuseppe Verdi", "La donna è mobile"), ("Giacomo Puccini", "O mio babbino caro"),
        ("Giacomo Puccini", "Nessun dorma"), ("Giacomo Puccini", "Vissi d'arte"), ("Mozart", "Voi che sapete"),
        ("Giuseppe Verdi", "Bella figlia dell'amore"), ("Giacomo Puccini", "Un bel dì vedremo"),
    ),
    # Romantic and early piano-orchestral pieces (Musicnotes, Chester, Music Sales, sets)
    "Romantic": (
        ("Claude Debussy", "Arabesque No. 1"), ("Robert Schumann", "Why?"), ("Frédéric Chopin", "Fantaisie-Impromptu"),
        ("Franz Liszt", "Liebesträume No. 3"), ("Gabriel Fauré", "Pavane"), ("Johannes Brahms", "Intermezzo in A Major"),
        ("Gustav Mahler", "Adagietto"), ("Antonín Dvořák", "Largo"), ("Pyotr Ilyich Tchaikovsky", "Piano Concerto No. 1"),
        ("Hector Berlioz", "March to the Scaffold"), ("Edvard Grieg", "Peer Gynt"), ("Johannes Brahms", "Hungarian Dances"),
        ("Frédéric Chopin", "Raindrop Prelude"),
    ),
    # Solo piano (Satie, Debussy, Chopin, Schirmer, Schott) — extends the Piano reference
    "Piano": (
        ("Erik Satie", "Gnossienne No. 1"), ("Claude Debussy", "Rêverie"), ("Claude Debussy", "Doctor Gradus ad Parnassum"),
        ("Frédéric Chopin", "Nocturne in C-sharp minor"), ("Frédéric Chopin", "Polonaise Héroïque"),
        ("Ludwig van Beethoven", "Für Elise"),
    ),
    # Orchestral: Louder, Scaruffi, library essentials, conductor's list
    "Orchestral": (
        ("Ludwig van Beethoven", "Symphony No. 5"), ("Ludwig van Beethoven", "Symphony No. 9"),
        ("Wolfgang Amadeus Mozart", "Symphony No. 39"), ("Wolfgang Amadeus Mozart", "Symphony No. 40"),
        ("Gustav Mahler", "Symphony No. 6"), ("Gustav Mahler", "Symphony No. 9"), ("Anton Bruckner", "Symphony No. 7"),
        ("Hector Berlioz", "Symphonie fantastique"), ("Richard Strauss", "Don Juan"), ("Richard Strauss", "Till Eulenspiegel"),
        ("Georges Bizet", "Carmen Suite"), ("Johannes Brahms", "Symphony No. 2"), ("Igor Stravinsky", "The Rite of Spring"),
        ("Béla Bartók", "Concerto for Orchestra"), ("Edward Elgar", "Nimrod"), ("Jean Sibelius", "Finlandia"),
    ),
    # Film music: only two named cues (Inception, The Hateful Eight): below ten
    "Film score": (("Hans Zimmer", "Dream Is Collapsing"), ("Ennio Morricone", "Overture")),
    # Bollywood: only one named song: below ten
    "Bollywood": (("Lata Mangeshkar", "Lag Jaa Gale"),),
    # Treble, BrooklynVegan, Stereogum, Musician Wave, Ride (DMY)
    "Shoegaze": (
        ("My Bloody Valentine", "You Made Me Realise"), ("My Bloody Valentine", "Soon"),
        ("My Bloody Valentine", "When You Sleep"), ("Ride", "Vapour Trail"), ("Ride", "Kookaburra"),
        ("Slowdive", "When the Sun Hits"), ("Swervedriver", "Hands"), ("Chapterhouse", "Pearl"),
        ("Cocteau Twins", "Cherry-coloured Funk"), ("The Jesus and Mary Chain", "Just Like Honey"),
        ("Flying Saucer Attack", "My Dreaming Hill"), ("The Lilys", "The Hermit Crab"),
        ("Catherine Wheel", "Kill Rhythm"), ("Smashing Pumpkins", "Rocket"), ("Pale Saints", "Language of Flowers"),
        ("The House of Love", "Touch Me"),
    ),
    # Lee 'Scratch' Perry, Mad Professor, King Tubby (Rough Guide, Red Bull, Deezer)
    "Dub": (
        ("Prince Jammy", "Rude Boy"), ("King Tubby", "Zion Gate Dub"), ("Horace Andy", "Don't Try It"),
        ("Lee Perry", "Dub Revolution Part 1"), ("Mad Professor", "Kunte Kinte"), ("King Tubby", "Cassava Piece"),
    ),
    # Deutscher Krach: the scene's own label, krach-music.com (artist pages and the 2026 release list),
    # Noiseflow's Scantraxx release and the Serato sets. Noiseflow founded the name in 2023.
    "Deutscher Krach": (
        ("Noiseflow", "All the Things She Said"), ("Noiseflow", "New Drug"), ("Noiseflow", "Mikrowellenessen"),
        ("Noiseflow", "Brainrot Bass"), ("Noiseflow", "Testing the Soundsystem"), ("Noiseflow", "Another Day In Paradise"),
        ("Schlot", "The Underworld"), ("Schlot", "Basswave Evolution"), ("Schlot", "ROUND & ROUND"), ("Schlot", "O-Zone"),
        ("vANE", "Die Leute wollen Krach"), ("vANE", "Nur noch deutscher Krach"), ("vANE", "sing me to sleep"),
        ("vANE", "The Cold"), ("vANE", "Rotor Blades"), ("vANE", "Faceless Forever"),
        ("RWF", "Endlevel Krach"), ("RWF", "Under My Skin"),
        ("Cyber Gunz", "Bass Addict"), ("Cyber Gunz", "Let This One Ride"), ("Cyber Gunz", "KRACH WHORE"),
        ("Cyber Gunz", "Stoff Und Bier"), ("Cyber Gunz", "Diamonds"),
        ("luvvtige", "SLOW DOWN"), ("luvvtige", "DIE MIKROSCHELLE"),
        ("Dr Donk", "Step Up"), ("Dr Donk", "He Comin!"), ("NOMAD", "Say My Name"), ("SWEAPY", "Crash The Party"),
    ),
    # The Hard Data ("Seven Hardcore Tracks That Changed My Life"), Treble, Catscan's "Classics" on Bandcamp
    "Industrial hardcore": (
        ("Inferno Bros.", "Slaves To The Rave"), ("Wedlock vs. Comababy", "Void Sector"),
        ("Catscan", "Midnight Impact"), ("Catscan", "The World Is Mine"),
    ),
    # Paula Temple's picks (Electronic Beats), a Reddit-era request thread quoted in search
    "Industrial techno": (
        ("Technoise", "System"), ("Death Abyss", "We Are What You Should Fear"), ("Clouds", "Nokia"),
        ("Clouds", "Wolverhampton"),
    ),
    # Ska punk and ska: sources named in the search results (Flexco, BrooklynVegan, Tildes thread)
    "Ska punk": (
        ("Sublime", "Santeria"), ("Reel Big Fish", "Sell Out"), ("Goldfinger", "Superman"),
        ("The Interrupters", "She's Kerosene"),
    ),
    "Ska": (("The Specials", "Ghost Town"), ("Madness", "One Step Beyond")),
}
