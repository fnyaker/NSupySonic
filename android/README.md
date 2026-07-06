# NSupySonic — application Android

Application Android native (Kotlin) qui embarque le lecteur web (`webapp/`)
dans une WebView plein écran et lui donne ce qui manque au navigateur :

- **Service média foreground + MediaSession** : Android ne tue plus le lecteur
  après une longue pause en arrière-plan ; l'audio est décodé dans la WebView
  (tout le comportement du lecteur web — cache, offline, reprise — reste
  identique), le natif tient la session, les wakelocks et la notification.
- **Notification média / écran de verrouillage / Bluetooth** : lecture, pause,
  précédent, suivant, seek — reliés au lecteur web via le pont
  `window.NSNative` (`webapp/src/lib/native.js`).
- **Écran de configuration au premier lancement** : adresse du serveur, port
  optionnel, case « Vérifier le certificat SSL » (à décocher pour un certificat
  auto-signé), et raccourci pour désactiver l'optimisation batterie.
  L'écran se rouvre via l'appui long sur l'icône de l'app (« Serveur ») ou
  depuis l'écran d'erreur de connexion.

## Build

L'APK est construit par le workflow CI `.github/workflows/android.yaml` :
artefact `nsupysonic-apk` sur chaque build, et fichier attaché à la release
GitHub sur les tags `v*`. Sans secrets configurés, la signature change à
chaque run (il faut désinstaller pour mettre à jour) ; pour une signature
stable, définir `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`,
`ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`.

En local :

```sh
cd android && gradle assembleDebug   # ou ./gradlew après `gradle wrapper`
```

Nécessite un JDK 17 et le SDK Android (API 34).
