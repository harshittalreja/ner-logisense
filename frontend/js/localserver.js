// NER-LogiSense in-browser backend.
//
// A JavaScript port of the Python/FastAPI backend (backend/*.py) so the prototype can run as a
// static page with no server. Same endpoints, same JSON shapes, same algorithms:
//   * hazard model: the trained XGBoost trees evaluated directly, with exact TreeSHAP
//   * time-dependent multimodal Dijkstra with the 4 routing profiles and Monte-Carlo ETA
//   * incident ingestion, auto-verification, idempotent offline sync, audit log
//   * KPI replay against shortest-path routing
// Random draws use a seeded generator, so KPI numbers differ slightly from the Python run.

// ============================================================================ utilities
const now = () => Date.now() / 1000;
const r2 = (x, d = 2) => Math.round(x * 10 ** d) / 10 ** d;
const sigmoid = (z) => 1 / (1 + Math.exp(-z));
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
  const r = (Math.random() * 16) | 0; return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
}));
const hex = (n) => Array.from({ length: n }, () => ((Math.random() * 16) | 0).toString(16)).join("").toUpperCase();
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const randn = (rng) => { let u = 0; while (u === 0) u = rng(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng()); };
const poisson = (rng, lam) => { const L = Math.exp(-lam); let k = 0, p = 1; do { k++; p *= rng(); } while (p > L); return k - 1; };
const percentile = (arr, q) => {
  const a = [...arr].sort((x, y) => x - y); const pos = (a.length - 1) * q / 100;
  const lo = Math.floor(pos), hi = Math.ceil(pos); return a[lo] + (a[hi] - a[lo]) * (pos - lo);
};
const mean = (a) => a.reduce((s, x) => s + x, 0) / (a.length || 1);

class Heap {
  constructor() { this.a = []; }
  push(x) { const a = this.a; a.push(x); let i = a.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (a[p][0] <= a[i][0]) break; [a[p], a[i]] = [a[i], a[p]]; i = p; } }
  pop() {
    const a = this.a; const top = a[0]; const last = a.pop();
    if (a.length) { a[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i;
      if (l < a.length && a[l][0] < a[m][0]) m = l; if (r < a.length && a[r][0] < a[m][0]) m = r;
      if (m === i) break; [a[m], a[i]] = [a[i], a[m]]; i = m; } }
    return top;
  }
  get size() { return this.a.length; }
}

class HttpError extends Error { constructor(status, detail) { super(detail); this.status = status; this.detail = detail; } }

// ============================================================================ features (backend/risk/features.py)
const FEATURES = ["slope_deg", "elevation_km", "landslide_hist", "river_adjacent", "mode_code", "rain_24h", "rain_72h",
  "rain_7d", "fcst_24h", "id_ratio", "reports_6h", "monsoon"];
const MODE_CODE = { road: 0, rail: 1, ferry: 2 };
const idThreshold = (d) => 43.26 * d ** -0.78;
const idRatio = (r24, r72) => Math.max(r24 / idThreshold(1), (r72 / 3) / idThreshold(3));
function shiftRain(rain, hours) {
  if (hours <= 0) return { ...rain };
  const h = Math.min(hours, 24), f = rain.fcst_24h / 24;
  return { rain_24h: rain.rain_24h * (1 - h / 24) + f * h, rain_72h: rain.rain_72h * (1 - h / 72) + f * h,
    rain_7d: rain.rain_7d * (1 - h / 168) + f * h, fcst_24h: rain.fcst_24h };
}
function buildRow(e, rain, reports, month) {
  return [e.slope_deg, e.elevation_m / 1000, e.landslide_hist, e.river_adjacent ? 1 : 0, MODE_CODE[e.mode],
    rain.rain_24h, rain.rain_72h, rain.rain_7d, rain.fcst_24h, idRatio(rain.rain_24h, rain.rain_72h), reports,
    month >= 6 && month <= 9 ? 1 : 0];
}
function delayIfBlocked(e, rain) {
  if (e.mode === "ferry") return r2(10 + rain.rain_72h / 40, 1);
  let base = 3 + 0.35 * e.slope_deg + 1.6 * Math.sqrt(e.landslide_hist);
  if (e.river_adjacent && rain.rain_72h > 150) base += 10;
  if (e.mode === "rail") base *= 2.2;
  return r2(Math.min(base, 96), 1);
}

// ============================================================================ generator (ground truth for KPI replay)
function trueBlockProb(x) {
  const [slope, elevKm, hist, river, mode, , r72, r7d, f24, idr, , monsoon] = x;
  if (mode === 2) return sigmoid(-4.6 + 1.9 * Math.log1p(r72 / 110) + 0.3 * monsoon);
  const s = Math.min(slope, 40);
  let z = -8.2 + 0.07 * slope + 0.45 * Math.sqrt(hist)
    + 1.3 * Math.log1p(Math.max(idr - 0.8, 0)) * (s / 25)
    + (slope > 12 ? 0.4 * Math.log1p(r7d / 300) : 0)
    + (slope > 15 ? 0.006 * Math.min(f24, 200) : 0)
    + river * 0.85 * Math.log1p(r72 / 120)
    + (slope < 8 ? river * 2.2 * Math.log1p(Math.max(r72 - 120, 0) / 100) : 0)
    + 0.25 * monsoon + 0.1 * Math.min(elevKm, 4);
  if (mode === 1) z -= 0.7;
  return sigmoid(z);
}

// ============================================================================ hazard model (backend/risk/model.py)
const GROUPS = {
  rain: ["Rainfall", ["rain_24h", "rain_72h", "rain_7d", "fcst_24h", "id_ratio", "monsoon"]],
  slope: ["Steep terrain", ["slope_deg", "elevation_km"]],
  history: ["Landslide history", ["landslide_hist"]],
  river: ["River-bank alignment", ["river_adjacent"]],
  reports: ["Driver reports", ["reports_6h"]],
  mode: ["Transport mode", ["mode_code"]],
};
export function level(p, status = "open") {
  if (status === "blocked") return "blocked";
  if (p >= 0.6) return "high"; if (p >= 0.35) return "medium"; if (p >= 0.15) return "elevated"; return "low";
}
const HORIZONS = [0, 6, 12, 24];
const f32 = Math.fround;

class HazardModel {
  constructor(model, metrics) {
    this.base = model.base_margin;
    this.trees = model.trees.map((t) => ({ ...t, c: t.c.map(f32) }));
    this.metrics = metrics;
    this.version = metrics.model_version;
    // expected value of each tree (cover-weighted leaf mean), for the TreeSHAP bias term
    this.treeExp = this.trees.map((t) => this._expect(t, 0));
  }
  _expect(t, n) {
    if (t.l[n] === -1) return t.c[n];
    return (t.h[t.l[n]] * this._expect(t, t.l[n]) + t.h[t.r[n]] * this._expect(t, t.r[n])) / t.h[n];
  }
  margin(x) {
    const xf = x.map(f32);
    let s = this.base;
    for (const t of this.trees) {
      let n = 0;
      while (t.l[n] !== -1) n = xf[t.f[n]] < t.c[n] ? t.l[n] : t.r[n];
      s += t.c[n];
    }
    return s;
  }
  predict(x) { return sigmoid(this.margin(x)); }

  // Exact TreeSHAP (Lundberg et al. 2018, Algorithm 2), per tree, summed. Returns 12 + bias.
  contributions(x) {
    const xf = x.map(f32);
    const phi = new Array(FEATURES.length + 1).fill(0);
    for (let k = 0; k < this.trees.length; k++) {
      const t = this.trees[k];
      this._recurse(t, xf, phi, 0, [], 0, 1, 1, -1);
      phi[FEATURES.length] += this.treeExp[k];
    }
    phi[FEATURES.length] += this.base;
    return phi;
  }
  _recurse(t, x, phi, node, parentPath, depth, pz, po, pi) {
    const path = parentPath.slice(0, depth).map((e) => ({ ...e }));
    extendPath(path, depth, pz, po, pi);
    if (t.l[node] === -1) {
      for (let i = 1; i <= depth; i++) {
        const w = unwoundPathSum(path, depth, i);
        phi[path[i].d] += w * (path[i].o - path[i].z) * t.c[node];
      }
      return;
    }
    const split = t.f[node];
    const hot = x[split] < t.c[node] ? t.l[node] : t.r[node];
    const cold = hot === t.l[node] ? t.r[node] : t.l[node];
    let iz = 1, io = 1, k = 1;
    for (; k <= depth; k++) if (path[k].d === split) break;
    if (k <= depth) { iz = path[k].z; io = path[k].o; unwindPath(path, depth, k); depth -= 1; }
    this._recurse(t, x, phi, hot, path, depth + 1, iz * t.h[hot] / t.h[node], io, split);
    this._recurse(t, x, phi, cold, path, depth + 1, iz * t.h[cold] / t.h[node], 0, split);
  }

  scoreAll(edges, weather, reports, status) {
    const out = {};
    for (const e of edges) {
      const base = weather.forEdge(e.met_zones);
      const rep = reports[e.id] || 0;
      const p = {};
      for (const h of HORIZONS) p[h] = this.predict(buildRow(e, shiftRain(base, h), rep * Math.exp(-h / 12), weather.month));
      const st = status[e.id] || "open";
      out[e.id] = {
        p, status: st, p_now: st === "blocked" ? 1 : p[0], p_max24: st === "blocked" ? 1 : Math.max(...Object.values(p)),
        delay_if_blocked_h: delayIfBlocked(e, base), level: level(st === "blocked" ? 1 : p[0], st), rain: base, reports_6h: rep,
      };
    }
    return out;
  }

  explain(e, rain, reports, month, freshness, status = "open", verified = 0) {
    const row = buildRow(e, rain, reports, month);
    const c = this.contributions(row);
    const p = this.predict(row);
    const feat = Object.fromEntries(FEATURES.map((f, i) => [f, c[i]]));
    const factors = Object.entries(GROUPS).map(([key, [label, names]]) => ({
      key, label, logodds: r2(names.reduce((s, n) => s + feat[n], 0), 3), detail: detail(key, e, rain, reports) }));
    factors.sort((a, b) => b.logodds - a.logodds);
    const pushing = factors.filter((f) => f.logodds > 0.15 && f.detail);
    const totalPos = factors.reduce((s, f) => s + Math.max(f.logodds, 0), 0) || 1;
    factors.forEach((f) => (f.share = r2(Math.max(f.logodds, 0) / totalPos, 3)));
    const lvl = level(p);
    const headline = status === "blocked" ? "Blocked: verified report or authority closure"
      : pushing.length ? `${lvl[0].toUpperCase() + lvl.slice(1)}-risk edge: ` + pushing.slice(0, 3).map((f) => f.label.toLowerCase()).join(" + ")
      : "Low risk: no strong hazard drivers";
    return { p: r2(p, 4), level: level(p, status), headline, factors, base_logodds: r2(c[FEATURES.length], 3),
      confidence: confidence(p, freshness, reports, verified, status), reasons: pushing.slice(0, 4).map((f) => f.detail),
      model_version: this.version };
  }
}
function extendPath(path, depth, z, o, d) {
  path[depth] = { d, z, o, w: depth === 0 ? 1 : 0 };
  for (let i = depth - 1; i >= 0; i--) {
    path[i + 1].w += o * path[i].w * (i + 1) / (depth + 1);
    path[i].w = z * path[i].w * (depth - i) / (depth + 1);
  }
}
function unwindPath(path, depth, idx) {
  const o = path[idx].o, z = path[idx].z;
  let next = path[depth].w;
  for (let i = depth - 1; i >= 0; i--) {
    if (o !== 0) { const tmp = path[i].w; path[i].w = next * (depth + 1) / ((i + 1) * o); next = tmp - path[i].w * z * (depth - i) / (depth + 1); }
    else path[i].w = (path[i].w * (depth + 1)) / (z * (depth - i));
  }
  for (let i = idx; i < depth; i++) { path[i].d = path[i + 1].d; path[i].z = path[i + 1].z; path[i].o = path[i + 1].o; }
}
function unwoundPathSum(path, depth, idx) {
  const o = path[idx].o, z = path[idx].z;
  let next = path[depth].w, total = 0;
  for (let i = depth - 1; i >= 0; i--) {
    if (o !== 0) { const tmp = next * (depth + 1) / ((i + 1) * o); total += tmp; next = path[i].w - tmp * z * (depth - i) / (depth + 1); }
    else total += (path[i].w / z) / ((depth - i) / (depth + 1));
  }
  return total;
}
function detail(key, e, r, reports) {
  if (key === "rain") {
    const ex = Math.max(r.rain_24h / idThreshold(1), r.rain_72h / (idThreshold(3) * 3));
    let txt = `${r.rain_24h.toFixed(0)} mm/24 h, ${r.rain_72h.toFixed(0)} mm/72 h`;
    if (ex >= 1) txt += ` (${ex.toFixed(1)}× the I-D landslide threshold)`;
    if (r.fcst_24h >= 30) txt += `; ${r.fcst_24h.toFixed(0)} mm more forecast`;
    return txt;
  }
  if (key === "slope") return e.slope_deg >= 12 ? `${e.slope_deg}° mean slope, ${e.terrain} section` : "";
  if (key === "history") return e.landslide_hist ? `${e.landslide_hist} mapped slides within 1 km` : "";
  if (key === "river") return e.river ? `road bed along the ${e.river}` : "";
  if (key === "reports") return reports >= 0.5 ? `${reports.toFixed(0)} driver report(s) in last 6 h` : "";
  if (key === "mode") return { rail: "rail formation", ferry: "ferry: suspended in high river stage" }[e.mode] || "";
  return "";
}
function confidence(p, fresh, reports, verified, status) {
  if (status === "blocked") return { score: verified ? 0.97 : 0.85, label: "High", basis: verified ? "Closure confirmed" : "Authority / dispatcher override" };
  const certainty = Math.abs(p - 0.5) * 2;
  const score = 0.45 * fresh + 0.35 * certainty + 0.2 * Math.min(reports, 2) / 2;
  const label = score >= 0.75 ? "High" : score >= 0.55 ? "Medium" : "Low";
  const basis = [fresh >= 1 ? "live rainfall" : fresh >= 0.8 ? "scenario rainfall" : "stale rainfall"];
  if (reports >= 1) basis.push(`${reports.toFixed(0)} field report(s)`);
  if (certainty < 0.3) basis.push("score near decision boundary");
  return { score: r2(score, 2), label, basis: basis.join(", ") };
}

// ============================================================================ weather (backend/weather.py)
const Z = (a, b, c, d) => ({ rain_24h: a, rain_72h: b, rain_7d: c, fcst_24h: d });
export const SCENARIOS = {
  dry_winter: { label: "Dry season (January)", month: 1, description: "Little rain anywhere; residual risk only from terrain and history.",
    default: Z(1, 3, 6, 1), zones: { TW: Z(4, 10, 18, 6), WK: Z(3, 6, 12, 4) } },
  normal_monsoon: { label: "Typical monsoon day (July)", month: 7, description: "Widespread moderate rain; hill segments carry elevated but manageable risk.",
    default: Z(22, 65, 150, 25), zones: { ML: Z(40, 110, 260, 45), SK: Z(30, 85, 190, 35), BV: Z(28, 80, 170, 30), DH: Z(30, 85, 180, 32), MZ: Z(26, 70, 150, 28) } },
  barak_extreme: { label: "Replay: Barak / Dima Hasao extreme rain (May 2022 pattern)", month: 5,
    description: "Days of extreme rain over Dima Hasao, Barak valley, Meghalaya and Manipur; NH27, NH6, NH37 and the Lumding-Badarpur line are all under threat.",
    default: Z(18, 55, 120, 20), zones: { DH: Z(165, 390, 620, 140), BV: Z(135, 330, 520, 110), ML: Z(150, 360, 600, 120), MN: Z(95, 240, 400, 80),
      MZ: Z(90, 230, 380, 75), TR: Z(70, 180, 300, 60), CA: Z(60, 150, 260, 50), NL: Z(55, 140, 240, 45) } },
  teesta_extreme: { label: "Replay: Teesta valley cloudburst (Aug 2025 pattern)", month: 8,
    description: "Very heavy rain over Sikkim and the Darjeeling-Kalimpong hills; NH10 slides at Chitrey / Selfie Dara, NH717A under pressure.",
    default: Z(20, 60, 140, 22), zones: { SK: Z(175, 410, 640, 150), NB: Z(110, 260, 420, 90) } },
  kameng_extreme: { label: "Arunachal West Kameng heavy rain (pre-monsoon)", month: 6,
    description: "Heavy rain on NH13 between Bhalukpong and Tawang; north-bank rivers in spate.",
    default: Z(15, 45, 100, 18), zones: { WK: Z(140, 330, 520, 120), TW: Z(90, 220, 360, 70), NBK: Z(80, 200, 330, 60), AR: Z(100, 240, 380, 80) } },
};
class Weather {
  constructor(zones) { this.zones = zones; this.error = null; this.setScenario("normal_monsoon"); }
  setScenario(key) {
    const sc = SCENARIOS[key]; if (!sc) throw new HttpError(400, `scenario must be one of ${Object.keys(SCENARIOS)}`);
    this.values = Object.fromEntries(this.zones.map((z) => [z.id, { ...(sc.zones[z.id] || sc.default) }]));
    this.source = "scenario"; this.scenario = key; this.month = sc.month; this.fetched = now(); this.error = null;
  }
  forEdge(zs) {
    const vals = zs.map((z) => this.values[z]).filter(Boolean);
    const o = {}; for (const k of Object.keys(vals[0])) o[k] = Math.max(...vals.map((v) => v[k])); return o;
  }
  freshness() {
    return { source: this.source, scenario: this.scenario, age_min: r2((now() - this.fetched) / 60, 1), score: this.source === "open-meteo" ? 1 : 0.8,
      error: this.error, label: SCENARIOS[this.scenario]?.label || "Live rainfall (Open-Meteo)" };
  }
  snapshot() {
    return { freshness: this.freshness(), month: this.month, zones: this.zones.map((z) => ({ ...z, ...this.values[z.id] })),
      scenarios: Object.entries(SCENARIOS).map(([id, v]) => ({ id, label: v.label, description: v.description })) };
  }
}

// ============================================================================ routing (backend/routing.py)
export const PROFILES = {
  fastest: { label: "Fastest", alpha: 0, gamma: 0, avoid_p: null, use_k: true,
    description: "Shortest travel time. Respects confirmed closures but ignores hazard forecasts, like a standard map router." },
  balanced: { label: "Balanced", alpha: 1, gamma: 0, avoid_p: null, use_k: true,
    description: "Minimises expected arrival: travel time plus expected blockage delay (risk-neutral), weighted for cargo perishability." },
  safest: { label: "Safest", alpha: 2.5, gamma: 1.5, avoid_p: 0.5, use_k: true,
    description: "Strongly risk-averse. Excludes any edge with ≥50% blockage probability." },
  emergency: { label: "Emergency priority", alpha: 1, gamma: 0, avoid_p: 0.75, use_k: false,
    description: "Minimises expected arrival time for relief/medical priority; uses every mode available." },
};
export const CARGO = {
  general: { label: "General freight", k: 0, max_transit_h: null, temp_range: null, ferry_ok: true },
  perishable: { label: "Perishable food", k: 0.35, max_transit_h: 48, temp_range: "0–10 °C", ferry_ok: true },
  pharma: { label: "Medicines / vaccines", k: 0.6, max_transit_h: 36, temp_range: "2–8 °C", ferry_ok: true },
  relief: { label: "Relief material", k: 0.25, max_transit_h: null, temp_range: null, ferry_ok: true },
  fuel: { label: "Fuel / LPG (hazmat)", k: 0.1, max_transit_h: null, temp_range: null, ferry_ok: false },
};
const TRANSFER_H = { "road>rail": 4, "rail>road": 3, "road>ferry": 1.5, "ferry>road": 1 };
function interpP(pm, tau) {
  if (tau <= 0) return pm[0];
  for (let i = 0; i < HORIZONS.length - 1; i++) {
    const a = HORIZONS[i], b = HORIZONS[i + 1];
    if (tau <= b) { const w = (tau - a) / (b - a); return pm[a] * (1 - w) + pm[b] * w; }
  }
  return pm[24];
}
function travelTime(e, rain) {
  let t = e.base_time_h;
  if (e.mode === "road") t *= 1 + (e.terrain !== "plain" ? 0.0035 : 0.0012) * Math.min(rain.rain_24h, 200);
  return t;
}
const key = (n, m) => `${n}|${m}`;

class Router {
  constructor(net) {
    this.nodes = Object.fromEntries(net.nodes.map((n) => [n.id, n]));
    this.edges = Object.fromEntries(net.edges.map((e) => [e.id, e]));
    this.adj = {};
    const modesAt = {};
    for (const e of net.edges) {
      for (const [a, b] of [[e.source, e.target], [e.target, e.source]]) {
        (this.adj[key(a, e.mode)] ||= []).push({ kind: "edge", id: e.id, to: key(b, e.mode), node: b, mode: e.mode });
        (modesAt[a] ||= new Set()).add(e.mode);
      }
    }
    for (const [n, ms] of Object.entries(modesAt)) for (const a of ms) for (const b of ms)
      if (a !== b && TRANSFER_H[`${a}>${b}`] != null) (this.adj[key(n, a)] ||= []).push({ kind: "transfer", to: key(n, b), node: n, mode: b });
    this.detourExtra = this._detours(net);
  }
  _detours(net) {
    const adj = {};
    for (const e of net.edges) if (e.mode === "road") {
      (adj[e.source] ||= []).push([e.target, e.base_time_h, e.id]); (adj[e.target] ||= []).push([e.source, e.base_time_h, e.id]);
    }
    const sp = (s, t, skip) => {
      const dist = { [s]: 0 }; const h = new Heap(); h.push([0, s]); const done = new Set();
      while (h.size) { const [d, u] = h.pop(); if (done.has(u)) continue; done.add(u); if (u === t) return d;
        for (const [v, w, id] of adj[u] || []) { if (id === skip) continue; const nd = d + w; if (nd < (dist[v] ?? Infinity)) { dist[v] = nd; h.push([nd, v]); } } }
      return Infinity;
    };
    const out = {};
    for (const e of net.edges) out[e.id] = e.mode !== "road" ? Infinity : (() => { const a = sp(e.source, e.target, e.id); return a === Infinity ? Infinity : r2(a - e.base_time_h); })();
    return out;
  }
  effectiveDelay(id, wait) { return r2(Math.min(wait, (this.detourExtra[id] ?? Infinity) + 0.5)); }

  search(origin, dest, scores, wfe, profile = "balanced", cargo = "general", modes = ["road", "rail", "ferry"],
    { exclude = new Set(), knowledge = "model", startH = 0, penalty = null } = {}) {
    const prof = PROFILES[profile], cg = CARGO[cargo];
    const k = prof.use_k ? cg.k : 0; const { alpha, gamma, avoid_p } = prof;
    const ms = new Set(modes); if (!cg.ferry_ok) ms.delete("ferry");
    const start = key(origin, "road"), goal = key(dest, "road");
    const dist = { [start]: 0 }, timeAt = { [start]: startH }, prev = {};
    const heap = new Heap(); heap.push([0, start]); const done = new Set();
    while (heap.size) {
      const [cost, s] = heap.pop();
      if (done.has(s)) continue; done.add(s);
      if (s === goal) break;
      const tau = timeAt[s]; const sMode = s.split("|")[1]; const sNode = s.split("|")[0];
      for (const a of this.adj[s] || []) {
        if (done.has(a.to) || !ms.has(a.mode)) continue;
        let leg, step;
        if (a.kind === "transfer") {
          const t = TRANSFER_H[`${sMode}>${a.mode}`];
          step = t * (1 + k);
          leg = { kind: "transfer", edge_id: null, frm: sNode, to: sNode, mode: `${sMode}→${a.mode}`, t, p: 0, c: 0, enter_h: tau };
        } else {
          if (exclude.has(a.id)) continue;
          const e = this.edges[a.id];
          let t, p, c;
          if (knowledge === "naive") { t = e.base_time_h; p = 0; c = 0; }
          else {
            const sc = scores[a.id];
            if (sc.status === "blocked") continue;
            t = travelTime(e, wfe(e)); p = interpP(sc.p, tau); c = this.effectiveDelay(a.id, sc.delay_if_blocked_h);
            if (avoid_p != null && p >= avoid_p) continue;
          }
          const d = p * c, sigma = c * Math.sqrt(Math.max(p * (1 - p), 0));
          step = (t + alpha * d) * (1 + k) + gamma * sigma;
          if (penalty && penalty[a.id]) step *= penalty[a.id];   // used to find distinct alternative routes
          leg = { kind: "edge", edge_id: a.id, frm: sNode, to: a.node, mode: e.mode, t, p, c, enter_h: tau };
        }
        const nc = cost + step;
        if (nc < (dist[a.to] ?? Infinity)) {
          dist[a.to] = nc; timeAt[a.to] = tau + leg.t + leg.p * leg.c; prev[a.to] = [s, leg]; heap.push([nc, a.to]);
        }
      }
    }
    if (!(goal in prev) && origin !== dest) return null;
    const legs = []; let s = goal;
    while (prev[s]) { const [p, leg] = prev[s]; legs.push(leg); s = p; }
    return legs.reverse();
  }

  evaluate(legs, profile, cargo, deadline = null, nMc = 600, seed = 11) {
    const prof = PROFILES[profile], cg = CARGO[cargo];
    const k = prof.use_k ? cg.k : 0;
    const E = legs.filter((l) => l.kind === "edge");
    const travel = legs.reduce((s, l) => s + l.t, 0);
    const expDelay = E.reduce((s, l) => s + l.p * l.c, 0);
    const riskPen = prof.alpha * expDelay, periPen = k * (travel + riskPen);
    const relPen = prof.gamma * E.reduce((s, l) => s + l.c * Math.sqrt(Math.max(l.p * (1 - l.p), 0)), 0);
    const rng = mulberry32(seed); const totals = [];
    for (let i = 0; i < nMc; i++) {
      let tot = travel;
      for (const l of E) { const hit = rng() < l.p; const sev = 0.5 + rng(); if (hit) tot += sev * l.c; }
      totals.push(tot);
    }
    const pAny = E.length ? 1 - E.reduce((s, l) => s * (1 - l.p), 1) : 0;
    const out = {
      distance_km: r2(E.reduce((s, l) => s + this.edges[l.edge_id].length_km, 0), 1), travel_time_h: r2(travel),
      expected_delay_h: r2(expDelay), eta_expected_h: r2(travel + expDelay), eta_p50_h: r2(percentile(totals, 50)),
      eta_p90_h: r2(percentile(totals, 90)), risk_score: r2(pAny, 3), max_edge_p: r2(Math.max(0, ...E.map((l) => l.p)), 3),
      cost_breakdown: { travel_time: r2(travel), risk_penalty: r2(riskPen), perishability_penalty: r2(periPen), reliability_penalty: r2(relPen) },
      total_cost: r2(travel + riskPen + periPen + relPen), modes: [...new Set(E.map((l) => l.mode))].sort(),
      transfers: legs.filter((l) => l.kind === "transfer").length,
    };
    if (deadline) out.p_late = r2(totals.filter((t) => t > deadline).length / nMc, 3);
    if (cg.max_transit_h) { out.p_cold_chain_breach = r2(totals.filter((t) => t > cg.max_transit_h).length / nMc, 3); out.max_transit_h = cg.max_transit_h; }
    return out;
  }
  edgeCoords(id, frm) { const e = this.edges[id]; return frm === e.source ? e.geometry : [...e.geometry].reverse(); }
  legsJson(legs) {
    return legs.map((l) => {
      if (l.kind === "transfer") return { kind: "transfer", at: l.frm, at_name: this.nodes[l.frm].name, mode: l.mode, t_h: r2(l.t), enter_h: r2(l.enter_h) };
      const e = this.edges[l.edge_id]; const dx = this.detourExtra[l.edge_id];
      return { kind: "edge", edge_id: l.edge_id, frm: l.frm, to: l.to, frm_name: this.nodes[l.frm].name, to_name: this.nodes[l.to].name,
        mode: l.mode, route_ref: e.route_ref, length_km: e.length_km, t_h: r2(l.t), p: r2(l.p, 3), delay_if_blocked_h: l.c,
        detour_extra_h: dx === Infinity ? null : dx, enter_h: r2(l.enter_h), no_network: e.no_network, coords: this.edgeCoords(l.edge_id, l.frm) };
    });
  }
  geometry(legs) {
    const c = [];
    for (const l of legs) { if (l.kind !== "edge") continue; const g = this.edgeCoords(l.edge_id, l.frm); c.push(...(c.length ? g.slice(1) : g)); }
    return c;
  }
}
function recommend(results, priority, cargo) {
  if (priority === "critical" && results.emergency) return ["emergency", "Critical priority: minimise expected arrival across all modes."];
  let best = null, bestS = Infinity;
  const w = cargo === "pharma" || cargo === "perishable" ? 0.8 : 0;
  for (const [name, r] of Object.entries(results)) {
    const m = r.metrics;
    const s = m.eta_expected_h + w * Math.max(m.eta_p90_h - m.eta_expected_h, 0) + 12 * (m.p_late || 0) + 12 * (m.p_cold_chain_breach || 0);
    if (s < bestS) { best = name; bestS = s; }
  }
  return [best, {
    fastest: "Hazard is low on the fast route; no penalty for taking it.",
    balanced: "Lowest expected arrival once blockage risk is priced in.",
    safest: "Risk on faster routes outweighs the extra distance.",
    emergency: "Lowest expected arrival time once blockage risk is priced in.",
  }[best]];
}

// ============================================================================ engine (backend/engine.py)
const BLOCKING = new Set(["landslide", "washout", "flood", "accident"]);
const HAZARD_TYPES = new Set([...BLOCKING, "debris", "clear"]);
const WINDOW_H = 6;

// Four route options that differ whenever the network allows it (backend/routing.py: alternatives).
// Each profile gets its own optimum; extra candidates come from the penalty method (edges already used get
// more expensive each round) minus those that mostly overlap one already found. A profile whose optimum is
// already shown takes the best remaining candidate by its own measure if its expected arrival is within
// ALT_TOLERANCE of the quickest option, and says so in `note`.
const PROFILE_ORDER = ["fastest", "safest", "balanced", "emergency"];
const ALT_TOLERANCE = { safest: 1.5, balanced: 1.35, emergency: 1.2 };
const signature = (legs) => legs.map((l) => l.edge_id || l.mode).join(",");
function alternatives(router, origin, dest, scores, wfe, cargo, modes, deadline = null, maxCands = 6, rounds = 12) {
  const own = {};
  for (const prof of PROFILE_ORDER) { const legs = router.search(origin, dest, scores, wfe, prof, cargo, modes); if (legs) own[prof] = legs; }
  if (!Object.keys(own).length) return {};
  const kmOf = (legs) => { const o = {}; for (const l of legs) if (l.kind === "edge") o[l.edge_id] = router.edges[l.edge_id].length_km; return o; };
  const mostlySame = (legs, others, limit = 0.8) => {
    const a = kmOf(legs); const tot = Object.values(a).reduce((x, y) => x + y, 0) || 1;
    return others.some((o) => { const b = kmOf(o); return Object.entries(a).reduce((x, [k, v]) => x + (k in b ? v : 0), 0) / tot >= limit; });
  };
  const cands = [], sigs = new Set();
  for (const legs of Object.values(own)) if (!sigs.has(signature(legs))) { sigs.add(signature(legs)); cands.push(legs); }
  const extra = [], penalty = {};
  for (let i = 0; i < rounds && cands.length + extra.length < maxCands; i++) {
    for (const legs of [...cands, ...extra]) for (const l of legs) if (l.kind === "edge") penalty[l.edge_id] = (penalty[l.edge_id] || 1) + 0.4;
    const legs = router.search(origin, dest, scores, wfe, "balanced", cargo, modes, { penalty });
    if (!legs) break;
    if (!sigs.has(signature(legs))) { sigs.add(signature(legs)); if (!mostlySame(legs, [...cands, ...extra])) extra.push(legs); }
  }
  const memo = {};
  const mOf = (prof, legs) => { const k = prof + "|" + signature(legs); return (memo[k] ||= router.evaluate(legs, prof, cargo, deadline, 300)); };
  const score = (prof, legs) => {
    const m = mOf(prof, legs);
    if (prof === "fastest") return m.travel_time_h;
    if (prof === "safest") return m.risk_score * 1e5 + m.eta_p90_h;
    if (prof === "balanced") return m.eta_expected_h + 0.3 * Math.max(m.eta_p90_h - m.eta_expected_h, 0);
    return m.eta_expected_h;
  };
  const all = [...cands, ...extra];
  const bestEta = Math.min(...all.map((c) => mOf("balanced", c).eta_expected_h));
  const chosen = {}, used = {};
  for (const prof of PROFILE_ORDER) {
    if (!own[prof]) continue;
    const sig = signature(own[prof]);
    if (!(sig in used)) { chosen[prof] = [own[prof], null]; used[sig] = prof; continue; }
    const tol = (ALT_TOLERANCE[prof] || 1) * bestEta;
    const shown = Object.values(chosen).map(([l]) => l);
    const rest = all.filter((c) => !(signature(c) in used) && mOf(prof, c).eta_expected_h <= tol && !mostlySame(c, shown));
    if (rest.length) {
      let best = rest[0], bs = score(prof, best);
      for (const c of rest.slice(1)) { const v = score(prof, c); if (v < bs) { best = c; bs = v; } }
      chosen[prof] = [best, `The ${PROFILES[prof].label.toLowerCase()} path is the same as the ${PROFILES[used[sig]].label} route; this is the best different route by the same measure.`];
      used[signature(best)] = prof;
    } else chosen[prof] = [own[prof], null];
  }
  return chosen;
}

// Field reports seeded with the demo (backend/engine.py: DEMO_REPORTS):
// [hours ago, uploading phone, reporting phone, type, severity, edge, note]; a different reporting phone = relayed by the convoy mesh
const DEMO_REPORTS = [
  [4.5, "TRK-NL02", "TRK-NL02", "landslide", "high", "MBG-HRJ", "Slide across both lanes near Jatinga; JCB on site"],
  [3.8, "TRK-AS01", "DRV-AS33", "landslide", "high", "MBG-HRJ", "Same slip near Jatinga, traffic stopped on both sides"],
  [2.6, "TRK-WB11", "TRK-WB11", "debris", "medium", "SVK-TBZ", "Debris on one lane at Chitrey, single-lane traffic"],
  [1.9, "TRK-WB07", "TRK-WB07", "landslide", "medium", "SVK-TBZ", "Fresh slip past 29th Mile, BRO clearing"],
  [1.2, "TRK-AS12", "TRK-AS12", "debris", "low", "KHL-SNP", "Loose rocks on NH6 after overnight rain"],
  [0.8, "TRK-AS01", "TRK-AS01", "flood", "medium", "KLB-KZR", "Water over the road near Kaziranga, slow crossing"],
  [0.5, "TRK-MZ05", "TRK-MZ05", "debris", "low", "KLS-AZL", "Small rockfall pushed to one side near Kolasib"],
  [0.3, "TRK-AR09", "TRK-AR09", "clear", "low", "NGB-NNY", "Road clear, normal traffic"],
];
const DEMO_QUEUED = {};   // reports still queued on a phone with no signal (none in the demo)

class Engine {
  constructor(network, model, metrics) {
    this.network = network;
    this.nodes = Object.fromEntries(network.nodes.map((n) => [n.id, n]));
    this.edges = Object.fromEntries(network.edges.map((e) => [e.id, e]));
    this.weather = new Weather(network.met_zones);
    this.model = new HazardModel(model, metrics);
    this.router = new Router(network);
    this.status = {}; this.statusReason = {};
    this.hazards = new Map(); this.shipmentsM = new Map(); this.vehiclesM = new Map(); this.routes = new Map();
    this.events = []; this.eventIds = new Set(); this.deviceStats = new Map(); this.audits = [];
    this._scores = null;
    const road = new Set(); network.edges.filter((e) => e.mode === "road").forEach((e) => { road.add(e.source); road.add(e.target); });
    this.roadNodes = [...road].sort();
  }
  audit(actor, action, detail) { this.audits.push({ id: this.audits.length + 1, ts: now(), actor, action, detail }); }
  invalidate() { this._scores = null; }
  wfe = (e) => this.weather.forEdge(e.met_zones);

  reports6h() {
    const since = now() - WINDOW_H * 3600; const per = {}, verified = {};
    for (const r of this.hazards.values()) {
      if (r.time_start < since || !r.edge_id || r.type === "clear") continue;
      let w = r.type === "debris" ? 0.5 : 1;
      if (r.verified) { w *= 2; verified[r.edge_id] = (verified[r.edge_id] || 0) + 1; }
      const d = (per[r.edge_id] ||= {}); d[r.device_id] = Math.max(d[r.device_id] || 0, w);
    }
    return [Object.fromEntries(Object.entries(per).map(([k, v]) => [k, Object.values(v).reduce((a, b) => a + b, 0)])), verified];
  }
  scores() {
    if (!this._scores) this._scores = this.model.scoreAll(this.network.edges, this.weather, this.reports6h()[0], this.status);
    return this._scores;
  }
  riskEdges() {
    return Object.entries(this.scores()).map(([id, s]) => ({ edge_id: id, p_now: r2(s.p_now, 4), p_max24: r2(s.p_max24, 4),
      p: Object.fromEntries(Object.entries(s.p).map(([h, v]) => [h, r2(v, 4)])), level: s.level, status: s.status,
      delay_if_blocked_h: s.delay_if_blocked_h, reports_6h: s.reports_6h }));
  }
  edgePublic(e) {
    const o = {}; for (const k of ["id", "source", "target", "mode", "route_ref", "road_class", "terrain", "length_km", "base_time_h",
      "slope_deg", "elevation_m", "landslide_hist", "river", "no_network", "note"]) o[k] = e[k];
    return { ...o, source_name: this.nodes[e.source].name, target_name: this.nodes[e.target].name };
  }
  edgeRisk(id) {
    const e = this.edges[id]; const sc = this.scores()[id]; const [rep, ver] = this.reports6h();
    const fresh = this.weather.freshness(); const base = this.wfe(e);
    const forecast = HORIZONS.map((h) => ({ h, p: r2(sc.p[h], 4), level: level(sc.p[h]), rain_24h: r2(shiftRain(base, h).rain_24h, 1) }));
    const incidents = [...this.hazards.values()].filter((x) => x.edge_id === id).sort((a, b) => b.time_start - a.time_start).slice(0, 10)
      .map(({ event_id, type, severity, device_id, verified, note, time_start, via }) => ({ event_id, type, severity, device_id, verified, note, time_start, via }));
    return { edge: this.edgePublic(e), status: sc.status, p_now: r2(sc.p_now, 4), level: sc.level, delay_if_blocked_h: sc.delay_if_blocked_h,
      forecast, explanation: this.model.explain(e, base, rep[id] || 0, this.weather.month, fresh.score, sc.status, ver[id] || 0),
      rain: base, data_freshness: fresh, incidents, model_version: this.model.version };
  }

  optimize({ origin, destination, cargo_type = "general", priority = "normal", deadline_h = null, modes = ["road", "rail", "ferry"], shipment_id = null }) {
    const t0 = performance.now();
    if (!this.nodes[origin] || !this.nodes[destination]) throw new HttpError(400, "unknown origin/destination");
    if (!CARGO[cargo_type]) throw new HttpError(400, "unknown cargo type");
    const sc = this.scores(); const results = {};
    for (const [prof, [legs, note]] of Object.entries(alternatives(this.router, origin, destination, sc, this.wfe, cargo_type, modes, deadline_h))) {
      results[prof] = { profile: prof, label: PROFILES[prof].label, description: PROFILES[prof].description, note,
        metrics: this.router.evaluate(legs, prof, cargo_type, deadline_h), legs: this.router.legsJson(legs), geometry: this.router.geometry(legs), _legs: legs };
    }
    if (!Object.keys(results).length) throw new HttpError(404, "No open route between these points with the selected modes.");
    const [rec, reason] = recommend(results, priority, cargo_type);
    const sigs = {};
    for (const [name, r] of Object.entries(results)) { const sig = r.legs.map((l) => l.edge_id || l.mode).join(","); r.same_as = sigs[sig] || null; sigs[sig] ||= name; }
    const fresh = this.weather.freshness(); const [rep, ver] = this.reports6h();
    const alerts = []; const seen = new Set();
    for (const r of Object.values(results)) for (const l of r._legs) {
      if (l.kind !== "edge" || seen.has(l.edge_id)) continue;
      const s = sc[l.edge_id];
      if (l.p >= 0.15 || s.status === "blocked") {
        seen.add(l.edge_id); const e = this.edges[l.edge_id];
        const ex = this.model.explain(e, this.wfe(e), rep[l.edge_id] || 0, this.weather.month, fresh.score, s.status, ver[l.edge_id] || 0);
        alerts.push({ edge_id: l.edge_id, name: `${this.nodes[e.source].name} – ${this.nodes[e.target].name} (${e.route_ref})`,
          p_at_arrival: r2(l.p, 3), enter_h: r2(l.enter_h, 1), level: level(l.p), headline: ex.headline, reasons: ex.reasons, confidence: ex.confidence,
          on_profiles: Object.entries(results).filter(([, rr]) => rr._legs.some((x) => x.edge_id === l.edge_id)).map(([n]) => n),
          delay_if_blocked_h: l.c, note: e.note });
      }
    }
    alerts.sort((a, b) => b.p_at_arrival - a.p_at_arrival);
    let comparison = null;
    if (results.fastest && rec !== "fastest") {
      const fE = new Set(results.fastest._legs.filter((l) => l.kind === "edge").map((l) => l.edge_id));
      const rE = new Set(results[rec]._legs.filter((l) => l.kind === "edge").map((l) => l.edge_id));
      const fm = results.fastest.metrics, rm = results[rec].metrics;
      comparison = { vs: "fastest", avoided: alerts.filter((a) => fE.has(a.edge_id) && !rE.has(a.edge_id)).slice(0, 3).map((a) => a.name),
        extra_travel_h: r2(rm.travel_time_h - fm.travel_time_h), delay_saved_h: r2(fm.expected_delay_h - rm.expected_delay_h),
        p90_saved_h: r2(fm.eta_p90_h - rm.eta_p90_h) };
    }
    const request_id = "Q-" + hex(8);
    for (const [name, r] of Object.entries(results)) {
      r.route_id = "R-" + hex(8);
      this.routes.set(r.route_id, { route_id: r.route_id, shipment_id, profile: name, recommended_profile: rec, edges: r.legs,
        cost_breakdown: r.metrics.cost_breakdown, risk_score: r.metrics.risk_score, eta: r.metrics.eta_expected_h, eta_p90: r.metrics.eta_p90_h,
        model_version: this.model.version, data_freshness: fresh, decision: "proposed", created_at: now(), decided_at: null,
        payload: { request_id, origin, destination, cargo_type, priority, deadline_h, geometry: r.geometry, metrics: r.metrics } });
      delete r._legs;
    }
    return { request_id, origin, destination, cargo_type, cargo: CARGO[cargo_type], priority, deadline_h, recommended: rec,
      recommendation_reason: reason, routes: results, alerts, comparison, data_freshness: fresh, model_version: this.model.version,
      latency_ms: r2(performance.now() - t0, 1), human_in_the_loop: "Recommendation only. A dispatcher must approve before a vehicle is sent." };
  }

  approve(routeId, { actor = "dispatcher", vehicle_id = null, override_reason = null, shipment_id = null } = {}) {
    const r = this.routes.get(routeId); if (!r) throw new HttpError(404, "route not found");
    if (r.profile !== r.recommended_profile && !override_reason) throw new HttpError(400, "Choosing a non-recommended route needs an override reason (logged for audit).");
    const t = now(); const p = r.payload;
    for (const s of this.routes.values()) if (s.decision === "proposed" && s.payload.request_id === p.request_id && s.route_id !== routeId) { s.decision = "rejected"; s.decided_at = t; }
    shipment_id = shipment_id || r.shipment_id || this.createShipment(p).shipment_id;
    vehicle_id = vehicle_id || "TRK-" + hex(4);
    Object.assign(r, { decision: "approved", decided_by: actor, override_reason, decided_at: t, shipment_id });
    Object.assign(this.shipmentsM.get(shipment_id), { status: "in_transit", route_id: routeId, vehicle_id });
    const o = this.nodes[p.origin];
    this.vehiclesM.set(vehicle_id, { vehicle_id, lat: o.lat, lon: o.lon, speed: 0, load: p.cargo_type, offline_flag: 0, last_sync: t, last_seen: t,
      shipment_id, edge_id: null, pinged: 0 });
    this.fleet?.attach(vehicle_id, routeId, "sim", actor === "seed", actor === "seed" ? Math.random() * 0.8 : 0);
    this.audit(actor, "route.approve", { route_id: routeId, profile: r.profile, recommended: r.recommended_profile, override_reason, shipment_id, vehicle_id,
      model_version: r.model_version, data_freshness: r.data_freshness });
    this.appendEvent("assignment", { vehicle_id, shipment_id, route_id: routeId, profile: r.profile, legs: r.edges, geometry: p.geometry,
      origin: p.origin, destination: p.destination, cargo_type: p.cargo_type, created_at: t });
    return { route_id: routeId, shipment_id, vehicle_id, decision: "approved" };
  }
  createShipment({ origin, destination, cargo_type = "general", priority = "normal", deadline_h = null, weight_t = 8 }) {
    const id = "SHP-" + hex(6); const t = now();
    this.shipmentsM.set(id, { shipment_id: id, priority, origin, destination, cargo_type, temp_range: CARGO[cargo_type].temp_range,
      deadline: deadline_h ? t + deadline_h * 3600 : null, weight_t, status: "planning", route_id: null, vehicle_id: null, created_at: t });
    return { shipment_id: id };
  }
  shipments() {
    const sc = this.scores();
    return [...this.shipmentsM.values()].sort((a, b) => b.created_at - a.created_at).map((s) => {
      const item = { ...s, origin_name: this.nodes[s.origin].name, destination_name: this.nodes[s.destination].name, cargo_label: CARGO[s.cargo_type].label };
      if (!s.route_id) return item;
      const r = this.routes.get(s.route_id);
      const tracked = s.vehicle_id ? this.fleet?.completedH(s.vehicle_id) : null;
      const elapsed = tracked ?? (now() - (r.decided_at || r.created_at)) / 3600;
      let remaining = 0, expDelay = 0, worst = null, hold = null, clock = 0;
      for (const l of r.edges) {
        clock += l.t_h; if (clock <= elapsed) continue;
        remaining += Math.min(l.t_h, clock - elapsed);
        if (l.kind === "edge") {
          const st = sc[l.edge_id]; const p = st.status === "blocked" ? 1 : interpP(st.p, Math.max(clock - elapsed, 0));
          expDelay += p * st.delay_if_blocked_h;
          if (!worst || p > worst.p) worst = { edge_id: l.edge_id, p: r2(p, 3), name: `${l.frm_name} – ${l.to_name}` };
          if (p >= 0.35 && !hold) hold = l.frm;
        }
      }
      const eta = remaining + expDelay;
      Object.assign(item, { route_profile: r.profile, progress: r2(Math.min(elapsed / Math.max(clock, 0.01), 1), 3), eta_remaining_h: r2(eta, 1),
        expected_delay_h: r2(expDelay, 1), worst_edge: worst, risk_level: worst ? level(worst.p) : "low" });
      if (s.deadline) item.slack_h = r2((s.deadline - now()) / 3600 - eta, 1);
      const mt = CARGO[s.cargo_type].max_transit_h; if (mt) item.cold_chain_margin_h = r2(mt - (elapsed + eta), 1);
      if (hold) item.handover_suggestion = { node: hold, name: this.nodes[hold].name,
        reason: `Hold or hand over at ${this.nodes[hold].name} before ${worst.name} (p=${Math.round(worst.p * 100)}%); cold storage / reroute from there.` };
      return item;
    });
  }

  // ---------------------------------------------------------------- incidents & sync
  snap(lat, lon, maxKm = 20) {
    let best = null, bd = Infinity; const k = Math.cos(lat * Math.PI / 180); const px = lon * k;
    for (const e of this.network.edges) {
      if (e.mode !== "road") continue;
      const g = e.geometry;
      for (let i = 0; i < g.length - 1; i++) {
        const ax = g[i][0] * k, ay = g[i][1], bx = g[i + 1][0] * k, by = g[i + 1][1], dx = bx - ax, dy = by - ay;
        const t = Math.max(0, Math.min(1, ((px - ax) * dx + (lat - ay) * dy) / (dx * dx + dy * dy || 1)));
        const d = Math.hypot(px - (ax + t * dx), lat - (ay + t * dy)) * 111;
        if (d < bd) { best = e.id; bd = d; }
      }
    }
    return bd <= maxKm ? best : null;
  }
  appendEvent(kind, payload, device_id = null, event_id = null) {
    event_id ||= uuid(); if (this.eventIds.has(event_id)) return null;
    this.eventIds.add(event_id);
    const seq = this.events.length + 1;
    this.events.push({ seq, event_id, kind, device_id, payload, created_at: payload.created_at || now(), received_at: now() });
    return seq;
  }
  ingest(ev, via = "direct") {
    if (!HAZARD_TYPES.has(ev.type)) throw new HttpError(400, `type must be one of ${[...HAZARD_TYPES].sort()}`);
    ev = { ...ev }; ev.event_id ||= uuid(); ev.created_at ||= now();
    if (!ev.edge_id && ev.lat != null) ev.edge_id = this.snap(ev.lat, ev.lon);
    if (ev.edge_id && !this.edges[ev.edge_id]) throw new HttpError(400, "unknown edge_id");
    ev.via = via;
    const isNew = !this.hazards.has(ev.event_id);
    let change = null;
    if (isNew) {
      this.hazards.set(ev.event_id, { event_id: ev.event_id, type: ev.type, severity: ev.severity || "medium", lat: ev.lat, lon: ev.lon,
        edge_id: ev.edge_id || null, time_start: ev.created_at, source: ev.source || "driver", device_id: ev.device_id, verified: ev.verified ? 1 : 0,
        note: ev.note || "", received_at: now(), via, hops: ev.hops || 0 });
      this.appendEvent("incident", ev, ev.device_id, ev.event_id);
      if (ev.edge_id) change = this.autoVerify(ev.edge_id);
      this.invalidate(); this.alertVehicles(ev.edge_id);
    }
    return { event_id: ev.event_id, new: isNew, edge_id: ev.edge_id || null, status_change: change };
  }
  autoVerify(id) {
    const since = now() - WINDOW_H * 3600;
    const rows = [...this.hazards.values()].filter((r) => r.edge_id === id && r.time_start >= since);
    const cur = this.status[id] || "open";
    const blockDevs = new Set(rows.filter((r) => BLOCKING.has(r.type)).map((r) => r.device_id));
    const last = Math.max(0, ...rows.filter((r) => BLOCKING.has(r.type)).map((r) => r.time_start));
    const clearDevs = new Set(rows.filter((r) => r.type === "clear" && r.time_start >= last).map((r) => r.device_id));
    if (cur !== "blocked" && blockDevs.size >= 2) {
      const reason = `${blockDevs.size} independent driver reports within ${WINDOW_H} h`;
      this.setStatus(id, "blocked", reason, "auto-verify");
      rows.filter((r) => BLOCKING.has(r.type)).forEach((r) => (r.verified = 1));
      return { status: "blocked", reason };
    }
    if (cur === "blocked" && clearDevs.size >= 2) {
      const reason = `${clearDevs.size} drivers report the road clear`;
      this.setStatus(id, "open", reason, "auto-verify"); return { status: "open", reason };
    }
    return null;
  }
  setStatus(id, status, reason, actor) {
    this.status[id] = status; this.statusReason[id] = reason;
    this.audit(actor, "edge.status", { edge_id: id, status, reason });
    this.appendEvent("edge_status", { edge_id: id, status, reason, created_at: now() });
    this.invalidate();
  }
  override(id, { status, reason, actor = "dispatcher" }) {
    if (!this.edges[id]) throw new HttpError(404, "unknown edge");
    if (!["open", "blocked"].includes(status)) throw new HttpError(400, "status must be open or blocked");
    if (!reason) throw new HttpError(400, "a reason is required for a manual override");
    this.setStatus(id, status, reason, actor); this.alertVehicles(id);
    return { edge_id: id, status };
  }
  alertVehicles(id) {
    if (!id) return; const sc = this.scores()[id];
    if (sc.status !== "blocked" && sc.p_now < 0.35) return;
    for (const r of this.routes.values()) {
      if (r.decision !== "approved" || !r.edges.some((l) => l.edge_id === id)) continue;
      const sh = this.shipmentsM.get(r.shipment_id); if (!sh?.vehicle_id) continue;
      const e = this.edges[id];
      this.appendEvent("alert", { vehicle_id: sh.vehicle_id, route_id: r.route_id, edge_id: id, p: r2(sc.p_now, 3), created_at: now(),
        message: `${sc.status === "blocked" ? "BLOCKED" : "High risk"} ahead: ${this.nodes[e.source].name} – ${this.nodes[e.target].name} (${e.route_ref}). Await dispatcher reroute.` });
    }
  }
  sync({ device_id, cursor = 0, events = [], stats = null }) {
    const accepted = []; let dup = 0, newInc = 0, mesh = 0;
    for (const ev of events) {
      if (!ev.event_id) continue;
      const origin = ev.origin_device || device_id; const via = origin !== device_id ? "mesh" : "direct";
      if (ev.kind === "incident") {
        try {
          const res = this.ingest({ ...(ev.payload || {}), event_id: ev.event_id, device_id: origin, created_at: ev.created_at || now(), hops: ev.hops || 0 }, via);
          if (res.new) { newInc++; if (via === "mesh") mesh++; } else dup++;
        } catch { continue; }
      } else if (ev.kind === "ping") this.ping(origin, ev.payload || {}, ev.created_at || now(), !!ev.queued);
      accepted.push(ev.event_id);
    }
    if (stats && stats.created_total != null) {
      const received = [...this.hazards.values()].filter((h) => h.device_id === device_id).length;
      const prev = this.deviceStats.get(device_id);
      this.deviceStats.set(device_id, { device_id, created_total: +stats.created_total, received_total: received, via_mesh: (prev?.via_mesh || 0) + mesh, last_sync: now() });
    }
    const v = this.vehiclesM.get(device_id); if (v) { v.last_sync = now(); v.offline_flag = 0; }
    return { accepted, duplicates: dup, new_incidents: newInc, events: this.events.filter((e) => e.seq > cursor).slice(0, 500), cursor: this.events.length };
  }
  ping(id, p, ts, offline) { if (p.lat != null) this.fleet?.ingest(id, p.lat, p.lon, p.speed, null, ts, "app", offline); }
  vehicles() { return this.fleet ? this.fleet.snapshot() : []; }
  syncStats() {
    const rows = [...this.deviceStats.values()];
    const created = rows.reduce((s, r) => s + (r.created_total || 0), 0);
    const received = rows.reduce((s, r) => s + Math.min(r.received_total || 0, r.created_total || 0), 0);
    const drivers = [...this.hazards.values()].filter((h) => h.source === "driver");
    return { devices: rows.length, created, received, sync_rate: created ? r2(received / created, 3) : null,
      via_mesh: [...this.hazards.values()].filter((h) => h.via === "mesh").length, driver_reports: drivers.length,
      mean_sync_lag_min: r2(mean(drivers.map((h) => h.received_at - h.time_start)) / 60, 1) };
  }
  corridors() {
    const sc = this.scores();
    const order = { blocked: 0, high: 1, medium: 2, elevated: 3, low: 4 };
    const out = this.network.corridors.map((c) => {
      const eds = c.edges.map((e) => sc[e]); const blocked = c.edges.filter((e) => sc[e].status === "blocked");
      const pAny = 1 - eds.reduce((s, x) => s * (1 - x.p_now), 1), pAny24 = 1 - eds.reduce((s, x) => s * (1 - x.p_max24), 1);
      const worst = c.edges.reduce((a, b) => (sc[b].p_now > sc[a].p_now ? b : a));
      const w = this.edges[worst];
      return { id: c.id, name: c.name, edges: c.edges, nodes: c.nodes, health: blocked.length ? "blocked" : level(pAny),
        p_disruption_now: r2(pAny, 3), p_disruption_24h: r2(pAny24, 3), blocked_edges: blocked,
        base_time_h: r2(c.edges.reduce((s, e) => s + this.edges[e].base_time_h, 0), 1),
        expected_delay_h: r2(eds.reduce((s, x) => s + x.p_now * x.delay_if_blocked_h, 0), 1),
        eta_std_h: r2(Math.sqrt(eds.reduce((s, x) => s + x.delay_if_blocked_h ** 2 * x.p_now * (1 - x.p_now), 0)), 1),
        worst_edge: { edge_id: worst, p: r2(sc[worst].p_now, 3), name: `${this.nodes[w.source].name} – ${this.nodes[w.target].name}` } };
    }).sort((a, b) => order[a.health] - order[b.health] || b.p_disruption_now - a.p_disruption_now);
    const feed = this.events.filter((e) => ["incident", "edge_status", "alert"].includes(e.kind)).slice(-30).reverse().map((e) => ({
      seq: e.seq, kind: e.kind, at: e.received_at, edge_id: e.payload.edge_id, type: e.payload.type, status: e.payload.status,
      reason: e.payload.reason, message: e.payload.message, device_id: e.payload.device_id, via: e.payload.via, note: e.payload.note }));
    const vals = Object.values(sc);
    return { corridors: out, feed, data_freshness: this.weather.freshness(), model_version: this.model.version, sync: this.syncStats(),
      counts: { blocked: vals.filter((s) => s.status === "blocked").length, high: vals.filter((s) => s.level === "high").length,
        medium: vals.filter((s) => s.level === "medium").length } };
  }
  seedDemo() {
    for (const [o, d, cargo, prio, dl, veh] of [["GHY", "IMP", "pharma", "high", 30, "TRK-AS01"], ["SLG", "GTK", "perishable", "normal", 12, "TRK-WB07"],
      ["GHY", "SCR", "relief", "critical", 20, "TRK-AS12"], ["GHY", "AGT", "general", "normal", 36, "TRK-TR03"],
      ["SLG", "GTK", "general", "normal", null, "TRK-WB11"], ["DMR", "IMP", "relief", "high", 24, "TRK-NL02"],
      ["SCR", "AZL", "perishable", "normal", 20, "TRK-MZ05"], ["GHY", "TWG", "fuel", "normal", null, "TRK-AR09"]]) {
      const sid = this.createShipment({ origin: o, destination: d, cargo_type: cargo, priority: prio, deadline_h: dl }).shipment_id;
      const res = this.optimize({ origin: o, destination: d, cargo_type: cargo, priority: prio, deadline_h: dl, shipment_id: sid });
      this.approve(res.routes[res.recommended].route_id, { actor: "seed", vehicle_id: veh, shipment_id: sid });
    }
    this.seedReports();
    this.audit("system", "seed.demo", { shipments: 8, reports: DEMO_REPORTS.length });
  }
  // replay DEMO_REPORTS in time order, as if the phones had synced them when they were made
  seedReports() {
    const own = {};
    for (const [, up, dev] of DEMO_REPORTS) own[up] = (own[up] || 0) + (dev === up ? 1 : 0);
    for (const [ago, up, dev, type, severity, edge_id, note] of DEMO_REPORTS) {
      const g = this.edges[edge_id].geometry; const [lon, lat] = g[Math.floor(g.length / 2)];
      const made = now() - ago * 3600, got = made + (dev !== up ? 25 : ago < 4 ? 3 : 40) * 60;
      const last = this.events.length; const event_id = uuid();
      this.sync({ device_id: up, cursor: 0, stats: { created_total: own[up] + (DEMO_QUEUED[up] || 0) },
        events: [{ kind: "incident", event_id, origin_device: dev, created_at: made, hops: dev === up ? 0 : 1,
          payload: { type, severity, edge_id, lat, lon, note, source: "driver" } }] });
      const h = this.hazards.get(event_id); if (h) h.received_at = got;
      for (const e of this.events.slice(last)) { e.received_at = got; e.created_at = Math.min(e.created_at, got); }
    }
  }

  // ---------------------------------------------------------------- KPI replay (backend/sim.py)
  replay({ scenario = null, trials = 300, closures = [], seed = 42, cargo_type = "general" }) {
    const t0 = performance.now();
    const rng = mulberry32(seed);
    let forecast, month;
    if (scenario && scenario !== "current") {
      const sc = SCENARIOS[scenario]; if (!sc) throw new HttpError(400, "unknown scenario");
      forecast = Object.fromEntries(this.network.met_zones.map((z) => [z.id, { ...(sc.zones[z.id] || sc.default) }])); month = sc.month;
    } else { forecast = JSON.parse(JSON.stringify(this.weather.values)); month = this.weather.month; }
    const bad = closures.filter((c) => !this.edges[c]); if (bad.length) throw new HttpError(400, `unknown edges: ${bad}`);
    const edges = this.network.edges; const R = this.router; const closed = new Set(closures);
    const W = (vals) => ({ values: vals, month, forEdge(zs) { const v = zs.map((z) => vals[z]); const o = {}; for (const k of Object.keys(v[0])) o[k] = Math.max(...v.map((x) => x[k])); return o; } });
    const OD = [["SLG", "GTK"], ["GHY", "SCR"], ["GHY", "IMP"], ["GHY", "AZL"], ["GHY", "AGT"], ["SCR", "IMP"], ["GHY", "TWG"], ["DMR", "IMP"], ["SLG", "SCR"], ["GHY", "SHL"], ["SCR", "AGT"], ["GHY", "DBR"]];
    const rows = [], lat = [];
    const mt = CARGO[cargo_type].max_transit_h;
    const fcW = W(forecast); const wfe = (e) => fcW.forEdge(e.met_zones);
    for (let trial = 0; trial < trials; trial++) {
      const [o, d] = OD[trial % OD.length];
      const truth = {}; for (const [z, v] of Object.entries(forecast)) { const f = Math.exp(0.3 * randn(rng)); truth[z] = Object.fromEntries(Object.entries(v).map(([k, x]) => [k, x * f])); }
      const tW = W(truth);
      const windows = {}, known = {};
      for (const e of edges) {
        const tr = tW.forEdge(e.met_zones);
        const pTrue = trueBlockProb(buildRow(e, tr, 0, month));
        const blocked = rng() < pTrue; const dur = delayIfBlocked(e, tr) * 2 * (0.5 + rng());
        const onset = -dur + rng() * (12 + dur);
        if (closed.has(e.id)) { windows[e.id] = [-24, 96]; known[e.id] = 2; }   // injected closures clear after 4 days
        else if (blocked) { windows[e.id] = [onset, onset + dur]; if (onset < -0.5 && rng() < 0.7) known[e.id] = 1 + poisson(rng, 0.8); }
      }
      const status = Object.fromEntries(edges.map((e) => [e.id, closed.has(e.id) ? "blocked" : "open"]));
      const scores = this.model.scoreAll(edges, fcW, known, status);
      const ts = performance.now(); const options = {};
      for (const prof of Object.keys(PROFILES)) {
        const lg = R.search(o, d, scores, wfe, prof, cargo_type);
        if (lg) options[prof] = { legs: lg, metrics: R.evaluate(lg, prof, cargo_type, null, 200) };
      }
      lat.push(performance.now() - ts);
      const naive = R.search(o, d, scores, wfe, "fastest", cargo_type, undefined, { knowledge: "naive" });
      if (!Object.keys(options).length || !naive) continue;
      const chosen = recommend(options, cargo_type === "relief" ? "critical" : "normal", cargo_type)[0];
      const aware = options[chosen].legs; const aEval = options[chosen].metrics;
      const trueT = Object.fromEntries(edges.map((e) => [e.id, travelTime(e, tW.forEdge(e.met_zones))]));
      const freeFlow = naive.reduce((s, l) => s + (l.kind === "edge" ? trueT[l.edge_id] : l.t), 0);
      const staticEta = naive.reduce((s, l) => s + l.t, 0);
      const drive = (legs, knowledge, prof) => {
        let clock = 0, hits = 0, replans = 0, i = 0, planned = legs, node = o, flagAt = null; const excl = new Set();
        while (i < planned.length) {
          const l = planned[i];
          if (l.kind === "edge") {
            const w = windows[l.edge_id];
            if (w && w[0] <= clock && clock < w[1]) {
              hits++; excl.add(l.edge_id);
              const wait = w[1] - clock; const restOld = planned.slice(i).reduce((s, x) => s + x.t, 0);
              let alt = null;
              if (replans < 4) alt = R.search(node, d, scores, wfe, prof, cargo_type, undefined, { knowledge, exclude: excl, startH: clock });
              const altT = alt ? alt.reduce((s, x) => s + x.t + (knowledge === "model" ? x.p * x.c : 0), 0) : 1e9;
              if (mt && flagAt == null && clock + Math.min(altT, wait + restOld) > mt) flagAt = clock;
              if (alt && altT < wait + restOld) { planned = alt; i = 0; replans++; continue; }
              clock += wait;
            }
            clock += trueT[l.edge_id]; node = l.to;
          } else clock += l.t;
          i++;
        }
        return [clock, hits, flagAt];
      };
      const [tb, hb] = drive(naive, "naive", "fastest");
      let [ta, ha, fa] = drive(aware, "model", chosen);
      if (mt && (aEval.p_cold_chain_breach || 0) >= 0.2) fa = 0;
      rows.push({ od: `${o}-${d}`, base_t: tb, aware_t: ta, base_hits: hb, aware_hits: ha, base_eta_pred: staticEta, aware_eta_pred: aEval.eta_expected_h,
        base_delay: tb - freeFlow, aware_delay: ta - freeFlow, aware_breach_flag: mt ? fa != null && fa < mt : null,
        aware_breach: mt ? ta > mt : null, base_breach: mt ? tb > mt : null });
    }
    const M = (k) => mean(rows.map((r) => r[k]));
    const bD = M("base_delay"), aD = M("aware_delay");
    const mape = (p, a) => mean(rows.map((r) => Math.abs(r[p] - r[a]) / r[a]));
    const exposed = rows.filter((r) => r.base_hits > 0);
    const k = {
      trials: rows.length, mean_delay_baseline_h: r2(bD), mean_delay_risk_aware_h: r2(aD),
      delay_avoided_pct: bD > 0 ? r2(100 * (bD - aD) / bD, 1) : 0,
      mean_trip_baseline_h: r2(M("base_t")), mean_trip_risk_aware_h: r2(M("aware_t")),
      p90_trip_baseline_h: r2(percentile(rows.map((r) => r.base_t), 90)), p90_trip_risk_aware_h: r2(percentile(rows.map((r) => r.aware_t), 90)),
      eta_error_baseline_pct: r2(100 * mape("base_eta_pred", "base_t"), 1), eta_error_risk_aware_pct: r2(100 * mape("aware_eta_pred", "aware_t"), 1),
      blockage_encounter_baseline_pct: r2(100 * mean(rows.map((r) => (r.base_hits > 0 ? 1 : 0))), 1),
      blockage_encounter_risk_aware_pct: r2(100 * mean(rows.map((r) => (r.aware_hits > 0 ? 1 : 0))), 1),
      reroute_success_pct: exposed.length ? r2(100 * mean(exposed.map((r) => (r.aware_hits === 0 ? 1 : 0))), 1) : null,
      trips_exposed_baseline: exposed.length,
      decision_latency_ms_mean: r2(mean(lat), 1), decision_latency_ms_p95: r2(percentile(lat, 95), 1),
    };
    if (mt) {
      const br = rows.filter((r) => r.aware_breach);
      k.cold_chain_breaches_baseline = rows.filter((r) => r.base_breach).length; k.cold_chain_breaches_risk_aware = br.length;
      k.cold_chain_flagged_before_breach_pct = br.length ? r2(100 * mean(br.map((r) => (r.aware_breach_flag ? 1 : 0))), 1) : null;
    }
    const bins = [0, 0.5, 2, 6, 12, 24, 48, Infinity], labels = ["<0.5 h", "0.5–2 h", "2–6 h", "6–12 h", "12–24 h", "24–48 h", ">48 h"];
    const hist = (a) => labels.map((_, i) => a.filter((x) => Math.max(x, 0) >= bins[i] && Math.max(x, 0) < bins[i + 1]).length);
    const hb = hist(rows.map((r) => r.base_delay)), ha = hist(rows.map((r) => r.aware_delay));
    k.delay_hist = labels.map((l, i) => ({ bin: l, baseline: hb[i], risk_aware: ha[i] }));
    const per = {};
    for (const r of rows) { const s = (per[r.od] ||= { od: r.od, n: 0, b: 0, a: 0 }); s.n++; s.b += r.base_delay; s.a += r.aware_delay; }
    k.per_od = Object.values(per).map((v) => ({ od: v.od, n: v.n, base_delay_h: r2(v.b / v.n), aware_delay_h: r2(v.a / v.n) }));
    Object.assign(k, { scenario: scenario || "current", cargo: cargo_type, closures: [...closed].sort(), runtime_s: r2((performance.now() - t0) / 1000),
      offline_sync: this.syncStats() });
    this.audit("analyst", "sim.replay", { scenario, trials, closures, cargo: cargo_type });
    return k;
  }
}


// ============================================================================ live fleet (backend/tracking.py)
const bearing = (a, b) => {
  const la1 = a[1] * Math.PI / 180, la2 = b[1] * Math.PI / 180, dl = (b[0] - a[0]) * Math.PI / 180;
  return (Math.atan2(Math.sin(dl) * Math.cos(la2), Math.cos(la1) * Math.sin(la2) - Math.sin(la1) * Math.cos(la2) * Math.cos(dl)) * 180 / Math.PI + 360) % 360;
};
const hav = (a, b) => {
  const R = 6371, t = Math.PI / 180, dLa = (b[1] - a[1]) * t, dLo = (b[0] - a[0]) * t;
  const s = Math.sin(dLa / 2) ** 2 + Math.cos(a[1] * t) * Math.cos(b[1] * t) * Math.sin(dLo / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
};
class Fleet {
  constructor(engine, speedup = 30) { this.E = engine; engine.fleet = this; this.v = new Map(); this.trails = new Map(); this.speedup = speedup; this.running = true; }
  plan(legs) {
    const out = []; let t = 0;
    for (const l of legs) {
      if (l.kind === "edge") {
        const coords = l.coords?.length > 1 ? l.coords : [[this.E.nodes[l.frm].lon, this.E.nodes[l.frm].lat], [this.E.nodes[l.to].lon, this.E.nodes[l.to].lat]];
        const cum = [0]; for (let i = 0; i < coords.length - 1; i++) cum.push(cum[i] + hav(coords[i], coords[i + 1]));
        const th = Math.max(l.t_h, 0.01);
        out.push({ kind: "edge", edge_id: l.edge_id, frm: l.frm, to: l.to, name: `${l.frm_name} → ${l.to_name}`, route_ref: l.route_ref, coords, cum,
          km: cum[cum.length - 1] || 0.01, t_h: th, t0: t, t1: t + th, no_network: l.no_network });
      } else {
        const n = this.E.nodes[l.at];
        out.push({ kind: "transfer", at: l.at, name: `Transfer ${l.mode} at ${l.at_name}`, coords: [[n.lon, n.lat]], cum: [0], km: 0, t_h: l.t_h, t0: t, t1: t + l.t_h });
      }
      t = out[out.length - 1].t1;
    }
    return out;
  }
  attach(vid, routeId, source = "sim", demo = false, startFrac = 0) {
    const r = this.E.routes.get(routeId); if (!r) return;
    const legs = this.plan(r.edges); const total = legs.length ? legs[legs.length - 1].t1 : 0;
    const st = { vehicle_id: vid, route_id: routeId, shipment_id: r.shipment_id, legs, total_h: total, pos_h: total * startFrac, source, demo,
      status: "moving", hold_reason: null, cargo_type: r.payload.cargo_type, origin: r.payload.origin, destination: r.payload.destination,
      profile: r.profile, heading: 0, speed_kmh: 0, updated: now(), arrived_at: null, offroute_km: 0, alerted: new Set() };
    this.v.set(vid, st); this.trails.set(vid, []); this.place(st);
  }
  legAt(st, pos) { for (let i = 0; i < st.legs.length; i++) if (pos <= st.legs[i].t1 || i === st.legs.length - 1) return [i, st.legs[i]]; return [0, st.legs[0]]; }
  pointOn(leg, f) {
    if (leg.kind !== "edge") return [leg.coords[0], null];
    const d = f * leg.km, c = leg.coords, cum = leg.cum;
    for (let i = 0; i < c.length - 1; i++) if (d <= cum[i + 1] || i === c.length - 2) {
      const seg = Math.max(cum[i + 1] - cum[i], 1e-9), t = Math.max(0, Math.min(1, (d - cum[i]) / seg));
      return [[c[i][0] + (c[i + 1][0] - c[i][0]) * t, c[i][1] + (c[i + 1][1] - c[i][1]) * t], bearing(c[i], c[i + 1])];
    }
    return [c[c.length - 1], null];
  }
  place(st) {
    if (!st.legs.length) return;
    const [i, leg] = this.legAt(st, st.pos_h);
    const f = leg.t_h ? (st.pos_h - leg.t0) / leg.t_h : 1;
    const [p, b] = this.pointOn(leg, Math.max(0, Math.min(1, f)));
    st.lon = p[0]; st.lat = p[1]; if (b != null) st.heading = b; st.leg_index = i;
    st.speed_kmh = st.status === "moving" && leg.kind === "edge" ? r2(leg.km / leg.t_h, 1) : 0;
  }
  step(dt) {
    const sc = this.E.scores();
    for (const st of this.v.values()) {
      if (st.source !== "sim" || !st.legs.length) continue;
      if (st.status === "arrived") {
        if (st.demo && now() - st.arrived_at > 45) { st.pos_h = 0; st.status = "moving"; st.arrived_at = null; this.trails.set(st.vehicle_id, []); }
        continue;
      }
      const np = Math.min(st.pos_h + dt * this.speedup / 3600, st.total_h);
      let held = null;
      for (const l of st.legs) {
        if (l.kind !== "edge" || l.t1 <= st.pos_h) continue;
        if (l.t0 > np) break;
        if (sc[l.edge_id].status === "blocked") { held = l; break; }
      }
      if (held) {
        if (held.t0 > st.pos_h) st.pos_h = Math.min(held.t0, np);
        st.status = "holding"; st.hold_reason = `Blocked ahead: ${held.name} (${held.route_ref})`;
        if (!st.alerted.has(held.edge_id)) {
          st.alerted.add(held.edge_id);
          this.E.appendEvent("alert", { vehicle_id: st.vehicle_id, route_id: st.route_id, edge_id: held.edge_id, created_at: now(),
            message: `${st.vehicle_id} holding before ${held.name}: segment blocked. Re-plan or wait for clearance.` });
        }
      } else {
        st.pos_h = np;
        const [, leg] = this.legAt(st, st.pos_h);
        st.status = leg.kind === "transfer" ? "loading" : "moving"; st.hold_reason = leg.kind === "transfer" ? leg.name : null;
        if (st.pos_h >= st.total_h - 1e-9) { st.status = "arrived"; st.arrived_at = now(); }
      }
      this.place(st); st.updated = now(); this.trail(st);
    }
  }
  trail(st) {
    const tr = this.trails.get(st.vehicle_id) || []; const pt = [r2(st.lon, 5), r2(st.lat, 5)];
    if (!tr.length || tr[tr.length - 1][0] !== pt[0] || tr[tr.length - 1][1] !== pt[1]) tr.push(pt);
    if (tr.length > 600) tr.shift();
    this.trails.set(st.vehicle_id, tr);
  }
  ingest(vid, lat, lon, speed = null, heading = null, ts = null, source = "gps", offline = false) {
    let st = this.v.get(vid);
    if (!st) {
      st = { vehicle_id: vid, route_id: null, shipment_id: null, legs: [], total_h: 0, pos_h: 0, source, demo: false, status: "moving", hold_reason: null,
        cargo_type: null, origin: null, destination: null, profile: null, heading: 0, speed_kmh: 0, arrived_at: null, offroute_km: 0, alerted: new Set() };
      this.v.set(vid, st); this.trails.set(vid, []);
    }
    const prev = st.lon != null ? [st.lon, st.lat] : null;
    Object.assign(st, { lat, lon, source, updated: ts || now() });
    if (heading != null) st.heading = heading; else if (prev && (prev[0] !== lon || prev[1] !== lat)) st.heading = bearing(prev, [lon, lat]);
    st.speed_kmh = speed ?? st.speed_kmh ?? 0; st.status = st.speed_kmh > 2 ? "moving" : "stopped";
    if (st.legs.length) this.snapTo(st, [lon, lat]);
    this.trail(st);
    return this.describe(st);
  }
  snapTo(st, p) {
    let best = [Infinity, st.pos_h, null]; const k = Math.cos(p[1] * Math.PI / 180);
    const win = st.pos_h < st.total_h - 1e-6 ? st.pos_h - 1 : -1;
    st.legs.forEach((l, i) => {
      if (l.kind !== "edge" || l.t1 < win) return;
      for (let j = 0; j < l.coords.length - 1; j++) {
        const a = l.coords[j], b = l.coords[j + 1]; const ax = a[0] * k, bx = b[0] * k, dx = bx - ax, dy = b[1] - a[1];
        const t = Math.max(0, Math.min(1, ((p[0] * k - ax) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)));
        const d = Math.hypot(p[0] * k - (ax + t * dx), p[1] - (a[1] + t * dy)) * 111;
        if (d < best[0]) best = [d, l.t0 + (l.cum[j] + t * (l.cum[j + 1] - l.cum[j])) / l.km * l.t_h, i];
      }
    });
    st.offroute_km = r2(best[0], 2);
    if (best[0] < 3) { st.pos_h = best[1]; st.leg_index = best[2]; }
  }
  describe(st, detail = false) {
    const sc = this.E.scores(); const N = this.E.nodes;
    let rem = 0, delay = 0, hazard = null;
    if (st.legs.length) {
      rem = Math.max(st.total_h - st.pos_h, 0);
      for (const l of st.legs) {
        if (l.t1 <= st.pos_h) continue;
        const startIn = Math.max(l.t0 - st.pos_h, 0);
        if (l.kind === "edge") {
          const s = sc[l.edge_id]; const blocked = s.status === "blocked"; const p = blocked ? 1 : interpP(s.p, startIn);
          delay += p * s.delay_if_blocked_h;
          if (!hazard && (blocked || p >= 0.35)) {
            let km = 0; for (const x of st.legs) { const lo = Math.max(x.t0, st.pos_h), hi = Math.min(x.t1, l.t0); if (hi > lo && x.t_h) km += x.km * (hi - lo) / x.t_h; }
            hazard = { edge_id: l.edge_id, name: l.name, route_ref: l.route_ref, p: r2(p, 3), blocked, in_h: r2(startIn, 2), in_km: r2(km, 1) };
          }
        }
      }
    }
    const leg = st.legs.length ? st.legs[st.leg_index ?? 0] : null;
    const out = { vehicle_id: st.vehicle_id, shipment_id: st.shipment_id, route_id: st.route_id, source: st.source, lat: st.lat, lon: st.lon,
      heading: r2(st.heading || 0, 1), speed_kmh: st.speed_kmh || 0, status: st.status, hold_reason: st.hold_reason, cargo_type: st.cargo_type,
      profile: st.profile, origin: st.origin, destination: st.destination, origin_name: st.origin ? N[st.origin].name : null,
      destination_name: st.destination ? N[st.destination].name : null, progress: st.total_h ? r2(st.pos_h / st.total_h, 4) : null,
      eta_h: st.legs.length ? r2(rem + delay, 2) : null, expected_delay_h: r2(delay, 2), current: leg?.name ?? null, current_edge: leg?.edge_id ?? null,
      no_network: !!leg?.no_network, offroute_km: st.offroute_km, next_hazard: hazard, updated: st.updated, stale_s: r2(now() - (st.updated || 0), 1) };
    if (detail) {
      out.trail = [...(this.trails.get(st.vehicle_id) || [])];
      out.route = st.legs.filter((l) => l.kind === "edge").flatMap((l) => l.coords);
      out.legs = st.legs.map((l) => ({ kind: l.kind, name: l.name, t0: r2(l.t0, 2), t1: r2(l.t1, 2), km: r2(l.km, 1), edge_id: l.edge_id }));
    }
    return out;
  }
  snapshot() { return [...this.v.values()].filter((s) => s.lat != null).map((s) => this.describe(s)); }
  detail(id) { const s = this.v.get(id); return s ? this.describe(s, true) : null; }
  completedH(id) { const s = this.v.get(id); return s && s.legs.length ? s.pos_h : null; }
  settings() { const all = [...this.v.values()]; return { speedup: this.speedup, running: this.running, vehicles: all.length, simulated: all.filter((s) => s.source === "sim").length }; }
  start() { let last = performance.now(); setInterval(() => { const t = performance.now(); if (this.running) this.step((t - last) / 1000); last = t; }, 1000); }
}

// ============================================================================ HTTP-style router (backend/main.py)
export class LocalServer {
  constructor(network, model, metrics) {
    this.engine = new Engine(network, model, metrics);
    this.fleet = new Fleet(this.engine, 30);
    this.engine.seedDemo();
    this.fleet.start();
  }
  handle(method, rawPath, body = {}) {
    const E = this.engine;
    const [path, qs] = rawPath.split("?"); const q = new URLSearchParams(qs || "");
    const m = (re) => path.match(re);
    let x;
    if (method === "GET") {
      if (path === "/health") return { ok: true, model_version: E.model.version, weather: E.weather.freshness(), edges: E.network.edges.length, time: now() };
      if (path === "/network") return { version: E.network.version, note: E.network.note, nodes: E.network.nodes, corridors: E.network.corridors,
        met_zones: E.network.met_zones, road_nodes: E.roadNodes, edges: E.network.edges.map((e) => ({ ...e, detour_extra_h: E.router.detourExtra[e.id] === Infinity ? null : E.router.detourExtra[e.id] })),
        cargo: CARGO, profiles: Object.fromEntries(Object.entries(PROFILES).map(([k, v]) => [k, { label: v.label, description: v.description }])) };
      if (path === "/risk/edges") return { edges: E.riskEdges(), data_freshness: E.weather.freshness(), model_version: E.model.version };
      if ((x = m(/^\/risk\/edge\/(.+)$/))) { if (!E.edges[x[1]]) throw new HttpError(404, "unknown edge"); return E.edgeRisk(x[1]); }
      if (path === "/weather") return E.weather.snapshot();
      if (path === "/dashboard/corridors") return E.corridors();
      if (path === "/shipments") return E.shipments();
      if (path === "/vehicles") return E.vehicles();
      if (path === "/fleet") return { vehicles: this.fleet.snapshot(), sim: this.fleet.settings(), t: now() };
      if ((x = m(/^\/fleet\/(.+)$/))) { const d = this.fleet.detail(decodeURIComponent(x[1])); if (!d) throw new HttpError(404, "unknown vehicle"); return d; }
      if (path === "/roads/status") return { total: E.network.edges.length, with_road_geometry: E.network.edges.filter((e) => e.geometry.length > 2).length,
        rejected: 0, pending: 0, running: false, error: null };
      if (path === "/model") return E.model.metrics;
      if (path === "/audit") return [...E.audits].reverse().slice(0, +(q.get("limit") || 100));
      if (path === "/incidents") {
        const since = now() - +(q.get("hours") || 24) * 3600;
        return [...E.hazards.values()].filter((h) => h.time_start >= since).sort((a, b) => b.time_start - a.time_start).map((h) => {
          let { lat, lon } = h;
          if (lat == null && h.edge_id) { const g = E.edges[h.edge_id].geometry; lon = (g[0][0] + g[1][0]) / 2; lat = (g[0][1] + g[1][1]) / 2; }
          return { ...h, lat, lon };
        });
      }
    } else if (method === "POST") {
      if (path === "/route/optimize") return E.optimize(body);
      if ((x = m(/^\/route\/(.+)\/approve$/))) return E.approve(x[1], body);
      if (path === "/incident/report") {
        if (!body.edge_id && (body.lat == null || body.lon == null)) throw new HttpError(400, "give edge_id or lat/lon");
        const res = E.ingest({ source: "driver", device_id: "dispatcher-console", ...body }, "direct");
        if (!res.edge_id) res.warning = "Could not snap the report to a corridor edge (more than 20 km away).";
        return res;
      }
      if (path === "/sync/events") return E.sync(body);
      if (path === "/weather/scenario") { E.weather.setScenario(body.scenario); E.invalidate(); E.audit("dispatcher", "weather.scenario", { scenario: body.scenario }); return E.weather.snapshot(); }
      if (path === "/weather/live") {
        E.weather.error = "This browser demo cannot reach external data sources. Run the downloadable server version for live Open-Meteo rainfall.";
        const snap = E.weather.snapshot(); snap.ok = false; throw Object.assign(new HttpError(502, E.weather.error), { data: snap });
      }
      if (path === "/shipments") return E.createShipment(body);
      if (path === "/fleet/sim") {
        if (body.speedup != null) this.fleet.speedup = Math.max(1, Math.min(600, +body.speedup));
        if (body.running != null) this.fleet.running = !!body.running;
        return this.fleet.settings();
      }
      if ((x = m(/^\/vehicles\/(.+)\/position$/))) return this.fleet.ingest(decodeURIComponent(x[1]), +body.lat, +body.lon, body.speed_kmh ?? null, body.heading ?? null, body.ts || now(), "gps");
      if ((x = m(/^\/edges\/(.+)\/status$/))) return E.override(x[1], body);
      if (path === "/sim/replay") {
        const t = Math.max(20, Math.min(2000, +body.trials || 300));
        return E.replay({ ...body, trials: t });
      }
    }
    throw new HttpError(404, `No route for ${method} ${path}`);
  }
}

export async function startLocalServer(base = "data/") {
  const [network, model, metrics] = await Promise.all(["network.json", "model.json", "metrics.json"].map((f) => fetch(base + f).then((r) => r.json())));
  return new LocalServer(network, model, metrics);
}
export const _internals = { HazardModel, buildRow, FEATURES };
