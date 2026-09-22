// What the music is DOING, above what this frame contains.
//
// features.js says "a kick landed and it was this hard". tempo.js says "the
// grid is here". Neither answers the questions an animation actually wants to
// ask, which are musical rather than acoustic:
//
//   Is this one of the MAIN kicks, or a note inside a roll? At 200 BPM a
//   frenchcore roll fires five hits in the time of one beat, and a scene that
//   throws something on every one of them is a strobe. The user's words for
//   this: the blocks should fall on the drop and on the main kicks, so there
//   has to be a way of telling them apart.
//
//   Is this a DROP, a build, or a breakdown? Every one of these genres is
//   written in sixteen-bar phrases with the whole arrangement pulled out and
//   put back, and the moment it comes back is the single most important event
//   in the track. Nothing downstream could see it.
//
// Everything here is O(1) per frame and allocates nothing after construction —
// a couple of dozen scalars and one sixteen-slot ring. It is not a second
// analysis pass; it is a reading of the two that already ran.
//
// MAINTAINING THIS: the constants below are musical spans (fractions of a beat,
// numbers of bars), not milliseconds, so they hold at 90 BPM and at 280. If you
// add an output, add it to `reset()` and to the projector bridge as well — an
// event that is true on one frame has to be LATCHED to survive the throttle
// (see lib/viz/bridge.js), or the second screen silently never sees it.

// How close to a beat a kick has to land to count as being ON the grid: a
// twelfth of a beat, but never tighter than a fixed few milliseconds.
//
// THE FLOOR IS THE POINT. A fraction of the beat gets narrower as the music
// gets faster, while the thing it has to accommodate — the detector's own
// latency, which is a property of the analyser's 46 ms window and not of the
// tempo — does not. At 280 BPM a twelfth of a beat is eighteen milliseconds,
// which is less than the latency itself: measured on synthesised speedcore,
// a quarter of the main kicks fell outside their own window and were filed as
// roll notes.
const ON_GRID = 1 / 12;
const ON_GRID_MIN = 0.03;
// Below this fraction of a beat, two kicks in a row are a roll rather than a
// pattern. Two thirds, so a straight eighth-note pattern (0.5) is a roll and a
// dotted one (0.75) is not.
const ROLL_GAP = 0.62;
// How long a roll is remembered after its last note, in beats. It is what makes
// `roll` a state rather than a flicker.
const ROLL_HOLD = 1.2;
// The strength a kick has to reach, against the track's own recent main kicks,
// to be called a big one. Below 1 on purpose: the point is to exclude the weak
// ones, not to find the single loudest.
const BIG = 0.82;
// Section detection. All spans are in seconds because a section is a span of
// TIME in the arrangement — a sixteen-bar phrase is twenty seconds at 190 BPM
// and nineteen at 200, and the listener does not re-time their sense of "the
// track has gone quiet" to the tempo.
const ENERGY_TAU = 0.35; // what "now" means
const REF_UP = 3; // the track's own loud level, rising
const REF_DOWN = 25; // ...and falling: slow, so a breakdown cannot reset it
const QUIET_REL = 0.62; // below this share of the reference, the track is out
const LOUD_REL = 0.82; // ...and above this, it is back
const MIN_QUIET = 1.6; // seconds out before coming back counts as a drop
const DROP_HOLD = 8; // how long a drop stays the most recent thing that happened

export function createPattern() {
  // The last few kicks: when, and how hard. Sixteen is four bars of
  // four-on-the-floor or one bar of sixteenths — enough to describe a roll and
  // to keep a running idea of what a main kick weighs.
  const N = 16;
  const kickAt = new Float64Array(N).fill(-1);
  const kickPow = new Float64Array(N);
  let kickHead = 0;

  let clock = 0;
  let mainRef = 0; // how hard this track's main kicks hit
  let rollUntil = -1;
  let rollNotes = 0;
  let rollDiv = 0; // notes per beat inside the current roll
  let energy = 0;
  let energyRef = 0;
  let quietSince = -1;
  let dropAt = -1e9;
  let breakdown = 0;
  let build = 0;
  let barsQuiet = 0;
  let lastBeatIndex = -1;
  let prevDown = false;

  const out = {
    /** True on the frame a MAIN kick lands: on the grid, not inside a roll. */
    mainKick: false,
    /** ...and how hard it hit, 0..1, held until the next one. */
    mainPower: 0,
    /** True on the frame a main kick lands that is big for this track. */
    bigKick: false,
    /** True on the frame any kick lands that is NOT a main one. */
    rollKick: false,
    /** 0..1: how much of a roll is going on right now. */
    roll: 0,
    /** Notes per beat inside the current roll (2, 3, 4...), 0 when none. */
    rollDiv: 0,
    /** How many notes the current roll has fired. */
    rollNotes: 0,
    /** True on the frame the arrangement comes back after being out. */
    drop: false,
    /** Seconds since that happened; large when it has not. */
    sinceDrop: 999,
    /** 0..1, decaying over DROP_HOLD — "we are in the drop". */
    dropped: 0,
    /** 0..1: the arrangement is out. */
    breakdown: 0,
    /** 0..1: it is coming back — rising, brightening, drums thinning. */
    build: 0,
    /** This moment against the track's own loud reference, 0..1+. */
    energy: 0,
  };

  function push(t, power) {
    kickAt[kickHead] = t;
    kickPow[kickHead] = power;
    kickHead = (kickHead + 1) % N;
  }

  function lastKick() {
    const i = (kickHead - 1 + N) % N;
    return kickAt[i] < 0 ? -1 : kickAt[i];
  }

  function update(frame, dt) {
    if (!(dt > 0)) dt = 1 / 60;
    clock += dt;
    out.mainKick = false;
    out.bigKick = false;
    out.rollKick = false;
    out.drop = false;

    const f = frame.features || {};
    const b = frame.beat || {};
    const beat = b.period > 0.15 && b.period < 2 ? b.period : 0.48;

    // --- main kick or roll note ---------------------------------------------
    if (f.kickHit) {
      const power = f.kickStrength || f.kick || 0;
      const prev = lastKick();
      const gap = prev >= 0 ? clock - prev : 99;
      // ON THE GRID is asked of the tracker's own phase, not of the interval.
      // An interval test alone cannot tell the first note of a roll from the
      // beat it starts on — they are the same note — and cannot survive a bar
      // where the kick simply does not play.
      const ph = b.locked ? Math.min(b.phase ?? 0, 1 - (b.phase ?? 0)) : 0;
      const grid = Math.max(ON_GRID, ON_GRID_MIN / beat);
      const onGrid = b.locked ? ph <= grid : true;
      const tight = gap < beat * ROLL_GAP;

      // ON THE GRID WINS OVER CLOSE TOGETHER, and the other order is a bug with
      // large consequences. A roll LEADS INTO the downbeat — that is what a
      // roll is for — so the note that lands on the beat almost always has one
      // a sixteenth behind it, and testing the interval first files the main
      // kick of every phrase as a roll note. Measured on real audio it was
      // worse than that: any spurious hit anywhere inside the previous beat
      // (an offbeat hi-hat, a stab) put the next real kick inside the window
      // too, and techno, trap and every off-kick pattern reported ZERO main
      // kicks for the whole track.
      if (onGrid && !(tight && ph > grid * 0.5)) {
        // A main kick. `mainRef` tracks what those weigh on this track, rising
        // slowly so one enormous hit does not make every later one small.
        rollNotes = 0;
        mainRef += (power - mainRef) * (power > mainRef ? 0.12 : 0.03);
        out.mainKick = true;
        out.mainPower = power;
        out.bigKick = power >= mainRef * BIG;
      } else if (tight) {
        // Inside a roll. The division is read from the gap, rounded to the
        // subdivisions anyone actually writes — halves, thirds, quarters,
        // sixths, eighths — so a scene can tell a triplet fill from a
        // sixteenth run without measuring anything itself.
        const perBeat = beat / Math.max(1e-3, gap);
        rollDiv = nearestDiv(perBeat);
        rollNotes++;
        rollUntil = clock + beat * ROLL_HOLD;
        out.rollKick = true;
      } else {
        // On no grid position and not tight enough to be a roll: a syncopated
        // hit. Real, and not a main kick.
        out.rollKick = true;
        rollUntil = Math.max(rollUntil, clock + beat * 0.4);
      }
      push(clock, power);
    }

    if (clock > rollUntil) {
      rollNotes = 0;
      rollDiv = 0;
    }
    const rollLeft = Math.max(0, rollUntil - clock) / (beat * ROLL_HOLD);
    out.roll = Math.min(1, rollLeft * Math.min(1, rollNotes / 3 + 0.34));
    out.rollDiv = rollDiv;
    out.rollNotes = rollNotes;

    // --- the arrangement ----------------------------------------------------
    // One number for "how much music is playing": the level, gated by the
    // dynamics reading so a quiet passage reads quiet however the master was
    // mastered, and weighted by percussivity so a held pad at the same level as
    // a drop is not mistaken for one.
    const now = (f.level || 0) * (f.dynamics ?? 1) * (0.55 + 0.45 * (f.percussivity || 0));
    energy += (now - energy) * (1 - Math.exp(-dt / ENERGY_TAU));
    energyRef +=
      (energy - energyRef) * (1 - Math.exp(-dt / (energy > energyRef ? REF_UP : REF_DOWN)));
    const rel = energyRef > 1e-4 ? energy / energyRef : 1;
    out.energy = rel;

    const isQuiet = rel < QUIET_REL;
    if (isQuiet) {
      if (quietSince < 0) quietSince = clock;
    } else if (rel > LOUD_REL && quietSince >= 0) {
      // Back in. A drop is the arrangement returning after it has been out
      // long enough to be missed — not every dip between two bars.
      if (clock - quietSince >= MIN_QUIET) {
        out.drop = true;
        dropAt = clock;
      }
      quietSince = -1;
    }
    breakdown +=
      ((isQuiet && quietSince >= 0 && clock - quietSince > 0.5 ? 1 : 0) - breakdown) *
      (1 - Math.exp(-dt / 0.6));
    out.breakdown = breakdown;
    out.sinceDrop = clock - dropAt;
    out.dropped = Math.max(0, 1 - out.sinceDrop / DROP_HOLD);

    // A BUILD is the one thing no single feature names: rising, brightening,
    // and the drums thinning out. Counted in bars, because it is a musical
    // span — eight bars of it is a build, half a second of it is a fill.
    const idx = b.beatIndex || 0;
    const onBeat = !!b.beat && idx !== lastBeatIndex;
    if (onBeat) lastBeatIndex = idx;
    const onBar = onBeat && !!b.downbeat && !prevDown;
    prevDown = !!b.downbeat;
    if (onBar) barsQuiet = (f.kick || 0) > 0.25 ? 0 : barsQuiet + 1;
    const thinning = Math.min(1, barsQuiet / 3);
    const rising = Math.min(1, Math.max(0, (rel - QUIET_REL) * 2.2)) * Math.min(1, (f.centroidN || 0) * 1.6);
    build += (thinning * rising - build) * (1 - Math.exp(-dt / 1.5));
    out.build = build;
    return out;
  }

  // The subdivisions rolls are written in. Anything else is rounded to the
  // nearest of them rather than reported as a fraction nobody plays.
  const DIVS = [2, 3, 4, 6, 8, 12, 16];
  function nearestDiv(perBeat) {
    let best = DIVS[0];
    let err = Infinity;
    for (const d of DIVS) {
      const e = Math.abs(Math.log(perBeat / d));
      if (e < err) {
        err = e;
        best = d;
      }
    }
    // Further than a quarter of an octave from every subdivision: it is not a
    // roll anyone wrote, so say nothing rather than guess.
    return err < 0.25 ? best : 0;
  }

  function reset() {
    kickAt.fill(-1);
    kickPow.fill(0);
    kickHead = 0;
    clock = 0;
    mainRef = 0;
    rollUntil = -1;
    rollNotes = 0;
    rollDiv = 0;
    energy = 0;
    energyRef = 0;
    quietSince = -1;
    dropAt = -1e9;
    breakdown = 0;
    build = 0;
    barsQuiet = 0;
    lastBeatIndex = -1;
    prevDown = false;
    out.mainKick = false;
    out.mainPower = 0;
    out.bigKick = false;
    out.rollKick = false;
    out.roll = 0;
    out.rollDiv = 0;
    out.rollNotes = 0;
    out.drop = false;
    out.sinceDrop = 999;
    out.dropped = 0;
    out.breakdown = 0;
    out.build = 0;
    out.energy = 0;
  }

  return { update, reset, out };
}
