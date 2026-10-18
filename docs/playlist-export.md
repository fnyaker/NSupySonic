# Exporter une playlist vers un autre service

Ce que chaque service permet en octobre 2026, et ce que NSupySonic en fait
(`supysonic/services/`, `supysonic/webui/services.py`, `components/ExportSheet.svelte`).

| Service | Possible ? | Comment | Ce qu'il faut |
|---|---|---|---|
| **Spotify** | Oui | Web API, OAuth « Authorization Code + PKCE » (pas de secret client sur le serveur). `POST /me/playlists` puis `POST /playlists/{id}/items` par 100. | Une app sur developer.spotify.com, créée par l'admin (Réglages → Compte → *Application Spotify du serveur*). Depuis février 2026, en mode développement : le propriétaire doit être **Premium**, **5 comptes** au plus (à déclarer dans *User Management*), et l'URI de redirection doit être en **https** (ou 127.0.0.1). |
| **YouTube Music** | Oui | `ytmusicapi`, connecté avec les en-têtes d'un onglet music.youtube.com (son mode « browser »). La recherche passe par la recherche YouTube déjà en place (cache d'un jour, pauses après un refus). | Coller les en-têtes d'une requête `browse` (Réglages → Compte). Ils valent une session : chiffrés, par utilisateur ; se déconnecter du navigateur les annule. |
| **Deezer** | Oui (admin) | Le compte du serveur (l'ARL), une seule fois et à la demande : une NOUVELLE playlist, jamais retouchée ensuite (ce n'est pas l'ancien miroir). | Rien de plus. Réservé à l'admin : ce compte est le sien. |
| **Apple Music** | Pas directement | MusicKit exige l'Apple Developer Program (99 $/an) pour signer le jeton développeur, plus MusicKit JS dans le navigateur pour le jeton utilisateur. | Exporter la **liste en CSV** et l'importer avec TuneMyMusic / Soundiiz / FreeYourMusic. |
| Tidal, Amazon Music, Qobuz | Pas directement | API réservées aux partenaires. | Même chemin : CSV. |

## Pourquoi ces choix

- **YouTube Data API v3 écartée** : 100 unités par recherche et 50 par titre ajouté,
  sur 10 000 par jour et par projet Google, soit une soixantaine de titres par jour.
  Le mode OAuth de ytmusicapi demande lui aussi un client Google Cloud et a cassé
  plusieurs fois ; le mode « en-têtes » est celui qui tient.
- **Correspondance** : l'identifiant du service quand le titre en vient
  (`youtube_id`, `deezer_id`), puis l'**ISRC** (lu sur le disque : le `.json` à côté
  de l'archive, sinon les tags du fichier), puis une recherche titre + artiste jugée
  par `availability.match_score` — même titre (hors « Remastered »…), même artiste
  principal, pas de remix/live/edit en plus, durée à 15 s près. Une reprise ou un
  remix n'est **pas** exporté à la place du morceau : il est listé comme introuvable.
- **Rien n'est créé** si aucun titre n'a été trouvé, ni si le service cesse de
  répondre en cours de route (l'export s'arrête avec la raison, au lieu de classer
  le reste en « introuvable »).
- **Identifiants** : table `service_link` (un compte par service et par utilisateur),
  chiffrée AES-GCM avec la clé du serveur comme `User.password_clear`. Aucune de ces
  routes n'est prêtée à une télécommande (`remote.POLICY`: `NEVER`), sauf la liste en
  fichier (`read`, c'est la playlist elle-même).
- **Retour de Spotify** : l'état PKCE est gardé côté serveur, pas dans le cookie : sur
  Android la page de consentement s'ouvre dans le navigateur système, qui n'a pas la
  session de l'app. Le retour y affiche simplement « Compte Spotify relié ».

## Fichiers liste

- `csv` : Title, Artist, Album, ISRC, Duration — UTF-8 avec BOM, une cellule qui
  commence par `= + - @` est préfixée d'une apostrophe (pas de formule).
- `xspf` : VLC, foobar2000…
- `txt` : « Artiste - Titre », une ligne par titre.

## Pour le fil « import de playlists »

`supysonic/services/` est fait pour servir dans les deux sens : `spotify.Client`,
`ytmusic.Client` et `deezer.Client` savent déjà chercher, `match.wanted` / `match.pick`
décrivent un titre et jugent une réponse, et `service_link` garde les comptes reliés.
