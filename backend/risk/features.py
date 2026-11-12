"""
Feature builder: turns raw layers (edge terrain, rainfall, live reports, season) into the
edge-level feature vector used by the hazard model H(e, t).
"""
from __future__ import annotations

import math

FEATURES = [
    "slope_deg",        # mean slope of the cut / hillside the road runs on
    "elevation_km",     # max elevation of the segment
    "landslide_hist",   # mapped slides within ~1 km (1998-2022)
    "river_adjacent",   # 1 if the road bed follows a river bank (toe erosion, flood)
    "mode_code",        # 0 road, 1 rail, 2 ferry
    "rain_24h",
    "rain_72h",
    "rain_7d",
    "fcst_24h",
    "id_ratio",         # rainfall / Sikkim intensity-duration threshold (max over D=1,3 days)
    "reports_6h",       # weighted driver reports on this edge in the last 6 h
    "monsoon",          # 1 during June-September
]

MODE_CODE = {"road": 0, "rail": 1, "ferry": 2}

# Regional intensity–duration threshold for rainfall-induced landslides in Sikkim:
#   I = 43.26 · D^-0.78   (I in mm/day, D in days)  — Harilal et al., Landslides (2019)
ID_ALPHA, ID_BETA = 43.26, -0.78


def id_threshold(days: float) -> float:
    return ID_ALPHA * days ** ID_BETA


def id_ratio(rain_24h: float, rain_72h: float, rain_7d: float | None = None) -> float:
    """Exceedance of the I-D threshold for 1-day and 3-day events (max of the two).
    The 7-day total enters the model separately as a soil-saturation feature."""
    r1 = rain_24h / id_threshold(1)
    r3 = (rain_72h / 3) / id_threshold(3)
    return max(r1, r3)


def shift_rain(rain: dict, hours: float) -> dict:
    """Roll the rainfall window forward by `hours` using the 24 h forecast (uniform rate)."""
    if hours <= 0:
        return dict(rain)
    h = min(hours, 24.0)
    f_rate = rain["fcst_24h"] / 24.0
    return dict(
        rain_24h=rain["rain_24h"] * (1 - h / 24) + f_rate * h,
        rain_72h=rain["rain_72h"] * (1 - h / 72) + f_rate * h,
        rain_7d=rain["rain_7d"] * (1 - h / 168) + f_rate * h,
        fcst_24h=rain["fcst_24h"],   # we don't know beyond +24 h; hold constant
    )


def build_row(edge: dict, rain: dict, reports_6h: float, month: int) -> list[float]:
    return [
        float(edge["slope_deg"]),
        edge["elevation_m"] / 1000.0,
        float(edge["landslide_hist"]),
        1.0 if edge["river_adjacent"] else 0.0,
        float(MODE_CODE[edge["mode"]]),
        rain["rain_24h"],
        rain["rain_72h"],
        rain["rain_7d"],
        rain["fcst_24h"],
        id_ratio(rain["rain_24h"], rain["rain_72h"], rain["rain_7d"]),
        float(reports_6h),
        1.0 if 6 <= month <= 9 else 0.0,
    ]


def delay_if_blocked_h(edge: dict, rain: dict) -> float:
    """Expected hours lost if the edge is blocked when the vehicle reaches it.

    Calibrated loosely on reported clearance times: small NH6/NH37 slides are cleared in
    hours to a day; large Teesta-bank failures on NH10 closed the road for ~6 days.
    """
    if edge["mode"] == "ferry":
        return 10.0 + rain["rain_72h"] / 40
    base = 3.0 + 0.35 * edge["slope_deg"] + 1.6 * math.sqrt(edge["landslide_hist"])
    if edge["river_adjacent"] and rain["rain_72h"] > 150:
        base += 10.0      # bank erosion / washout, not just debris
    if edge["mode"] == "rail":
        base *= 2.2       # track restoration is slower than debris clearance
    return round(min(base, 96.0), 1)
