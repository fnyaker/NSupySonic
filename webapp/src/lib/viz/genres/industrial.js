// INDUSTRIAL HARDCORE — the room, not the rig.
//
// Industrial hardcore is the one branch of this family that is about SPACE.
// Its kicks are long, its reverbs are enormous, its percussion is metal hit in
// a hall, and the arrangements leave holes on purpose — where gabber fills
// every sixteenth, this lets a hit ring out for a bar. The character is the
// decay, not the attack.
//
// So the picture is a HALL: a deep perspective corridor of girders, with every
// hit travelling away from the viewer down it and ringing as it goes. Nothing
// flashes in place; everything recedes. The reverb is drawn as the thing it is
// — a hit that is still visible long after it happened, further away each time
// you look.
//
// Travel is per bar, so a girder crosses the hall in a musical span. The
// tonality reading decides how metallic the light is: a clean sustained note
// lights the hall warmly, a destroyed one makes it a foundry.

import { clamp, hsl, lerp } from "../util.js";
import { pool, quad } from "./kit.js";

export const meta = { label: "Industrial", trail: 0.3 };

export function create(preset, opts) {
  // Sixteen girders receding, plus the hits that ring between them.
  const hits = pool(12, () => ({ age: -1, x: 0, power: 0, metal: 0 }));
  const HIT_LIFE = 6; // beats — the reverb IS the genre
  let depth = 0;
  let metal = 0.5;

  return {
    update(frame, dt, geom, m) {
      if (m.mainKick || m.hit || (m.onBeat && m.kick > 0.3)) {
        const h = hits.take();
        h.age = 0;
        h.power = clamp(0.5 + (m.mainPower || m.kick) * 0.8, 0, 1.4);
        // Across the hall, following the bar: a hall has width and a hit has
        // a place in it.
        h.x = 0.5 + Math.sin(m.barPhase * Math.PI * 2) * 0.34;
        h.metal = metal;
      }
      // A mid-band attack that is not the kick is the metal being struck, and
      // in this genre that is most of the arrangement.
      if (m.onset > 0.45 && !m.mainKick) {
        const h = hits.take();
        h.age = 0;
        h.power = 0.25 + m.onset * 0.4;
        h.x = 0.12 + ((m.beatPhase * 3) % 1) * 0.76;
        h.metal = 1;
      }
      hits.age(dt, m.beat, HIT_LIFE);
      // How far down the hall we are travelling: the drive pushes the viewer
      // forward, a breakdown lets the hall open out.
      depth += dt * m.perBar(0.5 + m.drive * 0.8);
      metal = m.ease(metal, clamp((frame.features?.flatness || 0) * 1.4 + m.chaos * 0.3, 0, 1), 3, dt);
    },

    draw(g, geom, pal, w, m) {
      const W = geom.w;
      const H = geom.h;
      // The vanishing point sits behind the artwork when there is one, so the
      // hall runs past it rather than into it.
      const vx = W * 0.5;
      const vy = geom.hole ? geom.cy : H * 0.48;
      g.globalCompositeOperation = "lighter";

      // The girders: rectangles in perspective, receding. Each one spans the
      // WHOLE frame at its nearest, so the hall's walls are the screen edges.
      //
      // THE HALL STARTS AT THE ARTWORK'S RIM. A corridor built around the
      // centre puts its far end — where the girders are small, dense and
      // numerous — exactly where the album cover is, and that is where a third
      // of this scene's ink was going. `ringRx`/`ringRy` are the frame's own
      // perspective: radial 0 is the rim (the whole frame's centre when there
      // is no artwork), radial 1 is out past the corners.
      const RINGS = 9;
      for (let i = 0; i < RINGS; i++) {
        const t = ((depth + i / RINGS) % 1);
        // Perspective: near the viewer things move fast and are huge.
        const u = t * t * 1.15;
        const hw = geom.ringRx(u);
        const hh = geom.ringRy(u);
        const a = (1 - t) * (0.05 + m.drive * 0.12) * w.energy * preset.glow;
        if (a < 0.004 || hw < 2) continue;
        const s = 0.06 + t * t * 2.1;
        const hue = pal.low + (pal.high - pal.low) * (1 - t) * 0.6;
        g.strokeStyle = hsl(hue, pal.sat * (0.3 + metal * 0.5), lerp(0.35, 0.8, 1 - t), a);
        g.lineWidth = Math.max(1, geom.rMin * 0.012 * s * (0.5 + m.weight));
        g.strokeRect(vx - hw, vy - hh, hw * 2, hh * 2);
      }

      // The hits, ringing as they recede. A hit is a bar of light across the
      // hall, dimming and shrinking for six beats — which at 150 BPM is two
      // and a half seconds of reverb, drawn.
      for (const h of hits.items) {
        if (h.age < 0) continue;
        const t = h.age / HIT_LIFE;
        const a = (1 - t) * (1 - t) * h.power * 0.4 * w.energy * preset.glow;
        if (a < 0.005) continue;
        // Same perspective, and the hit rides the ring's own lower edge — so a
        // hit ringing out for six beats travels down the hall PAST the artwork
        // instead of through it.
        const u = (1 - t) * (1 - t) * 1.15;
        const hw = geom.ringRx(u);
        const hh = geom.ringRy(u);
        const x = vx + (h.x - 0.5) * hw * 1.6;
        const y = vy + hh;
        const len = hw * (0.16 + h.power * 0.2);
        const th = hh * 0.06 * (0.5 + h.metal);
        g.fillStyle = hsl(
          pal.high - h.metal * 20,
          pal.sat * (0.2 + h.metal * 0.6),
          lerp(0.6, 0.95, h.power * (1 - t)),
          a
        );
        quad(g, x - len, y - th, x + len, y - th, x + len * 0.8, y + th, x - len * 0.8, y + th);
        g.fill();
      }

      // The far light: the end of the hall, which is where everything is going.
      const fg = g.createRadialGradient(vx, vy, 0, vx, vy, geom.rMin * (0.3 + m.calm * 0.4));
      fg.addColorStop(0, hsl(pal.mid, pal.sat * 0.4, 0.7, (0.04 + m.calm * 0.1) * w.energy * preset.glow));
      fg.addColorStop(1, hsl(pal.low, pal.sat, 0.4, 0));
      g.fillStyle = fg;
      g.fillRect(0, 0, W, H);
      g.globalCompositeOperation = "source-over";
      void opts;
    },
  };
}
