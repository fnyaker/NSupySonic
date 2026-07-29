# Reproduction harness for "paused 2-3 minutes -> the player is frozen, pressing
# play does nothing".
#
# Same setup as e2e_transport_repro.py (see its header); run that one's
# --prepare first, then:
#
#   .venv/bin/python docs/repro/e2e_pause_resume_repro.py
#   NS_LONG_PAUSE=180 .venv/bin/python docs/repro/e2e_pause_resume_repro.py
#
# What a long pause actually does to the element is browser- and OS-specific
# (Chromium suspends an idle paused media player and releases its decoder; an
# Android WebView goes further and can drop the whole resource), so the cases
# below drive the two OBSERVABLE outcomes a resume can hit, which is what the
# app has to survive either way:
#
#   R1  baseline play / pause / resume                             (sanity)
#   R2  a real wall-clock pause, then resume                       (slow, opt-in)
#   R3  the resume's play() REJECTS once — what a failed
#       resume-after-suspend or a denied audio focus looks like
#   R4  the element lost its buffered resource AND the stream is
#       dead when it goes back for it
#
# The failure being looked for is the same in R2-R4: the store still says
# "playing", the element stays paused, and NOTHING gets it out of that — the
# watchdog bailed on a paused element by design, so the transport was wedged
# with a pause icon over silence until the track was changed by hand.
#
# Measured against the code BEFORE the fix: R3 and R4 never resumed, at all,
# and showed no status while stuck. R2 passes on desktop Chromium even at 180s
# (it keeps the resource), which is exactly why R3/R4 exist — they reproduce
# the OUTCOME an Android WebView produces, on any machine, in seconds.
import os
import sys

BASE = os.environ.get("NS_BASE", "http://localhost:5722")
USER = os.environ.get("NS_USER", "admin")
PASSWORD = os.environ.get("NS_PASSWORD", "adminpw")
CHROMIUM = os.environ.get("NS_CHROMIUM")
# 0 disables the slow case; set e.g. 180 to reproduce the user-reported timing.
LONG_PAUSE = float(os.environ.get("NS_LONG_PAUSE", "0"))

INIT = """
(() => {
  const OA = window.Audio;
  window.__audios = [];
  window.Audio = function (...args) {
    const el = new OA(...args);
    el.__events = [];
    for (const ev of ["play","pause","error","stalled","loadedmetadata","waiting","playing","abort","emptied","suspend"]) {
      el.addEventListener(ev, () => {
        el.__events.push(ev);
        if (el.__events.length > 30) el.__events.shift();
      });
    }
    window.__audios.push(el);
    return el;
  };
  window.Audio.prototype = OA.prototype;

  // Arm a one-shot rejection of the next play() call (case R3).
  window.__failNextPlay = () => {
    const proto = Object.getPrototypeOf(window.__audios[0] || new OA());
    const real = proto.play;
    proto.play = function () {
      proto.play = real;
      return Promise.reject(new DOMException("simulated", "AbortError"));
    };
  };
})();
"""

SNAP = """
() => ({
  audios: (window.__audios || []).map((a) => ({
    src: (a.src || "").slice(-46),
    paused: a.paused,
    t: Math.round(a.currentTime * 100) / 100,
    readyState: a.readyState,
    networkState: a.networkState,
    events: (a.__events || []).slice(-6),
  })),
  uiShowsPause: !!document.querySelector(".player .pp svg rect"),
  statusText: (document.querySelector(".player .now .a.status") || {}).textContent || "",
  toasts: [...document.querySelectorAll(".toasts .toast")].map((t) => t.textContent.trim()),
})
"""


def active(snap):
    withsrc = [a for a in snap["audios"] if a["src"]]
    if not withsrc:
        return None
    unpaused = [a for a in withsrc if not a["paused"]]
    return unpaused[0] if unpaused else max(withsrc, key=lambda a: a["t"])


def show(page, label):
    s = page.evaluate(SNAP)
    a = active(s)
    print(
        f"  [{label}] ui_pause_icon={s['uiShowsPause']} status={s['statusText']!r} "
        f"toasts={s['toasts']}"
    )
    for i, el in enumerate(s["audios"]):
        if not el["src"]:
            continue
        print(
            f"    audio[{i}] paused={el['paused']} t={el['t']} rs={el['readyState']} "
            f"ns={el['networkState']} ev={el['events']}"
        )
    return s, a


def resumes(page, label, settle_ms=9000, step_ms=500):
    """Press play and report whether audio ACTUALLY got going again.

    Polls rather than sampling once: a resume is allowed to take a moment (a
    reload + reseek), it is just not allowed to never happen.
    """
    before = active(page.evaluate(SNAP))
    t0 = before["t"] if before else 0
    page.click(".player .pp")
    waited = 0
    while waited < settle_ms:
        page.wait_for_timeout(step_ms)
        waited += step_ms
        a = active(page.evaluate(SNAP))
        if a and not a["paused"] and a["t"] > t0 + 0.2:
            print(f"  [{label}] recovered after {waited}ms (t {t0} -> {a['t']})")
            return True
    show(page, label + " / still stuck")
    print(f"  [{label}] NEVER resumed within {settle_ms}ms")
    return False


def restart(page):
    """Back to a known state: playing from the top, whatever the last case left.

    Cases must not inherit each other's wedge — a stuck transport makes the very
    next `.pp` click mean the opposite of what the case intends.
    """
    page.reload()
    page.wait_for_selector(".sidebar", timeout=15000)
    page.click('a[href="#/library"]')
    page.wait_for_selector('button:has-text("Mes fichiers")')
    page.click('button:has-text("Mes fichiers")')
    page.wait_for_selector('button:has-text("Tout lire")')
    page.click('button:has-text("Tout lire")')
    page.wait_for_timeout(3000)
    a = active(page.evaluate(SNAP))
    if not a or a["paused"]:
        show(page, "restart FAILED to get playback going")
        return False
    return True


def pause(page):
    """Pause via the transport, confirmed against the element."""
    for _ in range(3):
        a = active(page.evaluate(SNAP))
        if a and a["paused"]:
            return True
        page.click(".player .pp")
        page.wait_for_timeout(1000)
    return False


def main():
    from playwright.sync_api import sync_playwright

    results = {}
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
        page.wait_for_selector(".sidebar", timeout=15000)

        print("== open library / local files ==")
        page.click('a[href="#/library"]')
        page.wait_for_selector('button:has-text("Mes fichiers")')
        page.click('button:has-text("Mes fichiers")')
        page.wait_for_selector('button:has-text("Tout lire")')
        page.click('button:has-text("Tout lire")')
        page.wait_for_timeout(3000)
        show(page, "playing")

        # ---------- R1: baseline short pause ----------
        print("\n== R1: pause 2s, resume ==")
        page.click(".player .pp")
        page.wait_for_timeout(2000)
        results["R1 short pause"] = resumes(page, "R1")

        # ---------- R2: a real long pause ----------
        if LONG_PAUSE > 0:
            print(f"\n== R2: pause {LONG_PAUSE:.0f}s (wall clock), resume ==")
            restart(page)
            pause(page)
            waited = 0.0
            while waited < LONG_PAUSE:
                page.wait_for_timeout(10000)
                waited += 10
                if waited % 60 == 0:
                    print(f"  ...{waited:.0f}s paused")
            show(page, "R2 after the long pause")
            results[f"R2 {LONG_PAUSE:.0f}s pause"] = resumes(page, "R2")
        else:
            print("\n== R2 skipped (set NS_LONG_PAUSE=180 to run it) ==")

        # ---------- R3: the resume's play() rejects once ----------
        print("\n== R3: resume where play() rejects once ==")
        restart(page)
        pause(page)
        page.evaluate("window.__failNextPlay()")
        results["R3 play() rejects"] = resumes(page, "R3", settle_ms=15000)

        # ---------- R4: resource dropped + dead stream on resume ----------
        print("\n== R4: element lost its buffer and the stream is dead ==")
        restart(page)
        pause(page)
        def kill(route):
            route.abort()

        page.route("**/api/stream/**", kill)
        # What a browser reclaiming a paused player's resources leaves behind.
        page.evaluate(
            """() => {
                const a = (window.__audios || []).find((x) => x.src);
                if (a) a.load();
            }"""
        )
        page.wait_for_timeout(500)
        ok = resumes(page, "R4", settle_ms=12000)
        page.unroute("**/api/stream/**")
        if not ok:
            # Not resuming while the stream really is dead is CORRECT — what
            # matters is that it says so and comes back by itself once the
            # network does. Generous window: the recovery ladder backs off and
            # each attempt carries a 12s deadline, so a fixed short wait just
            # measures where in that ladder we happened to land.
            print("  R4: stream restored, waiting up to 40s for self-recovery...")
            for _ in range(40):
                page.wait_for_timeout(1000)
                a = active(page.evaluate(SNAP))
                if a and not a["paused"]:
                    ok = True
                    break
            print(f"  R4 self-recovery after the network came back: {ok}")
            if not ok:
                show(page, "R4 end")
        results["R4 dead resume"] = ok

        browser.close()

    print("\n=== RESULTS ===")
    bad = 0
    for k, v in results.items():
        if not v:
            bad += 1
        print(f"  {'OK  ' if v else 'FAIL'}  {k}")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
