# Reproduction harness for the web-player transport bugs (docs/plan-bug-audit.md, P0).
#
# Drives the REAL SPA in Chromium, instruments the JS-created <audio> elements,
# and simulates slow / dead / failing /api/stream responses to reproduce:
#   T1  baseline: play / pause / resume on a healthy stream (sanity check)
#   T2  a stream request that HANGS -> watchdog recovery wedges the transport
#       (silent playback, pause/play dead, "recovering" stuck forever)  [P0.1/0.4]
#   T3  stream answers 5xx -> retry loop then "Titre indisponible" skip cascade,
#       ~9s of unexplained silence per track, no indicator                [P0.3]
#   T4  quality-switch preload hangs -> pause ignored for ~8s             [P0.2]
#
# Setup (from the repo root):
#   python3 -m venv .venv && .venv/bin/pip install -e . waitress playwright
#   (cd webapp && npm install && npm run build)
#   # config in ~/.supysonic: sqlite db + [deezer] archive_dir (no ARL needed)
#   .venv/bin/supysonic-cli user add admin -p adminpw
#   .venv/bin/supysonic-cli user setroles --admin admin
#   .venv/bin/supysonic-server -p 5722 &
#   # generate 3 small WAVs (see gen_wavs() below) and upload them:
#   python docs/repro/e2e_transport_repro.py --prepare
#   python docs/repro/e2e_transport_repro.py
#
# Expected AFTER the P0 fixes: pause effective < 500ms in every state, no track
# skipped on mere slowness, a visible status indicator while loading/recovering.
import json
import math
import os
import struct
import sys
import tempfile
import time
import urllib.request
import wave

BASE = os.environ.get("NS_BASE", "http://localhost:5722")
USER = os.environ.get("NS_USER", "admin")
PASSWORD = os.environ.get("NS_PASSWORD", "adminpw")
# Chromium binary; leave unset to let Playwright resolve its own download.
CHROMIUM = os.environ.get("NS_CHROMIUM")

INIT = """
(() => {
  const OA = window.Audio;
  window.__audios = [];
  window.Audio = function (...args) {
    const el = new OA(...args);
    el.__events = [];
    for (const ev of ["play","pause","error","stalled","loadedmetadata","waiting","playing","abort","emptied"]) {
      el.addEventListener(ev, () => {
        el.__events.push(ev + "@" + (Date.now() % 100000));
        if (el.__events.length > 40) el.__events.shift();
      });
    }
    window.__audios.push(el);
    return el;
  };
  window.Audio.prototype = OA.prototype;
})();
"""

SNAP = """
() => ({
  audios: (window.__audios || []).map((a) => ({
    src: (a.src || "").slice(-60),
    paused: a.paused,
    t: Math.round(a.currentTime * 100) / 100,
    readyState: a.readyState,
    networkState: a.networkState,
    events: (a.__events || []).slice(-8),
  })),
  // pause icon = <rect>s inside the main play/pause button; play icon = <polygon>
  uiShowsPause: !!document.querySelector(".player .pp svg rect"),
  toasts: [...document.querySelectorAll(".toasts .toast")].map((t) => t.textContent.trim()),
  title: (document.querySelector(".player .now .t") || {}).textContent || "",
})
"""


def gen_wavs(tmpdir):
    paths = []
    for name, freq in [("Alpha Song", 440), ("Beta Song", 523), ("Gamma Song", 660)]:
        p = os.path.join(tmpdir, name.replace(" ", "_") + ".wav")
        w = wave.open(p, "w")
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(22050)
        w.writeframes(
            b"".join(
                struct.pack("<h", int(12000 * math.sin(2 * math.pi * freq * i / 22050)))
                for i in range(22050 * 30)
            )
        )
        w.close()
        paths.append(p)
    return paths


def prepare():
    """Log in and upload the three generated WAVs through /api/upload."""
    import http.cookiejar

    jar = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
    body = json.dumps({"username": USER, "password": PASSWORD}).encode()
    req = urllib.request.Request(
        BASE + "/api/login", body, {"Content-Type": "application/json"}
    )
    opener.open(req).read()
    for p in gen_wavs(tempfile.mkdtemp(prefix="ns-repro-")):
        boundary = "nsrepro"
        with open(p, "rb") as f:
            data = f.read()
        payload = (
            (
                f"--{boundary}\r\nContent-Disposition: form-data; name=\"files\"; "
                f"filename=\"{os.path.basename(p)}\"\r\nContent-Type: audio/wav\r\n\r\n"
            ).encode()
            + data
            + f"\r\n--{boundary}--\r\n".encode()
        )
        req = urllib.request.Request(
            BASE + "/api/upload",
            payload,
            {"Content-Type": f"multipart/form-data; boundary={boundary}"},
        )
        print("upload", os.path.basename(p), opener.open(req).read()[:80])


def active(snap):
    """The audio element that is audibly relevant: an unpaused one first, else
    the one with the largest playhead, else the last one holding a src."""
    withsrc = [a for a in snap["audios"] if a["src"]]
    if not withsrc:
        return None
    unpaused = [a for a in withsrc if not a["paused"]]
    if unpaused:
        return unpaused[0]
    return max(withsrc, key=lambda a: a["t"])


def show(page, label):
    s = page.evaluate(SNAP)
    a = active(s)
    print(f"  [{label}] ui_pause_icon={s['uiShowsPause']} title={s['title']!r} toasts={s['toasts']}")
    for i, el in enumerate(s["audios"]):
        print(f"    audio[{i}] paused={el['paused']} t={el['t']} rs={el['readyState']} ns={el['networkState']} src=...{el['src']}")
        print(f"             ev={el['events']}")
    return s, a


def main():
    from playwright.sync_api import sync_playwright

    with sync_playwright() as p:
        kwargs = {"args": ["--autoplay-policy=no-user-gesture-required"]}
        if CHROMIUM:
            kwargs["executable_path"] = CHROMIUM
        browser = p.chromium.launch(**kwargs)
        ctx = browser.new_context(service_workers="block")
        ctx.add_init_script(INIT)
        page = ctx.new_page()
        page.on("pageerror", lambda e: print("  [pageerror]", str(e)[:200]))

        print("== login ==")
        page.goto(BASE + "/app/")
        page.fill('input[placeholder="Utilisateur"]', USER)
        page.fill('input[placeholder="Mot de passe"]', PASSWORD)
        page.click('button:has-text("Se connecter")')
        page.wait_for_selector(".sidebar", timeout=10000)

        print("== open library / local files ==")
        page.click('a[href="#/library"]')
        page.wait_for_selector('button:has-text("Mes fichiers")')
        page.click('button:has-text("Mes fichiers")')
        page.wait_for_selector('button:has-text("Tout lire")')

        # ---------- T1: baseline play / pause / play ----------
        print("\n== T1 baseline: play, pause, play ==")
        page.click('button:has-text("Tout lire")')
        page.wait_for_timeout(2500)
        s, a = show(page, "after play 2.5s")
        t1_play_ok = a and not a["paused"] and a["t"] > 0.5
        page.click(".player .pp")  # pause
        page.wait_for_timeout(1000)
        s, a = show(page, "after pause 1s")
        t1_pause_ok = a and a["paused"]
        page.click(".player .pp")  # play again
        page.wait_for_timeout(1000)
        s, a = show(page, "after resume 1s")
        t1_resume_ok = a and not a["paused"]
        print(f"T1 RESULT: play={t1_play_ok} pause={t1_pause_ok} resume={t1_resume_ok}")

        # ---------- T2: stream request HANGS on next track ----------
        print("\n== T2: next track's /api/stream HANGS -> watchdog recovery -> transport dead ==")
        hung = []
        def hang(route):
            hung.append(route)  # never fulfilled/continued: request pends forever
        page.route("**/api/stream/**", hang)
        page.click(".player .next")
        page.wait_for_timeout(1500)
        show(page, "1.5s after next (loading, hung)")
        print("  ... waiting 9s for the 6s watchdog to trigger recoverPlayback ...")
        page.wait_for_timeout(9000)
        s, a = show(page, "after watchdog window")
        t2_ui_lies = s["uiShowsPause"] and a and a["paused"]  # icon says playing, element silent
        print("  -> user presses PAUSE now")
        page.click(".player .pp")
        page.wait_for_timeout(1500)
        show(page, "1.5s after pause click")
        page.click(".player .pp")  # user retries: play
        page.wait_for_timeout(700)
        s, a = show(page, "after play retry")
        t2_play_dead = a and a["paused"] and s["uiShowsPause"]  # store playing, element still parked
        page.click(".player .pp")
        page.wait_for_timeout(1500)
        print(f"T2 RESULT: icon-playing-but-silent={t2_ui_lies}, play retries dead while recovering={t2_play_dead}")

        page.unroute("**/api/stream/**")
        page.wait_for_timeout(2000)
        page.click(".player .pp")  # play
        page.wait_for_timeout(500)
        page.click(".player .pp")  # pause
        page.wait_for_timeout(1200)
        s, a = show(page, "network OK again, user did play then pause")
        t2_state_flipped = a and (not a["paused"]) != (not s["uiShowsPause"]) or (a and not a["paused"])
        print(f"T2b RESULT: pause didn't stick / state flapped after recovery={bool(t2_state_flipped)}")

        page.click(".player .next")
        page.wait_for_timeout(2500)
        show(page, "after skipping to next track")
        page.click(".player .pp")
        page.wait_for_timeout(1000)
        s, a = show(page, "pause on the new track")
        print(f"T2c RESULT: next track plays and pause works again={bool(a and a['paused'])}")

        # ---------- T3: stream requests FAIL (502) -> skip cascade, no indicator ----------
        print("\n== T3: /api/stream answers 502 -> watchdog retry loop -> tracks skipped ==")
        page.route("**/api/stream/**", lambda r: r.fulfill(status=502, body=""))
        page.click('button:has-text("Tout lire")')
        t0 = time.time()
        saw_toast = None
        for _ in range(40):
            page.wait_for_timeout(1000)
            s = page.evaluate(SNAP)
            if any("indisponible" in t for t in s["toasts"]):
                saw_toast = round(time.time() - t0, 1)
                break
        show(page, f"after {round(time.time()-t0,1)}s of failing streams")
        print(f"T3 RESULT: 'Titre indisponible' toast after {saw_toast}s (only feedback; no loading/status indicator exists)")
        page.wait_for_timeout(12000)
        show(page, "cascade end")
        page.unroute("**/api/stream/**")

        # ---------- T4: pause during a hung quality switch ----------
        print("\n== T4: quality switch preload HANGS -> pause ignored during switch ==")
        page.click('button:has-text("Tout lire")')
        page.wait_for_timeout(2000)
        s, before = show(page, "playing before switch")
        page.route("**/api/stream/**", hang)  # the OPUS preload will hang
        page.click(".player .q")  # open quality menu
        page.wait_for_selector(".q-menu")
        page.click('.q-menu button:has-text("Opus 320")')
        page.wait_for_timeout(700)
        print("  -> user presses PAUSE during the switch")
        page.click(".player .pp")
        page.wait_for_timeout(1200)
        s, a = show(page, "1.2s after pause during switch")
        t4_ignored = a and not a["paused"] and not s["uiShowsPause"]
        page.wait_for_timeout(8000)
        s, a = show(page, "after 8s switch deadline")
        t4_applied_late = a and a["paused"]
        print(f"T4 RESULT: pause ignored during switch={bool(t4_ignored)}, applied only after ~8s deadline={bool(t4_applied_late)}")
        page.unroute("**/api/stream/**")

        browser.close()


if __name__ == "__main__":
    if "--prepare" in sys.argv:
        prepare()
    else:
        main()
