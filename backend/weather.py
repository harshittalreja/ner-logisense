"""
Rainfall inputs for the hazard model.

Two sources:
  1. Replayable scenarios (default; deterministic, work offline, used for demos and KPI replay).
  2. Live rainfall from Open-Meteo (free, no API key, CORS-enabled). Stand-in for IMD gridded
     rainfall / IMD district nowcasts, which need institutional access.

Each met zone gets four numbers (mm):
  rain_24h  – observed last 24 h
  rain_72h  – observed last 72 h (antecedent)
  rain_7d   – observed last 7 days (soil saturation proxy)
  fcst_24h  – forecast next 24 h
"""
from __future__ import annotations

import time
from datetime import datetime, timezone

import httpx

OPEN_METEO_URL = "https://api.open-meteo.com/v1/forecast"


def _z(r24, r72, r7d, f24):
    return dict(rain_24h=float(r24), rain_72h=float(r72), rain_7d=float(r7d), fcst_24h=float(f24))


# Magnitudes are illustrative. The two "replay" scenarios reproduce the *pattern* of real events
# (which zones were hit, roughly how hard) so the KPI replay has realistic spatial structure.
SCENARIOS: dict[str, dict] = {
    "dry_winter": dict(
        label="Dry season (January)", month=1,
        description="Little rain anywhere; residual risk only from terrain and history.",
        default=_z(1, 3, 6, 1),
        zones={"TW": _z(4, 10, 18, 6), "WK": _z(3, 6, 12, 4)},
    ),
    "normal_monsoon": dict(
        label="Typical monsoon day (July)", month=7,
        description="Widespread moderate rain; hill segments carry elevated but manageable risk.",
        default=_z(22, 65, 150, 25),
        zones={"ML": _z(40, 110, 260, 45), "SK": _z(30, 85, 190, 35), "BV": _z(28, 80, 170, 30),
               "DH": _z(30, 85, 180, 32), "MZ": _z(26, 70, 150, 28)},
    ),
    "barak_extreme": dict(
        label="Replay: Barak / Dima Hasao extreme rain (May 2022 pattern)", month=5,
        description="Days of extreme rain over Dima Hasao, Barak valley, Meghalaya and Manipur; "
                    "NH27, NH6, NH37 and the Lumding-Badarpur line are all under threat.",
        default=_z(18, 55, 120, 20),
        zones={"DH": _z(165, 390, 620, 140), "BV": _z(135, 330, 520, 110), "ML": _z(150, 360, 600, 120),
               "MN": _z(95, 240, 400, 80), "MZ": _z(90, 230, 380, 75), "TR": _z(70, 180, 300, 60),
               "CA": _z(60, 150, 260, 50), "NL": _z(55, 140, 240, 45)},
    ),
    "teesta_extreme": dict(
        label="Replay: Teesta valley cloudburst (Aug 2025 pattern)", month=8,
        description="Very heavy rain over Sikkim and the Darjeeling-Kalimpong hills; NH10 slides "
                    "at Chitrey / Selfie Dara, NH717A under pressure.",
        default=_z(20, 60, 140, 22),
        zones={"SK": _z(175, 410, 640, 150), "NB": _z(110, 260, 420, 90)},
    ),
    "kameng_extreme": dict(
        label="Arunachal West Kameng heavy rain (pre-monsoon)", month=6,
        description="Heavy rain on NH13 between Bhalukpong and Tawang; north-bank rivers in spate.",
        default=_z(15, 45, 100, 18),
        zones={"WK": _z(140, 330, 520, 120), "TW": _z(90, 220, 360, 70), "NBK": _z(80, 200, 330, 60),
               "AR": _z(100, 240, 380, 80)},
    ),
}


class WeatherState:
    """Holds the rainfall currently fed to the hazard model."""

    def __init__(self, zones: list[dict]):
        self.zone_defs = zones
        self.source = "scenario"
        self.scenario = "normal_monsoon"
        self.fetched_at = time.time()
        self.month = 7
        self.values: dict[str, dict] = {}
        self.error: str | None = None
        self.set_scenario("normal_monsoon")

    # ---------------------------------------------------------------- scenarios
    def set_scenario(self, key: str):
        if key not in SCENARIOS:
            raise KeyError(key)
        sc = SCENARIOS[key]
        self.values = {z["id"]: dict(sc["zones"].get(z["id"], sc["default"])) for z in self.zone_defs}
        self.source = "scenario"
        self.scenario = key
        self.month = sc["month"]
        self.fetched_at = time.time()
        self.error = None

    # ---------------------------------------------------------------- live data
    def fetch_live(self, timeout: float = 8.0) -> bool:
        """Pull 7-day history + 24 h forecast for every zone in one Open-Meteo call."""
        lats = ",".join(str(z["lat"]) for z in self.zone_defs)
        lons = ",".join(str(z["lon"]) for z in self.zone_defs)
        params = dict(latitude=lats, longitude=lons, hourly="precipitation",
                      past_days=7, forecast_days=2, timezone="UTC")
        try:
            r = httpx.get(OPEN_METEO_URL, params=params, timeout=timeout)
            r.raise_for_status()
            data = r.json()
            if isinstance(data, dict):
                data = [data]
            now = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0)
            now_key = now.strftime("%Y-%m-%dT%H:%M")
            values = {}
            for z, d in zip(self.zone_defs, data):
                times = d["hourly"]["time"]
                precip = [p or 0.0 for p in d["hourly"]["precipitation"]]
                i = times.index(now_key) if now_key in times else len(times) // 2
                past = precip[:i + 1]
                values[z["id"]] = _z(sum(past[-24:]), sum(past[-72:]), sum(past[-168:]),
                                     sum(precip[i + 1:i + 25]))
            self.values = values
            self.source = "open-meteo"
            self.scenario = "live"
            self.month = datetime.now(timezone.utc).month
            self.fetched_at = time.time()
            self.error = None
            return True
        except Exception as exc:  # network blocked, API down, schema change …
            self.error = f"{type(exc).__name__}: {exc}"[:300]
            return False

    # ---------------------------------------------------------------- helpers
    def for_edge(self, met_zones: list[str]) -> dict:
        """Hazard-conservative: use the wettest zone the edge touches."""
        vals = [self.values[z] for z in met_zones if z in self.values]
        if not vals:
            return _z(0, 0, 0, 0)
        return {k: max(v[k] for v in vals) for k in vals[0]}

    def freshness(self) -> dict:
        age_min = (time.time() - self.fetched_at) / 60
        if self.source == "open-meteo":
            score = 1.0 if age_min < 180 else 0.6
        else:
            score = 0.8   # scenario data is exact by construction, but not observed
        return dict(source=self.source, scenario=self.scenario, age_min=round(age_min, 1),
                    score=score, error=self.error,
                    label=SCENARIOS.get(self.scenario, {}).get("label", "Live rainfall (Open-Meteo)"))

    def snapshot(self) -> dict:
        return dict(freshness=self.freshness(), month=self.month,
                    zones=[dict(z, **self.values.get(z["id"], {})) for z in self.zone_defs],
                    scenarios=[dict(id=k, label=v["label"], description=v["description"])
                               for k, v in SCENARIOS.items()])
