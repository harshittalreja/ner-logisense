// Two simulated driver phones for the browser demo (the full PWA lives in frontend/driver.html).
// Each phone keeps its own outbox (a grow-only set of UUID events), syncs to the in-page server
// only when it "has signal", and gossips reports to the other phone over a simulated convoy mesh.
import {
  api, h, esc, pct, hrs, ago, badge, levelOf, LOGO, WARN_ICON, MapView, DEFAULT_BASEMAP, truckMarker, toast, uuid, haversineKm,
} from "./common.js";

const bus = new EventTarget();                       // stands in for Bluetooth / Wi-Fi Direct
const meshSend = (msg) => bus.dispatchEvent(new CustomEvent("mesh", { detail: msg }));

const REPORTS = [
  ["landslide", "Landslide", "block", `<path d="M3 20h18L14 8l-3 5-2-2z" fill="#d12f2f"/><circle cx="17" cy="6" r="2" fill="#d12f2f"/>`],
  ["washout", "Washed out", "block", `<path d="M2 16c3 0 3-2 6-2s3 2 6 2 3-2 6-2M2 20c3 0 3-2 6-2s3 2 6 2 3-2 6-2" stroke="#d12f2f" stroke-width="2" fill="none"/><path d="M4 11h16" stroke="#d12f2f" stroke-width="2" stroke-dasharray="3 2"/>`],
  ["flood", "Flooding", "block", `<path d="M12 3c3 4 5 7 5 10a5 5 0 0 1-10 0c0-3 2-6 5-10z" fill="#2f7fe6"/>`],
  ["accident", "Accident", "block", `<path d="M12 2 23 21H1z" fill="#e8642c"/><rect x="11" y="9" width="2" height="6" fill="#fff"/><rect x="11" y="16.5" width="2" height="2" fill="#fff"/>`],
  ["debris", "Debris / slow", "", `<circle cx="7" cy="16" r="3" fill="#e8a200"/><circle cx="14" cy="17" r="2.2" fill="#e8a200"/><circle cx="17" cy="12" r="2.6" fill="#e8a200"/>`],
  ["clear", "Road clear", "clear", `<path d="M5 13l4 4L19 7" stroke="#1e9e4a" stroke-width="3" fill="none" stroke-linecap="round"/>`],
];

function along(coords, f) {
  const seg = []; let total = 0;
  for (let i = 0; i < coords.length - 1; i++) { const d = haversineKm(coords[i], coords[i + 1]); seg.push(d); total += d; }
  let target = f * total;
  for (let i = 0; i < seg.length; i++) {
    if (target <= seg[i] || i === seg.length - 1) {
      const t = seg[i] ? Math.min(1, target / seg[i]) : 0; const a = coords[i], b = coords[i + 1];
      return [[a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], (Math.atan2(b[0] - a[0], b[1] - a[1]) * 180 / Math.PI + 360) % 360];
    }
    target -= seg[i];
  }
  return [coords[coords.length - 1], 0];
}

export class Phone {
  constructor(root, network, deviceId, idx) {
    this.root = root; this.idx = idx;
    this.network = network;
    this.nodes = Object.fromEntries(network.nodes.map((n) => [n.id, n]));
    this.edges = Object.fromEntries(network.edges.map((e) => [e.id, e]));
    root.innerHTML = this.template();
    this.q = (s) => root.querySelector(s);
    this.q(".rep-grid").innerHTML = REPORTS.map(([t, l, cls, svg]) => `<button class="rep ${cls}" data-rep="${t}"><svg viewBox="0 0 24 24" aria-hidden="true">${svg}</svg>${l}</button>`).join("");
    this.bind();
    this.initMap();
    bus.addEventListener("mesh", (ev) => this.onMesh(ev.detail));
    this.setDevice(deviceId);
    setInterval(() => this.tick(), 1000);
    setInterval(() => { if (this.online()) this.syncNow(); }, 6000);
    setInterval(() => this.hello(), 2500);
  }

  template() {
    const i = this.idx;
    return `
      <div class="phone-top">${LOGO}
        <label class="sr-only" for="veh-${i}" style="position:absolute;left:-9999px">Vehicle</label>
        <select class="veh" id="veh-${i}" title="Which vehicle this phone belongs to"></select>
        <span class="chip conn" style="margin-left:auto"><span class="dot"></span><span class="conn-t">–</span></span>
      </div>
      <div class="phone-map"></div>
      <div class="phone-body">
        <div class="offline-banner hidden"></div>
        <section class="card stack trip"></section>
        <section class="alerts stack"></section>
        <section class="stack">
          <div class="row between"><h3>Report what you see</h3><span class="tiny muted">works with no signal</span></div>
          <div class="rep-grid"></div>
          <input type="text" class="rep-note" id="note-${i}" placeholder="Optional note, e.g. both lanes, JCB on site">
        </section>
        <section class="card">
          <div class="row between"><h3>Outbox</h3><div class="row"><span class="tiny muted ob-count"></span><button class="btn small sync-now">Sync now</button></div></div>
          <ul class="outbox feed"></ul>
        </section>
        <section class="card stack">
          <div class="row between"><h3>Convoy mesh</h3><label class="toggle"><span>Mesh</span><input type="checkbox" class="mesh-on" id="mesh-${i}" checked></label></div>
          <div class="peers small"></div>
          <div class="tiny muted">Stands in for Bluetooth / Wi-Fi Direct between phones in range.</div>
        </section>
        <section class="card stack">
          <div class="row wrap between">
            <button class="btn primary drive">▶ Start driving</button>
            <select class="speed" id="speed-${i}" style="width:auto"><option value="300">300× speed</option><option value="1200" selected>1200× speed</option><option value="3600">3600× speed</option></select>
          </div>
          <label class="toggle"><input type="checkbox" class="force-off" id="off-${i}"><span>Airplane mode (no signal)</span></label>
          <div class="tiny muted">Segments marked as no-network stretches cut the signal automatically while driving. With no trip, tap a road on the map to set your position.</div>
        </section>
      </div>`;
  }

  // ---------------------------------------------------------------- state
  setDevice(id) {
    this.device = id;
    this.store = new Map();          // event_id -> event (the outbox, a G-Set)
    this.cursor = 0; this.createdTotal = 0; this.assignment = null; this.simH = 0; this.driving = false;
    this.statuses = {}; this.knownInc = {}; this.alerts = []; this.peers = {}; this.pos = null; this.edgeNow = null;
    this.manualPos = false; this.coverageOffline = false; this.serverDown = false; this.arrived = false;
    this.q(".drive").textContent = "▶ Start driving";
    this.drawRoute(); this.drawKnown();
    this.syncNow(true);
  }
  online() { return !this.q(".force-off").checked && !this.coverageOffline; }
  async refreshVehicleList() {
    try {
      const vs = await api("/vehicles");
      const ids = [...new Set([...vs.map((v) => v.vehicle_id), this.device])].sort();
      this.q(".veh").innerHTML = ids.map((v) => `<option ${v === this.device ? "selected" : ""}>${esc(v)}</option>`).join("");
    } catch { /* keep list */ }
  }

  // ---------------------------------------------------------------- map
  initMap() {
    this.mv = new MapView(this.q(".phone-map"), this.network, { basemap: DEFAULT_BASEMAP, compact: true });
    this.map = this.mv.map;
    this.veh = truckMarker().setLngLat([91.7, 26.1]).addTo(this.map);
    this.map.on("overlays.ready", () => { this.drawRoute(!this._fitted); this._fitted = true; this.drawKnown(); this.updatePosition(); });
    this.map.on("click", (ev) => {
      if (this.driving || !this.map.getLayer("edge-hit")) return;
      const hit = this.map.queryRenderedFeatures(ev.point, { layers: ["edge-hit"] })[0];
      this.pos = [ev.lngLat.lng, ev.lngLat.lat]; this.edgeNow = hit ? hit.properties.id : null; this.manualPos = true;
      this.coverageOffline = hit ? !!this.edges[this.edgeNow]?.no_network : false;
      this.veh.setLngLat(this.pos);
      const e = this.edgeNow && this.edges[this.edgeNow];
      toast(`${esc(this.device)}: position set ${e ? `on ${esc(this.nodes[e.source].name)} – ${esc(this.nodes[e.target].name)}` : "(not on a corridor)"}`);
      this.render();
    });
  }
  drawRoute(fit) {
    if (!this.mv) return;
    const a = this.assignment;
    if (!a || !a.geometry?.length) { this.mv.clearRoutes(); return; }
    this.mv.showRoutes({ trip: { geometry: a.geometry, legs: a.legs } }, "trip");
    if (fit) this.mv.fit(a.geometry, 20);
  }
  drawKnown() {
    if (!this.mv) return;
    const risk = {};
    for (const [id, st] of Object.entries(this.statuses)) risk[id] = { p_now: st === "blocked" ? 1 : 0, status: st };
    this.mv.setRisk(risk);
    (this.incMarkers || []).forEach((m) => m.remove());
    this.incMarkers = Object.values(this.knownInc).filter((i) => i.type !== "clear" && i.lat != null).map((i) =>
      new maplibregl.Marker({ element: h(`<div title="${esc(i.type)} · ${esc(i.device_id)}">${WARN_ICON(i.mine ? "#e8a200" : "#d12f2f")}</div>`) })
        .setLngLat([i.lon, i.lat]).addTo(this.map));
  }

  // ---------------------------------------------------------------- driving
  legs() { let t = 0; return (this.assignment?.legs || []).map((l) => { const a = t; t += l.t_h; return { ...l, t0: a, t1: t }; }); }
  updatePosition() {
    if (this.manualPos && !this.driving) return;
    this.manualPos = false;
    const legs = this.legs();
    if (!legs.length) { this.edgeNow = null; this.coverageOffline = false; return; }
    const total = legs[legs.length - 1].t1; this.simH = Math.min(this.simH, total);
    const cur = legs.find((l) => this.simH <= l.t1) || legs[legs.length - 1];
    if (cur.kind === "edge") {
      const a = this.nodes[cur.frm], b = this.nodes[cur.to];
      const f = Math.max(0, Math.min(1, (this.simH - cur.t0) / Math.max(cur.t1 - cur.t0, 1e-6)));
      const coords = cur.coords?.length > 1 ? cur.coords : [[a.lon, a.lat], [b.lon, b.lat]];
      [this.pos, this.heading] = along(coords, f);
      this.edgeNow = cur.edge_id; this.coverageOffline = !!this.edges[cur.edge_id]?.no_network;
    } else { const n = this.nodes[cur.at]; this.pos = [n.lon, n.lat]; this.edgeNow = null; this.coverageOffline = false; }
    this.veh?.setLngLat(this.pos);
    this.veh?.getElement().style.setProperty("--hdg", `${this.heading || 0}deg`);
    this.arrived = this.simH >= total;
  }
  async tick() {
    if (this.driving && this.assignment) {
      this.simH += +this.q(".speed").value / 3600;
      const wasOff = !this.online();
      this.updatePosition();
      if (this.arrived) { this.driving = false; this.q(".drive").textContent = "▶ Drive again"; toast(`${esc(this.device)} arrived.`); }
      if (wasOff && this.online()) { toast(`${esc(this.device)} is back in coverage and syncing its outbox.`); this.syncNow(); }
      if (!this._lastPing || Date.now() - this._lastPing > 4000) { this._lastPing = Date.now(); this.queuePing(); }
    }
    this.veh?.getElement().classList.toggle("offline", !this.online());
    this.renderConn(); this.renderTrip();
  }

  // ---------------------------------------------------------------- events
  queuePing() {
    if (!this.pos) return;
    for (const [id, e] of this.store) if (e.kind === "ping") this.store.delete(id);
    const id = uuid();
    this.store.set(id, { event_id: id, kind: "ping", origin_device: this.device, created_at: Date.now() / 1000, hops: 0, queued: !this.online(),
      status: "queued", payload: { lat: this.pos[1], lon: this.pos[0], speed: this.driving ? 30 : 0, edge_id: this.edgeNow,
        shipment_id: this.assignment?.shipment_id, load: this.assignment?.cargo_type } });
    if (this.online()) this.syncNow();
  }
  async report(type) {
    if (!this.pos) { const c = this.map.getCenter(); this.pos = [c.lng, c.lat]; }
    const id = uuid();
    const ev = { event_id: id, kind: "incident", origin_device: this.device, created_at: Date.now() / 1000, hops: 0, status: "queued", mesh_peers: [],
      payload: { type, lat: this.pos[1], lon: this.pos[0], edge_id: this.edgeNow || undefined, severity: type === "debris" ? "low" : "high",
        note: this.q(".rep-note").value.trim(), source: "driver" } };
    this.store.set(id, ev); this.createdTotal += 1;
    this.knownInc[id] = { ...ev.payload, device_id: this.device, mine: true };
    this.q(".rep-note").value = "";
    toast(this.online() ? `${esc(this.device)}: ${type} report sent.` : `${esc(this.device)}: ${type} report saved on the phone. It syncs when this phone or a convoy peer gets signal.`);
    this.meshShare();
    if (this.online()) await this.syncNow();
    this.drawKnown(); this.render();
  }
  async syncNow(first = false) {
    if (this._syncing || !this.online()) { if (!first) this.renderConn(); return; }
    this._syncing = true;
    try {
      const queued = [...this.store.values()].filter((e) => e.status === "queued");
      const res = await api("/sync/events", { method: "POST", body: { device_id: this.device, cursor: this.cursor, stats: { created_total: this.createdTotal },
        events: queued.map(({ event_id, kind, origin_device, created_at, hops, queued: q, payload }) => ({ event_id, kind, origin_device, created_at, hops, queued: !!q, payload })) } });
      const acc = new Set(res.accepted);
      for (const e of queued) if (acc.has(e.event_id)) {
        if (e.kind === "ping") this.store.delete(e.event_id); else e.status = "synced";
      }
      this.apply(res.events); this.cursor = res.cursor; this.serverDown = false;
      this.meshShare();
    } catch { this.serverDown = true; }
    finally { this._syncing = false; this.render(); }
  }
  apply(events) {
    let fresh = false;
    for (const ev of events) {
      const p = ev.payload;
      if (ev.kind === "assignment" && p.vehicle_id === this.device) {
        if (!this.assignment || this.assignment.route_id !== p.route_id) { this.assignment = p; this.simH = 0; fresh = true; }
      } else if (ev.kind === "incident") this.knownInc[ev.event_id] = { ...p, mine: p.device_id === this.device };
      else if (ev.kind === "edge_status") this.statuses[p.edge_id] = p.status;
      else if (ev.kind === "alert" && p.vehicle_id === this.device) { this.alerts.unshift(p); this.alerts = this.alerts.slice(0, 5); }
    }
    if (fresh) { this.manualPos = false; this.updatePosition(); this.drawRoute(true); }
    this.drawKnown();
  }

  // ---------------------------------------------------------------- mesh
  hello() {
    if (!this.q(".mesh-on").checked) return;
    meshSend({ t: "hello", from: this.device, pos: this.pos, online: this.online() });
    for (const [id, p] of Object.entries(this.peers)) if (Date.now() - p.seen > 7000) delete this.peers[id];
    this.renderPeers();
  }
  meshShare() {
    if (!this.q(".mesh-on").checked) return;
    const evs = [...this.store.values()].filter((e) => e.kind === "incident");
    if (evs.length) meshSend({ t: "events", from: this.device, events: evs.map((e) => ({ ...e, synced: e.status === "synced" })) });
  }
  onMesh(msg) {
    if (!this.q(".mesh-on").checked || msg.from === this.device) return;
    if (msg.t === "hello") {
      const isNew = !this.peers[msg.from];
      this.peers[msg.from] = { pos: msg.pos, seen: Date.now(), online: msg.online };
      if (isNew) this.meshShare();
      this.renderPeers(); return;
    }
    let added = 0, changed = false;
    for (const e of msg.events) {
      const mine = this.store.get(e.event_id);
      if (!mine) {
        this.store.set(e.event_id, { ...e, hops: (e.hops || 0) + 1, status: e.synced ? "synced" : "queued", via_mesh_from: msg.from, mesh_peers: [] });
        this.knownInc[e.event_id] = { ...e.payload, device_id: e.origin_device, mine: false }; added++;
      } else if (e.synced && mine.status === "queued") { mine.status = "synced"; mine.acked_via = msg.from; changed = true; }
      else if (e.origin_device === this.device && mine.status === "queued" && !(mine.mesh_peers || []).includes(msg.from)) {
        mine.mesh_peers = [...(mine.mesh_peers || []), msg.from]; changed = true;
      }
    }
    if (added) {
      toast(`${esc(this.device)} received ${added} report(s) from ${esc(msg.from)} over the convoy mesh.`);
      this.drawKnown(); this.meshShare(); if (this.online()) this.syncNow();
    }
    if (added || changed) this.renderOutbox();
  }

  // ---------------------------------------------------------------- UI
  bind() {
    this.root.querySelectorAll("[data-rep]").forEach((b) => b.addEventListener("click", () => this.report(b.dataset.rep)));
    this.q(".drive").addEventListener("click", () => {
      if (!this.assignment) return toast(`${esc(this.device)} has no trip. Approve a route for it in Dispatch first.`, true);
      if (this.arrived) { this.simH = 0; this.arrived = false; }
      this.driving = !this.driving; this.manualPos = false;
      this.q(".drive").textContent = this.driving ? "❚❚ Pause" : "▶ Resume driving";
    });
    this.q(".force-off").addEventListener("change", () => { this.renderConn(); if (this.online()) this.syncNow(); });
    this.q(".sync-now").addEventListener("click", () => { if (!this.online()) return toast("No signal: reports stay queued on the phone.", true); this.syncNow(); });
    this.q(".mesh-on").addEventListener("change", () => { this.peers = {}; this.renderPeers(); });
    this.q(".veh").addEventListener("change", (e) => this.setDevice(e.target.value));
  }
  render() { this.renderConn(); this.renderTrip(); this.renderAlerts(); this.renderOutbox(); this.renderPeers(); }
  renderConn() {
    const on = this.online();
    this.q(".conn").className = "chip conn " + (on && !this.serverDown ? "online" : "offline");
    this.q(".conn-t").textContent = on ? "Signal" : this.q(".force-off").checked ? "Airplane mode" : "No network";
    const b = this.q(".offline-banner");
    if (!on) {
      const e = this.edgeNow && this.edges[this.edgeNow];
      b.innerHTML = this.coverageOffline && e ? `<b>No-network stretch:</b> ${esc(this.nodes[e.source].name)} – ${esc(this.nodes[e.target].name)}. Reports stay on the phone and pass to nearby vehicles.`
        : `<b>Offline.</b> Reports are queued on the phone and sync automatically.`;
      b.classList.remove("hidden");
    } else b.classList.add("hidden");
  }
  renderTrip() {
    const a = this.assignment; const el = this.q(".trip");
    if (!a) { el.innerHTML = `<h2>No trip assigned</h2><div class="small dim">Approve a route for <b>${esc(this.device)}</b> in Dispatch, or pick a vehicle that has one from the list above.</div>`; return; }
    const legs = this.legs(); const total = legs.length ? legs[legs.length - 1].t1 : 0;
    const ahead = legs.filter((l) => l.kind === "edge" && l.t1 > this.simH);
    const rep = (id) => Object.values(this.knownInc).some((i) => i.edge_id === id && !["clear", "debris"].includes(i.type));
    const hz = ahead.find((l) => this.statuses[l.edge_id] === "blocked" || l.p >= 0.35 || rep(l.edge_id));
    const next = ahead[0];
    let hzTxt = "";
    if (hz) {
      const blk = this.statuses[hz.edge_id] === "blocked", r = rep(hz.edge_id);
      hzTxt = `<div class="alert ${blk ? "blocked" : r ? "high" : levelOf(hz.p)}"><b class="small">Ahead: ${esc(hz.frm_name)} → ${esc(hz.to_name)}</b>
        ${blk ? badge("blocked") : r ? badge("high", "Reported") : badge(levelOf(hz.p), `${pct(hz.p)} at dispatch`)}
        <div class="small dim">in ~${hrs(Math.max(0, hz.t0 - this.simH))}${hz.no_network ? " · no-network stretch" : ""}</div></div>`;
    }
    el.innerHTML = `<div class="row between"><div><h2 style="font-size:14px">${esc(this.nodes[a.origin].name)} → ${esc(this.nodes[a.destination].name)}</h2>
      <div class="tiny muted">${esc(a.cargo_type)} · ${esc(a.profile)} route</div></div><span class="small num dim">${hrs(this.simH)} / ${hrs(total)}</span></div>
      <div class="progress"><i style="width:${total ? (this.simH / total) * 100 : 0}%"></i></div>
      <div class="small">${this.arrived ? "<b>Arrived.</b>" : next ? `Now: <b>${esc(next.frm_name)} → ${esc(next.to_name)}</b> <span class="muted">${esc(next.route_ref)}</span>` : ""}</div>${hzTxt}`;
  }
  renderAlerts() {
    this.q(".alerts").innerHTML = this.alerts.slice(0, 2).map((a) => `<div class="alert high"><b class="small">Dispatcher alert</b><div class="small">${esc(a.message)}</div><div class="tiny muted">${ago(a.created_at)}</div></div>`).join("");
  }
  renderOutbox() {
    const evs = [...this.store.values()].filter((e) => e.kind === "incident").sort((a, b) => b.created_at - a.created_at);
    const q = evs.filter((e) => e.status === "queued").length;
    this.q(".ob-count").textContent = `${q} queued · ${evs.length - q} synced`;
    this.q(".outbox").innerHTML = evs.length ? evs.slice(0, 8).map((e) => {
      const mine = e.origin_device === this.device;
      const st = e.status === "synced" ? `<span class="st synced">Synced ✓</span>` : e.mesh_peers?.length ? `<span class="st mesh">Shared with ${e.mesh_peers.map(esc).join(", ")}</span>` : `<span class="st queued">Queued</span>`;
      const ed = e.payload.edge_id && this.edges[e.payload.edge_id];
      const where = ed ? `${this.nodes[ed.source].name} – ${this.nodes[ed.target].name}` : `${e.payload.lat?.toFixed(3)}, ${e.payload.lon?.toFixed(3)}`;
      return `<li><span><b>${esc(e.payload.type)}</b> · ${esc(where)}</span>${st}<span class="tiny muted">${mine ? "this phone" : `from ${esc(e.origin_device)} via mesh`} · ${ago(e.created_at)}</span><span></span></li>`;
    }).join("") : `<li class="muted">No reports yet.</li>`;
  }
  renderPeers() {
    const ps = Object.entries(this.peers);
    this.q(".peers").innerHTML = ps.length ? ps.map(([id, p]) => `<div class="row between"><span><b>${esc(id)}</b> <span class="muted">${p.online ? "has signal" : "no signal"}</span></span>
      <span class="muted">${p.pos && this.pos ? haversineKm(p.pos, this.pos).toFixed(0) + " km" : ""}</span></div>`).join("") : `<span class="muted">No vehicles in range.</span>`;
  }
  resize() { this.map?.resize(); }
}
