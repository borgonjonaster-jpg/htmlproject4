/*
  CHROMA — GPU engine (WebGL2). A layered 2D field renderer, not a 3D scene.

    pass 1 · FIELD   per pixel: symmetry fold → domain warp → base field → either up to 64 gradient primitives composited
                     in OKLab / linear light, or the rectangle tree (exact tiling, seamless windows, optional visible edges)
                     → iridescence, interference, micro detail. Output: linear RGB + coverage (RGBA16F).
                     The same shader renders a low-resolution copy of the whole image (MRT: colour + glow emission).
    pass 2 · LOW     the low-resolution copy is thresholded and blurred into glow (two radii), bloom, local contrast and the
                     large-radius global blur. They cover the whole image, so tiles and previews share exactly the same values.
    pass 3 · POST    global blur (full resolution for small radii, the pyramid for large ones), chromatic displacement,
                     digital artifacts, glow, tone, gamut mapping, texture, grain, posterization, ordered dither → 8-bit sRGB.
                     Every procedural term reads the folded coordinate, so strict symmetry survives the whole pipeline.

  Every stage is a function of the image coordinate, so the export renders the target resolution directly in tiles
  that match seamlessly. Changing a post parameter (grain, dither, contrast…) re-runs only pass 3.

    const eng = ChromaEngine.create(canvas)
    eng.preview(scene, view)                 view: {W, H, ox, oy, scl, tw, th, fast}  (image px, image px per target px)
    eng.pixels(scene, W, H, ox, oy, scl, tw, th) → Uint8Array (rows top-first)
    eng.exportTiles(scene, W, H, onBand, onProgress, isCancelled)
*/
(function (G) {
'use strict';
const CC = G.ChromaCore, LT = CC.LT, MAXL = CC.MAXL;

const VS = `#version 300 es
in vec2 aPos; void main() { gl_Position = vec4(aPos, 0., 1.); }`;

const COMMON = `
precision highp float; precision highp int; precision highp sampler2D;
const float TAU = 6.28318530718;
uniform float uEnc;                       // 1 when render targets are 8-bit: linear values are stored sqrt-encoded
vec3 enc(vec3 c) { return uEnc > .5 ? sqrt(max(c, 0.)) : c; }
vec3 dec(vec3 c) { return uEnc > .5 ? c * c : c; }
uint pcg(uint v) { uint s = v * 747796405u + 2891336453u; uint w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u; return (w >> 22u) ^ w; }
uint h2(ivec2 c, uint s) { return pcg(uint(c.x) * 1597334677u ^ pcg(uint(c.y) ^ (s * 3812015801u))); }
float h01(ivec2 c, uint s) { return float(h2(c, s)) * (1. / 4294967296.); }
vec2 grd(ivec2 c, uint s) { uint h = h2(c, s); return vec2(float(h & 65535u), float(h >> 16)) * (2. / 65535.) - 1.; }
float gnoise(vec2 p, uint s) {
  vec2 fl = floor(p); ivec2 i = ivec2(fl); vec2 f = p - fl; vec2 u = f * f * f * (f * (f * 6. - 15.) + 10.);
  float a = dot(grd(i, s), f), b = dot(grd(i + ivec2(1, 0), s), f - vec2(1, 0)), c = dot(grd(i + ivec2(0, 1), s), f - vec2(0, 1)), d = dot(grd(i + ivec2(1, 1), s), f - vec2(1, 1));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y) * 1.4;
}
float fbm(vec2 p, int oct, float g, uint s) {
  float a = 1., t = 0., n = 0.;
  for (int i = 0; i < 6; i++) { if (i >= oct) break; t += a * gnoise(p, s + uint(i) * 1013u); n += a; p = mat2(.8, -.6, .6, .8) * p * 2.03 + vec2(17.1, 9.3); a *= g; }
  return t / n;
}
vec2 rot2(vec2 v, float a) { float c = cos(a), s = sin(a); return vec2(c * v.x - s * v.y, s * v.x + c * v.y); }
float cbrt(float x) { return sign(x) * pow(abs(x), 1. / 3.); }
vec3 lin2ok(vec3 c) {
  float l = cbrt(.4122214708 * c.r + .5363325363 * c.g + .0514459929 * c.b), m = cbrt(.2119034982 * c.r + .6806995451 * c.g + .1073969566 * c.b), s = cbrt(.0883024619 * c.r + .2817188376 * c.g + .6299787005 * c.b);
  return vec3(.2104542553 * l + .7936177850 * m - .0040720468 * s, 1.9779984951 * l - 2.4285922050 * m + .4505937099 * s, .0259040371 * l + .7827717662 * m - .8086757660 * s);
}
vec3 ok2lin(vec3 o) {
  float l = o.x + .3963377774 * o.y + .2158037573 * o.z, m = o.x - .1055613458 * o.y - .0638541728 * o.z, s = o.x - .0894841775 * o.y - 1.2914855480 * o.z;
  l = l * l * l; m = m * m * m; s = s * s * s;
  return vec3(4.0767416621 * l - 3.3077115913 * m + .2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - .3413193965 * s, -.0041960863 * l - .7034186147 * m + 1.7076147010 * s);
}
float luma(vec3 c) { return dot(c, vec3(.2126, .7152, .0722)); }
// symmetry: every pixel is folded into the fundamental region before anything is evaluated, so mirrored pixels are
// computed from the same coordinate. Every mirror line is snapped to a half step of the pixel grid being rendered
// (uSymG: its origin and step, in image pixels), so a reflection maps pixel centres onto pixel centres and mirrored
// pixels coincide exactly — at any size, also when the tile width is not a whole number of pixels.
uniform vec4 uSym, uSym2;                 // mode (1 ↔, 2 ↕, 3 both, 4 180°, 5 mirrored modules), centre (uv), modules x, y
uniform vec3 uSymG;
float snapG(float v, float o) { return o + floor((v - o) / uSymG.z * 2. + .5) * .5 * uSymG.z; }
vec2 symC(vec2 res) { vec2 c = uSym.yz * res; return vec2(snapG(c.x, uSymG.x), snapG(c.y, uSymG.y)); }
// mirrored modules along one axis: the tile edges are snapped, and a point in tile k is reflected about edges k … 1
float foldAxis(float P, float res, float n, float o, out float s, out float off) {
  s = 1.; off = 0.; int k = 0;
  for (int j = 1; j < 8; j++) { if (float(j) >= n) break; if (P >= snapG(float(j) * res / n, o)) k = j; }
  for (int j = 7; j >= 1; j--) { if (j > k) continue; float e = snapG(float(j) * res / n, o); P = 2. * e - P; s = -s; off = 2. * e - off; }
  return P;
}
vec2 foldPx(vec2 P, vec2 res, out vec4 tf) {     // P' = tf.xy * P + tf.zw
  tf = vec4(1., 1., 0., 0.);
  int m = int(uSym.x + .5);
  if (m == 0) return P;
  if (m == 5) {
    float sx, ox, sy, oy, X = foldAxis(P.x, res.x, uSym.w, uSymG.x, sx, ox), Y = foldAxis(P.y, res.y, uSym2.x, uSymG.y, sy, oy);
    tf = vec4(sx, sy, ox, oy);
    return vec2(X, Y);
  }
  vec2 c = symC(res);
  if (m == 4) { if (P.x > c.x) tf = vec4(-1., -1., 2. * c); return tf.xy * P + tf.zw; }
  if ((m == 1 || m == 3) && P.x > c.x) { tf.x = -1.; tf.z = 2. * c.x; }
  if ((m == 2 || m == 3) && P.y > c.y) { tf.y = -1.; tf.w = 2. * c.y; }
  return tf.xy * P + tf.zw;
}
vec2 unfoldPx(vec2 Q, vec4 tf) { return tf.xy * (Q - tf.zw); }
`;

/* ------------------------------------------------------------------ pass 1: the field */
const FIELD_FS = `#version 300 es
${COMMON}
layout(location = 0) out vec4 o0;
layout(location = 1) out vec4 o1;
uniform sampler2D uLay;
uniform int uN;
uniform vec2 uRes, uOrg; uniform float uScl;
uniform vec3 uRamp[10]; uniform float uRampP[10]; uniform int uRampN;
uniform vec3 uBC[6]; uniform int uBN;
uniform vec4 uB0, uB1, uB2, uB3;
uniform vec4 uW0, uW1, uW2, uW3, uW4;
uniform vec4 uIr, uIf0, uIf1; uniform vec4 uIfS[3];
uniform vec4 uMi, uMx;
uniform sampler2D uRect;                  // segment tree: 8 texels per node, 128 nodes per row
uniform vec4 uSegM;                       // segments on, defined, Seamless transition, Defined edge softening
uniform vec4 uSegM2;                      // Seamless transition floor (short-side units)
uniform vec4 uGT, uGT2, uGT3;             // basic gradient: type (0 fields, 1 linear, 2 radial, 3 diamond), angle, centre · radii, reverse, repeats · warp, step hardness

float ease(float x) { x = clamp(x, 0., 1.); return mix(x, x * x * (3. - 2. * x), .5); }
// perceptual mix: OKLab, with the endpoints' chroma carried along the hue path (saturated pairs never pass through grey)
vec3 mixc(vec3 a, vec3 b, float t) {
  if (uMx.y > .5) return lin2ok(mix(ok2lin(a), ok2lin(b), t));
  vec3 m = mix(a, b, t);
  if (uMx.x <= 0.) return m;
  float ca = length(a.yz), cb = length(b.yz);
  float w = smoothstep(.015, .06, min(ca, cb)) * uMx.x;
  if (w <= 0.) return m;
  float ha = atan(a.z, a.y), dh = atan(b.z, b.y) - ha; dh -= TAU * floor((dh + 3.14159265) / TAU);
  float h = ha + dh * t;
  return vec3(m.x, mix(m.yz, vec2(cos(h), sin(h)) * mix(ca, cb, t), w));
}
vec3 rampAt(float t) {
  t = clamp(t, 0., 1.); int k = 0;
  for (int i = 1; i < 10; i++) { if (i >= uRampN) break; if (t > uRampP[i - 1]) k = i; }
  if (k == 0) return uRamp[0];
  float a = uRampP[k - 1], b = uRampP[k];
  return mixc(uRamp[k - 1], uRamp[k], ease((t - a) / max(b - a, 1e-4)));
}
vec3 baseRampAt(float t) { float k = clamp(t, 0., 1.) * float(uBN - 1); int i = min(int(k), uBN - 2); return mixc(uBC[i], uBC[i + 1], ease(k - float(i))); }
vec3 col3(vec3 A, vec3 B, vec3 C, float n, float t) { if (n > 2.5) return t < .5 ? mixc(A, B, ease(t * 2.)) : mixc(B, C, ease(t * 2. - 1.)); return mixc(A, B, ease(t)); }
// chrome: bright sky, a hard dark horizon, a ground that climbs back — a reflective ramp without any 3D
float chrome(float t) {
  float x = fract(t * .999 + .02), h = .52;
  float sky = mix(.97, .42, pow(clamp(x / h, 0., 1.), .7)), gnd = mix(.06, .62, pow(clamp((x - h) / (1. - h), 0., 1.), .8));
  return mix(sky, gnd, smoothstep(h - .025, h + .025, x));
}
float fall(float d, float soft, float fe) { float x = clamp((1. + soft - d) / (2. * soft + 1e-3), 0., 1.); x = x * x * (3. - 2. * x); return pow(x, fe); }
float aaf(float fw) { return 1. - smoothstep(.22, .5, fw); }            // fades a wave before it can alias
float sdSeg(vec2 p, vec2 a, vec2 b) { vec2 pa = p - a, ba = b - a; float h = clamp(dot(pa, ba) / dot(ba, ba), 0., 1.); return length(pa - ba * h); }
float smin(float a, float b, float k) { float h = clamp(.5 + .5 * (b - a) / k, 0., 1.); return mix(b, a, h) - k * h * (1. - h); }
float sdBox(vec2 p, vec2 b, float r) { vec2 q = abs(p) - b + r; return length(max(q, 0.)) + min(max(q.x, q.y), 0.) - r; }

vec2 warp(vec2 p) {
  vec2 q = p; int oct = int(uW3.x + .5); float g = uW4.x;
  if (uW2.y > 0.) {                                        // directional: streams stretched along the flow
    vec2 u = vec2(cos(uW2.x), sin(uW2.x)), n = vec2(-u.y, u.x);
    float f = fbm(vec2(dot(q, u) * uW0.y * .35, dot(q, n) * uW0.y * 1.6) + uW3.zw, max(oct - 1, 1), g, 3u);
    q += n * f * uW2.y * 2.;
  }
  vec2 w = vec2(0.);
  if (uW0.x > 0.) {                                        // macro domain warp
    w = vec2(fbm(q * uW0.y + uW3.zw, oct, g, 11u), fbm(q * uW0.y + uW3.zw + vec2(5.2, 1.3), oct, g, 23u));
    q += w * uW0.x * 2.;
  }
  if (uW0.z > 0.) {                                        // meso: a second pass driven by the first
    vec2 w2 = vec2(fbm(q * uW0.w + w * 1.7 + uW4.zw, oct, g, 37u), fbm(q * uW0.w + w * 1.7 + uW4.zw + vec2(8.3, 2.8), oct, g, 41u));
    q += w2 * uW0.z * 2.;
    if (uW3.y > 2.5) { int o2 = max(oct - 1, 1); vec2 w3 = vec2(fbm(q * uW0.w * 1.9 + w2 * 2., o2, g, 53u), fbm(q * uW0.w * 1.9 + w2 * 2. + 4.1, o2, g, 59u)); q += w3 * uW0.z * 1.2; }
  }
  if (uW2.z > 0.) {                                        // curl-like: rotated gradient of a noise field (no compression)
    float e = .03; vec2 cq = q * uW0.y * .7 + uW3.zw * 1.3;
    float n0 = fbm(cq, 3, .5, 71u), nx = fbm(cq + vec2(e, 0.), 3, .5, 71u), ny = fbm(cq + vec2(0., e), 3, .5, 71u);
    q += vec2(ny - n0, -(nx - n0)) / e * uW2.z * .1;
  }
  if (uW1.x != 0.) { vec2 d = q - uW1.yz; float a = uW1.x * exp(-dot(d, d) / (uW1.w * uW1.w)); q = uW1.yz + rot2(d, a); }   // swirl
  if (uW2.w > 0.) { vec2 d = q - uW1.yz; float r = length(d) + 1e-4; float n = gnoise(d / r * 1.6 + vec2(r * 2.2) + uW3.zw, 91u); q += d / r * n * uW2.w; }   // radial
  return q;
}

float baseT(vec2 p, vec2 q) {
  vec2 b = mix(p, q, uB3.y); int ty = int(uB0.x + .5);
  vec2 c = uB0.zw, dir = vec2(cos(uB0.y), sin(uB0.y)); float t;
  if (ty == 0) t = dot(b - c, dir) / uB1.x * .5 + .5;
  else if (ty == 1) t = 1. - length(b - c) / uB1.x;
  else if (ty == 2) { float l1 = exp(-dot(b - c, b - c) / (uB1.x * uB1.x) * 1.3); vec2 dv = b - uB2.zw; float l2 = exp(-dot(dv, dv) / (uB1.x * uB1.x) * 1.8); t = .3 + .75 * l1 - .3 * l2 * uB2.y; }
  else if (ty == 3) t = .5 + .5 * tanh(dot(b - c, dir) / uB1.x * uB1.y * .5);
  else if (ty == 4) t = .15 + .8 * fbm(b * .9 + uB3.w, 3, .5, 61u) + .35 * exp(-dot(b - c, b - c) / (uB1.x * uB1.x));
  else if (ty == 5) { float a = atan(b.y - c.y, b.x - c.x) / TAU + .5 + uB0.y / TAU; t = abs(fract(a) * 2. - 1.); }
  else { float d = dot(b - c, dir); t = smoothstep(-.08 * uB1.y, .08 * uB1.y, d) * .8 + .1 + .1 * d; }
  t += uB3.z * fbm(b * 1.7 + uB3.w + 3., 3, .5, 67u);
  return mix(uB1.w, uB2.x, pow(clamp(t, 0., 1.), uB1.z));
}
vec3 baseField(vec2 p, vec2 q) { float t = baseT(p, q); return uB3.x > .5 ? rampAt(t) : baseRampAt(t); }

vec3 blendFn(int bm, vec3 b, vec3 s) {
  b = max(b, 0.); s = max(s, 0.);
  if (bm == 1) return b + s;
  if (bm == 2) return 1. - (1. - min(b, 1.)) * (1. - min(s, 1.)) + max(b - 1., 0.);
  if (bm == 3) return b * s;
  if (bm == 4 || bm == 5) {
    vec3 bs = pow(min(b, 1.), vec3(1. / 2.2)), ss = pow(min(s, 1.), vec3(1. / 2.2)), r;
    if (bm == 4) r = mix(2. * bs * ss, 1. - 2. * (1. - bs) * (1. - ss), step(.5, bs));
    else r = mix(bs - (1. - 2. * ss) * bs * (1. - bs), bs + (2. * ss - 1.) * (sqrt(bs) - bs), step(.5, ss));
    return pow(max(r, 0.), vec3(2.2));
  }
  if (bm == 6) { vec3 lb = lin2ok(b), ls = lin2ok(s); return ok2lin(vec3(lb.x, ls.yz)); }
  if (bm == 7) { float L = lin2ok(b).x; return b + s * pow(clamp(1. - L, 0., 1.), 1.5) * .8; }
  if (bm == 8) return abs(b - s);
  if (bm == 9) return max(b, s);
  return s;
}

vec4 LD(int i, int k) { return texelFetch(uLay, ivec2(k, i), 0); }

// the gradient composition at a point p (q: p after the domain warp; jn: field units per pixel after warping), in OKLab.
// E is the light it emits (for glow), A its coverage. Segments call it once per segment, through their own view.
vec3 composition(vec2 p, vec2 q, float jn, out vec3 E, out float A) {
  vec3 C = vec3(0.); A = 0.;
  E = vec3(0.); float rimSum = 0.;
  if (uMx.z < .5) { C = ok2lin(baseField(p, q)); A = 1.; }
  for (int i = 0; i < ${MAXL}; i++) {
    if (i >= uN) break;
    vec4 t0 = LD(i, 0), t1 = LD(i, 1), t2 = LD(i, 2), t3 = LD(i, 3), t4 = LD(i, 4), t5 = LD(i, 5), t6 = LD(i, 6), t7 = LD(i, 7), t8 = LD(i, 8), t9 = LD(i, 9), t10 = LD(i, 10), t11 = LD(i, 11);
    int ty = int(t0.x + .5), bm = int(t2.y + .5), rm = int(t3.w + .5);
    float soft = t1.z, fe = t1.w;
    vec2 ql = mix(p, q, t2.z);
    if (t2.w > 0.) ql += t2.w * vec2(gnoise(ql * t8.x + t8.y, 3u), gnoise(ql * t8.x + t8.y + 31.7, 4u));
    vec2 d = ql - t0.yz; float cr = cos(t0.w), sr = sin(t0.w);
    vec2 l = vec2(cr * d.x + sr * d.y, -sr * d.x + cr * d.y) / t1.xy;
    float aaK = jn / min(t1.x, t1.y);
    soft = max(soft, aaK * .8);                              // the sharpest edge is still antialiased
    vec4 P = t6; float r = length(l);
    float m = 0., t = 0., rim = 0., shade = 1.; vec3 mc = vec3(0.);
    if (ty == 0) { t = l.x * .5 + .5; m = P.x > .5 ? fall(abs(l.y), soft, fe) : 1.; }
    else if (ty == 1) {
      t = r; m = fall(r, soft, fe);
      if (P.x > 0.) { float n = fbm(l * P.y + t8.y, 3, .55, 13u); m *= clamp(1. + P.x * (n * 1.8 - .25), 0., 1.25); t = clamp(t + P.x * .35 * n, 0., 1.); }   // nebula: the pool breaks into clouds
    }
    else if (ty == 2) {
      vec2 c1 = rot2(vec2(P.x, 0.), P.y), c2 = rot2(c1 * P.z, 2.094), c3 = rot2(c1 * P.z, -2.094);
      float dd = smin(smin(length(l - c1), length(l - c2), .45), length(l - c3), .45) + .25; t = dd; m = fall(dd, soft, fe);
    }
    else if (ty == 3) { float a = atan(l.y, l.x) / TAU + .5 + P.y; t = P.x > .5 ? abs(fract(a) * 2. - 1.) : fract(a); m = fall(r / P.z, soft, fe); }
    else if (ty == 4 || ty == 10) {
      vec2 b = l; if (ty == 10) b.y += P.z * b.x * b.x;
      float n = gnoise(b * P.x + t8.y, 5u) + .5 * gnoise(b * P.x * 2.1 + t8.y + 7.3, 6u);
      float dd = length(b) * (1. + P.y * n);
      if (ty == 4) dd = smin(dd, length(b - vec2(P.z, P.w)) * 1.5, .5);
      t = clamp(dd, 0., 1.); m = fall(dd, soft, fe);
      rim = exp(-pow((dd - 1.) / (.06 + soft * .15), 2.));
      if (ty == 10) m *= mix(.35, 1., smoothstep(.2, 1., dd));
    }
    else if (ty == 5) {
      float yc = P.x * sin(l.x * P.y + P.z) + P.w * l.x * l.x, dy = l.y - yc, along = fall(abs(l.x) / 3., .6, 1.);
      t = clamp(dy * .5 + .5, 0., 1.); m = fall(abs(dy), soft, fe) * along; rim = exp(-pow((abs(dy) - 1.) / .12, 2.)) * along;
    }
    else if (ty == 6) { float w = pow(.5 + .5 * cos(TAU * (r * P.x - P.y)), P.z); t = mix(.5, w, aaf(P.x * aaK)); m = fall(r / P.w, soft, fe); }
    else if (ty == 7) {
      float u = l.x + P.y * l.y * l.y + P.z * sin(l.y * 2.3 + P.w), ph = u * P.x; ph += .35 * sin(ph * .37 + P.w);
      float w = smoothstep(.1, .9, abs(fract(ph * .5) * 2. - 1.));
      t = mix(.5, w, aaf(P.x * aaK * 1.4)); m = fall(r / 1.4, soft, fe);
    }
    else if (ty == 8) { float sd = sdBox(l, vec2(1.), P.y), ins = max(-sd, 0.), th = max(P.x, .02); m = sd > 0. ? 1. : fall(ins / th, soft, fe); t = clamp(1. - ins / th, 0., 1.); }
    else if (ty == 9) {
      float f = P.x, v = cos(TAU * length(l - vec2(-P.z, 0.)) * f) + cos(TAU * length(l - vec2(P.z, 0.)) * f), nn = 2.;
      if (P.w > 0.) { v += cos(TAU * length(l - vec2(0., P.w)) * f * 1.03); nn = 3.; }
      t = .5 + .5 * v / nn * aaf(f * aaK); m = fall(r / P.y, soft, fe);
    }
    else if (ty == 11) {                                    // mesh: four colour control points, RBF-blended in OKLab
      float sg = P.x * P.x;
      float w0 = exp(-dot(l - t9.xy, l - t9.xy) / sg), w1 = exp(-dot(l - t9.zw, l - t9.zw) / sg), w2 = exp(-dot(l - t10.xy, l - t10.xy) / sg), w3 = exp(-dot(l - t10.zw, l - t10.zw) / sg);
      float ws = w0 + w1 + w2 + w3 + 1e-5;
      mc = (t3.xyz * w0 + t4.xyz * w1 + t5.xyz * w2 + t11.xyz * w3) / ws;
      float cAvg = (length(t3.yz) * w0 + length(t4.yz) * w1 + length(t5.yz) * w2 + length(t11.yz) * w3) / ws, cl = length(mc.yz);
      if (cl > 1e-4) mc.yz *= mix(1., cAvg / cl, max(uMx.x, .5));
      m = fall(1. + sdBox(l, vec2(.75), .5), soft, fe);
    }
    else if (ty == 12) {
      float sd = sdBox(l, vec2(1.), 0.), w = max(soft, aaK);
      m = max(1. - smoothstep(-w, w, sd), exp(-max(sd, 0.) * P.x) * P.y); t = clamp(l.y * .5 + .5, 0., 1.);
    }
    else if (ty == 13) {
      float dd = smin(smin(sdSeg(l, t9.xy, t9.zw), sdSeg(l, t9.zw, t10.xy), .2), sdSeg(l, t10.xy, t10.zw), .2), u = dd / P.x;
      m = fall(u, soft, fe); rim = exp(-pow((u - 1.) / .15, 2.));
      t = P.z > 0. ? mix(.5, .5 + .5 * cos(TAU * dd * P.z), aaf(P.z * aaK)) : clamp(u, 0., 1.);
    }
    else if (ty == 14) {
      float rr = max(r, 1e-3), w = .5 + .5 * cos(TAU * (log(rr) * P.x + atan(l.y, l.x) / TAU * P.y - P.z));
      t = mix(.5, w, aaf((P.x + abs(P.y) / TAU) / rr * aaK)); m = fall(r / 1.6, soft, fe); shade = mix(.25, 1., smoothstep(0., .9, r));
    }
    else if (ty == 15) {
      float a = atan(l.y, l.x), n = gnoise(vec2(cos(a), sin(a)) * 1.7 + t8.y, 9u);
      float ry = pow(.5 + .5 * cos(a * P.x + P.z * n * 3.), P.y); ry = mix(.35, ry, aaf(P.x / max(r, 1e-3) * aaK));
      m = fall(r, soft, fe) * mix(.25, 1., ry); t = clamp(r * (1. - .35 * ry), 0., 1.);
    }
    else { float a = atan(l.y, l.x); m = fall(abs(a) / P.x, soft, fe) * fall(r / P.y, soft, fe); t = clamp(r / P.y, 0., 1.); }

    // colour along the field parameter
    float stepN = floor(t11.w / 10.), metal = t11.w - stepN * 10.;
    t = clamp(t + t5.w, 0., 1.);
    if (t7.y > 1.01) t = abs(fract(t * t7.y * .5) * 2. - 1.);
    t = pow(max(t, 0.), t7.x);
    if (t8.w > .5) t = 1. - t;
    vec3 lc;
    if (ty == 11) lc = mc;
    else {
      float tt = t, mt = uIr.z * metal;
      if (rm == 1) tt = chrome(tt); else if (mt > 0.) tt = mix(tt, chrome(tt), mt);
      if (rm == 3) { float n = max(stepN, 2.), f = tt * n; tt = (floor(f) + smoothstep(.9, 1., fract(f))) / n; }
      lc = rm == 4 ? rampAt(mix(t3.x, t3.y, tt)) : col3(t3.xyz, t4.xyz, t5.xyz, t4.w, tt);
      if (rm == 2) lc.yz = rot2(lc.yz, (t - .5) * 3.2 * (1. - uMx.w)) * 1.12;   // a spectral hue sweep, unless the palette is strict
    }
    lc.x *= shade;
    if (t7.z > 0.) { float k = clamp(rim * t7.z, 0., 1.); lc = mixc(lc, t11.xyz, k); m = max(m, k * .85); rimSum += k * m; }
    float a = clamp(m * t2.x, 0., 1.);
    if (t8.z != 0.) { float Lb = lin2ok(max(C, 0.)).x; a *= t8.z > 0. ? mix(1., smoothstep(.15, .75, Lb), t8.z) : mix(1., 1. - smoothstep(.1, .6, Lb), -t8.z); }
    if (a > .0005) {
      vec3 Lc = ok2lin(lc);
      float An = a + A * (1. - a), w = a / max(An, 1e-5);
      if (bm == 0) C = ok2lin(mixc(lin2ok(C), lc, w));
      else C = mix(C, mix(Lc, blendFn(bm, C, Lc), A), w);
      A = An;
      E = E * (1. - (bm == 0 ? a : 0.)) + max(Lc, 0.) * a * t7.w;
    }
  }
  vec3 lab = lin2ok(C);
  if (uIr.x > 0.) {                                          // iridescence: hue rotation driven by a thickness-like field
    float th = lab.x * 1.6 + .55 * fbm(q * 2.2 + uIr.w, 3, .5, 81u) + rimSum * .4, ph = th * uIr.y;
    float s1 = sin(TAU * ph), c1 = cos(TAU * ph), amt = uIr.x, C0 = length(lab.yz);
    vec2 ab = rot2(lab.yz, amt * 1.4 * s1) * (1. + amt * .35 * (.5 + .5 * c1));
    ab += amt * .045 * vec2(cos(TAU * ph * 1.31 + 1.), sin(TAU * ph * 1.31 + 1.)) * (1. - .5 * smoothstep(.05, .15, C0));
    lab = vec3(lab.x + amt * .035 * c1, ab);
  }
  if (uIf0.x > 0.) {                                         // interference: point sources that beat against each other
    float v = 0., fw = 0.;
    for (int k = 0; k < 3; k++) { float f = uIf0.y * uIfS[k].z; v += cos(TAU * (length(q - uIfS[k].xy) * f + uIfS[k].w)); fw = max(fw, f * jn); }
    vec2 dq = q - uIf1.xy;
    v *= aaf(fw) * uIf0.x / 3. * mix(1., exp(-dot(dq, dq) / (uIf1.z * uIf1.z)), uIf1.w);
    lab.x *= 1. + .22 * v; lab.yz = rot2(lab.yz, .6 * v * (1. - uMx.w)) * (1. + .25 * abs(v));
  }
  if (uMi.x > 0.) {                                          // micro: colour breakup and fine filaments, in patches rather than everywhere
    float hf = 34., aa = aaf(hf * jn * .5);
    float zone = smoothstep(.05, .55, fbm(q * 1.3 + uMi.z * .37, 2, .5, 95u) + .1);
    float k = uMi.x * (1. - .7 * uMi.y) * aa * zone;
    float n1 = fbm(q * hf + uMi.z, 2, .5, 97u), rid = pow(1. - abs(gnoise(q * hf * .35 + n1 * .6 + uMi.z, 99u)), 8.);
    lab.x += k * (.02 * n1 + .035 * rid * smoothstep(.02, .2, lab.x));
    lab.yz = rot2(lab.yz, k * .45 * n1 * (1. - uMx.w)) * (1. + k * .25 * rid);
  }
  return lab;
}

// segments divide the frame; inside each one either the field composition is rendered through the segment's own view
// (centre, span, turn and mirror), or a basic gradient of its own (typedT). Each cut divides its parent's weight between its two sides
// with a smootherstep whose halves sum to one, so the weights of all segments add up to exactly 1 at every pixel: the
// segments alone make the image. Only branches that carry weight are visited.
vec4 SN(int n, int k) { return texelFetch(uRect, ivec2((n & 127) * 8 + k, n >> 7), 0); }
float pou(float x) { x = clamp(.5 + .5 * x, 0., 1.); return x * x * x * (x * (x * 6. - 15.) + 10.); }
// the basic gradient types: t along a direction (linear), elliptical distance (radial) or Manhattan distance (diamond)
// from a centre, in the frame turned by ang; rr are the radii that put t = 1 at the farthest corner of the region
float typedT(float ty, vec2 p, vec2 c, float ang, vec2 rr) {
  vec2 d = rot2(p - c, -ang);
  if (ty < 1.5) return .5 + .5 * d.x / rr.x;
  d /= rr;
  return ty < 2.5 ? length(d) : abs(d.x) + abs(d.y);
}
// the palette along t: reversed if asked, repeated as a mirror for Structure, steps hardened toward bands for low Softness
vec3 typedColor(float t, float rev) {
  t = clamp(t, 0., 1.); if (rev > .5) t = 1. - t;
  float u = t * uGT2.w; t = 1. - abs(1. - mod(u, 2.));
  int k = 0;
  for (int i = 1; i < 10; i++) { if (i >= uRampN) break; if (t > uRampP[i - 1]) k = i; }
  if (k == 0) return uRamp[0];
  float a = uRampP[k - 1], b = uRampP[k], f = clamp(((t - a) / max(b - a, 1e-4) - .5) * uGT3.y + .5, 0., 1.);
  return mixc(uRamp[k - 1], uRamp[k], ease(f));
}
vec3 typedEmit(vec3 lab) { return max(ok2lin(lab), 0.) * smoothstep(.72, .95, lab.x) * .8; }   // the brightest colours feed the glow
// the segments that carry weight at p, with their weights (at most 16; any further weight is dropped and the rest renormalised)
int segLeaves(vec2 p, float px, out int ln[16], out float lw[16]) {
  int sn[48]; float sw[48]; sn[0] = 0; sw[0] = 1.; int top = 1, nl = 0;   // pending branches: at most one per tree level
  for (int it = 0; it < 160; it++) {
    if (top == 0 || nl == 16) break;
    top--; int n = sn[top]; float w = sw[top];
    vec4 h = SN(n, 1);
    if (h.x < -.5) { ln[nl] = n; lw[nl] = w; nl++; continue; }
    int ax = int(h.x + .5), f = int(h.w + .5);
    // transition half-width. Seamless: a share of the narrowest segment at this cut, never under a floor (or under 45 %
    // of a thinner segment). Defined: about one pixel, softened by Softness.
    float tw = uSegM.y > .5 ? max(uSegM.w * h.z, px * .75) : max(max(uSegM.z * h.z, min(uSegM2.x, .45 * h.z)), px * .75);
    float s = pou((p[ax] - h.y) / tw);
    if (w * (1. - s) > 1e-5 && top < 48) { sn[top] = f; sw[top] = w * (1. - s); top++; }
    if (w * s > 1e-5 && top < 48) { sn[top] = f + 1; sw[top] = w * s; top++; }
  }
  return nl;
}

// every expensive function (warp, composition, typedColor) has a single call site: the Windows shader compiler inlines
// each call, and several copies of the composition made it take minutes
void main() {
  vec2 img = uOrg + gl_FragCoord.xy * uScl;                 // image px; row 0 of every target is the top of its region
  float S = min(uRes.x, uRes.y); vec4 tf;
  img = foldPx(img, uRes, tf);
  vec2 p = (img - .5 * uRes) / S;
  float px = uScl / S;
  // the warp at p, and with symmetry also one pixel to the right and below: the anti-aliasing width is then measured by
  // explicit differences on the folded coordinate. The GPU's derivatives pair pixels in 2×2 blocks, and a mirrored pixel
  // sits in the other half of its block, which would antialias it a little differently from its partner.
  vec2 wq[3];
  for (int k = 0; k < 3; k++) { if (k > 0 && uSym.x < .5) break; wq[k] = warp(p + (k == 1 ? vec2(px, 0.) : k == 2 ? vec2(0., px) : vec2(0.))); }
  vec2 q = wq[0];
  float jn = uSym.x > .5 ? max(max(length(wq[1] - q), length(wq[2] - q)), px) : max(max(length(dFdx(q)), length(dFdy(q))), px);
  // the regions at p: the whole frame (-1), or the segments that carry weight here
  int ln[16]; float lw[16]; int nl = 1; ln[0] = -1; lw[0] = 1.;
  if (uSegM.x > .5) nl = segLeaves(p, px, ln, lw);
  vec3 acc = vec3(0.), E = vec3(0.); float A = 0., ws = 0.;
  for (int i = 0; i < nl; i++) {                             // a dynamic bound: the compiler cannot unroll 16 copies of the composition
    int n = ln[i]; float w = lw[i];
    // the region's content: a basic gradient (type, angle, centre, radii, reverse), or the field composition seen
    // through the region's view (centre, span, turn and mirror; the whole frame is its own view)
    float ty = uGT.x, ang = uGT.y, rev = uGT2.z; vec2 gc = uGT.zw, rr = uGT2.xy, pv = p; float kj = jn; bool view = false;
    if (n >= 0) {
      vec4 r = SN(n, 0), v = SN(n, 2), c = SN(n, 3), g = SN(n, 4), g2 = SN(n, 5);
      ty = g.x; ang = g.y; gc = g.zw; rr = g2.xy; rev = g2.z;
      vec2 sz = r.zw - r.xy; float k = v.z / max(sz.x, sz.y);
      vec2 d = (p - .5 * (r.xy + r.zw)) * k; d.x *= c.x;
      pv = v.xy + rot2(d, v.w); kj = jn * k; view = true;
    }
    vec3 lab, e; float a;
    if (ty > .5) { lab = typedColor(typedT(ty, mix(p, q, uGT3.x), gc, ang, rr), rev); e = typedEmit(lab); a = 1.; }
    else lab = composition(pv, view ? warp(pv) : q, kj, e, a);
    acc += w * lab; E += w * e; A += w * a; ws += w;
  }
  float iw = 1. / max(ws, 1e-6);
  o0 = vec4(enc(ok2lin(acc * iw)), A * iw);
  o1 = vec4(enc(E * iw), 1.);
}`;

/* ------------------------------------------------------------------ pass 2: low-resolution glow, bloom and local contrast */
const BLUR_FS = `#version 300 es
${COMMON}
uniform sampler2D uSrc; uniform vec2 uStep; uniform float uSig; uniform int uTaps, uMode; uniform vec2 uThr;
out vec4 o;
// exact linear tap along the blur axis: weights depend only on the offset, so a tile and a one-piece render agree
vec4 tap(vec2 pos) {
  ivec2 sz = textureSize(uSrc, 0) - 1; vec2 f = pos - .5, i = floor(f), w = f - i; ivec2 a = ivec2(i);
  vec4 c00 = texelFetch(uSrc, clamp(a, ivec2(0), sz), 0), c10 = texelFetch(uSrc, clamp(a + ivec2(1, 0), ivec2(0), sz), 0);
  vec4 c01 = texelFetch(uSrc, clamp(a + ivec2(0, 1), ivec2(0), sz), 0), c11 = texelFetch(uSrc, clamp(a + ivec2(1, 1), ivec2(0), sz), 0);
  return mix(mix(c00, c10, w.x), mix(c01, c11, w.x), w.y);
}
void main() {
  if (uMode == 1) { vec3 c = dec(texelFetch(uSrc, ivec2(gl_FragCoord.xy), 0).rgb); float l = luma(max(c, 0.)); o = vec4(enc(max(c, 0.) * smoothstep(uThr.x - uThr.y, uThr.x + uThr.y, l)), 1.); return; }
  if (uMode == 2) {                    // box prefilter into a smaller copy (uStep: source texels per target texel)
    vec2 r = uStep, c0 = (gl_FragCoord.xy - .5) * r; int n = int(clamp(ceil(max(r.x, r.y)), 1., 8.)); vec4 s = vec4(0.);
    for (int j = 0; j < 8; j++) for (int i = 0; i < 8; i++) { if (i >= n || j >= n) continue; vec4 t = tap(c0 + (vec2(i, j) + .5) / float(n) * r); s += vec4(dec(t.rgb), t.a); }
    s /= float(n * n); o = vec4(enc(s.rgb), s.a); return;
  }
  vec4 s = vec4(0.); float ws = 0.;
  for (int i = -64; i <= 64; i++) {
    if (i < -uTaps || i > uTaps) continue;
    float x = float(i) / float(uTaps) * 3.;
    float w = exp(-.5 * x * x);
    vec4 t = tap(gl_FragCoord.xy + uStep * x * uSig);
    s += vec4(dec(t.rgb), t.a) * w; ws += w;
  }
  o = vec4(enc(s.rgb / ws), s.a / ws);
}`;

/* ------------------------------------------------------------------ pass 3: post */
const POST_FS = `#version 300 es
${COMMON}
uniform sampler2D uFld, uGlA, uGlB, uBlm, uLcT, uBlr;
uniform vec2 uRes, uOrg, uFOrg, uFSize, uLowK; uniform float uScl, uFlip, uTH, uBlrW;
uniform vec4 uCA, uGlw, uTn, uTn2, uLC, uCC, uGr, uTx, uQz, uBn; uniform vec3 uDeep;
out vec4 o;
// exact bilinear read of the field: weights depend only on the position relative to the field origin,
// so a tile and a one-piece render sample identically (hardware filtering quantizes its weights)
vec4 fld(vec2 P) {
  vec2 f = (P - uFOrg) / uScl - .5, i = floor(f), w = f - i;
  ivec2 c = ivec2(i), mx = ivec2(uFSize) - 1;
  vec4 a = texelFetch(uFld, clamp(c, ivec2(0), mx), 0), b = texelFetch(uFld, clamp(c + ivec2(1, 0), ivec2(0), mx), 0);
  vec4 d = texelFetch(uFld, clamp(c + ivec2(0, 1), ivec2(0), mx), 0), e = texelFetch(uFld, clamp(c + ivec2(1, 1), ivec2(0), mx), 0);
  vec4 r = mix(mix(a, b, w.x), mix(d, e, w.x), w.y);
  return vec4(dec(r.rgb), r.a);
}
vec4 cubicW(float v) { vec4 n = vec4(1., 2., 3., 4.) - v, s = n * n * n; float x = s.x, y = s.y - 4. * s.x, z = s.z - 4. * s.y + 6. * s.x; return vec4(x, y, z, 6. - x - y - z) * (1. / 6.); }
vec4 cubic(sampler2D t, vec2 uv) {                        // B-spline upsampling: no bilinear creases in smooth glows and blurs
  vec2 res = vec2(textureSize(t, 0)); uv = uv * res - .5; vec2 f = fract(uv); uv -= f;
  vec4 xc = cubicW(f.x), yc = cubicW(f.y), c = uv.xxyy + vec2(-.5, 1.5).xyxy, s = vec4(xc.xz + xc.yw, yc.xz + yc.yw);
  vec4 off = (c + vec4(xc.yw, yc.yw) / s) / res.xxyy;
  vec4 s0 = texture(t, off.xz), s1 = texture(t, off.yz), s2 = texture(t, off.xw), s3 = texture(t, off.yw);
  float sx = s.x / (s.x + s.y), sy = s.z / (s.z + s.w);
  vec4 r = mix(mix(s3, s2, sx), mix(s1, s0, sx), sy);
  return vec4(dec(r.rgb), r.a);
}
// the field as the rest of the pipeline sees it: sharp (or blurred at full resolution, per tile) mixed with the
// large-radius blur from the whole-image pyramid, which is read at the folded coordinate so it stays exactly symmetric
vec4 fieldAt(vec2 X) {
  vec4 c = fld(X);
  if (uBlrW > 0.) { vec4 tf; c = mix(c, cubic(uBlr, foldPx(X, uRes, tf) * uLowK), uBlrW); }
  return c;
}
vec3 glowAt(vec2 X) { vec4 tf; vec2 lu = foldPx(X, uRes, tf) * uLowK; return mix(cubic(uGlA, lu).rgb, cubic(uGlB, lu).rgb, uGlw.w) * uGlw.x + cubic(uBlm, lu).rgb * uGlw.y; }
bool inG(vec3 c) { return all(greaterThanEqual(c, vec3(-1e-4))) && all(lessThanEqual(c, vec3(1.0001))); }
vec3 gmap(vec3 lab) {                                       // keep lightness and hue; reduce chroma until displayable
  vec3 lin = ok2lin(lab); if (inG(lin)) return lin;
  float lo = 0., hi = 1.;
  for (int i = 0; i < 10; i++) { float m = .5 * (lo + hi); if (inG(ok2lin(vec3(lab.x, lab.yz * m)))) lo = m; else hi = m; }
  return clamp(ok2lin(vec3(lab.x, lab.yz * lo)), 0., 1.);
}
float bayer8(ivec2 p) { int x = p.x & 7, y = p.y & 7, c = x ^ y; return float(((c & 1) << 5) | ((y & 1) << 4) | ((c & 2) << 2) | ((y & 2) << 1) | ((c & 4) >> 1) | ((y & 4) >> 2)) / 64.; }
float bayer4(ivec2 p) { int x = p.x & 3, y = p.y & 3, c = x ^ y; return float(((c & 1) << 3) | ((y & 1) << 2) | (c & 2) | ((y & 2) >> 1)) / 16.; }
float pattern(ivec2 c, int k) {
  if (k == 0) return bayer8(c) + 1. / 128.;
  if (k == 1) return bayer4(c) + 1. / 32.;
  if (k == 2) return fract(52.9829189 * fract(.06711056 * float(c.x) + .00583715 * float(c.y)));
  if (k == 3) return fract(float(c.x + c.y) * .25 + .125);
  return h01(c, 17u);
}
float vnoise(vec2 p, uint s) { vec2 fl = floor(p); ivec2 i = ivec2(fl); vec2 f = p - fl; f = f * f * (3. - 2. * f);
  return mix(mix(h01(i, s), h01(i + ivec2(1, 0), s), f.x), mix(h01(i + ivec2(0, 1), s), h01(i + ivec2(1, 1), s), f.x), f.y) * 2. - 1.; }
void main() {
  vec2 tp = vec2(gl_FragCoord.x, uFlip > .5 ? uTH - gl_FragCoord.y : gl_FragCoord.y);
  vec2 P = uOrg + tp * uScl, Ps = P;
  float S = min(uRes.x, uRes.y); vec4 tf;
  vec2 Pf = foldPx(P, uRes, tf);                       // every procedural term below uses the folded coordinate
  int sm = int(uSym.x + .5);
  // digital artifacts: displaced scanline bands (displaced in the fundamental region, then mapped back)
  if (uBn.y > 0.) {
    float row = floor(Pf.y / (S / 180.));
    ivec2 rc = ivec2(int(row), int(uBn.w));
    if (h01(rc, 77u) < uBn.y * .35) Ps = unfoldPx(Pf + vec2((h01(rc, 91u) - .5) * uBn.y * S * .02, 0.), tf);
  }
  vec4 c0 = fieldAt(Ps); vec3 col = c0.rgb; float al = c0.a;
  vec3 g = glowAt(P);
  if (uCA.x > 0.) {                                          // chromatic displacement, radial about the symmetry centre
    vec2 cc = .5 * uRes;
    if (sm >= 1 && sm <= 4) cc = symC(uRes);
    else if (sm == 5) cc = unfoldPx(.5 * vec2(snapG(uRes.x / uSym.w, uSymG.x), snapG(uRes.y / uSym2.x, uSymG.y)), tf);   // each tile's own centre: the mirror of the first tile's
    vec2 dir = uCA.y < .5 ? (P - cc) / (.5 * max(uRes.x, uRes.y)) : vec2(cos(uCA.z), sin(uCA.z));
    vec2 off = dir * uCA.x * S;
    vec4 rr = fieldAt(Ps + off), bb = fieldAt(Ps - off);
    col = vec3(rr.r, col.g, bb.b); al = max(al, max(rr.a, bb.a));
    if (uCA.w > .5) { vec3 gr = glowAt(P + off), gb = glowAt(P - off); g = vec3(gr.r, g.g, gb.b); }
  }
  if (uBn.y > 0.) {                                          // blocky chroma, like an early codec
    vec2 bs = vec2(S * uBn.z), bc = unfoldPx((floor(Pf / bs) + .5) * bs, tf);
    vec3 la = lin2ok(col), lb = lin2ok(fieldAt(bc).rgb);
    la.yz = mix(la.yz, lb.yz, clamp(uBn.y * 1.2, 0., 1.)); col = ok2lin(la);
  }
  col += g;
  if (uTn2.z > .5) al = clamp(al + luma(max(g, 0.)) * 1.5, 0., 1.);
  vec3 lab = lin2ok(col);
  if (uGlw.z != 0.) lab.x += uGlw.z * (lab.x - lin2ok(cubic(uLcT, Pf * uLowK).rgb).x);
  // tone
  float L = max(lab.x, 0.);
  float ws = 1. - smoothstep(0., .55, L), wh = smoothstep(.45, 1., L), wm = max(0., 1. - ws - wh);
  L *= 1. - uTn.y * .45 * ws;
  float gk = exp(uTn.x * .9), Lc = min(L, 1.);
  L = (Lc < .5 ? .5 * pow(2. * Lc, gk) : 1. - .5 * pow(2. * (1. - Lc), gk)) + max(L - 1., 0.);
  L += uTn.z * .16 * wh + .2 * (uLC.x * ws + uLC.y * wm + uLC.z * wh);
  float knee = uTn2.y; if (L > knee) L = knee + (1. - knee) * (1. - exp(-(L - knee) / (1. - knee)));
  L = clamp(L, 0., .99);
  float cm = uTn.w * (1. + .9 * (uCC.x * ws + uCC.y * wm + uCC.z * wh));
  lab.yz *= mix(1., max(cm, 0.), .55 + .45 * wm) * uTn2.w;   // uTn2.w: the bottom of Color fades the rest to true grey
  float dc = length(uDeep.yz); vec2 dt = dc > 1e-4 ? uDeep.yz / dc * max(dc, .03) : vec2(0.);
  lab.yz = mix(lab.yz, dt * (.6 + .8 * length(lab.yz) / max(dc, .03)), uTn2.x * ws * .7);
  if (uBn.x > 0.) { float n = mix(40., 7., uBn.x), f = L * n, wb = mix(.5, .06, uBn.x); L = mix(L, (floor(f) + smoothstep(.5 - wb, .5 + wb, fract(f))) / n, min(1., uBn.x * 1.5)); }
  if (uTx.x > 0.) {                                          // paper: a fine tooth and a broad, gentle unevenness of tone
    vec2 tq = Pf / S; float fw = uTx.y * uScl / S;           // fixed to the image like the grain; fades before it would alias
    float tooth = fbm(tq * uTx.y + uTx.w, 3, .5, 7u) * (1. - smoothstep(.3, .6, fw));
    float broad = fbm(tq * 2.7 + uTx.w * .3, 2, .5, 5u);
    L *= 1. + uTx.x * (.05 * tooth + .03 * broad);
  }
  lab.x = L;
  vec3 srgb = gmap(lab);
  srgb = mix(12.92 * srgb, 1.055 * pow(srgb, vec3(1. / 2.4)) - .055, step(.0031308, srgb));
  // film grain: band-limited gradient noise in three octaves, each turned against the lattice so no grid shows, at a size
  // relative to the image — it belongs to the print, not to the pixel, so preview and export agree. Neutral in tone with
  // only a trace of colour, strongest in the midtones like film. A grain smaller than the pixel being drawn is softened
  // the way averaging over that pixel would soften it.
  float cell = uGr.y * S, gw = .25 + .75 * clamp(4. * L * (1. - L), 0., 1.);
  float ga = uGr.x * .055 * gw * clamp(sqrt(cell / uScl), .45, 1.);
  vec3 gn = vec3(0.);
  if (uGr.x > 0.) {
    vec2 gq = Pf / cell;
    float n = .7 * gnoise(gq, 21u) + .45 * gnoise(rot2(gq, 1.1) * 1.93 + 5.3, 22u) + .3 * gnoise(rot2(gq, 2.4) * 3.71 + 17.9, 25u);
    vec2 cn = vec2(gnoise(rot2(gq, .6) * .55 + 11.7, 23u), gnoise(rot2(gq, 1.9) * .55 + 3.1, 24u)) * uGr.z * .35;
    gn = (vec3(n) + vec3(cn.x, -.5 * (cn.x + cn.y), cn.y)) * ga;
  }
  if (uGr.w < .5) srgb += gn;
  // posterization and ordered dither
  float lv = uQz.x > 0. ? uQz.x : 256.;
  if (uQz.y > 0.) lv = min(lv, mix(96., 8., pow(uQz.y, .7)));
  if (lv < 255.) {
    float thr = 0.;
    if (uQz.y > 0.) thr = (pattern(ivec2(floor(Pf / max(uQz.z * S, uScl))), int(uQz.w)) - .5) * min(1., uQz.y * 3.);
    srgb = floor(clamp(srgb, 0., 1.) * (lv - 1.) + .5 + thr) / (lv - 1.);
  }
  if (uGr.w > .5) srgb += gn;
  ivec2 ip = ivec2(floor(Pf));
  srgb += (h01(ip, 3u) + h01(ip, 5u) - 1.) / 255.;          // final TPDF dither: no 8-bit banding in smooth gradients
  o = vec4(clamp(srgb, 0., 1.), uTn2.z > .5 ? clamp(al, 0., 1.) : 1.);
}`;

function create(canvas, onLost) {
  const gl = canvas.getContext('webgl2', { antialias: false, premultipliedAlpha: false, preserveDrawingBuffer: true, alpha: true, depth: false, stencil: false, powerPreference: 'high-performance' });
  if (!gl) throw new Error('WebGL2 is not available in this browser');
  const floatRT = !!gl.getExtension('EXT_color_buffer_float');
  const FMT = floatRT ? { i: gl.RGBA16F, f: gl.RGBA, t: gl.HALF_FLOAT } : { i: gl.RGBA8, f: gl.RGBA, t: gl.UNSIGNED_BYTE };
  const ENC = floatRT ? 0 : 1;
  canvas.addEventListener('webglcontextlost', e => { e.preventDefault(); onLost && onLost(); });

  // the programs compile in the background where the browser allows it (KHR_parallel_shader_compile), so the page stays
  // responsive: the first compile of the field shader can take many seconds on Windows, after which the browser caches
  // it. `ready` resolves once all three have linked; nothing is drawn before that.
  const par = gl.getExtension('KHR_parallel_shader_compile');
  const sh = (t, s) => { const o = gl.createShader(t); gl.shaderSource(o, s); gl.compileShader(o); return o; };
  const vs = sh(gl.VERTEX_SHADER, VS);
  function start(fs) {
    const p = gl.createProgram(), f = sh(gl.FRAGMENT_SHADER, fs);
    gl.attachShader(p, vs); gl.attachShader(p, f); gl.bindAttribLocation(p, 0, 'aPos'); gl.linkProgram(p);
    return { p, f, u: {} };
  }
  function finish(P) {
    if (!gl.getProgramParameter(P.p, gl.LINK_STATUS)) throw new Error(gl.getShaderInfoLog(P.f) || gl.getShaderInfoLog(vs) || gl.getProgramInfoLog(P.p));
    const n = gl.getProgramParameter(P.p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) { const a = gl.getActiveUniform(P.p, i); P.u[a.name.replace(/\[0\]$/, '')] = { loc: gl.getUniformLocation(P.p, a.name), type: a.type }; }
  }
  const PF = start(FIELD_FS), PB = start(BLUR_FS), PP = start(POST_FS);
  let isReady = false;
  const ready = new Promise((resolve, reject) => {
    const poll = () => {
      if (par && ![PF, PB, PP].every(P => gl.getProgramParameter(P.p, par.COMPLETION_STATUS_KHR))) { setTimeout(poll, 40); return; }
      try { [PF, PB, PP].forEach(finish); isReady = true; resolve(); } catch (e) { reject(e); }
    };
    poll();
  });
  function set(P, name, v) {
    const u = P.u[name]; if (!u) return;
    const a = typeof v === 'number' ? [v] : v;
    switch (u.type) {
      case gl.FLOAT: gl.uniform1fv(u.loc, a); break;
      case gl.FLOAT_VEC2: gl.uniform2fv(u.loc, a); break;
      case gl.FLOAT_VEC3: gl.uniform3fv(u.loc, a); break;
      case gl.FLOAT_VEC4: gl.uniform4fv(u.loc, a); break;
      default: gl.uniform1i(u.loc, a[0] | 0);
    }
  }
  const setAll = (P, obj) => { for (const k in obj) set(P, k, obj[k]); };

  const vao = gl.createVertexArray(); gl.bindVertexArray(vao);
  const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.disable(gl.BLEND); gl.disable(gl.DEPTH_TEST);

  const dataTex = (unit, w, h, data) => {
    const t = gl.createTexture(); gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, w, h, 0, gl.RGBA, gl.FLOAT, data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.activeTexture(gl.TEXTURE0);
    return t;
  };
  // layer table and rectangle tree: small float textures
  const ltex = dataTex(0, LT, MAXL, null), rtex = dataTex(9, 8, 1, new Float32Array(32));
  const blank = dataTex(10, 1, 1, new Float32Array(4));
  let layersOnGPU = null, rectsOnGPU = null;

  function texture(w, h, fmt) {
    const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, fmt.i, w, h, 0, fmt.f, fmt.t, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }
  function target(w, h, n = 1, fmt = FMT) {
    gl.activeTexture(gl.TEXTURE7);
    const fb = gl.createFramebuffer(), tex = [];
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    for (let k = 0; k < n; k++) { const t = texture(w, h, fmt); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + k, gl.TEXTURE_2D, t, 0); tex.push(t); }
    gl.drawBuffers(tex.map((_, k) => gl.COLOR_ATTACHMENT0 + k));
    const st = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.bindTexture(gl.TEXTURE_2D, null); gl.activeTexture(gl.TEXTURE0);
    if (st !== gl.FRAMEBUFFER_COMPLETE) { free({ fb, tex }); throw new Error(`could not allocate a ${w} × ${h} render target`); }
    return { fb, tex, w, h };
  }
  function free(T) { if (!T) return; gl.deleteFramebuffer(T.fb); T.tex.forEach(t => gl.deleteTexture(t)); }

  function upload(scene) {
    if (layersOnGPU !== scene.layers) {
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, ltex);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, LT, MAXL, gl.RGBA, gl.FLOAT, scene.layers);
      layersOnGPU = scene.layers;
    }
    if (scene.rects && rectsOnGPU !== scene.rects) {
      gl.activeTexture(gl.TEXTURE9); gl.bindTexture(gl.TEXTURE_2D, rtex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, 128 * 8, scene.rectRows, 0, gl.RGBA, gl.FLOAT, scene.rects);
      rectsOnGPU = scene.rects;
    }
  }
  function drawField(scene, T, org, scl, W, H, vw, vh) {
    gl.useProgram(PF.p); upload(scene);
    gl.activeTexture(gl.TEXTURE9); gl.bindTexture(gl.TEXTURE_2D, rtex);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, ltex);
    set(PF, 'uLay', 0); set(PF, 'uRect', 9); setAll(PF, scene.field);
    set(PF, 'uRes', [W, H]); set(PF, 'uOrg', org); set(PF, 'uScl', scl); set(PF, 'uEnc', ENC); set(PF, 'uSymG', [org[0], org[1], scl]);
    gl.bindFramebuffer(gl.FRAMEBUFFER, T.fb); gl.viewport(0, 0, vw, vh);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
  function blur(src, dst, mode, dir, sig, thr) {
    gl.useProgram(PB.p);
    gl.activeTexture(gl.TEXTURE6); gl.bindTexture(gl.TEXTURE_2D, src); set(PB, 'uSrc', 6);
    set(PB, 'uMode', mode); set(PB, 'uStep', dir); set(PB, 'uSig', Math.max(sig, .01)); set(PB, 'uTaps', Math.max(4, Math.min(64, Math.ceil(sig * 1.5))));
    set(PB, 'uThr', thr || [0, 0]); set(PB, 'uEnc', ENC);
    gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fb); gl.viewport(0, 0, dst.w, dst.h);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.activeTexture(gl.TEXTURE6); gl.bindTexture(gl.TEXTURE_2D, null);
  }
  // pass 2: the low-resolution whole-image textures (glow, bloom, local contrast and the large-radius global blur)
  let low = null, lowKey = '';
  function ensureLow(scene, W, H, res) {
    const scl = Math.max(W, H) / res, lw = Math.max(8, Math.ceil(W / scl)), lh = Math.max(8, Math.ceil(H / scl));
    const key = scene.fieldKey + '|' + scene.lowKey + '|' + scene.blurSig + '|' + [W, H, lw, lh].join(',');
    if (key === lowKey && low) return low;
    if (!low || low.w !== lw || low.h !== lh) {
      if (low) { ['L0', 't1', 't2', 'gA', 'gB', 'bl', 'lc', 'bz'].forEach(k => free(low[k])); if (low.dz) low.dz.forEach(free); }
      low = { w: lw, h: lh, L0: target(lw, lh, 2), t1: target(lw, lh), t2: target(lw, lh), gA: target(lw, lh), gB: target(lw, lh), bl: target(lw, lh), lc: target(lw, lh), bz: target(lw, lh) };
    }
    low.k = [1 / (lw * scl), 1 / (lh * scl)];
    drawField(scene, low.L0, [0, 0], scl, W, H, lw, lh);
    const px = Math.min(W, H) / scl, L = scene.low;
    blur(low.L0.tex[0], low.t1, 1, [0, 0], 0, L.bloomThr);
    blur(low.t1.tex[0], low.t2, 0, [1, 0], L.bloomSig * px); blur(low.t2.tex[0], low.bl, 0, [0, 1], L.bloomSig * px);
    blur(low.L0.tex[1], low.t1, 1, [0, 0], 0, L.glowThr);
    blur(low.t1.tex[0], low.t2, 0, [1, 0], L.glowSig * px); blur(low.t2.tex[0], low.gA, 0, [0, 1], L.glowSig * px);
    blur(low.gA.tex[0], low.t2, 0, [1, 0], L.glowSig * px * 2.83); blur(low.t2.tex[0], low.gB, 0, [0, 1], L.glowSig * px * 2.83);
    blur(low.L0.tex[0], low.t2, 0, [1, 0], L.lcSig * px); blur(low.t2.tex[0], low.lc, 0, [0, 1], L.lcSig * px);
    low.sLow = (scene.blurSig || 0) * px;                     // the global blur in low-resolution texels
    low.bzTex = low.bz.tex[0];
    if (low.sLow >= 1.4) {
      // a blur pass has at most 64 taps a side, so past ~32 texels the taps would spread out and ghost. Very wide blurs are
      // therefore computed on a box-prefiltered copy reduced by d, where the radius is again under 32 texels (a Gaussian
      // that wide has nothing left at the frequencies the reduction drops).
      const d = Math.ceil(low.sLow / 32);
      if (d <= 1) { blur(low.L0.tex[0], low.t2, 0, [1, 0], low.sLow); blur(low.t2.tex[0], low.bz, 0, [0, 1], low.sLow); }
      else {
        const bw = Math.max(4, Math.ceil(lw / d)), bh = Math.max(4, Math.ceil(lh / d));
        if (!low.dz || low.dz[0].w !== bw || low.dz[0].h !== bh) { if (low.dz) low.dz.forEach(free); low.dz = [target(bw, bh), target(bw, bh), target(bw, bh)]; }
        blur(low.L0.tex[0], low.dz[0], 2, [lw / bw, lh / bh], 0);
        blur(low.dz[0].tex[0], low.dz[1], 0, [1, 0], low.sLow * bw / lw); blur(low.dz[1].tex[0], low.dz[2], 0, [0, 1], low.sLow * bh / lh);
        low.bzTex = low.dz[2].tex[0];
      }
    }
    lowKey = key;
    return low;
  }
  // global blur: radii of at least ~2 low-resolution texels come from the pyramid (exact enough, any size, no margin);
  // smaller radii are blurred at full resolution per tile, with a margin. In between, the two are cross-faded.
  const sstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
  function blurPlan(scene, L, W, H, scl) {
    const sig = scene.blurSig || 0; if (!sig) return { wLow: 0, sPx: 0 };
    const wLow = L.sLow >= 1.4 ? sstep(1.5, 2.5, L.sLow) : 0, sPx = wLow < 1 ? sig * Math.min(W, H) / scl : 0;
    return { wLow, sPx: sPx > .3 ? sPx : 0 };
  }
  function drawPost(scene, fb, vw, vh, org, scl, W, H, F, fOrg, flip, wLow) {
    gl.useProgram(PP.p);
    const bind = (unit, t, name) => { gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, t); set(PP, name, unit); };
    bind(1, F.tex[0], 'uFld'); bind(2, low.gA.tex[0], 'uGlA'); bind(3, low.gB.tex[0], 'uGlB'); bind(4, low.bl.tex[0], 'uBlm'); bind(5, low.lc.tex[0], 'uLcT');
    bind(10, wLow > 0 ? low.bzTex : blank, 'uBlr');
    setAll(PP, scene.post);
    set(PP, 'uRes', [W, H]); set(PP, 'uOrg', org); set(PP, 'uScl', scl); set(PP, 'uSymG', [org[0], org[1], scl]); set(PP, 'uFlip', flip); set(PP, 'uTH', vh); set(PP, 'uBlrW', wLow);
    set(PP, 'uFOrg', fOrg); set(PP, 'uFSize', [F.w, F.h]); set(PP, 'uLowK', low.k); set(PP, 'uEnc', ENC);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb); gl.viewport(0, 0, vw, vh);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    for (const u of [1, 2, 3, 4, 5, 10]) { gl.activeTexture(gl.TEXTURE0 + u); gl.bindTexture(gl.TEXTURE_2D, null); }
    gl.activeTexture(gl.TEXTURE0);
  }
  const margin = (scene, W, H, scl, bp) => Math.min(512, Math.ceil(scene.marginNorm * Math.min(W, H) / scl) + 2) + (bp.sPx ? Math.ceil(3 * bp.sPx) + 2 : 0);

  // the field for a region (with its margin), blurred at full resolution when the plan asks for it
  const fieldCache = [];
  function cached(w, h) {
    let i = fieldCache.findIndex(c => c.T.w === w && c.T.h === h);
    if (i < 0) { if (fieldCache.length >= 2) { const c = fieldCache.shift(); free(c.T); free(c.B1); free(c.B2); } fieldCache.push({ T: target(w, h), key: '', bkey: '' }); i = fieldCache.length - 1; }
    return fieldCache[i];
  }
  function region(scene, W, H, ox, oy, scl, tw, th, lowRes, useCache) {
    const L = ensureLow(scene, W, H, lowRes), bp = blurPlan(scene, L, W, H, scl);
    const m = margin(scene, W, H, scl, bp), fw = tw + 2 * m, fh = th + 2 * m, fOrg = [ox - m * scl, oy - m * scl], temps = [];
    let F;
    if (useCache) {
      const FC = cached(fw, fh), key = scene.fieldKey + '|' + [W, H, fOrg[0], fOrg[1], scl, fw, fh].join(',');
      if (FC.key !== key) { drawField(scene, FC.T, fOrg, scl, W, H, fw, fh); FC.key = key; FC.bkey = ''; }
      F = FC.T;
      if (bp.sPx) {
        if (!FC.B1) { FC.B1 = target(fw, fh); FC.B2 = target(fw, fh); }
        const bkey = key + '|' + bp.sPx;
        if (FC.bkey !== bkey) { blur(F.tex[0], FC.B1, 0, [1, 0], bp.sPx); blur(FC.B1.tex[0], FC.B2, 0, [0, 1], bp.sPx); FC.bkey = bkey; }
        F = FC.B2;
      }
    } else {
      F = target(fw, fh); temps.push(F); drawField(scene, F, fOrg, scl, W, H, fw, fh);
      if (bp.sPx) { const B1 = target(fw, fh), B2 = target(fw, fh); temps.push(B1, B2); blur(F.tex[0], B1, 0, [1, 0], bp.sPx); blur(B1.tex[0], B2, 0, [0, 1], bp.sPx); F = B2; }
    }
    return { F, fOrg, wLow: bp.wLow, temps };
  }
  let out8 = null;
  function out8Target(w, h) { if (!out8 || out8.w < w || out8.h < h) { free(out8); out8 = target(Math.max(w, out8 ? out8.w : 0), Math.max(h, out8 ? out8.h : 0), 1, { i: gl.RGBA8, f: gl.RGBA, t: gl.UNSIGNED_BYTE }); } return out8; }

  const MAXT = Math.min(2048, gl.getParameter(gl.MAX_TEXTURE_SIZE) - 1400, gl.getParameter(gl.MAX_VIEWPORT_DIMS)[0] - 1400);
  return {
    gl, floatRT, ready, isReady: () => isReady,
    // preview: the field is cached; a post-only change re-runs just the last pass
    preview(scene, v) {
      const R = region(scene, v.W, v.H, v.ox, v.oy, v.scl, v.tw, v.th, v.fast ? 256 : 512, true);
      if (canvas.width !== v.tw || canvas.height !== v.th) { canvas.width = v.tw; canvas.height = v.th; }
      drawPost(scene, null, v.tw, v.th, [v.ox, v.oy], v.scl, v.W, v.H, R.F, R.fOrg, 1, R.wLow);
    },
    // any region of the image at any scale, straight to RGBA8 pixels (thumbnails, comparison, tests)
    pixels(scene, W, H, ox, oy, scl, tw, th, lowRes = 384) {
      const R = region(scene, W, H, ox, oy, scl, tw, th, lowRes, false);
      try {
        const O = out8Target(tw, th);
        drawPost(scene, O.fb, tw, th, [ox, oy], scl, W, H, R.F, R.fOrg, 0, R.wLow);
        const px = new Uint8Array(tw * th * 4);
        gl.bindFramebuffer(gl.FRAMEBUFFER, O.fb); gl.readPixels(0, 0, tw, th, gl.RGBA, gl.UNSIGNED_BYTE, px);
        return px;
      } finally { R.temps.forEach(free); gl.bindFramebuffer(gl.FRAMEBUFFER, null); }
    },
    // the real target resolution, in tiles: whole-image pyramid at 1024 px, field tiles with a margin, post, readback
    async exportTiles(scene, W, H, onBand, onProgress, cancelled) {
      const L = ensureLow(scene, W, H, 1024), bp = blurPlan(scene, L, W, H, 1);
      const m = margin(scene, W, H, 1, bp), TW = Math.min(W, MAXT), BH = Math.min(H, 256);
      const F = target(TW + 2 * m, BH + 2 * m), O = target(TW, BH, 1, { i: gl.RGBA8, f: gl.RGBA, t: gl.UNSIGNED_BYTE });
      const B1 = bp.sPx ? target(TW + 2 * m, BH + 2 * m) : null, B2 = bp.sPx ? target(TW + 2 * m, BH + 2 * m) : null;
      const tile = new Uint8Array(TW * BH * 4);
      try {
        for (let y0 = 0; y0 < H; y0 += BH) {
          const rows = Math.min(BH, H - y0), band = new Uint8Array(W * rows * 4);
          ensureLow(scene, W, H, 1024);                       // a preview drawn between bands must not change the shared pyramid
          for (let x0 = 0; x0 < W; x0 += TW) {
            if (cancelled && cancelled()) throw new Error('cancelled');
            const cols = Math.min(TW, W - x0), fOrg = [x0 - m, y0 - m];
            drawField(scene, F, fOrg, 1, W, H, cols + 2 * m, rows + 2 * m);
            let src = F;
            if (bp.sPx) { blur(F.tex[0], B1, 0, [1, 0], bp.sPx); blur(B1.tex[0], B2, 0, [0, 1], bp.sPx); src = B2; }
            drawPost(scene, O.fb, cols, rows, [x0, y0], 1, W, H, src, fOrg, 0, bp.wLow);
            gl.bindFramebuffer(gl.FRAMEBUFFER, O.fb); gl.readPixels(0, 0, cols, rows, gl.RGBA, gl.UNSIGNED_BYTE, tile);
            for (let r = 0; r < rows; r++) band.set(tile.subarray(r * cols * 4, (r + 1) * cols * 4), (r * W + x0) * 4);
          }
          await onBand(band, y0, rows);
          onProgress && onProgress((y0 + rows) / H);
          await new Promise(r => setTimeout(r, 0));
        }
      } finally { free(F); free(O); free(B1); free(B2); gl.bindFramebuffer(gl.FRAMEBUFFER, null); lowKey = ''; for (const c of fieldCache) c.key = ''; }
    },
    invalidate() { lowKey = ''; layersOnGPU = null; rectsOnGPU = null; for (const c of fieldCache) c.key = ''; },
  };
}

G.ChromaEngine = { create };
})(window);
