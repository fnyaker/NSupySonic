"""Exemple pratique d'utilisation de StreamClient."""

import os
from StreamClient import StreamClient


def example_search_and_info():
    """Recherche et affichage d'informations."""
    client = StreamClient(arl=os.getenv("ARL", ""))
    client.login()

    # Recherche d'un artiste
    print("🔍 Recherche 'Daft Punk'...")
    artists = client.search("Daft Punk", type="artist", limit=1)

    if not artists:
        print("Aucun résultat")
        return

    artist = artists[0]
    print(f"✓ Trouvé: {artist['name']} (ID: {artist['id']})")

    # Récupération des détails via l'API
    artist_id = str(artist['id'])
    details = client.api.get_artist(artist_id)
    print(f"  Fans: {details.get('nb_fan', 'N/A')}")
    print(f"  Albums: {details.get('nb_album', 'N/A')}")

    # Top tracks
    print(f"\n🎵 Top 5 tracks:")
    top = client.api.get_artist_top(artist_id, limit=5)
    for i, track in enumerate(top.get("data", []), 1):
        print(f"  {i}. {track['title']}")

    # Albums
    print(f"\n💿 Derniers albums:")
    albums = client.api.get_artist_albums(artist_id, limit=5)
    for album in albums.get("data", []):
        print(f"  - {album['title']} ({album.get('release_date', 'N/A')})")


def example_download_album():
    """Télécharge un album spécifique."""
    client = StreamClient(
        arl=os.getenv("ARL", ""),
        download_folder="./my_music",
        quality=2  # FLAC
    )
    client.login()

    # Recherche de l'album
    print("🔍 Recherche 'Random Access Memories'...")
    albums = client.search("Random Access Memories Daft Punk", type="album", limit=1)

    if not albums:
        print("Album non trouvé")
        return

    album = albums[0]
    album_id = str(album['id'])

    print(f"✓ Album trouvé: {album['title']}")

    # Récupération des détails
    details = client.get_metadata(album_id, "album")
    print(f"  Artiste: {details['artist']['name']}")
    print(f"  Tracks: {details['track_total']}")
    print(f"  Durée: {details['duration'] // 60} min")

    # Téléchargement
    print(f"\n⬇️  Téléchargement en cours...")
    client.download(album_id, type="album")
    print(f"✓ Téléchargement terminé!")


def example_user_favorites():
    """Affiche les favoris d'un utilisateur."""
    client = StreamClient(arl=os.getenv("ARL", ""))
    client.login()

    # Remplacez par un vrai user_id
    user_id = "USER_ID"

    print(f"👤 Favoris de l'utilisateur {user_id}:")

    # Tracks favorites
    tracks = client.get_user_data(user_id, "tracks", limit=10)
    print(f"\n🎵 Dernières pistes ({len(tracks)}):")
    for track in tracks[:5]:
        print(f"  - {track['title']} - {track['artist']['name']}")

    # Albums favoris
    albums = client.get_user_data(user_id, "albums", limit=10)
    print(f"\n💿 Derniers albums ({len(albums)}):")
    for album in albums[:5]:
        print(f"  - {album['title']} - {album['artist']['name']}")

    # Artistes suivis
    artists = client.get_user_data(user_id, "artists", limit=10)
    print(f"\n👨‍🎤 Artistes suivis ({len(artists)}):")
    for artist in artists[:5]:
        print(f"  - {artist['name']}")


def example_charts():
    """Affiche les charts."""
    client = StreamClient(arl=os.getenv("ARL", ""))
    client.login()

    print("📊 Top Charts:")

    # Top tracks
    print("\n🎵 Top 10 Tracks:")
    charts = client.api.get_chart_tracks(limit=10)
    for i, track in enumerate(charts.get("data", []), 1):
        print(f"  {i}. {track['title']} - {track['artist']['name']}")

    # Top albums
    print("\n💿 Top 5 Albums:")
    albums = client.api.get_chart_albums(limit=5)
    for i, album in enumerate(albums.get("data", []), 1):
        print(f"  {i}. {album['title']} - {album['artist']['name']}")


if __name__ == "__main__":
    # Vérification de l'ARL
    if not os.getenv("ARL"):
        print("⚠️  Variable d'environnement ARL non définie")
        print("   Définissez-la avec: export ARL='votre_arl'")
        exit(1)

    print("=" * 60)
    print("STREAMCLIENT - EXEMPLES D'UTILISATION")
    print("=" * 60)

    try:
        print("\n" + "=" * 60)
        print("1. RECHERCHE ET INFORMATIONS")
        print("=" * 60)
        example_search_and_info()

        print("\n" + "=" * 60)
        print("2. CHARTS")
        print("=" * 60)
        example_charts()

        # Décommentez pour télécharger
        # print("\n" + "=" * 60)
        # print("3. TÉLÉCHARGEMENT D'ALBUM")
        # print("=" * 60)
        # example_download_album()

        # Décommentez et remplacez USER_ID
        # print("\n" + "=" * 60)
        # print("4. FAVORIS UTILISATEUR")
        # print("=" * 60)
        # example_user_favorites()

    except Exception as e:
        print(f"\n❌ Erreur: {e}")
        import traceback
        traceback.print_exc()

