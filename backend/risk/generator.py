"""
Synthetic "world" used to (a) generate training data and (b) act as ground truth in KPI replay.

WHY SYNTHETIC: there is no public, edge-level, time-stamped label set of "this NER road segment
was blocked in this 12 h window" yet. Building that label set (from NHIDCL/PWD closure logs,
news-scraped closures, NASA COOLR and GSI inventory) is pilot work. Until then the model is
trained on a physically-motivated generator whose structure follows the literature:

  * rainfall-triggered failure scales with exceedance of an intensity-duration threshold
    (Sikkim regional threshold I = 43.26·D^-0.78), amplified by antecedent rainfall;
  * susceptibility rises with slope and with past-failure density (landslide history);
  * river-bank alignments add toe-erosion / washout risk;
  * rail formations fail less often than hill roads (drainage, retaining works);
  * ferries are suspended when the Brahmaputra is in spate.

Driver reports are *evidence* of a latent blockage, generated after the blockage state:
a blockage that has already happened produces ~Poisson(1.4) reports (about half of the positives
in the 12 h window have not happened yet and cannot be reported); a clear road produces
~Poisson(0.06) false reports.
The model therefore learns P(blocked | physical features, reports), which is exactly what a
dispatcher needs.

Swap this module for a real label set and re-run backend/risk/train.py — nothing else changes.
"""
from __future__ import annotations

import numpy as np

from .features import FEATURES, id_ratio


def physical_logit(slope, hist, river, mode, r24, r72, r7d, f24, idr, monsoon, elev_km):
    rail = (mode == 1)
    ferry = (mode == 2)
    s = np.minimum(slope, 40)
    rain_term = 1.3 * np.log1p(np.maximum(idr - 0.8, 0)) * (s / 25)          # threshold exceedance x slope
    sat_term = 0.4 * np.log1p(r7d / 300) * (slope > 12)                       # antecedent saturation
    fcst_term = 0.006 * np.minimum(f24, 200) * (slope > 15)                   # rain still coming
    bank_term = river * 0.85 * np.log1p(r72 / 120)                            # toe erosion / washout
    flood_term = river * (slope < 8) * 2.2 * np.log1p(np.maximum(r72 - 120, 0) / 100)
    z = (-8.2 + 0.07 * slope + 0.45 * np.sqrt(hist)
         + rain_term + sat_term + fcst_term + bank_term + flood_term
         + 0.25 * monsoon + 0.1 * np.minimum(elev_km, 4))
    z = np.where(rail, z - 0.7, z)
    # ferries: suspended by high river stage (antecedent basin rain), not by slopes
    z_ferry = -4.6 + 1.9 * np.log1p(r72 / 110) + 0.3 * monsoon
    return np.where(ferry, z_ferry, z)


def sigmoid(x):
    return 1.0 / (1.0 + np.exp(-x))


def true_block_prob(X: np.ndarray) -> np.ndarray:
    """Probability a segment is blocked within 12 h, from physical features only."""
    f = {name: X[:, i] for i, name in enumerate(FEATURES)}
    z = physical_logit(f["slope_deg"], f["landslide_hist"], f["river_adjacent"], f["mode_code"],
                       f["rain_24h"], f["rain_72h"], f["rain_7d"], f["fcst_24h"], f["id_ratio"],
                       f["monsoon"], f["elevation_km"])
    return sigmoid(z)


def sample_reports(blocked: np.ndarray, rng: np.random.Generator) -> np.ndarray:
    """Only blockages that have ALREADY happened can be reported; about half of the positives
    in a 12 h window are still in the future. Clear roads get occasional false reports."""
    already = rng.random(len(blocked)) < 0.5
    lam = np.where(blocked & already, 1.4, 0.06)
    return rng.poisson(lam).astype(float)


def sample_training_set(edges: list[dict], n: int = 90_000, seed: int = 7):
    """Mix of real edges under random weather + fully random synthetic edges."""
    rng = np.random.default_rng(seed)
    rows = np.zeros((n, len(FEATURES)))

    # half the rows re-use real edge attributes (with jitter) so the model is sharp on our graph
    n_real = n // 2
    idx = rng.integers(0, len(edges), n_real)
    mode_map = {"road": 0, "rail": 1, "ferry": 2}
    for j, k in enumerate(idx):
        e = edges[k]
        rows[j, 0] = max(0, e["slope_deg"] + rng.normal(0, 2))
        rows[j, 1] = e["elevation_m"] / 1000
        rows[j, 2] = max(0, e["landslide_hist"] + rng.normal(0, 1.5))
        rows[j, 3] = 1.0 if e["river_adjacent"] else 0.0
        rows[j, 4] = mode_map[e["mode"]]
    # the other half: random terrain
    m = n - n_real
    mode = rng.choice([0, 1, 2], m, p=[0.8, 0.15, 0.05])
    rows[n_real:, 0] = np.where(mode == 2, 0, rng.gamma(2.2, 8, m).clip(0, 45))
    rows[n_real:, 1] = rng.gamma(1.5, 0.5, m).clip(0, 4.5)
    rows[n_real:, 2] = np.where(mode == 2, 0, rng.poisson(rows[n_real:, 0] / 3))
    rows[n_real:, 3] = rng.random(m) < 0.35
    rows[n_real:, 4] = mode

    # weather regimes: dry / normal monsoon / heavy / extreme
    regime = rng.choice(4, n, p=[0.3, 0.4, 0.2, 0.1])
    r24_scale = np.array([2, 25, 70, 150])[regime]
    r24 = rng.gamma(1.6, r24_scale / 1.6)
    r72 = r24 + rng.gamma(2.0, r24_scale * 1.1 / 2.0)
    r7d = r72 + rng.gamma(2.0, r24_scale * 1.8 / 2.0)
    f24 = rng.gamma(1.5, r24_scale / 1.5)
    rows[:, 5], rows[:, 6], rows[:, 7], rows[:, 8] = r24, r72, r7d, f24
    rows[:, 9] = [id_ratio(a, b) for a, b in zip(r24, r72)]
    month = np.where(regime == 0, rng.integers(1, 13, n), rng.integers(5, 10, n))
    rows[:, 11] = ((month >= 6) & (month <= 9)).astype(float)

    p = true_block_prob(rows)
    y = rng.random(n) < p
    rows[:, 10] = sample_reports(y, rng)
    return rows, y.astype(int), p
