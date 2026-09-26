// One WebGL2 context, and everything that is shared between the worlds drawn
// in it: the music block, the spectrum and history textures, the noise, the
// artwork, the program cache, the render targets and the post chain.
//
// A renderer belongs to a CANVAS (lib/components/Visualizer.svelte owns it),
// not to a scene: a canvas has exactly one context for its whole life, and
// rebuilding the scene — a mode change, a tier change — must not recompile the
// shaders it already has. The program cache is what makes a change of world
// instant the second time.
//
// WHAT IT DELIBERATELY DOES NOT DO: decide anything about the music. It is
// handed a packed block of numbers and a list of worlds to draw, and it draws
// them. The musical reading lives in lib/viz/scenes/gl.js.
//
// FOUR THINGS IN HERE EXIST BECAUSE A DEVICE WILL DO THEM TO US:
//
//  - CONTEXT LOSS. Mobile browsers drop WebGL contexts under memory pressure
//    and when a tab is backgrounded long enough, and a lost context never
//    draws again unless someone rebuilds everything in it. `webglcontextlost`
//    is prevented (which is what allows a restore at all), every GL object is
//    re-created on `webglcontextrestored`, and programs recompile lazily from
//    the source they were first given — a world does not know it happened.
//  - NO FLOAT TARGETS. Rendering to RGBA16F needs EXT_color_buffer_float (or
//    its half-float sibling). Nearly everything has it; what does not gets
//    RGBA8 with the scene scaled into it by HEADROOM, so the bloom and the
//    tone map still see values above one.
//  - SLOW COMPILES. A first switch to a world compiles its program, and on a
//    phone that can be a hundred milliseconds of a frozen picture. With
//    KHR_parallel_shader_compile the link runs on the driver's own thread and
//    `ready` is polled; without it the link blocks, once, and is cached.
//  - A GPU THAT IS TOO SLOW. With EXT_disjoint_timer_query_webgl2 the renderer
//    measures what a frame actually costs on the GPU (`gpuMs`), which is what
//    the scene's dynamic resolution steers on. Timing the JavaScript that ISSUES
//    the calls measures nothing — it returns long before the GPU starts.

import {
  FULLSCREEN_VS,
  MUSIC_FLOATS,
  SAMPLER_UNITS,
} from "./glsl.js";
import { DISSOLVE_FS, DOWN_FS, FINAL_FS, PREFILTER_FS, UP_FS } from "./postfx.js";

export const SPEC_W = 128;
export const HIST_H = 64;
const NOISE = 256;
// RGBA8 fallback: the scene is written divided by this and read back
// multiplied, so an 8-bit target still carries light up to HEADROOM.
const HEADROOM = 4;
// How much each coarser bloom level contributes relative to the one above it.
// At 1 every level counts the same and the widest ones — a 64th of the frame,
// blurred — lay an even haze over everything the moment the picture has bright
// sparks in it: measured on the forge, that haze alone took the drop's mean from
// 0.2 to 0.4 and turned black smoke grey. At 0.72 the tight glow a bright line
// needs is intact and the fog is gone.
const BLOOM_FALLOFF = 0.72;
// The bloom's overall strength against the scene, at a world's `bloom` of 1.
const BLOOM_GAIN = 0.55;

/** Build a renderer on `canvas`, or return null when there is no WebGL2. */
export function createRenderer(canvas, { onLost, onRestored } = {}) {
  if (!canvas || typeof canvas.getContext !== "function") return null;
  const attrs = {
    alpha: true,
    premultipliedAlpha: true,
    antialias: false,
    depth: false,
    stencil: false,
    preserveDrawingBuffer: false,
    powerPreference: "default",
  };
  let gl = null;
  try {
    gl = canvas.getContext("webgl2", attrs);
  } catch {
    gl = null;
  }
  if (!gl) return null;

  let lost = false;
  let generation = 0;
  let caps = null;
  let res = null; // every GL object this renderer owns, rebuilt on restore
  const programs = new Map(); // key -> handle
  const targets = new Set(); // world targets, re-created on restore
  const datas = new Set(); // world data textures, likewise
  let cw = 1;
  let ch = 1;
  let rw = 1;
  let rh = 1;
  let bloomLevels = 6;
  // GPU timing.
  let timer = null;
  const queries = [];
  let gpuMs = 0;
  let gpuSamples = 0;

  function detectCaps() {
    const floatExt =
      gl.getExtension("EXT_color_buffer_float") || gl.getExtension("EXT_color_buffer_half_float");
    gl.getExtension("OES_texture_float_linear");
    const parallel = gl.getExtension("KHR_parallel_shader_compile");
    timer = gl.getExtension("EXT_disjoint_timer_query_webgl2");
    return {
      hdr: !!floatExt,
      parallel,
      timer: !!timer,
      maxTex: gl.getParameter(gl.MAX_TEXTURE_SIZE),
    };
  }

  // --- small GL helpers -------------------------------------------------------
  function texture(w, h, internal, format, type, { filter = gl.LINEAR, wrap = gl.CLAMP_TO_EDGE, data = null } = {}) {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter === gl.LINEAR_MIPMAP_LINEAR ? gl.LINEAR : filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
    gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, format, type, data);
    return t;
  }

  function colorTarget(w, h) {
    const tex = caps.hdr
      ? texture(w, h, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT)
      : texture(w, h, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE);
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    return { fb, tex, w, h };
  }
  function freeTarget(t) {
    if (!t) return;
    gl.deleteFramebuffer(t.fb);
    gl.deleteTexture(t.tex);
  }

  function compileShader(type, src, name) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    return s;
  }

  function reportFailure(h) {
    const logs = [];
    for (const [s, src, kind] of [[h.vs, h.vsSrc, "vertex"], [h.fs, h.fsSrc, "fragment"]]) {
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        const log = gl.getShaderInfoLog(s) || "";
        logs.push(`${h.key} ${kind} shader:\n${log}\n${numbered(src, log)}`);
      }
    }
    if (!logs.length) logs.push(`${h.key} link:\n${gl.getProgramInfoLog(h.prog)}`);
    // A world that does not compile is a bug, and it must be loud in
    // development — but it must never take the render loop down with it. The
    // scene simply never switches to it.
    console.error("[viz] shader failed\n" + logs.join("\n"));
  }

  // --- programs -----------------------------------------------------------------
  function link(h) {
    h.gen = generation;
    h.failed = false;
    h.linked = false;
    h.loc.clear();
    h.vs = compileShader(gl.VERTEX_SHADER, h.vsSrc, h.key);
    h.fs = compileShader(gl.FRAGMENT_SHADER, h.fsSrc, h.key);
    h.prog = gl.createProgram();
    gl.attachShader(h.prog, h.vs);
    gl.attachShader(h.prog, h.fs);
    gl.linkProgram(h.prog);
  }

  // Finish a link: read its status (which BLOCKS unless the parallel extension
  // said it is complete), bind the samplers and the music block once.
  function finish(h) {
    if (!gl.getProgramParameter(h.prog, gl.LINK_STATUS)) {
      reportFailure(h);
      h.failed = true;
      return false;
    }
    gl.useProgram(h.prog);
    for (const [name, unit] of Object.entries(SAMPLER_UNITS)) {
      const l = gl.getUniformLocation(h.prog, name);
      if (l) gl.uniform1i(l, unit);
    }
    for (const [name, unit] of Object.entries(h.samplers || {})) {
      const l = gl.getUniformLocation(h.prog, name);
      if (l) gl.uniform1i(l, unit);
    }
    const bi = gl.getUniformBlockIndex(h.prog, "Music");
    if (bi !== gl.INVALID_INDEX) gl.uniformBlockBinding(h.prog, bi, 0);
    gl.detachShader(h.prog, h.vs);
    gl.detachShader(h.prog, h.fs);
    gl.deleteShader(h.vs);
    gl.deleteShader(h.fs);
    h.vs = h.fs = null;
    h.linked = true;
    return true;
  }

  /**
   * A program handle. Compiled on first use and cached by `key`; recompiled
   * transparently after a context loss. `ready` is false while a parallel
   * compile is still running, and stays false for good if it failed.
   */
  function program(key, vsSrc, fsSrc, samplers = null) {
    let h = programs.get(key);
    if (h) return h;
    h = {
      key,
      vsSrc: vsSrc || FULLSCREEN_VS,
      fsSrc,
      samplers,
      prog: null,
      vs: null,
      fs: null,
      gen: -1,
      linked: false,
      failed: false,
      loc: new Map(),
      get ready() {
        if (lost) return false;
        if (h.gen !== generation) link(h);
        if (h.failed) return false;
        if (h.linked) return true;
        if (caps.parallel && !gl.getProgramParameter(h.prog, caps.parallel.COMPLETION_STATUS_KHR))
          return false;
        return finish(h);
      },
      use() {
        gl.useProgram(h.prog);
      },
      u(name) {
        let l = h.loc.get(name);
        if (l === undefined) {
          l = gl.getUniformLocation(h.prog, name);
          h.loc.set(name, l);
        }
        return l;
      },
      f(name, x) {
        const l = h.u(name);
        if (l) gl.uniform1f(l, x);
      },
      v2(name, x, y) {
        const l = h.u(name);
        if (l) gl.uniform2f(l, x, y);
      },
      v4(name, x, y, z, w) {
        const l = h.u(name);
        if (l) gl.uniform4f(l, x, y, z, w);
      },
      v4a(name, arr) {
        const l = h.u(name);
        if (l) gl.uniform4fv(l, arr);
      },
    };
    programs.set(key, h);
    if (!lost) link(h);
    return h;
  }

  // --- the shared resources ---------------------------------------------------
  function buildNoise() {
    // Deterministic, so a screenshot today and one next month show the same
    // clouds for the same music. G is the random field; R is G read (37, 17)
    // further on, which is what lets `noise3` in glsl.js take a z step as a
    // 2D offset.
    const data = new Uint8Array(NOISE * NOISE * 4);
    let s = 0x2545f491;
    const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) >>> 24);
    const g = new Uint8Array(NOISE * NOISE);
    for (let i = 0; i < g.length; i++) g[i] = rnd();
    for (let y = 0; y < NOISE; y++)
      for (let x = 0; x < NOISE; x++) {
        const i = (y * NOISE + x) * 4;
        data[i] = g[((y + 17) & 255) * NOISE + ((x + 37) & 255)];
        data[i + 1] = g[y * NOISE + x];
        data[i + 2] = rnd();
        data[i + 3] = rnd();
      }
    return texture(NOISE, NOISE, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, {
      filter: gl.LINEAR,
      wrap: gl.REPEAT,
      data,
    });
  }

  function init() {
    caps = detectCaps();
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    const vao = gl.createVertexArray();
    const ubo = gl.createBuffer();
    gl.bindBuffer(gl.UNIFORM_BUFFER, ubo);
    gl.bufferData(gl.UNIFORM_BUFFER, MUSIC_FLOATS * 4, gl.DYNAMIC_DRAW);
    gl.bindBufferBase(gl.UNIFORM_BUFFER, 0, ubo);
    res = {
      vao,
      ubo,
      spec: texture(SPEC_W, 2, gl.R8, gl.RED, gl.UNSIGNED_BYTE),
      hist: texture(SPEC_W, HIST_H, gl.R8, gl.RED, gl.UNSIGNED_BYTE, { wrap: gl.REPEAT }),
      noise: buildNoise(),
      cover: texture(1, 1, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, { data: new Uint8Array([40, 30, 60, 255]) }),
      black: texture(1, 1, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, { data: new Uint8Array([0, 0, 0, 0]) }),
      scene: null,
      mips: [],
    };
    // A float target that the driver claims to support but will not attach is
    // a thing that happens; test it once, fall back to 8 bits if so.
    if (caps.hdr) {
      const probe = colorTarget(4, 4);
      const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
      freeTarget(probe);
      if (!ok) caps.hdr = false;
    }
    histHead = 0;
    coverOK = 0;
    for (const d of datas) d.rebuild();
    allocate();
  }

  // Sized targets: the scene target (only drawn into during a dissolve) and
  // the bloom mips, all following the render size.
  function allocate() {
    if (!res) return;
    freeTarget(res.scene);
    for (const m of res.mips) freeTarget(m);
    res.scene = colorTarget(rw, rh);
    res.mips = [];
    let w = Math.max(1, rw >> 1);
    let h = Math.max(1, rh >> 1);
    for (let i = 0; i < bloomLevels && w >= 4 && h >= 4; i++) {
      res.mips.push(colorTarget(w, h));
      w = Math.max(1, w >> 1);
      h = Math.max(1, h >> 1);
    }
    for (const t of targets) t.rebuild();
  }

  // --- world targets ----------------------------------------------------------
  /**
   * Where one world draws. A feedback world gets two textures and reads the
   * one it wrote last frame; everything else gets one. Follows the render size
   * on its own, and survives a context loss (with its contents cleared).
   */
  function worldTarget(feedback = false) {
    const t = {
      feedback,
      a: null,
      b: null,
      out: null, // the texture holding the latest frame
      rebuild() {
        freeTarget(t.a);
        freeTarget(t.b);
        t.a = colorTarget(rw, rh);
        t.b = feedback ? colorTarget(rw, rh) : null;
        t.out = t.a.tex;
        t.fresh = true;
      },
      dispose() {
        freeTarget(t.a);
        freeTarget(t.b);
        t.a = t.b = null;
        targets.delete(t);
      },
      fresh: true,
    };
    targets.add(t);
    if (!lost && res) t.rebuild();
    return t;
  }

  // --- world data ---------------------------------------------------------------
  /**
   * A float texture a world's driver fills on the CPU — the oscilloscope's
   * trace, computed in Rust and uploaded straight from the WebAssembly
   * module's memory. RG32F read with texelFetch: no filtering, so no
   * extension, and exact values. Survives a context loss like a target does
   * (rebuilt on restore; the next upload refills it).
   */
  function dataTexture(w, h) {
    const d = {
      w,
      h,
      tex: null,
      rebuild() {
        d.tex = texture(w, h, gl.RG32F, gl.RG, gl.FLOAT, { filter: gl.NEAREST });
      },
      upload(src) {
        if (lost || !d.tex) return;
        gl.bindTexture(gl.TEXTURE_2D, d.tex);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RG, gl.FLOAT, src);
      },
      dispose() {
        if (d.tex && !lost) gl.deleteTexture(d.tex);
        d.tex = null;
        datas.delete(d);
      },
    };
    datas.add(d);
    if (!lost && res) d.rebuild();
    return d;
  }

  // --- per frame --------------------------------------------------------------
  let histHead = 0;
  let coverOK = 0;
  let frameQuery = null;

  function setSize(canvasW, canvasH, scale, levels) {
    const nw = Math.max(1, Math.round(canvasW));
    const nh = Math.max(1, Math.round(canvasH));
    if (canvas.width !== nw || canvas.height !== nh) {
      canvas.width = nw;
      canvas.height = nh;
    }
    cw = nw;
    ch = nh;
    // Even sizes keep the mip chain's halvings exact.
    const s = Math.max(0.2, Math.min(1, scale || 1));
    const nrw = Math.max(2, Math.round((nw * s) / 2) * 2);
    const nrh = Math.max(2, Math.round((nh * s) / 2) * 2);
    const lv = levels || bloomLevels;
    if (nrw === rw && nrh === rh && lv === bloomLevels && res?.scene) return false;
    rw = nrw;
    rh = nrh;
    bloomLevels = lv;
    if (!lost) allocate();
    return true;
  }

  function beginFrame(music, spec, histRow, headroomAware = true) {
    if (lost || !res) return false;
    // Timing starts here and ends in `present`: the whole frame, worlds and
    // post, is what the resolution governor needs to know about.
    pollTimer();
    if (timer && !frameQuery && queries.length < 4) {
      frameQuery = gl.createQuery();
      gl.beginQuery(timer.TIME_ELAPSED_EXT, frameQuery);
    }
    gl.bindVertexArray(res.vao);
    gl.bindBuffer(gl.UNIFORM_BUFFER, res.ubo);
    gl.bufferSubData(gl.UNIFORM_BUFFER, 0, music);
    gl.bindBufferBase(gl.UNIFORM_BUFFER, 0, res.ubo);
    gl.bindTexture(gl.TEXTURE_2D, res.spec);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, SPEC_W, 2, gl.RED, gl.UNSIGNED_BYTE, spec);
    if (histRow) {
      gl.bindTexture(gl.TEXTURE_2D, res.hist);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, histHead, SPEC_W, 1, gl.RED, gl.UNSIGNED_BYTE, histRow);
      histHead = (histHead + 1) % HIST_H;
    }
    void headroomAware;
    return true;
  }

  function bindCommon(prevTex, dataTex = null) {
    gl.activeTexture(gl.TEXTURE0 + SAMPLER_UNITS.uPrev);
    gl.bindTexture(gl.TEXTURE_2D, prevTex || res.black);
    gl.activeTexture(gl.TEXTURE0 + SAMPLER_UNITS.uSpec);
    gl.bindTexture(gl.TEXTURE_2D, res.spec);
    gl.activeTexture(gl.TEXTURE0 + SAMPLER_UNITS.uHist);
    gl.bindTexture(gl.TEXTURE_2D, res.hist);
    gl.activeTexture(gl.TEXTURE0 + SAMPLER_UNITS.uNoise);
    gl.bindTexture(gl.TEXTURE_2D, res.noise);
    gl.activeTexture(gl.TEXTURE0 + SAMPLER_UNITS.uCover);
    gl.bindTexture(gl.TEXTURE_2D, res.cover);
    gl.activeTexture(gl.TEXTURE0 + SAMPLER_UNITS.uData);
    gl.bindTexture(gl.TEXTURE_2D, dataTex || res.black);
    gl.activeTexture(gl.TEXTURE0);
  }

  /**
   * Draw one world into its target. `fill(h)` sets the world's own uniforms on
   * whichever program is bound (the main pass, then its particles). Returns
   * false when the program is not ready yet.
   */
  function drawWorld(h, target, fill, particles = null, data = null) {
    if (lost || !res || !h.ready || !target.a) return false;
    const src = target.feedback ? (target.fresh ? res.black : target.out) : null;
    const dst = target.feedback && target.out === target.a.tex ? target.b : target.a;
    gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fb);
    gl.viewport(0, 0, rw, rh);
    gl.disable(gl.BLEND);
    h.use();
    bindCommon(src, data?.tex || null);
    prep(h);
    fill(h);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    if (particles && particles.count > 0 && particles.h.ready) {
      gl.enable(gl.BLEND);
      // Sprites ADD, as light does — except where a world draws one continuous
      // line out of many pieces (the scope's trace), which takes the MAX, so
      // the joints between pieces are not twice as bright as the pieces.
      if (particles.blendMax) gl.blendEquation(gl.MAX);
      else gl.blendFunc(gl.ONE, gl.ONE);
      particles.h.use();
      prep(particles.h);
      fill(particles.h);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, particles.count);
      if (particles.blendMax) gl.blendEquation(gl.FUNC_ADD);
      gl.disable(gl.BLEND);
    }
    target.out = dst.tex;
    target.fresh = false;
    return true;
  }

  // What every world program is told regardless of what it draws.
  function prep(h) {
    h.v2("uRes", rw, rh);
    h.f("uHistHead", ((histHead - 0.5 + HIST_H) % HIST_H) / HIST_H);
    h.f("uCoverOK", coverOK);
    h.f("uHeadroom", caps.hdr ? 1 : 1 / HEADROOM);
  }

  function post(key, fs, samplers) {
    return program("post:" + key, FULLSCREEN_VS, fs, samplers);
  }

  function pass(h, fb, w, hgt) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.viewport(0, 0, w, hgt);
    h.use();
  }

  function bindTex(unit, tex) {
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
  }

  /**
   * Composite the worlds and grade the result onto the canvas.
   *
   * `a` is the leaving world's target (or null), `b` the arriving / only one,
   * `t` the dissolve's progress. `look` carries the grade:
   *   { exposure, bloom, threshold, knee, ca, grain, saturation, lift,
   *     transparent, time }
   */
  function present(a, b, t, seed, look) {
    if (lost || !res) return false;
    const pre = post("prefilter", PREFILTER_FS);
    const down = post("down", DOWN_FS);
    const up = post("up", UP_FS);
    const fin = post("final", FINAL_FS, { uScene: 0, uBloom: 1 });
    const dis = post("dissolve", DISSOLVE_FS, { uA: 0, uB: 1 });
    if (!pre.ready || !down.ready || !up.ready || !fin.ready || !dis.ready) return false;

    let src = b ? b.out : a ? a.out : res.black;
    if (a && b && a.out && b.out) {
      pass(dis, res.scene.fb, rw, rh);
      bindTex(0, a.out);
      bindTex(1, b.out);
      dis.f("uT", t);
      dis.f("uSeed", seed);
      dis.f("uAspect", rw / rh);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      src = res.scene.tex;
    }

    // --- bloom ---
    const mips = res.mips;
    if (look.bloom > 0 && mips.length) {
      pass(pre, mips[0].fb, mips[0].w, mips[0].h);
      bindTex(0, src);
      pre.v2("uTexel", 1 / rw, 1 / rh);
      pre.v2("uThresh", look.threshold, look.knee);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      for (let i = 1; i < mips.length; i++) {
        pass(down, mips[i].fb, mips[i].w, mips[i].h);
        bindTex(0, mips[i - 1].tex);
        down.v2("uTexel", 1 / mips[i - 1].w, 1 / mips[i - 1].h);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      }
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
      for (let i = mips.length - 1; i > 0; i--) {
        pass(up, mips[i - 1].fb, mips[i - 1].w, mips[i - 1].h);
        bindTex(0, mips[i].tex);
        up.v2("uTexel", 1 / mips[i].w, 1 / mips[i].h);
        up.f("uRadius", 1);
        up.f("uWeight", BLOOM_FALLOFF);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      }
      gl.disable(gl.BLEND);
    }

    // --- grade onto the canvas ---
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, cw, ch);
    fin.use();
    bindTex(0, src);
    bindTex(1, mips.length ? mips[0].tex : res.black);
    const head = caps.hdr ? 1 : HEADROOM;
    // The mip sum holds every level's copy of the light, each coarser one
    // attenuated by BLOOM_FALLOFF on its way up, so it is normalised by the sum
    // of those weights: the strength setting then means the same thing at a
    // tier with four levels and one with seven.
    let wsum = 0;
    for (let i = 0, w = 1; i < mips.length; i++, w *= BLOOM_FALLOFF) wsum += w;
    const bk = mips.length ? (look.bloom * BLOOM_GAIN) / wsum : 0;
    fin.v4("uPost", look.exposure * head, bk, look.ca, look.grain);
    fin.v4("uPost2", look.time, look.transparent ? 1 : 0, look.lift, look.saturation);
    fin.v2("uCanvas", cw, ch);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.activeTexture(gl.TEXTURE0);

    if (frameQuery) {
      gl.endQuery(timer.TIME_ELAPSED_EXT);
      queries.push(frameQuery);
      frameQuery = null;
    }
    return true;
  }

  function pollTimer() {
    if (!timer || !queries.length) return;
    const disjoint = gl.getParameter(timer.GPU_DISJOINT_EXT);
    while (queries.length) {
      const q = queries[0];
      if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) break;
      const ns = gl.getQueryParameter(q, gl.QUERY_RESULT);
      gl.deleteQuery(q);
      queries.shift();
      if (disjoint) continue;
      const ms = ns / 1e6;
      gpuMs = gpuSamples ? gpuMs + (ms - gpuMs) * 0.1 : ms;
      gpuSamples++;
    }
  }

  function clear() {
    if (lost || !res) return;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, cw, ch);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    for (const t of targets) t.fresh = true;
  }

  /** The artwork, as an <img> or <canvas> that is already loaded, or null. */
  function setCover(img) {
    if (lost || !res) return;
    if (!img) {
      coverOK = 0;
      return;
    }
    try {
      gl.bindTexture(gl.TEXTURE_2D, res.cover);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, img);
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      coverOK = 1;
    } catch {
      // A tainted image (a CDN that stopped sending CORS headers): keep the
      // placeholder rather than failing the frame.
      coverOK = 0;
    }
  }

  function dispose() {
    for (const t of [...targets]) t.dispose();
    for (const h of programs.values()) if (h.prog) gl.deleteProgram(h.prog);
    programs.clear();
    if (res) {
      freeTarget(res.scene);
      for (const m of res.mips) freeTarget(m);
      for (const k of ["spec", "hist", "noise", "cover", "black"]) gl.deleteTexture(res[k]);
      gl.deleteBuffer(res.ubo);
      gl.deleteVertexArray(res.vao);
    }
    for (const q of queries) gl.deleteQuery(q);
    queries.length = 0;
    res = null;
    canvas.removeEventListener("webglcontextlost", onLostEv);
    canvas.removeEventListener("webglcontextrestored", onRestoredEv);
  }

  function onLostEv(e) {
    e.preventDefault();
    lost = true;
    queries.length = 0;
    frameQuery = null;
    onLost?.();
  }
  function onRestoredEv() {
    lost = false;
    generation++;
    init();
    onRestored?.();
  }
  canvas.addEventListener("webglcontextlost", onLostEv);
  canvas.addEventListener("webglcontextrestored", onRestoredEv);

  init();

  return {
    gl,
    get caps() {
      return caps;
    },
    get lost() {
      return lost;
    },
    get size() {
      return { cw, ch, rw, rh };
    },
    /** Smoothed GPU milliseconds per frame, or 0 when it cannot be measured. */
    get gpuMs() {
      return gpuSamples > 3 ? gpuMs : 0;
    },
    program,
    worldTarget,
    dataTexture,
    setSize,
    beginFrame,
    drawWorld,
    present,
    clear,
    setCover,
    dispose,
  };
}

// Numbered source around the lines a compile log complains about.
function numbered(src, log) {
  const lines = src.split("\n");
  const bad = new Set();
  for (const m of log.matchAll(/\d+:(\d+)/g)) bad.add(+m[1]);
  // `#line 1` resets the numbering at the world's own body; find it so the
  // numbers in the log point at the right lines.
  const at = lines.findIndex((l) => l.startsWith("#line 1"));
  const base = at >= 0 ? at + 1 : 0;
  const out = [];
  for (const n of bad) {
    for (let k = Math.max(1, n - 2); k <= n + 2; k++) {
      const i = base + k - 1;
      if (i < lines.length) out.push(`${k === n ? ">" : " "}${String(k).padStart(4)}| ${lines[i]}`);
    }
    out.push("");
  }
  return out.join("\n");
}
