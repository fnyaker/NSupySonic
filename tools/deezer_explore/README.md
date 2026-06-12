# Explorer l'API Deezer

But : cartographier **toutes** les fonctions Deezer pour décider lesquelles exposer
dans le proxy / la web UI. Deux méthodes complémentaires.

> ⚠️ Les fichiers `.har` et les sorties contiennent **tes tokens de session
> (ARL, api_token…)**. Ils sont gitignorés — ne les partage pas publiquement.
> Le parseur masque les valeurs sensibles dans le catalogue généré.

## 1. Capture HAR (la plus complète) — recommandé

1. Ouvre <https://www.deezer.com> dans Chrome/Firefox, connecté.
2. Ouvre les DevTools (F12) → onglet **Réseau/Network**.
3. Coche **Preserve log** (conserver le journal) et filtre sur `deezer`.
4. **Utilise un max de fonctions** : accueil, recherche, page artiste, album,
   playlist, radio/mix, Flow, paroles, favoris (ajout/retrait), création/édition
   de playlist, “Nouveautés”, podcasts, etc.
5. Clic droit dans la liste des requêtes → **Save all as HAR** (Enregistrer tout
   en HAR). Mets le fichier ici : `tools/deezer_explore/capture.har`.
6. Génère le catalogue :

   ```sh
   python tools/deezer_explore/har_to_catalog.py tools/deezer_explore/capture.har
   ```

   → écrit `capture.catalog.md` (lisible) et `capture.catalog.json` à côté.
   Couvre `gw-light.php` (gateway privée), `api.deezer.com` (API publique) et
   `pipe.deezer.com` (GraphQL).

Ensuite je lis le `.catalog.md` (il est dans le repo) et on choisit quoi exposer.

## 2. Sonde active (probe) — complément rapide

Teste une liste de méthodes gw en lecture seule avec ton ARL et note lesquelles
répondent + la forme des réponses :

```sh
ARL=ton_arl python tools/deezer_explore/probe.py
# options: --artist <id> --album <id> --track <id> --playlist <id>
```

→ écrit `probe.json` / `probe.md` ici. (Lecture seule : aucune modif de ton compte.)

## Lequel utiliser ?

- **HAR** = exhaustif et fiable (ce que l'app fait *vraiment*, GraphQL compris).
- **probe** = rapide pour confirmer des noms de méthodes / des shapes sans capturer.

Fais au moins la capture HAR ; colle/laisse le `.catalog.md` dans le repo et je
construis la couverture des fonctions à partir de là.
