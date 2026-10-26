/*
  CHROMA — core: deterministic randomness, colour science, palettes, art directions, composition, recipes.
  No DOM and no WebGL here. Everything is a pure function of the state, so a recipe always rebuilds the same scene.

    ChromaCore.compile(state, aspect, opts) → scene { field, layers, n, post, low, marginNorm, fieldKey, lowKey, info, vec }
    ChromaCore.fromSeed(code) / seedCode(state) / encodeRecipe(state) / decodeRecipe(str)
    ChromaCore.makePalette(rng, harmony, profile) → [{hex, pos}] · identifyRoles(palette, roleSeed)
    ChromaCore.directionParams(dirId, styleSeed) → slider values the direction intends
*/
(function (G) {
'use strict';
const VERSION = 1;
const TAU = Math.PI * 2;
const clamp = (v, a, b) => v < a ? a : v > b ? b : v, lerp = (a, b, t) => a + (b - a) * t;
const sstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

/* ============================================================ 1. randomness — independent, named streams */
function strHash(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return h >>> 0; }
function mix32() {
  let h = 0x9e3779b9;
  for (let i = 0; i < arguments.length; i++) {
    let x = arguments[i]; x = typeof x === 'string' ? strHash(x) : (x >>> 0);
    h = Math.imul(h ^ x, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
  }
  return h >>> 0;
}
function rng(seed) {   // mulberry32
  let a = (seed >>> 0) || 0x6d2b79f5;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const stream = (...k) => rng(mix32(...k));
const newSeed = () => (G.crypto && G.crypto.getRandomValues ? G.crypto.getRandomValues(new Uint32Array(1))[0] : Math.random() * 4294967296) >>> 0;
const R = (r, a, b) => a + (b - a) * r();
const RI = (r, a, b) => Math.min(b, Math.floor(a + (b - a + 1) * r()));
const pick = (r, arr) => arr[Math.floor(r() * arr.length) % arr.length];
function pickW(r, w) {
  let s = 0; for (const k in w) s += w[k];
  let x = r() * s; for (const k in w) { x -= w[k]; if (x <= 0) return k; }
  return Object.keys(w)[0];
}

/* ============================================================ 2. colour science (OKLab / OKLCh, linear light, sRGB) */
const s2l = c => c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4;
const l2s = c => c <= .0031308 ? c * 12.92 : 1.055 * Math.max(c, 0) ** (1 / 2.4) - .055;
function lin2ok(c) {
  const l = Math.cbrt(.4122214708 * c[0] + .5363325363 * c[1] + .0514459929 * c[2]);
  const m = Math.cbrt(.2119034982 * c[0] + .6806995451 * c[1] + .1073969566 * c[2]);
  const s = Math.cbrt(.0883024619 * c[0] + .2817188376 * c[1] + .6299787005 * c[2]);
  return [.2104542553 * l + .7936177850 * m - .0040720468 * s, 1.9779984951 * l - 2.4285922050 * m + .4505937099 * s, .0259040371 * l + .7827717662 * m - .8086757660 * s];
}
function ok2lin(o) {
  const l = (o[0] + .3963377774 * o[1] + .2158037573 * o[2]) ** 3, m = (o[0] - .1055613458 * o[1] - .0638541728 * o[2]) ** 3, s = (o[0] - .0894841775 * o[1] - 1.2914855480 * o[2]) ** 3;
  return [4.0767416621 * l - 3.3077115913 * m + .2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - .3413193965 * s, -.0041960863 * l - .7034186147 * m + 1.7076147010 * s];
}
const inGamut = c => c[0] >= -1e-4 && c[0] <= 1.0001 && c[1] >= -1e-4 && c[1] <= 1.0001 && c[2] >= -1e-4 && c[2] <= 1.0001;
function hex2rgb(h) { h = h.replace('#', ''); if (h.length === 3) h = h.replace(/./g, '$&$&'); const n = parseInt(h, 16); return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255]; }
function rgb2hex(c) { return '#' + c.map(v => Math.round(clamp(v, 0, 1) * 255).toString(16).padStart(2, '0')).join(''); }
const hex2ok = h => lin2ok(hex2rgb(h).map(s2l));
function gamutClamp(o) {   // keep lightness and hue, give up chroma until the colour is displayable
  if (inGamut(ok2lin(o))) return o;
  let lo = 0, hi = 1;
  for (let i = 0; i < 18; i++) { const m = (lo + hi) / 2; if (inGamut(ok2lin([o[0], o[1] * m, o[2] * m]))) lo = m; else hi = m; }
  return [o[0], o[1] * lo, o[2] * lo];
}
const ok2hex = o => rgb2hex(ok2lin(gamutClamp([clamp(o[0], 0, 1), o[1], o[2]])).map(l2s));
const lch2ok = (L, C, h) => [L, C * Math.cos(h * Math.PI / 180), C * Math.sin(h * Math.PI / 180)];
function ok2lch(o) { let h = Math.atan2(o[2], o[1]) * 180 / Math.PI; if (h < 0) h += 360; return [o[0], Math.hypot(o[1], o[2]), h]; }
function maxChroma(L, h) {
  let lo = 0, hi = .42;
  for (let i = 0; i < 20; i++) { const m = (lo + hi) / 2; if (inGamut(ok2lin(lch2ok(L, m, h)))) lo = m; else hi = m; }
  return lo;
}
const wrapH = h => ((h % 360) + 360) % 360;
const hueDist = (a, b) => { const d = Math.abs(wrapH(a) - wrapH(b)); return d > 180 ? 360 - d : d; };
function mixHue(a, b, t) { let d = wrapH(b) - wrapH(a); if (d > 180) d -= 360; if (d < -180) d += 360; return wrapH(a + d * t); }
const lchHex = (L, cf, h) => { h = wrapH(h); return ok2hex(lch2ok(L, maxChroma(L, h) * clamp(cf, 0, 1), h)); };
// the lightness at which a hue reaches its maximum chroma: deep for blue, bright for yellow and lime
const cuspCache = {};
function cuspL(h) {
  const k = Math.round(wrapH(h)) % 360;
  if (cuspCache[k] != null) return cuspCache[k];
  let best = .5, bc = 0;
  for (let L = .2; L <= .98; L += .01) { const c = maxChroma(L, k); if (c > bc) { bc = c; best = L; } }
  return (cuspCache[k] = best);
}
function rotHue(o, deg) { if (!deg) return o; const a = deg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a); return gamutClamp([o[0], o[1] * c - o[2] * s, o[1] * s + o[2] * c]); }

/* JS mirror of the shader's perceptual mix: OKLab with the chroma of the endpoints carried through (no grey mud) */
function mixc(a, b, t, keep) {
  const m = [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
  if (!keep) return m;
  const ca = Math.hypot(a[1], a[2]), cb = Math.hypot(b[1], b[2]);
  const ha = Math.atan2(a[2], a[1]); let dh = Math.atan2(b[2], b[1]) - ha;
  dh -= TAU * Math.floor((dh + Math.PI) / TAU);
  const h = ha + dh * t, tc = lerp(ca, cb, t), w = sstep(.015, .06, Math.min(ca, cb)) * keep;
  return [m[0], lerp(m[1], Math.cos(h) * tc, w), lerp(m[2], Math.sin(h) * tc, w)];
}
const ease = x => { x = clamp(x, 0, 1); return lerp(x, x * x * (3 - 2 * x), .5); };

/* ============================================================ 3. palettes */
// OKLCh hues of the period: ultramarine, cobalt, electric blue, cyan, magenta, hot pink, acid lime, violet, red, amber
const Y2K_HUES = [266, 258, 248, 205, 195, 330, 342, 356, 132, 124, 302, 292, 28, 22, 72, 62];
const HARMONIES = {
  auto: 'Harmony: auto', complementary: 'Complementary', analogous: 'Analogous', triadic: 'Triadic', split: 'Split complementary',
  tetradic: 'Tetradic', mono: 'Monochrome + accent', warmcool: 'Warm vs cool', synthetic: 'High-chroma synthetic',
  nearblack: 'Near-black + luminous', metallic: 'Metallic', wild: 'Unconventional',
};
const DEFAULT_HARM = { complementary: 2, analogous: 2, triadic: 1.5, split: 2, tetradic: 1, mono: 1, warmcool: 1.5, synthetic: 2, nearblack: 1.5, metallic: .8, wild: 1.2 };
function harmonyHues(r, harm, hd) {
  const j = a => (r() - .5) * a, sg = r() < .5 ? 1 : -1;
  switch (harm) {
    case 'complementary': return { hd, hs: hd + sg * R(r, 18, 42), ha: hd + 180 + j(26), hc: hd + 180 + sg * R(r, 28, 55) };
    case 'analogous': return { hd, hs: hd + sg * R(r, 25, 45), ha: hd + sg * R(r, 55, 90), hc: r() < .4 ? hd + 180 + j(40) : hd - sg * R(r, 25, 45) };
    case 'triadic': return { hd, hs: hd + 120 + j(16), ha: hd + 240 + j(16), hc: hd + 60 + j(24) };
    case 'split': return { hd, hs: hd + 150 + j(12), ha: hd + 210 + j(12), hc: hd + sg * R(r, 20, 40) };
    case 'tetradic': return { hd, hs: hd + 90 + j(12), ha: hd + 180 + j(12), hc: hd + 270 + j(12) };
    case 'mono': return { hd, hs: hd + j(24), ha: hd + R(r, 140, 220), hc: hd + j(40), mod: 'mono' };
    case 'warmcool': { const c = R(r, 228, 300), w = R(r, 15, 78); return { hd: c, hs: w, ha: r() < .5 ? R(r, 55, 82) : R(r, 340, 372), hc: c + sg * 30 }; }
    case 'synthetic': return { hd, hs: hd + sg * R(r, 60, 110), ha: hd + R(r, 160, 220), hc: hd - sg * R(r, 70, 120), mod: 'hi' };
    case 'nearblack': return { hd, hs: hd + sg * R(r, 25, 60), ha: hd + 180 + j(60), hc: hd + sg * R(r, 90, 140), mod: 'dark' };
    case 'metallic': { const m = pick(r, [258, 290, 222, 330, 64, 270]); return { hd: m, hs: m + j(50), ha: pick(r, [330, 205, 300, 72, m + 180]), hc: m + 180 + j(40), mod: 'metal' }; }
    default: return { hd, hs: hd + sg * R(r, 70, 140), ha: hd - sg * R(r, 60, 170), hc: hd + R(r, 170, 260), mod: 'wild' };
  }
}
function makePalette(r, harmony = 'auto', prof = {}) {
  const harm = harmony === 'auto' ? pickW(r, prof.harm || DEFAULT_HARM) : harmony;
  const H = harmonyHues(r, harm, (prof.hues ? pick(r, prof.hues) : pick(r, Y2K_HUES)) + (r() - .5) * 20);
  const cr = prof.chroma || [.8, 1], cm = R(r, cr[0], cr[1]);
  const dark = H.mod === 'dark' || r() < (prof.dark ?? .3), light = !dark && r() < (prof.light ?? 0), metal = H.mod === 'metal', hi = H.mod === 'hi';
  const shadowHue = H.hd + (r() - .5) * 30;   // shadows stay in the dominant's family (no pull toward an unrelated violet)
  const cusp = (h, lo, hi, a, b) => clamp(cuspL(h) + R(r, lo, hi), a, b);
  const Ld = light ? R(r, .66, .78) : dark ? R(r, .28, .42) : cusp(H.hd, -.2, 0, .3, .66), Ls = light ? R(r, .76, .86) : cusp(H.hs, -.14, .04, .34, .8);
  const mk = {
    deep: () => lchHex(light ? R(r, .32, .46) : dark ? R(r, .05, .12) : R(r, .09, .19), metal ? R(r, .15, .4) : R(r, .45, .9), shadowHue),
    shadow2: () => lchHex(light ? R(r, .5, .6) : R(r, .2, .32), metal ? R(r, .2, .4) : R(r, .7, 1), mixHue(H.hd, shadowHue, .5) - R(r, 5, 30)),
    dominant: () => lchHex(Ld, metal ? R(r, .06, .2) : R(r, .88, 1) * (hi ? 1 : cm), H.hd),
    support: () => lchHex(Ls, metal ? R(r, .05, .22) : R(r, .75, 1) * cm, H.hs),
    accent: () => lchHex(H.mod === 'wild' && r() < .4 ? R(r, .45, .6) : light ? cusp(H.ha, 0, .1, .6, .92) : cusp(H.ha, -.06, .04, .45, .9), (metal ? R(r, .3, .55) : hi ? 1 : cm) * R(r, .92, 1), H.ha),
    highlight: () => lchHex(R(r, .92, .975), metal ? R(r, .1, .3) : R(r, .2, .6), r() < .5 ? H.ha : H.hd),   // a light tint of the palette's own hues
    transition: () => lchHex(lerp(Ld, Ls, .5), .92 * cm, mixHue(H.hd, H.hs, .5)),
    contrast: () => lchHex(light ? cusp(H.hc, 0, .1, .6, .9) : cusp(H.hc, -.1, .04, .4, .88), metal ? R(r, .2, .45) : cm, H.hc),
    transition2: () => lchHex(cusp(mixHue(H.hd, H.ha, .5), -.12, .02, .35, .85), .88 * cm, mixHue(H.hd, H.ha, .5)),
    support2: () => lchHex(clamp(Ls + R(r, -.25, .1), .25, .85), .85 * cm, H.hs + (r() - .5) * 30),
    accent2: () => lchHex(cusp(H.hc, -.08, .04, .4, .9), cm, H.hc + (r() - .5) * 20),
  };
  const nr = prof.n || [4, 7], n = clamp(RI(r, nr[0], nr[1]), 3, 10);
  let roles;
  if (n === 3) roles = ['deep', 'dominant', 'accent'];
  else {
    const extra = ['support', 'shadow2', 'transition', 'contrast', 'transition2', 'support2'];
    for (let i = extra.length - 1; i > 1; i--) { const k = 2 + Math.floor(r() * (i - 1)); [extra[i], extra[k]] = [extra[k], extra[i]]; }   // support and shadow2 come first
    roles = ['deep', 'dominant', 'accent', 'highlight', ...extra, 'accent2'].slice(0, n);
  }
  const cols = roles.map(k => mk[k]()).map(hex => ({ hex, L: hex2ok(hex)[0] })).sort((a, b) => a.L - b.L);
  return cols.map((c, i) => ({ hex: c.hex, pos: n > 1 ? clamp(i / (n - 1) + (i && i < n - 1 ? (r() - .5) * .3 / (n - 1) : 0), 0, 1) : 0 }));
}
/* palette families: explicit colour specifications. Every colour of a family is drawn inside a fixed OKLCh box —
   lightness, chroma as a share of the most that hue can show at that lightness, and hue in degrees — so a Warm palette
   can only contain warm colours, a Mono palette only one hue. 'style' leaves the choice to the art direction, 'custom'
   marks a palette the user edited. While a family other than 'style' is chosen the renderer adds no colours of its own
   (see `strict` in compile). */
const FAMILIES = { style: 'Style', warm: 'Warm', cool: 'Cool', earth: 'Earth', neon: 'Neon', pastel: 'Pastel', mono: 'Mono', metallic: 'Metallic' };
const FAMILY_SPEC = {
  //       [lightness],   [chroma share], [hue°]
  warm: [[[.16, .26], [.45, .75], [18, 42]], [[.45, .56], [.85, 1], [22, 32]], [[.62, .72], [.6, .85], [28, 45]],
    [[.66, .76], [.85, 1], [45, 62]], [[.78, .86], [.8, 1], [68, 82]], [[.92, .96], [.25, .5], [65, 85]]],
  cool: [[[.14, .24], [.5, .8], [255, 275]], [[.38, .5], [.8, 1], [255, 270]], [[.52, .62], [.7, .95], [280, 300]],
    [[.62, .72], [.75, 1], [215, 240]], [[.74, .84], [.7, .95], [190, 205]], [[.9, .96], [.2, .45], [200, 230]]],
  earth: [[[.18, .26], [.25, .45], [40, 60]], [[.42, .52], [.35, .55], [35, 50]], [[.5, .6], [.25, .45], [110, 135]],
    [[.62, .7], [.4, .6], [70, 85]], [[.74, .82], [.3, .45], [60, 80]], [[.88, .93], [.12, .25], [75, 90]]],
  pastel: [[[.6, .68], [.35, .5], null], [[.78, .84], [.4, .6], null], [[.82, .88], [.35, .55], null], [[.86, .9], [.35, .55], null],
    [[.9, .94], [.25, .45], null], [[.95, .98], [.1, .25], null]],
};
const NEON_HUES = [330, 200, 140, 265, 0, 105, 300];
function familyPalette(r, fam) {
  const out = [], put = (L, cf, h) => out.push(lchHex(clamp(L, 0, 1), cf, h));
  if (FAMILY_SPEC[fam]) {
    const base = R(r, 0, 360), spread = R(r, 60, 140);   // pastel: related hues around a base
    for (const [Lr, Cr, Hr] of FAMILY_SPEC[fam]) put(R(r, Lr[0], Lr[1]), R(r, Cr[0], Cr[1]), Hr ? R(r, Hr[0], Hr[1]) : base + (r() - .5) * spread);
  } else if (fam === 'neon') {
    // electric colours at full chroma, each at the lightness where its hue peaks, over a near-black of a related hue
    const hs = NEON_HUES.slice(); for (let i = hs.length - 1; i > 0; i--) { const k = Math.floor(r() * (i + 1)); [hs[i], hs[k]] = [hs[k], hs[i]]; }
    const pickN = hs.slice(0, RI(r, 3, 4));
    put(R(r, .1, .15), R(r, .35, .6), pickN[0] + (r() - .5) * 20);
    for (const h of pickN) put(cuspL(h) + R(r, -.03, .02), R(r, .95, 1), h + (r() - .5) * 8);
  } else if (fam === 'mono') {
    // one hue (or none: a neutral grey ladder), from near-black to near-white, chroma highest in the midtones
    const h = R(r, 0, 360), neutral = r() < .2, peak = neutral ? 0 : R(r, .55, .85), Ls = [.12, .27, .43, .58, .73, .87, .96];
    for (const L of Ls.slice(0, 7 - RI(r, 0, 1))) put(L + R(r, -.02, .02), peak * Math.sin(Math.PI * L) ** .7, h + (r() - .5) * 4);
  } else if (fam === 'metallic') {
    // a long, controlled tonal ladder of near-neutrals: silver and graphite (cool), gold, copper or gunmetal
    const kind = pickW(r, { silver: 3, gold: 1.5, copper: 1, gunmetal: 1 });
    const spec = { silver: [248, .004, .02], gold: [82, .03, .11], copper: [52, .035, .12], gunmetal: [255, .008, .03] }[kind];
    const Ls = kind === 'gunmetal' ? [.08, .2, .34, .5, .66, .82] : [.1, .24, .42, .6, .76, .88, .97];
    for (const L of Ls) { const c = lerp(spec[1], spec[2], Math.sin(Math.PI * L)), h = spec[0] + (r() - .5) * 6; out.push(ok2hex(lch2ok(L + R(r, -.015, .015), c, h))); }
  }
  const cols = out.map(hex => ({ hex, L: hex2ok(hex)[0] })).sort((a, b) => a.L - b.L), n = cols.length;
  return cols.map((c, i) => ({ hex: c.hex, pos: n > 1 ? i / (n - 1) : 0 }));
}
// a new palette for a state: the chosen family, or the style's own palette
function paletteForFamily(r, fam, dirId) { return FAMILY_SPEC[fam] || fam === 'neon' || fam === 'mono' || fam === 'metallic' ? familyPalette(r, fam) : makePalette(r, 'auto', getDirection(dirId).pal); }
const isStrict = st => !!(FAMILIES[st.harmony] && st.harmony !== 'style') || st.harmony === 'custom';

/* roles: which stop is the deep shadow, the dominant, the accent… derived from the colours themselves, so any edited palette works */
const ROLE_NAMES = ['deep', 'shadow2', 'dominant', 'support', 'accent', 'highlight', 'transition', 'contrast'];
const ROLE_LABEL = { deep: 'Deep', shadow2: 'Shadow', dominant: 'Dominant', support: 'Support', accent: 'Accent', highlight: 'Light', transition: 'Transition', contrast: 'Contrast' };
const ROLE_FALLBACK = {
  deep: ['shadow2', 'dominant'], shadow2: ['deep', 'dominant'], dominant: ['support', 'accent', 'transition', 'deep'], support: ['dominant', 'transition', 'accent'],
  accent: ['contrast', 'support', 'highlight', 'dominant'], highlight: ['accent', 'support', 'dominant'], transition: ['support', 'dominant', 'accent'], contrast: ['accent', 'support', 'dominant'],
};
function identifyRoles(pal, roleSeed) {
  const cs = pal.map((s, i) => { const o = hex2ok(s.hex), l = ok2lch(o); return { i, L: o[0], C: l[1], h: l[2] }; });
  const used = new Set(), roles = {};
  const by = f => { let best = -1, bv = -Infinity; for (const c of cs) if (!used.has(c.i)) { const v = f(c); if (v > bv) { bv = v; best = c.i; } } if (best >= 0) used.add(best); return best; };
  roles.deep = by(c => -c.L);
  roles.highlight = cs.length > 2 ? by(c => c.L * 1.4 - c.C) : -1;
  roles.accent = by(c => c.C * (.6 + c.L * .6));
  roles.dominant = by(c => c.C * (1.2 - Math.abs(c.L - .5) * 1.4));
  roles.support = by(c => c.C + .2 - Math.abs(c.L - .6) * .5);
  roles.shadow2 = by(c => (c.L < .42 ? 1 : 0) - c.L);
  const hd = roles.dominant >= 0 ? cs[roles.dominant].h : 0;
  roles.contrast = by(c => hueDist(c.h, hd) * c.C);
  roles.transition = by(c => c.C);
  const extra = cs.filter(c => !used.has(c.i)).map(c => c.i);
  // palette shuffle: the chromatic roles trade colours, so the same palette lands in different places
  if (roleSeed) {
    const r = rng(roleSeed), keys = ['dominant', 'support', 'accent', 'contrast', 'transition'].filter(k => roles[k] >= 0);
    const vals = keys.map(k => roles[k]);
    for (let i = vals.length - 1; i > 0; i--) { const k = Math.floor(r() * (i + 1)); [vals[i], vals[k]] = [vals[k], vals[i]]; }
    keys.forEach((k, i) => { roles[k] = vals[i]; });
  }
  const resolved = {};
  for (const k of ROLE_NAMES) {
    let v = roles[k];
    if (v < 0) for (const f of ROLE_FALLBACK[k]) if (roles[f] >= 0) { v = roles[f]; break; }
    resolved[k] = v < 0 ? 0 : v;
  }
  resolved.extra = extra;
  resolved.labels = pal.map((_, i) => { const k = ROLE_NAMES.find(n => roles[n] === i); return k ? ROLE_LABEL[k] : extra.includes(i) ? 'Extra' : ''; });
  return resolved;
}

/* ============================================================ 4. vocabulary */
const T = { LIN: 0, POOL: 1, MULTI: 2, CONIC: 3, BLOB: 4, BAND: 5, RINGS: 6, STRIPES: 7, FRAME: 8, INTERF: 9, MEMB: 10, MESH: 11, BLOCK: 12, TUBE: 13, TUNNEL: 14, RAYS: 15, WEDGE: 16 };
const GTYPES = {
  auto: ['Gradient type: direction', null],
  pools: ['Pools & airbrush', { 1: 3, 2: 1.5, 16: .7 }], blobs: ['Blobs', { 4: 3, 10: 2, 2: 1 }], membranes: ['Membranes', { 10: 4, 4: 1 }],
  bands: ['Ribbons & tubes', { 5: 3, 13: 2, 7: 1 }], stripes: ['Stripes', { 7: 3, 5: 1.5, 9: .7 }], rings: ['Rings & waves', { 6: 3, 14: 1.2, 9: 1 }],
  mesh: ['Mesh', { 11: 3, 1: 1 }], frames: ['Frames & sweeps', { 8: 2, 0: 2, 12: 1 }], blocks: ['Blocks', { 12: 3, 0: 1, 8: 1 }],
  orbs: ['Orbs', { 1: 2, 10: 2, 6: 1 }], interference: ['Interference', { 9: 3, 6: 1.5, 7: 1 }], tunnel: ['Tunnels', { 14: 2, 6: 2, 3: 1 }],
  rays: ['Rays & conics', { 15: 2, 16: 2, 3: 1 }], vector: ['Vector (SVG-ready)', { 1: 3, 0: 1 }],
};
const STRUCTS = {
  bloom: ['Central bloom', { radial: 3, circular: 1, 'diag-up': 1 }, r => [R(r, .36, .64), R(r, .36, .62)]],
  diagonal: ['Diagonal sweep', { 'diag-up': 1, 'diag-down': 1 }, r => thirds(r)],
  horizon: ['Horizon', { horizontal: 1 }, r => [R(r, .25, .75), pick(r, [.34, .62]) + (r() - .5) * .1]],
  edge: ['Edge-weighted', { vertical: 1, horizontal: 1, 'diag-down': .5 }, r => r() < .5 ? [pick(r, [.1, .9]), R(r, .2, .8)] : [R(r, .2, .8), pick(r, [.1, .9])]],
  split: ['Split field', { 'diag-up': 1, 'diag-down': 1, vertical: 1, horizontal: .6 }, r => [R(r, .32, .68), R(r, .32, .68)]],
  vortex: ['Vortex', { circular: 1 }, r => thirds(r)],
  constellation: ['Constellation', { 'diag-up': 1, 'diag-down': 1, horizontal: .5, radial: .5 }, r => thirds(r)],
  tunnel: ['Tunnel', { radial: 1 }, r => [R(r, .3, .7), R(r, .3, .7)]],
  cascade: ['Cascade', { vertical: 1 }, r => [R(r, .25, .75), R(r, .2, .45)]],
  corner: ['Corner burst', { radial: 1, 'diag-down': 1 }, r => [pick(r, [.1, .9]) + (r() - .5) * .08, pick(r, [.1, .9]) + (r() - .5) * .08]],
  field: ['Open field', { horizontal: 1, 'diag-up': 1, 'diag-down': 1, circular: .4 }, r => thirds(r)],
};
function thirds(r) { return [pick(r, [1 / 3, 2 / 3]) + (r() - .5) * .14, pick(r, [1 / 3, 2 / 3]) + (r() - .5) * .14]; }
const FLOW_ANGLE = { horizontal: 0, vertical: Math.PI / 2, 'diag-up': -Math.PI / 4, 'diag-down': Math.PI / 4, radial: 0, circular: 0 };

/* ============================================================ 5. parameters */
const PRM = (id, label, group, def, o = {}) => ({ id, label, group, def, min: 0, max: 1, step: .01, ...o });
const PARAMS = [
  PRM('complexity', 'Complexity', 'comp', .5, { tip: 'Few strong structures ↔ layered meso structures, light pools and micro detail' }),
  PRM('fields', 'Fields', 'comp', 6, { min: 2, max: 14, step: 1, int: true, tip: 'Number of primary gradient fields: the dominant event plus supporting structures' }),
  PRM('edge', 'Edge activity', 'comp', .3, { tip: 'Frames, ribbons and colour masses that cling to the edges of the canvas' }),
  PRM('negative', 'Negative space', 'comp', .35, { tip: 'Size of a deliberately quiet area (e.g. for typography). Fields are pushed out of it' }),
  PRM('asymmetry', 'Asymmetry', 'comp', .55, { tip: 'Centred and balanced ↔ off-centre, lopsided and edge-driven' }),
  PRM('hierarchy', 'Hierarchy', 'comp', .6, { adv: true, tip: 'How strongly the dominant event outweighs the supporting fields' }),
  PRM('varAmt', 'Variation range', 'comp', .5, { adv: true, tip: 'How far Variation moves positions, scale, colour distribution and distortion' }),

  PRM('gtype', 'Gradient type', 'struct', 'auto', { kind: 'select', options: Object.fromEntries(Object.entries(GTYPES).map(([k, v]) => [k, v[0]])), tip: 'Override the direction\'s gradient vocabulary with one family of primitives' }),
  PRM('echoes', 'Layers', 'struct', 0, { min: 0, max: 4, step: 1, int: true, tip: 'Translucent echo layers behind the main fields, offset along the flow' }),
  PRM('softness', 'Softness', 'struct', .5, { tip: 'Edge blur of every field: hard graphic edges ↔ airbrushed haze' }),
  PRM('spread', 'Spread', 'struct', .5, { tip: 'Scale of all fields relative to the canvas' }),
  PRM('overlap', 'Field overlap', 'struct', .5, { tip: 'Fields spread across the canvas ↔ gathered and overlapping around the focus' }),
  PRM('falloff', 'Falloff', 'struct', .5, { tip: 'Shape of each field\'s fade: wide glowing shoulders ↔ tight, concentrated cores' }),
  PRM('distortion', 'Distortion', 'struct', .4, { tip: 'Domain warp strength: the fluid, liquid bending of every gradient' }),
  PRM('warpFreq', 'Warp frequency', 'struct', .4, { tip: 'Scale of the distortion: broad slow currents ↔ tight, turbulent folds' }),
  PRM('octaves', 'Noise octaves', 'struct', 4, { min: 1, max: 6, step: 1, int: true, adv: true, tip: 'Number of noise octaves inside the warp' }),
  PRM('warpIter', 'Warp iterations', 'struct', 2, { min: 1, max: 3, step: 1, int: true, adv: true, tip: 'Domain warp passes: each pass warps the result of the previous one' }),
  PRM('swirl', 'Swirl', 'struct', .1, { adv: true, tip: 'Rotational distortion around the focus' }),
  PRM('curl', 'Curl flow', 'struct', .15, { adv: true, tip: 'Divergence-free, curl-like currents (fluid without compression)' }),
  PRM('flowWarp', 'Directional warp', 'struct', .2, { adv: true, tip: 'Streams stretched along the visual flow' }),
  PRM('radial', 'Radial displacement', 'struct', 0, { adv: true, tip: 'Pushes the field in and out from the focus, like a shock wave' }),
  PRM('layerWarp', 'Layer distortion', 'struct', .3, { adv: true, tip: 'Each field\'s own local distortion, independent of the global warp' }),

  PRM('hue', 'Hue shift', 'color', 0, { min: -180, max: 180, step: 1, fmt: 'deg', tip: 'Rotates the whole palette around the hue circle' }),
  PRM('chroma', 'Chroma', 'color', .5, { tip: 'Colour intensity, concentrated in the midtones so darks and lights stay clean' }),
  PRM('bright', 'Brightness', 'color', .5, { tip: 'Shifts the lightness of every palette colour' }),
  PRM('hueVar', 'Hue variation', 'color', .15, { tip: 'Small, controlled hue drift per field, keeping the palette identity' }),
  PRM('contrast', 'Tonal contrast', 'color', .5, { tip: 'S-curve around the midtones' }),
  PRM('highlight', 'Highlights', 'color', .5, { tip: 'Intensity of the luminous zones' }),
  PRM('shadow', 'Shadow depth', 'color', .5, { tip: 'How deep the shadows fall: lifted haze ↔ near-black' }),
  PRM('interp', 'Interpolation', 'color', 'chroma', { kind: 'select', adv: true, options: { chroma: 'OKLCh · chroma-preserving', oklab: 'OKLab · perceptual', linear: 'Linear light' }, tip: 'Colour space in which gradients and fields are mixed' }),
  PRM('transition', 'Transition chroma', 'color', .8, { adv: true, tip: 'How much chroma survives between two saturated colours (avoids muddy mixes)' }),
  PRM('shadowTint', 'Shadow tint', 'color', .35, { adv: true, tip: 'Pulls the shadows toward the deep shadow colour' }),
  PRM('rolloff', 'Highlight roll-off', 'color', .5, { adv: true, tip: 'Hard highlights ↔ long, soft roll-off that never hits flat white' }),
  PRM('localContrast', 'Local contrast', 'color', .15, { adv: true, tip: 'Large-radius local contrast: separates colour masses from their surroundings' }),
  PRM('lS', 'Luma · shadows', 'color', .5, { adv: true }), PRM('lM', 'Luma · mids', 'color', .5, { adv: true }), PRM('lH', 'Luma · lights', 'color', .5, { adv: true }),
  PRM('cS', 'Chroma · shadows', 'color', .5, { adv: true }), PRM('cM', 'Chroma · mids', 'color', .5, { adv: true }), PRM('cH', 'Chroma · lights', 'color', .5, { adv: true }),

  PRM('glow', 'Glow', 'fx', .3, { tip: 'Localised glow around the luminous structures (light pools, additive fields)' }),
  PRM('bloom', 'Bloom', 'fx', .2, { tip: 'Wide bloom from every area above the bloom threshold' }),
  PRM('irid', 'Iridescence', 'fx', 0, { tip: 'Hue shifts driven by an underlying field: pearl, oil slick, holographic foil' }),
  PRM('ca', 'Chromatic aberration', 'fx', 0, { tip: 'Red and blue channels displaced from green: RGB fringing' }),
  PRM('interf', 'Interference', 'fx', 0, { tip: 'Layered wave fields that beat against each other: rings, moiré, fringes' }),
  PRM('metallic', 'Metallic', 'fx', 0, { tip: 'Folds the colour ramps into reflective, chrome-like bands' }),
  PRM('grain', 'Grain', 'fx', .2, { tip: 'Analogue-feeling grain, strongest in the midtones' }),
  PRM('dither', 'Dither', 'fx', 0, { tip: 'Ordered dithering at reduced bit depth' }),
  PRM('poster', 'Posterization', 'fx', 0, { tip: 'Fewer levels per channel' }),
  PRM('banding', 'Color banding', 'fx', 0, { tip: 'Soft luminance terraces, like a 16-bit gradient' }),
  PRM('glowRadius', 'Glow radius', 'fx', .35, { adv: true }), PRM('glowThreshold', 'Glow threshold', 'fx', .25, { adv: true }),
  PRM('glowFalloff', 'Glow falloff', 'fx', .4, { adv: true, tip: 'Tight core ↔ long tail' }),
  PRM('bloomRadius', 'Bloom radius', 'fx', .5, { adv: true }), PRM('bloomThreshold', 'Bloom threshold', 'fx', .55, { adv: true }),
  PRM('caMode', 'Aberration', 'fx', 'radial', { kind: 'select', adv: true, options: { radial: 'Radial (lens)', linear: 'Linear (offset print)' } }),
  PRM('caAngle', 'Aberration angle', 'fx', 0, { min: -180, max: 180, step: 1, fmt: 'deg', adv: true }),
  PRM('glowOrder', 'Effect order', 'fx', 'aberrate-field', { kind: 'select', adv: true, options: { 'aberrate-field': 'Aberrate field, then glow', 'aberrate-all': 'Glow, then aberrate both' } }),
  PRM('iridFreq', 'Iridescence frequency', 'fx', .4, { adv: true }), PRM('interfFreq', 'Interference frequency', 'fx', .4, { adv: true }),
  PRM('grainSize', 'Grain size', 'fx', .3, { adv: true }), PRM('grainColor', 'Grain colour', 'fx', .25, { adv: true, tip: 'Monochrome ↔ RGB grain' }),
  PRM('grainOrder', 'Grain order', 'fx', 'before', { kind: 'select', adv: true, options: { before: 'Grain before quantize', after: 'Grain after quantize' } }),
  PRM('ditherPattern', 'Dither pattern', 'fx', 'bayer8', { kind: 'select', adv: true, options: { bayer8: 'Bayer 8×8', bayer4: 'Bayer 4×4', ign: 'Interleaved noise', lines: 'Line screen', noise: 'White noise' } }),
  PRM('ditherScale', 'Dither scale', 'fx', .15, { adv: true }),

  PRM('smooth', 'Smoothness', 'surf', .5, { tip: 'Suppresses high-frequency structure for exceptionally smooth airbrush transitions' }),
  PRM('texture', 'Texture', 'surf', .1, { tip: 'Localised surface mottling, independent of the colour field' }),
  PRM('texScale', 'Texture scale', 'surf', .5),
  PRM('detail', 'Fine detail', 'surf', .25, { tip: 'Micro structures: fine filaments, colour breakup and small interference fields' }),
  PRM('artifact', 'Digital artifacts', 'surf', 0, { tip: 'Early-digital artefacts: scanline displacement and blocky chroma' }),
];
const PMAP = Object.fromEntries(PARAMS.map(p => [p.id, p]));
const DEFAULTS = Object.fromEntries(PARAMS.map(p => [p.id, p.def]));

/* the four controls. Each runs 0–1, and 0.5 is exactly what the art direction intends: the middle of every slider is
   the behaviour the earlier versions had, and the outer halves reach well past their old ends. Each half has its own
   curve, chosen per control from the rendered result, so neither end is a dead zone or a cliff.
     Color      chroma and hue drift: grey (0) ↔ the style's colour (0.5) ↔ 4× its intensity (1)
     Structure  the composition's complexity: one dominant form and its shadows (0) ↔ the style (0.5) ↔ dense,
                many smaller forms, more pools, echoes and fine detail, a finer warp (1). Forms fade in and out with
                their own seeds, so moving it never reshuffles what is already there. It does not change segments.
     Softness   razor edges (0) ↔ the style (0.5) ↔ diffuse: wide shoulders, then a resolution-independent blur of up to
                a quarter of the short side (1). With segments it also sets the transitions between them.
     Depth      flat, lifted haze (0) ↔ the style (0.5) ↔ hard S-curve, near-black shadows, luminous light (1)
     Texture    perfectly clean: no grain, no surface mottling (0) ↔ the style (0.5) ↔ heavy, coarser grain and deep
                mottling (1). Only the surface: it never changes colour, form or tone.
   Measured before consolidating: the separate glow, texture and effects sliders changed the image by under 1–6 levels,
   while complexity/warp/count and softness/transition/blur each moved together along one visible axis. */
const LOOK = [['color', 'Color'], ['structure', 'Structure'], ['softness', 'Softness'], ['depth', 'Depth'], ['texture', 'Texture']];
const LOOK_DEFAULT = { color: .5, structure: .5, softness: .5, depth: .5, texture: .5 };
// the two halves of a control: lo runs 0 → 1 over the lower half (1 above it), up runs 0 → 1 over the upper half
const halves = v => [clamp(v * 2, 0, 1), clamp(v * 2 - 1, 0, 1)];
function lookMap(look) {
  const L = { ...LOOK_DEFAULT, ...(look || {}) };
  for (const k in LOOK_DEFAULT) L[k] = clamp(+L[k] || 0, 0, 1);
  const [cLo, cUp] = halves(L.color), [sLo, sUp] = halves(L.structure), [fLo, fUp] = halves(L.softness), [dLo, dUp] = halves(L.depth), [tLo, tUp] = halves(L.texture);
  return {
    color: cUp > 0 ? 1 + 3 * cUp ** 1.5 : cLo ** 1.4,
    sLo, sUp, dLo, dUp, fLo, fUp, tLo, tUp,
    sharp: lerp(.06, 1, fLo ** .8),                              // edge width of every field, below the style's own
    blurSig: .25 * (62 ** (fUp ** .75) - 1) / 61,                // global blur, short-side units: near-equal steps in log radius, up to a quarter
    // segments: Seamless transition as a share of the narrowest neighbour, its floor, and the Defined edge softening
    segK: fUp > 0 ? lerp(.2, .45, fUp) : lerp(.02, .2, fLo), segFloor: fUp > 0 ? .015 + .02 * fUp : lerp(.002, .015, fLo),
    segEdge: .12 * Math.max(0, (L.softness - .25) / .75) ** 2,
    // the basic gradient types: Structure adds warp (none at 0, the style's at 1) and, above the middle, mirrored
    // repeats along the palette; the lower half of Softness hardens the steps between palette colours to clean bands
    gWarp: .35 * sLo + .65 * sUp, gCycles: 1 + 2 * sUp ** 1.3, gSharp: 1 + 39 * (1 - fLo) ** 2,
  };
}
function effectiveParams(params, look) {
  const P = { ...DEFAULTS, ...params }, M = lookMap(look);
  const mul = (ids, k) => { for (const id of ids) P[id] *= k; };
  if (P.glow + P.bloom < .1) P.glow = .2;   // Depth always has light to scale
  // Structure. Counts are continuous: the last form of a fractional count fades in, so nothing pops.
  const { sLo, sUp } = M, sup0 = clamp(Math.round(P.fields) - 1, 1, 13);
  P.nSup = sUp > 0 ? sup0 + (24 - sup0) * sUp ** 1.4 : sup0 * sLo ** 1.3;
  P.echoes = sUp > 0 ? P.echoes + (3 - P.echoes) * Math.max(0, sUp - .3) / .7 : P.echoes * sLo;
  P.complexity = sUp > 0 ? lerp(P.complexity, 1, sUp) : P.complexity * sLo;
  P.detail = sUp > 0 ? lerp(P.detail, 1, sUp) : P.detail * sLo;
  P.hierarchy = lerp(1, P.hierarchy, sLo);           // below the middle the hero dominates more and more
  P.sup0 = sup0; P.supScale = lerp(1, .8, sUp);       // above it, denser means smaller forms (and the added ones smaller still)
  // the warp keeps its frequency: rescaling it would re-flow the whole image on every step. Only its strength follows,
  // gently, so simple compositions are also calmer.
  mul(['distortion', 'swirl', 'curl', 'flowWarp', 'radial', 'layerWarp'], lerp(.6, 1, sLo) * lerp(1, 1.15, sUp));
  // Softness
  const { fLo, fUp } = M;
  P.softness = clamp(P.softness * (fUp > 0 ? 1 + .8 * fUp : fLo), 0, 1);
  P.sharp = M.sharp;
  P.falloff = clamp(P.falloff + (1 - fLo) * .6 - .35 * fUp, 0, 1);    // crisp: tight cores as well as hard edges
  P.smooth = fUp > 0 ? lerp(P.smooth, 1, fUp) : P.smooth * fLo;
  // Color
  mul(['chroma', 'hueVar'], M.color);
  if (M.color > 1) P.transition = lerp(P.transition, 1, Math.min(1, M.color - 1));
  // Depth
  const { dLo, dUp } = M, du = dUp ** 1.2;
  P.contrast = dUp > 0 ? lerp(P.contrast, 1.6, du) : lerp(-.25, P.contrast, dLo);
  P.shadow = dUp > 0 ? lerp(P.shadow, 1.5, du) : lerp(0, P.shadow, dLo);
  P.highlight = dUp > 0 ? lerp(P.highlight, 1.4, du) : lerp(.1, P.highlight, dLo);
  const dk = dUp > 0 ? 1 + 2 * dUp : dLo;
  P.localContrast *= dk; mul(['glow', 'bloom'], dk);
  // Texture: below the middle every surface effect of the style fades out (grain, mottling, dither, banding,
  // posterization, digital artefacts), so 0 is perfectly clean; above it grain and mottling deepen and the grain coarsens
  const { tLo, tUp } = M;
  P.grain = tUp > 0 ? lerp(P.grain, 1.6, tUp ** 1.2) : P.grain * tLo;
  P.texture = tUp > 0 ? lerp(P.texture, 1.8, tUp) : P.texture * tLo;
  if (tUp > 0) P.grainSize = lerp(P.grainSize, .75, tUp);
  else mul(['dither', 'banding', 'poster', 'artifact'], tLo);
  return P;
}

/* ============================================================ 6. art directions — generation systems, not presets */
const D = (o) => ({ rigid: 1, rimP: .5, dens: 1, cloud: .2, baseRange: [0, .75], ...o });   // cloud: how much pools break up into nebulae   // dens: scale of the supporting fields (low = sparse clouds in darkness)
const DIRECTIONS = [
  D({ id: 'liquid-chrome', code: 'LQCH', name: 'Chrome', blurb: 'Flowing reflective bands',
    pal: { harm: { metallic: 3, complementary: 1, split: 1, synthetic: .7 }, hues: [266, 292, 302, 205, 330], chroma: [.7, 1], dark: .4, n: [5, 8] },
    base: { 0: 1, 3: 2, 2: 1 }, baseRamp: { rich: 2, dark: 1 }, baseRange: [0, .8],
    prim: { 5: 4, 13: 3, 10: 2, 7: 1.2, 1: 1 }, hero: { 5: 3, 13: 3, 10: 1 }, blend: { 0: 3, 2: 1.2, 4: 1, 1: .8, 5: .6 }, ramp: { 1: 5, 0: 2, 2: 1 },
    struct: { diagonal: 2, cascade: 1.5, field: 1.5, vortex: 1, horizon: 1 },
    p: { distortion: [.4, .75], warpFreq: [.25, .5], flowWarp: [.35, .8], curl: [.15, .45], swirl: [0, .3], metallic: [.55, .9], irid: [.08, .35], glow: [.15, .35], bloom: [.1, .3], grain: [.05, .18], softness: [.2, .45], ca: [0, .15], contrast: [.55, .75], highlight: [.55, .75], shadow: [.45, .7], fields: [4, 8], complexity: [.35, .65], echoes: [0, 2], chroma: [.45, .65], hueVar: [.05, .25], detail: [.1, .35], smooth: [.5, .8], interf: [0, .15], spread: [.45, .7] } }),
  D({ id: 'cyber-airbrush', code: 'CYAB', name: 'Airbrush', blurb: 'Large soft fields, light pools and deep shadows',
    pal: { harm: { nearblack: 2, complementary: 1.5, split: 1.5, warmcool: 1.5, synthetic: 1 }, chroma: [.85, 1], dark: .6, n: [4, 7] },
    base: { 2: 3, 1: 2, 0: 1 }, baseRamp: { dark: 2, rich: 1 }, baseRange: [0, .65], dens: .8,
    prim: { 1: 5, 2: 2, 4: 1.5, 16: 1.2, 15: .6, 10: 1 }, hero: { 1: 3, 2: 2, 16: 1, 15: .7 }, blend: { 0: 2, 1: 2, 2: 1.5, 7: 1.2 }, ramp: { 0: 6, 2: 1 },
    struct: { bloom: 2, edge: 2, corner: 1.5, constellation: 1.5, field: 1 },
    p: { softness: [.6, .95], distortion: [.1, .35], warpFreq: [.2, .45], glow: [.3, .6], bloom: [.3, .55], grain: [.1, .28], shadow: [.55, .85], highlight: [.5, .8], contrast: [.5, .7], chroma: [.55, .75], fields: [4, 8], complexity: [.3, .6], negative: [.3, .6], smooth: [.65, .9], detail: [.05, .25], hueVar: [.1, .3], falloff: [.35, .7], ca: [0, .12], localContrast: [.1, .3] } }),
  D({ id: 'holo-interference', code: 'HOLO', name: 'Holographic', blurb: 'Iridescent bands and interference',
    pal: { harm: { synthetic: 2, tetradic: 1, split: 1, metallic: 1, analogous: 1 }, hues: [205, 302, 330, 266, 132], chroma: [.75, 1], dark: .3, light: .15, n: [5, 9] },
    base: { 0: 1, 1: 2, 5: 1.5, 2: 1 }, baseRamp: { spectral: 1.5, rich: 1 }, baseRange: [0, .72],
    prim: { 9: 3, 6: 3, 7: 2, 1: 2, 3: 1.5, 10: 1 }, hero: { 9: 2, 6: 2, 3: 1.5, 14: 1 }, blend: { 2: 2.5, 4: 1.5, 8: 1, 6: 1, 0: 1.5, 1: 1 }, ramp: { 2: 4, 0: 2, 1: 1.5 },
    struct: { bloom: 2, vortex: 1.5, tunnel: 1, field: 1.5, constellation: 1 },
    p: { irid: [.5, .9], iridFreq: [.3, .7], interf: [.35, .7], interfFreq: [.25, .6], ca: [.2, .5], glow: [.2, .45], bloom: [.15, .35], distortion: [.25, .55], grain: [.05, .2], metallic: [0, .35], hueVar: [.2, .5], chroma: [.55, .75], softness: [.35, .65], fields: [4, 9], complexity: [.45, .8], detail: [.25, .55], swirl: [.05, .35] } }),
  D({ id: 'digital-plasma', code: 'PLSM', name: 'Plasma', blurb: 'Warped colour currents and hotspots',
    pal: { harm: { synthetic: 3, triadic: 1.5, complementary: 1, wild: 1 }, chroma: [.9, 1], dark: .4, n: [5, 8] },
    base: { 4: 1, 2: 2, 0: 1, 1: 1 }, baseRamp: { rich: 2, spectral: 1 }, baseRange: [0, .7], cloud: .55,
    prim: { 4: 3, 1: 2, 10: 2, 5: 2, 15: 1.2, 2: 1 }, hero: { 4: 2, 10: 2, 15: 1, 2: 1 }, blend: { 1: 2.5, 0: 2, 2: 2, 7: 1.5, 4: .8 }, ramp: { 0: 4, 2: 2, 3: 1 },
    struct: { vortex: 2, field: 2, bloom: 1.5, diagonal: 1 },
    p: { distortion: [.6, .95], warpFreq: [.35, .65], warpIter: [2, 3], curl: [.35, .8], swirl: [.1, .5], glow: [.4, .7], bloom: [.3, .55], chroma: [.6, .85], contrast: [.55, .8], grain: [.08, .22], fields: [5, 10], complexity: [.5, .85], layerWarp: [.4, .8], hueVar: [.2, .45], irid: [0, .35], detail: [.2, .5], ca: [0, .25] } }),
  D({ id: 'membranes', code: 'MEMB', name: 'Membranes', blurb: 'Overlapping translucent shapes',
    pal: { harm: { analogous: 2, split: 2, complementary: 1, triadic: 1 }, chroma: [.75, .95], dark: .35, light: .15, n: [4, 7] },
    base: { 0: 2, 1: 1, 2: 2 }, baseRamp: { rich: 2, dark: 1 }, baseRange: [0, .75], rimP: .9,
    prim: { 10: 5, 4: 3, 1: 1.2, 11: .8 }, hero: { 10: 3, 4: 1 }, blend: { 2: 4, 0: 1.5, 1: 1, 9: .6 }, heroBlend: { 0: 2, 2: 1.5 }, ramp: { 0: 4, 2: 2, 1: .8 },
    struct: { field: 2, diagonal: 1.5, bloom: 1, constellation: 1.5, edge: 1 },
    p: { softness: [.3, .6], distortion: [.3, .55], echoes: [1, 3], glow: [.2, .45], bloom: [.1, .3], irid: [0, .3], grain: [.05, .2], fields: [4, 9], complexity: [.35, .65], chroma: [.5, .7], layerWarp: [.3, .6], smooth: [.55, .85], overlap: [.5, .85] } }),
  D({ id: 'acid-optics', code: 'ACID', name: 'Acid', blurb: 'Hard, saturated warped bands',
    pal: { harm: { complementary: 2, wild: 2, triadic: 1.5, synthetic: 1.5 }, hues: [132, 124, 330, 342, 28, 205], chroma: [.92, 1], dark: .3, n: [4, 6] },
    base: { 0: 2, 6: 1.5, 3: 1 }, baseRamp: { rich: 1 }, baseRange: [0, .85],
    prim: { 7: 3, 5: 3, 6: 2, 12: 1, 1: 1.5, 9: 1 }, hero: { 7: 2, 5: 2, 6: 1.5, 1: 1 }, blend: { 0: 3, 8: 1.2, 2: 1, 3: 1, 4: 1 }, ramp: { 3: 3, 0: 2, 1: 2 },
    struct: { diagonal: 2, split: 2, vortex: 1, field: 1, cascade: 1 },
    p: { contrast: [.6, .85], chroma: [.65, .85], distortion: [.35, .7], warpFreq: [.4, .7], ca: [.25, .6], poster: [0, .3], dither: [0, .35], softness: [.1, .35], glow: [.1, .3], fields: [4, 9], flowWarp: [.3, .7], grain: [.1, .3], banding: [0, .3], interf: [0, .3], shadow: [.4, .65] } }),
  D({ id: 'synthetic-pearl', code: 'PERL', name: 'Pearl', blurb: 'Light pearlescent gradients',
    pal: { harm: { analogous: 2, split: 1.5, mono: 1.5, triadic: 1 }, hues: [302, 330, 205, 266, 356, 62], chroma: [.55, .85], dark: 0, light: .85, n: [5, 8] },
    base: { 2: 2, 0: 1.5, 1: 1.5 }, baseRamp: { light: 3, rich: .5 }, baseRange: [.1, .95], rimP: .7,
    prim: { 11: 3, 1: 3, 10: 2, 4: 1 }, hero: { 11: 2, 10: 2, 1: 1.5 }, blend: { 0: 3, 2: 2, 5: 1.5, 6: 1 }, ramp: { 0: 3, 2: 3 },
    struct: { field: 2, bloom: 1.5, diagonal: 1, edge: 1 },
    p: { irid: [.4, .75], iridFreq: [.25, .5], softness: [.6, .9], distortion: [.2, .45], shadow: [.15, .35], highlight: [.6, .85], contrast: [.3, .5], grain: [.04, .15], glow: [.1, .3], bloom: [.15, .35], chroma: [.45, .65], smooth: [.7, .95], detail: [.05, .2], metallic: [0, .3], fields: [4, 7], bright: [.5, .62], rolloff: [.55, .8] } }),
  D({ id: 'early-web', code: 'EWEB', name: 'Early Web', blurb: 'Glossy gradients, blocks and dither',
    pal: { harm: { complementary: 2, warmcool: 2, synthetic: 1.5, metallic: 1 }, hues: [258, 266, 205, 62, 28], chroma: [.85, 1], dark: .3, n: [4, 7] },
    base: { 0: 3, 3: 2, 6: 1 }, baseRamp: { rich: 1 }, baseRange: [0, .85], rigid: .6,
    prim: { 12: 3, 0: 2, 1: 2, 5: 2, 8: 1, 13: 1 }, hero: { 12: 2, 1: 2, 5: 1.5, 13: 1 }, blend: { 0: 4, 2: 1.5, 4: 1, 8: .6 }, ramp: { 1: 3, 3: 2, 0: 3 },
    struct: { split: 2, edge: 2, horizon: 2, corner: 1 },
    p: { dither: [.15, .5], ditherScale: [.1, .35], artifact: [.1, .35], poster: [.05, .3], ca: [.08, .3], banding: [.1, .35], metallic: [.2, .6], softness: [.15, .45], distortion: [.05, .3], grain: [.05, .2], contrast: [.55, .8], glow: [.1, .3], edge: [.3, .7], fields: [4, 8] } }),
  D({ id: 'chromatic-tunnel', code: 'TUNL', name: 'Tunnel', blurb: 'Concentric and spiral fields',
    pal: { harm: { synthetic: 2, split: 1.5, triadic: 1, nearblack: 1 }, chroma: [.85, 1], dark: .45, n: [5, 9] },
    base: { 1: 3, 5: 1 }, baseRamp: { rich: 2, spectral: 1 }, baseRange: [0, .7],
    prim: { 14: 2.5, 6: 3, 1: 2, 3: 1, 10: 1 }, hero: { 14: 3, 6: 2 }, blend: { 0: 2, 2: 2, 1: 1.5, 4: 1 }, ramp: { 0: 3, 2: 2, 1: 1.5, 3: 1 },
    struct: { tunnel: 4, vortex: 1.5, bloom: 1 },
    p: { swirl: [.2, .6], distortion: [.15, .45], glow: [.25, .5], bloom: [.2, .4], ca: [.15, .4], irid: [0, .4], interf: [0, .3], fields: [4, 8], complexity: [.4, .7], softness: [.35, .65], grain: [.08, .22], asymmetry: [.2, .6] } }),
  D({ id: 'typography-field', code: 'TYPO', name: 'Poster', blurb: 'A quiet area left free for type',
    pal: { harm: { analogous: 2, complementary: 1.5, nearblack: 1.5, mono: 1 }, chroma: [.8, 1], dark: .4, n: [3, 6] },
    base: { 0: 2, 2: 2, 3: 1 }, baseRamp: { dark: 2, rich: 1 }, baseRange: [0, .6], dens: .8,
    prim: { 1: 3, 5: 2, 10: 2, 0: 1.5, 4: 1 }, hero: { 1: 2, 10: 2, 5: 1.5 }, blend: { 0: 3, 2: 1.5, 1: 1 }, ramp: { 0: 5, 1: 1, 2: 1 },
    struct: { edge: 3, split: 2, corner: 2, horizon: 1.5 },
    p: { negative: [.6, .9], complexity: [.15, .4], fields: [3, 5], softness: [.55, .85], grain: [.08, .22], distortion: [.15, .45], glow: [.15, .35], bloom: [.1, .25], edge: [.1, .35], detail: [.05, .15], asymmetry: [.65, .95], hierarchy: [.65, .9] } }),
  D({ id: 'deep-space', code: 'DEEP', name: 'Space', blurb: 'Dark ground with bright colour clouds',
    pal: { harm: { nearblack: 4, complementary: 1, split: 1, synthetic: 1 }, hues: [266, 258, 292, 248], chroma: [.85, 1], dark: .85, n: [4, 7] },
    base: { 4: 3, 2: 2, 1: 1 }, baseRamp: { dark: 1 }, baseRange: [0, .42], dens: .55, cloud: .85,
    prim: { 1: 4, 4: 3, 2: 2, 15: .8, 10: 1.5 }, hero: { 4: 2, 1: 2, 2: 2, 10: 1 }, blend: { 1: 3, 2: 2.5, 0: 1.2, 7: 2 }, ramp: { 0: 5, 2: 1.5 },
    struct: { constellation: 2, bloom: 1.5, edge: 1.5, corner: 1, diagonal: 1 },
    p: { bloom: [.35, .6], glow: [.35, .65], shadow: [.65, .95], negative: [.4, .7], detail: [.2, .5], grain: [.12, .32], distortion: [.35, .7], curl: [.2, .5], contrast: [.55, .75], highlight: [.55, .8], fields: [5, 10], softness: [.5, .85], chroma: [.55, .75], localContrast: [.1, .3] } }),
  D({ id: 'overprint', code: 'OVPR', name: 'Overprint', blurb: 'Multiplied colour fields and misregistration',
    pal: { harm: { complementary: 1.5, triadic: 2, wild: 1.5 }, hues: [356, 342, 266, 205, 100, 62], chroma: [.85, 1], dark: .1, light: .35, n: [3, 5] },
    base: { 0: 2, 6: 1 }, baseRamp: { light: 2, rich: 1 }, baseRange: [.15, .9], rigid: .8,
    prim: { 12: 2.5, 1: 2, 4: 2, 7: 1.2, 0: 1.5 }, hero: { 12: 2, 1: 2, 4: 1.5 }, blend: { 3: 4, 4: 1.5, 0: 1.5, 8: .8 }, ramp: { 0: 3, 3: 2 },
    struct: { split: 2, constellation: 2, edge: 1.5, diagonal: 1 },
    p: { grain: [.35, .65], texture: [.35, .65], texScale: [.4, .7], dither: [.05, .35], poster: [.05, .3], ca: [.2, .45], caMode: 'linear', echoes: [1, 2], softness: [.15, .45], distortion: [.1, .35], contrast: [.45, .65], shadow: [.3, .5], artifact: [0, .2], fields: [3, 7] } }),
  D({ id: 'optical-waveform', code: 'WAVE', name: 'Waves', blurb: 'Curved stripes and rhythmic bands',
    pal: { harm: { complementary: 1.5, triadic: 1.5, split: 1.5, synthetic: 1.5 }, chroma: [.85, 1], dark: .4, n: [4, 7] },
    base: { 0: 2, 3: 2, 1: 1 }, baseRamp: { rich: 1 }, baseRange: [0, .75],
    prim: { 7: 4, 5: 3, 9: 2, 6: 1.5 }, hero: { 7: 3, 5: 2, 9: 1 }, blend: { 0: 3, 2: 1.5, 8: 1, 4: 1 }, ramp: { 0: 3, 3: 2, 1: 2 },
    struct: { horizon: 2, cascade: 1.5, diagonal: 1.5, field: 1.5 },
    p: { interf: [.3, .6], interfFreq: [.3, .6], distortion: [.35, .65], flowWarp: [.5, .9], warpFreq: [.3, .55], ca: [.1, .35], glow: [.1, .3], grain: [.05, .2], softness: [.2, .5], fields: [4, 9], banding: [0, .25], contrast: [.55, .75] } }),
  D({ id: 'unstable-spectrum', code: 'USPC', name: 'Spectrum', blurb: 'Shifting spectral transitions',
    pal: { harm: { tetradic: 2, triadic: 2, wild: 2, synthetic: 1.5 }, chroma: [.85, 1], dark: .3, n: [6, 10] },
    base: { 5: 2, 0: 1, 2: 1 }, baseRamp: { spectral: 3, rich: 1 }, baseRange: [0, .9],
    prim: { 11: 2, 4: 2, 3: 2, 5: 2, 10: 1.5 }, hero: { 11: 2, 3: 2, 4: 1.5 }, blend: { 0: 2, 2: 1.5, 6: 1.5, 8: 1, 4: 1 }, ramp: { 4: 4, 2: 2, 0: 1 },
    struct: { field: 2, vortex: 1.5, diagonal: 1.5, split: 1 },
    p: { irid: [.3, .6], hueVar: [.4, .75], distortion: [.5, .85], chroma: [.6, .8], transition: [.85, 1], curl: [.25, .6], glow: [.15, .4], fields: [5, 10], grain: [.05, .2], ca: [.05, .3] } }),
  D({ id: 'soft-noise', code: 'SOFT', name: 'Soft', blurb: 'Smooth large gradients',
    pal: { harm: { analogous: 2, mono: 1.5, warmcool: 1.5, split: 1 }, chroma: [.65, .9], dark: .35, light: .2, n: [3, 6] },
    base: { 2: 3, 0: 2, 1: 1 }, baseRamp: { rich: 2, light: .6 }, baseRange: [0, .85], rimP: .2,
    prim: { 1: 4, 11: 3, 0: 1, 4: 1 }, hero: { 11: 2, 1: 2 }, blend: { 0: 4, 2: 1, 5: 1 }, ramp: { 0: 6 },
    struct: { field: 3, bloom: 1, diagonal: 1, edge: 1 },
    p: { softness: [.75, 1], distortion: [.1, .3], smooth: [.75, .95], grain: [.2, .42], grainSize: [.2, .45], dither: [.08, .3], banding: [0, .2], detail: [.03, .15], glow: [.05, .2], bloom: [.05, .2], fields: [3, 6], complexity: [.15, .4], contrast: [.4, .6], ca: [0, .1] } }),
  D({ id: 'chromatic-brutalism', code: 'BRUT', name: 'Blocks', blurb: 'Hard-edged blocks and high contrast',
    pal: { harm: { complementary: 2, triadic: 1.5, wild: 2, synthetic: 1 }, chroma: [.9, 1], dark: .4, n: [3, 6] },
    base: { 0: 2, 6: 3 }, baseRamp: { rich: 1 }, baseRange: [0, .8], rigid: .3, rimP: .1,
    prim: { 12: 5, 8: 2, 0: 2, 7: 1 }, hero: { 12: 3, 8: 1, 0: 1 }, blend: { 0: 3, 3: 1.5, 8: 1.5, 2: 1, 4: 1 }, ramp: { 0: 3, 3: 2, 1: 1 },
    struct: { split: 2, edge: 2, corner: 1.5, constellation: 1.5 },
    p: { softness: [.05, .3], contrast: [.65, .9], ca: [.15, .4], caMode: 'linear', glow: [.15, .35], bloom: [.1, .3], distortion: [0, .25], layerWarp: [0, .25], grain: [.1, .3], fields: [3, 8], edge: [.4, .8], poster: [0, .25], artifact: [0, .25] } }),
];
const DIR = Object.fromEntries(DIRECTIONS.map(d => [d.id, d]));
const DIR_BY_CODE = Object.fromEntries(DIRECTIONS.map(d => [d.code, d]));

/* a hybrid invents a new direction from two: weights blend, ranges interpolate. dir id: "a+b" */
const hybridCache = {};
function getDirection(id) {
  if (DIR[id]) return DIR[id];
  if (hybridCache[id]) return hybridCache[id];
  const [ia, ib] = String(id).split('+'), A = DIR[ia] || DIRECTIONS[0], B = DIR[ib] || DIRECTIONS[1], t = .42;
  const mw = (a, b) => { const o = {}; for (const k in a) o[k] = (o[k] || 0) + a[k] * (1 - t); for (const k in b) o[k] = (o[k] || 0) + b[k] * t; return o; };
  const p = {};
  for (const k of new Set([...Object.keys(A.p), ...Object.keys(B.p)])) {
    const a = A.p[k] ?? rangeOf(k), b = B.p[k] ?? rangeOf(k);
    p[k] = typeof a === 'string' ? a : [lerp(a[0], b[0], t), lerp(a[1], b[1], t)];
  }
  const h = hybridCache[id] = {
    id, code: A.code + '+' + B.code, name: A.name + ' × ' + B.name, blurb: A.name + ' crossed with ' + B.name,
    pal: { ...A.pal, harm: mw(A.pal.harm, B.pal.harm), hues: A.pal.hues || B.pal.hues, light: lerp(A.pal.light || 0, B.pal.light || 0, t) },
    base: mw(A.base, B.base), baseRamp: mw(A.baseRamp, B.baseRamp), baseRange: [lerp(A.baseRange[0], B.baseRange[0], t), lerp(A.baseRange[1], B.baseRange[1], t)],
    prim: mw(A.prim, B.prim), hero: mw(A.hero, B.hero), blend: mw(A.blend, B.blend), ramp: mw(A.ramp, B.ramp), struct: mw(A.struct, B.struct),
    rigid: lerp(A.rigid, B.rigid, t), rimP: lerp(A.rimP, B.rimP, t), dens: lerp(A.dens, B.dens, t), cloud: lerp(A.cloud, B.cloud, t), p,
  };
  return h;
}
function rangeOf(k) { const d = PMAP[k].def; return typeof d === 'string' ? d : [d, d]; }
function dirFromCode(code) {
  const [a, b] = code.toUpperCase().split('+');
  if (!DIR_BY_CODE[a]) return null;
  if (!b) return DIR_BY_CODE[a].id;
  return DIR_BY_CODE[b] ? DIR_BY_CODE[a].id + '+' + DIR_BY_CODE[b].id : null;
}
function pickDirection(r, hybridP = .22) {
  const a = pick(r, DIRECTIONS);
  if (r() < hybridP) { let b = pick(r, DIRECTIONS); if (b === a) b = DIRECTIONS[(DIRECTIONS.indexOf(a) + 5) % DIRECTIONS.length]; return a.id + '+' + b.id; }
  return a.id;
}
/* the slider values a direction intends — each parameter draws from its own stream */
function directionParams(dirId, styleSeed) {
  const d = getDirection(dirId), out = {};
  for (const P of PARAMS) {
    const rr = d.p[P.id];
    if (rr == null) { out[P.id] = P.def; continue; }
    if (typeof rr === 'string') { out[P.id] = rr; continue; }
    const v = R(stream(styleSeed, 'param', P.id), rr[0], rr[1]);
    out[P.id] = P.int ? Math.round(v) : +v.toFixed(3);
  }
  return out;
}
/* Randomize: every parameter anywhere in its range, effects biased toward restraint */
const SPARSE = new Set(['irid', 'ca', 'interf', 'metallic', 'dither', 'poster', 'banding', 'artifact', 'texture', 'radial', 'swirl']);
function randomParams(seed) {
  const out = {};
  for (const P of PARAMS) {
    const r = stream(seed, 'rnd', P.id);
    if (P.kind === 'select') { out[P.id] = pick(r, Object.keys(P.options)); continue; }
    if (P.id === 'hue' || P.id === 'caAngle') { out[P.id] = P.id === 'hue' ? 0 : Math.round(R(r, -180, 180)); continue; }
    let v;
    if (SPARSE.has(P.id)) v = r() < .55 ? 0 : P.min + (P.max - P.min) * r() ** 1.4 * .85;
    else if (/^[lc][SMH]$/.test(P.id)) v = .5 + (r() - .5) * .4;
    else v = P.min + (P.max - P.min) * (.1 + .8 * r());
    out[P.id] = P.int ? Math.round(v) : +v.toFixed(3);
  }
  out.chroma = R(stream(seed, 'rnd', 'chroma2'), .45, .8);
  return out;
}

/* ============================================================ 7. composition — a hierarchy of macro, meso and micro decisions */
const COLS = {
  hero: [['dominant', 'accent', 'highlight'], ['shadow2', 'dominant', 'accent'], ['dominant', 'support', 'highlight'], ['deep', 'dominant', 'accent'], ['support', 'dominant', 'contrast']],
  sup: [['support', 'transition'], ['dominant', 'support', 'accent'], ['shadow2', 'support'], ['transition', 'contrast'], ['dominant', 'highlight'], ['accent', 'support'], ['shadow2', 'dominant', 'support'], ['contrast', 'accent', 'highlight']],
  pool: [['accent', 'support'], ['highlight', 'accent', 'dominant'], ['accent', 'contrast', 'dominant'], ['contrast', 'accent'], ['accent', 'transition']],
  shadow: [['deep', 'shadow2'], ['deep', 'deep'], ['shadow2', 'deep']],
  edge: [['shadow2', 'dominant'], ['accent', 'support'], ['dominant', 'deep'], ['contrast', 'shadow2']],
  micro: [['highlight', 'accent'], ['support', 'contrast'], ['accent', 'highlight'], ['transition', 'highlight']],
  void: [['deep', 'shadow2'], ['shadow2', 'deep'], ['dominant', 'shadow2']],
};
function typeWeights(w, gtype) { return gtype && gtype !== 'auto' && GTYPES[gtype] ? GTYPES[gtype][1] : w; }

function mkLayer(o) {
  const { r, type, P, dir } = o, size = o.size, vec = o.gtype === 'vector';
  const L = {
    id: o.id, kind: o.kind, type, x: o.x, y: o.y, rot: o.rot, sx: size, sy: size, z: o.z,
    soft: clamp(R(r, .2, .75) * lerp(.2, 1.5, P.softness) * (P.sharp ?? 1), .002, 1.3), fall: R(r, .8, 1.25) * lerp(.55, 2.4, P.falloff),
    op: o.op, blend: o.blend, warpK: clamp(R(r, .6, 1) * dir.rigid, .05, 1), lw: vec ? 0 : P.layerWarp * R(r, .02, .1), lwf: R(r, 1.2, 3.5) / Math.max(size, .1),
    off: R(r, 0, 400), cols: o.cols, ramp: vec ? 0 : +pickW(r, dir.ramp), rr: [0, 1], phase: 0, gamma: 1, rep: 1, rim: 0, rimRole: 'highlight', glow: o.glow || 0,
    gate: 0, inv: 0, metal: 0, a: 0, b: 0, c: 0, d: 0, pts: null, hueU: r() * 2 - 1,
  };
  switch (type) {
    case T.LIN: L.sy = size * R(r, .5, 1.2); L.a = r() < .55 ? 1 : 0; L.metal = .5; break;
    case T.POOL: L.sy = size * R(r, .55, 1.15); if (!vec && r() < .35 + dir.cloud) { L.a = dir.cloud * R(r, .5, 1.3); L.b = R(r, 1.5, 4); } break;
    case T.MULTI: L.a = R(r, .3, .7); L.b = r() * TAU; L.c = R(r, .5, 1); break;
    case T.CONIC: L.a = r() < .6 ? 1 : 0; L.b = r(); L.c = R(r, 1.1, 2.2); L.soft = Math.max(L.soft, .4); break;
    case T.BLOB: L.a = R(r, 1, 2.4); L.b = R(r, .15, .45); L.c = R(r, -.6, .6); L.d = R(r, -.6, .6); if (r() < dir.rimP * .6) { L.rim = R(r, .25, .7); } break;
    case T.BAND: L.sx = size * R(r, .9, 1.6); L.sy = size * R(r, .06, .22); L.a = R(r, .1, .6); L.b = R(r, .6, 2.2); L.c = r() * TAU; L.d = R(r, -.5, .5); L.soft *= .7; if (r() < .45) L.rim = R(r, .2, .6); L.metal = 1; break;
    case T.RINGS: L.sy = size * R(r, .7, 1.3); L.a = R(r, 2.5, 9); L.b = r(); L.c = R(r, 1, 3); L.d = R(r, 1, 1.6); L.metal = .5; break;
    case T.STRIPES: L.sx = size * R(r, .8, 1.4) * (o.kind === 'micro' ? 1 : 1.55); L.sy = L.sx * R(r, .8, 1.2); L.a = R(r, 3, 12) * (o.kind === 'micro' ? 1 : 1.55); L.b = R(r, -.6, .6); L.c = R(r, .1, .6); L.d = r() * TAU; L.metal = 1; break;
    case T.FRAME: L.a = R(r, .08, .3); L.b = R(r, 0, .35); break;
    case T.INTERF: L.a = R(r, 5, 18); L.b = R(r, 1.1, 1.8); L.c = R(r, .12, .5); L.d = r() < .5 ? R(r, .2, .5) : 0; break;
    case T.MEMB: L.a = R(r, .8, 1.8); L.b = R(r, .12, .35); L.c = R(r, -.5, .5); L.rim = R(r, .45, 1) * (r() < dir.rimP ? 1 : .4); L.soft = Math.max(L.soft * .6, .05); break;
    case T.MESH: L.sx = size * R(r, 1, 1.6); L.sy = L.sx * R(r, .7, 1.2); L.a = R(r, .5, .9); L.pts = [0, 1, 2, 3].map(k => [R(r, -.9, .9) * .8 + (k % 2 ? .3 : -.3), R(r, -.9, .9) * .8 + (k > 1 ? .3 : -.3)]).flat(); L.soft = Math.max(L.soft, .5); break;
    case T.BLOCK: L.sx = size * R(r, .2, .7); L.sy = size * R(r, .15, .6); L.soft *= .12; L.a = R(r, 2, 9); L.b = R(r, .15, .5); if (r() < .6) L.rot = Math.round(L.rot / (Math.PI / 2)) * Math.PI / 2 + (r() - .5) * .08; L.warpK *= .5; break;
    case T.TUBE: { const a0 = r() * TAU; L.pts = [0, 1, 2, 3].map(k => { const t = k / 3 * 2 - 1; return [t * .95, Math.sin(a0 + t * R(r, 1.2, 2.4)) * .45]; }).flat(); L.a = R(r, .12, .32); L.c = r() < .3 ? R(r, 3, 8) : 0; L.metal = 1; if (r() < .5) L.rim = R(r, .2, .5); break; }
    case T.TUNNEL: L.a = R(r, 2, 6); L.b = Math.round(R(r, -2.4, 2.4)); L.c = r(); L.sy = size * R(r, .7, 1.2); break;
    case T.RAYS: L.a = RI(r, 5, 22); L.b = R(r, 1, 4); L.c = R(r, .2, 1.2); break;
    case T.WEDGE: L.a = R(r, .25, 1.1); L.b = R(r, 1, 2); break;
  }
  if (L.ramp === 4) { const a = R(r, 0, .55); L.rr = [a, clamp(a + R(r, .3, .7), 0, 1)]; }
  if (L.ramp === 3) L.c2 = RI(r, 3, 7);
  // periodic fields keep their geometry under the warp; otherwise they melt into marble
  if (type === T.RINGS || type === T.STRIPES || type === T.INTERF || type === T.TUNNEL || type === T.RAYS) { L.warpK *= .55; L.lw *= .4; }
  // light-adding modes belong to concentrated sources: a large additive field only washes the image out
  const big = Math.max(L.sx, L.sy);
  if ((L.blend === 1 || L.blend === 2 || L.blend === 7) && big > .3) L.op *= clamp(.3 / big, .3, 1);
  if (vec) { L.rim = 0; L.rep = 1; }
  return L;
}

function layout(st, dir, aspect) {
  const P = st.params, S = st.seeds, gt = P.gtype || st.gtype || 'auto', vec = gt === 'vector';
  const fx = aspect >= 1 ? aspect : 1, fy = aspect >= 1 ? 1 : 1 / aspect, hx = fx / 2, hy = fy / 2, hm = Math.max(hx, hy);
  const rc = stream(S.comp, 'frame');
  const structure = st.structure && st.structure !== 'auto' && STRUCTS[st.structure] ? st.structure : pickW(rc, dir.struct);
  const SD = STRUCTS[structure];
  const flowSeed = pickW(rc, SD[1]), flow = st.flow && st.flow !== 'auto' ? st.flow : flowSeed;
  const theta = (FLOW_ANGLE[flow] ?? 0) + (rc() - .5) * .35 + (flow === 'radial' || flow === 'circular' ? rc() * TAU : 0);
  let fu = SD[2](rc);
  if (st.focal) fu = [st.focal.x, st.focal.y];
  else { const k = .25 + 1.2 * P.asymmetry; fu = [clamp(.5 + (fu[0] - .5) * k, .06, .94), clamp(.5 + (fu[1] - .5) * k, .06, .94)]; }
  const toP = (u, v) => [(u - .5) * fx, (v - .5) * fy];
  const F = toP(fu[0], fu[1]);
  const u = [Math.cos(theta), Math.sin(theta)], nrm = [-u[1], u[0]];
  // negative space: opposite the focus, sized by the slider
  const vr = stream(S.comp, 'void');
  let vu = [.5 - (fu[0] - .5) * R(vr, .7, 1.3) + (vr() - .5) * .2, .5 - (fu[1] - .5) * R(vr, .7, 1.3) + (vr() - .5) * .2];
  if (Math.hypot(fu[0] - .5, fu[1] - .5) < .08) { const a = vr() * TAU; vu = [.5 + Math.cos(a) * .32, .5 + Math.sin(a) * .32]; }
  vu = [clamp(vu[0], .12, .88), clamp(vu[1], .12, .88)];
  const V = toP(vu[0], vu[1]), Rv = lerp(.06, .5, P.negative) * (structure === 'edge' || structure === 'corner' ? 1.25 : 1);
  const spreadK = lerp(.6, 1.6, P.spread), reach = lerp(1.25, .45, P.overlap) * hm, width = lerp(.7, .2, P.overlap);
  const ctx = { P, dir, gtype: gt };
  const layers = [];
  const pushVoid = (L) => {
    const dx = L.x - V[0], dy = L.y - V[1], d = Math.hypot(dx, dy);
    if (d < Rv && P.negative > .02) { const k = d > 1e-4 ? lerp(d, Rv * 1.05, .85) / d : 0; L.x = V[0] + (d > 1e-4 ? dx * k : Rv); L.y = V[1] + (d > 1e-4 ? dy * k : 0); }
  };
  const blendFor = (r, kind) => {
    if (vec) return +pickW(r, kind === 'pool' ? { 2: 3, 9: 1 } : { 0: 4, 2: 1, 3: .6, 4: .6 });
    if (kind === 'pool') return +pickW(r, { 1: 3, 2: 2, 7: 2 });
    if (kind === 'shadow' || kind === 'void') return +pickW(r, { 0: 3, 3: 1 });
    if (kind === 'micro') return +pickW(r, { 2: 2, 4: 1.5, 5: 1.5, 8: .6, 1: 1 });
    if (kind === 'hero') return dir.heroBlend ? +pickW(r, dir.heroBlend) : r() < .78 ? 0 : +pickW(r, { 2: 1, 4: 1, 5: 1, 6: .5 });
    return r() < .5 ? 0 : +pickW(r, dir.blend);
  };

  // macro · the dominant event
  {
    const r = stream(S.comp, 'hero');
    let w = typeWeights(dir.hero, gt);
    if (!vec && gt === 'auto') {
      if (structure === 'tunnel') w = { 14: 3, 6: 2 };
      else if (structure === 'horizon' && r() < .6) w = { 5: 2, 0: 1, 7: 1 };
      else if (structure === 'split' && r() < .6) w = { 0: 2, 5: 2, 12: 1 };
      else if (structure === 'corner' && r() < .5) w = { 15: 2, 1: 2, 3: 1 };
    }
    const type = +pickW(r, w), size = R(r, .6, 1.05) * spreadK * (structure === 'field' ? 1.35 : 1) * lerp(.85, 1.15, P.hierarchy);
    const L = mkLayer({ ...ctx, r, id: 'H', kind: 'hero', type, x: F[0], y: F[1], rot: theta + (r() - .5) * .5, size,
      op: R(r, .85, 1), blend: blendFor(r, 'hero'), cols: pick(r, COLS.hero), z: 2 + r() * .5, glow: R(r, 0, .25) });
    if (type === T.LIN || type === T.WEDGE) L.sx *= 1.4;
    layers.push(L);
  }
  // meso · supporting fields, placed by the structure's rule
  // the count is continuous: every field has its own stream, and the last one fades in with the fraction
  const nSup = P.nSup ?? clamp(Math.round(P.fields) - 1, 1, 13);
  for (let i = 0; i < Math.ceil(nSup); i++) {
    const r = stream(S.comp, 'sup', i);
    const extra = P.sup0 != null && i >= P.sup0 ? (i - P.sup0) / Math.max(1, 24 - P.sup0) : -1;   // fields beyond the style's own count
    let type = +pickW(r, typeWeights(dir.prim, gt));
    if (extra >= 0 && type === T.FRAME) type = T.POOL;   // added fields are small forms; a frame covers everything outside it
    const rank = Math.min(i / 12, 1.6);
    let size = (.22 + .9 * r() ** 1.6) * spreadK * dir.dens * lerp(1.05, .5, P.hierarchy) * lerp(1, .65, rank) * (P.supScale ?? 1) * (extra >= 0 ? lerp(.38, .16, extra) : 1) * (structure === 'field' ? 1.3 : 1);   // mostly medium and small, a few large
    let x, y, rot;
    const s = r() * 2 - 1, o = r() * 2 - 1, a = r() * TAU, dd = r();
    switch (structure) {
      case 'bloom': case 'tunnel': { const d = (.18 + dd * .75) * reach; x = F[0] + Math.cos(a) * d; y = F[1] + Math.sin(a) * d; rot = a; break; }
      case 'vortex': { const d = (.2 + dd * .8) * reach; x = F[0] + Math.cos(a) * d; y = F[1] + Math.sin(a) * d; rot = a + Math.PI / 2; break; }
      case 'constellation': { x = (s * .9) * hx; y = (o * .9) * hy; rot = a; break; }
      case 'corner': { const an = Math.atan2(-F[1], -F[0]) + (s * .9), d = (.25 + dd) * reach * 1.3; x = F[0] + Math.cos(an) * d; y = F[1] + Math.sin(an) * d; rot = an; break; }
      case 'horizon': case 'cascade': { x = F[0] + u[0] * s * hm * 1.1 + nrm[0] * o * .3 * width; y = F[1] + u[1] * s * hm * 1.1 + nrm[1] * o * .3 * width; rot = theta + (a - Math.PI) * .08; break; }
      case 'split': { const side = i % 2 ? 1 : -1; x = F[0] + nrm[0] * side * (.15 + dd * .6) * reach + u[0] * s * .8; y = F[1] + nrm[1] * side * (.15 + dd * .6) * reach + u[1] * s * .8; rot = theta + (a - Math.PI) * .2; break; }
      case 'edge': { const ax = Math.abs(fu[0] - .5) > Math.abs(fu[1] - .5); x = ax ? F[0] + (o * .35) * hx : s * hx; y = ax ? s * hy : F[1] + (o * .35) * hy; rot = theta + (a - Math.PI) * .3; break; }
      default: { const sb = s * (1 - .5 * P.asymmetry) + P.asymmetry * .45 * (F[0] * u[0] + F[1] * u[1] > 0 ? -1 : 1); x = F[0] + u[0] * sb * reach + nrm[0] * o * width; y = F[1] + u[1] * sb * reach + nrm[1] * o * width; rot = theta + (a - Math.PI) * .28; }
    }
    if (flow === 'radial' && structure !== 'bloom' && structure !== 'tunnel') rot = Math.atan2(y - F[1], x - F[0]);
    if (flow === 'circular' && structure !== 'vortex') rot = Math.atan2(y - F[1], x - F[0]) + Math.PI / 2;
    x = clamp(x, -hx * 1.15, hx * 1.15); y = clamp(y, -hy * 1.15, hy * 1.15);
    const L = mkLayer({ ...ctx, r, id: 'S' + i, kind: 'sup', type, x, y, rot, size, op: R(r, .4, 1) * lerp(1, .7, rank * P.hierarchy),
      blend: blendFor(r, 'sup'), cols: pick(r, COLS.sup), z: 1 + r() * 3.5, glow: r() < .2 && size < .45 ? R(r, .2, .5) : 0 });
    pushVoid(L);
    if (extra >= 0) {
      if (type === T.LIN) L.a = 1;                                                   // bounded across its axis, not a full-frame ramp
      L.op *= L.blend === 1 || L.blend === 2 || L.blend === 7 ? .45 : .85;          // many added lights would only wash out
    }
    L.op *= clamp(nSup - i, 0, 1);
    if (L.op > .002) layers.push(L);
  }
  // light pools: small concentrated hotspots
  const nPool = 1 + P.complexity * 2;
  for (let i = 0; i < 3; i++) {
    const r = stream(S.comp, 'pool', i);
    const gs = i === 0 ? R(r, .05, .25) : R(r, .25, .75) * (r() < .5 ? -1 : 1);
    const px = F[0] + u[0] * gs * reach + nrm[0] * (r() - .5) * .25, py = F[1] + u[1] * gs * reach + nrm[1] * (r() - .5) * .25;
    const type = vec ? T.POOL : +pickW(r, { 1: 4, 15: dir.prim[15] ? 1.5 : .3, 2: 1, 10: .5 });
    const L = mkLayer({ ...ctx, r, id: 'P' + i, kind: 'pool', type, x: px, y: py, rot: r() * TAU, size: R(r, .05, .2) * spreadK * (i ? .8 : 1),
      op: R(r, .5, .9), blend: blendFor(r, 'pool'), cols: pick(r, COLS.pool), z: 5 + r(), glow: 1 });
    L.fall *= 1.2; pushVoid(L);
    L.op *= clamp(nPool - i, 0, 1);
    if (L.op > .002) layers.push(L);
  }
  // shadow masses: deep colour pulling the eye back
  {
    const r0 = stream(S.style, 'shadows'), nSh = 1 + (r0() < .7 ? 1 : 0);
    for (let i = 0; i < nSh; i++) {
      const r = stream(S.comp, 'shadow', i);
      const an = Math.atan2(V[1] - F[1], V[0] - F[0]) + (i ? Math.PI * R(r, .5, 1) : (r() - .5) * .9);
      const x = clamp(F[0] + Math.cos(an) * hm * R(r, .7, 1.3), -hx * 1.2, hx * 1.2), y = clamp(F[1] + Math.sin(an) * hm * R(r, .7, 1.3), -hy * 1.2, hy * 1.2);
      const type = vec ? T.POOL : +pickW(r, { 1: 3, 4: 1, 0: 1.5 });
      layers.push(mkLayer({ ...ctx, r, id: 'D' + i, kind: 'shadow', type, x, y, rot: an, size: R(r, .6, 1.1) * spreadK, op: R(r, .6, .95), blend: blendFor(r, 'shadow'), cols: pick(r, COLS.shadow), z: r() * .8 }));
    }
  }
  // the quiet zone itself: a soft, low-detail mass where the negative space is
  if (P.negative > .3) {
    const r = stream(S.comp, 'voidmass');
    const L = mkLayer({ ...ctx, r, id: 'N', kind: 'void', type: T.POOL, x: V[0], y: V[1], rot: r() * TAU, size: Rv * R(r, 1.3, 1.8),
      op: clamp((P.negative - .3) / .6, 0, 1) * R(r, .55, .85), blend: 0, cols: pick(r, stream(S.style, 'voidcol')() < .7 ? COLS.void.slice(0, 2) : COLS.void.slice(2)), z: 4.9 });
    L.soft = Math.max(L.soft, .8); L.fall = .8; L.lw = 0;
    layers.push(L);
  }
  // edge activity: fields that hold the frame
  for (let i = 0; i < 3; i++) {
    const k = clamp(P.edge * 3 - i, 0, 1);
    if (k <= 0) break;
    const r = stream(S.comp, 'edge', i), kind = vec ? 1 : pickW(r, i === 0 ? { 0: 2, 1: 1.5, 2: 1.5 } : { 1: 2, 2: 2, 0: .5 });
    let L;
    if (+kind === 0) {           // a frame around the canvas
      L = mkLayer({ ...ctx, r, id: 'E' + i, kind: 'edge', type: T.FRAME, x: 0, y: 0, rot: (r() - .5) * .06, size: 1, op: k * R(r, .5, .85), blend: blendFor(r, 'sup'), cols: pick(r, COLS.edge), z: 1.2 + r() * 3 });
      L.sx = hx * R(r, .72, .94); L.sy = hy * R(r, .72, .94); L.a = R(r, .12, .35); L.warpK = .4;
    } else {
      const side = RI(r, 0, 3), t = r() * 2 - 1;
      const x = side < 2 ? (side ? hx : -hx) * R(r, .95, 1.15) : t * hx, y = side < 2 ? t * hy : (side === 2 ? hy : -hy) * R(r, .95, 1.15);
      const type = vec ? T.POOL : +kind === 1 ? +pickW(r, { 1: 2, 4: 1.5, 10: 1 }) : T.BAND;
      L = mkLayer({ ...ctx, r, id: 'E' + i, kind: 'edge', type, x, y, rot: side < 2 ? Math.PI / 2 + (r() - .5) * .4 : (r() - .5) * .4, size: R(r, .35, .7) * spreadK, op: k * R(r, .55, .9), blend: blendFor(r, 'sup'), cols: pick(r, COLS.edge), z: 1.2 + r() * 3 });
      if (type === T.BAND) { L.sx = Math.max(hx, hy) * 1.2; L.sy = R(r, .05, .14); }
    }
    layers.push(L);
  }
  // micro · fine interference, filaments and small waves (detail stream; Variation shifts it too)
  if (!vec) {
    const nMicro = P.complexity * 1.5 + P.detail * 3.5;
    for (let i = 0; i < 6; i++) {
      const k = clamp(nMicro - i, 0, 1);
      if (k <= 0) break;
      const r = stream(S.detail, S.v, 'micro', i);
      const type = +pickW(r, { 6: 1.2, 9: 1.2, 7: 1.5, 5: 1.5, 15: .6, 10: 1 });
      const near = r() < .7, x = near ? F[0] + (r() - .5) * .6 : (r() * 2 - 1) * hx, y = near ? F[1] + (r() - .5) * .6 : (r() * 2 - 1) * hy;
      const L = mkLayer({ ...ctx, r, id: 'M' + i, kind: 'micro', type, x, y, rot: r() * TAU, size: R(r, .08, .3), op: k * R(r, .06, .18) * lerp(.5, 1.4, P.detail), blend: blendFor(r, 'micro'), cols: pick(r, COLS.micro), z: 6 + r() });
      L.fall = Math.max(L.fall, 1.6); L.soft = Math.max(L.soft, .7);   // micro waves dissolve into their surroundings instead of reading as stamps
      if (type === T.RINGS) { L.a *= 2; L.d = R(r, .55, .9); } if (type === T.STRIPES) L.a *= 1.8; if (type === T.INTERF) { L.a *= 1.6; L.b = R(r, .55, .9); }
      pushVoid(L);
      layers.push(L);
    }
  }
  return { layers, structure, flow, theta, F, fu, V, Rv, hx, hy, fx, fy, u, nrm };
}

/* ============================================================ 7b. segments — the spatial division of the composition
   Segments say where; the gradient composition (sections 6–7, the style) says what. There is one model, not two engines:
   1 segment is the composition itself, and more segments divide the frame into regions that each render it anew.
   1. Layout: an exact binary partition of the frame. Every cut is one coordinate shared by both sides, so the segments
      cover the frame with no gaps and no overlaps by construction.
   2. Content: every segment renders the gradient composition through its own view — a centre in the composition, the
      span its longer side covers, a quarter turn and a mirror — and a colour offset that turns hues by one of the
      palette's own intervals. The renderer evaluates the composition per pixel in that view; nothing is cropped.
   3. Compositing (in the shader): each cut divides its parent's weight between its two sides with a smooth step whose
      halves sum to one, so the weights of all segments add up to exactly 1 at every pixel and nothing lies behind them.
      Seamless: the step is wide (a share of the narrowest neighbouring segment). Defined: about one pixel.
   With symmetry only the fundamental domain is partitioned; the renderer folds every pixel into it, so mirrored
   segments are the same geometry and the same field, not look-alikes. */
const GEO_DEFAULT = { layout: 'mixed', count: 1, edges: 'seamless', edits: {}, splits: [] };
const LAYOUTS = { mixed: 'Mixed', columns: 'Columns', rows: 'Rows', grid: 'Grid', golden: 'Golden', nested: 'Nested' };
const SEG_MAX = 64, MIN_SEG = .03;          // most segments; shortest side of a segment, in short-side units
const SYM_DEFAULT = { mode: 'none' };
const SYM_FIXED = { cx: .5, cy: .5, mx: 3, my: 3 };
const SYM_INDEX = { none: 0, v: 1, h: 2, vh: 3, rot: 4, modules: 5 };
const NODE_TX = 8, NODE_ROW = 128;          // texels per node and nodes per texture row (the shader uses the same numbers)
const segMemo = new Map();

// one composition model: the gradient is always the content, and the segment count says how the frame is divided
// (1 = not divided). Layout, boundaries and the per-segment edits are kept while the count is 1, so they come back.
function normGeo(g) {
  g = g || {};
  const layout = LAYOUTS[g.layout] ? g.layout : ({ split: 'mixed', golden: 'golden', grid: 'grid', nested: 'nested' })[g.pattern] || 'mixed';
  const edges = ['defined', 'soft', 'hard'].includes(g.edges) ? 'defined' : 'seamless';
  // older recipes switched between two engines: 'fields' meant undivided, 'segments' and 'rects' meant divided
  let count = clamp(Math.round(+g.count || 1), 1, SEG_MAX);
  if (g.engine === 'fields') count = 1; else if ((g.engine === 'segments' || g.engine === 'rects') && !g.count) count = 8;
  const edits = {};
  for (const [k, e] of Object.entries(g.edits || {})) {
    if (!/^r[01]{0,40}$/.test(k) || !e || typeof e !== 'object') continue;
    const o = {};
    for (const f of ['roll', 'rot']) if (e[f]) o[f] = e[f] | 0;
    if (e.type != null && e.type >= 0 && e.type <= 3) o.type = e.type | 0;   // the segment's own gradient type
    if (Object.keys(o).length) edits[k] = o;
  }
  const splits = (Array.isArray(g.splits) ? g.splits : []).filter(p => typeof p === 'string' && /^r[01]{0,40}$/.test(p)).slice(0, 64);
  return { layout, count, edges, edits, splits };
}
const isSegmented = st => normGeo(st.geo).count > 1;

// the region that is actually generated, and the transforms that copy it over the frame
function symDomain(mode, fx, fy) {
  const hx = fx / 2, hy = fy / 2;
  if (mode === 'v' || mode === 'rot') return [-hx, -hy, 0, hy];
  if (mode === 'h') return [-hx, -hy, hx, 0];
  if (mode === 'vh') return [-hx, -hy, 0, 0];
  if (mode === 'modules') return [-hx, -hy, -hx + fx / SYM_FIXED.mx, -hy + fy / SYM_FIXED.my];
  return [-hx, -hy, hx, hy];
}
function symCopies(mode, fx, fy) {
  const id = r => r, mx = r => [-r[2], r[1], -r[0], r[3]], my = r => [r[0], -r[3], r[2], -r[1]];
  if (mode === 'v') return [id, mx];
  if (mode === 'h') return [id, my];
  if (mode === 'vh') return [id, mx, my, r => mx(my(r))];
  if (mode === 'rot') return [id, r => mx(my(r))];
  if (mode === 'modules') {
    const hx = fx / 2, hy = fy / 2, mw = fx / SYM_FIXED.mx, mh = fy / SYM_FIXED.my, out = [];
    for (let j = 0; j < SYM_FIXED.my; j++) for (let i = 0; i < SYM_FIXED.mx; i++) out.push(r => {
      const lx = [r[0] + hx, r[2] + hx], ly = [r[1] + hy, r[3] + hy], ox = -hx + i * mw, oy = -hy + j * mh;
      const X = i % 2 ? [ox + mw - lx[1], ox + mw - lx[0]] : [ox + lx[0], ox + lx[1]], Y = j % 2 ? [oy + mh - ly[1], oy + mh - ly[0]] : [oy + ly[0], oy + ly[1]];
      return [X[0], Y[0], X[1], Y[1]];
    });
    return out;
  }
  return [id];
}

const mkSeg = (x0, y0, x1, y1, path) => ({ x0, y0, x1, y1, path, axis: -1, cut: 0, kids: null });
const segW = L => L.x1 - L.x0, segH = L => L.y1 - L.y0;
const canCut = (L, axis, t) => (axis ? segH(L) : segW(L)) * Math.min(t, 1 - t) >= MIN_SEG;
function cutSeg(L, axis, t) {
  const c = axis ? L.y0 + segH(L) * t : L.x0 + segW(L) * t;   // one coordinate, copied into both children
  L.axis = axis; L.cut = c;
  L.kids = axis ? [mkSeg(L.x0, L.y0, L.x1, c, L.path + '0'), mkSeg(L.x0, c, L.x1, L.y1, L.path + '1')]
    : [mkSeg(L.x0, L.y0, c, L.y1, L.path + '0'), mkSeg(c, L.y0, L.x1, L.y1, L.path + '1')];
  return L.kids;
}
function leavesOf(L, out = []) { if (L.kids) { leavesOf(L.kids[0], out); leavesOf(L.kids[1], out); } else out.push(L); return out; }
function findPath(root, path) { let L = root; for (let i = 1; i < path.length; i++) { if (!L.kids) return null; L = L.kids[+path[i]]; } return L; }

// n segments in the given layout. Every layout except Grid adds one cut per step from one random stream, so n + 1
// segments are the n-segment layout with one more cut: raising the count subdivides, it does not reshuffle.
function buildLayout(layout, seed, D, n) {
  const root = mkSeg(D[0], D[1], D[2], D[3], 'r'), r = stream(seed, 'layout', layout);
  const jit = L => .55 + .9 * stream(seed, 'jit', L.path)();
  if (layout === 'grid') {
    const rowsN = clamp(Math.round(Math.sqrt(n * segH(root) / segW(root))), 1, n), off = RI(r, 0, rowsN - 1);
    const per = Array.from({ length: rowsN }, (_, i) => Math.floor(n / rowsN) + ((i + off) % rowsN < n % rowsN ? 1 : 0));
    const even = (L, axis, k, leaf) => { if (k <= 1) { leaf(L); return; } const a = k >> 1, [x, y] = cutSeg(L, axis, a / k); even(x, axis, a, leaf); even(y, axis, k - a, leaf); };
    const rows = []; even(root, 1, rowsN, L => rows.push(L));
    rows.forEach((L, i) => even(L, 0, per[i], () => {}));
    return root;
  }
  let leaves = [root], cur = root, side = RI(r, 0, 3);
  const swap = (L) => { leaves.splice(leaves.indexOf(L), 1, ...L.kids); };
  const best = score => { let b = null, bs = 0; for (const L of leaves) { const s = score(L); if (s > bs) { bs = s; b = L; } } return b; };
  const mixed = () => {
    const L = best(l => canCut(l, 0, .35) || canCut(l, 1, .35) ? (segW(l) * segH(l)) ** .8 * jit(l) : 0);
    if (!L) return false;
    let axis = segW(L) >= segH(L) ? 0 : 1; if (r() < .22) axis = 1 - axis;
    const k = pickW(r, { free: 3, golden: 1.2, half: 1 });
    let t = k === 'half' ? .5 : k === 'golden' ? pick(r, [.382, .618]) : R(r, .28, .72);
    if (!canCut(L, axis, t)) { axis = 1 - axis; if (!canCut(L, axis, t)) t = .5; }
    cutSeg(L, axis, t); swap(L); return true;
  };
  const strip = axis => {
    const L = best(l => (axis ? segH(l) : segW(l)) * jit(l)), t = R(r, .34, .66);
    if (!L || !canCut(L, axis, t)) return mixed();
    cutSeg(L, axis, t); swap(L); return true;
  };
  const golden = () => {   // cut the larger, square-ish part off the remainder, turning round the frame
    if (!cur) return mixed();
    const axis = segW(cur) >= segH(cur) ? 0 : 1, first = side % 4 < 2, t = first ? .618 : .382;
    if (!canCut(cur, axis, t)) { cur = null; return mixed(); }
    const [a, b] = cutSeg(cur, axis, t); swap(cur); cur = first ? b : a; side++; return true;
  };
  const nested = () => {   // peel strips off the sides in turn, so the segments wrap round a core
    if (!cur) return mixed();
    const s = side % 4, axis = s % 2, len = axis ? segH(cur) : segW(cur), th = R(r, .14, .26) * Math.min(segW(cur), segH(cur));
    const t = s < 2 ? th / len : 1 - th / len;
    if (Math.min(segW(cur), segH(cur)) < 4 * MIN_SEG || !canCut(cur, axis, t)) { cur = null; return mixed(); }
    const [a, b] = cutSeg(cur, axis, t); swap(cur); cur = s < 2 ? b : a; side++; return true;
  };
  const step = { columns: () => strip(0), rows: () => strip(1), golden, nested }[layout] || mixed;
  for (let i = 1; i < n; i++) if (!step()) break;
  return root;
}
// segments the user split by hand, on top of the layout
function applySplits(root, splits, seed) {
  for (const path of splits) {
    const L = findPath(root, path); if (!L || L.kids) continue;
    const r = stream(seed, 'usersplit', path), axis = segW(L) >= segH(L) ? 0 : 1, t = R(r, .38, .62);
    if (canCut(L, axis, t)) cutSeg(L, axis, t); else if (canCut(L, 1 - axis, t)) cutSeg(L, 1 - axis, t);
  }
}
// every copy of every segment over the frame; mirrored copies of one segment that meet on a mirror axis read as one
// region (no boundary is drawn there), so they count once
function visibleSegments(leaves, mode, fx, fy) {
  const tfs = symCopies(mode, fx, fy), rects = [], owner = [];
  leaves.forEach((L, i) => { for (const t of tfs) { rects.push(t([L.x0, L.y0, L.x1, L.y1])); owner.push(i); } });
  const par = rects.map((_, i) => i), find = i => par[i] === i ? i : (par[i] = find(par[i])), eps = 1e-9;
  for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) {
    if (owner[i] !== owner[j]) continue;
    const a = rects[i], b = rects[j], ox = Math.min(a[2], b[2]) - Math.max(a[0], b[0]), oy = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
    if ((Math.abs(ox) < eps && oy > eps) || (Math.abs(oy) < eps && ox > eps)) par[find(i)] = find(j);
  }
  return { rects, owner, count: new Set(rects.map((_, i) => find(i))).size };
}
function segGeometry(st, aspect) {
  const G = normGeo(st.geo), mode = SYM_INDEX[(st.sym || {}).mode] ? st.sym.mode : 'none', seed = (st.seeds.geo ?? st.seeds.comp) >>> 0;
  const key = JSON.stringify([G.layout, G.count, G.splits, mode, seed, aspect.toFixed(5)]);
  if (segMemo.has(key)) return segMemo.get(key);
  const fx = aspect >= 1 ? aspect : 1, fy = aspect >= 1 ? 1 : 1 / aspect, D = symDomain(mode, fx, fy);
  // the count is what the viewer sees: with symmetry the fundamental layout grows until its copies reach it
  let root = null;
  for (let n = 1; n <= G.count; n++) {
    root = buildLayout(G.layout, seed, D, n);
    if (visibleSegments(leavesOf(root), mode, fx, fy).count >= G.count) break;
  }
  applySplits(root, G.splits, seed);
  const leaves = leavesOf(root), vis = visibleSegments(leaves, mode, fx, fy);
  // breadth-first: the two children of a node are stored next to each other, as the shader expects
  const nodes = [root];
  for (let i = 0; i < nodes.length; i++) { const N = nodes[i]; N.index = i; N.first = -1; if (N.kids) { N.first = nodes.length; nodes.push(...N.kids); } }
  // transition room at every cut: the extent, across the cut, of the narrowest segment that touches it
  for (const N of nodes) if (N.kids) {
    const ax = N.axis, c = N.cut, ext = L => ax ? segH(L) : segW(L);
    const lo = leavesOf(N.kids[0]).filter(L => (ax ? L.y1 : L.x1) === c), hi = leavesOf(N.kids[1]).filter(L => (ax ? L.y0 : L.x0) === c);
    N.m = Math.min(...lo.map(ext), ...hi.map(ext));
  }
  const geo = { root, nodes, leaves, rects: vis.rects, count: vis.count, mode, fx, fy, D };
  if (segMemo.size > 24) segMemo.delete(segMemo.keys().next().value);
  segMemo.set(key, geo);
  return geo;
}
// the complete tiling of the canvas as plain rectangles (mirrored copies included)
function segTiling(st, aspect) {
  const g = segGeometry(st, aspect), hx = g.fx / 2, hy = g.fy / 2;
  const rects = g.rects.map(r => [Math.max(r[0], -hx), Math.max(r[1], -hy), Math.min(r[2], hx), Math.min(r[3], hy)]).filter(q => q[2] - q[0] > 1e-12 && q[3] - q[1] > 1e-12);
  return { rects, frame: [g.fx, g.fy], visible: g.count, leaves: g.leaves.length };
}
// proof that a tiling is a partition: total area equals the frame and no two rectangles overlap
function validateTiling(st, aspect) {
  const { rects, frame, visible } = segTiling(st, aspect), A = frame[0] * frame[1];
  let sum = 0, overlaps = 0, outside = 0, degenerate = 0;
  const eps = 1e-9 * Math.max(frame[0], frame[1]);
  for (const r of rects) { sum += (r[2] - r[0]) * (r[3] - r[1]); if (r[0] < -frame[0] / 2 - eps || r[2] > frame[0] / 2 + eps || r[1] < -frame[1] / 2 - eps || r[3] > frame[1] / 2 + eps) outside++; if (r[2] - r[0] <= 0 || r[3] - r[1] <= 0) degenerate++; }
  const s = rects.slice().sort((a, b) => a[0] - b[0]);
  for (let i = 0; i < s.length; i++) for (let j = i + 1; j < s.length && s[j][0] < s[i][2] - eps; j++) {
    const ox = Math.min(s[i][2], s[j][2]) - Math.max(s[i][0], s[j][0]), oy = Math.min(s[i][3], s[j][3]) - Math.max(s[i][1], s[j][1]);
    if (ox > eps && oy > eps) overlaps++;
  }
  return { rects: rects.length, visible, areaError: Math.abs(sum - A) / A, overlaps, outside, degenerate, valid: Math.abs(sum - A) / A < 1e-9 && !overlaps && !outside && !degenerate };
}
// the segment under a point of the image (u, v in 0–1): its path and the rectangle of that copy, in u, v
function segAt(st, aspect, u, v) {
  const g = segGeometry(st, aspect), h = [g.fx / 2, g.fy / 2];
  let p = [(u - .5) * g.fx, (v - .5) * g.fy], unf;
  if (g.mode === 'modules') {   // the same fold as the shader's
    const ms = [g.fx / SYM_FIXED.mx, g.fy / SYM_FIXED.my], n = [SYM_FIXED.mx, SYM_FIXED.my], P = [p[0] + h[0], p[1] + h[1]], s = [1, 1], off = [0, 0];
    for (const k of [0, 1]) { const i = clamp(Math.floor(P[k] / ms[k]), 0, n[k] - 1), odd = i & 1; s[k] = 1 - 2 * odd; off[k] = -i * ms[k] * s[k] + odd * ms[k]; }
    p = [s[0] * P[0] + off[0] - h[0], s[1] * P[1] + off[1] - h[1]];
    unf = q => [s[0] * (q[0] + h[0] - off[0]) - h[0], s[1] * (q[1] + h[1] - off[1]) - h[1]];
  } else {
    const m = g.mode, s = [(m === 'v' || m === 'vh' || m === 'rot') && p[0] > 0 ? -1 : 1, ((m === 'h' || m === 'vh') && p[1] > 0) || (m === 'rot' && p[0] > 0) ? -1 : 1];
    p = [p[0] * s[0], p[1] * s[1]]; unf = q => [q[0] * s[0], q[1] * s[1]];
  }
  let L = g.root;
  while (L.kids) L = L.kids[(L.axis ? p[1] : p[0]) >= L.cut ? 1 : 0];
  const a = unf([L.x0, L.y0]), b = unf([L.x1, L.y1]);
  const uv = q => [q[0] / g.fx + .5, q[1] / g.fy + .5], A = uv([Math.min(a[0], b[0]), Math.min(a[1], b[1])]), B = uv([Math.max(a[0], b[0]), Math.max(a[1], b[1])]);
  return { path: L.path, rect: [A[0], A[1], B[0], B[1]] };
}
/* the basic gradient types. Each has its own field t ∈ [0, 1] (evaluated in the shader by typedT), read along the palette:
     Linear   t runs along a direction, from one side of the region to the other
     Radial   t is the elliptical distance from a centre: rings
     Diamond  t is the Manhattan distance from a centre: |dx|/rx + |dy|/ry, a diamond, never a circle
   The radii are set so t reaches 1 exactly at the farthest corner of the region (the frame, or a segment). */
const GRADIENTS = { fields: 'Fields', linear: 'Linear', radial: 'Radial', diamond: 'Diamond' };
const GRAD_INDEX = { fields: 0, linear: 1, radial: 2, diamond: 3 };
function gradFrame(type, c, ang, ratio, rect) {
  const [x0, y0, x1, y1] = rect, cs = Math.cos(ang), sn = Math.sin(ang);
  if (type === 1) return { c: [(x0 + x1) / 2, (y0 + y1) / 2], rr: [.5 * (Math.abs(cs) * (x1 - x0) + Math.abs(sn) * (y1 - y0)), 1] };
  let R0 = 1e-6;
  for (const [x, y] of [[x0, y0], [x1, y0], [x0, y1], [x1, y1]]) {
    const dx = (x - c[0]) * cs + (y - c[1]) * sn, dy = -(x - c[0]) * sn + (y - c[1]) * cs;
    R0 = Math.max(R0, type === 2 ? Math.hypot(dx / ratio, dy) : Math.abs(dx) / ratio + Math.abs(dy));
  }
  return { c, rr: [ratio * R0, R0] };
}
// the content of every segment: a view of the field composition (centre, span, quarter turn, mirror) and, for the basic
// types, the segment's own gradient — its type (the chosen one unless the segment overrides it), direction, centre, radii
// and direction of travel along the palette. Colours come only from the palette: neighbouring segments travel it in
// opposite directions, so they read as separate regions without inventing colours.
// Each segment draws from its own streams (keyed by its path), so editing one leaves every other one as it was.
function packSegments(geo, st, P, lay, gt) {
  const { nodes } = geo, rows = Math.ceil(nodes.length / NODE_ROW), data = new Float32Array(NODE_ROW * NODE_TX * 4 * rows);
  const S = st.seeds, G = normGeo(st.geo), va = S.v ? P.varAmt : 0, types = {};
  nodes.forEach((n, i) => {
    const o = (Math.floor(i / NODE_ROW) * NODE_ROW * NODE_TX + (i % NODE_ROW) * NODE_TX) * 4;
    data.set([n.x0, n.y0, n.x1, n.y1, n.kids ? n.axis : -1, n.cut, n.m || 0, n.first], o);
    if (n.kids) return;
    const e = G.edits[n.path] || {}, r = stream(S.comp, 'segview', n.path, e.roll | 0), rv = stream(S.comp, S.v, 'segvar', n.path);
    // the view: a centre in the composition (drawn toward its focus), the span the segment's longer side covers,
    // a quarter turn and a mirror. Variation moves it a little.
    const cx = lerp(R(r, -.85, .85) * lay.hx, lay.F[0], .3) + (rv() - .5) * .25 * va, cy = lerp(R(r, -.85, .85) * lay.hy, lay.F[1], .3) + (rv() - .5) * .25 * va;
    const span = R(r, .45, 1.05) * (1 + (rv() - .5) * .2 * va), mirror = r() < .3 ? -1 : 1;
    const turn = (RI(r, 0, 3) + (e.rot | 0)) * Math.PI / 2 + (r() - .5) * .3 + (rv() - .5) * .4 * va;
    // the segment's own gradient
    const type = e.type != null ? e.type : gt, rg = stream(S.comp, 'seggrad', n.path, e.roll | 0), parity = n.path.split('1').length & 1;
    const ang = lay.theta + pick(rg, [0, 0, Math.PI / 2, Math.PI]) + (rg() - .5) * .5 + (e.rot | 0) * Math.PI / 2 + (rv() - .5) * .4 * va;
    const w = n.x1 - n.x0, h = n.y1 - n.y0, c0 = [n.x0 + R(rg, .25, .75) * w, n.y0 + R(rg, .25, .75) * h], ratio = R(rg, .7, 1.4);
    const fr = gradFrame(type, c0, ang, ratio, [n.x0, n.y0, n.x1, n.y1]), rev = parity ^ (rg() < .25 ? 1 : 0);
    types[n.path] = type;
    data.set([cx, cy, span, turn, mirror, 0, 0, 0, type, ang, fr.c[0], fr.c[1], fr.rr[0], fr.rr[1], rev, 0], o + 8);
  });
  return { data, rows, types };
}

/* ============================================================ 8. compile: state → GPU scene */
const LT = 12, MAXL = 64;
const BASE_TYPE = { linear: 0, radial: 1, airbrush: 2, horizon: 3, deep: 4, conic: 5, split: 6 };
// the palette reaches the renderer exactly as the editor shows it: no hue turn or brightness shift on the way
function adjustPalette(pal) {
  return pal.map(s => gamutClamp(hex2ok(s.hex)));
}
function hashF32(arr) { let h = 2166136261; const u = new Uint32Array(arr.buffer, arr.byteOffset, arr.length); for (let i = 0; i < u.length; i++) h = Math.imul(h ^ u[i], 16777619); return (h >>> 0).toString(36); }

function compile(st, aspect, opts = {}) {
  const dir = getDirection(st.dir), P = effectiveParams(st.params, st.look), S = st.seeds, LM = lookMap(st.look);  const stx = { ...st, params: P };
  const pal = st.palette.length ? st.palette : [{ hex: '#000000', pos: 0 }, { hex: '#ffffff', pos: 1 }];
  const okPal = adjustPalette(pal), strict = isStrict(st), roles = identifyRoles(pal, st.roleSeed || 0);
  const roleCol = (name) => okPal[roles[name] ?? 0];
  const lay = layout(stx, dir, aspect);
  let layers = lay.layers;
  const { fx, fy } = lay;
  const fromUV = (u, v) => [(u - .5) * fx, (v - .5) * fy];

  // Variation: a related version — every layer shifts within its own stream
  if (S.v) {
    const amt = P.varAmt;
    for (const L of layers) {
      const rv = stream(S.comp, S.v, 'var', L.id), sz = Math.min(.6, Math.max(L.sx, L.sy));
      L.x += (rv() - .5) * .5 * amt * (.25 + sz); L.y += (rv() - .5) * .5 * amt * (.25 + sz);
      L.rot += (rv() - .5) * 1.1 * amt; const ks = Math.exp((rv() - .5) * .6 * amt); L.sx *= ks; L.sy *= ks;
      L.phase += (rv() - .5) * .3 * amt; L.off += (rv() - .5) * 3 * amt; L.hueU = clamp(L.hueU + (rv() - .5) * 1.2 * amt, -1, 1);
      if (rv() < .35 * amt) L.cols = [...L.cols].reverse();
      if (rv() < .2 * amt && L.kind === 'sup') L.cols = pick(rv, COLS.sup);
      L.op = clamp(L.op * (1 + (rv() - .5) * .3 * amt), 0, 1);
    }
  }
  // user edits, duplicates, locked (pinned) layers, ordering
  const ed = st.edits || {};
  for (const d of st.dups || []) { const src = layers.find(l => l.id === d.src); if (src) { const c = JSON.parse(JSON.stringify(src)); c.id = d.id; c.kind = 'dup'; c.z = src.z + .005; const p = fromUV(...d.uv); c.x = p[0]; c.y = p[1]; layers.push(c); } }
  for (const pn of st.pinned || []) { const c = JSON.parse(JSON.stringify(pn)); const p = fromUV(...pn.uv); c.x = p[0]; c.y = p[1]; c.kind = 'pin'; layers.push(c); }
  // echo layers: translucent offset copies behind the hero and the first fields
  if (P.echoes > 0) {
    const ech = [];
    for (const L of layers) {
      if (!(L.kind === 'hero' || (L.kind === 'sup' && +L.id.slice(1) < 6))) continue;
      const r = stream(S.comp, 'echo', L.id), step = R(r, .03, .07) * (1 + Math.max(L.sx, L.sy)), side = (r() - .5) * .6;
      for (let k = 1; k <= Math.ceil(P.echoes); k++) {   // a fractional count fades its last echo in
        const c = { ...L, id: L.id + 'e' + k, kind: 'echo', z: L.z - .01 * k, glow: 0, op: L.op * .55 ** k * clamp(P.echoes - k + 1, 0, 1), rim: L.rim * .6 };
        c.x += (lay.u[0] + lay.nrm[0] * side) * step * k; c.y += (lay.u[1] + lay.nrm[1] * side) * step * k;
        c.sx *= 1 + .07 * k; c.sy *= 1 + .07 * k; c.phase += .06 * k; c.off += 1.7 * k;
        if (r() < .35) c.cols = [...L.cols].reverse();
        ech.push(c);
      }
    }
    layers = layers.concat(ech);
  }
  for (const L of layers) {
    const e = ed[L.id]; if (!e) continue;
    if (e.uv) { const p = fromUV(...e.uv); L.x = p[0]; L.y = p[1]; }
    if (e.rot != null) L.rot = e.rot; if (e.scale != null) { L.sx *= e.scale; L.sy *= e.scale; }
    if (e.op != null) L.op = e.op; if (e.blend != null) L.blend = e.blend; if (e.z != null) L.z = e.z;
    if (e.pts) L.pts = e.pts.slice(); if (e.hidden) L.hidden = true; if (e.locked) L.locked = true;
  }
  layers.sort((a, b) => a.z - b.z);
  const all = layers;
  const visible = all.filter(l => !l.hidden && l.op > .002).slice(0, MAXL);

  // pack: 12 RGBA32F texels per layer
  const data = new Float32Array(MAXL * LT * 4);
  // per-field hue drift keeps palette colours recognisable: at most 14°, and 5° while a palette family is chosen
  const hueAmt = Math.min(P.hueVar * 42, strict ? 5 : 14);
  visible.forEach((L, i) => {
    const o = i * LT * 4, drift = L.hueU * hueAmt;
    const col = k => rotHue(roleCol(L.cols[Math.min(k, L.cols.length - 1)]), drift);
    const ncol = L.type === T.MESH ? 4 : Math.min(3, L.cols.length);
    const cA = L.ramp === 4 ? [L.rr[0], L.rr[1], 0] : col(0), cB = col(1), cC = col(2);
    const cD = L.type === T.MESH ? col(3 % L.cols.length) : rotHue(roleCol(L.rimRole), drift * .5);
    const pts = L.pts || [0, 0, 0, 0, 0, 0, 0, 0];
    data.set([L.type, L.x, L.y, L.rot, Math.max(L.sx, 1e-3), Math.max(L.sy, 1e-3), L.soft, L.fall, clamp(L.op, 0, 1), L.blend, L.warpK, L.lw,
      ...cA, L.ramp, ...cB, ncol, ...cC, L.phase, L.a, L.b, L.c, L.d, L.gamma, L.rep, L.rim, L.glow,
      L.lwf, L.off, L.gate, L.inv, pts[0], pts[1], pts[2], pts[3], pts[4], pts[5], pts[6], pts[7], ...cD, L.metal + (L.ramp === 3 ? (L.c2 || 4) * 10 : 0)], o);
  });

  // base field: macro colour mass beneath everything
  const rb = stream(S.style, 'base'), rbc = stream(S.comp, 'base');
  const btype = +pickW(rb, typeWeights(dir.base, null)), brName = pickW(rb, dir.baseRamp);
  const bt0 = clamp(dir.baseRange[0] + (rb() - .5) * .08, 0, 1), bt1 = clamp(dir.baseRange[1] + (rb() - .5) * .12, bt0 + .1, 1);
  const vecBase = P.gtype === 'vector' ? (btype === 1 ? 1 : 0) : btype;
  const bAng = lay.theta + Math.PI / 2 * (rbc() < .5 ? 1 : 0) + (rbc() - .5) * 1.2;
  const bRx = R(rbc, .6, 1.2) * Math.max(lay.hx, lay.hy), bRy = bRx * R(rbc, .6, 1.2);
  const bCenter = vecBase === 2 || vecBase === 1 ? [lay.F[0] + (rbc() - .5) * .3, lay.F[1] + (rbc() - .5) * .3] : [(rbc() - .5) * .4, (rbc() - .5) * .4];
  const baseCols = brName === 'dark' ? ['deep', 'shadow2', 'dominant'] : brName === 'light' ? ['support', 'transition', 'highlight'] : ['deep', 'shadow2', 'dominant', 'support'];
  const baseRampCols = baseCols.map(roleCol);
  // master ramp: the palette in stop order
  const order = pal.map((s, i) => ({ i, pos: s.pos ?? i / Math.max(1, pal.length - 1) })).sort((a, b) => a.pos - b.pos);
  const ramp = new Float32Array(30), rampP = new Float32Array(10);
  order.slice(0, 10).forEach((o, k) => { ramp.set(okPal[o.i], k * 3); rampP[k] = o.pos; });
  const baseC = new Float32Array(18); baseRampCols.forEach((c, k) => baseC.set(c, k * 3));

  // warp and global fields
  const rw = stream(S.comp, 'warp'), rd = stream(S.detail, 'warp'), rvw = stream(S.comp, S.v, 'varwarp');
  const va = S.v ? P.varAmt : 0;
  const wf = lerp(.45, 2.8, P.warpFreq), wAmp = P.distortion * .3 / Math.sqrt(Math.max(wf, .5));   // finer warps displace less, so structure survives
  const swirlC = lay.structure === 'vortex' ? 1.2 : 0;
  const ri = stream(S.comp, 'interf');
  const ifs = new Float32Array(12);
  for (let k = 0; k < 3; k++) { const a = ri() * TAU, d = R(ri, .05, .5); ifs.set([lay.F[0] + Math.cos(a) * d, lay.F[1] + Math.sin(a) * d, 1 + (ri() - .5) * .12, ri()], k * 4); }
  const transparent = !!opts.transparent;
  // segments and symmetry
  const gt = GRAD_INDEX[st.gradient] || 0;
  // the basic gradient type over the whole frame: along the composition's flow, centred on its focus
  const rgG = stream(S.comp, 'grad'), vg = stream(S.comp, S.v, 'gradvar'), gva = S.v ? P.varAmt : 0;   // Variation turns and moves it a little
  const gAng = lay.theta + (rgG() - .5) * .4 + (vg() - .5) * .6 * gva, gRatio = R(rgG, .75, 1.35), gRev = rgG() < .5 ? 1 : 0;
  const gFr = gradFrame(Math.max(gt, 1), [lay.F[0] + (vg() - .5) * .2 * gva, lay.F[1] + (vg() - .5) * .2 * gva], gAng, gRatio, [-lay.hx, -lay.hy, lay.hx, lay.hy]);
  const GEO = normGeo(st.geo), SYM = { ...SYM_DEFAULT, ...st.sym, ...SYM_FIXED }, segMode = GEO.count > 1;
  const symIdx = SYM_INDEX[SYM.mode] || 0;
  let seg = null, sgeo = null;
  if (segMode) { sgeo = segGeometry(st, aspect); seg = packSegments(sgeo, st, P, lay, gt); }
  // Defined segments keep their edges: the effects that spread light or colour across a boundary (glow, bloom, local
  // contrast, aberration, global blur) are off for them. Everything inside the composition stays on.
  const whole = segMode && GEO.edges === 'defined' ? 0 : 1;
  const field = {
    uRamp: ramp, uRampP: rampP, uRampN: Math.min(10, order.length), uBC: baseC, uBN: baseRampCols.length,
    uB0: [vecBase, bAng, bCenter[0], bCenter[1]], uB1: [bRx, R(rb, 2, 7), R(rb, .8, 1.35), bt0],
    uB2: [bt1, R(rbc, .4, .9), lay.V[0], lay.V[1]], uB3: [brName === 'spectral' ? 1 : 0, R(rb, .35, .9), P.gtype === 'vector' ? 0 : R(rb, .04, .18), R(rb, 0, 300)],
    uW0: [wAmp, wf, P.warpIter >= 2 ? wAmp * .3 : 0, wf * R(rd, 2.1, 2.8)],
    uW1: [(P.swirl * 3.2 + swirlC * (P.swirl > 0 || lay.structure === 'vortex' ? 1 : 0)) * (rw() < .5 ? 1 : -1), lay.F[0], lay.F[1], R(rw, .35, .8) * Math.max(lay.hx, lay.hy)],
    uW2: [lay.theta, P.flowWarp * .22, P.curl * .14, P.radial * .22],
    uW3: [P.octaves, P.warpIter, R(rw, 0, 200) + (rvw() - .5) * 1.2 * va, R(rw, 0, 200) + (rvw() - .5) * 1.2 * va],
    uW4: [lerp(.62, .36, P.smooth), 0, R(rd, 0, 200) + (rvw() - .5) * 2 * va, R(rd, 0, 200)],
    uIr: [strict ? 0 : P.irid, lerp(.6, 4, P.iridFreq), st.harmony === 'metallic' ? Math.max(P.metallic, .7) : P.metallic, R(rd, 0, 100)],
    uIf0: [P.interf, lerp(8, 70, P.interfFreq), 3, 0], uIf1: [lay.F[0], lay.F[1], R(ri, .5, 1.1), R(ri, .3, .7)], uIfS: ifs,
    uMi: [P.detail, P.smooth, R(stream(S.detail, S.v, 'micro'), 0, 300), 0],
    uMx: [P.interp === 'chroma' ? P.transition : 0, P.interp === 'linear' ? 1 : 0, transparent ? 1 : 0, strict ? 1 : 0],   // w: strict, no hue twists of the style's own
    uN: visible.length,
    // segments on, defined, Seamless transition (share of the narrowest neighbour), Defined edge softening (same unit)
    uSegM: [segMode ? 1 : 0, GEO.edges === 'defined' ? 1 : 0, LM.segK, LM.segEdge], uSegM2: [LM.segFloor, 0, 0, 0],
    uGT: [gt, gAng, gFr.c[0], gFr.c[1]], uGT2: [gFr.rr[0], gFr.rr[1], gRev, LM.gCycles], uGT3: [LM.gWarp, LM.gSharp, 0, 0],
    uSym: [symIdx, SYM.cx, SYM.cy, SYM.mx], uSym2: [SYM.my, 0, 0, 0],
  };
  const fieldKey = JSON.stringify(field, (k, v) => v instanceof Float32Array ? Array.from(v) : v) + hashF32(data) + (seg ? hashF32(seg.data) : '');
  const low = {
    glowSig: lerp(.004, .045, P.glowRadius), bloomSig: lerp(.03, .2, P.bloomRadius), lcSig: .05,
    glowThr: [lerp(0, .9, P.glowThreshold), .15], bloomThr: [lerp(.15, 1.4, P.bloomThreshold), .25],
  };
  const lowKey = JSON.stringify(low);
  const deep = roleCol('deep');
  const ditherIdx = ['bayer8', 'bayer4', 'ign', 'lines', 'noise'].indexOf(P.ditherPattern);
  const post = {
    uCA: [P.ca * .009 * whole * (strict ? 0 : 1), P.caMode === 'linear' ? 1 : 0, P.caAngle * Math.PI / 180, P.glowOrder === 'aberrate-all' ? 1 : 0],
    uGlw: [P.glow * 1.1 * whole, P.bloom * .8 * whole, P.localContrast * 1.2 * whole, P.glowFalloff],
    uTn: [(P.contrast - .5) * 2, (P.shadow - .5) * 2, (P.highlight - .5) * 2, P.chroma * 2],
    uTn2: [P.shadowTint, lerp(.96, .62, P.rolloff), transparent ? 1 : 0, Math.min(1, LM.color * 4)],
    uDeep: deep,
    uLC: [(P.lS - .5) * 2, (P.lM - .5) * 2, (P.lH - .5) * 2, 0], uCC: [(P.cS - .5) * 2, (P.cM - .5) * 2, (P.cH - .5) * 2, 0],
    uGr: [P.grain, lerp(1 / 3400, 1 / 700, P.grainSize), Math.min(P.grainColor, .4), P.grainOrder === 'after' ? 1 : 0],   // grain size: share of the short side
    uTx: [P.texture, lerp(320, 90, P.texScale), P.smooth, (S.detail % 997) + .5],                                         // paper tooth: cycles per short side
    uQz: [P.poster > 0 ? Math.round(lerp(48, 3, P.poster ** .7)) : 0, P.dither, lerp(1 / 3200, 1 / 240, P.ditherScale), Math.max(0, ditherIdx)],
    uBn: [P.banding, P.artifact, 1 / 110, (S.detail % 991) + .5],
    uSym: field.uSym, uSym2: field.uSym2,
  };
  if (symIdx) post.uCA[1] = 0;   // a linear offset would break the mirror; radial aberration about the symmetry centre keeps it
  const marginNorm = P.ca * .009 * 1.45 * whole + P.artifact * .011 + (P.artifact > 0 ? .0075 : 0) + .002;
  const info = { direction: dir.name, directionId: dir.id, drawn: visible.length, segments: sgeo ? sgeo.count : 1, segTypes: seg ? seg.types : null, gradient: gt, symmetry: SYM.mode };
  const blurSig = LM.blurSig * whole;   // global blur, in short-side units (so preview and export agree)
  return { field, layers: data, n: visible.length, rects: seg ? seg.data : null, rectRows: seg ? seg.rows : 0, blurSig,
    fieldKey, low, lowKey, post, marginNorm, info, frame: [fx, fy] };
}

/* ============================================================ 9. seeds and recipes */
const b36 = n => (n >>> 0).toString(36).toUpperCase();
function dirCode(id) { const d = getDirection(id); return d.code; }
// geometry seed: equal to the composition seed unless the geometry was locked while the composition changed
function seedCode(st) {
  const s = st.seeds, g = s.geo ?? s.comp;
  return `${dirCode(st.dir)}.${b36(s.style)}.${b36(s.comp)}.${s.v | 0}.${b36(s.detail)}${g !== s.comp ? '~' + b36(g) : ''}`;
}
function paletteFor(dirId, styleSeed, harmony = 'auto') { return makePalette(stream(styleSeed, 'palette', harmony), harmony, getDirection(dirId).pal); }
function freshState(dirId, seeds) {
  return { dir: dirId, seeds: { ...seeds, geo: seeds.geo ?? seeds.comp }, params: directionParams(dirId, seeds.style), look: { ...LOOK_DEFAULT },
    geo: normGeo(GEO_DEFAULT), sym: { ...SYM_DEFAULT }, gradient: 'fields',
    palette: paletteFor(dirId, seeds.style), harmony: 'style', roleSeed: 0, structure: 'auto', flow: 'auto', focal: null, edits: {}, dups: [], pinned: [] };
}
function fromSeed(code) {
  const m = String(code).trim().match(/^([A-Za-z]{4}(?:\+[A-Za-z]{4})?)\.([0-9A-Za-z]{1,7})\.([0-9A-Za-z]{1,7})\.(\d{1,6})\.([0-9A-Za-z]{1,7})(?:~([0-9A-Za-z]{1,7}))?$/);
  if (!m) return null;
  const dir = dirFromCode(m[1]); if (!dir) return null;
  const n = s => parseInt(s, 36) >>> 0;
  return freshState(dir, { style: n(m[2]), comp: n(m[3]), v: +m[4], detail: n(m[5]), geo: m[6] ? n(m[6]) : n(m[3]) });
}
function encodeRecipe(st) {
  const o = { v: VERSION, d: st.dir, s: [st.seeds.style, st.seeds.comp, st.seeds.v, st.seeds.detail, st.seeds.geo ?? st.seeds.comp], p: st.params, l: st.look, gr: st.gradient,
    g: st.geo, y: st.sym, c: st.palette, h: st.harmony, rs: st.roleSeed || 0,
    st: st.structure, fl: st.flow, fo: st.focal, ed: st.edits, du: st.dups, pn: st.pinned };
  return 'chroma1:' + btoa(unescape(encodeURIComponent(JSON.stringify(o))));
}
function decodeRecipe(str) {
  const o = JSON.parse(decodeURIComponent(escape(atob(String(str).trim().replace(/^chroma\d*:/, '')))));
  if (!o || !o.s || !o.c) throw new Error('not a Chroma recipe');
  getDirection(o.d);
  return { dir: o.d, seeds: { style: o.s[0] >>> 0, comp: o.s[1] >>> 0, v: o.s[2] | 0, detail: o.s[3] >>> 0, geo: (o.s[4] ?? o.s[1]) >>> 0 }, params: { ...DEFAULTS, ...o.p },
    look: { ...LOOK_DEFAULT, ...(o.l || {}) }, geo: normGeo(o.g), gradient: GRADIENTS[o.gr] ? o.gr : 'fields',
    sym: { mode: (o.y && SYM_INDEX[o.y.mode] != null && o.y.mode) || 'none' },
    palette: o.c.map(c => ({ hex: c.hex, pos: +c.pos, lock: !!c.lock })), harmony: FAMILIES[o.h] || o.h === 'custom' ? o.h : 'style', roleSeed: o.rs || 0,
    structure: o.st || 'auto', flow: o.fl || 'auto', focal: o.fo || null, edits: o.ed || {}, dups: o.du || [], pinned: o.pn || [] };
}

G.ChromaCore = {
  VERSION, TAU, clamp, lerp, rng, stream, mix32, newSeed, pickW, pick,
  color: { hex2ok, ok2hex, lin2ok, ok2lin, lch2ok, ok2lch, maxChroma, gamutClamp, mixc, rotHue, s2l, l2s, hex2rgb, rgb2hex, lchHex, ease },
  makePalette, identifyRoles, HARMONIES, ROLE_LABEL, paletteFor,
  DIRECTIONS, getDirection, pickDirection, directionParams, randomParams,
  PARAMS, PMAP, DEFAULTS, LOOK, LOOK_DEFAULT, lookMap, effectiveParams, GTYPES, T,
  compile, LT, MAXL,
  GEO_DEFAULT, LAYOUTS, SEG_MAX, isSegmented, GRADIENTS, FAMILIES, paletteForFamily, isStrict, SYM_DEFAULT, normGeo, segGeometry, segTiling, validateTiling, segAt,
  seedCode, fromSeed, freshState, encodeRecipe, decodeRecipe,
};
})(typeof window !== 'undefined' ? window : globalThis);
