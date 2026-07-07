# Regression repro for "enabling shuffle skips to the next song".
#
# The bug is in the MOBILE full-screen player's cover carousel
# (MobileNowPlaying.svelte): toggling shuffle reorders the queue and moves the
# current track to index 0 WITHOUT changing its id. The carousel keyed its
# re-centre on the track id, so it stayed aligned to the old slot; the stale
# scroll position then made onSettled fire a bogus swipe-advance -> a skip.
#
# This drives the real player at a phone viewport: play a MIDDLE track, open the
# full-screen player, toggle shuffle, and assert the track did NOT change. It
# also checks the Next button still advances (the fix must not break real
# advancement). Desktop is unaffected (it uses a queue list, not a carousel).
#
# Setup: see docs/repro/e2e_transport_repro.py (same server + built SPA + a few
# uploaded local tracks; needs >= ~6 so a middle track has neighbours).
import os

from playwright.sync_api import sync_playwright

BASE = os.environ.get("NS_BASE", "http://localhost:5722")
USER = os.environ.get("NS_USER", "admin")
PASSWORD = os.environ.get("NS_PASSWORD", "adminpw")
CHROMIUM = os.environ.get("NS_CHROMIUM")

INIT = """
(() => {
  const OA = window.Audio;
  window.__audios = [];
  window.Audio = function (...a) { const el = new OA(...a); window.__audios.push(el); return el; };
  window.Audio.prototype = OA.prototype;
})();
"""

SNAP = """
() => {
  const a = (window.__audios || []).filter(x => x.src);
  const act = a.find(x => !x.paused) || a.sort((x, y) => y.currentTime - x.currentTime)[0] || null;
  return {
    src: act ? (act.src.split('/stream/')[1] || '').slice(0, 8) : null,
    t: act ? Math.round(act.currentTime * 100) / 100 : null,
    title: (document.querySelector('.m .info .t') || document.querySelector('.player .now .t') || {}).textContent || '',
  };
}
"""


def main():
    with sync_playwright() as p:
        kwargs = {"args": ["--autoplay-policy=no-user-gesture-required"]}
        if CHROMIUM:
            kwargs["executable_path"] = CHROMIUM
        browser = p.chromium.launch(**kwargs)
        ctx = browser.new_context(service_workers="block", viewport={"width": 390, "height": 844})
        ctx.add_init_script(INIT)
        page = ctx.new_page()
        page.on("pageerror", lambda e: print("  [pageerror]", str(e)[:150]))

        page.goto(BASE + "/app/")
        page.fill('input[placeholder="Utilisateur"]', USER)
        page.fill('input[placeholder="Mot de passe"]', PASSWORD)
        page.click('button:has-text("Se connecter")')
        page.wait_for_selector(".mobilenav", timeout=10000)
        page.click('.mobilenav a[href="#/library"]')
        page.click('button:has-text("Mes fichiers")')
        page.wait_for_selector(".track")

        # Play a middle track (index 5) via its play button (single tap on the row
        # doesn't play on mobile), then open the full-screen player.
        page.query_selector_all(".track .play")[5].click()
        page.wait_for_timeout(1500)
        page.click(".player .now")
        page.wait_for_selector(".m .controls", timeout=8000)
        page.wait_for_timeout(1200)

        before = page.evaluate(SNAP)
        page.click(".m .controls .sm:first-child")  # the shuffle button
        page.wait_for_timeout(3000)
        after = page.evaluate(SNAP)
        skipped = bool(before["src"] and after["src"] and before["src"] != after["src"])
        print(f"shuffle: {before['title']!r} -> {after['title']!r}  SKIPPED={skipped} (want False)")

        # Next must still advance.
        t0 = page.evaluate(SNAP)["title"]
        page.click('.m .controls button[aria-label="Suivant"]')
        page.wait_for_timeout(1500)
        t1 = page.evaluate(SNAP)["title"]
        print(f"next button: {t0!r} -> {t1!r}  ADVANCED={t0 != t1} (want True)")

        browser.close()


if __name__ == "__main__":
    main()
