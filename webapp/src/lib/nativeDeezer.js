// Linking the Deezer account from inside the Android app.
//
// Deezer has no email/password endpoint left that a server could call — the web
// one answers 403 since 2024, and the mobile gateway needs keys extracted from
// Deezer's own binaries — so the only way to turn credentials into an ARL is a
// real browser session. The Android app does exactly that: it opens Deezer's
// OWN login page in a separate WebView (no JS bridge attached), reads the `arl`
// session cookie the login sets, and hands back that one value.
//
// The password is therefore typed on deezer.com and never reaches this app nor
// the NSupySonic server; only the ARL crosses back, and only to a page served
// by the configured server (MainActivity.deliverArl checks the origin).
//
// See android/app/src/main/java/org/nsupysonic/app/DeezerLoginActivity.kt.

/** Whether the host app can capture an ARL for us (Android app only). */
export function nativeDeezerLoginAvailable() {
  return (
    typeof window !== "undefined" &&
    typeof window.NSNative?.deezerLogin === "function"
  );
}

/** Rejection raised when the user backs out of the native login screen. */
function cancelled() {
  const err = new Error("Connexion Deezer annulée");
  err.cancelled = true;
  return err;
}

// At most one login screen can be open (the activity is launched from a single
// task), so a single slot is enough — and a second call must not leave the
// first promise pending for ever.
let pending = null;

function settle(payload) {
  const slot = pending;
  pending = null;
  if (!slot) return;
  const arl =
    payload && typeof payload.arl === "string" ? payload.arl.trim() : "";
  if (arl) slot.resolve(arl);
  else slot.reject(cancelled());
}

/**
 * Open the native Deezer login screen and resolve with the captured ARL.
 * Rejects with `err.cancelled` when the user gave up.
 */
export function nativeDeezerLogin() {
  if (!nativeDeezerLoginAvailable())
    return Promise.reject(new Error("Connexion Deezer native indisponible"));
  settle(null); // supersede any screen we somehow still believe is open
  return new Promise((resolve, reject) => {
    pending = { resolve, reject };
    // The native side calls this once the screen closes, either way.
    window.__nsDeezerArl = settle;
    try {
      window.NSNative.deezerLogin();
    } catch (e) {
      pending = null;
      reject(e instanceof Error ? e : new Error(String(e)));
    }
  });
}
