// NER-LogiSense driver PWA — offline-first incident reporting with a convoy mesh.
//
// Storage   : IndexedDB, one database per device (so several tabs = several vehicles).
// Outbox    : grow-only set of events keyed by UUID. Merging two sets is a union, so
//             duplicates are harmless and order does not matter (a G-Set CRDT).
// Sync      : POST /sync/events uploads queued events and pulls server events since a cursor.
//             The server is idempotent on event_id.
// Mesh      : BroadcastChannel between tabs stands in for Bluetooth / Wi-Fi Direct.
import {
  api, $, $$, h, esc, pct, hrs, ago, badge, levelOf, LOGO, WARN_ICON, MapView, DEFAULT_BASEMAP, truckMarker, toast, uuid, haversineKm,
} from "./common.js";

// ------------------------------------------------------------------------------------ identity
const params = new URLSearchParams(location.search);
function safeLS(fn, fallback = null) { try { return fn(); } catch { return fallback; } }
let DEVICE = params.get("vehicle") || safeLS(() => localStorage.getItem("ner-device")) || `TRK-${Math.random().toString(16).slice(2, 6).toUpperCase()}`;
safeLS(() => localStorage.setItem("ner-device", DEVICE));
if (!params.get("vehicle")) history.replaceState(null, "", `/driver?vehicle=${encodeURIComponent(DEVICE)}`);
$("#vid").textContent = DEVICE; $("#dev-foot").textContent = DEVICE;
$("#logo").innerHTML = LOGO;

// ------------------------------------------------------------------------------------ IndexedDB
const DB_NAME = `ner-driver-${DEVICE}`;
const db = await new Promise((res, rej) => {
  const r = indexedDB.open(DB_NAME, 1);
  r.onupgradeneeded = () => {
    r.result.createObjectStore("events", { keyPath: "event_id" });
    r.result.createObjectStore("meta", { keyPath: "key" });
  };
  r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
});
function tx(store, mode, fn) {
  return new Promise((res, rej) => {
    const t = db.transaction(store, mode); const s = t.objectStore(store);
    const out = fn(s); t.oncomplete = () => res(out?.result ?? out); t.onerror = () => rej(t.error);
  });
}
const idb = {
  get: (store, key) => new Promise((res) => { const r = db.transaction(store).objectStore(store).get(key); r.onsuccess = () => res(r.result); r.onerror = () => res(undefined); }),
  all: (store) => new Promise((res) => { const r = db.transaction(store).objectStore(store).getAll(); r.onsuccess = () => res(r.result || []); }),
  put: (store, val) => tx(store, "readwrite", (s) => s.put(val)),
  del: (store, key) => tx(store, "readwrite", (s) => s.delete(key)),
};
const meta = {
  get: async (k, d = null) => (await idb.get("meta", k))?.value ?? d,
  set: (k, v) => idb.put("meta", { key: k, value: v }),
};

// ------------------------------------------------------------------------------------ state
const S = {
  network: null, nodes: {}, edges: {}, assignment: null, cursor: 0, createdTotal: 0,
  manualOffline: false, coverageOffline: false, serverDown: false,
  driving: false, simH: 0, speed: 300, pos: null, edgeNow: null,
  statuses: {}, knownInc: {}, alerts: [], peers: {}, map: null, veh: null, incMarkers: [],
};
window.__ner = S;   // handy for debugging in the console
const online = () => !S.manualOffline && !S.coverageOffline && navigator.onLine;

// ------------------------------------------------------------------------------------ boot
async function boot() {
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {});
  S.cursor = await meta.get("cursor", 0);
  S.createdTotal = await meta.get("created_total", 0);
  S.assignment = await meta.get("assignment", null);
  S.simH = await meta.get("simH", 0);
  S.statuses = await meta.get("statuses", {});
  S.knownInc = await meta.get("knownInc", {});
  S.alerts = await meta.get("alerts", []);
  // network: try the server, fall back to the copy cached on the device
  try { S.network = await api("/network"); await meta.set("network", S.network); }
  catch { S.network = await meta.get("network"); }
  if (!S.network) {
    $("#trip").innerHTML = `<div class="empty">No network data cached yet. Open this page once with signal.</div>`;
    return;
  }
  S.network.nodes.forEach((n) => (S.nodes[n.id] = n));
  S.network.edges.forEach((e) => (S.edges[e.id] = e));
  renderReportButtons();
  initMap();
  bindUI();
  startMesh();
  await syncNow(true);
  renderAll();
  setInterval(tick, 1000);
  setInterval(() => { if (online()) syncNow(); }, 8000);
}

// ------------------------------------------------------------------------------------ map
function initMap() {
  S.mv = new MapView("dmap", S.network, { basemap: DEFAULT_BASEMAP, compact: true });
  S.map = S.mv.map;
  S.veh = truckMarker().setLngLat([91.7, 26.1]).addTo(S.map);
  S.map.on("overlays.ready", () => { drawRoute(!S._fitted); S._fitted = true; drawKnown(); updatePosition(); });
  // With no trip (or while parked) the driver can tap a road segment to say "I am here".
  S.map.on("click", (ev) => {
    if (S.driving || !S.map.getLayer("edge-hit")) return;
    const hit = S.map.queryRenderedFeatures(ev.point, { layers: ["edge-hit"] })[0];
    S.pos = [ev.lngLat.lng, ev.lngLat.lat];
    S.edgeNow = hit ? hit.properties.id : null;
    S.manualPos = true;
    S.coverageOffline = hit ? !!S.edges[S.edgeNow]?.no_network : false;
    S.veh.setLngLat(S.pos);
    const e = S.edgeNow && S.edges[S.edgeNow];
    toast(e ? `Position set on ${esc(S.nodes[e.source].name)} – ${esc(S.nodes[e.target].name)} (${esc(e.route_ref)})` : "Position set (not on a corridor segment)");
    renderConn();
  });
}

function drawRoute(fit) {
  if (!S.mv) return;
  const a = S.assignment;
  if (!a || !a.geometry?.length) { S.mv.clearRoutes(); return; }
  S.mv.showRoutes({ trip: { geometry: a.geometry, legs: a.legs } }, "trip");
  if (fit) S.mv.fit(a.geometry, 30);
}
function drawKnown() {
  if (!S.mv) return;
  const risk = {};
  for (const [id, st] of Object.entries(S.statuses)) risk[id] = { p_now: st === "blocked" ? 1 : 0, status: st };
  S.mv.setRisk(risk);
  S.incMarkers.forEach((m) => m.remove());
  S.incMarkers = Object.values(S.knownInc).filter((i) => i.type !== "clear" && i.lat != null).map((i) =>
    new maplibregl.Marker({ element: h(`<div title="${esc(i.type)} · ${esc(i.device_id)}">${WARN_ICON(i.mine ? "#e8a200" : "#d12f2f")}</div>`) })
      .setLngLat([i.lon, i.lat]).addTo(S.map));
}

// Point at fraction f along a polyline, plus the heading there.
function along(coords, f) {
  if (coords.length < 2) return [coords[0], 0];
  const seg = []; let total = 0;
  for (let i = 0; i < coords.length - 1; i++) { const d = haversineKm(coords[i], coords[i + 1]); seg.push(d); total += d; }
  let target = f * total;
  for (let i = 0; i < seg.length; i++) {
    if (target <= seg[i] || i === seg.length - 1) {
      const t = seg[i] ? Math.min(1, target / seg[i]) : 0; const a = coords[i], b = coords[i + 1];
      const hdg = (Math.atan2(b[0] - a[0], b[1] - a[1]) * 180 / Math.PI + 360) % 360;
      return [[a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], hdg];
    }
    target -= seg[i];
  }
  return [coords[coords.length - 1], 0];
}

// ------------------------------------------------------------------------------------ driving simulation
function legsWithClock() {
  let t = 0;
  return (S.assignment?.legs || []).map((l) => { const a = t; t += l.t_h; return { ...l, t0: a, t1: t }; });
}
function updatePosition() {
  if (S.manualPos && !S.driving) return;
  S.manualPos = false;
  const legs = legsWithClock();
  if (!legs.length) { S.edgeNow = null; S.coverageOffline = false; return; }
  const total = legs[legs.length - 1].t1;
  S.simH = Math.min(S.simH, total);
  const cur = legs.find((l) => S.simH <= l.t1) || legs[legs.length - 1];
  let pos;
  if (cur.kind === "edge") {
    const a = S.nodes[cur.frm], b = S.nodes[cur.to];
    const f = Math.max(0, Math.min(1, (S.simH - cur.t0) / Math.max(cur.t1 - cur.t0, 1e-6)));
    const coords = cur.coords?.length > 1 ? cur.coords : [[a.lon, a.lat], [b.lon, b.lat]];
    const [p, hdg] = along(coords, f);
    pos = p; S.heading = hdg;
    S.edgeNow = cur.edge_id;
    S.coverageOffline = !!S.edges[cur.edge_id]?.no_network;
  } else {
    const n = S.nodes[cur.at]; pos = [n.lon, n.lat]; S.edgeNow = null; S.coverageOffline = false;
  }
  S.pos = pos;
  S.veh?.setLngLat(pos);
  S.veh?.getElement().style.setProperty("--hdg", `${S.heading || 0}deg`);
  S.veh?.getElement().classList.toggle("offline", !online());
  S.arrived = S.simH >= total;
}

let lastPing = 0;
async function tick() {
  if (S.driving && S.assignment) {
    S.simH += S.speed / 3600;          // 1 real second = speed sim-seconds
    const wasOff = !online();
    updatePosition();
    if (S.arrived) { S.driving = false; toast("Arrived at destination."); }
    if (wasOff && online()) { toast("Back in coverage: syncing outbox."); syncNow(); }
    meta.set("simH", S.simH);
    if (Date.now() - lastPing > 5000) { lastPing = Date.now(); await queuePing(); }
  }
  renderConn(); renderTrip();
}

// ------------------------------------------------------------------------------------ events
async function queuePing() {
  if (!S.pos) return;
  for (const e of await idb.all("events")) if (e.kind === "ping" && e.status === "queued") await idb.del("events", e.event_id);
  await idb.put("events", { event_id: uuid(), kind: "ping", origin_device: DEVICE, created_at: Date.now() / 1000, hops: 0,
    queued: !online(), status: "queued", payload: { lat: S.pos[1], lon: S.pos[0], speed: S.driving ? 32 : 0,
      edge_id: S.edgeNow, shipment_id: S.assignment?.shipment_id, load: S.assignment?.cargo_type } });
  if (online()) syncNow();
}

async function report(type) {
  if (!S.pos) {
    // no trip: report at the map centre so the prototype can still be used freely
    const c = S.map.getCenter(); S.pos = [c.lng, c.lat];
  }
  const ev = { event_id: uuid(), kind: "incident", origin_device: DEVICE, created_at: Date.now() / 1000, hops: 0,
    status: "queued", mesh_peers: [], payload: { type, lat: S.pos[1], lon: S.pos[0], edge_id: S.edgeNow || undefined,
      severity: type === "debris" ? "low" : "high", note: $("#rep-note").value.trim(), source: "driver" } };
  await idb.put("events", ev);
  S.createdTotal += 1; await meta.set("created_total", S.createdTotal);
  S.knownInc[ev.event_id] = { ...ev.payload, device_id: DEVICE, mine: true };
  await meta.set("knownInc", S.knownInc);
  $("#rep-note").value = "";
  if (navigator.vibrate) navigator.vibrate(60);
  toast(online() ? `${type} report sent.` : `${type} report saved on device. It will sync when you reach signal${S.peers && Object.keys(S.peers).length ? " or via the convoy mesh" : ""}.`);
  meshShare();
  if (online()) await syncNow();
  drawKnown(); renderOutbox();
}

// ------------------------------------------------------------------------------------ sync
let syncing = false;
async function syncNow(first = false) {
  if (syncing) return;
  if (!online()) { if (!first) renderConn(); return; }
  syncing = true;
  try {
    const all = await idb.all("events");
    const queued = all.filter((e) => e.status === "queued");
    const res = await api("/sync/events", { method: "POST", body: {
      device_id: DEVICE, cursor: S.cursor, stats: { created_total: S.createdTotal },
      events: queued.map(({ event_id, kind, origin_device, created_at, hops, queued: q, payload }) =>
        ({ event_id, kind, origin_device, created_at, hops, queued: !!q, payload })) } });
    const acc = new Set(res.accepted);
    for (const e of queued) if (acc.has(e.event_id)) {
      if (e.kind === "ping") await idb.del("events", e.event_id);
      else await idb.put("events", { ...e, status: "synced", synced_at: Date.now() / 1000 });
    }
    applyServerEvents(res.events);
    S.cursor = res.cursor; await meta.set("cursor", S.cursor);
    S.serverDown = false;
    meshShare();   // tell peers what is now acknowledged
  } catch (err) {
    S.serverDown = true;
  } finally { syncing = false; renderAll(); }
}

function applyServerEvents(events) {
  let newAssign = false;
  for (const ev of events) {
    const p = ev.payload;
    if (ev.kind === "assignment" && p.vehicle_id === DEVICE) {
      if (!S.assignment || S.assignment.route_id !== p.route_id) { S.assignment = p; S.simH = 0; newAssign = true; }
    } else if (ev.kind === "incident") {
      S.knownInc[ev.event_id] = { ...p, mine: p.device_id === DEVICE };
    } else if (ev.kind === "edge_status") {
      S.statuses[p.edge_id] = p.status;
    } else if (ev.kind === "alert" && p.vehicle_id === DEVICE) {
      S.alerts.unshift({ ...p, seq: ev.seq }); S.alerts = S.alerts.slice(0, 10);
      if (navigator.vibrate) navigator.vibrate([100, 60, 100]);
    }
  }
  meta.set("knownInc", S.knownInc); meta.set("statuses", S.statuses); meta.set("alerts", S.alerts);
  if (newAssign) { meta.set("assignment", S.assignment); meta.set("simH", 0); updatePosition(); drawRoute(true); toast(`New trip assigned: ${esc(S.nodes[S.assignment.origin].name)} → ${esc(S.nodes[S.assignment.destination].name)}`); }
  drawKnown();
}

// ------------------------------------------------------------------------------------ convoy mesh
let chan = null;
function startMesh() {
  if (!("BroadcastChannel" in window)) { $("#peers").textContent = "This browser has no BroadcastChannel; mesh simulation unavailable."; return; }
  chan = new BroadcastChannel("ner-convoy-mesh");
  chan.onmessage = async ({ data }) => {
    if (!$("#mesh-on").checked || data.from === DEVICE) return;
    if (data.t === "hello") {
      const isNew = !S.peers[data.from];
      S.peers[data.from] = { pos: data.pos, seen: Date.now(), online: data.online };
      if (isNew) meshShare();
      renderPeers();
    } else if (data.t === "events") {
      await meshReceive(data.from, data.events);
    }
  };
  setInterval(() => {
    if (!$("#mesh-on").checked) return;
    chan.postMessage({ t: "hello", from: DEVICE, pos: S.pos, online: online() });
    for (const [id, p] of Object.entries(S.peers)) if (Date.now() - p.seen > 8000) delete S.peers[id];
    renderPeers();
  }, 2500);
}

async function meshShare() {
  if (!chan || !$("#mesh-on").checked) return;
  const since = Date.now() / 1000 - 12 * 3600;
  const evs = (await idb.all("events")).filter((e) => e.kind === "incident" && e.created_at >= since);
  if (evs.length) chan.postMessage({ t: "events", from: DEVICE, events: evs.map((e) => ({ ...e, synced: e.status === "synced" })) });
}

async function meshReceive(from, events) {
  let added = 0;
  for (const e of events) {
    const mine = await idb.get("events", e.event_id);
    if (!mine) {
      // union: keep the event; if the sender already delivered it to the server, just remember it
      await idb.put("events", { ...e, hops: (e.hops || 0) + 1, status: e.synced ? "synced" : "queued", via_mesh_from: from, mesh_peers: [] });
      S.knownInc[e.event_id] = { ...e.payload, device_id: e.origin_device, mine: false };
      added++;
    } else if (e.synced && mine.status === "queued") {
      await idb.put("events", { ...mine, status: "synced", acked_via: from });     // ack travelled over the mesh
    } else if (e.origin_device === DEVICE && mine.status === "queued") {
      const peers = new Set(mine.mesh_peers || []); peers.add(from);
      await idb.put("events", { ...mine, mesh_peers: [...peers] });
    }
  }
  if (added) {
    await meta.set("knownInc", S.knownInc);
    toast(`Received ${added} report(s) from ${esc(from)} over the convoy mesh.`);
    drawKnown(); meshShare();                 // echo back so the sender learns we hold it
    if (online()) syncNow();
  }
  renderOutbox();
}

// ------------------------------------------------------------------------------------ rendering
const REPORTS = [
  ["landslide", "Landslide", "block", `<path d="M3 20h18L14 8l-3 5-2-2z" fill="#d12f2f"/><circle cx="17" cy="6" r="2" fill="#d12f2f"/>`],
  ["washout", "Road washed out", "block", `<path d="M2 16c3 0 3-2 6-2s3 2 6 2 3-2 6-2M2 20c3 0 3-2 6-2s3 2 6 2 3-2 6-2" stroke="#d12f2f" stroke-width="2" fill="none"/><path d="M4 11h16" stroke="#d12f2f" stroke-width="2" stroke-dasharray="3 2"/>`],
  ["flood", "Flooding", "block", `<path d="M12 3c3 4 5 7 5 10a5 5 0 0 1-10 0c0-3 2-6 5-10z" fill="#2f7fe6"/>`],
  ["accident", "Accident", "block", `<path d="M12 2 23 21H1z" fill="#e8642c"/><rect x="11" y="9" width="2" height="6" fill="#fff"/><rect x="11" y="16.5" width="2" height="2" fill="#fff"/>`],
  ["debris", "Debris / slow", "", `<circle cx="7" cy="16" r="3" fill="#e8a200"/><circle cx="14" cy="17" r="2.2" fill="#e8a200"/><circle cx="17" cy="12" r="2.6" fill="#e8a200"/>`],
  ["clear", "Road clear", "clear", `<path d="M5 13l4 4L19 7" stroke="#1e9e4a" stroke-width="3" fill="none" stroke-linecap="round"/>`],
];
function renderReportButtons() {
  $("#rep-grid").innerHTML = REPORTS.map(([t, l, cls, svg]) => `<button class="rep ${cls}" data-rep="${t}"><svg viewBox="0 0 24 24">${svg}</svg>${l}</button>`).join("");
  $$("[data-rep]").forEach((b) => b.addEventListener("click", () => report(b.dataset.rep)));
}

function renderConn() {
  const on = online();
  const c = $("#conn"); c.className = "chip conn " + (on && !S.serverDown ? "online" : "offline");
  $("#conn-t").textContent = on ? (S.serverDown ? "Server unreachable" : "Online") : S.manualOffline ? "Offline (manual)" : S.coverageOffline ? "No network" : "Offline";
  const b = $("#offline-banner");
  if (!on || S.serverDown) {
    const edge = S.edgeNow && S.edges[S.edgeNow];
    b.innerHTML = S.coverageOffline && edge ? `<b>No-network stretch:</b> ${esc(S.nodes[edge.source].name)} – ${esc(S.nodes[edge.target].name)}. Reports stay on this device and pass to nearby convoy vehicles.`
      : `<b>Offline.</b> Reports are queued on this device and will sync automatically.`;
    b.classList.remove("hidden");
  } else b.classList.add("hidden");
}

function renderTrip() {
  const a = S.assignment;
  if (!a) {
    $("#trip").innerHTML = `<div class="row between"><h2>No trip assigned</h2></div>
      <div class="small dim">Waiting for a dispatcher to approve a route for <b>${esc(DEVICE)}</b>. You can still file reports: tap a road segment on the map to set your position first.</div>
      <div class="row wrap" id="veh-pick"></div>`;
    loadVehiclePicker();
    return;
  }
  const legs = legsWithClock(); const total = legs.length ? legs[legs.length - 1].t1 : 0;
  const ahead = legs.filter((l) => l.kind === "edge" && l.t1 > S.simH);
  const hazards = ahead.filter((l) => S.statuses[l.edge_id] === "blocked" || l.p >= 0.35 ||
    Object.values(S.knownInc).some((i) => i.edge_id === l.edge_id && i.type !== "clear" && i.type !== "debris"));
  const next = ahead[0];
  const hz = hazards[0];
  const hzBlocked = hz && S.statuses[hz.edge_id] === "blocked";
  const hzReported = hz && Object.values(S.knownInc).some((i) => i.edge_id === hz.edge_id && !["clear", "debris"].includes(i.type));
  const hzBadge = !hz ? "" : hzBlocked ? badge("blocked") : hzReported ? badge("high", "Reported") : badge(levelOf(hz.p), `${pct(hz.p)} at dispatch`);
  const hzTxt = hz ? `<div class="alert ${hzBlocked ? "blocked" : hzReported ? "high" : levelOf(hz.p)}" style="margin-top:8px">
      <b class="small">Ahead: ${esc(hz.frm_name)} → ${esc(hz.to_name)}</b> ${hzBadge}
      <div class="small dim">in ~${hrs(Math.max(0, hz.t0 - S.simH))}${hz.no_network ? " · no-network stretch" : ""}</div></div>` : "";
  $("#trip").innerHTML = `
    <div class="row between"><div><h2>${esc(S.nodes[a.origin].name)} → ${esc(S.nodes[a.destination].name)}</h2>
      <div class="tiny muted">${esc(a.shipment_id)} · ${esc(a.cargo_type)} · ${esc(a.profile)} route · ${esc(a.route_id)}</div></div>
      <span class="small num dim">${hrs(S.simH)} / ${hrs(total)}</span></div>
    <div class="progress"><i style="width:${total ? (S.simH / total) * 100 : 0}%"></i></div>
    <div class="small">${S.arrived ? "<b>Arrived.</b>" : next ? `Now: <b>${esc(next.frm_name)} → ${esc(next.to_name)}</b> <span class="muted">${esc(next.route_ref)}</span>` : ""}</div>
    ${hzTxt}`;
}

let pickerLoaded = false;
async function loadVehiclePicker() {
  if (pickerLoaded || !online()) return; pickerLoaded = true;
  try {
    const vs = await api("/vehicles");
    const el = $("#veh-pick"); if (!el || !vs.length) return;
    el.innerHTML = `<span class="small muted">Or drive an existing vehicle:</span>` + vs.map((v) => `<a class="chip" href="/driver?vehicle=${encodeURIComponent(v.vehicle_id)}">${esc(v.vehicle_id)}</a>`).join("");
  } catch { pickerLoaded = false; }
}

function renderAlerts() {
  $("#alerts").innerHTML = S.alerts.slice(0, 3).map((a) => `<div class="alert high"><b class="small">Dispatcher alert</b><div class="small">${esc(a.message)}</div><div class="tiny muted">${ago(a.created_at)}</div></div>`).join("");
}

async function renderOutbox() {
  const evs = (await idb.all("events")).filter((e) => e.kind === "incident").sort((a, b) => b.created_at - a.created_at);
  const q = evs.filter((e) => e.status === "queued").length;
  $("#outbox-count").textContent = `${q} queued · ${evs.length - q} synced`;
  $("#outbox").innerHTML = evs.length ? evs.slice(0, 12).map((e) => {
    const mine = e.origin_device === DEVICE;
    const st = e.status === "synced" ? `<span class="st synced">Synced ✓</span>`
      : e.mesh_peers?.length ? `<span class="st mesh">Shared with ${e.mesh_peers.map(esc).join(", ")}</span>` : `<span class="st queued">Queued</span>`;
    const where = e.payload.edge_id && S.edges[e.payload.edge_id] ? `${S.nodes[S.edges[e.payload.edge_id].source].name} – ${S.nodes[S.edges[e.payload.edge_id].target].name}` : `${e.payload.lat?.toFixed(3)}, ${e.payload.lon?.toFixed(3)}`;
    return `<li><span><b>${esc(e.payload.type)}</b> · ${esc(where)}</span>${st}
      <span class="tiny muted">${mine ? "you" : `from ${esc(e.origin_device)} via mesh (${e.hops} hop)`} · ${ago(e.created_at)}${e.payload.note ? " · " + esc(e.payload.note) : ""}</span><span></span></li>`;
  }).join("") : `<li class="muted">No reports yet.</li>`;
}

function renderPeers() {
  const ps = Object.entries(S.peers);
  $("#peers").innerHTML = ps.length ? ps.map(([id, p]) => {
    const d = p.pos && S.pos ? `${haversineKm(p.pos, S.pos).toFixed(1)} km` : "position unknown";
    return `<div class="peer"><span><b>${esc(id)}</b> <span class="muted">${p.online ? "has signal" : "offline"}</span></span><span class="muted">${d}</span></div>`;
  }).join("") : `<span class="muted">No vehicles in range.</span>`;
}

function renderAll() { renderConn(); renderTrip(); renderAlerts(); renderOutbox(); renderPeers(); }

// ------------------------------------------------------------------------------------ UI
function bindUI() {
  $("#drive").addEventListener("click", () => {
    if (!S.assignment) return toast("No trip assigned yet.", true);
    if (S.arrived) { S.simH = 0; S.arrived = false; }
    S.driving = !S.driving;
    $("#drive").textContent = S.driving ? "❚❚ Pause" : "▶ Resume driving";
  });
  $("#speed").addEventListener("change", (e) => (S.speed = +e.target.value));
  S.speed = +$("#speed").value;
  $("#force-off").addEventListener("change", (e) => { S.manualOffline = e.target.checked; renderConn(); if (!S.manualOffline) syncNow(); });
  $("#sync-now").addEventListener("click", () => { if (!online()) return toast("No connection: reports stay queued.", true); syncNow(); });
  $("#mesh-on").addEventListener("change", () => { S.peers = {}; renderPeers(); });
  $("#open-peer").addEventListener("click", (e) => { e.preventDefault(); window.open(`/driver?vehicle=TRK-${Math.random().toString(16).slice(2, 6).toUpperCase()}`, "_blank"); });
  $("#switch-veh").addEventListener("click", (e) => {
    e.preventDefault();
    const v = prompt("Vehicle ID", DEVICE);
    if (v && v.trim()) { safeLS(() => localStorage.setItem("ner-device", v.trim())); location.href = `/driver?vehicle=${encodeURIComponent(v.trim())}`; }
  });
  window.addEventListener("online", () => { renderConn(); syncNow(); });
  window.addEventListener("offline", renderConn);
}

boot().catch((err) => { console.error(err); toast(`Driver app failed to start: ${esc(err.message)}`, true, 10000); });
