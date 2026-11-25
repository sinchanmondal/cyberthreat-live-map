/* ============================================================================
 *  CYBERTHREAT LIVE MAP — single-file React + Three.js
 *
 *  Runs as-is in the claude.ai artifact sandbox (three r128) and in a Vite +
 *  React project with the current `three`, `lucide-react` and Tailwind.
 *
 *  ThreatEngine ......... Stochastic Threat Stream Regenerator. Turns aggregated
 *                         percentage distributions into a normalized origin→target
 *                         probability matrix, then emits individual laser events
 *                         with Poisson arrivals + weighted Monte-Carlo draws.
 *  Radar client ......... Polls Cloudflare Radar every 5 min (token and/or CORS
 *                         proxy) and rebuilds the matrix; baseline weights otherwise.
 *  createGlobeScene ..... Raw Three.js. Every layer stores lat/lng and projects in
 *                         the vertex shader, so globe ⇄ flat map is a GPU morph.
 *                         Lasers, shockwaves and pillars live in fixed instanced
 *                         slots: zero allocations on the 60 FPS path.
 *  React HUD ............ Reads 4 Hz snapshots only; the render loop never sets state.
 * ========================================================================== */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import {
  Activity, Check, ChevronDown, ChevronUp, Compass, Copy, Crosshair, Database, Download,
  Globe, KeyRound, Map as MapIcon, Minus, Plus, Radio, RefreshCw, Search, Share2,
  ShieldCheck, Volume2, VolumeX, X, Zap,
} from "lucide-react";

/* ----------------------------------------------------------------------------
 * Constants
 * ------------------------------------------------------------------------- */
const R = 100;                 // globe radius in world units
const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;
const MAX_ARCS = 80;           // hard cap on concurrent laser arcs (GPU instance slots)
const MAX_RINGS = 160;         // impact + launch shockwaves
const MAX_SPIKES = 64;         // impact pillars
const ARC_SEG = 72;            // ribbon segments per arc
const BOLT_LEN = 0.3;          // laser bolt length as a fraction of its arc
const DPE = 48;                // mean real detections represented by one laser event
const ROLL_TAU = 90;           // seconds: rolling window for the "most attacked" rank
const POLL_MS = 5 * 60 * 1000; // Cloudflare polling interval
const BASE_RATE = 25;          // default lasers per second
const GEO_URL =
  "https://raw.githubusercontent.com/vasturiano/react-globe.gl/master/example/datasets/ne_110m_admin_0_countries.geojson";
const CF_API = "https://api.cloudflare.com/client/v4";
const MONO = "'JetBrains Mono', 'Share Tech Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
const DISPLAY = "'Share Tech Mono', 'JetBrains Mono', ui-monospace, monospace";

const C = {
  void: "#05070a", land: "#181c20", border: "#2a323b", neon: "#00ff9d", ice: "#e4f4ff",
  text: "#b7cad4", dim: "#5f707c", hot: "#ff2a55", cyan: "#00e5ff",
};

const VECTORS = [
  { id: "OAS", label: "On-Access", desc: "Botnet probe", color: "#00ff66" },
  { id: "ODS", label: "On-Demand", desc: "Port & vuln scan", color: "#ff2a55" },
  { id: "MAV", label: "Mail", desc: "Phishing & SMTP flood", color: "#ff9900" },
  { id: "WAV", label: "Web", desc: "Layer-7 HTTP DDoS & WAF", color: "#00e5ff" },
  { id: "IDS", label: "Intrusion", desc: "SYN & TCP flood", color: "#ff00aa" },
  { id: "VUL", label: "Exploit", desc: "Zero-day & RCE attempt", color: "#b829ff" },
  { id: "KAS", label: "UDP", desc: "DNS & NTP amplification", color: "#00ffcc" },
  { id: "BAD", label: "BGP", desc: "Hijack, route leak, anomaly", color: "#3b82f6" },
];
const VEC_IDS = VECTORS.map((v) => v.id);
const VEC = Object.fromEntries(VECTORS.map((v) => [v.id, v]));
const VEC_PITCH = { OAS: 660, ODS: 523, MAV: 440, WAV: 880, IDS: 740, VUL: 988, KAS: 587, BAD: 392 };

/* Major data-center / IXP hubs: [name, originWeight, targetWeight, [[lat, lng], ...]] */
const HUBS = {
  US: ["United States", 14, 15, [[39.04, -77.49], [32.78, -96.8], [37.34, -121.89], [41.88, -87.63], [40.71, -74.01], [34.05, -118.24], [47.61, -122.33], [25.76, -80.19]]],
  CN: ["China", 11, 5, [[39.9, 116.41], [31.23, 121.47], [23.13, 113.26], [22.54, 114.06], [30.57, 104.07], [30.27, 120.16]]],
  RU: ["Russia", 8, 4.2, [[55.76, 37.62], [59.93, 30.34], [55.01, 82.93], [56.84, 60.61]]],
  IN: ["India", 5, 3.6, [[19.08, 72.88], [13.08, 80.27], [28.61, 77.21], [12.97, 77.59], [17.39, 78.49], [22.57, 88.36], [18.52, 73.86]]],
  BR: ["Brazil", 6, 4, [[-23.55, -46.63], [-22.91, -43.17], [-3.73, -38.52], [-15.79, -47.88]]],
  DE: ["Germany", 4.5, 6.5, [[50.11, 8.68], [52.52, 13.4], [48.14, 11.58], [51.23, 6.77]]],
  GB: ["United Kingdom", 2.6, 4.5, [[51.51, -0.13], [53.48, -2.24]]],
  SG: ["Singapore", 2.8, 5, [[1.35, 103.82]]],
  NL: ["Netherlands", 4, 3.4, [[52.37, 4.9], [51.92, 4.48]]],
  UA: ["Ukraine", 2, 2.6, [[50.45, 30.52], [49.99, 36.23], [46.48, 30.72]]],
  FR: ["France", 2.4, 3.8, [[48.86, 2.35], [43.3, 5.37], [45.76, 4.84]]],
  JP: ["Japan", 1.6, 3.2, [[35.68, 139.69], [34.69, 135.5]]],
  KR: ["South Korea", 2.6, 2.8, [[37.57, 126.98], [35.18, 129.08]]],
  IR: ["Iran", 2, 0.9, [[35.69, 51.39], [32.65, 51.67]]],
  HK: ["Hong Kong", 3, 3.5, [[22.32, 114.17]]],
  VN: ["Vietnam", 3.5, 1.5, [[21.03, 105.85], [10.82, 106.63]]],
  ID: ["Indonesia", 3, 1.4, [[-6.21, 106.85], [-7.25, 112.75]]],
  TW: ["Taiwan", 1.8, 2.4, [[25.03, 121.57]]],
  CA: ["Canada", 1.4, 2.2, [[43.65, -79.38], [45.5, -73.57], [49.28, -123.12]]],
  AU: ["Australia", 0.8, 2.2, [[-33.87, 151.21], [-37.81, 144.96]]],
  TR: ["Turkey", 1.5, 1.5, [[41.01, 28.98], [39.93, 32.86]]],
  ZA: ["South Africa", 0.8, 1, [[-26.2, 28.05], [-33.92, 18.42]]],
  MX: ["Mexico", 1.2, 1.2, [[19.43, -99.13], [25.69, -100.32]]],
  AR: ["Argentina", 1, 0.9, [[-34.6, -58.38]]],
  EG: ["Egypt", 0.8, 0.8, [[30.04, 31.24]]],
  NG: ["Nigeria", 0.6, 0.6, [[6.52, 3.38]]],
  PK: ["Pakistan", 1, 0.8, [[24.86, 67.01], [31.55, 74.34]]],
  BD: ["Bangladesh", 1, 0.7, [[23.81, 90.41]]],
  IL: ["Israel", 0.5, 2, [[32.09, 34.78]]],
  SA: ["Saudi Arabia", 0.5, 1.6, [[24.71, 46.68]]],
  AE: ["United Arab Emirates", 0.6, 1.6, [[25.2, 55.27]]],
  PL: ["Poland", 1, 1.4, [[52.23, 21.01]]],
  IT: ["Italy", 0.9, 1.5, [[45.46, 9.19], [41.9, 12.5]]],
  ES: ["Spain", 0.9, 1.4, [[40.42, -3.7], [41.39, 2.17]]],
  SE: ["Sweden", 0.5, 1, [[59.33, 18.07]]],
  TH: ["Thailand", 1.2, 0.9, [[13.76, 100.5]]],
  KP: ["North Korea", 1, 0.2, [[39.04, 125.76]]],
  CO: ["Colombia", 0.6, 0.6, [[4.71, -74.07]]],
  CL: ["Chile", 0.5, 0.6, [[-33.45, -70.67]]],
};

/* Well-known corridors: [origin, target, weight, layer] — layer ANY splits L3/L7 */
const BASE_PAIRS = [
  ["CN", "US", 3, "L3"], ["RU", "UA", 2.5, "L7"], ["US", "CN", 2, "ANY"], ["RU", "US", 1.8, "ANY"],
  ["IR", "IL", 1.5, "L7"], ["KP", "KR", 1.2, "ANY"], ["CN", "TW", 1.6, "L7"], ["CN", "IN", 1.4, "ANY"],
  ["PK", "IN", 1.2, "L7"], ["BR", "US", 1.2, "L3"], ["VN", "US", 1, "L3"], ["NL", "DE", 1, "L3"],
  ["US", "DE", 1, "ANY"], ["DE", "US", 0.9, "ANY"], ["ID", "SG", 0.9, "L3"], ["HK", "SG", 0.9, "L3"],
  ["US", "IN", 1, "ANY"], ["RU", "DE", 1, "L7"], ["CN", "JP", 1, "ANY"], ["CN", "SG", 0.9, "L3"],
  ["IN", "US", 0.9, "L3"], ["UA", "RU", 1, "L7"], ["BD", "IN", 0.7, "L7"], ["SG", "IN", 0.8, "L3"],
  ["US", "BR", 0.8, "L3"], ["RU", "GB", 0.8, "L7"], ["CN", "KR", 0.9, "ANY"], ["BR", "AR", 0.5, "L3"],
  ["TR", "DE", 0.5, "ANY"], ["NL", "GB", 0.6, "L3"], ["US", "GB", 0.7, "ANY"], ["FR", "US", 0.5, "ANY"],
  ["IN", "SG", 0.5, "L3"], ["CN", "AU", 0.6, "ANY"], ["RU", "FR", 0.6, "L7"],
];

/* Vector mix per layer. Cloudflare L3 protocols / L7 mitigation products map onto these. */
const BASE_VEC = {
  L3: { IDS: 30, KAS: 34, ODS: 16, BAD: 8, OAS: 8, MAV: 4 },
  L7: { WAV: 38, VUL: 22, OAS: 20, MAV: 12, ODS: 8 },
};

/* ----------------------------------------------------------------------------
 * Small utilities
 * ------------------------------------------------------------------------- */
const hexRgb = (hex) => {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
};
const RGB = Object.fromEntries(VECTORS.map((v) => [v.id, hexRgb(v.color)]));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const wrapPi = (a) => {
  let x = (a + Math.PI) % (2 * Math.PI);
  if (x < 0) x += 2 * Math.PI;
  return x - Math.PI;
};
const fmt = (n) => Math.round(n || 0).toLocaleString("en-US");
const fmtK = (n) => {
  const v = n || 0;
  if (v >= 1e6) return (v / 1e6).toFixed(1) + "M";
  if (v >= 1e3) return (v / 1e3).toFixed(1) + "K";
  return v.toFixed(v < 10 ? 1 : 0);
};
const zeroVec = () => Object.fromEntries(VEC_IDS.map((v) => [v, 0]));
const utcDayKey = () => new Date().toISOString().slice(0, 10);
const secsSinceUtcMidnight = () => {
  const d = new Date();
  return d.getUTCHours() * 3600 + d.getUTCMinutes() * 60 + d.getUTCSeconds() + d.getUTCMilliseconds() / 1000;
};
function gauss() {
  let u = 0, v = 0;
  while (!u) u = Math.random();
  while (!v) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
function gcDist(lat1, lng1, lat2, lng2) {
  const s = Math.sin((lat2 - lat1) / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin((lng2 - lng1) / 2) ** 2;
  return 2 * Math.asin(Math.min(1, Math.sqrt(s)));
}

/* Weighted sampler: prefix sums + binary search, O(log n) per draw */
class Sampler {
  constructor(entries) {
    this.items = [];
    this.cum = [];
    let t = 0;
    for (const [k, w] of entries) {
      if (w > 0 && Number.isFinite(w)) {
        t += w;
        this.items.push(k);
        this.cum.push(t);
      }
    }
    this.total = t;
  }
  sample() {
    if (!this.total) return null;
    const r = Math.random() * this.total;
    let lo = 0, hi = this.cum.length - 1;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (this.cum[m] < r) lo = m + 1;
      else hi = m;
    }
    return this.items[lo];
  }
}

/* ----------------------------------------------------------------------------
 * Country geometry: embedded polyline-encoded Natural Earth 1:110m (0.05°)
 * with the remote GeoJSON preferred when reachable.
 * ------------------------------------------------------------------------- */
const GEO_Q = 20;
function decodeRing(s) {
  const pts = [];
  let i = 0, x = 0, y = 0;
  const next = () => {
    let r = 0, sh = 0, b;
    do {
      b = s.charCodeAt(i++) - 63;
      r |= (b & 31) << sh;
      sh += 5;
    } while (b >= 32);
    return r & 1 ? ~(r >> 1) : r >> 1;
  };
  while (i < s.length) {
    x += next();
    y += next();
    pts.push([x / GEO_Q, y / GEO_Q]);
  }
  return pts;
}
function decodeEmbedded(rows) {
  return rows.map(([iso, name, enc]) => ({
    iso, name, polys: enc.split(";").map((p) => p.split(":").map(decodeRing)),
  }));
}
const ISO_FIX = { FRA: "FR", NOR: "NO", CYN: "XN", SOL: "XS" };
const NAME_FIX = {
  US: "United States", CD: "DR Congo", CF: "Central African Rep.", BA: "Bosnia & Herzegovina",
  DO: "Dominican Republic", SS: "South Sudan", GQ: "Equatorial Guinea", TF: "French S. Territories",
  EH: "Western Sahara", SB: "Solomon Islands", FK: "Falkland Islands",
};
function parseGeoJSON(gj) {
  const out = [];
  const seen = new Set();
  for (const f of (gj && gj.features) || []) {
    const p = f.properties || {};
    const g = f.geometry;
    if (!g) continue;
    let iso = p.ISO_A2;
    if (!iso || iso === "-99") iso = ISO_FIX[p.ADM0_A3] || p.ADM0_A3 || p.NAME;
    if (!iso) continue;
    while (seen.has(iso)) iso += "_";
    seen.add(iso);
    const polys = g.type === "Polygon" ? [g.coordinates] : g.type === "MultiPolygon" ? g.coordinates : [];
    out.push({ iso, name: NAME_FIX[iso] || p.NAME || p.ADMIN || iso, polys });
  }
  return out;
}
function prepareCountries(list) {
  const out = [];
  for (const c of list) {
    const polys = [];
    for (const rings of c.polys) {
      const rr = rings
        .map((r) => {
          const a = r.map((pt) => [pt[0], pt[1]]);
          if (a.length > 1 && a[0][0] === a[a.length - 1][0] && a[0][1] === a[a.length - 1][1]) a.pop();
          return a;
        })
        .filter((r) => r.length >= 3);
      if (!rr.length) continue;
      const o = rr[0];
      let minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9, A = 0, cx = 0, cy = 0;
      for (let i = 0, j = o.length - 1; i < o.length; j = i++) {
        const [xi, yi] = o[i];
        const [xj, yj] = o[j];
        minX = Math.min(minX, xi); maxX = Math.max(maxX, xi);
        minY = Math.min(minY, yi); maxY = Math.max(maxY, yi);
        const f = xj * yi - xi * yj;
        A += f; cx += (xi + xj) * f; cy += (yi + yj) * f;
      }
      A /= 2;
      polys.push({
        rings: rr, bbox: [minX, minY, maxX, maxY], area: Math.abs(A),
        cx: Math.abs(A) > 1e-9 ? cx / (6 * A) : (minX + maxX) / 2,
        cy: Math.abs(A) > 1e-9 ? cy / (6 * A) : (minY + maxY) / 2,
      });
    }
    if (!polys.length) continue;
    const big = polys.reduce((a, b) => (b.area > a.area ? b : a), polys[0]);
    out.push({ idx: out.length, iso: c.iso, name: c.name, polys, center: [big.cy, big.cx] });
  }
  return out;
}
function inRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function findCountryAt(countries, lng, lat) {
  for (const c of countries) {
    for (const p of c.polys) {
      const b = p.bbox;
      if (lng < b[0] || lng > b[2] || lat < b[1] || lat > b[3]) continue;
      if (!inRing(lng, lat, p.rings[0])) continue;
      let hole = false;
      for (let h = 1; h < p.rings.length && !hole; h++) hole = inRing(lng, lat, p.rings[h]);
      if (!hole) return c;
    }
  }
  return null;
}

/* Triangulates every country in lng/lat space, then subdivides triangles with a
 * per-edge rule (an edge splits iff it is long) so neighbours stay crack-free
 * when the vertices are wrapped onto the sphere. */
function buildCountryBuffers(list) {
  const MAXE = 2.4;
  const pos = [], cid = [], bpos = [], bcid = [];
  const elen = (a, b) => {
    const dl = (a[0] - b[0]) * Math.cos(((a[1] + b[1]) / 2) * D2R);
    const dp = a[1] - b[1];
    return Math.sqrt(dl * dl + dp * dp);
  };
  const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  let ci = 0;
  const put = (p) => { pos.push(p[0] * D2R, p[1] * D2R, 0); cid.push(ci); };
  const tri = (a, b, c, depth) => {
    if (depth > 7) { put(a); put(b); put(c); return; }
    const sab = elen(a, b) > MAXE, sbc = elen(b, c) > MAXE, sca = elen(c, a) > MAXE;
    const n = (sab ? 1 : 0) + (sbc ? 1 : 0) + (sca ? 1 : 0);
    if (!n) { put(a); put(b); put(c); return; }
    const d = depth + 1;
    const ab = sab ? mid(a, b) : null, bc = sbc ? mid(b, c) : null, ca = sca ? mid(c, a) : null;
    if (n === 3) { tri(a, ab, ca, d); tri(ab, b, bc, d); tri(ca, bc, c, d); tri(ab, bc, ca, d); }
    else if (n === 1) {
      if (sab) { tri(a, ab, c, d); tri(ab, b, c, d); }
      else if (sbc) { tri(a, b, bc, d); tri(a, bc, c, d); }
      else { tri(a, b, ca, d); tri(ca, b, c, d); }
    } else if (!sab) { tri(c, ca, bc, d); tri(a, b, bc, d); tri(a, bc, ca, d); }
    else if (!sbc) { tri(a, ab, ca, d); tri(ab, b, c, d); tri(ab, c, ca, d); }
    else { tri(b, bc, ab, d); tri(a, ab, bc, d); tri(a, bc, c, d); }
  };
  const seg = (a, b, depth) => {
    if (depth < 8 && elen(a, b) > MAXE) {
      const m = mid(a, b);
      seg(a, m, depth + 1);
      seg(m, b, depth + 1);
      return;
    }
    bpos.push(a[0] * D2R, a[1] * D2R, 0.14, b[0] * D2R, b[1] * D2R, 0.14);
    bcid.push(ci, ci);
  };
  for (const c of list) {
    ci = c.idx;
    for (const p of c.polys) {
      const contour = p.rings[0].map(([x, y]) => new THREE.Vector2(x, y));
      const holes = p.rings.slice(1).map((r) => r.map(([x, y]) => new THREE.Vector2(x, y)));
      let faces = [];
      try { faces = THREE.ShapeUtils.triangulateShape(contour, holes); } catch (e) { faces = []; }
      const verts = p.rings[0].concat(...p.rings.slice(1));
      for (const f of faces) tri(verts[f[0]], verts[f[1]], verts[f[2]], 0);
      for (const r of p.rings) for (let i = 0; i < r.length; i++) seg(r[i], r[(i + 1) % r.length], 0);
    }
  }
  return { pos: new Float32Array(pos), cid: new Float32Array(cid), bpos: new Float32Array(bpos), bcid: new Float32Array(bcid) };
}

/* ----------------------------------------------------------------------------
 * ThreatEngine — the Stochastic Threat Stream Regenerator
 * ------------------------------------------------------------------------- */
class ThreatEngine {
  constructor() {
    this.countries = [];
    this.byIso = {};
    this.names = {};
    for (const [iso, h] of Object.entries(HUBS)) this.names[iso] = h[0];
    this.seq = 0;
    this.nextArrival = null;
    this.burst = 0;
    this.session = 0;
    this.apsTimes = [];
    this.recent = [];
    this.global = zeroVec();
    this.inc = {};
    this.inRoll = {};
    this.outRoll = {};
    this.originHits = {};
    this.lastDecay = 0;
    this.histIso = null;
    this.histSec = -1;
    this.histCur = 0;
    this.hist = [];
    this.rankList = [];
    this.rankOfIso = {};
    this.dayKey = utcDayKey();
    this.version = 0;
    this.seedTotal = secsSinceUtcMidnight() * BASE_RATE * DPE;
    this.setMatrix(this.baselineMatrix());
    for (const v of VEC_IDS) this.global[v] = Math.round(this.seedTotal * this.vShare[v] * (0.97 + Math.random() * 0.06));
    this.seedIsos(Object.keys(HUBS));
    this.rank();
  }

  setCountries(list) {
    this.countries = list;
    this.byIso = {};
    for (const c of list) {
      this.byIso[c.iso] = c;
      if (!this.names[c.iso]) this.names[c.iso] = c.name;
    }
    this.setMatrix(this.matrix.source === "baseline" ? this.baselineMatrix() : this.matrix);
    this.seedIsos(list.map((c) => c.iso));
    this.rank();
  }

  baselineMatrix() {
    const src = {}, tgt = {};
    for (const [iso, h] of Object.entries(HUBS)) { src[iso] = h[1]; tgt[iso] = h[2]; }
    for (const c of this.countries) {
      if (c.iso in src) continue;
      const remote = c.iso === "AQ" || c.iso === "TF" || c.iso === "FK";
      src[c.iso] = remote ? 0 : 0.05;
      tgt[c.iso] = remote ? 0.004 : 0.07;
    }
    return {
      source: "baseline", label: "Baseline global threat weights", src, tgt,
      pairs: BASE_PAIRS.map(([o, t, w, layer]) => ({ o, t, w, layer })),
      vec: BASE_VEC, l7Share: 0.45, pPair: 0.42, names: {}, fetchedAt: null,
    };
  }

  /* Normalizes a matrix into samplers + analytic shares used for seeding and display. */
  setMatrix(m) {
    this.matrix = m;
    this.version++;
    Object.assign(this.names, m.names || {});
    this.srcS = new Sampler(Object.entries(m.src));
    this.tgtS = new Sampler(Object.entries(m.tgt));
    this.pairS = new Sampler(m.pairs.map((p, i) => [i, p.w]));
    this.vecS = { L3: new Sampler(Object.entries(m.vec.L3)), L7: new Sampler(Object.entries(m.vec.L7)) };
    const pp = m.pairs.length ? m.pPair : 0;
    this.pPair = pp;
    const srcT = this.srcS.total || 1, tgtT = this.tgtS.total || 1, pairT = this.pairS.total || 1;
    const tShare = {}, oShare = {};
    for (const [k, w] of Object.entries(m.tgt)) tShare[k] = ((1 - pp) * w) / tgtT;
    for (const [k, w] of Object.entries(m.src)) oShare[k] = ((1 - pp) * w) / srcT;
    let l7 = (1 - pp) * m.l7Share;
    for (const p of m.pairs) {
      const s = (pp * p.w) / pairT;
      tShare[p.t] = (tShare[p.t] || 0) + s;
      oShare[p.o] = (oShare[p.o] || 0) + s;
      l7 += s * (p.layer === "L7" ? 1 : p.layer === "ANY" ? m.l7Share : 0);
    }
    this.tShare = tShare;
    this.oShare = oShare;
    this.l7Total = l7;
    const vShare = zeroVec();
    const t3 = this.vecS.L3.total || 1, t7 = this.vecS.L7.total || 1;
    for (const v of VEC_IDS) vShare[v] = (1 - l7) * ((m.vec.L3[v] || 0) / t3) + l7 * ((m.vec.L7[v] || 0) / t7);
    this.vShare = vShare;
    this.originCache = {};
  }

  /* Extrapolates "since 00:00 GMT" counters so the HUD opens with realistic totals. */
  seedIsos(isos) {
    for (const iso of isos) {
      if (this.inc[iso]) continue;
      const share = this.tShare[iso] || 0;
      const row = { ...zeroVec(), total: 0 };
      for (const v of VEC_IDS) {
        const x = Math.round(this.seedTotal * share * this.vShare[v] * (0.82 + Math.random() * 0.36));
        row[v] = x;
        row.total += x;
      }
      this.inc[iso] = row;
      this.inRoll[iso] = share * BASE_RATE * DPE * ROLL_TAU;
      this.outRoll[iso] = (this.oShare[iso] || 0) * BASE_RATE * DPE * ROLL_TAU;
    }
  }

  nameOf(iso) { return this.names[iso] || iso; }
  centerOf(iso) {
    const h = HUBS[iso];
    if (h) return h[3][0];
    const c = this.byIso[iso];
    return c ? c.center : null;
  }

  locate(iso) {
    const h = HUBS[iso];
    let lat, lng, s;
    if (h) {
      const cs = h[3];
      const c = cs[Math.floor(Math.pow(Math.random(), 1.7) * cs.length)];
      lat = c[0]; lng = c[1]; s = 0.55;
    } else {
      const c = this.byIso[iso];
      if (!c) return null;
      lat = c.center[0]; lng = c.center[1]; s = 0.9;
    }
    lat = clamp(lat + gauss() * s, -82, 82);
    lng += (gauss() * s) / Math.max(0.3, Math.cos(lat * D2R));
    return [lat, lng];
  }

  sampleEvent() {
    const m = this.matrix;
    let o, t, layer;
    if (this.pPair > 0 && Math.random() < this.pPair) {
      const p = m.pairs[this.pairS.sample()];
      if (!p) return null;
      o = p.o; t = p.t; layer = p.layer;
    } else {
      o = this.srcS.sample();
      t = this.tgtS.sample();
      for (let g = 0; g < 6 && t === o; g++) t = this.tgtS.sample();
      layer = "ANY";
    }
    if (!o || !t) return null;
    if (layer === "ANY") layer = Math.random() < m.l7Share ? "L7" : "L3";
    const v = this.vecS[layer].sample() || "WAV";
    const a = this.locate(o), b = this.locate(t);
    if (!a || !b) return null;
    const d = gcDist(a[0] * D2R, a[1] * D2R, b[0] * D2R, b[1] * D2R);
    if (d < 0.012) return null;
    return {
      id: ++this.seq, o, t, v, layer, lat1: a[0], lng1: a[1], lat2: b[0], lng2: b[1], d,
      w: 12 + Math.floor(-Math.log(1 - Math.random()) * 36),
    };
  }

  /* Poisson emitter: exponential inter-arrival times around a modulated rate. */
  step(now, dt, rate) {
    if (Math.random() < dt * 0.08) this.burst = 0.5 + Math.random() * 0.9;
    this.burst *= Math.exp(-dt * 0.9);
    const mod = 1 + 0.26 * Math.sin(now * 0.23) + 0.14 * Math.sin(now * 0.71 + 1.3) + this.burst;
    const lambda = Math.max(0.5, rate * mod);
    if (this.nextArrival === null || now - this.nextArrival > 1) this.nextArrival = now;
    const out = [];
    while (this.nextArrival <= now && out.length < 16) {
      const ev = this.sampleEvent();
      if (ev) { this.record(ev, now); out.push(ev); }
      this.nextArrival += -Math.log(1 - Math.random()) / lambda;
    }
    const sec = Math.floor(now);
    if (sec !== this.histSec) {
      if (this.histSec >= 0) {
        this.hist.push(this.histCur);
        if (this.hist.length > 60) this.hist.shift();
      }
      this.histSec = sec;
      this.histCur = 0;
    }
    return out;
  }

  record(ev, now) {
    this.session++;
    this.global[ev.v] += ev.w;
    const row = this.inc[ev.t] || (this.inc[ev.t] = { ...zeroVec(), total: 0 });
    row[ev.v] += ev.w;
    row.total += ev.w;
    this.inRoll[ev.t] = (this.inRoll[ev.t] || 0) + ev.w;
    this.outRoll[ev.o] = (this.outRoll[ev.o] || 0) + ev.w;
    const oh = this.originHits[ev.t] || (this.originHits[ev.t] = {});
    oh[ev.o] = (oh[ev.o] || 0) + 1;
    this.apsTimes.push(now);
    while (this.apsTimes.length && this.apsTimes[0] < now - 2) this.apsTimes.shift();
    this.recent.push(ev);
    if (this.recent.length > 14) this.recent.shift();
    if (ev.t === this.histIso) this.histCur++;
  }

  decay(now) {
    const dt = now - this.lastDecay;
    if (dt <= 0) return;
    this.lastDecay = now;
    const f = Math.exp(-dt / ROLL_TAU);
    for (const k in this.inRoll) this.inRoll[k] *= f;
    for (const k in this.outRoll) this.outRoll[k] *= f;
  }

  rank() {
    this.rankList = Object.entries(this.inRoll).filter(([, v]) => v > 0.01).sort((a, b) => b[1] - a[1]);
    this.rankOfIso = {};
    this.rankList.forEach(([iso], i) => { this.rankOfIso[iso] = i + 1; });
  }
  rankOf(iso) { return this.rankOfIso[iso] || null; }
  topTargets(n) { return this.rankList.slice(0, n).map(([iso]) => iso); }

  heat() {
    let max = 0;
    for (const k in this.inRoll) if (this.inRoll[k] > max) max = this.inRoll[k];
    const out = {};
    if (!max) return out;
    for (const k in this.inRoll) out[k] = Math.sqrt(this.inRoll[k] / max);
    return out;
  }

  resetHistory(iso) {
    this.histIso = iso;
    this.hist = [];
    this.histCur = 0;
  }

  originShares(t) {
    const key = t + "|" + this.version;
    if (this.originCache[key]) return this.originCache[key];
    const m = this.matrix;
    const res = {};
    const pairT = this.pairS.total || 1, srcT = this.srcS.total || 1, tgtT = this.tgtS.total || 1;
    for (const p of m.pairs) if (p.t === t) res[p.o] = (res[p.o] || 0) + (this.pPair * p.w) / pairT;
    const ts = ((1 - this.pPair) * (m.tgt[t] || 0)) / tgtT;
    for (const [o, w] of Object.entries(m.src)) if (o !== t && w > 0) res[o] = (res[o] || 0) + (ts * w) / srcT;
    const sum = Object.values(res).reduce((a, b) => a + b, 0) || 1;
    const list = Object.entries(res)
      .map(([iso, v]) => ({ iso, name: this.nameOf(iso), share: v / sum }))
      .sort((a, b) => b.share - a.share)
      .slice(0, 6);
    this.originCache[key] = list;
    return list;
  }

  /* Top-n origins × top-n targets of the current probability matrix. */
  matrixView(n = 8) {
    const m = this.matrix;
    const origins = Object.entries(this.oShare).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k]) => k);
    const targets = Object.entries(this.tShare).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k]) => k);
    const pairT = this.pairS.total || 1, srcT = this.srcS.total || 1, tgtT = this.tgtS.total || 1;
    let max = 0;
    const cells = origins.map((o) =>
      targets.map((t) => {
        let p = o === t ? 0 : ((1 - this.pPair) * ((m.src[o] || 0) / srcT) * ((m.tgt[t] || 0) / tgtT));
        for (const q of m.pairs) if (q.o === o && q.t === t) p += (this.pPair * q.w) / pairT;
        max = Math.max(max, p);
        return p;
      })
    );
    return { origins, targets, cells, max: max || 1 };
  }

  snapshot(sel, now) {
    this.decay(now);
    const day = utcDayKey();
    if (day !== this.dayKey) {
      this.dayKey = day;
      this.global = zeroVec();
      for (const k in this.inc) this.inc[k] = { ...zeroVec(), total: 0 };
    }
    while (this.apsTimes.length && this.apsTimes[0] < now - 1) this.apsTimes.shift();
    this.rank();
    const outList = Object.entries(this.outRoll).filter(([, v]) => v > 0.01).sort((a, b) => b[1] - a[1]);
    const total = VEC_IDS.reduce((a, v) => a + this.global[v], 0);
    let selInfo = null;
    if (sel) {
      if (sel !== this.histIso) this.resetHistory(sel);
      const row = this.inc[sel] || { ...zeroVec(), total: 0 };
      const hits = this.originHits[sel] || {};
      selInfo = {
        iso: sel, name: this.nameOf(sel), counts: { ...row }, total: row.total,
        rank: this.rankOf(sel), of: this.rankList.length, hist: this.hist.slice(),
        origins: this.originShares(sel).map((o) => ({ ...o, seen: hits[o.iso] || 0 })),
        rate: (this.inRoll[sel] || 0) / ROLL_TAU,
      };
    }
    return {
      aps: this.apsTimes.length, session: this.session, global: { ...this.global }, total, sel: selInfo,
      topTargets: this.rankList.slice(0, 10).map(([iso, s]) => ({ iso, name: this.nameOf(iso), rate: s / ROLL_TAU })),
      topOrigins: outList.slice(0, 10).map(([iso, s]) => ({ iso, name: this.nameOf(iso), rate: s / ROLL_TAU })),
      recent: this.recent.slice(-10).reverse().map((e) => ({ id: e.id, o: e.o, t: e.t, v: e.v, layer: e.layer, on: this.nameOf(e.o), tn: this.nameOf(e.t) })),
      vShare: { ...this.vShare }, l7Total: this.l7Total,
      mode: this.matrix.source, label: this.matrix.label, fetchedAt: this.matrix.fetchedAt, version: this.version,
    };
  }
}

/* ----------------------------------------------------------------------------
 * Cloudflare Radar client
 * ------------------------------------------------------------------------- */
const RADAR_ENDPOINTS = [
  { key: "l3pairs", label: "L3 origin → target pairs", path: "/radar/attacks/layer3/top/attacks", params: { limit: 30 } },
  { key: "l7pairs", label: "L7 origin → target pairs", path: "/radar/attacks/layer7/top/attacks", params: { limit: 30 } },
  { key: "l3targets", label: "L3 top target locations", path: "/radar/attacks/layer3/top/locations/target", params: { limit: 30 } },
  { key: "l3origins", label: "L3 top origin locations", path: "/radar/attacks/layer3/top/locations/origin", params: { limit: 30 } },
  { key: "l3protocol", label: "L3 protocol timeseries", path: "/radar/attacks/layer3/timeseries_groups/protocol", params: {} },
  { key: "l7mitigation", label: "L7 mitigation product mix", path: "/radar/attacks/layer7/summary/mitigation_product", params: {} },
];

/* Proxy formats: "https://x.workers.dev" (path-forwarding), "https://proxy/?url=" (prefix),
 * or a template containing {url}. */
function proxify(url, proxy) {
  const p = (proxy || "").trim();
  if (!p) return url;
  if (p.includes("{url}")) return p.replace("{url}", encodeURIComponent(url));
  if (p.includes("?") || p.endsWith("=")) return p + encodeURIComponent(url);
  return p.replace(/\/+$/, "") + url.replace(/^https:\/\/api\.cloudflare\.com/, "");
}

function blockOf(result, prefixes) {
  if (!result || typeof result !== "object") return null;
  for (const [k, v] of Object.entries(result)) if (k !== "meta" && prefixes.some((p) => k.startsWith(p))) return v;
  for (const [k, v] of Object.entries(result)) if (k !== "meta" && v && typeof v === "object") return v;
  return null;
}
function numericBlock(blk) {
  if (!blk || typeof blk !== "object" || Array.isArray(blk)) return null;
  const o = {};
  for (const [k, v] of Object.entries(blk)) {
    if (k === "timestamps") continue;
    if (Array.isArray(v)) {
      const nums = v.map(parseFloat).filter(Number.isFinite);
      if (nums.length) o[k] = nums.reduce((a, b) => a + b, 0) / nums.length;
    } else {
      const x = parseFloat(v);
      if (Number.isFinite(x)) o[k] = x;
    }
  }
  return Object.keys(o).length ? o : null;
}
function countRows(result) {
  const b = blockOf(result, ["top_", "summary_", "serie_"]);
  if (Array.isArray(b)) return b.length;
  if (b && typeof b === "object") return Object.keys(b).length;
  return 0;
}

async function fetchRadar(cfg) {
  const results = {}, status = {};
  await Promise.all(
    RADAR_ENDPOINTS.map(async (ep) => {
      const qs = new URLSearchParams({ ...ep.params, dateRange: cfg.dateRange || "1d", format: "json" });
      const url = proxify(`${CF_API}${ep.path}?${qs}`, cfg.proxy);
      const headers = { Accept: "application/json" };
      if (cfg.token && cfg.token.trim()) headers.Authorization = `Bearer ${cfg.token.trim()}`;
      const t0 = performance.now();
      try {
        const res = await fetch(url, { headers });
        const json = await res.json().catch(() => null);
        const ms = Math.round(performance.now() - t0);
        if (!res.ok || !json || json.success === false) {
          const msg = (json && json.errors && json.errors[0] && json.errors[0].message) || `HTTP ${res.status}`;
          status[ep.key] = { ok: false, msg, code: res.status, ms };
          return;
        }
        results[ep.key] = json.result;
        status[ep.key] = { ok: true, msg: "OK", code: res.status, ms, rows: countRows(json.result) };
      } catch (e) {
        status[ep.key] = { ok: false, msg: "Blocked (network or CORS)", code: 0, ms: Math.round(performance.now() - t0) };
      }
    })
  );
  return { results, status };
}

function radarErrorHint(status) {
  const list = Object.values(status);
  if (!list.length) return "No endpoints were queried.";
  if (list.every((s) => s.code === 0))
    return "The browser blocked the request. Cloudflare's API doesn't allow direct browser calls, so deploy the Worker proxy below and paste its URL.";
  if (list.some((s) => s.code === 401 || s.code === 403))
    return "Cloudflare rejected the token. Create an API token with Radar read access and paste it again.";
  return "Cloudflare answered without usable data. Check the endpoint table for details.";
}

function normMap(m) {
  const s = Object.values(m).reduce((a, b) => a + b, 0);
  const o = {};
  if (!s) return o;
  for (const [k, v] of Object.entries(m)) o[k] = v / s;
  return o;
}

/* Aggregated Radar percentages → normalized probability matrix (85% live, 15% baseline floor). */
function buildLiveMatrix(r, base) {
  const names = {};
  const up = (s) => (s ? String(s).toUpperCase() : null);
  const pairs = [], pairSrc = {}, pairTgt = {};
  const addPairs = (blk, layer) => {
    if (!Array.isArray(blk)) return 0;
    const rows = [];
    for (const it of blk) {
      const o = up(it.originCountryAlpha2 || it.origin_country_alpha2);
      const t = up(it.targetCountryAlpha2 || it.target_country_alpha2);
      const w = parseFloat(it.value);
      if (!o || !t || !(w > 0)) continue;
      if (it.originCountryName) names[o] = it.originCountryName;
      if (it.targetCountryName) names[t] = it.targetCountryName;
      rows.push({ o, t, w, layer });
    }
    const s = rows.reduce((a, b) => a + b.w, 0) || 1;
    for (const p of rows) {
      p.w /= s;
      pairs.push(p);
      pairSrc[p.o] = (pairSrc[p.o] || 0) + p.w;
      pairTgt[p.t] = (pairTgt[p.t] || 0) + p.w;
    }
    return rows.length;
  };
  const n3 = addPairs(blockOf(r.l3pairs, ["top_"]), "L3");
  const n7 = addPairs(blockOf(r.l7pairs, ["top_"]), "L7");
  const loc = (blk, key, nameKey) => {
    const m = {};
    if (Array.isArray(blk))
      for (const it of blk) {
        const iso = up(it[key]);
        const w = parseFloat(it.value);
        if (iso && w > 0) {
          m[iso] = (m[iso] || 0) + w;
          if (it[nameKey]) names[iso] = it[nameKey];
        }
      }
    return m;
  };
  let tgtLive = loc(blockOf(r.l3targets, ["top_"]), "targetCountryAlpha2", "targetCountryName");
  let srcLive = loc(blockOf(r.l3origins, ["top_"]), "originCountryAlpha2", "originCountryName");
  if (!Object.keys(tgtLive).length) tgtLive = pairTgt;
  if (!Object.keys(srcLive).length) srcLive = pairSrc;
  if (!pairs.length && !Object.keys(tgtLive).length && !Object.keys(srcLive).length) return null;
  const blend = (live, b) => {
    const L = normMap(live), B = normMap(b), out = {};
    for (const k of new Set([...Object.keys(L), ...Object.keys(B)])) out[k] = 0.85 * (L[k] || 0) + 0.15 * (B[k] || 0);
    return out;
  };
  const vec = { L3: { ...base.vec.L3 }, L7: { ...base.vec.L7 } };
  const proto = numericBlock(blockOf(r.l3protocol, ["serie_", "summary_"]));
  if (proto) {
    const g = (k) => proto[k] || 0;
    if (g("TCP") + g("UDP") + g("ICMP") + g("GRE") > 0)
      vec.L3 = { IDS: g("TCP"), KAS: g("UDP"), ODS: g("ICMP") + 2, BAD: g("GRE") + 1.5, OAS: 3, MAV: 1 };
  }
  const mit = numericBlock(blockOf(r.l7mitigation, ["summary_"]));
  if (mit) {
    const g = (k) => mit[k] || 0;
    if (Object.values(mit).reduce((a, b) => a + b, 0) > 0)
      vec.L7 = {
        WAV: g("DDOS"), VUL: g("WAF") + g("API_SHIELD"), OAS: g("BOT_MANAGEMENT") + g("IP_REPUTATION"),
        MAV: g("ACCESS_RULES") + g("DATA_LOSS_PREVENTION") + 4, ODS: 3,
      };
  }
  return {
    source: "cloudflare", label: `Cloudflare Radar: ${n3} L3 + ${n7} L7 corridors`,
    src: blend(srcLive, base.src), tgt: blend(tgtLive, base.tgt), pairs, vec,
    l7Share: 0.45, pPair: pairs.length ? 0.62 : 0, names, fetchedAt: Date.now(),
  };
}

const WORKER_SNIPPET = `// Cloudflare Worker: CORS proxy for the Radar API.
// Optional: add a secret CF_API_TOKEN so the token never reaches the browser.
export default {
  async fetch(req, env) {
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Authorization, Content-Type, Accept",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
    };
    if (req.method === "OPTIONS") return new Response(null, { headers: cors });
    const url = new URL(req.url);
    if (!url.pathname.startsWith("/client/v4/radar/")) {
      return new Response("Only Radar paths are proxied", { status: 403, headers: cors });
    }
    const auth = env.CF_API_TOKEN ? "Bearer " + env.CF_API_TOKEN : req.headers.get("Authorization") || "";
    const upstream = await fetch("https://api.cloudflare.com" + url.pathname + url.search, {
      headers: { Authorization: auth, Accept: "application/json" },
    });
    const res = new Response(upstream.body, upstream);
    for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
    return res;
  },
};`;

/* ----------------------------------------------------------------------------
 * Web Audio: quiet sonar pings on impact (muted until the user opts in)
 * ------------------------------------------------------------------------- */
function createAudio() {
  let ctx = null, master = null, noise = null, last = 0;
  return {
    enable() {
      const AC = typeof window !== "undefined" && (window.AudioContext || window.webkitAudioContext);
      if (!AC) return false;
      if (!ctx) {
        ctx = new AC();
        master = ctx.createGain();
        master.gain.value = 0.55;
        master.connect(ctx.destination);
        noise = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.06), ctx.sampleRate);
        const d = noise.getChannelData(0);
        for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / d.length, 3);
      }
      if (ctx.state === "suspended") ctx.resume();
      return true;
    },
    ping(freq, pan) {
      if (!ctx || ctx.state !== "running") return;
      const t = ctx.currentTime;
      if (t - last < 0.07) return;
      last = t;
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(freq, t);
      osc.frequency.exponentialRampToValueAtTime(freq * 0.5, t + 0.22);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.03, t + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.26);
      osc.connect(g);
      if (ctx.createStereoPanner) {
        const p = ctx.createStereoPanner();
        p.pan.value = clamp(pan, -1, 1);
        g.connect(p);
        p.connect(master);
      } else g.connect(master);
      osc.start(t);
      osc.stop(t + 0.3);
      const src = ctx.createBufferSource();
      src.buffer = noise;
      const bp = ctx.createBiquadFilter();
      bp.type = "bandpass";
      bp.frequency.value = freq * 3;
      bp.Q.value = 6;
      const ng = ctx.createGain();
      ng.gain.value = 0.035;
      src.connect(bp);
      bp.connect(ng);
      ng.connect(master);
      src.start(t);
    },
    dispose() {
      if (ctx) ctx.close().catch(() => {});
      ctx = null;
    },
  };
}

/* ----------------------------------------------------------------------------
 * GLSL. Every layer stores (lng, lat, altitude) and projects on the GPU:
 * uMorph = 0 → sphere, uMorph = 1 → equirectangular tactical plane.
 * ------------------------------------------------------------------------- */
const GLSL_PROJ = `
uniform float uMorph;
uniform float uR;
vec3 llUnit(vec2 ll) { float c = cos(ll.y); return vec3(c * sin(ll.x), sin(ll.y), c * cos(ll.x)); }
vec3 projLL(vec2 ll, float h) { return mix(llUnit(ll) * (uR + h), vec3(ll.x * uR, ll.y * uR, h), uMorph); }
vec3 projN(vec2 ll) {
  vec3 n = mix(llUnit(ll), vec3(0.0, 0.0, 1.0), uMorph);
  float l = length(n);
  return l > 0.0001 ? n / l : vec3(0.0, 0.0, 1.0);
}
`;

const OCEAN_VS = GLSL_PROJ + `
varying vec2 vLL; varying vec3 vN; varying vec3 vW;
void main() {
  vLL = position.xy;
  vec3 p = projLL(position.xy, position.z);
  vN = projN(position.xy);
  vW = p;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}`;
const OCEAN_FS = `
uniform float uMorph; uniform vec3 uBase; uniform vec3 uDot; uniform vec3 uRim;
varying vec2 vLL; varying vec3 vN; varying vec3 vW;
void main() {
  vec2 deg = vLL * 57.2957795;
  vec2 f = fract(deg / 2.5) - 0.5;
  f.x *= mix(max(cos(vLL.y), 0.2), 1.0, uMorph);
  float dots = smoothstep(0.17, 0.05, length(f));
  vec2 g = abs(fract(deg / 30.0 + 0.5) - 0.5) * 30.0;
  float grid = smoothstep(0.32, 0.0, min(g.x, g.y));
  vec3 V = normalize(cameraPosition - vW);
  float fres = pow(1.0 - clamp(dot(normalize(vN), V), 0.0, 1.0), 3.0);
  vec3 col = uBase + uDot * (dots * 0.5 + grid * 0.45) + uRim * fres * 0.55 * (1.0 - uMorph);
  gl_FragColor = vec4(col, 1.0);
}`;

const LAND_VS = GLSL_PROJ + `
attribute float aCid;
uniform float uHover; uniform float uSel;
varying float vCid; varying float vHov; varying float vSel; varying vec3 vN; varying vec3 vW;
void main() {
  vCid = aCid;
  vHov = 1.0 - step(0.5, abs(aCid - uHover));
  vSel = 1.0 - step(0.5, abs(aCid - uSel));
  vec3 p = projLL(position.xy, position.z + max(vHov, vSel) * 1.2);
  vN = projN(position.xy);
  vW = p;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}`;
const LAND_FS = `
uniform vec3 uLand; uniform vec3 uHot; uniform vec3 uNeon;
uniform sampler2D uHeat; uniform float uN; uniform float uTime;
varying float vCid; varying float vHov; varying float vSel; varying vec3 vN; varying vec3 vW;
void main() {
  vec3 V = normalize(cameraPosition - vW);
  float lam = 0.68 + 0.42 * clamp(dot(normalize(vN), V), 0.0, 1.0);
  float heat = texture2D(uHeat, vec2((vCid + 0.5) / uN, 0.5)).r;
  vec3 col = uLand * lam;
  col = mix(col, uHot, heat * heat * 0.24);
  col += uNeon * (vHov * 0.08 + vSel * (0.11 + 0.04 * sin(uTime * 3.0)));
  gl_FragColor = vec4(col, 1.0);
}`;

const BORDER_VS = GLSL_PROJ + `
attribute float aCid;
uniform float uHover; uniform float uSel;
varying float vA;
void main() {
  float hov = 1.0 - step(0.5, abs(aCid - uHover));
  float sel = 1.0 - step(0.5, abs(aCid - uSel));
  vA = max(hov * 0.7, sel);
  vec3 p = projLL(position.xy, position.z + max(hov, sel) * 1.2);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}`;
const BORDER_FS = `
uniform vec3 uBorder; uniform vec3 uNeon;
varying float vA;
void main() { gl_FragColor = vec4(mix(uBorder, uNeon, vA), 1.0); }`;

const ATMO_VS = `
varying vec3 vNv;
void main() {
  vNv = normalize(normalMatrix * normal);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;
const ATMO_FS = `
uniform vec3 uColor; uniform float uOpacity;
varying vec3 vNv;
void main() {
  float i = pow(clamp(0.75 - dot(vNv, vec3(0.0, 0.0, 1.0)), 0.0, 2.0), 5.0) * 0.12;
  gl_FragColor = vec4(uColor * min(i, 1.0) * uOpacity, 1.0);
}`;

const STAR_VS = `
attribute float aSize;
uniform float uTime; uniform float uPR;
varying float vA;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = aSize * uPR;
  vA = 0.4 + 0.3 * sin(uTime * 0.7 + position.x * 0.013 + position.y * 0.007);
}`;
const STAR_FS = `
varying float vA;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d = length(c);
  if (d > 0.5) discard;
  gl_FragColor = vec4(vec3(0.62, 0.8, 1.0) * vA * smoothstep(0.5, 0.0, d), 1.0);
}`;

/* Laser ribbons: camera-facing strips along a slerped great circle (globe) or a
 * bowed chord (flat). The fragment shader draws a travelling bolt + fading trace. */
const ARC_VS = GLSL_PROJ + `
attribute vec2 iStart; attribute vec2 iEnd; attribute vec3 iColor; attribute vec3 iTime;
uniform float uWidth;
varying float vT; varying float vSide; varying vec3 vColor; varying float vBirth; varying float vDur;
vec3 arcPos(float t) {
  vec3 a = llUnit(iStart);
  vec3 b = llUnit(iEnd);
  float d = acos(clamp(dot(a, b), -1.0, 1.0));
  float s = sin(d);
  vec3 p = s < 0.001 ? normalize(mix(a, b, t) + vec3(0.0, 0.0001, 0.0)) : (sin((1.0 - t) * d) * a + sin(t * d) * b) / s;
  float lift = iTime.z * sin(3.14159265 * t);
  vec3 g = p * (uR + 0.35 + lift);
  vec2 fa = iStart * uR;
  vec2 fb = iEnd * uR;
  vec2 dir = fb - fa;
  vec2 perp = vec2(-dir.y, dir.x);
  float pl = length(perp);
  perp = pl > 0.0001 ? perp / pl : vec2(0.0, 1.0);
  if (perp.y < 0.0) perp = -perp;
  vec3 f = vec3(mix(fa, fb, t) + perp * lift * 0.5, 0.35 + lift * 0.3);
  return mix(g, f, uMorph);
}
void main() {
  float t = position.x;
  float side = position.y;
  vec3 p = arcPos(t);
  vec3 tg = arcPos(min(t + 0.012, 1.0)) - arcPos(max(t - 0.012, 0.0));
  vec3 sd = cross(tg, cameraPosition - p);
  float sl = length(sd);
  sd = sl > 0.000001 ? sd / sl : vec3(1.0, 0.0, 0.0);
  vT = t; vSide = side; vColor = iColor; vBirth = iTime.x; vDur = iTime.y;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p + sd * side * uWidth, 1.0);
}`;
const ARC_FS = `
uniform float uTime;
varying float vT; varying float vSide; varying vec3 vColor; varying float vBirth; varying float vDur;
void main() {
  float age = (uTime - vBirth) / vDur;
  if (age < 0.0 || age > 2.4 || vT > age) discard;
  float k = (vT - (age - ${BOLT_LEN.toFixed(3)})) / ${BOLT_LEN.toFixed(3)};
  float bolt = k >= 0.0 ? pow(clamp(k, 0.0, 1.0), 1.7) : 0.0;
  float trace = 0.12 * exp(-(uTime - (vBirth + vT * vDur)) * 1.5);
  float x = vSide;
  float core = exp(-x * x * 14.0);
  float halo = exp(-x * x * 2.6) * 0.38;
  float a = bolt * (core + halo) + trace * core;
  vec3 col = vColor * a + vec3(1.0) * pow(bolt, 6.0) * exp(-x * x * 40.0) * 0.9;
  gl_FragColor = vec4(col, 1.0);
}`;

const RING_VS = GLSL_PROJ + `
attribute vec2 iLL; attribute vec3 iColor; attribute vec3 iTime;
uniform float uTime;
varying vec2 vUv; varying vec3 vColor; varying float vAge;
void main() {
  vec3 n = projN(iLL);
  vec3 c = projLL(iLL, 0.45);
  vec3 up = abs(n.y) > 0.98 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 1.0, 0.0);
  vec3 e = normalize(cross(up, n));
  vec3 no = cross(n, e);
  vUv = position.xy; vColor = iColor; vAge = (uTime - iTime.x) / iTime.y;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(c + (e * position.x + no * position.y) * iTime.z, 1.0);
}`;
const RING_FS = `
varying vec2 vUv; varying vec3 vColor; varying float vAge;
void main() {
  if (vAge < 0.0 || vAge > 1.0) discard;
  float r = length(vUv);
  if (r > 1.0) discard;
  float fade = 1.0 - vAge;
  float r1 = smoothstep(0.075, 0.0, abs(r - vAge));
  float r2 = smoothstep(0.06, 0.0, abs(r - vAge * 0.62)) * 0.55;
  float core = smoothstep(0.22, 0.0, r) * fade * fade;
  gl_FragColor = vec4(vColor * ((r1 + r2) * fade + core * 0.9), 1.0);
}`;

const SPIKE_VS = GLSL_PROJ + `
attribute vec2 iLL; attribute vec3 iColor; attribute vec3 iTime;
uniform float uTime; uniform float uWidth;
varying vec2 vUv; varying vec3 vColor; varying float vAge;
void main() {
  vAge = (uTime - iTime.x) / iTime.y;
  float a = clamp(vAge, 0.0, 1.0);
  vec3 n = projN(iLL);
  vec3 base = projLL(iLL, 0.3);
  float h = iTime.z * smoothstep(0.0, 0.15, a) * (1.0 - 0.35 * a);
  vec3 axis = base + n * h * position.y;
  vec3 sd = cross(n, cameraPosition - axis);
  float sl = length(sd);
  sd = sl > 0.00001 ? sd / sl : vec3(1.0, 0.0, 0.0);
  vUv = position.xy; vColor = iColor;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(axis + sd * position.x * uWidth * 0.9, 1.0);
}`;
const SPIKE_FS = `
uniform float uMorph;
varying vec2 vUv; varying vec3 vColor; varying float vAge;
void main() {
  if (vAge < 0.0 || vAge > 1.0) discard;
  float fade = (1.0 - vAge) * (1.0 - 0.75 * uMorph);
  float x = vUv.x;
  float y = vUv.y;
  float a = exp(-x * x * 5.0) * pow(1.0 - y, 1.4) * fade;
  vec3 col = vColor * a + vec3(1.0) * exp(-x * x * 30.0) * pow(1.0 - y, 3.0) * fade * 0.6;
  gl_FragColor = vec4(col, 1.0);
}`;

/* ----------------------------------------------------------------------------
 * createGlobeScene — renderer, layers, camera rig, picking, instanced effects
 * ------------------------------------------------------------------------- */
function createGlobeScene(container, hooks = {}) {
  const t0 = performance.now();
  const clock = () => (performance.now() - t0) / 1000;

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearColor(0x05070a, 1);
  const canvas = renderer.domElement;
  Object.assign(canvas.style, { display: "block", width: "100%", height: "100%", touchAction: "none", outline: "none", cursor: "grab" });
  container.appendChild(canvas);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, 1, 1, 6000);
  const U = {
    uMorph: { value: 0 }, uR: { value: R }, uTime: { value: 0 }, uWidth: { value: 1 },
    uHover: { value: -1 }, uSel: { value: -1 }, uPR: { value: renderer.getPixelRatio() },
  };
  const disposables = [];
  const track = (x) => { disposables.push(x); return x; };
  const vec3 = (hex) => new THREE.Vector3(...hexRgb(hex));
  const additive = { transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide };

  /* Ocean: lat/lng grid that is a sphere or a plane depending on uMorph */
  {
    const nx = 120, ny = 60, pos = [], idx = [];
    for (let j = 0; j <= ny; j++)
      for (let i = 0; i <= nx; i++) pos.push(-Math.PI + (2 * Math.PI * i) / nx, -Math.PI / 2 + (Math.PI * j) / ny, -0.6);
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        const a = j * (nx + 1) + i, b = a + 1, c = a + nx + 1, d = c + 1;
        idx.push(a, b, c, b, d, c);
      }
    const g = track(new THREE.BufferGeometry());
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    const m = track(new THREE.ShaderMaterial({
      vertexShader: OCEAN_VS, fragmentShader: OCEAN_FS, side: THREE.DoubleSide,
      uniforms: { uMorph: U.uMorph, uR: U.uR, uBase: { value: vec3("#070b10") }, uDot: { value: new THREE.Vector3(0.05, 0.2, 0.15) }, uRim: { value: vec3("#00ff9d") } },
    }));
    const mesh = new THREE.Mesh(g, m);
    mesh.frustumCulled = false;
    scene.add(mesh);
  }

  /* Atmosphere halo (globe only) */
  const atmoMat = track(new THREE.ShaderMaterial({
    vertexShader: ATMO_VS, fragmentShader: ATMO_FS,
    uniforms: { uColor: { value: new THREE.Vector3(0.0, 0.9, 0.62) }, uOpacity: { value: 1 } },
    side: THREE.BackSide, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false,
  }));
  const atmo = new THREE.Mesh(track(new THREE.SphereGeometry(R * 1.14, 64, 48)), atmoMat);
  scene.add(atmo);

  /* Starfield */
  {
    const n = 1400, pos = new Float32Array(n * 3), sz = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const u = Math.random() * 2 - 1, th = Math.random() * Math.PI * 2, r = 1600 + Math.random() * 1600, s = Math.sqrt(1 - u * u);
      pos[i * 3] = r * s * Math.cos(th);
      pos[i * 3 + 1] = r * u;
      pos[i * 3 + 2] = r * s * Math.sin(th);
      sz[i] = 0.8 + Math.random() * Math.random() * 2.4;
    }
    const g = track(new THREE.BufferGeometry());
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setAttribute("aSize", new THREE.BufferAttribute(sz, 1));
    const m = track(new THREE.ShaderMaterial({ vertexShader: STAR_VS, fragmentShader: STAR_FS, uniforms: { uTime: U.uTime, uPR: U.uPR }, ...additive }));
    const pts = new THREE.Points(g, m);
    pts.frustumCulled = false;
    scene.add(pts);
  }

  /* Instanced effect pools */
  function makePool(template, index, attrs, count, vs, fs, uniforms, order) {
    const g = track(new THREE.InstancedBufferGeometry());
    g.setAttribute("position", new THREE.Float32BufferAttribute(template, 3));
    g.setIndex(index);
    const a = {};
    for (const [name, size, init] of attrs) {
      const arr = new Float32Array(count * size);
      if (init) for (let i = 0; i < count; i++) arr.set(init, i * size);
      const attr = new THREE.InstancedBufferAttribute(arr, size);
      attr.setUsage(THREE.DynamicDrawUsage);
      g.setAttribute(name, attr);
      a[name] = attr;
    }
    g.instanceCount = count;
    const m = track(new THREE.ShaderMaterial({ vertexShader: vs, fragmentShader: fs, uniforms, ...additive }));
    const mesh = new THREE.Mesh(g, m);
    mesh.frustumCulled = false;
    mesh.renderOrder = order;
    scene.add(mesh);
    return a;
  }
  const DEAD = [-100000, 1, 0];
  const arcTpl = [], arcIdx = [];
  for (let i = 0; i <= ARC_SEG; i++) {
    const t = i / ARC_SEG;
    arcTpl.push(t, -1, 0, t, 1, 0);
    if (i < ARC_SEG) { const k = i * 2; arcIdx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2); }
  }
  const arcs = makePool(arcTpl, arcIdx, [["iStart", 2], ["iEnd", 2], ["iColor", 3], ["iTime", 3, DEAD]], MAX_ARCS, ARC_VS, ARC_FS,
    { uMorph: U.uMorph, uR: U.uR, uTime: U.uTime, uWidth: U.uWidth }, 3);
  const quad = [-1, -1, 0, 1, -1, 0, -1, 1, 0, 1, 1, 0];
  const rings = makePool(quad, [0, 1, 2, 1, 3, 2], [["iLL", 2], ["iColor", 3], ["iTime", 3, DEAD]], MAX_RINGS, RING_VS, RING_FS,
    { uMorph: U.uMorph, uR: U.uR, uTime: U.uTime }, 2);
  const spikeTpl = [-1, 0, 0, 1, 0, 0, -1, 1, 0, 1, 1, 0];
  const spikes = makePool(spikeTpl, [0, 1, 2, 1, 3, 2], [["iLL", 2], ["iColor", 3], ["iTime", 3, DEAD]], MAX_SPIKES, SPIKE_VS, SPIKE_FS,
    { uMorph: U.uMorph, uR: U.uR, uTime: U.uTime, uWidth: U.uWidth }, 4);

  const arcFree = new Float64Array(MAX_ARCS).fill(-1);
  const impacts = [];
  let ringHead = 0, spikeHead = 0, arcDirty = false, ringDirty = false, spikeDirty = false;

  function spawnRing(lng, lat, rgb, now, dur, size) {
    const i = ringHead;
    ringHead = (ringHead + 1) % MAX_RINGS;
    rings.iLL.array[i * 2] = lng;
    rings.iLL.array[i * 2 + 1] = lat;
    rings.iColor.array.set(rgb, i * 3);
    rings.iTime.array[i * 3] = now;
    rings.iTime.array[i * 3 + 1] = dur;
    rings.iTime.array[i * 3 + 2] = size;
    ringDirty = true;
  }
  function spawnSpike(lng, lat, rgb, now) {
    const i = spikeHead;
    spikeHead = (spikeHead + 1) % MAX_SPIKES;
    spikes.iLL.array[i * 2] = lng;
    spikes.iLL.array[i * 2 + 1] = lat;
    spikes.iColor.array.set(rgb, i * 3);
    spikes.iTime.array[i * 3] = now;
    spikes.iTime.array[i * 3 + 1] = 1.1;
    spikes.iTime.array[i * 3 + 2] = 7 + Math.random() * 7;
    spikeDirty = true;
  }

  /* Claims a free GPU slot for a laser; returns false when all 80 are in flight. */
  function launch(ev, now) {
    let slot = -1;
    for (let i = 0; i < MAX_ARCS; i++) if (arcFree[i] <= now) { slot = i; break; }
    if (slot < 0) return false;
    const frac = ev.d / Math.PI;
    const dur = 0.95 + 1.15 * frac;
    arcFree[slot] = now + dur * (1 + BOLT_LEN) + 0.7;
    const rgb = RGB[ev.v];
    arcs.iStart.array[slot * 2] = ev.lng1 * D2R;
    arcs.iStart.array[slot * 2 + 1] = ev.lat1 * D2R;
    arcs.iEnd.array[slot * 2] = ev.lng2 * D2R;
    arcs.iEnd.array[slot * 2 + 1] = ev.lat2 * D2R;
    arcs.iColor.array.set(rgb, slot * 3);
    arcs.iTime.array[slot * 3] = now;
    arcs.iTime.array[slot * 3 + 1] = dur;
    arcs.iTime.array[slot * 3 + 2] = R * (0.05 + 0.34 * frac);
    arcDirty = true;
    spawnRing(ev.lng1 * D2R, ev.lat1 * D2R, rgb, now, 0.75, 1.8);
    impacts.push({ at: now + dur, lat: ev.lat2, lng: ev.lng2, v: ev.v, iso: ev.t, rgb });
    return true;
  }
  const activeArcs = () => {
    const now = clock();
    let n = 0;
    for (let i = 0; i < MAX_ARCS; i++) if (arcFree[i] > now) n++;
    return n;
  };

  /* Countries */
  let countries = [], land = null, borders = null, heatTex = null, heatData = null;
  function disposeCountries() {
    for (const obj of [land, borders]) {
      if (!obj) continue;
      scene.remove(obj);
      obj.geometry.dispose();
      obj.material.dispose();
    }
    if (heatTex) heatTex.dispose();
    land = borders = heatTex = null;
  }
  function setCountries(list) {
    disposeCountries();
    countries = list;
    const buf = buildCountryBuffers(list);
    const N = Math.max(1, list.length);
    heatData = new Uint8Array(N * 4);
    heatTex = new THREE.DataTexture(heatData, N, 1, THREE.RGBAFormat);
    heatTex.needsUpdate = true;
    const lg = new THREE.BufferGeometry();
    lg.setAttribute("position", new THREE.BufferAttribute(buf.pos, 3));
    lg.setAttribute("aCid", new THREE.BufferAttribute(buf.cid, 1));
    const lm = new THREE.ShaderMaterial({
      vertexShader: LAND_VS, fragmentShader: LAND_FS, side: THREE.DoubleSide,
      uniforms: {
        uMorph: U.uMorph, uR: U.uR, uHover: U.uHover, uSel: U.uSel, uTime: U.uTime,
        uHeat: { value: heatTex }, uN: { value: N },
        uLand: { value: vec3(C.land) }, uHot: { value: vec3(C.hot) }, uNeon: { value: vec3(C.neon) },
      },
    });
    land = new THREE.Mesh(lg, lm);
    land.frustumCulled = false;
    land.renderOrder = 1;
    scene.add(land);
    const bg = new THREE.BufferGeometry();
    bg.setAttribute("position", new THREE.BufferAttribute(buf.bpos, 3));
    bg.setAttribute("aCid", new THREE.BufferAttribute(buf.bcid, 1));
    const bm = new THREE.ShaderMaterial({
      vertexShader: BORDER_VS, fragmentShader: BORDER_FS,
      uniforms: { uMorph: U.uMorph, uR: U.uR, uHover: U.uHover, uSel: U.uSel, uBorder: { value: vec3(C.border) }, uNeon: { value: vec3(C.neon) } },
    });
    borders = new THREE.LineSegments(bg, bm);
    borders.frustumCulled = false;
    borders.renderOrder = 1;
    scene.add(borders);
    return { triangles: buf.pos.length / 9, segments: buf.bpos.length / 6 };
  }
  function setHeat(map) {
    if (!heatData) return;
    for (const c of countries) heatData[c.idx * 4] = Math.round(clamp(map[c.iso] || 0, 0, 1) * 255);
    heatTex.needsUpdate = true;
  }
  function setSelectedIso(iso) {
    const c = iso ? countries.find((x) => x.iso === iso) : null;
    U.uSel.value = c ? c.idx : -1;
  }

  /* Camera rig: one (lat, lng, zoom) state drives both the orbit and the flat pan */
  const cam = {
    lat: 18 * D2R, lng: 78 * D2R, zoom: 1.15, tLat: 18 * D2R, tLng: 78 * D2R, tZoom: 1,
    vLat: 0, vLng: 0, mLin: 0, mTarget: 0, flyUntil: 0, lastInteract: -100, demo: false, reduced: false,
  };
  const tmpA = new THREE.Vector3(), tmpB = new THREE.Vector3(), tmpC = new THREE.Vector3();
  const TAN = Math.tan(22.5 * D2R);
  const isFlat = () => cam.mTarget > 0.5;

  function updateCamera(now, dt) {
    const flat = isFlat();
    const step = dt * 0.8;
    cam.mLin += clamp(cam.mTarget - cam.mLin, -step, step);
    const x = cam.mLin;
    U.uMorph.value = x * x * x * (x * (x * 6 - 15) + 10);
    const flying = now < cam.flyUntil;
    if (!flat && !drag.active && !flying && (cam.demo || (!cam.reduced && now - cam.lastInteract > 5)))
      cam.tLng += dt * (cam.demo ? 0.1 : 0.03);
    if (!drag.active && (cam.vLng || cam.vLat)) {
      cam.tLng += cam.vLng * dt;
      cam.tLat += cam.vLat * dt;
      const f = Math.exp(-dt * 4);
      cam.vLng *= f;
      cam.vLat *= f;
      if (Math.abs(cam.vLng) + Math.abs(cam.vLat) < 1e-4) cam.vLng = cam.vLat = 0;
    }
    cam.tZoom = clamp(cam.tZoom, flat ? 0.22 : 0.42, flat ? 1.3 : 2.0);
    if (flat) {
      const visH = 560 * cam.zoom * TAN, visW = visH * camera.aspect;
      const limLat = Math.max(0, (R * Math.PI) / 2 - visH * 0.55) / R;
      const limLng = Math.max(0, R * Math.PI - visW * 0.55) / R;
      cam.tLat = clamp(cam.tLat, -limLat, limLat);
      cam.tLng = clamp(cam.tLng, -limLng, limLng);
    } else cam.tLat = clamp(cam.tLat, -80 * D2R, 84 * D2R);
    const k = 1 - Math.exp(-dt * (flying ? 2.6 : drag.active ? 18 : 7));
    cam.lat += (cam.tLat - cam.lat) * k;
    cam.lng += (flat ? cam.tLng - cam.lng : wrapPi(cam.tLng - cam.lng)) * k;
    cam.zoom += (cam.tZoom - cam.zoom) * (1 - Math.exp(-dt * 6));
    if (!flat) {
      const w = cam.lng - wrapPi(cam.lng);
      cam.lng -= w;
      cam.tLng -= w;
    }
    const m = U.uMorph.value;
    const dG = 340 * cam.zoom, dF = 560 * cam.zoom, cl = Math.cos(cam.lat);
    tmpA.set(dG * cl * Math.sin(cam.lng), dG * Math.sin(cam.lat), dG * cl * Math.cos(cam.lng));
    tmpB.set(cam.lng * R, cam.lat * R, dF);
    camera.position.lerpVectors(tmpA, tmpB, m);
    tmpC.set(cam.lng * R * m, cam.lat * R * m, 0);
    camera.up.set(0, 1, 0);
    camera.lookAt(tmpC);
    U.uWidth.value = (0.95 * camera.position.distanceTo(tmpC)) / 340;
  }

  function flyTo(lat, lng, zoom) {
    const now = clock();
    cam.tLat = lat * D2R;
    cam.tLng = isFlat() ? wrapPi(lng * D2R) : cam.lng + wrapPi(lng * D2R - cam.lng);
    if (zoom) cam.tZoom = zoom;
    cam.vLat = cam.vLng = 0;
    cam.flyUntil = now + 2.4;
    cam.lastInteract = now;
  }
  function setProjection(mode) {
    const now = clock();
    if (mode === "flat") {
      cam.lng = wrapPi(cam.lng);
      cam.tLng = wrapPi(cam.tLng);
      cam.mTarget = 1;
      cam.tZoom = clamp(cam.tZoom, 0.22, 1.3);
    } else {
      cam.mTarget = 0;
      if (mode === "polar") {
        cam.tLat = 84 * D2R;
        cam.tZoom = Math.max(cam.tZoom, 1.05);
        cam.flyUntil = now + 2.4;
      } else if (cam.tLat > 70 * D2R) {
        cam.tLat = 22 * D2R;
        cam.flyUntil = now + 2.4;
      }
    }
    cam.lastInteract = now;
  }
  const zoomBy = (f) => { cam.tZoom *= f; cam.lastInteract = clock(); };

  /* Picking: analytic ray vs sphere / plane, then point-in-polygon on lng/lat */
  const ray = new THREE.Vector3(), hit = new THREE.Vector3();
  function pickLL(x, y) {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return null;
    const m = U.uMorph.value;
    ray.set((x / w) * 2 - 1, -(y / h) * 2 + 1, 0.5).unproject(camera).sub(camera.position).normalize();
    const o = camera.position;
    if (m < 0.01) {
      const b = o.dot(ray), c = o.lengthSq() - R * R, disc = b * b - c;
      if (disc < 0) return null;
      const t = -b - Math.sqrt(disc);
      if (t < 0) return null;
      hit.copy(o).addScaledVector(ray, t);
      return [Math.asin(clamp(hit.y / R, -1, 1)) * R2D, Math.atan2(hit.x, hit.z) * R2D];
    }
    if (m > 0.99 && Math.abs(ray.z) > 1e-6) {
      const t = -o.z / ray.z;
      if (t < 0) return null;
      hit.copy(o).addScaledVector(ray, t);
      const lng = (hit.x / R) * R2D, lat = (hit.y / R) * R2D;
      return Math.abs(lng) > 180 || Math.abs(lat) > 90 ? null : [lat, lng];
    }
    return null;
  }
  const pickAt = (x, y) => {
    const ll = pickLL(x, y);
    return ll ? findCountryAt(countries, ll[1], ll[0]) : null;
  };

  /* Pointer / wheel / pinch input */
  const drag = { active: false, x: 0, y: 0, moved: 0, lastT: 0 };
  const pointers = new Map();
  let pinch = null;
  const hover = { x: 0, y: 0, inside: false, dirty: false, idx: -1 };
  const rel = (e) => {
    const r = canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };
  function onDown(e) {
    if (e.button !== undefined && e.button !== 0 && e.pointerType === "mouse") return;
    if (canvas.setPointerCapture) { try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ } }
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const now = clock();
    cam.lastInteract = now;
    cam.flyUntil = 0;
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, z: cam.tZoom };
      drag.active = false;
      return;
    }
    drag.active = true;
    drag.x = e.clientX;
    drag.y = e.clientY;
    drag.moved = 0;
    drag.lastT = now;
    cam.vLat = cam.vLng = 0;
    cam.tLat = cam.lat;
    cam.tLng = cam.lng;
    canvas.style.cursor = "grabbing";
  }
  function onMove(e) {
    const [x, y] = rel(e);
    hover.x = x;
    hover.y = y;
    hover.inside = true;
    hover.dirty = true;
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const now = clock();
    if (pinch && pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      cam.tZoom = (pinch.z * pinch.d) / Math.max(10, Math.hypot(a.x - b.x, a.y - b.y));
      cam.lastInteract = now;
      return;
    }
    if (!drag.active) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    drag.x = e.clientX;
    drag.y = e.clientY;
    drag.moved += Math.abs(dx) + Math.abs(dy);
    const h = canvas.clientHeight || 1;
    const radPerPx = isFlat()
      ? (2 * 560 * cam.zoom * TAN) / h / R
      : (2 * Math.max(40, 340 * cam.zoom - R * 0.8) * TAN) / h / R;
    cam.tLng -= dx * radPerPx;
    cam.tLat += dy * radPerPx;
    const dtm = Math.max(0.008, now - drag.lastT);
    drag.lastT = now;
    cam.vLng = clamp(cam.vLng * 0.5 + 0.5 * ((-dx * radPerPx) / dtm), -3, 3);
    cam.vLat = clamp(cam.vLat * 0.5 + 0.5 * ((dy * radPerPx) / dtm), -3, 3);
    cam.lastInteract = now;
  }
  function onUp(e) {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = null;
    if (!drag.active) return;
    drag.active = false;
    canvas.style.cursor = hover.idx >= 0 ? "pointer" : "grab";
    if (clock() - drag.lastT > 0.08) cam.vLng = cam.vLat = 0;
    if (e.type === "pointerup" && drag.moved < 6) {
      cam.vLng = cam.vLat = 0;
      const [x, y] = rel(e);
      const c = pickAt(x, y);
      if (c && hooks.onSelect) hooks.onSelect(c.iso);
    }
  }
  function onLeave() {
    hover.inside = false;
    hover.dirty = true;
  }
  function onWheel(e) {
    e.preventDefault();
    cam.tZoom *= Math.exp(e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0016));
    cam.lastInteract = clock();
  }
  canvas.addEventListener("pointerdown", onDown);
  canvas.addEventListener("pointermove", onMove);
  canvas.addEventListener("pointerup", onUp);
  canvas.addEventListener("pointercancel", onUp);
  canvas.addEventListener("pointerleave", onLeave);
  canvas.addEventListener("wheel", onWheel, { passive: false });

  /* Resize */
  function resize() {
    const w = container.clientWidth, h = container.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  let ro = null;
  if (typeof ResizeObserver !== "undefined") {
    ro = new ResizeObserver(resize);
    ro.observe(container);
  } else window.addEventListener("resize", resize);
  resize();

  /* Per-frame update: camera → impacts → buffer flush → hover pick → render */
  let frameNo = 0;
  function frame(now, dt) {
    frameNo++;
    U.uTime.value = now;
    updateCamera(now, dt);
    camera.updateMatrixWorld();
    for (let i = impacts.length - 1; i >= 0; i--) {
      const im = impacts[i];
      if (im.at > now) continue;
      const lng = im.lng * D2R, lat = im.lat * D2R;
      spawnRing(lng, lat, im.rgb, now, 1.35, 4.4);
      spawnSpike(lng, lat, im.rgb, now);
      if (hooks.onImpact) hooks.onImpact(im);
      impacts[i] = impacts[impacts.length - 1];
      impacts.pop();
    }
    if (arcDirty) { for (const k in arcs) arcs[k].needsUpdate = true; arcDirty = false; }
    if (ringDirty) { for (const k in rings) rings[k].needsUpdate = true; ringDirty = false; }
    if (spikeDirty) { for (const k in spikes) spikes[k].needsUpdate = true; spikeDirty = false; }
    const m = U.uMorph.value;
    atmoMat.uniforms.uOpacity.value = 1 - m;
    atmo.visible = m < 0.97;
    if (hover.inside && !drag.active && frameNo % 8 === 0) hover.dirty = true;
    if (hover.dirty) {
      hover.dirty = false;
      const c = hover.inside && !drag.active && !pinch ? pickAt(hover.x, hover.y) : null;
      hover.idx = c ? c.idx : -1;
      U.uHover.value = hover.idx;
      if (!drag.active) canvas.style.cursor = c ? "pointer" : "grab";
      if (hooks.onHover) hooks.onHover(c, hover.x, hover.y);
    }
    renderer.render(scene, camera);
  }

  function dispose() {
    if (ro) ro.disconnect();
    else window.removeEventListener("resize", resize);
    canvas.removeEventListener("pointerdown", onDown);
    canvas.removeEventListener("pointermove", onMove);
    canvas.removeEventListener("pointerup", onUp);
    canvas.removeEventListener("pointercancel", onUp);
    canvas.removeEventListener("pointerleave", onLeave);
    canvas.removeEventListener("wheel", onWheel);
    disposeCountries();
    for (const d of disposables) if (d && d.dispose) d.dispose();
    renderer.dispose();
    if (renderer.forceContextLoss) renderer.forceContextLoss();
    if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
  }

  return {
    clock, frame, launch, activeArcs, setCountries, setHeat, setSelectedIso, flyTo, zoomBy, setProjection, dispose,
    setDemo: (on) => { cam.demo = on; },
    setReducedMotion: (on) => { cam.reduced = on; },
    camLng: () => cam.lng,
  };
}

/* ----------------------------------------------------------------------------
 * HUD styles (Tailwind handles layout; theme lives here so the artifact
 * sandbox, which only ships core Tailwind utilities, renders identically)
 * ------------------------------------------------------------------------- */
const CORNER = "linear-gradient(#00ff9d, #00ff9d)";
const CSS = `
@import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;700&family=Share+Tech+Mono&display=swap');
.ctm-root { font-family: ${MONO}; color: ${C.text}; -webkit-font-smoothing: antialiased; }
.ctm-root *, .ctm-root *::before, .ctm-root *::after { box-sizing: border-box; }
.ctm-root button, .ctm-root input, .ctm-root select { font-family: inherit; }
.ctm-root button:focus-visible, .ctm-root input:focus-visible, .ctm-root select:focus-visible { outline: 1px solid ${C.neon}; outline-offset: 2px; }
.ctm-num { font-variant-numeric: tabular-nums; }
.ctm-panel:not(.absolute) { position: relative; }
.ctm-panel { background: rgba(6, 10, 14, 0.8); border: 1px solid rgba(0, 255, 157, 0.14); backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px); }
.ctm-frame::after { content: ""; position: absolute; inset: -1px; pointer-events: none; opacity: 0.85;
  background:
    ${CORNER} left top / 10px 1px no-repeat, ${CORNER} left top / 1px 10px no-repeat,
    ${CORNER} right top / 10px 1px no-repeat, ${CORNER} right top / 1px 10px no-repeat,
    ${CORNER} left bottom / 10px 1px no-repeat, ${CORNER} left bottom / 1px 10px no-repeat,
    ${CORNER} right bottom / 10px 1px no-repeat, ${CORNER} right bottom / 1px 10px no-repeat; }
.ctm-label { font-size: 9.5px; letter-spacing: 0.16em; color: ${C.dim}; text-transform: uppercase; }
.ctm-hint { font-size: 10.5px; line-height: 1.5; color: ${C.dim}; margin-top: 4px; }
.ctm-dot { position: relative; display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: currentColor; flex-shrink: 0; }
.ctm-dot::after { content: ""; position: absolute; inset: -5px; border-radius: 50%; border: 1px solid currentColor; animation: ctm-ping 1.6s ease-out infinite; }
@keyframes ctm-ping { from { transform: scale(0.35); opacity: 0.9; } to { transform: scale(1.3); opacity: 0; } }
.ctm-tab { display: inline-flex; align-items: center; gap: 6px; height: 30px; padding: 0 10px; font-size: 10.5px; letter-spacing: 0.16em; color: ${C.dim}; background: transparent; border: 0; border-bottom: 1px solid transparent; cursor: pointer; white-space: nowrap; transition: color .15s, border-color .15s; }
.ctm-tab:hover { color: ${C.ice}; }
.ctm-tab[data-active="true"] { color: ${C.neon}; border-bottom-color: ${C.neon}; }
.ctm-badge { display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 10px; border: 1px solid rgba(0, 255, 157, 0.28); background: rgba(0, 255, 157, 0.05); font-size: 10px; letter-spacing: 0.14em; color: ${C.dim}; white-space: nowrap; }
.ctm-badge b { color: ${C.neon}; font-weight: 500; font-size: 12.5px; letter-spacing: 0.04em; min-width: 2ch; text-align: right; }
.ctm-cta { display: inline-flex; align-items: center; gap: 8px; height: 30px; padding: 0 12px; border: 1px solid #10b981; background: rgba(16, 185, 129, 0.16); color: #6ee7b7; font-size: 11px; letter-spacing: 0.04em; cursor: pointer; white-space: nowrap; transition: background .15s, box-shadow .15s; }
.ctm-cta:hover { background: rgba(16, 185, 129, 0.28); box-shadow: 0 0 18px rgba(16, 185, 129, 0.3); color: #d1fae5; }
.ctm-ibtn { display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; padding: 0; color: ${C.text}; background: transparent; border: 1px solid transparent; cursor: pointer; transition: color .15s, border-color .15s, background .15s; }
.ctm-ibtn:hover { color: ${C.neon}; border-color: rgba(0, 255, 157, 0.3); }
.ctm-ibtn[data-active="true"] { color: ${C.neon}; border-color: rgba(0, 255, 157, 0.45); background: rgba(0, 255, 157, 0.08); }
.ctm-dbtn { width: 40px; height: 36px; }
.ctm-vec { display: flex; flex-direction: column; align-items: center; flex-shrink: 0; background: transparent; border: 0; padding: 0; cursor: pointer; transition: opacity .2s; }
.ctm-vec-box { width: 66px; height: 30px; display: flex; align-items: center; justify-content: center; font-family: ${DISPLAY}; font-size: 13px; letter-spacing: 0.22em; padding-left: 0.22em; background: rgba(5, 7, 10, 0.72); transition: box-shadow .2s, transform .15s; }
.ctm-vec:hover .ctm-vec-box { transform: translateY(-2px); }
.ctm-input { flex: 1; min-width: 0; height: 100%; background: transparent; border: 0; outline: none; color: ${C.ice}; font-size: 11.5px; }
.ctm-input::placeholder, .ctm-field::placeholder { color: ${C.dim}; }
.ctm-field { width: 100%; height: 34px; padding: 0 10px; margin-top: 4px; background: rgba(5, 7, 10, 0.7); border: 1px solid rgba(0, 255, 157, 0.2); color: ${C.ice}; font-size: 12px; }
.ctm-option { display: flex; width: 100%; justify-content: space-between; gap: 8px; padding: 6px 10px; font-size: 11.5px; color: ${C.text}; background: transparent; border: 0; text-align: left; cursor: pointer; }
.ctm-option:hover { background: rgba(0, 255, 157, 0.08); color: ${C.ice}; }
.ctm-link { display: inline-flex; align-items: center; gap: 4px; background: transparent; border: 0; color: ${C.neon}; font-size: 11px; cursor: pointer; padding: 0; }
.ctm-btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; height: 32px; padding: 0 14px; font-size: 11px; letter-spacing: 0.04em; border: 1px solid rgba(0, 255, 157, 0.4); background: rgba(0, 255, 157, 0.08); color: ${C.neon}; cursor: pointer; }
.ctm-btn:hover { background: rgba(0, 255, 157, 0.16); }
.ctm-btn[disabled] { opacity: 0.5; cursor: default; }
.ctm-btn-ghost { border-color: rgba(183, 202, 212, 0.25); background: transparent; color: ${C.text}; }
.ctm-btn-ghost:hover { background: rgba(183, 202, 212, 0.08); }
.ctm-scroll { scrollbar-width: thin; scrollbar-color: rgba(0, 255, 157, 0.25) transparent; }
.ctm-scroll::-webkit-scrollbar { width: 6px; height: 6px; }
.ctm-scroll::-webkit-scrollbar-thumb { background: rgba(0, 255, 157, 0.25); }
.ctm-scan { background: repeating-linear-gradient(0deg, rgba(255, 255, 255, 0.022) 0px, rgba(255, 255, 255, 0.022) 1px, transparent 1px, transparent 3px); }
.ctm-vignette { background: radial-gradient(ellipse at center, rgba(5, 7, 10, 0) 52%, rgba(2, 3, 5, 0.72) 100%); }
.ctm-tip { position: absolute; left: 0; top: 0; z-index: 25; pointer-events: none; opacity: 0; padding: 6px 9px; min-width: 120px; background: rgba(6, 10, 14, 0.92); border: 1px solid rgba(0, 255, 157, 0.3); transition: opacity .12s; will-change: transform; }
.ctm-range { width: 100%; accent-color: ${C.neon}; }
.ctm-toast { position: absolute; left: 50%; bottom: 100px; transform: translateX(-50%); z-index: 45; padding: 8px 14px; font-size: 11.5px; color: ${C.ice}; background: rgba(6, 10, 14, 0.94); border: 1px solid rgba(0, 255, 157, 0.35); white-space: nowrap; }
.ctm-modal-bg { background: rgba(2, 4, 6, 0.62); }
.ctm-table th, .ctm-table td { padding: 6px 8px; text-align: left; font-weight: 400; vertical-align: top; }
.ctm-boot-bar { animation: ctm-boot 1.2s ease-in-out infinite; }
@keyframes ctm-boot { from { transform: translateX(-100%); } to { transform: translateX(250%); } }
@media (prefers-reduced-motion: reduce) {
  .ctm-dot::after, .ctm-boot-bar { animation: none; }
  .ctm-vec-box, .ctm-tip, .ctm-tab, .ctm-ibtn { transition: none; }
}
`;

const TABS = [
  { id: "map", label: "MAP", icon: Globe },
  { id: "stats", label: "STATISTICS", icon: Activity },
  { id: "sources", label: "DATA SOURCES", icon: Database },
  { id: "api", label: "API CONFIG", icon: KeyRound },
];
const EMPTY_HUD = {
  aps: 0, session: 0, global: zeroVec(), total: 0, sel: null, topTargets: [], topOrigins: [], recent: [],
  vShare: zeroVec(), l7Total: 0.45, mode: "baseline", label: "", fetchedAt: null, version: 0, arcs: 0,
};

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (e) {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      return ok;
    } catch (err) {
      return false;
    }
  }
}
function downloadJSON(name, data) {
  try {
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    return true;
  } catch (e) {
    return false;
  }
}
const timeOf = (ms) => (ms ? new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "");

/* ----------------------------------------------------------------------------
 * Small presentational pieces
 * ------------------------------------------------------------------------- */
function IconBtn({ title, onClick, active, className = "", children }) {
  return (
    <button type="button" title={title} aria-label={title} onClick={onClick}
      className={`ctm-ibtn ${className}`} data-active={active ? "true" : "false"}>
      {children}
    </button>
  );
}
function Bar({ value, color }) {
  return (
    <span className="flex-1" style={{ position: "relative", height: 3, minWidth: 30, background: "rgba(255,255,255,0.06)" }}>
      <span style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: `${clamp(value || 0, 0, 1) * 100}%`, background: color, boxShadow: `0 0 6px ${color}`, opacity: 0.8 }} />
    </span>
  );
}
function Divider() {
  return <span style={{ width: 24, height: 1, background: "rgba(0,255,157,0.18)", margin: "3px 0" }} />;
}
function Sparkline({ data, color }) {
  const W = 268, H = 46;
  if (!data || data.length < 2) {
    return <div className="ctm-hint" style={{ height: H, display: "flex", alignItems: "center" }}>Collecting per-second samples…</div>;
  }
  const max = Math.max(1, ...data);
  const step = W / Math.max(1, data.length - 1);
  const pts = data.map((v, i) => `${(i * step).toFixed(1)},${(H - 2 - (v / max) * (H - 6)).toFixed(1)}`).join(" ");
  return (
    <svg width="100%" height={H} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-label="Incoming lasers per second">
      <polygon points={`0,${H} ${pts} ${((data.length - 1) * step).toFixed(1)},${H}`} fill={color} opacity="0.12" />
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.3" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/* ----------------------------------------------------------------------------
 * Header
 * ------------------------------------------------------------------------- */
function Header({ tab, onTab, hud, onCta }) {
  const live = hud.mode === "cloudflare";
  const accent = live ? C.cyan : C.neon;
  return (
    <header className="absolute left-0 right-0 top-0 z-30 flex items-center justify-between gap-3 px-3"
      style={{ height: 56, background: "linear-gradient(180deg, rgba(5,7,10,0.96) 0%, rgba(5,7,10,0.7) 65%, rgba(5,7,10,0) 100%)" }}>
      <div className="flex items-center gap-4 min-w-0">
        <div className="min-w-0">
          <h1 className="truncate" style={{ margin: 0, fontFamily: DISPLAY, fontWeight: 400, fontSize: 16, letterSpacing: "0.24em", color: C.ice }}>
            CYBERTHREAT LIVE MAP
          </h1>
          <div className="flex items-center gap-2" style={{ fontSize: 9.5, letterSpacing: "0.18em", color: accent, marginTop: 3 }}>
            <span className="ctm-dot" />
            <span className="truncate">{live ? "CLOUDFLARE RADAR API" : "LIVE STREAM REGENERATOR"}</span>
          </div>
        </div>
        <nav className="flex items-center" aria-label="Views">
          {TABS.map((t) => {
            const Icon = t.icon;
            return (
              <button key={t.id} type="button" className="ctm-tab" data-active={tab === t.id ? "true" : "false"} onClick={() => onTab(t.id)} title={t.label}>
                <Icon size={13} />
                <span className="hidden lg:inline">{t.label}</span>
              </button>
            );
          })}
        </nav>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <div className="ctm-badge" title="Laser events in the last second">
          <Zap size={12} color={C.neon} />
          <span>APS</span>
          <b className="ctm-num">{hud.aps}</b>
        </div>
        <div className="ctm-badge hidden md:flex" title="Laser events since this page opened">
          <Radio size={12} />
          <span>SESSION</span>
          <b className="ctm-num">{fmt(hud.session)}</b>
        </div>
        <button type="button" className="ctm-cta" onClick={onCta} title="Protect Yourself / Configure API">
          <ShieldCheck size={14} />
          <span className="hidden sm:inline">Protect Yourself / Configure API</span>
        </button>
      </div>
    </header>
  );
}

/* ----------------------------------------------------------------------------
 * Country search + inspector
 * ------------------------------------------------------------------------- */
function CountrySearch({ countries, onPick, placeholder }) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const results = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return countries.slice(0, 8);
    return countries.filter((c) => c.name.toLowerCase().includes(s) || c.iso.toLowerCase() === s).slice(0, 8);
  }, [q, countries]);
  const pick = (iso) => {
    onPick(iso);
    setQ("");
    setOpen(false);
  };
  return (
    <div className="relative">
      <div className="ctm-panel flex items-center gap-2 px-2" style={{ height: 32 }}>
        <Search size={13} color={C.dim} />
        <input
          value={q}
          onChange={(e) => { setQ(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && results[0]) { pick(results[0].iso); e.currentTarget.blur(); }
            if (e.key === "Escape") { setOpen(false); e.currentTarget.blur(); }
          }}
          placeholder={placeholder}
          aria-label="Search country"
          className="ctm-input"
        />
      </div>
      {open && results.length > 0 && (
        <div className="absolute left-0 right-0 z-40 ctm-scroll" style={{ top: 34, maxHeight: 248, overflowY: "auto", background: "rgba(6,10,14,0.97)", border: "1px solid rgba(0,255,157,0.22)" }}>
          {results.map((c) => (
            <button key={c.iso} type="button" className="ctm-option" onMouseDown={(e) => { e.preventDefault(); pick(c.iso); }}>
              <span className="truncate">{c.name}</span>
              <span style={{ color: C.dim }}>{c.iso}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function Inspector({ info, selected, countries, onPick, onClose, onRefresh, onShare, onExport, more, setMore, collapsed, setCollapsed }) {
  const maxV = info ? Math.max(1, ...VEC_IDS.map((v) => info.counts[v] || 0)) : 1;
  const peak = info && info.hist.length ? Math.max(...info.hist) : 0;
  return (
    <aside className="absolute z-20 flex flex-col gap-2" style={{ left: 12, top: 64, width: "min(300px, calc(100% - 84px))" }} aria-label="Country inspector">
      <CountrySearch countries={countries} onPick={onPick} placeholder={selected ? "Jump to another country" : "Search a country to inspect"} />
      {info && (
        <div className="ctm-panel ctm-frame">
          <div className="flex items-start justify-between gap-2" style={{ padding: "12px 10px 0 16px" }}>
            <h2 className="min-w-0" style={{ margin: 0, fontFamily: DISPLAY, fontWeight: 400, fontSize: 22, letterSpacing: "0.14em", color: C.ice, lineHeight: 1.15, wordBreak: "break-word" }}>
              {info.name.toUpperCase()}
            </h2>
            <div className="flex shrink-0">
              <IconBtn title="Refresh and re-center" onClick={onRefresh}><RefreshCw size={14} /></IconBtn>
              <IconBtn title={collapsed ? "Expand panel" : "Collapse panel"} onClick={() => setCollapsed(!collapsed)}>
                {collapsed ? <ChevronDown size={15} /> : <ChevronUp size={15} />}
              </IconBtn>
              <IconBtn title="Close" onClick={onClose}><X size={15} /></IconBtn>
            </div>
          </div>
          <div className="flex items-baseline gap-2" style={{ margin: "10px 16px 0", padding: "5px 10px", width: "fit-content", border: "1px solid rgba(0,255,157,0.35)", background: "rgba(0,255,157,0.06)" }}>
            <span style={{ color: C.neon, fontSize: 12 }}>#</span>
            <span className="ctm-num" style={{ color: C.neon, fontFamily: DISPLAY, fontSize: 22, lineHeight: 1 }}>{info.rank || "–"}</span>
            <span style={{ fontSize: 10, letterSpacing: "0.16em", color: C.ice }}>MOST-ATTACKED COUNTRY</span>
          </div>
          {!collapsed && (
            <>
              <div style={{ padding: "12px 16px 8px" }}>
                {VECTORS.map((v) => {
                  const n = info.counts[v.id] || 0;
                  return (
                    <div key={v.id} className="flex items-center gap-3" style={{ height: 24 }} title={`${v.label}: ${v.desc}`}>
                      <span style={{ width: 34, color: v.color, fontFamily: DISPLAY, letterSpacing: "0.12em", fontSize: 12.5 }}>{v.id}</span>
                      <Bar value={n / maxV} color={v.color} />
                      <span className="ctm-num" style={{ minWidth: 92, textAlign: "right", color: C.ice, fontSize: 12.5 }}>{fmt(n)}</span>
                    </div>
                  );
                })}
              </div>
              <div style={{ padding: "8px 16px 10px", borderTop: "1px solid rgba(0,255,157,0.1)" }}>
                <div className="ctm-hint" style={{ marginTop: 0 }}>Detections regenerated since 00:00 GMT</div>
                <div className="ctm-hint" style={{ marginTop: 1 }}>
                  Inbound now <span className="ctm-num" style={{ color: C.text }}>{fmtK(info.rate)}</span> detections/s
                </div>
                <div className="flex items-center justify-between" style={{ marginTop: 8 }}>
                  <button type="button" className="ctm-link" onClick={() => setMore(!more)} aria-expanded={more}>
                    {more ? <ChevronUp size={13} /> : <ChevronDown size={13} />} More details
                  </button>
                  <div className="flex gap-1">
                    <IconBtn title="Copy summary" onClick={onShare}><Share2 size={14} /></IconBtn>
                    <IconBtn title="Export JSON" onClick={onExport}><Download size={14} /></IconBtn>
                  </div>
                </div>
              </div>
              {more && (
                <div style={{ padding: "10px 16px 14px", borderTop: "1px solid rgba(0,255,157,0.1)" }}>
                  <div className="flex justify-between ctm-label" style={{ marginBottom: 4 }}>
                    <span>Inbound lasers per second</span>
                    <span>peak {peak}</span>
                  </div>
                  <Sparkline data={info.hist} color={C.neon} />
                  <div className="flex justify-between ctm-label" style={{ marginTop: 12, marginBottom: 4 }}>
                    <span>Likely origins</span>
                    <span>share / seen</span>
                  </div>
                  {info.origins.map((o) => (
                    <div key={o.iso} className="flex items-center gap-2" style={{ height: 21, fontSize: 11 }}>
                      <span className="truncate" style={{ width: 104, color: C.ice }}>{o.name}</span>
                      <Bar value={o.share / (info.origins[0] ? info.origins[0].share : 1)} color={C.hot} />
                      <span className="ctm-num" style={{ width: 40, textAlign: "right" }}>{(o.share * 100).toFixed(1)}%</span>
                      <span className="ctm-num" style={{ width: 30, textAlign: "right", color: C.dim }}>{o.seen}</span>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </aside>
  );
}

/* ----------------------------------------------------------------------------
 * Docks
 * ------------------------------------------------------------------------- */
function ThreatDock({ counts, enabled, onToggle }) {
  return (
    <div className="absolute left-0 right-0 z-20 flex justify-center px-2" style={{ bottom: 12 }}>
      <div className="flex gap-2 overflow-x-auto ctm-scroll" style={{ paddingBottom: 4, paddingTop: 4 }} role="group" aria-label="Threat vector filters">
        {VECTORS.map((v) => {
          const on = enabled[v.id];
          return (
            <button key={v.id} type="button" className="ctm-vec" onClick={() => onToggle(v.id)} aria-pressed={on}
              title={`${v.label}: ${v.desc} (${on ? "click to hide" : "click to show"})`} style={{ opacity: on ? 1 : 0.38 }}>
              <span className="ctm-num" style={{ fontSize: 10.5, color: on ? C.ice : C.dim, marginBottom: 5 }}>{fmt(counts[v.id])}</span>
              <span className="ctm-vec-box" style={{
                border: `1px solid ${v.color}`, color: v.color, textDecoration: on ? "none" : "line-through",
                boxShadow: on ? `0 0 12px ${v.color}55, inset 0 0 10px ${v.color}2e` : "none",
              }}>{v.id}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function ControlDock({ projection, onProjection, onZoom, onCenter, demo, onDemo, muted, onSound }) {
  return (
    <div className="absolute z-20 ctm-panel flex flex-col items-center gap-1 p-1" style={{ right: 12, top: "50%", transform: "translateY(-50%)" }}
      role="toolbar" aria-label="View controls" aria-orientation="vertical">
      <IconBtn className="ctm-dbtn" title="3D interactive globe" active={projection === "globe"} onClick={() => onProjection("globe")}><Globe size={17} /></IconBtn>
      <IconBtn className="ctm-dbtn" title="2D tactical map" active={projection === "flat"} onClick={() => onProjection("flat")}><MapIcon size={17} /></IconBtn>
      <IconBtn className="ctm-dbtn" title="Top-down polar view" active={projection === "polar"} onClick={() => onProjection("polar")}><Compass size={17} /></IconBtn>
      <Divider />
      <IconBtn className="ctm-dbtn" title="Zoom in" onClick={() => onZoom(0.8)}><Plus size={17} /></IconBtn>
      <IconBtn className="ctm-dbtn" title="Zoom out" onClick={() => onZoom(1.25)}><Minus size={17} /></IconBtn>
      <IconBtn className="ctm-dbtn" title="Center on the inspected country" onClick={onCenter}><Crosshair size={17} /></IconBtn>
      <Divider />
      <button type="button" className="ctm-ibtn ctm-dbtn" data-active={demo ? "true" : "false"} aria-pressed={demo} onClick={onDemo}
        title="Demo mode: orbit and cycle the most-attacked countries every 10 s"
        style={{ flexDirection: "column", height: 40, fontSize: 8.5, letterSpacing: "0.14em", lineHeight: 1.25 }}>
        <span>DEMO</span>
        <span style={{ color: demo ? C.neon : C.dim }}>{demo ? "ON" : "OFF"}</span>
      </button>
      <IconBtn className="ctm-dbtn" title={muted ? "Turn sound on" : "Turn sound off"} active={!muted} onClick={onSound}>
        {muted ? <VolumeX size={17} /> : <Volume2 size={17} />}
      </IconBtn>
    </div>
  );
}

function EventTail({ recent }) {
  return (
    <div className="absolute z-10 hidden xl:block pointer-events-none" style={{ right: 70, bottom: 20, width: 250 }}>
      <div className="ctm-label" style={{ textAlign: "right", marginBottom: 4 }}>Latest events</div>
      {recent.slice(0, 6).map((e, i) => (
        <div key={e.id} className="flex items-center justify-end gap-2" style={{ fontSize: 10.5, height: 17, opacity: 1 - i * 0.13 }}>
          <span className="truncate">{e.on} → {e.tn}</span>
          <span style={{ color: VEC[e.v].color, width: 28, textAlign: "right" }}>{e.v}</span>
        </div>
      ))}
    </div>
  );
}

/* ----------------------------------------------------------------------------
 * Modal views
 * ------------------------------------------------------------------------- */
function Kpi({ label, value, accent }) {
  return (
    <div className="ctm-panel" style={{ padding: "8px 12px" }}>
      <div className="ctm-label">{label}</div>
      <div className="ctm-num" style={{ fontFamily: DISPLAY, fontSize: 20, color: accent || C.ice, marginTop: 3 }}>{value}</div>
    </div>
  );
}
function RankList({ title, items, color }) {
  const max = Math.max(1e-9, ...items.map((t) => t.rate));
  return (
    <section>
      <div className="ctm-label" style={{ marginBottom: 8 }}>{title}</div>
      {items.length === 0 && <div className="ctm-hint">Waiting for traffic</div>}
      {items.map((t, i) => (
        <div key={t.iso} className="flex items-center gap-2" style={{ height: 22, fontSize: 11.5 }}>
          <span className="ctm-num" style={{ width: 20, color: C.dim }}>{i + 1}</span>
          <span className="truncate" style={{ width: 128, color: C.ice }}>{t.name}</span>
          <Bar value={t.rate / max} color={color} />
          <span className="ctm-num" style={{ width: 58, textAlign: "right" }}>{fmtK(t.rate)}/s</span>
        </div>
      ))}
    </section>
  );
}
function StatsView({ hud }) {
  const totalV = VEC_IDS.reduce((a, v) => a + (hud.global[v] || 0), 0) || 1;
  return (
    <div className="flex flex-col gap-5">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        <Kpi label="Lasers per second" value={hud.aps} accent={C.neon} />
        <Kpi label="Lasers this session" value={fmt(hud.session)} />
        <Kpi label="Detections today" value={fmtK(hud.total)} />
        <Kpi label="Arcs in flight" value={`${hud.arcs} / ${MAX_ARCS}`} />
      </div>
      <section>
        <div className="ctm-label" style={{ marginBottom: 8 }}>Detections by threat vector since 00:00 GMT</div>
        {VECTORS.map((v) => {
          const share = (hud.global[v.id] || 0) / totalV;
          return (
            <div key={v.id} className="flex items-center gap-3" style={{ height: 23 }}>
              <span style={{ width: 36, color: v.color, fontFamily: DISPLAY, fontSize: 12.5, letterSpacing: "0.12em" }}>{v.id}</span>
              <span className="truncate hidden sm:inline" style={{ width: 180, fontSize: 11, color: C.dim }}>{v.label}: {v.desc}</span>
              <Bar value={share / 0.35} color={v.color} />
              <span className="ctm-num" style={{ width: 92, textAlign: "right", fontSize: 11.5, color: C.ice }}>{fmt(hud.global[v.id])}</span>
              <span className="ctm-num" style={{ width: 48, textAlign: "right", fontSize: 11.5 }}>{(share * 100).toFixed(1)}%</span>
            </div>
          );
        })}
      </section>
      <div className="grid md:grid-cols-2 gap-6">
        <RankList title="Most attacked right now, detections/s" items={hud.topTargets} color={C.hot} />
        <RankList title="Most active origins, detections/s" items={hud.topOrigins} color={C.neon} />
      </div>
      <section>
        <div className="ctm-label" style={{ marginBottom: 8 }}>Latest regenerated events</div>
        <div className="grid sm:grid-cols-2 gap-x-6">
          {hud.recent.map((e) => (
            <div key={e.id} className="flex items-center gap-2" style={{ fontSize: 11, height: 21 }}>
              <span style={{ color: VEC[e.v].color, width: 30 }}>{e.v}</span>
              <span className="truncate" style={{ color: C.ice }}>{e.on} → {e.tn}</span>
              <span style={{ marginLeft: "auto", color: C.dim }}>{e.layer}</span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
function MatrixGrid({ view }) {
  return (
    <div className="overflow-x-auto ctm-scroll">
      <table style={{ borderCollapse: "collapse", fontSize: 10.5 }}>
        <thead>
          <tr>
            <th style={{ padding: "4px 8px", color: C.dim, fontWeight: 400, textAlign: "left" }}>From \ To</th>
            {view.targets.map((t) => <th key={t} style={{ padding: "4px 0", width: 46, color: C.hot, fontWeight: 400 }}>{t}</th>)}
          </tr>
        </thead>
        <tbody>
          {view.origins.map((o, i) => (
            <tr key={o}>
              <th style={{ padding: "0 8px", color: C.neon, fontWeight: 400, textAlign: "left" }}>{o}</th>
              {view.cells[i].map((p, j) => {
                const r = p / view.max;
                return (
                  <td key={view.targets[j]} className="ctm-num" title={`${o} → ${view.targets[j]}: ${(p * 100).toFixed(2)}% of lasers`}
                    style={{ width: 46, height: 26, textAlign: "center", border: "1px solid rgba(5,7,10,0.95)", background: `rgba(0,255,157,${(0.04 + 0.78 * Math.sqrt(r)).toFixed(3)})`, color: r > 0.35 ? "#02140c" : C.text }}>
                    {o === view.targets[j] ? "·" : (p * 100).toFixed(1)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
function SourcesView({ hud, engine, feed, live, geoInfo }) {
  const view = engine ? engine.matrixView(8) : null;
  const l7 = hud.l7Total || 0;
  const cf = hud.mode === "cloudflare";
  return (
    <div className="flex flex-col gap-5">
      <section className="ctm-panel" style={{ padding: 12 }}>
        <div className="flex items-center gap-2" style={{ color: cf ? C.cyan : C.neon, fontSize: 12 }}>
          <span className="ctm-dot" />
          {cf ? "Cloudflare Radar matrix active" : "Baseline matrix active"}
        </div>
        <p style={{ fontSize: 11.5, lineHeight: 1.65, margin: "6px 0 0", maxWidth: 760 }}>
          {cf
            ? `${hud.label}. Refreshed at ${timeOf(hud.fetchedAt)}; the next poll runs at ${timeOf((hud.fetchedAt || 0) + POLL_MS)}. Live shares carry 85% of the weight, with a 15% baseline floor so quiet countries still appear.`
            : "Cloudflare Radar publishes aggregated percentages over time windows, not a per-attack feed. Until a token is configured, the regenerator samples realistic weights for 39 hub countries and gives every other country a low background rate."}
        </p>
      </section>
      <section>
        <div className="ctm-label" style={{ marginBottom: 6 }}>Radar endpoints, polled every 5 minutes</div>
        <div className="overflow-x-auto ctm-scroll">
          <table className="ctm-table" style={{ width: "100%", fontSize: 11, borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ color: C.dim }}><th>Feed</th><th>Path</th><th>Status</th></tr>
            </thead>
            <tbody>
              {RADAR_ENDPOINTS.map((ep) => {
                const s = feed.status[ep.key];
                return (
                  <tr key={ep.key} style={{ borderTop: "1px solid rgba(255,255,255,0.05)" }}>
                    <td style={{ color: C.ice, whiteSpace: "nowrap" }}>{ep.label}</td>
                    <td style={{ color: C.dim }}>{ep.path}</td>
                    <td style={{ whiteSpace: "nowrap", color: !s ? C.dim : s.ok ? C.neon : C.hot }}>
                      {!s ? (live ? "Waiting" : "Not connected") : s.ok ? `OK, ${s.rows} rows, ${s.ms} ms` : s.msg}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
      <section>
        <div className="ctm-label" style={{ marginBottom: 6 }}>Origin → target probability matrix, % of all lasers</div>
        {view && <MatrixGrid view={view} />}
      </section>
      <section>
        <div className="ctm-label" style={{ marginBottom: 6 }}>Layer split</div>
        {[["L3 network floods", 1 - l7, C.neon], ["L7 application attacks", l7, C.cyan]].map(([label, v, color]) => (
          <div key={label} className="flex items-center gap-3" style={{ height: 22, fontSize: 11 }}>
            <span style={{ width: 160 }}>{label}</span>
            <Bar value={v} color={color} />
            <span className="ctm-num" style={{ width: 44, textAlign: "right" }}>{(v * 100).toFixed(0)}%</span>
          </div>
        ))}
      </section>
      <p className="ctm-hint" style={{ maxWidth: 760, marginTop: 0 }}>
        Country shapes: {geoInfo || "loading"}. Vector mapping: TCP → IDS, UDP → KAS, ICMP → ODS, GRE → BAD;
        L7 DDoS → WAV, WAF and API Shield → VUL, bot management and IP reputation → OAS, access rules and DLP → MAV.
      </p>
    </div>
  );
}
function ApiView({ api, setApi, live, feed, onConnect, onBaseline, rate, setRate, muted, onSound, demo, onDemo }) {
  const [copied, setCopied] = useState(false);
  const copySnippet = async () => {
    const ok = await copyText(WORKER_SNIPPET);
    setCopied(ok);
    setTimeout(() => setCopied(false), 1600);
  };
  return (
    <div className="grid md:grid-cols-2 gap-6">
      <section className="flex flex-col gap-3">
        <div>
          <label className="ctm-label" htmlFor="ctm-token">Cloudflare API token</label>
          <input id="ctm-token" type="password" autoComplete="off" spellCheck={false} className="ctm-field"
            placeholder="Token with Radar read access" value={api.token}
            onChange={(e) => { const token = e.target.value; setApi((a) => ({ ...a, token })); }} />
          <div className="ctm-hint">Held in memory for this tab only and never written to storage.</div>
        </div>
        <div>
          <label className="ctm-label" htmlFor="ctm-proxy">CORS proxy URL (optional)</label>
          <input id="ctm-proxy" type="url" autoComplete="off" spellCheck={false} className="ctm-field"
            placeholder="https://radar-proxy.you.workers.dev" value={api.proxy}
            onChange={(e) => { const proxy = e.target.value; setApi((a) => ({ ...a, proxy })); }} />
          <div className="ctm-hint">Accepts a path-forwarding Worker, a prefix proxy ending in ?url=, or a template containing {"{url}"}.</div>
        </div>
        <div>
          <label className="ctm-label" htmlFor="ctm-window">Aggregation window</label>
          <select id="ctm-window" className="ctm-field" value={api.dateRange} onChange={(e) => { const dateRange = e.target.value; setApi((a) => ({ ...a, dateRange })); }}>
            <option value="1d">Last 24 hours</option>
            <option value="2d">Last 2 days</option>
            <option value="7d">Last 7 days</option>
          </select>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" className="ctm-btn" onClick={onConnect} disabled={feed.polling}>
            <Radio size={13} />
            {feed.polling ? "Polling Radar…" : live ? "Poll Radar now" : "Connect to Radar"}
          </button>
          <button type="button" className="ctm-btn ctm-btn-ghost" onClick={onBaseline}>Use baseline weights</button>
        </div>
        {feed.error && (
          <div role="alert" style={{ fontSize: 11.5, lineHeight: 1.55, color: "#ff8fa6", borderLeft: `2px solid ${C.hot}`, paddingLeft: 10 }}>{feed.error}</div>
        )}
        {!feed.error && feed.lastPoll && (
          <div role="status" style={{ fontSize: 11.5, lineHeight: 1.55, color: C.neon, borderLeft: `2px solid ${C.neon}`, paddingLeft: 10 }}>
            Matrix updated from Radar at {timeOf(feed.lastPoll)}. Next poll at {timeOf(feed.lastPoll + POLL_MS)}.
          </div>
        )}
      </section>
      <section className="flex flex-col gap-3">
        <div>
          <div className="flex items-center justify-between">
            <label className="ctm-label" htmlFor="ctm-rate">Laser emission rate</label>
            <span className="ctm-num" style={{ color: C.neon, fontSize: 12 }}>{rate} / s</span>
          </div>
          <input id="ctm-rate" type="range" min="5" max="60" step="1" value={rate} onChange={(e) => setRate(Number(e.target.value))} className="ctm-range" style={{ marginTop: 8 }} />
          <div className="ctm-hint">Poisson arrivals around this mean, with slow drift and short bursts. Up to {MAX_ARCS} lasers are drawn at once.</div>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" className="ctm-btn ctm-btn-ghost" onClick={onSound}>
            {muted ? <VolumeX size={13} /> : <Volume2 size={13} />}
            {muted ? "Turn sound on" : "Turn sound off"}
          </button>
          <button type="button" className="ctm-btn ctm-btn-ghost" onClick={onDemo}>
            <Globe size={13} />
            {demo ? "Stop demo mode" : "Start demo mode"}
          </button>
        </div>
        <div>
          <div className="flex items-center justify-between">
            <span className="ctm-label">Worker proxy for Radar</span>
            <button type="button" className="ctm-link" onClick={copySnippet}>
              {copied ? <Check size={12} /> : <Copy size={12} />} {copied ? "Copied" : "Copy code"}
            </button>
          </div>
          <pre className="ctm-scroll" style={{ margin: "6px 0 0", maxHeight: 220, overflow: "auto", fontSize: 10.5, lineHeight: 1.5, padding: 10, background: "rgba(0,0,0,0.45)", border: "1px solid rgba(0,255,157,0.12)", color: "#9fe8c8", whiteSpace: "pre", userSelect: "text" }}>
            {WORKER_SNIPPET}
          </pre>
          <div className="ctm-hint">Deploy with wrangler, optionally add the CF_API_TOKEN secret, then paste the Worker URL above.</div>
        </div>
      </section>
    </div>
  );
}
function Modal({ tab, onTab, onClose, children }) {
  return (
    <div className="absolute inset-0 z-40 flex items-center justify-center ctm-modal-bg" style={{ padding: 12 }}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div role="dialog" aria-modal="true" aria-label="Threat data" className="ctm-panel ctm-frame flex flex-col"
        style={{ width: "min(960px, 100%)", maxHeight: "100%", background: "rgba(7,11,16,0.92)", userSelect: "text" }}>
        <div className="flex items-center justify-between gap-2" style={{ padding: "0 8px 0 10px", borderBottom: "1px solid rgba(0,255,157,0.12)" }}>
          <div className="flex overflow-x-auto ctm-scroll">
            {TABS.filter((t) => t.id !== "map").map((t) => {
              const Icon = t.icon;
              return (
                <button key={t.id} type="button" className="ctm-tab" data-active={tab === t.id ? "true" : "false"} onClick={() => onTab(t.id)} style={{ height: 42 }}>
                  <Icon size={13} />{t.label}
                </button>
              );
            })}
          </div>
          <IconBtn title="Close" onClick={onClose}><X size={16} /></IconBtn>
        </div>
        <div className="overflow-auto ctm-scroll" style={{ padding: 18, minHeight: 0 }}>{children}</div>
      </div>
    </div>
  );
}
function BootOverlay() {
  return (
    <div className="absolute inset-0 z-30 flex items-center justify-center pointer-events-none">
      <div className="flex flex-col items-center gap-3">
        <div style={{ fontFamily: DISPLAY, letterSpacing: "0.3em", color: C.neon, fontSize: 12 }}>LOADING COUNTRY GEOMETRY</div>
        <div style={{ width: 180, height: 2, background: "rgba(0,255,157,0.12)", overflow: "hidden" }}>
          <div className="ctm-boot-bar" style={{ width: "40%", height: "100%", background: C.neon }} />
        </div>
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------------------
 * App
 * ------------------------------------------------------------------------- */
export default function CyberthreatLiveMap() {
  const rootRef = useRef(null);
  const mountRef = useRef(null);
  const tipRef = useRef(null);
  const tipTitleRef = useRef(null);
  const tipSubRef = useRef(null);
  const sceneRef = useRef(null);
  const engineRef = useRef(null);
  const audioRef = useRef(null);
  const liveRef = useRef({ enabled: Object.fromEntries(VEC_IDS.map((v) => [v, true])), rate: BASE_RATE, muted: true });
  const selRef = useRef("IN");
  const toastTimer = useRef(0);

  const [ready, setReady] = useState(false);
  const [geoInfo, setGeoInfo] = useState("");
  const [glError, setGlError] = useState(null);
  const [countryList, setCountryList] = useState([]);
  const [hud, setHud] = useState(EMPTY_HUD);
  const [selected, setSelected] = useState("IN");
  const [collapsed, setCollapsed] = useState(false);
  const [more, setMore] = useState(false);
  const [enabled, setEnabled] = useState(liveRef.current.enabled);
  const [rate, setRate] = useState(BASE_RATE);
  const [projection, setProjection] = useState("globe");
  const [demo, setDemo] = useState(false);
  const [muted, setMuted] = useState(true);
  const [modal, setModal] = useState(null);
  const [api, setApi] = useState({ token: "", proxy: "", dateRange: "1d" });
  const apiRef = useRef(api);
  const [live, setLive] = useState(false);
  const [feed, setFeed] = useState({ status: {}, lastPoll: null, error: null, polling: false });
  const [toast, setToast] = useState(null);

  const refreshHud = useCallback(() => {
    const en = engineRef.current, sc = sceneRef.current;
    if (!en || !sc) return;
    const snap = en.snapshot(selRef.current, sc.clock());
    snap.arcs = sc.activeArcs();
    setHud(snap);
  }, []);
  const flash = useCallback((msg) => {
    setToast(msg);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2200);
  }, []);

  /* Boot: engine + scene + geometry + the 60 FPS loop. Nothing in the loop sets React state. */
  useEffect(() => {
    const el = mountRef.current;
    if (!el) return undefined;
    let disposed = false;
    const engine = new ThreatEngine();
    const audio = createAudio();
    let scene;
    try {
      scene = createGlobeScene(el, {
        onSelect: (iso) => { setSelected(iso); setCollapsed(false); },
        onHover: (c, x, y) => {
          const tip = tipRef.current;
          if (!tip) return;
          if (!c) { tip.style.opacity = "0"; return; }
          const rank = engine.rankOf(c.iso);
          tipTitleRef.current.textContent = c.name.toUpperCase();
          tipSubRef.current.textContent = rank ? `#${rank} most attacked right now` : "No recent detections";
          const w = rootRef.current ? rootRef.current.clientWidth : 9999;
          tip.style.transform = `translate(${x + 230 > w ? x - 214 : x + 16}px, ${y + 16}px)`;
          tip.style.opacity = "1";
        },
        onImpact: (im) => {
          if (!liveRef.current.muted) audio.ping(VEC_PITCH[im.v], Math.sin(im.lng * D2R - scene.camLng()));
        },
      });
    } catch (err) {
      setGlError("WebGL isn't available in this browser, so the globe can't render. Turn on hardware acceleration or try another browser.");
      audio.dispose();
      return undefined;
    }
    engineRef.current = engine;
    audioRef.current = audio;
    sceneRef.current = scene;
    const mq = typeof window.matchMedia === "function" ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
    if (mq) scene.setReducedMotion(mq.matches);

    (async () => {
      let list = null;
      let source = "Natural Earth 1:110m, embedded copy";
      try {
        const ctl = typeof AbortController !== "undefined" ? new AbortController() : null;
        const timer = setTimeout(() => ctl && ctl.abort(), 3500);
        const res = await fetch(GEO_URL, ctl ? { signal: ctl.signal } : undefined);
        clearTimeout(timer);
        if (res.ok) {
          const parsed = parseGeoJSON(await res.json());
          if (parsed.length > 100) { list = parsed; source = "Natural Earth 1:110m, loaded from GitHub"; }
        }
      } catch (e) {
        /* sandboxed or offline: the embedded copy takes over */
      }
      if (disposed) return;
      if (!list) list = decodeEmbedded(GEO_EMBED);
      const prepared = prepareCountries(list);
      const stats = scene.setCountries(prepared);
      engine.setCountries(prepared);
      const names = new Map();
      for (const c of prepared) names.set(c.iso, engine.nameOf(c.iso));
      for (const iso of Object.keys(HUBS)) if (!names.has(iso)) names.set(iso, engine.nameOf(iso));
      setCountryList([...names].map(([iso, name]) => ({ iso, name })).filter((c) => c.iso !== "AQ").sort((a, b) => a.name.localeCompare(b.name)));
      setGeoInfo(`${source} (${prepared.length} countries, ${fmt(stats.triangles)} triangles)`);
      setReady(true);
    })();

    let raf = 0;
    let last = scene.clock();
    let lastHeat = -10;
    const loop = () => {
      raf = requestAnimationFrame(loop);
      const now = scene.clock();
      const dt = Math.min(0.1, Math.max(0, now - last));
      last = now;
      const s = liveRef.current;
      const evs = engine.step(now, dt, s.rate);
      for (let i = 0; i < evs.length; i++) if (s.enabled[evs[i].v]) scene.launch(evs[i], now);
      if (now - lastHeat > 1) { lastHeat = now; scene.setHeat(engine.heat()); }
      scene.frame(now, dt);
    };
    raf = requestAnimationFrame(loop);
    const hudTimer = setInterval(refreshHud, 250);

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      clearInterval(hudTimer);
      scene.dispose();
      audio.dispose();
      sceneRef.current = null;
      engineRef.current = null;
      audioRef.current = null;
    };
  }, [refreshHud]);

  /* Selection → highlight, camera flight, immediate HUD refresh */
  useEffect(() => {
    selRef.current = selected;
    const sc = sceneRef.current, en = engineRef.current;
    if (!sc || !en) return;
    sc.setSelectedIso(selected);
    if (selected) {
      const c = en.centerOf(selected);
      if (c) sc.flyTo(c[0], c[1]);
    }
    refreshHud();
  }, [selected, ready, refreshHud]);

  useEffect(() => { liveRef.current.enabled = enabled; }, [enabled]);
  useEffect(() => { liveRef.current.rate = rate; }, [rate]);
  useEffect(() => { liveRef.current.muted = muted; }, [muted]);
  useEffect(() => { apiRef.current = api; }, [api]);
  useEffect(() => { if (sceneRef.current) sceneRef.current.setProjection(projection); }, [projection]);

  /* Demo mode: SOC wall display, cycling the top-ranked targets every 10 s */
  useEffect(() => {
    if (sceneRef.current) sceneRef.current.setDemo(demo);
    if (!demo) return undefined;
    let i = 0;
    const cycle = () => {
      const en = engineRef.current;
      if (!en) return;
      const top = en.topTargets(8);
      if (!top.length) return;
      setSelected(top[i % top.length]);
      setCollapsed(false);
      i++;
    };
    cycle();
    const id = setInterval(cycle, 10000);
    return () => clearInterval(id);
  }, [demo]);

  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") setModal(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  /* Cloudflare Radar polling */
  const poll = useCallback(async () => {
    const en = engineRef.current;
    if (!en) return;
    setFeed((f) => ({ ...f, polling: true, error: null }));
    const { results, status } = await fetchRadar(apiRef.current);
    if (!engineRef.current) return;
    const m = buildLiveMatrix(results, en.baselineMatrix());
    if (m) {
      en.setMatrix(m);
      setFeed({ status, lastPoll: Date.now(), error: null, polling: false });
    } else {
      setFeed({ status, lastPoll: null, error: radarErrorHint(status), polling: false });
    }
  }, []);
  useEffect(() => {
    if (!live) return undefined;
    poll();
    const id = setInterval(poll, POLL_MS);
    return () => clearInterval(id);
  }, [live, poll]);

  const connect = () => {
    if (!api.token.trim() && !api.proxy.trim()) {
      setFeed((f) => ({ ...f, error: "Paste a Cloudflare API token, or a proxy URL that adds the token for you." }));
      return;
    }
    apiRef.current = api;
    if (live) poll();
    else setLive(true);
  };
  const revertToBaseline = () => {
    setLive(false);
    const en = engineRef.current;
    if (en) en.setMatrix(en.baselineMatrix());
    setFeed({ status: {}, lastPoll: null, error: null, polling: false });
    flash("Using baseline threat weights");
  };

  const toggleVector = useCallback((id) => setEnabled((prev) => ({ ...prev, [id]: !prev[id] })), []);
  const toggleSound = () => {
    if (muted && audioRef.current) audioRef.current.enable();
    setMuted(!muted);
  };
  const zoom = (f) => { if (sceneRef.current) sceneRef.current.zoomBy(f); };
  const center = () => {
    const sc = sceneRef.current, en = engineRef.current;
    if (!sc || !en) return;
    const c = selected ? en.centerOf(selected) : null;
    if (c) sc.flyTo(c[0], c[1], 0.9);
    else sc.flyTo(20, 0, 1);
  };
  const refreshSelected = () => {
    const en = engineRef.current;
    if (en && selected) en.resetHistory(selected);
    center();
    refreshHud();
  };
  const share = async () => {
    const s = hud.sel;
    if (!s) return;
    const lines = [
      `CYBERTHREAT LIVE MAP: ${s.name.toUpperCase()}`,
      s.rank ? `#${s.rank} most-attacked country (rolling ${ROLL_TAU}s window)` : "Not currently ranked",
      ...VECTORS.map((v) => `${v.id}  ${fmt(s.counts[v.id]).padStart(12)}  ${v.label}: ${v.desc}`),
      `Detections regenerated since 00:00 GMT from ${hud.mode === "cloudflare" ? "Cloudflare Radar aggregates" : "baseline threat weights"}.`,
    ];
    flash((await copyText(lines.join("\n"))) ? "Summary copied to the clipboard" : "Clipboard is blocked here, so use Export instead");
  };
  const exportJson = () => {
    const s = hud.sel;
    if (!s) return;
    const ok = downloadJSON(`threat-${s.iso.toLowerCase()}-${utcDayKey()}.json`, {
      country: s.name, iso: s.iso, rank: s.rank, detectionsSince0000GMT: s.counts,
      inboundDetectionsPerSecond: Number(s.rate.toFixed(2)), likelyOrigins: s.origins,
      matrixSource: hud.label, exportedAt: new Date().toISOString(),
    });
    flash(ok ? "Export started" : "Downloads are blocked here");
  };

  const tab = modal || "map";
  const info = selected && hud.sel && hud.sel.iso === selected ? hud.sel : null;

  return (
    <div ref={rootRef} className="ctm-root relative w-full overflow-hidden select-none" style={{ height: "100vh", minHeight: 540, background: C.void }}>
      <style>{CSS}</style>
      <div ref={mountRef} className="absolute inset-0" aria-label="Interactive map of regenerated cyberattacks" />
      <div className="ctm-vignette absolute inset-0 pointer-events-none" />
      <div className="ctm-scan absolute inset-0 pointer-events-none" />
      <div ref={tipRef} className="ctm-tip" aria-hidden="true">
        <div ref={tipTitleRef} style={{ fontFamily: DISPLAY, letterSpacing: "0.14em", fontSize: 12, color: C.ice }} />
        <div ref={tipSubRef} style={{ fontSize: 10, color: C.neon, marginTop: 2 }} />
      </div>

      <Header tab={tab} onTab={(id) => setModal(id === "map" ? null : id)} hud={hud} onCta={() => setModal("api")} />

      <Inspector
        info={info} selected={selected} countries={countryList}
        onPick={(iso) => { setSelected(iso); setCollapsed(false); }}
        onClose={() => { setSelected(null); setMore(false); }}
        onRefresh={refreshSelected} onShare={share} onExport={exportJson}
        more={more} setMore={setMore} collapsed={collapsed} setCollapsed={setCollapsed}
      />

      <ControlDock
        projection={projection} onProjection={setProjection} onZoom={zoom} onCenter={center}
        demo={demo} onDemo={() => setDemo(!demo)} muted={muted} onSound={toggleSound}
      />

      <ThreatDock counts={hud.global} enabled={enabled} onToggle={toggleVector} />
      <EventTail recent={hud.recent} />

      {!ready && !glError && <BootOverlay />}
      {glError && (
        <div className="absolute inset-0 z-30 flex items-center justify-center" style={{ padding: 24 }}>
          <div className="ctm-panel ctm-frame" style={{ maxWidth: 420, padding: 16, fontSize: 12, lineHeight: 1.6, color: C.ice }}>{glError}</div>
        </div>
      )}
      {toast && <div className="ctm-toast" role="status">{toast}</div>}

      {modal && (
        <Modal tab={modal} onTab={(id) => setModal(id)} onClose={() => setModal(null)}>
          {modal === "stats" && <StatsView hud={hud} />}
          {modal === "sources" && <SourcesView hud={hud} engine={engineRef.current} feed={feed} live={live} geoInfo={geoInfo} />}
          {modal === "api" && (
            <ApiView api={api} setApi={setApi} live={live} feed={feed} onConnect={connect} onBaseline={revertToBaseline}
              rate={rate} setRate={setRate} muted={muted} onSound={toggleSound} demo={demo} onDemo={() => setDemo(!demo)} />
          )}
        </Modal>
      )}
    </div>
  );
}

/* ----------------------------------------------------------------------------
 * Embedded Natural Earth 1:110m admin-0 countries (public domain), polyline-
 * encoded at 0.05°: [ISO-A2, name, "ring:hole;polygon…"]. Used when the GeoJSON
 * URL above is unreachable (sandboxed previews, offline demos).
 * ------------------------------------------------------------------------- */
const GEO_EMBED = [["AF","Afghanistan","okAqk@i@N]EGQ_@EUKG_@a@GEMQHK@W?]FKD[MMFKQW?EEEOOMUHBJK@B`@OJMGQCWQ[Bi@?EHTDTDl@Dh@FVPINCRRNANHLd@?MXVHPVAVLJNC\\BBJ\\?TT@`@r@PZCFFVCf@DbAUe@c@BY\\EBYJ_@OUNEI["],["AO","Angola","{\\rMGRDLALpA?@~BY^YVfAP`BEZS`D@D@VQX?VDPFBYEa@Kc@CQKc@IOUYMQC]@UJOJWFWAGKOJe@FYRYAGQEI@OEuB@GZKVILMR[AKEUDEIIWYAAES?BLq@??VGNDVCVKN@n@ICQ?WEQBCJ;gNfFJ]OQKEOLLFFH?P"],["AL","Albania","gYar@?HLD@LPRDC@GTMBSCYEKFG@KQSAFICIJGBCLDLEN"],["AE","United Arab Emirates","o_Ai]EAAJ_@G_@@W@[[]YWWGLE^R?BXGBPF?PJN@NFFvBSNg@"],["AR","Argentina","trArcAVAj@??wAOPS\\s@Vw@HPRd@@;ttAj`Ad@E~AEPUA]Z@LM@k@]OKYBSUa@Mu@BWQEDOPGMOPOHm@OGDo@Gi@Kc@WMJe@?e@]Y@a@We@?e@HEReAYg@Bg@Mc@Ye@[WJOGK?cAi@QMi@BIa@c@s@HUZO_@m@@EFiA`A_@Dq@Zg@NEPd@z@g@Jk@D_@Ec@_@Ea@SGST?^`@TXPl@d@t@t@F^Jh@?f@FFBX@Tq@`@BZWN@Rd@r@z@RnAHj@CGTF\\GTVLf@Bf@MLHCf@[JUKKRd@J^XDf@FTd@?^RJ\\g@\\e@FLb@l@TXl@d@NNRMf@YV"],["AM","Armenia","ou@kr@u@EIHMFFHULJJQHQF?ZL?NU?EP?JKF@NK\\ICS"],["AQ","Antarctica","liA`cBJRJPrAExA@p@K?ATKyA@uAB]OUM;~eEjbBlADr@MVM?CXIWOiAFg@J]L;lw@p`Bq@POVEN?T|@J~@HjAHrAF|ACr@KEQuAIa@MYOQOWMYOS?{@G;nvCzzAs@Do@EVLd@Ht@Cf@MGM;|{CzzA{@LT?r@Cv@K]G;vzB|xAk@Bk@CWT^An@@p@At@@f@GTOYGq@D;ptAtwACPDNJLl@Dl@Fr@?SOl@Dl@B\\K@Ok@OYCo@@ISCO@_@WQc@EULGLQPKP;fhAdoAPF\\E^BZHZHRJDNALSLZHd@@TLVJVPDLMNSLa@F]LOLININSJKNCb@KNCLKNDTTNTLt@DPLVJz@Nt@Dp@Ft@F^P~@?dA?~@@bA?KN}@Fk@HYLj@JdACx@J@N?Nm@JGNs@LsADgAJy@JgAJcBDaBJcAJiALg@PSLo@MaAKeAKqAIgAIcBA_BDqAHYQw@KcB?oAIiAGsAEwAE}@IZMPM?OjA@rADlA?HMC]QIy@GcAIo@Ko@Kc@Ow@Eu@E[A{@A{@Eq@Go@Ik@Gw@Ka@Me@KKOh@IMOYKi@Gk@Ig@K_@OSQ[Ko@@SLo@@?OUMi@BILo@@s@Eq@Em@BONk@Mi@Ek@Em@Eg@Ik@Ec@GWM]Hi@E[RULm@GQOg@Ku@BOL_@Mk@Em@Ai@@m@Bi@@QLYJk@Go@?m@?k@Ag@Ei@Cc@Ic@Gi@C]IUUUMi@DOLa@Hi@C[L]Jg@IMQc@Ei@Mg@Em@G_@G_@I_@Ge@Bc@MYIe@?_@GGOa@I_@Gg@Ee@Ca@Be@@_@JCPc@JWJo@BYJa@He@@_@Ga@Oe@Fe@De@Bg@Bg@?_@f@@JBPd@H^LENk@?BLTNPN]Jm@Bm@EUOMOUKYKIMSSYAm@Ag@Eg@ESOKMYMg@Ka@EUMUG]Eg@Bc@Ce@Ck@@]IS[MJSP_@Fg@Be@Eg@Be@?YC_@@_@Hc@Ei@?e@Eg@D[MSK[Kq@]YD]HYNs@Ve@?e@?i@Ck@E_@I[Kk@A]G_@DSL[Jk@A[Ho@Hq@Bg@A_@KYMc@Ac@Bi@Be@Ec@?c@Bc@Bc@Ek@Eg@Am@?c@Cc@CKS?OYJEPMNOLa@Dm@As@?c@Cs@?e@?s@@m@@[LFLYJi@Hm@Hs@Du@Dg@Dm@@YMa@J_@Ja@Hq@Bm@BQNm@H]Lm@Dm@Ai@Bo@Ao@Bm@Bg@Hi@F[JBNTLPPLLPNr@DVLr@HPLZNZJPNHNBPALUNGNSLiABOPfAD|@FjA@`@VDPPLRNs@LUNa@Lo@Lw@J{@J{ALSRsBFG@[JoBI{AJcAH?rE~`M??sEA?c@UgAJCAi@KE?C?y@Ps@QGAuBEe@FQD}@JoBJyAJ{CFqBIiDF_BJiBKoBIGS|C?~BI`@OjBGGQMOOOFObAK\\M|@KaB@{AEy@LgAKaAO_@KLOr@Kz@KpAAfAElACXMp@K^MJm@QBe@J_AC_AEa@P}@Cu@Gq@Km@K{@C@OLMKMs@GWL{@Gm@Iy@Au@Cu@Gi@Iq@G]@[B{@Es@Fw@As@Eu@B{@Bw@?y@?{@?u@?g@Kq@Eq@Fo@Gi@MYLMLYJi@Ko@Nu@Bm@Jw@Aq@G}@@u@Du@DUQXKRMr@CTMHOL]_@Ds@@s@Am@Di@JOLu@@s@Cw@Go@Ei@Hs@Ca@]a@Pm@Fq@C_@Ns@?q@Do@F]MOMg@Lu@Ci@H[Js@Ci@Gg@Iq@Ew@Cq@Eg@GWKGQBOJOLOLOHM@OCMQOOOEODQDMSQUKYO[K_@KMQUIYIe@AYM[G_@C]IUK_@EWJNJ"],["TF","French S. Territories","euAv{@YLc@BAFHP|@B@UEO"],["AU","Australia","wtD~q@e@LUE_@GWBAl@LLB^LIZZFAVAVa@DYVc@AQ;mrDdPM^YOMPQNBPI`@ERIBI`@BTMXi@T]PYPDHWVOj@OIOPIEEh@[XQL_@^K^?V@VQ`@@b@DPJb@ATF\\Pb@\\RL\\LRJ`@LRH\\DZALVJj@@b@NRNVP^QVGESTFb@Z`@ITEVCd@KXWF]HSPOf@EMQH]RZ`@DSUEUOSB]^`@XLL^^OAUX]RMEIp@WZ?d@SfABr@Ll@Ld@Ch@Tb@FDTNN`@?VBb@GZDZ@VRJARJRJZ?X?j@YRG?WSCEI?MC[BWTg@DUAWNY@KPOB]T_@DQQPLe@SJKN@SR_@@KHKCWGIESBUO]C\\OY_@MSQ]MQCKD_@OWCEGICU@i@KUQIUWSAO?U[a@Q`@OGLQKSQHE_@UQGOSGAIQB?IQEQE]RUTY@W@FUS_@QIDIOUWMUBa@G@S\\MUCYHUNa@HKCWJWKMBIGQRHTNNL?ENJRLRAJ_@T]JUL[VK?SHEJe@L[MESGQEUK_@DSCKDUE]GGDMISEUAKMOKRAXIBAPMRCT"],["AT","Austria","gTc{@BNT?GFLXFD`@@RF`@Av@IHMf@DBFVER?PGEI@GKASJEIc@@[GQ@MFCGDYMCMS]LUOMC_@JQAQF@D"],["AZ","Azerbaijan","cy@mo@?[PGPIKKTMGILGHIIE]JU@EERSIEK?YXQ@GIWOSRS\\S?KJ`@@D^FLLHARH@XUMSJKLB;_w@sp@GAKJQ??DOTZCRS"],["BI","Burundi","uc@rD@o@JQY@KUS@CNGH?JHFNTLL"],["BE","Belgium","aDa_Ac@IYPUHBXH@DT`@QRBZSROP?DM_@G"],["BJ","Benin","kByF`@BH[A{AFG?SLMLIEUMCGQSCGKMKM?]V@JIVFNCJRVJJFXAX"],["BF","Burkina Faso","uA}MFJRBFPLBb@?PCJDPAdA@?TC\\XIR@LHPGDMPG@WIQ?K]a@E[KGSBOGEI]QGKe@OUEIFWA@REPUX?Ro@F"],["BD","Bangladesh","yrBqZ?\\LGA`@HU@SFSPUb@ACNLTNGDFJCLCDa@L]EWVIGMYO\\SM[_@PS@AZe@Be@?WDR`@PBJTUREWKA"],["BG","Bulgaria","i[iv@KPOC]Dy@@SIo@I[NWBRNNZMV`@Eh@J?Rb@BZM^J\\A@YRKEEBEEKOKRQBM"],["BS","Bahamas","|_Bu\\H@HWLKGWK@M^;f`Bg`@j@FBOSAY?;f_Bg`@DZFC?UPO?C"],["BA","Bosnia & Herzegovina","eWaw@HPSLDRH@D@LHDTb@OLONGPOFKRQGQMHIGQAa@F[AQH"],["BY","Belarus","k\\kbAe@?k@OGUa@KBQWGk@Mi@HCHUEe@HCPFJYXOF@DYFKHNF^?FBIJIX`@@LH@RNCb@@HINDLC^Aj@If@A^?TJP?@OJSWG?OHM"],["BZ","Belize","lnBgU?ECAGBMWG??DG??HFPCDBLABBRFJF?FLJ?Ck@"],["BO","Bolivia","jmAxZDGl@AN^T[r@I`@b@\\BLu@Tm@Ke@ROD]RYYk@Pa@IMFMOS?a@A[IMb@_A]BUAGKc@OSMs@GB\\ENBXk@b@k@FOLYFQJW?WJATGJ?PJ?Ol@kA@DVCLUJIVF^HPCTJH@Mb@Sd@?dAJP`@@T"],["BR","Brazil","`gAvd@u@u@m@e@YQa@U?_@RURFGWEW?ULENDLABOBc@FKXIPFh@GCu@JUKIBUIQG_@HWTKBMEWjAANm@K??QFK@UVKV?PKXGNMj@Gj@c@CYDOC]r@FRLb@NFJT@\\CTDPCA{@^Vb@ALUZAIOTYPc@KE?QWIBUIMASm@Y_@GEEc@@QmBAQFUNM?]UEGBAOVC?WmA?KMKLGTECUT_@CGK]IOECO]K@G`@CDYAYPIEC]D_@HKI[Em@OMMDKUAGHBPMDGPHLD`@IRAPWRS@CGMAQGKIUBIAUBCGDGCKOBQCWFOFKKI@EJQAOOK]Wc@MAITUdAUD?Z\\`@KJgAD?f@_@Yq@LaAVSVFTo@KmARy@A{@`@s@j@]Ja@@MJMr@EVN`ARXv@v@Xj@Zb@H?J\\AhAH|@BXLNDt@f@r@Fh@^NHVh@?~@NZPj@Jn@^`@f@DZGVFf@HPZTj@fAb@^XPPd@XTJUQQV[\\Uh@YL@h@_@"],["BN","Brunei","wmCuDOMa@U@R@XRAFL"],["BT","Bhutan","sqBua@OJ@V`@@`@CVFb@O@G[]SI]HS?"],["BW","Botswana","yc@rZx@\\b@ZJZJLTBFPBLVF`@APIPERHFRRJRPZBHMCYVe@HE?sBg@A?mC]A}@MOPWOK?WIEBO^GDKVm@j@OBALIX_@D"],["CF","Central African Rep.","cRgH_@CGIE?IHq@OQOSMBMKAe@@e@S[i@UOWGEPUV?NDPAJMJ]NUN?L[ROPIV]NEJJBX?\\CLBDFL@NGj@RPCD@JV\\EZCXO`@MRLNRBZXAXGVTTd@BK@QPMLSBMPUAKBOC_@IE"],["CA","Canada","pnAey@[De@ARNLBr@QHMOK;flAk|@R?r@Kb@QMCs@Hg@N;jyCs{@RD`ASJMb@MFIf@GNUCGi@FWDe@BMLSPg@P;deAk~@Xb@YM[FLLa@JSIe@JJ\\[GETKVNb@P@ZGIa@JCl@`@V?[Sd@Ij@BjAADKWMPIa@Yi@}@WWc@MQ@FJ;neDubASBe@AJj@a@^N?VQLQRKFQ;`bBulANRPAHKACMKQ@;jeBkmAl@TZAHI]Qu@?;liBaqAEPUEUHk@Lm@JCP]A[Jb@L|@ITQf@Tv@RLWt@Ba@SE]Ke@;x}A}rAl@@HSQUc@E_@J?NBD;pvBkuAVLt@K`@Bt@Qc@K[Qi@JWDKF;htAez@XDLI\\\\J^LPPDJ@BHhA?z@?PFj@ZBBJLd@?d@?PFEFCJ@Br@Rh@Dl@RH?LEBEACGMQUKUFc@Fc@h@QEGDCJ?FG@GFBHAACHCBI\\K^Mf@Od@M`@JL?p@I^Bd@Kh@EZAJGDUL??NrA?fC?fC?vB?vB?tB?xB?f@?tB?pB?B?lAg@ZOhAQTa@EYr@OD_@n@]@SUS?WbAYh@m@V[b@QZOTUf@Ld@Tb@YZQd@Kf@??cF?sCkAH}@Pi@Ba@Oq@My@D{@QaAI[N]GGS[BcAb@u@YC\\q@EMKq@@{@N}ANu@Dg@Au@Rv@RgAFkBCa@Gi@Vk@Sf@OYMo@A_@C_@Hg@Tm@CeAP}@Ey@?BWc@G}@L@d@Y_@_@@Qg@h@Yl@OAk@o@[s@Dg@Pw@j@b@RiAF?h@u@_@o@XJ\\e@Xi@[[c@Ck@w@B{@Ds@RCR\\R[TDRlAZv@Df@KJRf@`@HNn@Zv@@^P@Xn@Bn@`@j@j@N^@l@{@DQd@Q\\w@GiAPg@N]Pq@Ji@NaA@k@BF`@Kf@]l@{@d@]MUg@R_A\\S_ASm@[U[@YZa@n@]m@i@Nc@L}@[IcAHi@B_@Ie@Lo@TMNeAB?`@Kp@e@D[Vy@Ue@k@YS_@b@s@r@k@n@NVu@Tc@V}@HYJO`@_@DONAj@ZN\\L~@Lr@^`ADtAGz@?h@@`@\\p@Px@r@l@d@a@G_As@sAa@{@Cc@Rd@ZKh@M\\s@RaAEg@k@AZYNp@XvAVf@Nj@Z\\A@a@cAa@~@@j@BXU?u@;tmCkzARPwAKw@Rm@Sc@J_@f@SOZi@c@Eg@Dk@PYd@KZaARgARBN`ABYNLLfAEbAKl@BjAJdBDdABTQt@Kb@Dp@_@[C{@Gy@@s@ElAItABv@ATM}AO|@?dAIa@][OiBW;raCwzAb@X|@[MEu@A;l~AkzACHh@?j@Aj@DJAj@UAMSA{AB;dkBmzA_@Vc@_@eBOcAh@DXoAKe@OwARu@RENiAGi@X_BLc@Pe@b@hAR}AX_AFy@b@}@BJZdAl@p@Q|@e@r@DDTi@Vu@PQHYf@L\\r@KbB_@y@`@g@VGLlBOrAUp@SMKz@Sx@SAJrBD`@KY]kAAqACLMMSs@g@JQLK|@SnAMWIh@W`@C^KTJfABpCGrAK`AE^Mi@Qx@?Ji@]c@i@OeBI;l|Bi{Ao@FeACKJd@P{@PDb@`ANd@CZObB]?MqADj@Y;nsB}yAh@\\l@AXc@ASSOg@KsA@kAHz@b@;puCgxAhBRRQ|ASQQ[[a@[d@WeCEy@FeB@e@Jk@Np@J`BZp@Z;~sBw|ATNx@An@KSQy@Ia@L;bzB{~A]PARP\\`ABj@EAW`AB@_@i@@{@Mw@@;ffCg~AOLa@Ei@@GPVRfCDbBP|@?BKqAQrDBv@Eu@g@e@KoBLgAVeABx@g@c@Mi@B;juBk_Bm@JmA?a@LFNm@FWHu@@y@@_AGqAC_ABk@LGPVHz@Fr@CpBDpA?~@ChBMLUDSf@OpAEl@KMO;fpCa`BD\\\\Ld@@hAP~@Dt@GcA]qAY}@?;htB{_BP?hAAJKqA@[D;vhCc`BhAJz@Ma@Ky@Cw@D;`hCgaBp@F`A??Ei@KU@;xvBq`Bx@F^IPMBOs@?WBo@L;`|B{`BON`AC`AMxAAg@Kn@GBOmADkBL;vkBqbBo@Jv@JhA\\dABrAEh@O?M_@KfA@l@MVQ[Q[Kg@CPG}AAq@TcAFaAF;rtA{fBiB@uADiAH@J`BN~AFb@HuA?|AV~@JdA^pADXFvBDu@BXF_@Pd@L|@JPNv@JEFcA??FhBVfBItBDz@CjAABSiAIR[WAiBNt@Y~@E_@OeAIKMv@OPSmB@_@B}@MxAEjCBdAM`@Ol@KHM{@Gm@?oAGy@Mq@@i@J_@Us@EgAEyB?UBqBGwAB"],["CH","Switzerland","_Kmz@AFDHQFS?BNPFZEHNP@FETLR?NGLQRFAS[U?IQBIEa@?GI"],["CL","Chile","xtAx`A?vAk@?W@LN`@JR?VCZKh@Ep@Uh@Ut@k@_@Fw@Xu@LSQMYc@Q;zrAl[CHLh@h@P?bAFJKNZVXd@Lb@Cf@Xf@SdAID?d@Vd@A`@\\X?d@Kd@VLJb@Fh@En@NFIl@QNLNQFENPDCVLt@T`@CRJX\\NAj@ML[A@\\QT_BDe@Db@?RHb@LDd@P?j@Kl@[p@WJWIWRYBeAOe@i@]z@Ke@c@MaAk@LUqAZKJp@XEMw@KiAS[Je@Bm@QAW_A[_AO{@F{@K_@Dq@Wo@GmAKqAKyA@aAFw@SIISSXE\\SNJd@Ul@Mt@"],["CN","China","}|Amm@DIDW?OVGJBHe@IGDIg@QYGk@BMWs@EMO}@SEI@UYKb@cAoAOSI]gAmALUQAg@a@C]YOCIZa@Ty@LY^Ln@MNo@Fu@Bo@XWBQd@WTk@?qAHu@Eg@Dy@Vo@?QJo@U_AM{@?m@M]U[MFKJOSYWBg@Fg@U}@O[Y[Iy@E_@BCMb@[^K\\Lf@ETBHO[g@S]o@Nw@Y?Qc@i@UK?UTI_@Sq@Gs@?{@Jc@LWf@OPMVMf@eAJo@ZOd@{@?a@OcAKTb@NNLj@Xd@n@E`@LI`@Dl@R@?RXWNV|@NET`@ARKXZj@T`@Vv@JZRj@HUQFO]YRUb@Lj@ZXXd@@RPSZa@D?P_@Jk@[c@LY@ERv@JPTf@RRZk@TMd@Yd@Y\\?\\XHITWJD`@H\\TB\\j@^r@d@n@t@d@v@^l@DVPLMTRv@Rh@DLh@T@H[GOt@KPDf@IROGWd@GPM`@Tf@B^?THRDEl@TA@I@O\\JNG\\MKa@XGHc@h@DCo@e@_@Aa@?]PILWTBj@EMQRWZN`@Il@Xb@\\^DPKR?\\IRHZ\\@_@XFl@Al@I^Q\\GLQTEf@Y^KPFv@[d@WJk@]B?SNSC_@h@o@`AOJ];}hCkV`@R`@K?a@QQk@KW?GNPP"],["CI","Côte d'Ivoire","vE}KQFELQFMISAYHKx@P^Hl@Q`@@NP?ZGX@n@DZJd@LF?Aa@CC?OPQJAJIGQBSAKE?COBGCEMEH_@FOAMGAECKD]?GKE@KCENIC"],["CM","Cameroon","cRgHRf@HDB^CN@JQTCLMRQLAPCJ@R^G^Kp@?DAVBVEPB`AAE]N[PEFQHE?II]Se@I?WWO?UN[MCOGOESUOG[GIESIYa@]AMEGNO?KKAOXAX@XUb@T?HBRCFPWVQDCNMZ"],["CD","DR Congo","{\\tLPCVDP?HBAo@JOBWEWFO?Wp@?CMR?@DX@HVDHTEJDZ@LSHMJWF[tBANDHAPDBKIC?QGIMGIBMOU?AJODUWWSIK@a@Qe@QSYSEM?MGMBUEc@GWKUAWC[OSSMa@LYN[B]DKWEAQBk@SOFMAEGMC]BY?KCY`@QBIEQ@UGIPc@XBl@ODJLNHLTFPB^FN?\\JH@VDBBTKPAn@Eb@BTGTWVUp@NCt@DHDJVGPDn@Df@KD[NIECh@\\?PULQ\\CHUVJ^CLQVCR?@K"],["CG","Congo","gO~DNMJDNP^i@]UL[KI[CCQSRc@?KQEYD_@PWQm@HG\\BJUCOq@?_@J_@FASUe@WUYFY@@VJTFVDb@CTFL?LDLXRPRPd@A`@HJVRTVNE@KT?LN"],["CO","Colombia","rrAq@DBFUJMJLlA??VWB@NFCTD?\\OLGT@PPlBRUJ?Yg@\\SVBLGVJZEVi@PILQXSHBPIRKJD^EHQF@f@WDKOA@SGOSAQYMSLIGUHe@IIFa@NSESK@GKFUCES?][QC?KEa@WSW?CG_@@]SOGSSM@IJFJVFJRLJJLDZHVS@EPGHCNDLAHI@ILs@CUD[`@OC]@UCMDDTHL@ZGXIJAHRRMFIL"],["CR","Costa Rica","tfBiITGFGCG@GHINGLC@KJGCJFHHKJCDG?KEKJEIGECYHIEKBEFK@IGITONQPN@?PIBDD?D@H"],["CU","Cuba","xeB_\\a@B_@?c@LOLe@CMFa@XYPK?WF@H[@]NBHXDZ@XCx@BYUNIXCLKFUV@b@KJGr@ELGMIf@AZTN?DHRBNCSKGMQIUG]C"],["XN","N. Cyprus","}g@}j@A?EI[@e@KZNAFBADBDA@@@C@AF?J@"],["CY","Cyprus","}g@}j@E@KAG?A@ABAAE@ECC@A@f@PREHO"],["CZ","Czechia","eTw{@PGP@^KLBTN\\MTOTIBODK[IOI[GIEIBQCSJ]B@JSFEI[BCJ]@QRJ?DFH@@FF@?BLBP?"],["DE","Germany","_Pc|@LRLBEXBFLGPAZFb@ADHRKJ@j@KFH`@?E]SYx@GPIAQFICYDi@W?IOIc@FMGGa@AEF[QHO?U]BWEANg@H?Lg@GUIm@LQLIRJHONIRBLOXPBHCHDZFNHZHEJCNUH"],["DJ","Djibouti","{t@{NGJ?PVFQJLRHEH@T??KBKMQMQQB"],["DK","Denmark","kKwcAVD\\CPU?i@EIKKa@AOK_@K@TJJCJUDHLJCZ\\;{NodAV^h@UDQy@K"],["DO","Dominican Republic","rxAsWCG_@?WJIAGLU?@JQ?SNNNPGP?LAFFL@DILDNZHE@K?IHKIGCM"],["DZ","Algeria","iD}Vj@B?YPEXKHQdCwAdCuAvCaBAG?A?o@_A]g@E_@IOSm@OA]WAQOs@EGOJGLi@@YLWe@Ui@GYOe@KcAGaAASDe@Ok@?OFYAFRGd@H`@XTC\\a@V?HWNQfAKb@APD^APBTAXNNW\\ANMTQE_@PQXhCjApBlA"],["EC","Ecuador","paBw@g@VGAIP_@DKESJQHC\\JXj@h@n@NV`@FZTNNSPCNB?OIIBOU]HQLRVQGKFc@MEGWOYBOUI"],["EG","Egypt","am@oZ|C?zC?~C??sC?mCJ_@IWDQMQu@Ae@Jg@HQF_@MOIc@C[BIRIK_@H]@SIUx@CHHNF\\JTHDJKPQ\\y@BBQh@Wf@]|@MTMTc@j@FFAXm@b@"],["ER","Eritrea","{t@{NJHPCLKNWPKHM`@OZAHGVHVQJ\\l@GDOQ{@CYKK]GSUWl@Id@UPw@d@UVUTKL"],["ES","Spain","hJks@A[NQw@[q@Fu@?i@Da@A_A@OLiAPMGm@Pm@CATd@Xr@HBJVVN^OTTPHX\\FZ^p@?d@AXNNLPCNKHWd@EBMOMCKJII[NWQA?SGE?]QKHSV?DBV?HSND"],["EE","Estonia","k]ggAEWNDVMBWq@Iq@Ek@Di@AEF\\VKb@NL`@A`@MPC"],["ET","Ethiopia","}s@uNLPLPCJ?JU?IAIDHNOTMPOLaCn@a@?pBvBr@@b@ZV?JLZ?NMb@NJPXCHCF?L?p@a@Z?LM?UREVk@PIDOTQVCMUUACK?c@Ki@SICOO_@WSOe@Ga@m@FK]WPWIIF[@a@NILQJOV"],["FI","Finland","{\\oqALO?}@|@Yt@SWIk@Rs@Ak@He@QS]}@Kq@NNZDZ}@Xd@\\m@l@X`@c@\\NXy@ZLRd@TtAr@fABdAL`AFTUf@KIg@Rc@SWc@W{Ak@YGBQ"],["FJ","Fiji","}}EtTMJDRVDTEBQMKSB;e_F~SVFDMSGKAWM?R;z_FrSB@?SGA"],["FK","Falkland Islands","nkAx_Ao@Wa@HWO_@PJLt@JPM`@P"],["FR","France","cB}~@ELQ?SN[RSCa@PIBK?QHy@FRXD\\HDPC?HZT@RSGMP@JKLLJI^UBBPb@TnAIx@JBXl@Bl@QLFhAQNMSWGoAh@i@ZS|@OB]s@GcAHLm@e@P}A_@K_@;p_AeDVb@J\\NNP@DKHAJJNGIQAQGONWB[Ua@MB[Hk@`@;}Jus@J\\PGHYGOYM"],["GA","Gabon","cMyAQCWDWCE@BNKT]CIFPl@QVE^DXJPb@?RSBPZBJHMZ\\Th@i@X_@Vi@AKGMI[G]MAy@?"],["GB","United Kingdom","vFibA\\GV?GUFU_@?k@V;vBihAh@j@g@Ek@?H`@b@b@g@@CBc@n@YDYj@INq@FDXRJORb@Tt@?bAHPGXPd@CZNTG{@i@c@I~@EHOi@KTUEY{@BEWXW@?n@GHIOQLKTR@g@RSMg@_@a@_@B"],["GE","Georgia","ew@qr@t@Df@Sh@@EOH[TMVELKEC_@D{@Fu@PGFWEc@FMNWHHDSRDDTA\\K"],["GH","Ghana","pBaKB]?UeAAQ@KEQB@JOR?\\C\\INFb@ARKVGL|@VTLb@Jb@KAOPa@Im@Q_@"],["GN","Guinea","`IwKF@@LGNI^LDBDCFBND?H?HNH?FIAONWHBH@H@?MDKAIHQHM^?HFJ?DHBHTPPWLOJCHGBQDIJEQSK@KGG?ECBMEC?MS?[HG?CCU@EAALE?ICG?IJQ@IGMEGEG@IFCJONFH?LGCCB@J"],["GM","Gambia","`TmOEQk@?GIKAOHK?MEGJPFN?PGLFF@HB"],["GW","Guinea-Bissau","bPwN?LDBCLDBF?JFJAPRROPAFK?EJGBIUEM@IE"],["GQ","Equatorial Guinea","aK{AaA@?n@x@?L@FE"],["GR","Greece","eXop@QSAMME?IYCOGU?EEGA]@_@K[Lc@C?SSJJVHDVARCp@H[VRDT?TUDHGVSPNHWPSJ?Td@IKRXBOb@X?`@QL_@FYLQTW;s\\sk@UL_@A[@?DUCDJx@BAGp@G"],["GL","Greenland","ly@ifBeCWkC@s@MkCC_IDyF\\hANvC@vEBSFmCEwBLmAKa@Lj@VeBMaEOwBFUNbDZTH~BD{A@l@\\^XAj@o@X~@@`AJiATI`@h@Bs@`@xABm@NJLv@Dv@?q@X?PnAORHu@Hs@XO^fAF\\Op@WMZl@RgB@w@@jBb@jB^rBJl@@f@Lv@h@tAZZ@t@Hv@H`@V@ZRX~@^O^P`@Td@v@@x@_@nA?f@UXg@dAq@RYDc@t@c@M]XMe@m@{@OOOI_@l@NTBb@Dp@K@[OSc@AqAJbAYb@Mf@D`@Im@e@XM\\[n@i@r@O?OhBWtAChB@`BBl@MdAWgBKqACjDIxAOEOwCQqCSOMjBMa@OiC[y@CNQ}AK{BEyB?k@JiBU_BNw@@sAL~AU"],["GT","Guatemala","lnBgU?^Bj@K?MFCEIBPNPJBFCDFJH@ABDBLH@DREXAPGTOAKCGDGS_@s@??MDABINGLMQ??Ue@?"],["GY","Guyana","teAkAH@TCJHPFL@BFRAVS@QHSEa@IMFQLECQFIT@X]IK?QWEIGLMCO_@UYLWXARM@UROLDb@VHAFFTQZK?EV"],["HN","Honduras","tnB_QGKBECGQKQOE@GEKACBEAQBQAMCCCK@I@I?GCQDG?KFKHMDIHL?DBLDH?FDFADEB?DHB??FLHFDBBJGFJFAH@?RD?BFJ@FKJCCODCFAPB@EJEFG"],["HR","Croatia","wVaw@PIZ@`@GP@HFLIFPSPGJQNOFMNc@NBDd@MTMd@K`@]IARQ?MXEJPJMAM[@GGMFO?@KMCCO_@IMB]P_@FOEGNMH"],["HT","Haiti","rxAsWCTBLHFIJ?HXER@VAPDTKCKc@B]BMGPQ?OVEGIW@"],["HU","Hungary","gSqy@MYFGU?COSHMBa@ECGM?SEC@SEGGMAi@JICUHAHVHPXXZ^DV?\\HND^G\\QLCFM"],["ID","Indonesia","{uCxKN?t@[e@GUJMJ;e{CbJCFAJX\\`@FDCCMQW;krCbIMHYAINn@FXDT?MWU?;sxCbIDTz@Jt@E?M_@GYJYC;wfCnGmABGQiAROX{@Fo@Tl@Nj@Ob@@h@Cb@Gl@M\\CNBhAODQd@A[e@o@@_@NQ@;kgDvFRZB]GMGMIJ;a~ChCNLXGFOg@A;abDzBO\\`@O`@CTBZAIUo@A;goDfB?`CA`Cb@_@f@GHJr@?Q_@WKHi@Pa@lAa@`@Cz@c@JPLBHM?Q\\Si@M]@BKx@?NWb@EPSu@IUM_APELI~@i@Va@i@m@Wc@?a@L]L;q{Cw@^d@\\Ff@G`A@`@DD\\c@b@UQiAMBRPENTb@Ne@r@FLc@l@?XRJNMQa@d@NHKCMZWAe@XJCl@Ax@XBPIKe@De@N?L[QYC_@U{@GOa@]]Js@Bm@?e@];{_Dm@@b@TCDVQTJBNYJq@G_@MMARWB;ahCoAGXYVYIYBWSQCe@J_@IUu@MMMm@m@?c@DVb@]d@DPk@d@n@BJZ?b@d@Z?f@Nz@DMl@PNWZARMn@NLSX@`@CDu@RKPa@Da@Ce@;gcChFj@?`@_@p@a@PW\\_@R]\\w@b@a@Ja@L]b@YRa@^Uf@k@BUY@}@Fa@f@_@XUPe@h@g@?a@ZW`@]PN^ULM@GZMT[BSVHp@"],["IN","India","yrBqZR_AJ@DVTSKUQCSa@VEd@?d@C@[RA^QLZ]RXNFLWHDVM\\E`@DLZ?n@FA\\TVx@Xj@n@\\Xf@X?PRHb@LR@H\\Gr@A`@Pd@?bAR@P\\KLb@HLZNJd@e@Pw@Ng@LSTe@Hq@DWb@w@PmAJq@?o@De@x@V\\Er@o@SMJOl@a@YYwA?Fa@TSD_@XQk@i@o@Bg@i@Yi@e@g@?[a@U^SL[La@SQ{@Hk@Eg@a@i@n@B^OR?R\\CKj@e@Vw@ZVPNd@e@Ne@Ps@Vw@BUR]Bq@H_@?COBYAQYGA^AFc@NWGa@Ba@AAWNK_@Ec@]m@Ya@H[OSVLPk@DALLFCV\\Er@ZATT`@@PP`@\\I@h@HLCN"],["IE","Ireland","lH}cAGTFTW?]FEZ\\b@dAVx@Ea@i@Ti@u@]"],["IR","Iran","okAqk@Np@HZODNTK^CX]DCXd@b@STOVg@P?`@SFAPx@RLl@jAKh@Gl@EPo@PG^Ff@Pn@Kf@_@f@IXe@\\u@RDXKNLTS?UJ?E[R]p@UZe@I_@SM@WZKXm@R_@EMJm@[IELSR[BM?o@]MCKJLRYTIAKZe@H[Rw@D_AIAIc@G[U[?OE]@k@T_@Bm@`@[@"],["IQ","Iraq","}v@mm@Yl@[JAVRLH^[d@q@TS\\DZK??TURVAXA\\d@hACnBoAz@[n@INq@wAg@Oq@B[UISYQEm@DMH"],["IS","Iceland","bQarAHXm@Xr@^rBX`@Fr@EnBKe@QtASeAG@KrAG[Y{@E}@X}@Uq@JaAU"],["IL","Israel","oj@ed@Ty@KM@AIQG_@EIA?K?CEIAAPDDDJLEHZKBJD?HQE?NR~@"],["IT","Italy","aLsy@WDCGg@EILw@HBRIN^E^LARDJMRe@RS`@k@^_@?GFHFc@L[Jc@TCFFLTSb@ENX[NBRN@T`@NB?KGUGGNWJSNCJQXGNO\\A^Qb@YZWJe@RE^KPBVRN@CQTCH_@MKJMAKOFS?UMGDQAIO[DQG;kRyn@L^EJFT\\ORCv@SCUo@Bg@C;oJor@WZDr@PANLLI@q@HUU@"],["JM","Jamaica","|_BcVYBUHEHZ@JDTEVOEGOA"],["JO","Jordan","oo@wh@Op@FDnARg@f@LDDL\\DHLPJj@E@ES_A?OEK?WEKm@N"],["JP","Japan","igDui@CLTVNKRFJVXK?QUWWBOO;goDmm@N^ERRZp@RfA@v@l@ZO?]dAFn@Rl@?g@\\XbAXNRMIc@XKN[e@KUYg@S[[oAKk@Fg@eA[Py@g@WMWq@Dk@OYi@GUv@?^d@h@;{rDev@[F[QIl@z@H`@f@~@[Tj@j@@Dg@S_@k@AIu@K_@o@h@"],["KZ","Kazakhstan","elBo|@\\X`@B@f@TPlAM\\fARHnANc@bAXJATVERMz@C`AALBx@OTFDV`AMXDHPTDt@ZN\\N?HSr@?Fa@R?Cg@n@]bABn@Dd@c@^O|@[FCdBV?rCR@Z_@XIl@FPJ@IIOFMl@MPc@TI@Kg@B?]a@Ec@DEg@DWf@@`@Il@Pd@FRECUXY\\@`@[W]JG_@k@i@VC]qAk@_A?wAXm@Pk@Q}@?s@RKKw@@IQ`A[g@SFIe@KZYQMuCMQIcBMc@QgAHMf@g@Is@L@Te@AcBe@LJq@^yAdBSUw@Vy@IUDQV[FQNs@E"],["KE","Kenya","ck@{ESD?TML[?q@`@M?G?IBYBKQc@OOL[?`@j@?pCW`@ZNHNN@D\\JNFXNLx@g@@WpCqADC?i@KOQ[O[Pm@BSR[WW"],["KG","Kyrgyzstan","icB}s@DH|@RLNr@DLVj@CXFf@PEHHFjADp@Kj@@CUk@DMK]Bs@[n@UZH\\Ma@YJCIQYEaALEWUGy@NMCaA@{@BSL"],["KH","Cambodia","g_CgNHo@Ya@s@Ec@Da@LQYc@LGXBn@bA^QVh@@`@N`@ENS"],["KR","South Korea","m_Dgo@a@l@IX?l@LTb@F^Nb@BDUG]Pi@]EZa@CCQ@MQ]AOA"],["XK","Kosovo","wXis@BMFCHKGGICEKEAEBGBCDG@GDE?DHBDA@H@VD@F"],["KW","Kuwait","ey@kc@]e@Y@IPBHK\\Z?HQ"],["LA","Laos","o}ByYAHU@Dm@SEW\\Qd@q@?M`@VJJLo@Va@l@Wb@]ZIZDf@b@MPX`@MMQAa@^c@Bg@\\_@\\AFLV?JEh@V?c@Ii@ZA@WPKIO"],["LB","Lebanon","wk@sh@H@BDJ?M_@S[?AQ@ENTN"],["LR","Liberia","pIsH@JCRFPKHK@QP?NBB@`@H?h@Sb@]`@UZYIKAKQUQQIAICOV@NGHI?IO"],["LY","Libya","_Ni\\PY^QPDLU@OV]OO@YCU@QE_@@QJc@QICOBQ[MKMSIA_@m@LQC_@Fu@PQ`@c@Fw@Pk@RQKSQH]MS[Q[Eu@FMPM?MFe@BILLPEPHVK^?lC?rC?nAl@??N~CkA~CkAf@TZLTU"],["LK","Sri Lanka","geBkHDf@PJ`@HR_@Dy@Q_A[TQZ"],["LS","Lesotho","gc@dc@MJLRDJTFFJLB\\]UYSOSG"],["LT","Lithuania","c`@odACP`@JFTj@Nd@?HKREBICIPEh@GFa@m@KcABe@CEFU@"],["LU","Luxembourg","aF}|@EUIAGH@PJ?"],["LV","Latvia","gb@eeAj@LVFd@STADGd@BbACl@JA]SWc@M_@\\_@AG]a@EQBa@La@@QFCR"],["MA","Morocco","tA}j@MVAXMh@KFFNr@DPNV@@\\l@NNR^Hf@D~@\\?n@D??TV?LHP?LE`@BJ^L@Pr@v@h@Jv@PPBLxABASMIMUBKM[UYMEKW?UMW[MWi@A?SOc@C_@[SIa@a@Hq@Ma@ESY[g@Q]OYi@KW]?WNe@Ai@F"],["MD","Moldova","g`@g{@IEYC]JO@QH@LMDENMJ@BEDH@VABCF@CFJJDLHBFQCO?QVWJQLI"],["MG","Madagascar","}|@pNIPIXEn@KRBPFJLWFJG\\BPHF@`@Nl@Rv@VjANv@Pl@^Hb@NTI^MJU@c@L]B]G[QG?KQ_@CWFSFWBe@MUEYS?UIMEQ?WW_@WKSDQQDU[?WMQ"],["MX","Mexico","jmBcVF?LVFCB@?Db@?d@??TP?MLOFCHE@?Lr@?R^EFBF@Jj@i@TM^IT@^NRBZI\\Gd@Q\\El@Q^SHIVCf@KNQj@URYHSMCBIIK?KLQBOLS`@g@f@_@RW`@QFGEYRIVQH[TCTSRS?KT]L_@?MZOL@VKDNGRC\\KN]ZGFEBCLGAGXKHGNYRKb@KPKPATS@OPMP@DNNF?HYXUZSTIA[DURKXQDBHIVIVUACQ@MMAQ^]TINYLYP_@Pc@m@As@CBD{@R{AZmA?_@??OeA?MLSJWPMTITSJa@JW_@a@A[NSZMVWTGZKR]J[FO?N`@D\\Br@@RETKRG\\Y\\IVOPi@JONc@I]C]GYGYOGUCa@EK[Ii@Ic@@WCIF@RTVFVEFDNH^HI"],["MK","Macedonia","gYar@NIDOEMC?AGWEIAKAS?SJAXF@DDT?NF"],["ML","Mali","MuQV@HGTDd@NFJ\\PDHNFRCJFDZ\\`@?JHPAVNDHBDOJBDAFJ\\?JEDBJKAKBCFB?MGINOBKHGFAFDLDHFPAHKF?HBD?@MAKBONIDW@WKGGWK?[HUGOBEI_D?I[FEPkDRkD}@?eCtAeCvAIPYJQD?Xk@C?zATX@Xb@Dt@BNL"],["MM","Myanmar","mrByX@a@MF?]SIBOIMAi@]HQa@AQUa@@Us@[]DBWMG@MUCMVQH?\\@`@d@^Bn@i@EIb@YFJ`@]LOF]KAN`@XHNTFVPZ@Ph@NFQb@YZOXLb@LFIRY\\CV?POb@Td@Rf@B]K]JWAi@NUJo@Fq@Pa@XRl@\\TCVIMq@Hc@\\m@COTC"],["ME","Montenegro","aXgt@HB@GPRAJFAHMPGCEEUMIEAKDEDKBOFBB"],["MN","Mongolia","{pCk}@R\\Zf@INUCg@D]M_@Jc@ZBL^Cx@DZHZX|@Nf@Tf@GVCRXKNGJZL\\Tl@Lz@?~@Ln@TPKn@?x@Wf@Et@DpAIj@?VUPe@VCn@Yt@Cn@GLOMo@X_@x@M`@UH[i@EkAc@}@Qa@Ji@?YRg@?y@Hg@YNWg@i@m@Nc@Dm@HG\\y@Nc@Gs@Cg@De@PYRc@?q@De@Is@Ey@[WBUL"],["MZ","Mozambique","ej@jM]Ao@HKCYAOKW@i@O_@WGP@f@Cb@A|@GRJZNZXVb@Nl@Rj@h@NFZZNHBZS\\EVAJEA?d@FRIDDNNN`@Jn@TPNCNI@@T^?@QDQBMGm@J[Pw@i@m@I[ECCWDKA]GY?s@RKRCFIRG^@BO@[wBa@WRICOHANFRCZYVK[OG@s@P[LML@Hs@"],["MR","Mauritania","zIga@wC`B|@?SjDQjDGDHZ~C?DHNCTFZIJ?FVJFZ[V]XIRKT?PHRCLJBSKSCe@Bg@DSCSHQRQGM{C?Dw@IUc@A?gBaC@"],["MW","Malawi","ej@jMH^Ir@MAMLQZAr@NFJZXWB[GS@ONIHBVSRIKc@KMFa@G_@GIHa@RQg@DGJMP"],["MY","Malaysia","wmCuDQTGMS@AYAS][U]OASTANYJa@JBNX@EPZLb@El@?Ll@LLTt@^Hd@KPBVRXCXHXWFY]L]GGa@QGo@G[_@;u~BwFG@WXQXAXBPCLAVMJO`@?L\\@d@[l@_@DST[D_@LUC]FOEGa@PARYC"],["NA","Namibia","uMrTQGWEY?WPEAaDA[RaBDgAQa@GY@OH?@VHJ?VNNQ|@L\\@?lCf@@?rB?rCb@RTBVGPAFQNIPR\\_@N[Fg@H[L}@?o@DUNORa@Ro@HW^g@"],["NC","New Caledonia","gnEjY_@VSPLHTI\\QVUZ[BMO?ULQL"],["NE","Niger","oCqM\\WL?LJA[n@G?STYDQASY?OMu@Cc@EAYUY?{Ay@QqBmAiCkA_ANUT[MI|@MHAJOLFPNnA@r@r@d@Nt@OL?XY?BRJ@?JF@Zk@FA^T\\KTAJDVAVPR?n@SPHT?LOf@Mj@BHFDVHN"],["NG","Nigeria","kByFA_A@YGYKKSWBKGOHWAKCc@IOEWIGk@Cg@LMNU?QIo@RS?WQW@KEU@]J_@UG@[j@GAONDF@L`@\\HXDRFHFZTNDRFNBNZLTON?VVH?Rd@H\\h@LLANF^?TYJ[ZY^?"],["NI","Nicaragua","pgBuLHFJADGJCHDXIDBLKROFMNKRQCEEDCCKACGE??SIAG@GKKFCCGEMI?GC?EIC?EDG@GEI?MEECM?BB@FCNFLBN@NAJAPFB@NAHFJAH"],["NL","Netherlands","uFo~@TIXQb@H\\CUIa@{@u@Oa@?GLHb@HNV?"],["NO","Norway","wb@iuAO[p@O|@JR\\d@Pj@Ir@@j@SVHV@DXjAEHTf@?XZf@j@|@v@MLLNd@?Xb@At@YRLn@`@XNVZWlAl@t@Fv@SLi@J{Ac@YiBa@oAi@gAw@_BkAcA]mBq@wAQ_A@}@a@gA@gAG}B\\r@Hk@XbAN;{]i`BvANdAIYIVKsAGOL;yUsbBcC\\bBNVZ`@FR`@n@@tAYc@Mz@IlAa@\\_@kBMULy@?MM{@A;y^ocBmALz@TrBBrBEFKx@?j@Q{BKy@Hg@K"],["NP","Nepal","kdBwd@QG_@Jg@XUDMP]F_@Pm@Hm@@@PCXBN^?p@I\\CTSv@Cr@Wd@Qd@OOe@"],["NZ","New Zealand","gwEbr@IP[OKN?NLRZZRNOR^?`@NHXVf@\\PRJd@AXKh@CFMU]q@g@YE[Oa@SYUO]OIEU[Q;gyEdl@]h@?YQHE\\_@L[@UMSBHb@JT\\?HJCPDDNTRZ\\NFINEWa@LUj@OAM[MG]@YN[?EPQ^a@N[MCUT_@H"],["OM","Oman","ieAc_@FMKMEBBN;_dAk[AOKO?QQGFCCYS?QXUL]DWFQTILMB?HLVDHPLLXPAFHFREZBBP?XNBPFFX?NH?NPJTCZLP@J[^aAwBg@YoA"],["PK","Pakistan","akAid@cATg@EWBGG[Bs@QAa@UU]?CK]COBMK@WQWWILYe@?IM@OSOBSHOWQi@Gm@EUEUE]RK\\aANf@`@j@Dz@IRPM`@MZ_@R`@T?Zd@f@Xh@f@h@n@Cj@h@YPE^URG`@vA?XX\\IJ[^_@fAF`A@v@BMm@y@S@QRG?a@f@QNW"],["PA","Panama","t_ByIBDGTFJJADRJKHUIIHCDKRKP@FLNHH@BFSTJDBDR@DWDDJAFOPCHCN?@HBGAEAI?EEEHC?QOAML?FO@CCIHSAQIWGMKU@@BU@QDKJ"],["PE","Peru","|uAtLc@~@HL@Z?`@NRGLHLQ`@Xj@HRRHh@W@OnAg@fAk@\\WNa@EI`@u@f@gAd@oANQJ]^YZOKQPe@K[_@YCNHH?NOCQBORUOG[Wa@o@Ok@i@KYB]ICYRMPQHWh@[DWKMFWC]RXf@K?STb@ADD^Fl@X@RHLCTVH?PJDQb@UXHN[@MTc@@_@W@z@QB"],["PH","Philippines","_}CoICXATLd@Li@RRM\\JPn@UH]KQXSJPPA\\TFKOa@YIUOMP]IEQ[A@]_@PCR;_zC{KNLJXJJV[GKIICYUADZ]g@;csCsJt@d@S[]YW[Se@G^XT;kwC{MWJW??PPNXJ@QCS;{{CeNKj@^IAJIXRF@[JADWWB?OX]g@?;}vCiOJ`@NST]c@?;svCcVYJKKCJFNMZH`@VJD`@I\\SDQEq@TBTMHBP^SLSJLVWb@DRGAOKKJGDLRUDQ?e@OJC}@Kc@"],["PG","Papua New Guinea","ioDjJ@aC?aCeAZiATYRWTETaAXIRd@BIZc@XYh@UA@P_@FJDi@PBJX@HIb@Cf@E\\YVURc@r@O`@HVLC\\\\LVG;{aEnGJBPMNYH]ECCJKFSXQL;_}DzET@DJTHRFT?^IVKCKc@DUCEQEACTUCKMUMBWW?GD@T;m~DrDJHFUHOPMTO\\KKIUJKFQHONML"],["PL","Poland","k\\kbAAPIL?NVFKRANSb@DJPBd@^KPHAd@MZBRCTHTMNB@APS\\ABKZCDHRGAK\\CRKNYCMHSNOKIHS[K}@Qq@Mg@DCHe@?q@DiAASD"],["PR","Puerto Rico","zqAcVU@EFHH\\?V@@OEE"],["KP","North Korea","izC}p@a@Wk@UY[SJa@@DU}@OOWYVEFNCPLJLAZRHFDLJZDNJ@PBBODUPDHN@\\@LPPABBPGDFHB@GHCJEKQGC@GIUBETC"],["PT","Portugal","hJks@OIOEIRW?ECW?IRPJ?\\FD?RP@OVHZKHBJNLCLNHTERDE_@BWPCHOCYOMAOIW@QFM"],["PY","Paraguay","hcAd_@D`@b@^^Dj@Ef@Ke@{@DQf@Op@[^EhAaAOo@AUQa@eAKe@?c@RALKTBt@i@FQGYHGJCb@CNM@OEMD?TDV"],["PS","Palestine","gk@kf@PD?IKEJCI[MD?V"],["QA","Qatar","o~@}]@]ISKCKJ?VFTJB"],["RO","Romania","ub@su@VCZOn@HRHx@A\\ENBJQFEIGHCJFVI@QXGBMTO_@EY[QYWIQGWBY?QHME]CIGO?KBMHKPWV?PBNGPQFQEQDAHRHJC"],["RU","Russia","w{@gs@VNFHPAXYJ?VILOb@GVDFGt@Qz@G^EDBp@a@l@M`@W[Ea@a@VO{@O@Gb@DAQSKg@AEMHUQS@Kx@MV@VS\\Dr@MAENQ^A@KIGXWh@BJAHHLAHYHKGC_@?OGJIXGAENGXYGKBQd@ITDBIh@ILWBSPGOMJc@]WDGk@Uh@QuAs@e@UMSx@[OYb@]Ya@l@m@e@]|@YE[_@CcAOi@MaAVkBHwCj@]RCXl@T~@HrD]ZB_A\\CPAh@s@J]HESVOYO_BXa@IZ]}Ag@c@Be@LW[`@WSW\\WoBJUTp@D?T_@L}@IIWsASiCa@]@d@Vq@B[MiA?{@Qm@Vm@Yh@USMuBJw@JoCl@[Sh@U?Gn@CKST]?MiAc@Yc@]GiBHGVd@^WJMZHv@k@VNXlAx@k@DOOk@IKSa@QVWSYj@AHW_@g@r@_@gAYH]S?UTNd@i@FP[cAOqAAiATb@a@Bi@eAG_B@uAE^Sm@Ym@AmASiBCMKgBCa@HwAUiA?KOe@Q}AOcALt@FyAFKPc@GuB?yAR_@LHRj@JhBT\\Jq@Dy@Hc@GUXOI_AEaCDGRgDDA_@uAF_A?_ARQXVNq@^_ANe@i@_APcAImAJ]K_ADZc@s@QiJXa@VgB\\aDGoAFa@ND\\q@Hu@GeA?kAFkAEeAb@o@K^YQQ_CJqACsBRw@P?|C?@r@Nr@Ac@RW`@QHEPHHjAGnB\\`@B|@Zx@VLPx@YfB\\PMd@Nt@CLXn@d@ANm@HDx@b@@P^OPdARLl@x@HJf@x@d@N[Ny@TyAQu@a@WAS}@GgAq@cAi@gA_@_@w@n@BV^dBj@^o@fBJbBbAa@VxAH|@BC[|@Ep@RxBGbCJ`ClAvC|A}@DSVe@HYSk@@y@j@A`@^f@Bn@P~@z@x@LZt@l@t@l@XVr@VX?VSt@\\DLDG?SSAEm@Ha@a@Mo@DYe@Mk@OOUc@bAJ`@Nz@?Ne@n@[dAKLg@LWNQVg@b@Mz@Kr@?p@F^RUH?TTJb@h@?Pv@Xn@On@BTMVCx@Zr@Dd@Hp@Eb@?XSd@Qf@Er@Bb@Fx@OF]l@Ib@El@Of@h@OVf@Xx@If@?XSh@?`@K|@PjAb@h@DNBRYr@DPOZGPWTEx@Hv@WRTxAeBp@_@MKbBd@d@@AUr@Mf@HLg@fAIb@PbBLPHtCLPL[Xd@JGHf@RaAZHPv@AJJr@S|@?j@Pl@QvAY~@?pAj@B\\h@W^j@KFV\\a@Z]AYXBTSDPVd@Df@h@c@d@BX;qY_dAi@FQDBHCHhA@p@EIO;yh@mx@II[FM@CFE??BSHi@AFLj@Dt@VTGGSj@KGEe@M;qrDm~@g@dAz@KVx@g@f@@Z\\WX^Fa@Cg@Bi@I]Au@Vg@Cu@c@QNSQCIXMd@?f@;vyEgrAYHF[kBDmAb@f@P`AB?f@NFd@A\\Mt@IFQf@El@BTMGMn@HQPTN?}CaB\\gBf@;_`FqwAj@@DKq@O;j~EswAr@@?YEAa@?w@J@B;orDozAz@?pACFAe@Oq@Cy@L;m{D{|Al@N~@CjAMIMiAD;ktDm}A^\\rCA`AHnAYU[u@GgB@;}fAkwAV@`CCJQfAIDUi@I@SoAc@d@C_Bc@HQwAScCYeCGcAMmAE[NXJlCRxBRzBd@z@d@~@f@G^;kbC{`B`FNgAu@a@C]@cBV;}~@ucBt@Db@@DDl@Fj@IUKvAAmAE{@AGJWIe@Ey@F;}{BsaBvADnBK`AO\\[t@GgBYuAImAR{Ad@"],["RW","Rwanda","ae@~ARAJTXACUECAWKIGBWKOT@V"],["EH","Western Sahara","xIqa@?@@F?z@`CA?fBb@@HTEv@zC?FLAOyACCMQQKw@w@i@Qs@MAK_@a@CMDQ?MIW??U"],["SA","Saudi Arabia","o_Ai]?HOf@wBRGGQZXnAvBf@rBNb@P\\h@PDHMN@d@CFCl@@HBNKJRCPNJDOJMBMROT_@Ha@ZYPGXe@D[AWTk@RORGLUAIHSJIN[Va@RYR?EUAMCOk@DQKIM]EEMMEf@g@oASGEo@H{@ZoBnAiABc@BIP[?O`@SHEL[NANBLELKHCLEHKFKC"],["SD","Sudan","u]iI\\OLK@KEQ?OTWDQAINK?UFOL@CMIOBQKKFIIWQ]c@B@_D?Om@??oA_D?{C?}C?Mf@HDEh@On@MHULRT\\FJJBXPz@ENF`@Nd@VRN^BNRHJh@?b@?]DAASDMRMB]C]PABHV@IHCVTTR\\RB`@WNFBJRF@Ff@?BG\\ALFHCTWDI\\DHPHb@LDJD"],["SS","South Sudan","ea@qEDK\\OHWNQZS?MTOXMKEMEIc@IQ]EEHUVIBMG]@CFg@?AGSGCKOGa@VSCS]UUBWHIWACIQ@B\\C\\SLEL@RE@?\\BJT@LTWBUPENQHWj@ZXVVVPZ?^HXINJb@YHQTFPAHDPC"],["SN","Senegal","jMqND@TABBF?ZIR?hAAHDLATDD]c@?ICGAMGQFO?QGFKLDJ?NIJ@FHj@?P]ROQES[IUMKSBQIU?SJYHW\\[ZAVEVOHCN"],["SB","Solomon Islands","siEbLKLZANWWH;ahEhKN@VCFEAOYDMF;ciE~JDF\\c@FWK?O^;{fElI?F\\QTMNMECQHa@P;}cEdHF@PGNQAEWN"],["SL","Sierra Leone","pOcJUQCIEIK?IG_@?ILIP@HEJ?LIAPPPT@JHJHA\\ORUDM"],["SV","El Salvador","roBePAEMIEC@CIAK@GFKDADQCG@EBBNBHV?LCNGTA"],["XS","Somaliland","ot@uLMSKDGPQNS?e@Ik@Cc@MQAOGU??N?h@?RPVZ`@`@?`Co@NMLQNU"],["SO","Somalia","is@{CKMW?c@[s@AqBwB[a@QW?S?i@?OKASESCSKM?AHBV?RFLJj@Rj@Vr@`@x@`@l@n@t@f@^z@f@b@\\j@n@HTFHVa@?qC"],["RS","Serbia","i[iv@HHCLSPNJDJCDDDR?J@@ACEEID?FEFABEFCDCD@DJHBCCNGJCDEJEIAESRMIQL?OOLIFO]IW?UNCLYFAPWHKGIBHF"],["SR","Suriname","bcA{AVGPBNCBJEFBFTCVa@DWJ?P[GU@GWIEc@o@FCG_@Ck@JT`@CZOVFN@P"],["SK","Slovakia","gTc{@BMAEEGQ?MC?CGAAGIAEGK?A@OCULUISB[Ce@LHHFPHBh@KL@FFRDBARDL?BF`@DLC"],["SI","Slovenia","gPcy@a@@SGa@AGEE?GL^HBNLBAJN?LGFFZAICHO"],["SE","Sweden","yXkuAu@R}@X?|@MNbAJf@XEX|@^lA`@\\v@]Ze@Td@l@f@HN`ATd@p@CT^l@@Je@`@m@\\w@OWa@YMo@XS@u@Yc@e@?MOLM}@w@g@k@Y[g@?IUkADEY"],["SZ","Swaziland","yf@h_@EPAPFPTBVU?MIOCIKC"],["SY","Syria","}s@qm@RXTHCZNp@vAf@lAj@l@OEE@QISUODOPAB]IOIIKGAUKFk@KUF_@?m@OU@"],["TD","Chad","q[}LVFTNZh@d@Rd@AJ@CLRLPNp@NHID?FH^BEKL[BOPEVWGQSBICU?Tc@AY@YNYCSX??YNMOu@s@e@As@OoAGQNM@KLIH}@g@U_DjA_DjAA~Cb@CP\\HVGHJJCPHNBLMAGN?TOJ"],["TG","Togo","c@wLDTMHML?RGF@zAIZ^FFMJW@SGc@HOB]?]NSAK"],["TH","Thailand","obCyPb@Er@DX`@In@b@Q`@?E]b@?Bj@Rx@Lb@AZY@Qb@E`@UVWBUTLNXB@S`@QDFNOFSRURSDVFUCWKg@Sg@Ue@Nc@?QBWX]HSMGMc@NYX[Pc@OGQi@[AWQUGQJAV[@Hh@?b@i@WKDW?GM]@]^Cf@_@b@@`@"],["TJ","Tajikistan","w|Awm@h@?ZCVPPBLFNKCa@JACKTINLDNDDV?JPLGZLJEUg@F]\\IIQa@@QUMYs@GFPEJOALJj@EBTk@Aq@JkAEId@KCWF?N"],["TM","Turkmenistan","crAum@JAPIDL`@FF^TJ^DFP\\Dh@OBa@ZAl@a@^Cj@U\\ANDZ?ZTb@FD[Ei@^MI[XAGa@e@Hc@K\\WJU^HBZJYQKm@GYH[^SAm@?DUa@Ka@Wu@TC\\MHk@AMDQh@m@ZYPi@Ru@P"],["TL","Timor-Leste","k{CvJ@KBGEIa@G[AKEODNHf@P"],["TT","Trinidad and Tobago","blAmLWEG@@\\^BFCKI"],["TN","Tunisia","{J{d@PgAVO?I`@WB]YUIa@Fe@GSk@O[B?Ta@OAFRR?PMHD`@XRGTS@IPOD@^RHJLZLCPBN"],["TR","Turkey","ou@kr@ELBR]HOJZHKl@DLS^PDLIl@EPDl@FTAl@N^?TGj@JJG@TJFHHLQMOVB`@IXV|@B^Uj@AFPZBd@Uj@@Vg@\\US_@XQm@e@{@AQ]kABo@Ym@IaAAeAZy@Nm@Ea@Bo@Ui@A;s_@is@i@Ka@DCNc@JFHn@@NJ`@TJQ?GIEKW"],["TW","Taiwan","gwCo]V~@P`@Ta@B]Wg@_@]QJ"],["TZ","Tanzania","uc@rDOAMMOUIG?KFIBOKCAWNUMEk@@qACEBqCpAAVy@f@Pn@AVYL?HHVAJ@RMVOf@MF^Vh@NVANJX@JBn@I\\@Hu@LQFKf@ETKXGNENITq@VWFUCU"],["UG","Uganda","_d@t@?]GOC_@GQMUOIKMNECm@OKYH_@I[?WQSZCRQl@NZPZJN?h@pABj@ALDVJ"],["UA","Ukraine","m\\o_AQ?UK_@?g@@k@H_@@MBOEIHc@AOBASMIa@AM@IIK@i@CYVHFAJ_@@OP@Ds@L]EWRWAy@LAJPRITDLf@@RJ@P\\BZJd@@`@NARD?BGLAZGHHDE|@I@Md@BLT^\\PEPDPGICEMKKBGGACBW@IADEACLKDOLEAMPINA\\KXBHDN?HF\\BLDPIX?VCPF@ITIGQIII@JQe@_@QCEK"],["UY","Uruguay","`hAji@CYGG?g@Ki@G_@YCi@^MAi@X]TWZPPKTPXl@TZGTBd@OX?"],["US","United States","pxCg|@qB?uB?g@?yB?uB?wB?wB?gC?gC?sA??OM?ETKF[@i@De@J_@Cq@HM?a@Ke@Lg@N_@L]JCHIB@BI@GCAFGFK?EBDFi@PGb@Gb@JTPTFL@BCDMDI?m@Si@Es@SACBKDGQGe@?e@?KMCCk@[QG{@?iA?CIKAQEMQK_@]]MHYEQJ?t@YTGLj@Pf@Lh@JTVDH?RKTO?BMKH@HZDP?\\FP@V@^Hy@EKDv@JX?ACJJK?H\\Z\\BIFALIITID?NLNT^BAM[TMBa@FPGVXE[LAd@K@CLCf@V\\h@JXTRBRLDLj@XTPRVDZGZK`@Q\\?NSl@@Z@NHVJBPCFQLGTc@P]DOGYJU\\a@NEf@PFAPQXIl@D`@E^BNDGH@NIFFDNELF\\A\\U`@D\\IVB`@Fb@\\f@PTPFP@ZARGLN?ZG\\KJSF[VULWR[ZO`@@V^`@KRKHULUVQRKLMdA??N^?lA?zA[z@SCEr@Bl@@DSXUPEBKVALIb@CHEDUd@g@`@w@AIPK^a@B_@TUGa@?a@L]Oe@Ec@Cc@Fu@Ja@JSEGy@LSd@IIDa@;foDcvA?rC?bFg@?e@J[Pc@Xe@Ug@MUT[Nc@PWZi@l@cAX?VTRTO`@KJa@r@a@Tc@d@C~@?l@KpAi@f@GbAMv@BnAQl@Qj@HGXTBn@F`@Lj@FDWQg@i@KHIr@TZZv@Z[Rd@Zh@Nf@LHN|@TLPl@PZCb@Jh@L^JdAJDEk@Sg@Ki@Uq@CSOu@WIG]ME_@SUl@JJGTNXUJNLSf@NV?BWGOXMr@F`@QZI?U\\QMUa@WMS_@A[D_@S[B_@KFQTG[OV?h@HJF^Gv@Bz@INOp@Uw@QyAS_@?DRsA?^Yn@M\\Sd@Qt@KUUeA?s@QGSi@Se@CkAQe@B{@U}@F[PQGcA@@H{@Di@CsALkAB_@Bs@E}@J;laE{VDFHEAKDMACEG@EACA?ODGBEDIL@@LF;bbEyXJBFIBA?CCAMBID;|bEoY@DTACC;`dEsY@@BAL?BI@AICC@;dfEoZBBLEACECI@;f~DkfAf@LRIDQc@MSE[@OJ;~mE{iAVDXGVIg@G_@B;tuEwnAYFWC_@Hg@D@B^F\\GLGb@BHC"],["UZ","Uzbekistan","ysAmm@\\GV?AWt@Qh@SXQl@[Pi@LEj@@LIB]t@U`@V`@JETl@??sCeBWGB}@Z_@Ne@b@o@EcACo@\\Bf@S?G`@s@?IRO?O]u@[UEKB`@X]L[Io@Tr@Z\\CN@DKGQr@FLXPT`@AHP]HG\\"],["VE","Venezuela","|jAoEEJLLl@NZDJH^I\\EDBQH@XEXa@BAF\\JBNND\\HFJ^BTUJg@HMLGSS@IHKFYA[IMEULETB\\ANBZa@TEr@BHMHA@IEMBOFIDQRAIWE[KMMKKSWG?HVDMP@RNVM^QCG[JM@]q@QDQMKMZ[?YTALc@?i@CWP]BUKAIo@Ao@?`@JMP_@B]PG^S?OH^TBNMLHFVD?PHJ"],["VN","Vietnam","u~Ba[UI_@?g@Ca@UQLe@FFVSNg@Ht@`@^d@HZ_@h@c@r@c@VY^QhADfA`@Xl@X^^p@d@LYKY\\Wa@Oi@APWcA_@Co@FYEg@H[\\[Vc@`@m@n@WKMWKLa@p@?Pe@"],["VU","Vanuatu","ypEpSLDJQ?I;{oEtQE^HEF@DI?]"],["YE","Yemen","_`AwV_@`AKZZHFP@Lf@N~@R`@ZP@JAVNXF^@H@HHHBDHR?JBZAJUAUDKF]JOGABQCG?QOKBQKSOJICm@AGBe@BOAILQE]i@c@Q"],["ZA","South Africa","{W|]IDWd@BXIL[CSQSKGSSIQDQHa@@WGCMGQUCKMK[c@[y@]O?QDMCUBQv@KZFl@CLRGJBBHHN?LWTUCGQ_@?HZD`@HPZRDDPRJRT\\j@f@\\V\\Rh@LR@BJXEPFj@GVBPAf@N`@DXNP?NML?PQ?DDK?UJ[KE@_@Xc@Ra@Zs@QSOHGPQ@WFUCc@S:gc@dc@PKRFRNTX]\\MCGKUGEKMS"],["ZM","Zambia","_\\zTXWX_@A_CqA?@MEMFSCQBKM?AJS?WBMP_@BWKIT]BMPQT]?Bi@HDZOJEEg@Eo@FQKWIEu@EOBOHODYFUJSPI`@FHF^G`@JLJb@SHvB`@AZ\\DTNBLN@`@`@TXL?JCl@CDC?ANIXA"],["ZW","Zimbabwe","yc@rZXQ^EHY@MNCl@k@JWFEN_@m@BKBM?UYa@a@OACMUO]ECN_@ASFGHSBSJ?r@FX@\\EJBVDBHZh@l@TCLBPE"]];
