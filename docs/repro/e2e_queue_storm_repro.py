# Reproduction harness for the runaway queue top-up.
#
# Symptom, from a user diagnostic log: `GET /api/radio/track/<id>` fired
# continuously — every ~250 ms, for over an hour — pinning the network and the
# main thread until the UI stopped responding to taps at all (buttons dead, the
# full-screen player impossible to close) and playback stalled.
#
# Cause: the queue top-up reactive block runs on EVERY player-store
# notification. Once the playhead is within 3 tracks of the end it asks the
# radio endpoint for more. When that radio returns only tracks ALREADY in the
# queue, `extend()` adds nothing — but it still called `update()`, and svelte's
# safe_not_equal is unconditionally true for objects, so every subscriber fired
# anyway. That notification re-ran the trigger, which asked again. A closed
# loop, running as fast as the network answered.
#
# Same setup as e2e_transport_repro.py (see its header); run that one's
# --prepare first, then:
#
#   .venv/bin/python docs/repro/e2e_queue_storm_repro.py
#
# The radio endpoint is stubbed to return tracks that are already queued — the
# exact condition from the log — and the harness simply counts the requests.
import json
import os
import sys

BASE = os.environ.get("NS_BASE", "http://localhost:5722")
USER = os.environ.get("NS_USER", "admin")
PASSWORD = os.environ.get("NS_PASSWORD", "adminpw")
CHROMIUM = os.environ.get("NS_CHROMIUM")

# How long to watch, and what counts as a storm. The top-up fires with three
# tracks (many minutes of audio) still to play, so a handful of calls in half a
# minute is generous; the bug produced well over a hundred.
WATCH_SECONDS = 30
STORM_THRESHOLD = 10

SNAP = """
() => ({
  queueLen: (window.__player && window.__player.queue.length) || 0,
  index: (window.__player && window.__player.index) ?? -1,
})
"""


def main():
    from playwright.sync_api import sync_playwright

    with sync_playwright() as p:
        kwargs = {"args": ["--autoplay-policy=no-user-gesture-required"]}
        if CHROMIUM:
            kwargs["executable_path"] = CHROMIUM
        browser = p.chromium.launch(**kwargs)
        ctx = browser.new_context(service_workers="block")
        page = ctx.new_page()
        page.on("pageerror", lambda e: print("  [pageerror]", str(e)[:200]))

        print("== login ==")
        page.goto(BASE + "/app/")
        page.fill('input[placeholder="Utilisateur"]', USER)
        page.fill('input[placeholder="Mot de passe"]', PASSWORD)
        page.click('button:has-text("Se connecter")')
        page.wait_for_selector(".sidebar", timeout=15000)

        print("== play the local files ==")
        page.click('a[href="#/library"]')
        page.wait_for_selector('button:has-text("Mes fichiers")')
        page.click('button:has-text("Mes fichiers")')
        page.wait_for_selector('button:has-text("Tout lire")')

        # Capture the tracks the app is about to queue, so the stubbed radio can
        # hand back exactly those — "everything I offer is already queued", the
        # condition that closed the loop.
        queued = {"tracks": []}

        def capture(route):
            resp = route.fetch()
            try:
                body = resp.json()
            except Exception:
                route.fulfill(response=resp)
                return
            if isinstance(body, dict) and body.get("tracks"):
                queued["tracks"] = body["tracks"]
            route.fulfill(response=resp)

        page.route("**/api/tracks**", capture)
        page.click('button:has-text("Tout lire")')
        page.wait_for_timeout(3000)
        page.unroute("**/api/tracks**")

        radio_calls = {"n": 0}

        def radio(route):
            radio_calls["n"] += 1
            # Only duplicates: nothing here can ever grow the queue.
            route.fulfill(
                status=200,
                content_type="application/json",
                body=json.dumps({"tracks": queued["tracks"]}),
            )

        page.route("**/api/radio/track/**", radio)
        page.route("**/api/flow**", radio)

        # The uploaded library is 3 tracks, so index 0 already satisfies the
        # top-up's "within 3 of the end" condition — it is armed from the first
        # tick, exactly as it was for the user (a 6-track queue at index 4).
        page.wait_for_timeout(2000)
        before = radio_calls["n"]
        print(f"== armed; {before} radio call(s) during setup ==")
        print(f"== watching /api/radio for {WATCH_SECONDS}s ==")
        for i in range(WATCH_SECONDS):
            page.wait_for_timeout(1000)
            if (i + 1) % 10 == 0:
                print(f"  {i + 1}s: {radio_calls['n'] - before} radio calls so far")
        during = radio_calls["n"] - before

        # A wedged main thread is the actual user-visible damage, so check the
        # UI still reacts: the transport icon must CHANGE when tapped (pause
        # bars <-> play triangle), whichever way round it started.
        icon = '() => !!document.querySelector(".player .pp svg rect")'
        was_playing = page.evaluate(icon)
        page.click(".player .pp")
        page.wait_for_timeout(1500)
        responsive = page.evaluate(icon) != was_playing

        print(f"\nradio calls in {WATCH_SECONDS}s: {during}")
        print(f"UI still responds to the transport button: {responsive}")
        browser.close()

    ok_rate = during <= STORM_THRESHOLD
    print("\n=== RESULTS ===")
    print(f"  {'OK  ' if ok_rate else 'FAIL'}  no request storm ({during} <= {STORM_THRESHOLD})")
    print(f"  {'OK  ' if responsive else 'FAIL'}  UI responsive")
    return 0 if (ok_rate and responsive) else 1


if __name__ == "__main__":
    sys.exit(main())
