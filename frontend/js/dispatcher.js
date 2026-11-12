// NER-LogiSense dispatcher console: directions, live fleet, corridors, shipments, KPI replay, audit.
import {
  api, $, $$, h, esc, pct, hrs, ago, badge, levelOf, LEVEL_COLOR, LOGO, TRUCK, WARN_ICON,
  MapView, BASEMAPS, DEFAULT_BASEMAP, bubblePoint, pinMarker, truckMarker, toast, useLocalServer,
} from "./common.js";

// Browser-only build (no Python server): run the backend's JavaScript port inside this page.
const CFG = globalThis.NER_CONFIG || {};
if (CFG.local) {
  const { startLocalServer } = await import("./localserver.js");
  useLocalServer(startLocalServer(CFG.dataBase || "data/"));
}

const S = {
  network: null, nodes: {}, edges: {}, risk: {}, opt: null, selected: null,
  closures: new Set(), picking: false, incMarkers: [], tab: "dispatch", mv: null,
  bubbles: [], pins: [], trucks: {}, fleet: [], sim: null, selTruck: null, follow: false, showTrucks: true, showIncidents: true,
};
const store = { get: (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } } };

// ------------------------------------------------------------------------------------ boot
$("#brand").innerHTML = `${LOGO}<div>NER-LogiSense <small>Dispatcher</small></div>`;

async function boot() {
  const [network, weather, model] = await Promise.all([api("/network"), api("/weather"), api("/model")]);
  setNetwork(network);
  $("#model-chip").textContent = `${model.model_version} · AUC ${model.test.xgboost.auc}`;
  $("#model-chip").title = "Hold-out metrics on synthetic labels. See docs/MODEL.md";
  fillSelects(network, weather);
  renderFreshness(weather.freshness);
  initMap();
  bindUI();
  startFleetStream();
  watchRoads();
}

function setNetwork(network) {
  S.network = network; S.nodes = {}; S.edges = {};
  network.nodes.forEach((n) => (S.nodes[n.id] = n));
  network.edges.forEach((e) => (S.edges[e.id] = e));
}

function fillSelects(network, weather) {
  const byState = {};
  network.road_nodes.map((id) => S.nodes[id]).forEach((n) => (byState[n.state] ||= []).push(n));
  const opts = Object.keys(byState).sort().map((st) =>
    `<optgroup label="${esc(st)}">${byState[st].sort((a, b) => (b.kind === "hub") - (a.kind === "hub") || a.name.localeCompare(b.name))
      .map((n) => `<option value="${n.id}">${esc(n.name)}${n.kind === "hub" ? " ●" : ""}</option>`).join("")}</optgroup>`).join("");
  $("#f-origin").innerHTML = opts; $("#f-dest").innerHTML = opts;
  $("#f-origin").value = "SLG"; $("#f-dest").value = "GTK";
  const cargo = Object.entries(network.cargo).map(([k, v]) => `<option value="${k}">${esc(v.label)}</option>`).join("");
  $("#f-cargo").innerHTML = cargo; $("#k-cargo").innerHTML = cargo;
  $("#f-cargo").value = "pharma";
  $("#f-deadline").value = 10;
  updateTemp();
  const sc = weather.scenarios.map((s) => `<option value="${s.id}">${esc(s.label)}</option>`).join("");
  $("#scenario").innerHTML = sc + `<option value="live" disabled>Live rainfall (Open-Meteo)</option>`;
  $("#scenario").value = weather.freshness.scenario;
  $("#k-scenario").innerHTML = `<option value="current">Current map input</option>` + sc;
}

function updateTemp() {
  const c = S.network.cargo[$("#f-cargo").value];
  $("#f-temp").textContent = c.temp_range ? `Cold chain ${c.temp_range} · max ${c.max_transit_h} h` : "";
}

function renderFreshness(f) {
  const el = $("#freshness");
  el.className = "chip hide-sm " + (f.source === "open-meteo" ? "live" : "warn");
  el.querySelector("span:last-child").textContent =
    f.source === "open-meteo" ? `Live rainfall · ${f.age_min < 1 ? "just now" : Math.round(f.age_min) + " min old"}` : "Scenario rainfall";
  el.title = (f.source === "open-meteo" ? "Observed + forecast rainfall from Open-Meteo" : `Replayable scenario: ${f.label}`) + (f.error ? ` · last live fetch failed: ${f.error}` : "");
  if (f.source === "open-meteo") {
    $("#scenario").querySelector('option[value="live"]').disabled = false;
    $("#scenario").value = "live";
  }
}

// ------------------------------------------------------------------------------------ map
function initMap() {
  const saved = store.get("ner-basemap", DEFAULT_BASEMAP);
  const basemap = BASEMAPS[saved] ? saved : DEFAULT_BASEMAP;
  S.mv = new MapView("map", S.network, {
    basemap,
    onEdgeClick: (id) => (S.picking ? toggleClosure(id) : openEdge(id)),
    onRouteClick: (profile) => { if (S.opt?.routes[profile]) { S.selected = profile; renderResults(false); } },
  });
  $("#basemaps").innerHTML = Object.entries(BASEMAPS).map(([k, b]) =>
    `<button type="button" data-bm="${k}" class="${k === basemap ? "on" : ""}"><i style="background:${b.swatch}"></i>${b.label}</button>`).join("");
  let first = true;
  S.mv.map.on("overlays.ready", async () => {
    S.mv.setRisk(S.risk);
    if (!S.mv.basemapOk) mapStatus("Online map tiles unreachable: showing the built-in map (national highways, railways, towns).", 9000);
    if (!first) return;
    first = false;
    await refreshRisk(); refreshIncidents();
    optimize();
    setInterval(async () => {
      try {
        await refreshRisk(); await refreshIncidents();
        if (S.tab === "corridors") await loadCorridors();
      } catch {
        const el = $("#freshness"); el.className = "chip hide-sm warn";
        el.querySelector("span:last-child").textContent = "Server unreachable, retrying";
      }
    }, 15000);
  });
}

let statusTimer = null;
function mapStatus(text, ms = 0) {
  const el = $("#map-status");
  if (!text) { el.classList.add("hidden"); return; }
  el.innerHTML = text; el.classList.remove("hidden");
  clearTimeout(statusTimer);
  if (ms) statusTimer = setTimeout(() => el.classList.add("hidden"), ms);
}

// Real road shapes arrive from OSRM in the background on first start; reload the network when done.
async function watchRoads() {
  if (CFG.local) return;
  let lastCount = S.network.edges.filter((e) => e.geometry_source === "osrm").length;
  for (;;) {
    let st;
    try { st = await api("/roads/status"); } catch { return; }
    if (st.with_road_geometry !== lastCount) {
      lastCount = st.with_road_geometry;
      setNetwork(await api("/network"));
      S.mv.network = S.network; S.mv.setRisk(S.risk);
      if (S.opt && !st.running) optimize();
    }
    if (st.running) mapStatus(`<span class="spinner" style="border-color:rgba(31,111,224,.3);border-top-color:var(--accent);display:inline-block;vertical-align:-2px"></span> Loading real road shapes from OpenStreetMap: ${st.with_road_geometry + st.rejected}/${st.total}`);
    else {
      if (st.pending && st.error && st.with_road_geometry === 0) mapStatus("Road shapes unavailable (no internet?): corridors drawn as straight links.", 8000);
      else mapStatus("");
      return;
    }
    await new Promise((r) => setTimeout(r, 4000));
  }
}

async function refreshRisk() {
  const r = await api("/risk/edges");
  S.risk = Object.fromEntries(r.edges.map((e) => [e.edge_id, e]));
  S.mv.setRisk(S.risk);
  renderFreshness(r.data_freshness);
  const blocked = r.edges.filter((e) => e.status === "blocked").length;
  const bc = $("#blocked-count"); bc.textContent = blocked; bc.classList.toggle("hidden", !blocked);
}

async function refreshIncidents() {
  const inc = await api("/incidents?hours=12");
  S.incMarkers.forEach((m) => m.remove());
  if (!S.showIncidents) { S.incMarkers = []; return; }
  S.incMarkers = inc.filter((i) => i.type !== "clear" && i.lat != null).map((i) => {
    const el = h(`<div title="${esc(i.type)} · ${esc(i.device_id)} · ${ago(i.time_start)}${i.verified ? " · verified" : ""}">${WARN_ICON(i.verified ? "#d12f2f" : "#e8a200")}</div>`);
    el.addEventListener("click", (ev) => { ev.stopPropagation(); if (i.edge_id) openEdge(i.edge_id); });
    return new maplibregl.Marker({ element: el }).setLngLat([i.lon, i.lat]).addTo(S.mv.map);
  });
}

// ------------------------------------------------------------------------------------ live fleet
function startFleetStream() {
  let polling = null;
  if (CFG.local) {        // in-page server: poll it once a second
    setInterval(() => api("/fleet").then((d) => { S.fleet = d.vehicles; S.sim = d.sim; updateTrucks(); if (S.tab === "fleet") renderFleet(); }).catch(() => {}), 1000);
    return;
  }
  const onData = (d) => { S.fleet = d.vehicles; S.sim = d.sim; updateTrucks(); if (S.tab === "fleet") renderFleet(); };
  const poll = () => { if (!polling) polling = setInterval(() => api("/fleet").then(onData).catch(() => {}), 3000); };
  if (!("EventSource" in window)) return poll();
  const es = new EventSource("/stream/fleet");
  es.onmessage = (ev) => { try { onData(JSON.parse(ev.data)); } catch { /* ignore */ } };
  es.onerror = () => { if (es.readyState === EventSource.CLOSED) poll(); };
}

function updateTrucks() {
  const seen = new Set();
  for (const v of S.fleet) {
    if (v.lat == null) continue;
    seen.add(v.vehicle_id);
    let m = S.trucks[v.vehicle_id];
    if (!m) {
      m = truckMarker(); m.setLngLat([v.lon, v.lat]);
      if (S.showTrucks) m.addTo(S.mv.map);
      m.getElement().addEventListener("click", (ev) => { ev.stopPropagation(); selectTruck(v.vehicle_id); });
      S.trucks[v.vehicle_id] = m;
    }
    m.setLngLat([v.lon, v.lat]);
    const el = m.getElement();
    // keep MapLibre's own marker classes; only toggle ours
    for (const st of ["moving", "holding", "loading", "arrived", "stopped"]) el.classList.toggle(st, v.status === st);
    el.classList.toggle("gps", v.source !== "sim");
    el.classList.toggle("sel", S.selTruck === v.vehicle_id);
    el.style.setProperty("--hdg", `${v.heading}deg`);
    el.querySelector(".truck-label").textContent = `${v.vehicle_id}${v.status === "holding" ? " · holding" : ""}`;
    el.title = `${v.vehicle_id} · ${v.origin_name || ""} → ${v.destination_name || ""} · ${v.status}`;
    if (S.selTruck === v.vehicle_id) {
      if (S.follow) S.mv.map.easeTo({ center: [v.lon, v.lat], duration: 900 });
      renderTruckCard(v);
    }
  }
  for (const [id, m] of Object.entries(S.trucks)) if (!seen.has(id)) { m.remove(); delete S.trucks[id]; }
}

const STATUS_LABEL = { moving: "Moving", holding: "Holding", loading: "Loading / transfer", arrived: "Arrived", stopped: "Stopped" };

function renderFleet() {
  const vs = [...S.fleet].sort((a, b) => (a.status === "holding" ? -1 : 0) - (b.status === "holding" ? -1 : 0) || a.vehicle_id.localeCompare(b.vehicle_id));
  const count = (st) => vs.filter((v) => v.status === st).length;
  $("#fleet-summary").innerHTML = ["moving", "holding", "loading", "arrived"].map((st) =>
    `<span class="status-pill st-${st}">${count(st)} ${STATUS_LABEL[st].toLowerCase()}</span>`).join("");
  $("#fleet-updated").textContent = `updated ${new Date().toLocaleTimeString()}`;
  if (S.sim) {
    $$("#sim-speed button").forEach((b) => b.classList.toggle("on", +b.dataset.speed === S.sim.speedup));
    $("#sim-pause").textContent = S.sim.running ? "Pause" : "Resume";
  }
  $("#fleet-list").innerHTML = vs.length ? vs.map((v) => {
    const hz = v.next_hazard;
    return `<div class="truck-row st-${v.status} ${S.selTruck === v.vehicle_id ? "sel" : ""}" data-truck="${esc(v.vehicle_id)}">
      <div class="truck-ico">${TRUCK}</div>
      <div><b>${esc(v.vehicle_id)}</b> <span class="small dim">${esc(v.origin_name || "")} → ${esc(v.destination_name || "")}</span>
        <div class="tiny muted">${esc(v.cargo_type || "")} · ${esc(v.current || "")}${v.source !== "sim" ? ` · <b>${esc(v.source)}</b> position` : ""}</div>
        ${v.progress != null ? `<div class="meter" style="margin-top:5px"><i style="width:${Math.max(2, v.progress * 100)}%;background:var(--st)"></i></div>` : ""}
        ${hz ? `<div class="tiny" style="margin-top:4px">${hz.blocked ? badge("blocked") : badge(levelOf(hz.p), pct(hz.p))} ahead in ${hz.in_km} km: ${esc(hz.name)}</div>` : ""}
      </div>
      <div style="text-align:right"><span class="status-pill">${STATUS_LABEL[v.status] || v.status}</span>
        <div class="small num" style="margin-top:4px">${v.eta_h != null ? `ETA ${hrs(v.eta_h)}` : ""}</div>
        <div class="tiny muted num">${Math.round(v.speed_kmh || 0)} km/h</div></div>
    </div>`;
  }).join("") : `<div class="empty">No vehicles yet. Approve a route in Directions.</div>`;
  $$("#fleet-list [data-truck]").forEach((r) => r.addEventListener("click", () => selectTruck(r.dataset.truck)));
}

let truckTimer = null;
async function selectTruck(id) {
  S.selTruck = id; S.follow = true;
  switchTab("fleet");
  const load = async () => {
    if (S.selTruck !== id) return;
    try { const d = await api(`/fleet/${encodeURIComponent(id)}`); S.mv.showTrail(d.trail, d.route); return d; } catch { return null; }
  };
  const d = await load();
  clearInterval(truckTimer); truckTimer = setInterval(load, 3000);
  if (d?.lat != null) S.mv.map.flyTo({ center: [d.lon, d.lat], zoom: Math.max(S.mv.map.getZoom(), 9), duration: 900 });
  const v = S.fleet.find((x) => x.vehicle_id === id) || d;
  if (v) renderTruckCard(v);
  updateTrucks();
}
function deselectTruck() {
  S.selTruck = null; S.follow = false; clearInterval(truckTimer); S.mv.clearTrail();
  $("#drawer").classList.add("hidden"); updateTrucks();
}

function renderTruckCard(v) {
  const dr = $("#drawer");
  if (dr.dataset.kind === "truck" && dr.dataset.id === v.vehicle_id && !dr.classList.contains("hidden")) {
    // update the live numbers only
    dr.querySelector("[data-f=status]").innerHTML = `<span class="status-pill st-${v.status}">${STATUS_LABEL[v.status] || v.status}</span>`;
    dr.querySelector("[data-f=speed]").textContent = `${Math.round(v.speed_kmh || 0)} km/h`;
    dr.querySelector("[data-f=eta]").textContent = v.eta_h != null ? hrs(v.eta_h) : "–";
    dr.querySelector("[data-f=prog]").style.width = `${Math.max(2, (v.progress || 0) * 100)}%`;
    dr.querySelector("[data-f=now]").textContent = v.current || "–";
    dr.querySelector("[data-f=hold]").textContent = v.hold_reason || "";
    dr.querySelector("[data-f=hz]").innerHTML = hazardLine(v);
    return;
  }
  dr.dataset.kind = "truck"; dr.dataset.id = v.vehicle_id;
  dr.innerHTML = `
    <button class="btn small ghost close" id="dr-close" aria-label="Close" type="button">✕</button>
    <div class="stack">
      <div class="row" style="padding-right:30px"><div class="truck-ico st-${v.status}">${TRUCK}</div>
        <div><h2>${esc(v.vehicle_id)}</h2><div class="small dim">${esc(v.origin_name || "")} → ${esc(v.destination_name || "")} · ${esc(v.cargo_type || "")}</div></div></div>
      <div class="row between"><span data-f="status"><span class="status-pill st-${v.status}">${STATUS_LABEL[v.status] || v.status}</span></span>
        <span class="tiny muted">${v.source === "sim" ? "simulated position" : `live position (${esc(v.source)})`}</span></div>
      <div class="meter"><i data-f="prog" style="width:${Math.max(2, (v.progress || 0) * 100)}%;background:var(--accent)"></i></div>
      <div class="kv">
        <div><b data-f="eta">${v.eta_h != null ? hrs(v.eta_h) : "–"}</b><span>ETA incl. expected delay</span></div>
        <div><b data-f="speed">${Math.round(v.speed_kmh || 0)} km/h</b><span>Speed</span></div>
      </div>
      <div class="small"><span class="muted">Now:</span> <span data-f="now">${esc(v.current || "–")}</span></div>
      <div class="small" style="color:var(--critical)" data-f="hold">${esc(v.hold_reason || "")}</div>
      <div class="small" data-f="hz">${hazardLine(v)}</div>
      <div class="row">
        <button class="btn small ${S.follow ? "on" : ""}" id="tr-follow" type="button">${S.follow ? "Following" : "Follow"}</button>
        ${v.shipment_id ? `<button class="btn small" id="tr-replan" type="button">Re-plan this shipment</button>` : ""}
      </div>
      <div class="tiny muted">Dashed line: where the truck has been. Faint blue: its approved route. ETA uses the simulator clock (${S.sim?.speedup ?? "–"}× real time).</div>
    </div>`;
  dr.classList.remove("hidden");
  $("#dr-close").onclick = deselectTruck;
  $("#tr-follow").onclick = () => { S.follow = !S.follow; $("#tr-follow").classList.toggle("on", S.follow); $("#tr-follow").textContent = S.follow ? "Following" : "Follow"; };
  $("#tr-replan")?.addEventListener("click", async () => {
    const list = await api("/shipments"); const s = list.find((x) => x.shipment_id === v.shipment_id);
    if (!s) return;
    deselectTruck();
    $("#f-origin").value = s.origin; $("#f-dest").value = s.destination; $("#f-cargo").value = s.cargo_type;
    $("#f-priority").value = s.priority; updateTemp(); switchTab("dispatch"); optimize();
  });
}
function hazardLine(v) {
  const hz = v.next_hazard;
  if (!hz) return `<span class="muted">No high-risk or blocked segment ahead.</span>`;
  return `${hz.blocked ? badge("blocked") : badge(levelOf(hz.p), pct(hz.p))} <b>${esc(hz.name)}</b> <span class="muted">(${esc(hz.route_ref || "")}) in ${hz.in_km} km</span>`;
}

// ------------------------------------------------------------------------------------ UI bindings
function bindUI() {
  $$(".tab").forEach((t) => t.addEventListener("click", () => switchTab(t.dataset.tab)));
  $("#btn-optimize").addEventListener("click", optimize);
  $("#btn-swap").addEventListener("click", () => { const o = $("#f-origin").value; $("#f-origin").value = $("#f-dest").value; $("#f-dest").value = o; optimize(); });
  $("#f-cargo").addEventListener("change", updateTemp);
  $("#scenario").addEventListener("change", async (e) => {
    if (e.target.value === "live") return;
    const w = await api("/weather/scenario", { method: "POST", body: { scenario: e.target.value } });
    $("#scenario").querySelector('option[value="live"]').disabled = true;
    renderFreshness(w.freshness);
    await refreshRisk();
    toast(`Rainfall input: <b>${esc(w.freshness.label)}</b>. Hazard scores updated.`);
    if (S.opt) optimize();
    if (S.tab === "corridors") loadCorridors();
    if (S.tab === "shipments") loadShipments();
  });
  $("#btn-live").addEventListener("click", async () => {
    const b = $("#btn-live"); b.disabled = true; b.innerHTML = `<span class="spinner" style="border-color:rgba(0,0,0,.2);border-top-color:var(--accent)"></span> Fetching`;
    try {
      const w = await api("/weather/live", { method: "POST" });
      renderFreshness(w.freshness); await refreshRisk(); if (S.opt) optimize();
      toast("Live rainfall loaded from Open-Meteo for 17 met zones.");
    } catch (err) {
      toast(`Live rainfall unavailable (${esc(err.data?.freshness?.error || err.message)}). Still using scenario data.`, true, 7000);
    } finally { b.disabled = false; b.textContent = "Live rainfall"; }
  });
  $("#btn-layers").addEventListener("click", () => {
    const pop = $("#layers-pop"); pop.classList.toggle("hidden");
    $("#btn-layers").setAttribute("aria-expanded", String(!pop.classList.contains("hidden")));
  });
  $("#basemaps").addEventListener("click", (e) => {
    const b = e.target.closest("[data-bm]"); if (!b) return;
    $$("#basemaps button").forEach((x) => x.classList.toggle("on", x === b));
    store.set("ner-basemap", b.dataset.bm); S.mv.setBasemap(b.dataset.bm);
  });
  $("#ly-hazard").addEventListener("change", (e) => S.mv.setVisible("hazard", e.target.checked));
  $("#ly-rail").addEventListener("change", (e) => S.mv.setVisible("rail", e.target.checked));
  $("#ly-trucks").addEventListener("change", (e) => {
    S.showTrucks = e.target.checked;
    Object.values(S.trucks).forEach((m) => (S.showTrucks ? m.addTo(S.mv.map) : m.remove()));
  });
  $("#ly-incidents").addEventListener("change", (e) => { S.showIncidents = e.target.checked; refreshIncidents(); });
  $$("#sim-speed button").forEach((b) => b.addEventListener("click", async () => {
    S.sim = await api("/fleet/sim", { method: "POST", body: { speedup: +b.dataset.speed } }); renderFleet();
  }));
  $("#sim-pause").addEventListener("click", async () => {
    S.sim = await api("/fleet/sim", { method: "POST", body: { running: !(S.sim?.running ?? true) } }); renderFleet();
  });
  $("#btn-phones")?.addEventListener("click", () => ($("#dock").classList.contains("hidden") ? openPhones() : closePhones()));
  $("#dock-close")?.addEventListener("click", closePhones);
  $("#btn-ship-refresh").addEventListener("click", loadShipments);
  $("#btn-audit").addEventListener("click", loadAudit);
  $("#btn-kpi").addEventListener("click", runKpi);
  $("#k-pick").addEventListener("click", () => setPicking(!S.picking));
  $("#pick-done").addEventListener("click", (e) => { e.preventDefault(); setPicking(false); });
}

// ------------------------------------------------------------------------------------ driver phones (browser-only build)
let phones = null;
async function openPhones(vehicle) {
  const dock = $("#dock"); if (!dock) return;
  const { Phone } = await import("./phones.js");
  dock.classList.remove("hidden");
  if (!phones) phones = [new Phone($("#phone-a"), S.network, vehicle || "TRK-WB07", 0), new Phone($("#phone-b"), S.network, "TRK-DEMO2", 1)];
  else { phones.forEach((p) => p.resize()); if (vehicle && phones[0].device !== vehicle) phones[0].setDevice(vehicle); }
  phones.forEach((p) => p.refreshVehicleList());
  $("#btn-phones").classList.add("on");
}
function closePhones() { $("#dock").classList.add("hidden"); $("#btn-phones").classList.remove("on"); }

function switchTab(tab) {
  S.tab = tab;
  $$(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === tab));
  $$("[data-panel]").forEach((p) => p.classList.toggle("hidden", p.dataset.panel !== tab));
  if (tab === "corridors") loadCorridors();
  if (tab === "shipments") loadShipments();
  if (tab === "audit") loadAudit();
  if (tab === "fleet") renderFleet();
  if (tab === "dispatch" && S.opt) renderResults(false);
  else clearRouteDisplay();
  if (tab !== "fleet" && S.selTruck) deselectTruck();
}

// ------------------------------------------------------------------------------------ directions
async function optimize() {
  const body = {
    origin: $("#f-origin").value, destination: $("#f-dest").value, cargo_type: $("#f-cargo").value,
    priority: $("#f-priority").value, deadline_h: +$("#f-deadline").value || null,
    modes: ["road", ...($("#m-rail").checked ? ["rail"] : []), ...($("#m-ferry").checked ? ["ferry"] : [])],
  };
  if (body.origin === body.destination) return toast("Origin and destination are the same.", true);
  const btn = $("#btn-optimize"); btn.disabled = true; btn.innerHTML = `<span class="spinner"></span> Scoring routes`;
  try {
    S.opt = await api("/route/optimize", { method: "POST", body });
    S.selected = S.opt.recommended;
    if (S.tab === "dispatch") renderResults(true);
  } catch (err) {
    $("#results").innerHTML = `<div class="banner warn">${esc(err.message)}</div>`;
    clearRouteDisplay();
  } finally { btn.disabled = false; btn.textContent = "Find routes"; }
}

const COST_KEYS = [
  ["travel_time", "Travel time", "var(--series-1)"],
  ["risk_penalty", "Risk", "var(--series-2)"],
  ["perishability_penalty", "Perishability", "var(--series-3)"],
  ["reliability_penalty", "Reliability", "var(--series-4)"],
];

function via(route) {
  const km = {};
  for (const l of route.legs) if (l.kind === "edge") km[l.route_ref] = (km[l.route_ref] || 0) + l.length_km;
  return Object.entries(km).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([r]) => r).join(", ");
}

function renderResults(fit) {
  const o = S.opt;
  const rec = o.routes[o.recommended];
  const cmp = o.comparison;
  const maxCost = Math.max(...Object.values(o.routes).map((r) => r.metrics.total_cost));
  const order = [o.recommended, ...["fastest", "balanced", "safest", "emergency"].filter((k) => k !== o.recommended)].filter((k) => o.routes[k]);
  const rows = order.map((k) => {
    const r = o.routes[k]; const m = r.metrics;
    const lvl = levelOf(m.max_edge_p);
    const lateCls = m.p_late == null ? "" : m.p_late < 0.2 ? "good" : m.p_late > 0.5 ? "bad" : "";
    const bar = COST_KEYS.map(([key, , col]) => {
      const w = (m.cost_breakdown[key] / maxCost) * 100;
      return w > 0.2 ? `<i style="width:${w}%;background:${col}" title="${key.replace("_", " ")}: ${m.cost_breakdown[key]} h"></i>` : "";
    }).join("");
    const extras = [`P90 ${hrs(m.eta_p90_h)}`, `worst segment ${pct(m.max_edge_p)}`];
    if (m.p_late != null) extras.push(`P(late) ${pct(m.p_late)}`);
    if (m.p_cold_chain_breach != null) extras.push(`cold-chain risk ${pct(m.p_cold_chain_breach)}`);
    return `<div class="card select ${k === S.selected ? "selected" : ""}" data-profile="${k}">
      <div class="route-row">
        <div><b>${esc(r.label)}</b> ${k === o.recommended ? `<span class="badge rec-badge">Recommended</span>` : ""}
          <div class="small dim">via ${esc(via(r))} · ${m.distance_km} km${m.modes.includes("rail") ? " · uses rail" : ""}${r.same_as ? ` · same path as ${esc(o.routes[r.same_as].label)}` : ""}</div></div>
        <div class="eta ${lateCls}" title="Expected arrival including expected blockage delay">${hrs(m.eta_expected_h)}</div>
        <div class="tiny muted">${extras.join(" · ")}</div>
        <div>${badge(lvl, lvl === "low" ? "Low risk" : `${LEVEL_LABEL_SHORT[lvl]} risk`)}</div>
      </div>
      <div class="costbar" aria-label="cost breakdown">${bar}</div>
      ${r.note ? `<div class="tiny muted" style="margin-top:6px">${esc(r.note)}</div>` : ""}
    </div>`;
  }).join("");

  const nDistinct = Object.values(o.routes).filter((x) => !x.same_as).length;
  const cmpLine = cmp && cmp.avoided.length ? `Avoids <b>${cmp.avoided.map(esc).join("</b>, <b>")}</b>. ${cmp.extra_travel_h >= 0 ? "+" : ""}${hrs(cmp.extra_travel_h)} driving, saves ${hrs(cmp.delay_saved_h)} of expected blockage delay vs Fastest.`
    : cmp ? `vs Fastest: ${cmp.extra_travel_h >= 0 ? "+" : ""}${hrs(cmp.extra_travel_h)} driving, ${hrs(cmp.delay_saved_h)} less expected delay, P90 ${hrs(cmp.p90_saved_h)} earlier.` : "";

  $("#results").innerHTML = `
    <div class="banner">
      <div class="row between"><b>Recommended: ${esc(rec.label)}</b><span class="tiny muted num">${o.latency_ms} ms · ${esc(o.model_version)}</span></div>
      <div class="small" style="margin-top:4px">${esc(o.recommendation_reason)} ${cmpLine}</div>
    </div>
    ${nDistinct === 1 ? `<div class="banner" style="margin:0"><span class="small">Only one practical route between ${esc(S.nodes[o.origin].name)} and ${esc(S.nodes[o.destination].name)} with these modes: every other path is more than twice as long, so all four options use it.</span></div>` : ""}
    <div class="routes">${rows}</div>
    <div class="legend">${COST_KEYS.map(([, l, c]) => `<span><i style="background:${c}"></i>${l}</span>`).join("")}<span class="muted">route cost (h-equivalent)</span></div>
    <div id="sel-detail" class="stack"></div>
    <div class="stack">
      <h3>Explained alerts (${o.alerts.length})</h3>
      ${o.alerts.length ? o.alerts.map(alertHTML).join("") : `<div class="small muted">No segment on any candidate route is above 15% hazard.</div>`}
    </div>`;
  $$("#results [data-profile]").forEach((c) => c.addEventListener("click", () => { S.selected = c.dataset.profile; renderResults(false); }));
  $$("#results [data-edge]").forEach((c) => c.addEventListener("click", () => openEdge(c.dataset.edge)));
  showSelected(fit);
}
const LEVEL_LABEL_SHORT = { elevated: "Elevated", medium: "Medium", high: "High", blocked: "Blocked" };

function alertHTML(a) {
  return `<div class="alert ${a.level}" data-edge="${a.edge_id}" style="cursor:pointer">
    <div class="row between"><b class="small">${esc(a.name)}</b>${badge(a.level, pct(a.p_at_arrival))}</div>
    <div class="small">${esc(a.headline)}</div>
    <ul>${a.reasons.map((r) => `<li>${esc(r)}</li>`).join("")}</ul>
    <div class="row between" style="margin-top:6px">
      <span class="conf">Confidence ${esc(a.confidence.label)} (${a.confidence.score}) · ${esc(a.confidence.basis)}</span>
      <span class="tiny muted">on ${a.on_profiles.join(", ")} · reached ~${hrs(a.enter_h)}</span>
    </div>
    ${a.note ? `<div class="tiny muted" style="margin-top:3px">${esc(a.note)}</div>` : ""}
  </div>`;
}

function clearRouteDisplay() {
  S.mv?.clearRoutes();
  S.bubbles.forEach((b) => b.remove()); S.bubbles = [];
  S.pins.forEach((p) => p.remove()); S.pins = [];
}

function showSelected(fit) {
  const o = S.opt; if (!o) return;
  const r = o.routes[S.selected];
  clearRouteDisplay();
  S.mv.showRoutes(o.routes, S.selected);
  // travel-time bubbles on each distinct route, like a maps app
  const distinct = Object.entries(o.routes).filter(([, x]) => !x.same_as);
  for (const [k, x] of distinct) {
    const others = distinct.filter(([j]) => j !== k).map(([, y]) => y.geometry);
    const pt = bubblePoint(x.geometry, others);
    if (!pt) continue;
    const el = h(`<div class="route-bubble ${k === S.selected ? "sel" : ""}"><b>${hrs(x.metrics.eta_expected_h)}</b><span class="risk">${esc(x.label)} · worst ${pct(x.metrics.max_edge_p)}</span></div>`);
    el.addEventListener("click", (ev) => { ev.stopPropagation(); S.selected = k; renderResults(false); });
    S.bubbles.push(new maplibregl.Marker({ element: el, anchor: "bottom", offset: [0, -6] }).setLngLat(pt).addTo(S.mv.map));
  }
  const oN = S.nodes[o.origin], dN = S.nodes[o.destination];
  S.pins.push(pinMarker("A", "#1e9e4a").setLngLat([oN.lon, oN.lat]).addTo(S.mv.map));
  S.pins.push(pinMarker("B", "#d12f2f").setLngLat([dN.lon, dN.lat]).addTo(S.mv.map));
  if (fit) S.mv.fit(distinct.flatMap(([, x]) => x.geometry), { top: 80, bottom: 60, left: 60, right: 60 });
  const isRec = S.selected === o.recommended;
  const legs = r.legs.map((l) => {
    if (l.kind === "transfer") return `<li><span class="pin" style="background:var(--rail)"></span><span class="transfer">Transfer ${esc(l.mode)} at ${esc(l.at_name)}</span><span class="num dim">${hrs(l.t_h)}</span></li>`;
    const lvl = levelOf(l.p, S.risk[l.edge_id]?.status);
    return `<li class="clickable" data-edge="${l.edge_id}"><span class="pin" style="background:${LEVEL_COLOR[lvl]}"></span>
      <span>${esc(l.frm_name)} → ${esc(l.to_name)} <span class="tiny muted">${esc(l.route_ref)} · ${l.length_km} km${l.mode !== "road" ? " · " + l.mode : ""}${l.no_network ? " · no signal" : ""}</span></span>
      <span class="num dim">${l.p >= 0.15 ? badge(lvl, pct(l.p)) + " " : ""}${hrs(l.t_h)}</span></li>`;
  }).join("");
  const m = r.metrics;
  $("#sel-detail").innerHTML = `
    <div class="card">
      <div class="row between"><h4>${esc(r.label)} · ${m.distance_km} km</h4><span class="tiny muted">${esc(r.route_id)}</span></div>
      <p class="small dim" style="margin:4px 0 8px">${esc(r.description)}</p>
      <div class="small dim num">Travel ${hrs(m.cost_breakdown.travel_time)} + risk ${hrs(m.cost_breakdown.risk_penalty)} + perishability ${hrs(m.cost_breakdown.perishability_penalty)} + reliability ${hrs(m.cost_breakdown.reliability_penalty)} = <b style="color:var(--text)">${hrs(m.total_cost)}</b> cost</div>
      <ul class="legs" style="margin-top:8px">${legs}</ul>
    </div>
    <div class="card stack">
      <div class="row between"><h4>Approve & dispatch</h4><span class="tiny muted">human decision</span></div>
      <div class="grid2">
        <label class="field"><span>Vehicle ID</span><input type="text" id="a-vehicle" placeholder="auto (TRK-xxxx)"></label>
        <label class="field"><span>Approved by</span><input type="text" id="a-actor" value="dispatcher"></label>
      </div>
      ${isRec ? "" : `<label class="field"><span>Override reason (required: this is not the recommended route)</span><textarea id="a-reason" rows="2" placeholder="e.g. convoy escort available on NH10"></textarea></label>`}
      <button class="btn ${isRec ? "primary" : "danger"}" id="btn-approve" type="button">Approve ${esc(r.label)} route</button>
      <div class="tiny muted">After approval a simulated truck starts driving this route; watch it under Live fleet.</div>
    </div>`;
  $$("#sel-detail [data-edge]").forEach((c) => c.addEventListener("click", () => openEdge(c.dataset.edge)));
  $("#btn-approve").addEventListener("click", approve);
}

async function approve() {
  const r = S.opt.routes[S.selected];
  try {
    const res = await api(`/route/${r.route_id}/approve`, { method: "POST", body: {
      actor: $("#a-actor").value || "dispatcher", vehicle_id: $("#a-vehicle").value.trim() || null,
      override_reason: $("#a-reason")?.value.trim() || null } });
    const driverLink = CFG.local ? `<a href="#" id="toast-phone">show on a driver phone</a>` : `<a href="/driver?vehicle=${encodeURIComponent(res.vehicle_id)}" target="_blank">driver app ↗</a>`;
    toast(`Approved: shipment <b>${res.shipment_id}</b> assigned to <b>${res.vehicle_id}</b>. <a href="#" id="toast-track">Track it live</a> · ${driverLink}`, false, 9000);
    $("#toast-track")?.addEventListener("click", (e) => { e.preventDefault(); selectTruck(res.vehicle_id); });
    $("#toast-phone")?.addEventListener("click", (e) => { e.preventDefault(); openPhones(res.vehicle_id); });
    S.opt = null; $("#results").innerHTML = ""; clearRouteDisplay();
  } catch (err) { toast(esc(err.message), true); }
}

// ------------------------------------------------------------------------------------ edge drawer
async function openEdge(id) {
  const d = await api(`/risk/edge/${id}`);
  const e = d.edge; const ex = d.explanation;
  const maxAbs = Math.max(0.5, ...ex.factors.map((f) => Math.abs(f.logodds)));
  const factors = ex.factors.filter((f) => Math.abs(f.logodds) >= 0.02).map((f) => {
    const w = (Math.abs(f.logodds) / maxAbs) * 100;
    return `<div class="factor" title="${esc(f.detail || "")}"><span>${esc(f.label)}</span>
      <span class="track"><span class="fill ${f.logodds < 0 ? "neg" : ""}" style="width:${w}%"></span></span>
      <span class="num small dim" style="text-align:right">${f.logodds > 0 ? "+" : ""}${f.logodds.toFixed(2)}</span></div>`;
  }).join("");
  const blocked = d.status === "blocked";
  const dr = $("#drawer");
  dr.dataset.kind = "edge"; dr.dataset.id = id;
  dr.innerHTML = `
    <button class="btn small ghost close" id="dr-close" aria-label="Close" type="button">✕</button>
    <div class="stack">
      <div>
        <div class="tiny muted">${esc(e.route_ref)} · ${esc(e.mode)} · ${esc(e.id)}</div>
        <h2 style="padding-right:30px">${esc(e.source_name)} – ${esc(e.target_name)}</h2>
        ${e.note ? `<div class="small dim">${esc(e.note)}</div>` : ""}
      </div>
      <div class="row between">
        <div><div class="tiny muted">H(e, now)</div><div style="font-size:28px;font-weight:650" class="num">${pct(d.p_now)}</div></div>
        <div style="text-align:right">${badge(d.level)}<div class="conf" style="margin-top:4px">Confidence ${esc(ex.confidence.label)} · ${esc(ex.confidence.basis)}</div></div>
      </div>
      <div><h3>Forecast H(e, t+h)</h3>${forecastChart(d.forecast)}</div>
      <div><h3>Why: factor contributions (log-odds)</h3>
        <div class="tiny muted" style="margin:2px 0 6px">Positive values push the blockage probability up; TreeSHAP values from the XGBoost model.</div>
        ${factors}
        <ul class="small dim" style="padding-left:18px;margin:6px 0 0">${ex.reasons.map((r) => `<li>${esc(r)}</li>`).join("")}</ul>
      </div>
      <table class="t">
        <tr><td class="muted">Length / base time</td><td>${e.length_km} km · ${hrs(e.base_time_h)}</td></tr>
        <tr><td class="muted">Slope / elevation</td><td>${e.slope_deg}° · ${e.elevation_m} m</td></tr>
        <tr><td class="muted">Landslide history</td><td>${e.landslide_hist} mapped within 1 km</td></tr>
        <tr><td class="muted">River</td><td>${esc(e.river || "–")}</td></tr>
        <tr><td class="muted">Cellular coverage</td><td>${e.no_network ? "No-network stretch" : "Covered"}</td></tr>
        <tr><td class="muted">Rain 24 h / 72 h / next 24 h</td><td class="num">${d.rain.rain_24h.toFixed(0)} / ${d.rain.rain_72h.toFixed(0)} / ${d.rain.fcst_24h.toFixed(0)} mm</td></tr>
        <tr><td class="muted">If blocked: clearance wait</td><td>${hrs(d.delay_if_blocked_h)}${S.edges[id].detour_extra_h != null ? ` · detour +${hrs(S.edges[id].detour_extra_h)}` : " · no detour"}</td></tr>
      </table>
      <div><h3>Field reports (${d.incidents.length})</h3>
        ${d.incidents.length ? `<ul class="feed">${d.incidents.map((i) => `<li>${esc(i.type)} · ${esc(i.device_id)} · ${ago(i.time_start)}${i.verified ? " · <b>verified</b>" : ""}${i.via === "mesh" ? " · via mesh" : ""}${i.note ? `<br><span class="muted">${esc(i.note)}</span>` : ""}</li>`).join("")}</ul>` : `<div class="small muted">None in the last reports window.</div>`}
      </div>
      <div class="card stack">
        <h4>Authority / dispatcher action</h4>
        <input type="text" id="ov-reason" placeholder="Reason (required), e.g. 'PWD confirms debris at km 23'">
        <div class="row">
          ${blocked ? `<button class="btn ok grow" id="ov-open">Reopen segment</button>` : `<button class="btn danger grow" id="ov-block">Mark blocked</button>`}
          <select id="rep-type" style="width:auto"><option value="landslide">Landslide</option><option value="debris">Debris / slow</option><option value="flood">Flooding</option><option value="clear">Road clear</option></select>
          <button class="btn" id="rep-go">Log report</button>
        </div>
        <div class="tiny muted">Overrides are logged in the audit trail and pushed to vehicles on this segment at their next sync.</div>
      </div>
    </div>`;
  dr.classList.remove("hidden");
  bindChartTooltips(dr);
  $("#dr-close").onclick = () => dr.classList.add("hidden");
  const act = async (status) => {
    const reason = $("#ov-reason").value.trim();
    if (!reason) return toast("Give a reason for the override.", true);
    await api(`/edges/${id}/status`, { method: "POST", body: { status, reason } });
    toast(`${e.source_name} – ${e.target_name} marked <b>${status}</b>.`);
    await refreshRisk(); openEdge(id); if (S.opt) optimize();
  };
  $("#ov-block")?.addEventListener("click", () => act("blocked"));
  $("#ov-open")?.addEventListener("click", () => act("open"));
  $("#rep-go").addEventListener("click", async () => {
    const res = await api("/incident/report", { method: "POST", body: { type: $("#rep-type").value, edge_id: id,
      device_id: "dispatcher-console", source: "dispatcher", note: $("#ov-reason").value.trim() } });
    toast(res.status_change ? `Report logged. Segment now <b>${res.status_change.status}</b> (${esc(res.status_change.reason)}).` : "Report logged. A second independent report auto-verifies a blockage.");
    await refreshRisk(); refreshIncidents(); openEdge(id);
  });
  S.mv.fit(S.edges[id].geometry, 160, 12);
}

// Small single-series bar chart for H(e,t+h). The title names the series, so no legend.
function forecastChart(fc) {
  const W = 340, H = 110, pad = { l: 34, r: 6, t: 14, b: 20 };
  const iw = W - pad.l - pad.r, ih = H - pad.t - pad.b;
  const bw = iw / fc.length;
  const y = (p) => pad.t + ih - p * ih;
  const grid = [0, 0.25, 0.5, 0.75, 1].map((g) => `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y(g)}" y2="${y(g)}"/>`).join("");
  const ax = [0, 0.5, 1].map((g) => `<text x="${pad.l - 6}" y="${y(g) + 3}" text-anchor="end">${g * 100}%</text>`).join("");
  const bars = fc.map((f, i) => {
    const x = pad.l + i * bw + bw * 0.22, w = bw * 0.56, top = y(Math.max(f.p, 0.004)), base = y(0);
    const r = Math.min(4, w / 2, base - top);
    const path = `M${x},${base} V${top + r} Q${x},${top} ${x + r},${top} H${x + w - r} Q${x + w},${top} ${x + w},${top + r} V${base} Z`;
    return `<g class="hit" data-tip="<b>+${f.h} h</b><div class='tt-row'><span>H(e,t)</span><b>${pct(f.p, 1)}</b></div><div class='tt-row'><span>Rain 24 h</span><span>${f.rain_24h} mm</span></div>">
      <rect x="${pad.l + i * bw}" y="${pad.t}" width="${bw}" height="${ih}" fill="transparent"/>
      <path d="${path}" fill="${LEVEL_COLOR[f.level]}"/>
      <text x="${x + w / 2}" y="${top - 4}" text-anchor="middle" style="fill:var(--text-2);font-size:10.5px">${pct(f.p)}</text>
      <text x="${x + w / 2}" y="${H - 5}" text-anchor="middle" style="fill:var(--muted);font-size:10.5px">${f.h === 0 ? "now" : "+" + f.h + " h"}</text></g>`;
  }).join("");
  return `<div class="chart"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Hazard forecast"><g class="grid">${grid}</g><g class="axis">${ax}</g>${bars}</svg></div>`;
}

function bindChartTooltips(root) {
  $$(".chart", root).forEach((chart) => {
    let tip = null;
    $$(".hit", chart).forEach((g) => {
      g.addEventListener("mouseenter", () => { tip = h(`<div class="tooltip">${g.dataset.tip}</div>`); chart.appendChild(tip); });
      g.addEventListener("mousemove", (ev) => {
        if (!tip) return;
        const r = chart.getBoundingClientRect();
        let x = ev.clientX - r.left + 12; if (x + 170 > r.width) x = ev.clientX - r.left - 170;
        tip.style.left = x + "px"; tip.style.top = ev.clientY - r.top - 10 + "px";
      });
      g.addEventListener("mouseleave", () => { tip?.remove(); tip = null; });
    });
  });
}

// ------------------------------------------------------------------------------------ corridors
async function loadCorridors() {
  const d = await api("/dashboard/corridors");
  $("#corr-updated").textContent = `updated ${new Date().toLocaleTimeString()}`;
  $("#corr-counts").innerHTML = [["blocked", "Blocked"], ["high", "High"], ["medium", "Medium"]].map(([k, l]) =>
    `<div class="tile"><div class="label">${badge(k, l)}</div><div class="value">${d.counts[k]}</div><div class="sub">segments</div></div>`).join("");
  $("#corr-list").innerHTML = d.corridors.map((c) => `
    <div class="corr" data-corr="${c.id}">
      <div><b class="small">${esc(c.name)}</b><div class="tiny muted">worst: ${esc(c.worst_edge.name)} (${pct(c.worst_edge.p)})${c.blocked_edges.length ? ` · <b style="color:#ff9a9a">${c.blocked_edges.length} blocked</b>` : ""}</div></div>
      <div style="text-align:right">${badge(c.health)}<div class="tiny muted num">+${hrs(c.expected_delay_h)} exp · σ ${hrs(c.eta_std_h)}</div></div>
      <div class="meter" title="P(disruption) now ${pct(c.p_disruption_now)}; within 24 h ${pct(c.p_disruption_24h)}"><i style="width:${Math.max(2, c.p_disruption_now * 100)}%;background:${LEVEL_COLOR[c.health]}"></i></div>
      <div class="tiny muted" style="grid-column:1/-1">P(disruption) now ${pct(c.p_disruption_now)} · next 24 h ${pct(c.p_disruption_24h)} · base ${hrs(c.base_time_h)}</div>
    </div>`).join("");
  $$("#corr-list [data-corr]").forEach((el) => el.addEventListener("click", () => {
    const c = d.corridors.find((x) => x.id === el.dataset.corr);
    const coords = c.edges.flatMap((eid, i) => { const e = S.edges[eid]; const fwd = e.source === c.nodes[i]; return fwd ? e.geometry : [...e.geometry].reverse(); });
    S.mv.showRoutes({ corridor: { geometry: coords, legs: [] } }, "corridor"); S.mv.fit(coords, 80);
    openEdge(c.worst_edge.edge_id);
  }));
  $("#corr-feed").innerHTML = d.feed.length ? d.feed.map((f) => {
    const e = f.edge_id && S.edges[f.edge_id];
    const where = e ? `${esc(S.nodes[e.source].name)} – ${esc(S.nodes[e.target].name)}` : "";
    const what = f.kind === "incident" ? `<b>${esc(f.type)}</b> reported by ${esc(f.device_id)}${f.via === "mesh" ? " (relayed over convoy mesh)" : ""}`
      : f.kind === "edge_status" ? `status → <b>${esc(f.status)}</b>: ${esc(f.reason)}` : `alert: ${esc(f.message)}`;
    return `<li>${what}<br><span class="muted">${where} · ${ago(f.at)}</span></li>`;
  }).join("") : `<li class="muted">No incidents yet. Report one from the driver app or from a segment's panel.</li>`;
  const s = d.sync;
  $("#sync-stats").innerHTML = s.devices ? `${s.devices} device(s) · ${s.received}/${s.created} reports delivered (${pct(s.sync_rate, 1)}) · ${s.via_mesh} relayed via mesh · mean lag ${s.mean_sync_lag_min} min`
    : "No driver device has synced yet.";
}

// ------------------------------------------------------------------------------------ shipments
async function loadShipments() {
  const list = await api("/shipments");
  $("#ship-list").innerHTML = list.length ? list.map((s) => {
    const lvl = s.risk_level || "low";
    const slack = s.slack_h != null ? `<div><b style="color:${s.slack_h < 0 ? "#ff9a9a" : "inherit"}">${hrs(s.slack_h)}</b><span>Slack vs deadline</span></div>` : `<div><b>–</b><span>No deadline</span></div>`;
    const cold = s.cold_chain_margin_h != null ? `<div><b style="color:${s.cold_chain_margin_h < 0 ? "#ff9a9a" : "inherit"}">${hrs(s.cold_chain_margin_h)}</b><span>Cold-chain margin ${esc(s.temp_range || "")}</span></div>` : `<div><b>${esc(s.priority)}</b><span>Priority</span></div>`;
    return `<div class="card">
      <div class="row between"><div><b>${esc(s.origin_name)} → ${esc(s.destination_name)}</b><div class="tiny muted">${esc(s.shipment_id)} · ${esc(s.cargo_label)} · ${esc(s.vehicle_id || "unassigned")} · ${esc(s.route_profile || s.status)}</div></div>${badge(lvl)}</div>
      ${s.progress != null ? `<div class="meter" style="margin-top:8px"><i style="width:${Math.max(2, s.progress * 100)}%;background:var(--accent)"></i></div>` : ""}
      <div class="kv">
        <div><b>${hrs(s.eta_remaining_h)}</b><span>ETA remaining</span></div>
        <div><b>${hrs(s.expected_delay_h)}</b><span>Expected delay</span></div>
        ${slack}${cold}
      </div>
      ${s.worst_edge ? `<div class="small dim" style="margin-top:8px">Worst segment ahead: <a href="#" data-edge="${s.worst_edge.edge_id}">${esc(s.worst_edge.name)}</a> (${pct(s.worst_edge.p)})</div>` : ""}
      ${s.handover_suggestion ? `<div class="banner warn small" style="margin-top:8px">${esc(s.handover_suggestion.reason)}</div>` : ""}
      <div class="row" style="margin-top:8px"><button class="btn small" data-replan="${s.shipment_id}">Re-plan from origin</button></div>
    </div>`;
  }).join("") : `<div class="empty">No shipments yet.</div>`;
  $$("#ship-list [data-edge]").forEach((a) => a.addEventListener("click", (e) => { e.preventDefault(); openEdge(a.dataset.edge); }));
  $$("#ship-list [data-replan]").forEach((b) => b.addEventListener("click", () => {
    const s = list.find((x) => x.shipment_id === b.dataset.replan);
    $("#f-origin").value = s.origin; $("#f-dest").value = s.destination; $("#f-cargo").value = s.cargo_type;
    $("#f-priority").value = s.priority; updateTemp(); switchTab("dispatch"); optimize();
  }));
}

// ------------------------------------------------------------------------------------ KPI replay
function setPicking(on) {
  S.picking = on;
  $("#pick-tip").classList.toggle("hidden", !on);
  $("#k-pick").textContent = on ? "Done picking" : "Pick on map";
}
function toggleClosure(id) {
  S.closures.has(id) ? S.closures.delete(id) : S.closures.add(id);
  renderClosures();
}
function renderClosures() {
  const el = $("#k-closures");
  el.innerHTML = S.closures.size ? [...S.closures].map((id) => {
    const e = S.edges[id];
    return `<span class="chip">${esc(S.nodes[e.source].name)} – ${esc(S.nodes[e.target].name)} <a href="#" data-rm="${id}" aria-label="remove">✕</a></span>`;
  }).join("") : `<span class="small muted">None: click “Pick on map”, then click road segments.</span>`;
  $$("[data-rm]", el).forEach((a) => a.addEventListener("click", (ev) => { ev.preventDefault(); S.closures.delete(a.dataset.rm); renderClosures(); }));
}

async function runKpi() {
  setPicking(false);
  const b = $("#btn-kpi"); b.disabled = true; b.innerHTML = `<span class="spinner"></span> Replaying`;
  try {
    const k = await api("/sim/replay", { method: "POST", body: { scenario: $("#k-scenario").value, cargo_type: $("#k-cargo").value,
      trials: +$("#k-trials").value || 300, closures: [...S.closures] } });
    renderKpi(k);
  } catch (err) { toast(esc(err.message), true); }
  finally { b.disabled = false; b.textContent = "Run replay"; }
}

function tile(label, value, sub, target) {
  const t = target ? `<div class="target ${target.pass ? "pass" : "fail"}">${target.pass ? "✓" : "✕"} target ${esc(target.text)}</div>` : "";
  return `<div class="tile"><div class="label">${esc(label)}</div><div class="value">${value}</div><div class="sub">${sub}</div>${t}</div>`;
}

function renderKpi(k) {
  const sync = k.offline_sync;
  const cold = k.cold_chain_breaches_baseline != null;
  $("#kpi-out").innerHTML = `
    <div class="tiles">
      ${tile("Delay avoided", `${k.delay_avoided_pct > 0 ? "" : ""}${k.delay_avoided_pct}%`, `mean delay ${hrs(k.mean_delay_baseline_h)} → ${hrs(k.mean_delay_risk_aware_h)}`)}
      ${tile("P90 trip time", hrs(k.p90_trip_risk_aware_h), `baseline ${hrs(k.p90_trip_baseline_h)}`)}
      ${tile("ETA accuracy (MAPE)", `${k.eta_error_risk_aware_pct}%`, `baseline ${k.eta_error_baseline_pct}%`, { pass: k.eta_error_risk_aware_pct < 15, text: "< 15%" })}
      ${tile("Reroute quality", k.reroute_success_pct == null ? "–" : `${k.reroute_success_pct}%`, `of ${k.trips_exposed_baseline} trips where the baseline hit a blockage, share the risk-aware route avoided entirely`, k.reroute_success_pct == null ? null : { pass: k.reroute_success_pct > 85, text: "> 85%" })}
      ${tile("Blockage encounters", `${k.blockage_encounter_risk_aware_pct}%`, `of trips · baseline ${k.blockage_encounter_baseline_pct}%`)}
      ${tile("Decision latency (p95)", `${k.decision_latency_ms_p95} ms`, `mean ${k.decision_latency_ms_mean} ms, all 4 profiles`, { pass: k.decision_latency_ms_p95 < 2000, text: "< 2 s" })}
      ${tile("Offline sync rate", sync.sync_rate == null ? "–" : pct(sync.sync_rate, 1), sync.devices ? `${sync.received}/${sync.created} driver reports from ${sync.devices} device(s)` : "measured from real driver-app syncs; none yet", sync.sync_rate == null ? null : { pass: sync.sync_rate > 0.95, text: "> 95%" })}
      ${cold ? tile("Cold-chain protection", k.cold_chain_flagged_before_breach_pct == null ? "–" : `${k.cold_chain_flagged_before_breach_pct}%`, `breaches flagged before they happened · breaches ${k.cold_chain_breaches_baseline} → ${k.cold_chain_breaches_risk_aware}`, k.cold_chain_flagged_before_breach_pct == null ? null : { pass: k.cold_chain_flagged_before_breach_pct >= 90, text: "flag before SLA breach" }) : ""}
    </div>
    <div class="card">
      <div class="row between"><h4>Trips delayed by 30 min or more</h4><span class="tiny muted">${k.trials} trials · ${esc(k.scenario)} · ${k.runtime_s}s</span></div>
      <div class="tiny muted" style="margin-top:2px">${kpiHistNote(k)}</div>
      <div class="legend" style="margin:6px 0 4px"><span><i style="background:var(--series-2)"></i>Baseline shortest path</span><span><i style="background:var(--series-1)"></i>Risk-aware (recommended profile)</span></div>
      ${histChart(k.delay_hist.slice(1))}
    </div>
    <div class="card">
      <h4>By corridor pair</h4>
      <table class="t" style="margin-top:6px"><tr><th>O–D</th><th>Trials</th><th>Baseline delay</th><th>Risk-aware delay</th></tr>
      ${k.per_od.map((r) => `<tr><td>${r.od}</td><td>${r.n}</td><td>${hrs(r.base_delay_h)}</td><td>${hrs(r.aware_delay_h)}</td></tr>`).join("")}</table>
    </div>
    <p class="note">Ground truth comes from the physically motivated generator in <span class="mono">backend/risk/generator.py</span>, not from observed closures. The numbers show how the method behaves, not what a pilot will measure. Replace the generator with replayed closure logs to get pilot KPIs.</p>`;
  bindChartTooltips($("#kpi-out"));
}

// Explain the delay histogram: risk-aware routes take small detours to stay out of long blockage waits.
function kpiHistNote(k) {
  const H = k.delay_hist, long = (key) => H.slice(3).reduce((s, b) => s + b[key], 0);
  const onB = H[0].baseline, onA = H[0].risk_aware, lB = long("baseline"), lA = long("risk_aware");
  let s = `Delay measured against the free-flow time of the shortest path. Within 30 min: baseline ${onB}, risk-aware ${onA} trips. Stuck 6 h or more: baseline ${lB}, risk-aware ${lA}.`;
  if (onA < onB && lA <= lB) s += " The risk-aware router accepts a short detour on some trips to stay out of the long waits behind a landslide.";
  return s;
}

// Grouped bar histogram: two series, legend above, per-bin hover tooltip.
function histChart(bins) {
  const W = 380, H = 170, pad = { l: 30, r: 6, t: 10, b: 24 };
  const iw = W - pad.l - pad.r, ih = H - pad.t - pad.b;
  const max = Math.max(1, ...bins.flatMap((b) => [b.baseline, b.risk_aware]));
  const nice = Math.ceil(max / 5) * 5 || 5;
  const y = (v) => pad.t + ih - (v / nice) * ih;
  const gw = iw / bins.length, bw = Math.min(14, (gw - 8) / 2);
  const grid = [0, 0.5, 1].map((g) => `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y(g * nice)}" y2="${y(g * nice)}"/>`).join("");
  const ax = [0, 0.5, 1].map((g) => `<text x="${pad.l - 5}" y="${y(g * nice) + 3}" text-anchor="end">${Math.round(g * nice)}</text>`).join("");
  const bar = (x, v, col) => {
    if (!v) return "";
    const top = y(v), base = y(0), r = Math.min(4, bw / 2, base - top);
    return `<path d="M${x},${base} V${top + r} Q${x},${top} ${x + r},${top} H${x + bw - r} Q${x + bw},${top} ${x + bw},${top + r} V${base} Z" fill="${col}"/>`;
  };
  const groups = bins.map((b, i) => {
    const cx = pad.l + i * gw + gw / 2;
    return `<g class="hit" data-tip="<b>${b.bin}</b><div class='tt-row'><span><i style='background:var(--series-2)'></i>Baseline</span><b>${b.baseline}</b></div><div class='tt-row'><span><i style='background:var(--series-1)'></i>Risk-aware</span><b>${b.risk_aware}</b></div>">
      <rect x="${pad.l + i * gw}" y="${pad.t}" width="${gw}" height="${ih}" fill="transparent"/>
      ${bar(cx - bw - 1, b.baseline, "var(--series-2)")}${bar(cx + 1, b.risk_aware, "var(--series-1)")}
      <text x="${cx}" y="${H - 7}" text-anchor="middle" style="fill:var(--muted);font-size:10px">${b.bin}</text></g>`;
  }).join("");
  return `<div class="chart"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Delay histogram, trips per delay bucket"><g class="grid">${grid}</g><g class="axis">${ax}</g>${groups}</svg></div>`;
}

// ------------------------------------------------------------------------------------ audit
async function loadAudit() {
  const rows = await api("/audit?limit=150");
  $("#audit-table").innerHTML = `<tr><th>When</th><th>Actor</th><th>Action</th><th>Detail</th></tr>` + rows.map((r) => {
    const d = r.detail; let txt = "";
    if (r.action === "route.approve") txt = `${d.route_id} · ${d.profile}${d.profile !== d.recommended ? ` (rec. ${d.recommended}; override: “${esc(d.override_reason)}”)` : ""} → ${d.vehicle_id} · ${d.model_version} · ${d.data_freshness?.label || ""}`;
    else if (r.action === "edge.status") txt = `${d.edge_id} → ${d.status}: ${esc(d.reason)}`;
    else txt = esc(JSON.stringify(d));
    return `<tr><td class="tiny muted">${new Date(r.ts * 1000).toLocaleString()}</td><td>${esc(r.actor)}</td><td class="mono">${esc(r.action)}</td><td class="small">${txt}</td></tr>`;
  }).join("");
}

boot().catch((err) => { console.error(err); toast(`Could not reach the API: ${esc(err.message)}`, true, 10000); });
