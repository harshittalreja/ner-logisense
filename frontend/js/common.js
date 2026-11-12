// Shared helpers for the dispatcher console and the driver app: API calls, formatting,
// the basemap (OpenStreetMap via OpenFreeMap) and all map overlays.
export const API = "";   // same origin as the FastAPI server

// Browser-only build: requests go to an in-page JavaScript port of the backend instead of HTTP.
let localServer = null;
export function useLocalServer(promise) { localServer = promise; }

export async function api(path, opts = {}) {
  if (localServer) {
    const srv = await localServer;
    let body = opts.body;
    if (typeof body === "string") body = JSON.parse(body);
    if (path.startsWith("/sim/replay")) await new Promise((r) => setTimeout(r, 30));   // let the spinner paint
    try { return JSON.parse(JSON.stringify(srv.handle(opts.method || "GET", path, body || {}))); }
    catch (e) {
      if (e.status) { const err = new Error(e.detail); err.status = e.status; err.data = e.data; throw err; }
      throw e;
    }
  }
  const init = { headers: { "Content-Type": "application/json" }, ...opts };
  if (init.body && typeof init.body !== "string") init.body = JSON.stringify(init.body);
  const res = await fetch(API + path, init);
  let data = null;
  try { data = await res.json(); } catch { /* empty */ }
  if (!res.ok) {
    const msg = (data && (data.detail || data.error)) || `${res.status} ${res.statusText}`;
    const err = new Error(typeof msg === "string" ? msg : JSON.stringify(msg));
    err.status = res.status; err.data = data;
    throw err;
  }
  return data;
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export function h(html) { const t = document.createElement("template"); t.innerHTML = html.trim(); return t.content.firstElementChild; }
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export const pct = (p, d = 0) => (p == null ? "–" : `${(p * 100).toFixed(d)}%`);
export function hrs(x) {
  if (x == null || Number.isNaN(x)) return "–";
  const neg = x < 0; x = Math.abs(x);
  const hh = Math.floor(x), mm = Math.round((x - hh) * 60);
  const s = hh >= 48 ? `${(x / 24).toFixed(1)} d` : mm === 60 ? `${hh + 1} h` : hh ? `${hh} h ${String(mm).padStart(2, "0")} min` : `${mm} min`;
  return (neg ? "−" : "") + s;
}
export const ago = (ts) => {
  const s = Math.max(0, Date.now() / 1000 - ts);
  if (s < 60) return `${Math.round(s)} s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  return `${(s / 3600).toFixed(1)} h ago`;
};

// Hazard colours (fixed status palette; always shown with a text label too)
export const LEVEL_COLOR = { low: "#1e9e4a", elevated: "#e8a200", medium: "#e8642c", high: "#d12f2f", blocked: "#8e1414" };
export const LEVEL_LABEL = { low: "Low", elevated: "Elevated", medium: "Medium", high: "High", blocked: "Blocked" };
export const badge = (lvl, text) => `<span class="badge lvl-${lvl}">${esc(text || LEVEL_LABEL[lvl] || lvl)}</span>`;
export function levelOf(p, status) {
  if (status === "blocked") return "blocked";
  if (p >= 0.6) return "high"; if (p >= 0.35) return "medium"; if (p >= 0.15) return "elevated"; return "low";
}

export const LOGO = `<svg class="logo" viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="8" fill="#0f3b75"/>
<path d="M3 24 L11 12 L16 18 L21 9 L29 24 Z" fill="#1d5aa6"/><path d="M4 23 C 10 21, 12 16, 17 17 S 25 12, 28 10" fill="none" stroke="#8cc4ff" stroke-width="2.4" stroke-linecap="round"/>
<circle cx="17" cy="17" r="2.6" fill="#ffc53d"/></svg>`;
export const TRUCK = `<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h11v9H3z"/><path d="M14 9h4l3 3v3h-7z"/><circle cx="7" cy="17" r="1.6"/><circle cx="17" cy="17" r="1.6"/></svg>`;
export const WARN_ICON = (c = "#d12f2f") => `<svg viewBox="0 0 24 24" class="inc-marker"><path d="M12 2 L23 21 H1 Z" fill="${c}" stroke="#fff" stroke-width="1.6"/><rect x="11" y="8" width="2" height="7" fill="#fff"/><rect x="11" y="16.5" width="2" height="2" fill="#fff"/></svg>`;

// ------------------------------------------------------------------------------------ basemaps
// Two kinds of basemap:
//  * online vector/raster tiles: OpenFreeMap (OpenStreetMap data, no API key) and Esri imagery;
//  * the built-in map shipped with the app (frontend/basemap): official National Highways (MoRTH),
//    Indian Railways, state boundaries, rivers, lakes and towns. It needs no tile server, so it also
//    works offline, inside locked-down pages, and whenever the online map can't be reached.
const CFG = globalThis.NER_CONFIG || {};
const ASSET_BASE = new URL(CFG.assetBase || "/static/", document.baseURI).href;

// Hosts that don't serve .pbf files get the label glyphs as one JSON bundle, read through a custom protocol.
let GLYPHS = `${ASSET_BASE}fonts/{fontstack}/{range}.pbf`;
if (CFG.fontsJson && globalThis.maplibregl?.addProtocol) {
  const bundle = fetch(new URL(CFG.fontsJson, document.baseURI)).then((r) => r.json());
  maplibregl.addProtocol("nerfont", async (params) => {
    const key = decodeURIComponent(params.url.replace("nerfont://", "")).split(",")[0];
    const b64 = (await bundle)[key];
    if (!b64) return { data: new ArrayBuffer(0) };
    const bin = atob(b64); const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return { data: bytes.buffer };
  });
  GLYPHS = "nerfont://{fontstack}/{range}";
}

const PALETTE = {
  light: { bg: "#f2efe9", land: "#f8f6f1", neighbour: "#e8e5de", border: "#b7a9cc", water: "#a8cfe0", rail: "#9aa0a6",
    roadCase: "#d3cdbf", road: "#ffffff", roadLabel: "#6d6a63", place: "#2a2f36", placeHalo: "#ffffff", region: "#a293bb", country: "#8f8a80" },
  dark: { bg: "#1b1f25", land: "#23282f", neighbour: "#1e2228", border: "#56506a", water: "#2a4a66", rail: "#5c636b",
    roadCase: "#15181c", road: "#3b434e", roadLabel: "#aab3bf", place: "#e1e6ec", placeHalo: "#1b1f25", region: "#7f78a0", country: "#7b8490" },
};

export function bundleStyle(mode = "light") {
  const c = PALETTE[mode];
  const src = (f) => ({ type: "geojson", data: `${ASSET_BASE}basemap/${f}.geojson`, attribution: f === "highways"
    ? "Highways: MoRTH / PM GatiShakti · Railways: Indian Railways · © Natural Earth" : undefined });
  const font = (w) => [`OpenSans-${w}`];
  return {
    version: 8,
    glyphs: GLYPHS,
    sources: Object.fromEntries(["countries", "states", "lakes", "rivers", "railways", "highways", "places", "regionlabels"].map((f) => [`bm-${f}`, src(f)])),
    layers: [
      { id: "bm-bg", type: "background", paint: { "background-color": c.bg } },
      { id: "bm-countries", type: "fill", source: "bm-countries", paint: { "fill-color": c.neighbour } },
      { id: "bm-states", type: "fill", source: "bm-states", paint: { "fill-color": c.land } },
      { id: "bm-lakes", type: "fill", source: "bm-lakes", paint: { "fill-color": c.water } },
      { id: "bm-rivers", type: "line", source: "bm-rivers", layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": c.water, "line-width": ["interpolate", ["linear"], ["zoom"], 5, ["case", ["<=", ["get", "rank"], 4], 2.5, 1], 10, ["case", ["<=", ["get", "rank"], 4], 8, 3]] } },
      { id: "bm-state-lines", type: "line", source: "bm-states", paint: { "line-color": c.border, "line-width": 1, "line-dasharray": [3, 2] } },
      { id: "bm-country-lines", type: "line", source: "bm-countries", paint: { "line-color": c.border, "line-width": 1.8 } },
      { id: "bm-rail", type: "line", source: "bm-railways", paint: { "line-color": c.rail, "line-width": ["interpolate", ["linear"], ["zoom"], 6, 0.8, 11, 2], "line-dasharray": [4, 3] } },
      { id: "bm-road-case", type: "line", source: "bm-highways", layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": c.roadCase, "line-width": ["interpolate", ["linear"], ["zoom"], 5, 2.2, 9, 5, 13, 11] } },
      { id: "bm-road", type: "line", source: "bm-highways", layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": c.road, "line-width": ["interpolate", ["linear"], ["zoom"], 5, 1.1, 9, 3.2, 13, 8] } },
      { id: "bm-road-label", type: "symbol", source: "bm-highways", minzoom: 7,
        layout: { "symbol-placement": "line", "text-field": ["get", "ref"], "text-font": font("Semibold"), "text-size": 10.5, "symbol-spacing": 350 },
        paint: { "text-color": c.roadLabel, "text-halo-color": c.placeHalo, "text-halo-width": 1.6 } },
      { id: "bm-region-label", type: "symbol", source: "bm-regionlabels",
        layout: { "text-field": ["get", "name"], "text-font": ["case", ["==", ["get", "country"], 1], ["literal", font("Italic")], ["literal", font("Semibold")]],
          "text-size": ["case", ["==", ["get", "country"], 1], 13, 11], "text-letter-spacing": 0.2, "text-max-width": 8 },
        paint: { "text-color": ["case", ["==", ["get", "country"], 1], c.country, c.region], "text-halo-color": c.bg, "text-halo-width": 1 } },
      { id: "bm-place-dot", type: "circle", source: "bm-places", filter: ["<=", ["get", "rank"], ["step", ["zoom"], 1, 6.5, 2, 8.5, 3]],
        paint: { "circle-radius": ["match", ["get", "rank"], 1, 3.5, 2.6], "circle-color": c.place, "circle-stroke-color": c.placeHalo, "circle-stroke-width": 1.2 } },
      { id: "bm-place-label", type: "symbol", source: "bm-places", filter: ["<=", ["get", "rank"], ["step", ["zoom"], 1, 6.5, 2, 8.5, 3]],
        layout: { "text-field": ["get", "name"], "text-font": ["match", ["get", "rank"], 1, ["literal", font("Bold")], 2, ["literal", font("Semibold")], ["literal", font("Regular")]],
          "text-size": ["match", ["get", "rank"], 1, 13, 2, 11.5, 10.5], "text-anchor": "top", "text-offset": [0, 0.45], "text-max-width": 9 },
        paint: { "text-color": c.place, "text-halo-color": c.placeHalo, "text-halo-width": 1.6 } },
    ],
  };
}

const ONLINE = {
  streets: { label: "Streets", url: "https://tiles.openfreemap.org/styles/liberty", swatch: "#e9e4d8" },
  light: { label: "Light", url: "https://tiles.openfreemap.org/styles/positron", swatch: "#eef0f2" },
  dark: { label: "Dark", url: "https://tiles.openfreemap.org/styles/dark", swatch: "#2b2f36" },
  satellite: { label: "Satellite", swatch: "#44513c", style: () => ({
    version: 8, glyphs: GLYPHS,
    sources: { sat: { type: "raster", tileSize: 256, maxzoom: 19, attribution: "Imagery © Esri, Maxar, Earthstar Geographics",
      tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"] } },
    layers: [{ id: "sat", type: "raster", source: "sat" }],
  }) },
  builtin: { label: "Built-in", swatch: "#f8f6f1", style: () => bundleStyle("light") },
};
const BUILTIN_ONLY = {
  map: { label: "Map", swatch: "#f8f6f1", style: () => bundleStyle("light") },
  dark: { label: "Dark", swatch: "#23282f", style: () => bundleStyle("dark") },
};
export const BASEMAPS = CFG.builtinMapOnly ? BUILTIN_ONLY : ONLINE;
export const DEFAULT_BASEMAP = CFG.builtinMapOnly ? "map" : "streets";
export const NER_BOUNDS = [[88.0, 23.3], [95.8, 28.3]];

// Resolve a basemap to a style object; if an online style can't be fetched (offline, firewall),
// fall back to the built-in map so the page still shows a real map.
export async function resolveStyle(name) {
  const b = BASEMAPS[name] || BASEMAPS[DEFAULT_BASEMAP];
  if (b.style) return { style: b.style(), ok: true };
  try {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 5000);
    const res = await fetch(b.url, { signal: ctl.signal }); clearTimeout(t);
    if (!res.ok) throw new Error(res.status);
    return { style: await res.json(), ok: true };
  } catch { return { style: bundleStyle(name === "dark" ? "dark" : "light"), ok: false }; }
}
const FALLBACK_STYLE = { version: 8, sources: {}, layers: [{ id: "bg", type: "background", paint: { "background-color": "#f2efe9" } }] };

// ------------------------------------------------------------------------------------ overlays
const EMPTY = { type: "FeatureCollection", features: [] };
const line = (coords, props = {}) => ({ type: "Feature", properties: props, geometry: { type: "LineString", coordinates: coords } });
const lvlColor = ["match", ["get", "level"], "low", LEVEL_COLOR.low, "elevated", LEVEL_COLOR.elevated, "medium", LEVEL_COLOR.medium,
  "high", LEVEL_COLOR.high, "blocked", LEVEL_COLOR.blocked, "#888"];

// Build GeoJSON for the corridor network with live risk attached.
export function edgesGeoJSON(network, riskById = {}) {
  return { type: "FeatureCollection", features: network.edges.map((e) => {
    const r = riskById[e.id] || {}; const p = r.p_now ?? 0; const status = r.status || "open";
    return line(e.geometry, { id: e.id, mode: e.mode, p, level: levelOf(p, status), status, ref: e.route_ref });
  }) };
}

/**
 * MapView wraps a MapLibre map: basemap switching, and overlays that survive style changes.
 * Overlay data lives here and is re-applied after every style load.
 */
export class MapView {
  constructor(container, network, { basemap = "streets", onEdgeClick, onRouteClick, compact = false } = {}) {
    this.network = network; this.basemap = basemap; this.onEdgeClick = onEdgeClick; this.onRouteClick = onRouteClick;
    this.data = { edges: edgesGeoJSON(network), routeAlt: EMPTY, route: EMPTY, routeRisk: EMPTY, trail: EMPTY, plan: EMPTY };
    this.visible = { hazard: true, rail: true };
    this.routeMode = false;
    this.ready = new Promise((res) => (this._resolveReady = res));
    if (typeof container === "string") container = document.getElementById(container);
    this.map = new maplibregl.Map({ container, style: FALLBACK_STYLE, bounds: NER_BOUNDS, fitBoundsOptions: { padding: 30 },
      attributionControl: { compact: true }, maxZoom: 18 });
    if (!compact) this.map.addControl(new maplibregl.NavigationControl({ visualizePitch: false }), "bottom-right");
    this.map.addControl(new maplibregl.ScaleControl({ unit: "metric" }), "bottom-right");
    this.map.on("style.load", () => this._addOverlays());
    if (compact) this.map.on("idle", () => container.querySelector?.(".maplibregl-compact-show")?.classList.remove("maplibregl-compact-show"));
    this._bindEvents();
    this.setBasemap(basemap);
  }

  async setBasemap(name) {
    this.basemap = name;
    const { style, ok } = await resolveStyle(name);
    this.basemapOk = ok;
    this.map.setStyle(style, { diff: false });
  }

  _addOverlays() {
    const m = this.map;
    const src = (id) => m.addSource(id, { type: "geojson", data: this.data[id] });
    ["edges", "routeAlt", "route", "routeRisk", "trail", "plan"].forEach(src);
    const lineLayout = { "line-cap": "round", "line-join": "round" };
    // corridor hazard network (like a traffic layer)
    m.addLayer({ id: "edge-road", type: "line", source: "edges", filter: ["==", ["get", "mode"], "road"], layout: lineLayout,
      paint: { "line-color": lvlColor, "line-width": ["interpolate", ["linear"], ["zoom"], 5, 2.5, 10, 5, 14, 8], "line-opacity": 0.85 } });
    m.addLayer({ id: "edge-rail", type: "line", source: "edges", filter: ["==", ["get", "mode"], "rail"],
      paint: { "line-color": ["case", ["==", ["get", "level"], "low"], "#6f5fd6", lvlColor], "line-width": 2.2, "line-dasharray": [2, 1.5], "line-opacity": 0.85 } });
    m.addLayer({ id: "edge-ferry", type: "line", source: "edges", filter: ["==", ["get", "mode"], "ferry"],
      paint: { "line-color": "#1b8fb8", "line-width": 2.5, "line-dasharray": [0.6, 1.4] } });
    m.addLayer({ id: "edge-blocked", type: "line", source: "edges", filter: ["==", ["get", "status"], "blocked"], layout: lineLayout,
      paint: { "line-color": "#ffffff", "line-width": 2.5, "line-dasharray": [1, 1.6] } });
    // alternative routes (grey, clickable) and selected route (blue, with casing)
    m.addLayer({ id: "route-alt-casing", type: "line", source: "routeAlt", layout: lineLayout, paint: { "line-color": "#7b8794", "line-width": 9 } });
    m.addLayer({ id: "route-alt", type: "line", source: "routeAlt", layout: lineLayout, paint: { "line-color": "#b9c4cf", "line-width": 6 } });
    m.addLayer({ id: "route-casing", type: "line", source: "route", layout: lineLayout, paint: { "line-color": "#0d4fa8", "line-width": 10 } });
    m.addLayer({ id: "route-line", type: "line", source: "route", layout: lineLayout, paint: { "line-color": "#2f7fe6", "line-width": 6.5 } });
    m.addLayer({ id: "route-risk", type: "line", source: "routeRisk", layout: lineLayout, paint: { "line-color": lvlColor, "line-width": 6.5 } });
    // selected truck: planned route + breadcrumb trail
    m.addLayer({ id: "plan", type: "line", source: "plan", layout: lineLayout, paint: { "line-color": "#2f7fe6", "line-width": 4, "line-opacity": 0.45 } });
    m.addLayer({ id: "trail", type: "line", source: "trail", layout: lineLayout, paint: { "line-color": "#0d4fa8", "line-width": 3.5, "line-dasharray": [1, 1.2] } });
    m.addLayer({ id: "edge-hit", type: "line", source: "edges", paint: { "line-color": "#000", "line-width": 14, "line-opacity": 0 } });
    m.addLayer({ id: "route-alt-hit", type: "line", source: "routeAlt", paint: { "line-color": "#000", "line-width": 16, "line-opacity": 0 } });
    this._applyVisibility();
    this._resolveReady();
    this.map.fire("overlays.ready");
  }

  _bindEvents() {
    const m = this.map;
    const hover = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 10, className: "hover-pop" });
    m.on("mousemove", "edge-hit", (ev) => {
      if (!this.visible.hazard && !this.routeMode) return;
      m.getCanvas().style.cursor = "pointer";
      const p = ev.features[0].properties; const e = this.network.edges.find((x) => x.id === p.id);
      const nodes = this.network._nodes ||= Object.fromEntries(this.network.nodes.map((n) => [n.id, n]));
      hover.setLngLat(ev.lngLat).setHTML(`<b>${esc(nodes[e.source].name)} – ${esc(nodes[e.target].name)}</b><br>
        <span class="small dim">${esc(e.route_ref)} · ${e.mode} · ${e.length_km} km</span><br>${badge(p.level)} <span class="num">${pct(+p.p)}</span>`).addTo(m);
    });
    m.on("mouseleave", "edge-hit", () => { m.getCanvas().style.cursor = ""; hover.remove(); });
    m.on("click", (ev) => {
      if (!m.getLayer("edge-hit")) return;
      const alt = m.queryRenderedFeatures(ev.point, { layers: ["route-alt-hit"] })[0];
      if (alt && this.onRouteClick) return this.onRouteClick(alt.properties.profile);
      const hit = m.queryRenderedFeatures(ev.point, { layers: ["edge-hit"] })[0];
      if (hit && this.onEdgeClick) this.onEdgeClick(hit.properties.id, ev);
    });
    m.on("mouseenter", "route-alt-hit", () => (m.getCanvas().style.cursor = "pointer"));
    m.on("mouseleave", "route-alt-hit", () => (m.getCanvas().style.cursor = ""));
  }

  _set(id, data) { this.data[id] = data; this.map.getSource(id)?.setData(data); }
  setRisk(riskById) { this._set("edges", edgesGeoJSON(this.network, riskById)); }
  setVisible(key, on) { this.visible[key] = on; this._applyVisibility(); }
  _applyVisibility() {
    const m = this.map; if (!m.getLayer("edge-road")) return;
    const hz = this.visible.hazard;
    const op = this.routeMode ? 0.35 : 0.85;
    m.setLayoutProperty("edge-road", "visibility", hz ? "visible" : "none");
    m.setPaintProperty("edge-road", "line-opacity", op);
    ["edge-rail", "edge-ferry"].forEach((l) => m.setLayoutProperty(l, "visibility", hz && this.visible.rail ? "visible" : "none"));
    m.setLayoutProperty("edge-blocked", "visibility", hz || this.routeMode ? "visible" : "none");
  }

  // Google-style route display: grey clickable alternatives, blue selected route, hazard-coloured stretches.
  showRoutes(routes, selected) {
    const alts = Object.entries(routes).filter(([k, r]) => k !== selected && !r.same_as && r.geometry?.length);
    this._set("routeAlt", { type: "FeatureCollection", features: alts.map(([k, r]) => line(r.geometry, { profile: k })) });
    const sel = routes[selected];
    this._set("route", sel ? { type: "FeatureCollection", features: [line(sel.geometry)] } : EMPTY);
    const risky = sel ? sel.legs.filter((l) => l.kind === "edge" && l.p >= 0.15 && l.coords?.length > 1)
      .map((l) => line(l.coords, { level: levelOf(l.p) })) : [];
    this._set("routeRisk", { type: "FeatureCollection", features: risky });
    this.routeMode = !!sel; this._applyVisibility();
  }
  clearRoutes() { ["routeAlt", "route", "routeRisk"].forEach((k) => this._set(k, EMPTY)); this.routeMode = false; this._applyVisibility(); }
  showTrail(trail, plan) {
    this._set("trail", trail?.length > 1 ? { type: "FeatureCollection", features: [line(trail.map((p) => [p[0], p[1]]))] } : EMPTY);
    this._set("plan", plan?.length > 1 ? { type: "FeatureCollection", features: [line(plan)] } : EMPTY);
  }
  clearTrail() { this._set("trail", EMPTY); this._set("plan", EMPTY); }
  fit(coords, pad = 70, maxZoom = 11) {
    if (!coords || !coords.length) return;
    const b = new maplibregl.LngLatBounds(coords[0], coords[0]);
    coords.forEach((c) => b.extend(c));
    this.map.fitBounds(b, { padding: pad, maxZoom, duration: 700 });
  }
}

// Route time bubble (like the travel-time labels on a maps app), placed on a route's own stretch.
export function bubblePoint(coords, others) {
  const key = (c) => `${c[0].toFixed(3)},${c[1].toFixed(3)}`;
  const shared = new Set(others.flat().map(key));
  const own = coords.filter((c) => !shared.has(key(c)));
  const arr = own.length > 2 ? own : coords;
  return arr[Math.floor(arr.length / 2)];
}

export function pinMarker(letter, color) {
  const el = h(`<div class="pin-marker" style="--pin:${color}"><span>${letter}</span></div>`);
  return new maplibregl.Marker({ element: el, anchor: "bottom" });
}

export function truckMarker() {
  const el = h(`<div class="truck-marker"><div class="truck-arrow"></div><div class="truck-dot">${TRUCK}</div><div class="truck-label"></div></div>`);
  return new maplibregl.Marker({ element: el, anchor: "center" });
}

export function toast(msg, err = false, ms = 4200) {
  const t = h(`<div class="toast ${err ? "err" : ""}" role="status">${msg}</div>`);
  document.body.appendChild(t);
  setTimeout(() => t.remove(), ms);
}

export function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0; return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

export function haversineKm(a, b) {
  const R = 6371, toR = Math.PI / 180;
  const dLat = (b[1] - a[1]) * toR, dLon = (b[0] - a[0]) * toR;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * toR) * Math.cos(b[1] * toR) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
