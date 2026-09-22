// AMBIENT / STRINGS — clouds, and no beat markers at all.
//
// The temptation with quiet music is to draw the same scene dimmer. That is
// wrong twice over: it still flashes on whatever the detector finds, and a
// dimmer version of a busy picture is a busy picture. So this world has NO
// event in it — nothing fires, nothing snaps, nothing is keyed to a beat. It is
// clouds moving at the speed clouds move, a horizon of light whose height is
// where the sustained energy sits, and motes rising through it.
//
// It is also the longest exposure in the set (`trail: 0.12`), so a full turn of
// the picture takes the better part of a minute.

import { approach, clamp, hsl, rng } from "../util.js";

const TAU = Math.PI * 2;

export function createNebulaWorld(preset, opts, skin = {}) {
  const p = skin.p || {};
  const CLOUDS = Math.max(2, Math.min(14, Math.round((preset.layers + 3) * (p.clouds ?? 1))));
  const BAND = p.band ?? 1;
  // `veil` draws the clouds as tall soft curtains rather than as round puffs —
  // drone and dark ambient are vertical, standing things, and a sky of circles
  // is the wrong object for them. `fall` sends the motes down instead of up,
  // which is the difference between ash and embers.
  const VEIL = clamp(p.veil ?? 0, 0, 1);
  const FALL = (p.fall ?? 0) > 0.5 ? -1 : 1;
  const SPEED = skin.speed ?? 1;
  const rand = rng(1971);
  const cloud = [];
  for (let i = 0; i < CLOUDS; i++)
    cloud.push({
      a: rand() * TAU,
      r: 0.2 + rand() * 0.75,
      va: (rand() - 0.5) * 0.06,
      vr: (rand() - 0.5) * 0.03,
      k: rand(),
      size: 0.5 + rand() * 0.7,
    });
  const MOTES = Math.max(4, Math.floor(preset.particles * 0.25 * (p.motes ?? 1)));
  const mote = new Float32Array(MOTES * 4); // x, y, speed, seed
  for (let i = 0; i < MOTES; i++) {
    mote[i * 4] = rand();
    mote[i * 4 + 1] = rand();
    mote[i * 4 + 2] = 0.01 + rand() * 0.03;
    mote[i * 4 + 3] = rand();
  }
  let level = 0;
  let tonal = 0;
  let pitch = 0.5;
  let clock = 0;

  return {
    update(frame, dt) {
      clock += dt;
      const f = frame.features;
      // Every reading here is eased over SECONDS. Nothing in this world is
      // allowed to react within a bar, because nothing in the music does.
      level = approach(level, f.level || 0, 1.6, dt);
      tonal = approach(tonal, f.tonal || 0, 2.2, dt);
      pitch = approach(pitch, f.melodyPitch ?? 0.5, 2.8, dt);
      for (const c of cloud) {
        c.a += dt * c.va * SPEED;
        c.r += dt * c.vr;
        if (c.r < 0.12 || c.r > 1.05) c.vr = -c.vr;
      }
      for (let i = 0; i < MOTES; i++) {
        const j = i * 4;
        mote[j + 1] -= dt * mote[j + 2] * FALL;
        if (FALL > 0 ? mote[j + 1] < -0.05 : mote[j + 1] > 1.05) {
          mote[j + 1] = FALL > 0 ? 1.05 : -0.05;
          mote[j] = rand();
        }
        mote[j] += Math.sin(clock * 0.3 + mote[j + 3] * 9) * 0.004 * dt;
      }
    },

    draw(g, geom, pal, w) {
      g.globalCompositeOperation = "lighter";

      // The clouds.
      for (const c of cloud) {
        const p = geom.place(c.a, c.r);
        const rad = geom.rMin * c.size * (0.6 + level * 0.5);
        const hue = pal.low + (pal.high - pal.low) * c.k;
        // A tenth of what a normal world would use. The wash here is 0.12, so
        // anything drawn settles at roughly eight times its own alpha — the
        // price of an exposure this long is that everything on it is a whisper.
        const a = (0.009 + level * 0.016) * (0.6 + tonal * 0.6) * w.energy * preset.glow;
        if (a < 0.003) continue;
        const gr = g.createRadialGradient(p[0], p[1], 0, p[0], p[1], Math.max(1, rad));
        gr.addColorStop(0, hsl(hue, pal.sat * 0.8, 0.6, a));
        gr.addColorStop(0.6, hsl(hue + 12, pal.sat * 0.7, 0.5, a * 0.35));
        gr.addColorStop(1, hsl(hue + 24, pal.sat * 0.6, 0.4, 0));
        g.fillStyle = gr;
        if (VEIL > 0.05) {
          // The same gradient stretched tall: a curtain, not a cloud. Scaled
          // rather than re-authored, so the two shapes share one light budget.
          g.save();
          g.translate(p[0], p[1]);
          g.scale(Math.max(0.12, 1 - VEIL * 0.78), 1 + VEIL * 1.6);
          g.beginPath();
          g.arc(0, 0, rad, 0, TAU);
          g.fill();
          g.restore();
        } else {
          g.beginPath();
          g.arc(p[0], p[1], rad, 0, TAU);
          g.fill();
        }
      }

      // A band of light at the height the sustained energy sits, stretched the
      // full width. It is the closest this world comes to an event: it moves
      // when the music changes register, over seconds.
      const y = geom.h * clamp(0.85 - pitch * 0.6, 0.12, 0.88);
      const thick = geom.h * (0.06 + tonal * 0.12) * BAND;
      const bg = g.createLinearGradient(0, y - thick, 0, y + thick);
      bg.addColorStop(0, hsl(pal.high, pal.sat * 0.7, 0.62, 0));
      bg.addColorStop(0.5, hsl(pal.mid, pal.sat * 0.8, 0.66, (0.012 + tonal * 0.022) * w.energy * preset.glow));
      bg.addColorStop(1, hsl(pal.low, pal.sat * 0.7, 0.55, 0));
      g.fillStyle = bg;
      g.fillRect(0, y - thick, geom.w, thick * 2);

      // Motes.
      const s = Math.max(1, geom.rMin * 0.004);
      for (let i = 0; i < MOTES; i++) {
        const j = i * 4;
        const tw = 0.45 + 0.55 * Math.abs(Math.sin(clock * 0.5 + mote[j + 3] * 8));
        g.fillStyle = hsl(pal.high, pal.sat * 0.5, 0.88, 0.05 * tw * w.energy);
        g.beginPath();
        g.arc(mote[j] * geom.w, mote[j + 1] * geom.h, s * (0.6 + mote[j + 3]), 0, TAU);
        g.fill();
      }
      g.globalCompositeOperation = "source-over";
    },
  };
}
