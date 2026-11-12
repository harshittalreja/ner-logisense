# Demo script (about 8 minutes)

This script follows the storyline on slide 9, *"one shipment from booking to offline sync"*. Start the server (`./run.sh`) and keep three tabs ready:

- **A**: dispatcher at `http://localhost:8000/`
- **B**: driver at `http://localhost:8000/driver?vehicle=TRK-DEMO1`
- **C**: driver at `http://localhost:8000/driver?vehicle=TRK-DEMO2`

Tip: to start from a clean state, stop the server, delete `ner_logisense.db`, and start it again.

## 1. The problem on a map (30 s)
In tab A, rainfall is set to *Typical monsoon day*. Point out the corridors: NH10 up the Teesta, the NH717A bypass via Lava, NH6 through Sonapur, NH27 through Dima Hasao, NH37 via Noney, and the rail lines (dashed violet). Line colour is the hazard score H(e,t). Click any segment to open its panel.

## 2. Create a shipment and compare routes (1 min)
Set **Siliguri → Gangtok**, *Medicines / vaccines*, deadline **10 h**, then click **Compare routes**. Four cards appear: Fastest, Balanced, Safest and Emergency. Each shows expected ETA, P90 ETA, P(late), cold-chain risk, and a stacked bar with the four cost terms from slide 6.

Even on a typical monsoon day, the vaccine load is steered to **Safest** (the NH717A bypass), because the tail matters for the cold chain. Change the cargo to *General freight* and compare again: the recommendation returns to **Fastest** on NH10. The same road network gives a different answer for different cargo.

## 3. Weather changes the answer (1 min)
In the top bar, choose **Replay: Teesta valley cloudburst**. NH10 turns red, and the recommendation switches to the Lava bypass. The banner states what is avoided, the extra driving time, and the expected blockage delay saved.

## 4. An explained alert (1 min)
Click the top alert, *Sevoke – Teesta Bazar (NH10)*. The panel shows:
- H now = ~90%, plus a forecast for +6, +12 and +24 h
- factor contributions (rainfall, slope, landslide history, river bank) as TreeSHAP log-odds
- the reasons in plain words: "175 mm/24 h … 7.4× the I-D landslide threshold"
- a confidence score and its basis (scenario vs live data, field reports)

## 5. The human decides (45 s)
Select the **Fastest** card. The approve button turns red and asks for an override reason. Type one, enter vehicle **TRK-DEMO1**, and approve. Open *Audit*: the decision is logged with the model version and data freshness.

## 6. Driver app, offline (2 min)
Tab B receives the trip Siliguri → Gangtok through `/sync/events`.
1. In tab C (a second vehicle), switch on **Force offline** now, so it will have no signal either.
2. In tab B, press **Start driving** at 1200×. When the truck enters Sevoke – Teesta Bazar (a no-network stretch), the status pill flips to *No network*. Press **Pause** and tap **Landslide**. The report is *Queued* on the device.
3. Within a few seconds tab C shows *"Received 1 report from TRK-DEMO1 over the convoy mesh"*. In C, **tap the same road segment on the map** to set its position there, then tap **Landslide**.
4. Switch C back online. C uploads both reports. The server sees two independent devices and **auto-verifies the segment as blocked**, and tab A shows it dashed white on red. B's report changes to *Synced ✓* even though B never had signal, because the acknowledgement came back over the mesh. Routes planned from now on avoid the segment.

## 7. Corridor and warehouse views (45 s)
- *Corridors*: 12 NH corridors ranked by P(disruption), expected delay and ETA spread, with the live alert feed (incidents, auto-verification, overrides) and the offline sync rate.
- *Shipments*: the in-transit pharma load shows negative cold-chain margin and a **hand-over suggestion** at the last safe node before the risky segment.

## 8. Prove it (1 min)
In *KPI replay*, choose *Typical monsoon*, cargo *Medicines*, 400 trials, and run. Walk through the tiles against the targets on slide 11:
- blockage encounters: ~16% → ~6–7%
- ETA error: ~14% → ~9%
- cold-chain breaches: more than halved
- decision latency: a few ms

Then switch the cargo to *General freight* and run again. Mean delay is no longer sacrificed: the recommendation becomes risk-neutral when the cargo is not perishable. Finally, use *Pick on map* to click two NH10 segments as injected closures, and rerun on *Teesta valley cloudburst*.

## If asked
- **"Is the data real?"** The towns, corridors, hotspots and I-D threshold are real. Terrain values are estimated and training labels are synthetic, because no public segment-level closure log exists. `docs/DATA.md` is the plan for replacing both.
- **"Why not OSRM?"** OSRM precomputes static weights. Our cost changes by the hour along the trip (time-dependent hazard), so we run a custom time-dependent Dijkstra. At state or national scale, OSRM/GraphHopper with custom weights refreshed every hour is the production path.
- **"Does the mesh really work?"** The protocol does: UUID events, a grow-only set union, and server idempotency. The transport is BroadcastChannel in the browser. On Android, the same events go over Nearby Connections (Bluetooth/Wi-Fi Direct) in a Flutter or Capacitor wrapper.
