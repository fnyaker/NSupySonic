/* Training kernels for the genre head, compiled to WebAssembly.
 *
 * WHY THIS EXISTS. A linear head over the frozen embedding trains in a second
 * of plain JavaScript and is enough for genres that are far apart. It is not
 * enough for the ones that are close — hardtekk against frenchcore, zaag
 * against uptempo — where the boundary is not a plane. Those need a hidden
 * layer, and a hidden layer is roughly a hundred times the arithmetic: 1280
 * inputs by 128 hidden units, forwards and backwards, for every example of
 * every epoch. That is where JavaScript stops being fast enough and this
 * starts: against the SAME loops written in JavaScript and warmed up, `fwd`
 * measures 8x and `accum_outer` 12x.
 *
 * It is deliberately tiny and deliberately dumb: four kernels, no allocation,
 * no standard library. The JavaScript side owns the linear memory and passes
 * offsets, so there is nothing here to leak and nothing to free. Built with
 * SIMD enabled and left to clang's auto-vectoriser, which handles contiguous
 * float32 loops like these well.
 *
 * Build (the result is committed, so no toolchain is needed to work on this
 * repository — see build.sh next to this file):
 *   clang --target=wasm32 -O3 -msimd128 -nostdlib -ffreestanding \
 *     -Wl,--no-entry -Wl,--export-all -Wl,--allow-undefined \
 *     -o kernel.wasm kernel.c
 */

#define EXPORT __attribute__((visibility("default")))

/* out[r] = dot(W[r], x) + b[r] */
EXPORT void fwd(const float *W, const float *b, const float *x, float *out,
                int rows, int cols) {
  for (int r = 0; r < rows; r++) {
    const float *w = W + (long)r * cols;
    float acc = 0.f;
    /* Four accumulators: the loop-carried dependency on a single one is what
       stops a vectoriser from doing anything useful with a dot product. */
    float a0 = 0.f, a1 = 0.f, a2 = 0.f, a3 = 0.f;
    int c = 0;
    for (; c + 3 < cols; c += 4) {
      a0 += w[c] * x[c];
      a1 += w[c + 1] * x[c + 1];
      a2 += w[c + 2] * x[c + 2];
      a3 += w[c + 3] * x[c + 3];
    }
    for (; c < cols; c++) acc += w[c] * x[c];
    out[r] = acc + a0 + a1 + a2 + a3 + b[r];
  }
}

/* G[r] += g[r] * x  (the outer product every gradient step is made of) */
EXPORT void accum_outer(float *G, const float *g, const float *x, int rows,
                        int cols) {
  for (int r = 0; r < rows; r++) {
    const float gr = g[r];
    if (gr == 0.f) continue;
    float *row = G + (long)r * cols;
    for (int c = 0; c < cols; c++) row[c] += gr * x[c];
  }
}

/* out = W^T . g   (propagating the error back through a layer) */
EXPORT void matvec_t(const float *W, const float *g, float *out, int rows,
                     int cols) {
  for (int c = 0; c < cols; c++) out[c] = 0.f;
  for (int r = 0; r < rows; r++) {
    const float gr = g[r];
    if (gr == 0.f) continue;
    const float *row = W + (long)r * cols;
    for (int c = 0; c < cols; c++) out[c] += gr * row[c];
  }
}

/* relu in place, and its mask for the backward pass */
EXPORT void relu(float *x, int n) {
  for (int i = 0; i < n; i++) if (x[i] < 0.f) x[i] = 0.f;
}
EXPORT void relu_back(float *d, const float *h, int n) {
  for (int i = 0; i < n; i++) if (h[i] <= 0.f) d[i] = 0.f;
}

/* One Adam step over a whole parameter block, with L2. */
EXPORT void adam(float *p, float *m, float *v, float *g, int n, float scale,
                 float lr, float l2, float bc1, float bc2) {
  const float b1 = 0.9f, b2 = 0.999f, eps = 1e-8f;
  for (int i = 0; i < n; i++) {
    const float gi = g[i] * scale + l2 * p[i];
    const float mi = b1 * m[i] + (1.f - b1) * gi;
    const float vi = b2 * v[i] + (1.f - b2) * gi * gi;
    m[i] = mi;
    v[i] = vi;
    float denom = vi / bc2;
    /* No libm in a freestanding build; Newton's method on the reciprocal
       square root is plenty for a denominator that only scales a step. */
    float rs;
    if (denom <= 0.f) {
      rs = 0.f;
    } else {
      float y = denom;
      float half = 0.5f * y;
      int i32 = *(int *)&y;
      i32 = 0x5f3759df - (i32 >> 1);
      y = *(float *)&i32;
      y = y * (1.5f - half * y * y);
      y = y * (1.5f - half * y * y);
      y = y * (1.5f - half * y * y);
      rs = y; /* 1/sqrt(denom) */
    }
    p[i] -= lr * (mi / bc1) * (rs / (1.f + eps * rs));
    g[i] = 0.f;
  }
}

EXPORT void zero(float *p, int n) {
  for (int i = 0; i < n; i++) p[i] = 0.f;
}
