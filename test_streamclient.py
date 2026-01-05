"""Test StreamClient - Reproduction des opérations manuelles."""

import os
from StreamClient import StreamClient

# Récupérer l'ARL depuis les variables d'environnement
arl = os.getenv("ARL")
if not arl:
    print("❌ Variable ARL non définie")
    print("   Définissez-la avec: export ARL='votre_arl'")
    exit(1)

# Créer le client
print("🔧 Création du client...")
cl = StreamClient(arl=arl, download_folder="./downloads", quality=2)

# Login
print("🔐 Connexion...")
cl.login()
print(f"✓ Connecté: {cl.logged_in}")

# Recherche
print("\n🔍 Recherche 'Lovesong for Bass'...")
results = cl.search("Lovesong for Bass", "track")
print(f"✓ Trouvé {len(results)} résultats")
for i, track in enumerate(results[:3], 1):
    print(f"  {i}. {track['title']} - {track['artist']['name']} (ID: {track['id']})")

# Téléchargement de la première piste trouvée
track_id = str(results[0]['id'])
print(f"\n⬇️  Téléchargement de la piste ID {track_id}...")
try:
    cl.download(track_id, "track")
    print(f"✓ Téléchargement terminé!")
except Exception as e:
    print(f"❌ Erreur lors du téléchargement: {e}")

print("\n✅ Test terminé!")

