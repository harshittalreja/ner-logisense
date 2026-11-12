"""
Builds backend/data/network.json — the prototype corridor graph for Northeast India.

WHAT IS REAL
  * Towns, junctions, national-highway numbers and the corridor structure
    (NH10 Teesta valley, NH6 via Sonapur, NH27 East-West corridor through Dima Hasao,
    NH2/NH29 via Kohima, NH37 via Noney, NH306 to Aizawl, NH8 to Agartala,
    NH13 over Sela, the Lumding-Badarpur and Bairabi-Sairang rail lines,
    IWAI ferries at Dhubri and Majuli).
  * Chronic slide / flood hotspots named in news and GSI reporting
    (Chitrey & Selfie Dara on NH10, Sonapur on NH6, Dima Hasao on NH27,
    Pagla Pahar on NH29, Noney on NH37, Kaziranga flood stretch on NH715).

WHAT IS ESTIMATED (replace in a pilot)
  * Coordinates are town-level (±2 km). Edge geometry is town-to-town, not OSM polylines.
  * Length = haversine × sinuosity factor for the terrain class.
  * Slope, elevation and landslide-history counts are expert estimates chosen to be
    consistent with the NRSC Landslide Atlas pattern, NOT derived from a DEM or inventory.
    See docs/DATA.md for the pipeline that replaces them with SRTM / CartoDEM slope,
    NASA COOLR + GSI inventory counts and OSM road geometry.

Run:  python -m backend.data.build_network
"""
import json
import math
from pathlib import Path

# id: (name, state, lat, lon, elev_m, kind, met_zone)
# kind: hub (warehouse / dispatch), town, junction, rail (station only), ferry (ghat)
NODES = {
    # --- North Bengal gateway & Sikkim -------------------------------------------------
    "SLG": ("Siliguri", "West Bengal", 26.727, 88.395, 120, "hub", "NB"),
    "SVK": ("Sevoke (Coronation Br.)", "West Bengal", 26.905, 88.472, 150, "junction", "NB"),
    "TBZ": ("Teesta Bazar", "West Bengal", 27.064, 88.435, 250, "town", "SK"),
    "MLI": ("Melli", "Sikkim", 27.100, 88.470, 300, "town", "SK"),
    "RNP": ("Rangpo", "Sikkim", 27.176, 88.530, 330, "town", "SK"),
    "SNG": ("Singtam", "Sikkim", 27.233, 88.497, 450, "town", "SK"),
    "GTK": ("Gangtok", "Sikkim", 27.330, 88.612, 1650, "hub", "SK"),
    "KLP": ("Kalimpong", "West Bengal", 27.060, 88.470, 1250, "town", "SK"),
    "MAL": ("Malbazar", "West Bengal", 26.850, 88.740, 150, "town", "NB"),
    "GRB": ("Gorubathan", "West Bengal", 26.970, 88.700, 300, "town", "NB"),
    "LAV": ("Lava", "West Bengal", 27.087, 88.664, 2150, "town", "SK"),
    "PDG": ("Pedong", "West Bengal", 27.155, 88.610, 1400, "town", "SK"),
    "RNK": ("Rhenock", "Sikkim", 27.180, 88.645, 1100, "town", "SK"),
    "PKY": ("Pakyong", "Sikkim", 27.230, 88.590, 1400, "town", "SK"),
    # --- Bengal - Lower Assam --------------------------------------------------------------
    "DHP": ("Dhupguri", "West Bengal", 26.590, 89.010, 90, "town", "NB"),
    "SRP": ("Srirampur Gate", "Assam", 26.440, 89.930, 50, "junction", "LA"),
    "BNG": ("Bongaigaon", "Assam", 26.480, 90.560, 60, "town", "LA"),
    "DHB": ("Dhubri Ghat", "Assam", 26.020, 89.980, 30, "ferry", "LA"),
    "HTS": ("Hatsingimari Ghat", "Assam", 25.870, 89.990, 30, "ferry", "GH"),
    "TUR": ("Tura", "Meghalaya", 25.510, 90.220, 350, "town", "GH"),
    "GLP": ("Goalpara", "Assam", 26.170, 90.620, 50, "town", "LA"),
    "GHY": ("Guwahati", "Assam", 26.144, 91.736, 55, "hub", "LA"),
    "JRB": ("Jorabat", "Assam", 26.107, 91.860, 60, "junction", "LA"),
    # --- Meghalaya NH6 to Barak valley -----------------------------------------------------
    "NGP": ("Nongpoh", "Meghalaya", 25.900, 91.880, 500, "town", "ML"),
    "UMI": ("Umiam", "Meghalaya", 25.670, 91.890, 1000, "town", "ML"),
    "SHL": ("Shillong", "Meghalaya", 25.570, 91.880, 1500, "hub", "ML"),
    "JWI": ("Jowai", "Meghalaya", 25.450, 92.200, 1380, "town", "ML"),
    "KHL": ("Khliehriat", "Meghalaya", 25.360, 92.370, 1200, "town", "ML"),
    "SNP": ("Sonapur", "Meghalaya", 25.130, 92.430, 600, "town", "ML"),
    "RTC": ("Ratacherra", "Assam", 24.990, 92.520, 60, "town", "BV"),
    "BDP": ("Badarpur", "Assam", 24.868, 92.595, 20, "junction", "BV"),
    "SCR": ("Silchar", "Assam", 24.827, 92.797, 22, "hub", "BV"),
    "KMJ": ("Karimganj", "Assam", 24.870, 92.360, 15, "town", "BV"),
    # --- East-West corridor (NH27) through Dima Hasao -------------------------------------
    "NGN": ("Nagaon", "Assam", 26.350, 92.680, 60, "town", "CA"),
    "LNK": ("Lanka", "Assam", 25.930, 92.950, 80, "town", "CA"),
    "MBG": ("Maibang", "Assam", 25.300, 93.130, 350, "town", "DH"),
    "HRJ": ("Harangajao", "Assam", 25.100, 92.870, 600, "town", "DH"),
    "BLC": ("Balacherra", "Assam", 24.960, 92.850, 50, "town", "BV"),
    "LMD": ("Lumding Jn", "Assam", 25.750, 93.170, 150, "rail", "CA"),
    "NHF": ("New Haflong", "Assam", 25.170, 93.020, 700, "rail", "DH"),
    # --- Upper Assam & Nagaland ------------------------------------------------------------
    "DBK": ("Doboka", "Assam", 26.100, 92.930, 70, "town", "CA"),
    "BKJ": ("Bokajan", "Assam", 26.020, 93.770, 120, "town", "CA"),
    "DMR": ("Dimapur", "Nagaland", 25.906, 93.727, 150, "hub", "NL"),
    "GLG": ("Golaghat", "Assam", 26.520, 93.970, 90, "town", "UA"),
    "JRT": ("Jorhat", "Assam", 26.750, 94.200, 100, "town", "UA"),
    "SVS": ("Sivasagar", "Assam", 26.980, 94.640, 95, "town", "UA"),
    "DBR": ("Dibrugarh", "Assam", 27.470, 94.910, 110, "hub", "UA"),
    "KLB": ("Kaliabor", "Assam", 26.550, 92.990, 70, "junction", "CA"),
    "KZR": ("Kaziranga (Bokakhat)", "Assam", 26.640, 93.600, 80, "town", "UA"),
    "NMT": ("Neamati Ghat", "Assam", 26.830, 94.250, 90, "ferry", "UA"),
    "KMB": ("Kamalabari (Majuli)", "Assam", 26.950, 94.170, 85, "ferry", "UA"),
    "CHM": ("Chumoukedima", "Nagaland", 25.790, 93.780, 200, "town", "NL"),
    "PPH": ("Pagla Pahar", "Nagaland", 25.730, 93.930, 500, "town", "NL"),
    "KOH": ("Kohima", "Nagaland", 25.670, 94.110, 1440, "town", "NL"),
    # --- Manipur ---------------------------------------------------------------------------
    "MAO": ("Mao", "Manipur", 25.520, 94.140, 1800, "town", "MN"),
    "SPT": ("Senapati", "Manipur", 25.270, 94.020, 1100, "town", "MN"),
    "KGK": ("Kangpokpi", "Manipur", 25.140, 93.970, 1000, "town", "MN"),
    "IMP": ("Imphal", "Manipur", 24.810, 93.940, 790, "hub", "MN"),
    "JRI": ("Jiribam", "Manipur", 24.800, 93.120, 40, "town", "BV"),
    "NGB": ("Nungba", "Manipur", 24.770, 93.430, 400, "town", "MN"),
    "NNY": ("Noney", "Manipur", 24.860, 93.610, 800, "town", "MN"),
    # --- Mizoram ---------------------------------------------------------------------------
    "VRT": ("Vairengte", "Mizoram", 24.500, 92.750, 100, "town", "MZ"),
    "KLS": ("Kolasib", "Mizoram", 24.220, 92.680, 600, "town", "MZ"),
    "AZL": ("Aizawl", "Mizoram", 23.730, 92.720, 1100, "hub", "MZ"),
    "BRB": ("Bairabi", "Mizoram", 24.190, 92.530, 50, "rail", "MZ"),
    "SRG": ("Sairang", "Mizoram", 23.810, 92.660, 150, "rail", "MZ"),
    # --- Tripura ---------------------------------------------------------------------------
    "CHB": ("Churaibari", "Tripura", 24.430, 92.230, 30, "town", "TR"),
    "DMN": ("Dharmanagar", "Tripura", 24.370, 92.170, 30, "town", "TR"),
    "KMG": ("Kumarghat", "Tripura", 24.160, 92.030, 30, "town", "TR"),
    "AMB": ("Ambassa", "Tripura", 23.930, 91.850, 400, "town", "TR"),
    "TLM": ("Teliamura", "Tripura", 23.840, 91.630, 100, "town", "TR"),
    "AGT": ("Agartala", "Tripura", 23.830, 91.280, 15, "hub", "TR"),
    # --- North bank & Arunachal ------------------------------------------------------------
    "MGD": ("Mangaldoi", "Assam", 26.440, 92.030, 50, "town", "LA"),
    "TZP": ("Tezpur", "Assam", 26.630, 92.800, 80, "town", "NBK"),
    "BLP": ("Balipara", "Assam", 26.830, 92.780, 100, "junction", "NBK"),
    "BHK": ("Bhalukpong", "Arunachal Pradesh", 27.010, 92.650, 200, "town", "WK"),
    "BMD": ("Bomdila", "Arunachal Pradesh", 27.260, 92.410, 2400, "town", "WK"),
    "DRG": ("Dirang", "Arunachal Pradesh", 27.360, 92.240, 1500, "town", "WK"),
    "SLA": ("Sela Tunnel", "Arunachal Pradesh", 27.500, 92.100, 4000, "junction", "TW"),
    "TWG": ("Tawang", "Arunachal Pradesh", 27.586, 91.866, 2700, "town", "TW"),
    "GHP": ("Gohpur", "Assam", 26.880, 93.620, 90, "town", "NBK"),
    "ITN": ("Itanagar", "Arunachal Pradesh", 27.090, 93.610, 400, "hub", "AR"),
    "NLK": ("North Lakhimpur", "Assam", 27.240, 94.100, 100, "town", "NBK"),
    "DMJ": ("Dhemaji", "Assam", 27.480, 94.580, 110, "town", "UA"),
    "PSG": ("Pasighat", "Arunachal Pradesh", 28.070, 95.330, 150, "town", "AR"),
}

# Rainfall zones: one representative point each, used for Open-Meteo and scenarios.
MET_ZONES = {
    "NB": ("North Bengal Duars", 26.80, 88.60),
    "SK": ("Sikkim / Teesta valley", 27.20, 88.55),
    "LA": ("Lower Assam", 26.25, 91.20),
    "GH": ("Garo Hills", 25.60, 90.20),
    "ML": ("Khasi-Jaintia Hills", 25.40, 92.10),
    "BV": ("Barak valley", 24.85, 92.70),
    "CA": ("Central Assam", 26.10, 92.90),
    "DH": ("Dima Hasao", 25.30, 92.85),
    "NL": ("Nagaland foothills & Kohima", 25.75, 93.90),
    "UA": ("Upper Assam", 26.90, 94.40),
    "MN": ("Manipur hills", 24.95, 93.70),
    "MZ": ("Mizoram", 24.00, 92.70),
    "TR": ("Tripura", 24.00, 91.80),
    "NBK": ("North bank Assam", 26.85, 93.30),
    "WK": ("West Kameng", 27.20, 92.50),
    "TW": ("Tawang", 27.55, 92.00),
    "AR": ("Central Arunachal", 27.50, 94.20),
}

# Edges: (a, b, mode, route_ref, road_class, terrain, slope_deg, landslide_hist, river, no_network, note)
#   road_class: NH | SH | ODR (other district road) | RAIL | FERRY
#   terrain: plain | hill | mountain
#   landslide_hist: mapped slide events within ~1 km buffer, 1998-2022 (ESTIMATE)
#   river: adjacent river that drives flood / toe-erosion risk ('' if none)
EDGES = [
    # NH10 Teesta valley (primary Sikkim lifeline)
    ("SLG", "SVK", "road", "NH10", "NH", "plain", 4, 1, "", False, ""),
    ("SVK", "TBZ", "road", "NH10", "NH", "hill", 33, 26, "Teesta", True,
     "Chitrey · Selfie Dara slide zone; road bed on Teesta bank"),
    ("TBZ", "MLI", "road", "NH10", "NH", "hill", 30, 14, "Teesta", False, "29th Mile slide belt"),
    ("MLI", "RNP", "road", "NH10", "NH", "hill", 27, 9, "Teesta", False, ""),
    ("RNP", "SNG", "road", "NH10", "NH", "hill", 25, 7, "Teesta", False, ""),
    ("SNG", "GTK", "road", "NH10", "NH", "hill", 26, 8, "", False, ""),
    # NH717A alternate via Lava (the standard NH10 bypass)
    ("SLG", "MAL", "road", "NH27", "NH", "plain", 3, 0, "", False, ""),
    ("MAL", "GRB", "road", "NH717A", "NH", "hill", 14, 2, "", False, ""),
    ("GRB", "LAV", "road", "NH717A", "NH", "mountain", 29, 6, "", True, "Narrow single-lane climb; fog"),
    ("LAV", "PDG", "road", "NH717A", "NH", "mountain", 27, 5, "", True, ""),
    ("PDG", "RNK", "road", "NH717A", "NH", "hill", 24, 3, "", False, ""),
    ("RNK", "PKY", "road", "NH717A", "NH", "hill", 22, 3, "", False, ""),
    ("PKY", "GTK", "road", "NH717A", "NH", "hill", 21, 2, "", False, ""),
    ("TBZ", "KLP", "road", "NH717", "NH", "hill", 28, 8, "", False, ""),
    ("KLP", "PDG", "road", "SH", "SH", "hill", 26, 5, "", False, "Algarah road"),
    # Siliguri - Guwahati (NH27) and Dhubri ferry branch
    ("SLG", "DHP", "road", "NH27", "NH", "plain", 2, 0, "Teesta", False, ""),
    ("DHP", "SRP", "road", "NH27", "NH", "plain", 2, 0, "Torsa", False, ""),
    ("SRP", "BNG", "road", "NH27", "NH", "plain", 2, 0, "", False, ""),
    ("BNG", "GHY", "road", "NH27", "NH", "plain", 3, 0, "Brahmaputra", False, ""),
    ("SRP", "DHB", "road", "NH17", "NH", "plain", 2, 0, "Brahmaputra", False, ""),
    ("DHB", "HTS", "ferry", "IWAI NW-2", "FERRY", "plain", 0, 0, "Brahmaputra", False,
     "Dhubri-Hatsingimari ro-ro ferry"),
    ("HTS", "TUR", "road", "NH127B", "NH", "hill", 13, 2, "", False, ""),
    ("GHY", "GLP", "road", "NH17", "NH", "plain", 3, 0, "Brahmaputra", False, ""),
    ("GLP", "TUR", "road", "NH217", "NH", "hill", 17, 4, "", False, ""),
    # Guwahati - Shillong - Silchar (NH6) via Sonapur
    ("GHY", "JRB", "road", "NH27", "NH", "plain", 4, 1, "", False, "Guwahati city traffic"),
    ("JRB", "NGP", "road", "NH6", "NH", "hill", 15, 4, "", False, ""),
    ("NGP", "UMI", "road", "NH6", "NH", "hill", 20, 6, "", False, ""),
    ("UMI", "SHL", "road", "NH6", "NH", "hill", 18, 5, "", False, ""),
    ("SHL", "JWI", "road", "NH6", "NH", "hill", 16, 3, "", False, ""),
    ("JWI", "KHL", "road", "NH6", "NH", "hill", 19, 5, "", False, ""),
    ("KHL", "SNP", "road", "NH6", "NH", "mountain", 34, 22, "Lubha", True,
     "Sonapur tunnel approaches - chronic slides"),
    ("SNP", "RTC", "road", "NH6", "NH", "hill", 27, 11, "", False, ""),
    ("RTC", "BDP", "road", "NH6", "NH", "plain", 5, 1, "Barak", False, ""),
    ("BDP", "SCR", "road", "NH37", "NH", "plain", 3, 0, "Barak", False, ""),
    ("BDP", "KMJ", "road", "NH8", "NH", "plain", 3, 0, "Kushiyara", False, ""),
    # East-West corridor NH27 through Dima Hasao
    ("JRB", "NGN", "road", "NH27", "NH", "plain", 3, 0, "", False, ""),
    ("NGN", "LNK", "road", "NH27", "NH", "plain", 5, 1, "Kopili", False, ""),
    ("LNK", "MBG", "road", "NH27", "NH", "hill", 18, 6, "Kopili", False, ""),
    ("MBG", "HRJ", "road", "NH27", "NH", "mountain", 32, 24, "Jatinga", True,
     "Dima Hasao - May 2022 cluster; cut NH27 and rail"),
    ("HRJ", "BLC", "road", "NH27", "NH", "hill", 28, 15, "Jatinga", True, "Jatinga descent"),
    ("BLC", "SCR", "road", "NH27", "NH", "plain", 4, 1, "Barak", False, ""),
    # Central / Upper Assam, Nagaland
    ("NGN", "DBK", "road", "NH27", "NH", "plain", 3, 0, "", False, ""),
    ("DBK", "BKJ", "road", "NH29", "NH", "plain", 5, 1, "Dhansiri", False, ""),
    ("BKJ", "DMR", "road", "NH29", "NH", "plain", 4, 0, "Dhansiri", False, ""),
    ("NGN", "KLB", "road", "NH715", "NH", "plain", 2, 0, "Brahmaputra", False, ""),
    ("KLB", "TZP", "road", "NH715", "NH", "plain", 2, 0, "Brahmaputra", False, "Kolia Bhomora bridge"),
    ("KLB", "KZR", "road", "NH715", "NH", "plain", 2, 0, "Brahmaputra", False,
     "Kaziranga flood stretch; animal-corridor speed limits"),
    ("KZR", "JRT", "road", "NH715", "NH", "plain", 2, 0, "Dhansiri", False, ""),
    ("DMR", "GLG", "road", "NH129", "NH", "plain", 3, 0, "Dhansiri", False, ""),
    ("GLG", "JRT", "road", "NH715", "NH", "plain", 2, 0, "", False, ""),
    ("JRT", "SVS", "road", "NH715", "NH", "plain", 2, 0, "", False, ""),
    ("SVS", "DBR", "road", "NH37", "NH", "plain", 2, 0, "Brahmaputra", False, ""),
    ("JRT", "NMT", "road", "ODR", "ODR", "plain", 1, 0, "Brahmaputra", False, ""),
    ("NMT", "KMB", "ferry", "IWAI NW-2", "FERRY", "plain", 0, 0, "Brahmaputra", False,
     "Neamati-Majuli ferry"),
    ("DMR", "CHM", "road", "NH29", "NH", "plain", 6, 1, "", False, ""),
    ("CHM", "PPH", "road", "NH29", "NH", "hill", 30, 18, "", True, "Pagla Pahar - recurring sinking & slides"),
    ("PPH", "KOH", "road", "NH29", "NH", "hill", 27, 11, "", False, ""),
    # Manipur: NH2 via Kohima and NH37 via Jiribam
    ("KOH", "MAO", "road", "NH2", "NH", "mountain", 25, 8, "", False, "Mao gate - blockades & slides"),
    ("MAO", "SPT", "road", "NH2", "NH", "hill", 22, 6, "", False, ""),
    ("SPT", "KGK", "road", "NH2", "NH", "hill", 20, 5, "", False, ""),
    ("KGK", "IMP", "road", "NH2", "NH", "hill", 14, 3, "", False, ""),
    ("SCR", "JRI", "road", "NH37", "NH", "plain", 6, 2, "Barak", False, ""),
    ("JRI", "NGB", "road", "NH37", "NH", "mountain", 31, 17, "Irang", True, ""),
    ("NGB", "NNY", "road", "NH37", "NH", "mountain", 33, 21, "Ijei", True, "Noney - repeated NH37 cuts"),
    ("NNY", "IMP", "road", "NH37", "NH", "hill", 24, 9, "", False, ""),
    # Mizoram NH306 and new Bairabi-Sairang rail
    ("SCR", "VRT", "road", "NH306", "NH", "plain", 8, 3, "Dhaleswari", False, ""),
    ("VRT", "KLS", "road", "NH306", "NH", "hill", 26, 12, "", False, ""),
    ("KLS", "AZL", "road", "NH306", "NH", "hill", 30, 16, "Tlawng", True, "NH306 sinking zones"),
    ("SRG", "AZL", "road", "NH306", "NH", "hill", 22, 5, "", False, "Sairang railhead to Aizawl"),
    # Tripura NH8 (the state's single road lifeline)
    ("KMJ", "CHB", "road", "NH8", "NH", "plain", 5, 1, "", False, ""),
    ("CHB", "DMN", "road", "NH8", "NH", "plain", 4, 0, "", False, ""),
    ("DMN", "KMG", "road", "NH8", "NH", "plain", 6, 1, "Manu", False, ""),
    ("KMG", "AMB", "road", "NH8", "NH", "hill", 19, 6, "", False, "Atharamura range"),
    ("AMB", "TLM", "road", "NH8", "NH", "hill", 22, 8, "", True, "Atharamura range"),
    ("TLM", "AGT", "road", "NH8", "NH", "plain", 6, 1, "Haora", False, ""),
    # North bank & Arunachal
    ("GHY", "MGD", "road", "NH15", "NH", "plain", 2, 0, "Brahmaputra", False, "Saraighat bridge"),
    ("MGD", "TZP", "road", "NH15", "NH", "plain", 2, 0, "", False, ""),
    ("TZP", "BLP", "road", "NH15", "NH", "plain", 2, 0, "", False, ""),
    ("BLP", "BHK", "road", "NH13", "NH", "plain", 5, 1, "Kameng", False, ""),
    ("BHK", "BMD", "road", "NH13", "NH", "mountain", 30, 13, "Kameng", True, ""),
    ("BMD", "DRG", "road", "NH13", "NH", "mountain", 28, 9, "", False, ""),
    ("DRG", "SLA", "road", "NH13", "NH", "mountain", 29, 7, "", True, "Sela tunnel; snow Dec-Mar"),
    ("SLA", "TWG", "road", "NH13", "NH", "mountain", 26, 8, "", True, ""),
    ("TZP", "GHP", "road", "NH15", "NH", "plain", 2, 0, "", False, ""),
    ("GHP", "ITN", "road", "NH415", "NH", "hill", 17, 5, "", False, ""),
    ("GHP", "NLK", "road", "NH15", "NH", "plain", 2, 0, "Ranganadi", False, ""),
    ("NLK", "DMJ", "road", "NH15", "NH", "plain", 2, 0, "Subansiri", False, "Frequent flood breaches"),
    ("DMJ", "DBR", "road", "NH515", "NH", "plain", 1, 0, "Brahmaputra", False, "Bogibeel bridge"),
    ("DMJ", "PSG", "road", "NH515", "NH", "plain", 5, 2, "Siang", False, ""),
    # Rail (freight). Lumding-Badarpur hill section crosses Dima Hasao.
    ("SLG", "BNG", "rail", "NFR NJP-NBQ", "RAIL", "plain", 1, 0, "", False, ""),
    ("BNG", "GHY", "rail", "NFR NBQ-GHY", "RAIL", "plain", 1, 0, "", False, ""),
    ("GHY", "LMD", "rail", "NFR GHY-LMG", "RAIL", "plain", 2, 0, "", False, ""),
    ("LMD", "DMR", "rail", "NFR LMG-DMV", "RAIL", "plain", 2, 0, "", False, ""),
    ("DMR", "JRT", "rail", "NFR DMV-JTTN", "RAIL", "plain", 1, 0, "", False, ""),
    ("JRT", "DBR", "rail", "NFR JTTN-DBRG", "RAIL", "plain", 1, 0, "", False, ""),
    ("LMD", "NHF", "rail", "NFR Hill Section", "RAIL", "mountain", 24, 19, "Jatinga", True,
     "Lumding-Badarpur hill section; cut for weeks in 2022"),
    ("NHF", "BDP", "rail", "NFR Hill Section", "RAIL", "hill", 22, 14, "Jatinga", True, ""),
    ("BDP", "SCR", "rail", "NFR BPB-SCL", "RAIL", "plain", 1, 0, "", False, ""),
    ("BDP", "DMN", "rail", "NFR BPB-DMR", "RAIL", "plain", 3, 1, "", False, ""),
    ("DMN", "AGT", "rail", "NFR DMR-AGTL", "RAIL", "hill", 10, 3, "", False, ""),
    ("SCR", "BRB", "rail", "NFR Katakhal-Bairabi", "RAIL", "plain", 4, 1, "", False, ""),
    ("BRB", "SRG", "rail", "NFR Bairabi-Sairang", "RAIL", "hill", 12, 3, "", False,
     "Opened Sept 2025; tunnel-heavy alignment"),
]

# Corridors for the authority dashboard: ordered node chains (road only).
CORRIDORS = [
    ("NH10", "Siliguri – Gangtok (NH10 Teesta valley)", ["SLG", "SVK", "TBZ", "MLI", "RNP", "SNG", "GTK"]),
    ("NH717A", "Siliguri – Gangtok bypass (NH717A via Lava)", ["SLG", "MAL", "GRB", "LAV", "PDG", "RNK", "PKY", "GTK"]),
    ("NH27W", "Siliguri – Guwahati (NH27)", ["SLG", "DHP", "SRP", "BNG", "GHY"]),
    ("NH6", "Guwahati – Shillong – Silchar (NH6 via Sonapur)", ["GHY", "JRB", "NGP", "UMI", "SHL", "JWI", "KHL", "SNP", "RTC", "BDP", "SCR"]),
    ("NH27E", "Nagaon – Silchar (NH27 through Dima Hasao)", ["JRB", "NGN", "LNK", "MBG", "HRJ", "BLC", "SCR"]),
    ("NH29", "Dimapur – Kohima – Imphal (NH29 / NH2)", ["DMR", "CHM", "PPH", "KOH", "MAO", "SPT", "KGK", "IMP"]),
    ("NH37M", "Silchar – Jiribam – Imphal (NH37)", ["SCR", "JRI", "NGB", "NNY", "IMP"]),
    ("NH306", "Silchar – Aizawl (NH306)", ["SCR", "VRT", "KLS", "AZL"]),
    ("NH8", "Karimganj – Agartala (NH8)", ["BDP", "KMJ", "CHB", "DMN", "KMG", "AMB", "TLM", "AGT"]),
    ("NH13", "Tezpur – Tawang (NH13 via Sela)", ["TZP", "BLP", "BHK", "BMD", "DRG", "SLA", "TWG"]),
    ("NH715", "Nagaon – Jorhat – Dibrugarh (NH715 / NH37)", ["NGN", "KLB", "KZR", "JRT", "SVS", "DBR"]),
    ("NH15", "Guwahati – Tezpur – Dibrugarh north bank (NH15)", ["GHY", "MGD", "TZP", "GHP", "NLK", "DMJ", "DBR"]),
]

SINUOSITY = {"plain": 1.25, "hill": 1.55, "mountain": 1.75}
RAIL_SINUOSITY = 1.3
FERRY_SINUOSITY = 1.1

# Typical loaded-truck speeds in km/h (NH, SH, ODR) by terrain.
ROAD_SPEED = {
    ("NH", "plain"): 45, ("NH", "hill"): 25, ("NH", "mountain"): 18,
    ("SH", "plain"): 35, ("SH", "hill"): 20, ("SH", "mountain"): 15,
    ("ODR", "plain"): 25, ("ODR", "hill"): 15, ("ODR", "mountain"): 12,
}
RAIL_SPEED = 30     # average freight speed incl. crossings
FERRY_SPEED = 10


def haversine_km(lat1, lon1, lat2, lon2):
    r = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = p2 - p1
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def build():
    nodes = []
    for nid, (name, state, lat, lon, elev, kind, zone) in NODES.items():
        nodes.append(dict(id=nid, name=name, state=state, lat=lat, lon=lon,
                          elevation_m=elev, kind=kind, met_zone=zone))

    edges = []
    seen = set()
    for (a, b, mode, ref, cls, terrain, slope, hist, river, no_net, note) in EDGES:
        assert a in NODES and b in NODES, (a, b)
        key = (a, b, mode)
        assert key not in seen, key
        seen.add(key)
        na, nb = NODES[a], NODES[b]
        d = haversine_km(na[2], na[3], nb[2], nb[3])
        if mode == "road":
            length = d * SINUOSITY[terrain]
            speed = ROAD_SPEED[(cls, terrain)]
        elif mode == "rail":
            length = d * RAIL_SINUOSITY
            speed = RAIL_SPEED
        else:
            length = d * FERRY_SINUOSITY
            speed = FERRY_SPEED
        edges.append(dict(
            id=f"{a}-{b}" + ("" if mode == "road" else f"-{mode}"),
            source=a, target=b, mode=mode, route_ref=ref, road_class=cls, terrain=terrain,
            length_km=round(length, 1), base_speed_kmh=speed,
            base_time_h=round(length / speed, 2),
            slope_deg=slope, elevation_m=max(na[4], nb[4]),
            landslide_hist=hist, river=river, river_adjacent=bool(river),
            no_network=no_net, note=note,
            met_zones=sorted({na[6], nb[6]}),
            geometry=[[na[3], na[2]], [nb[3], nb[2]]],
        ))

    corridors = []
    edge_by_pair = {}
    for e in edges:
        if e["mode"] == "road":
            edge_by_pair[(e["source"], e["target"])] = e["id"]
            edge_by_pair[(e["target"], e["source"])] = e["id"]
    for cid, name, chain in CORRIDORS:
        ids = [edge_by_pair[(chain[i], chain[i + 1])] for i in range(len(chain) - 1)]
        corridors.append(dict(id=cid, name=name, nodes=chain, edges=ids))

    zones = [dict(id=z, name=n, lat=la, lon=lo) for z, (n, la, lo) in MET_ZONES.items()]
    out = dict(
        version="ner-corridors-0.3",
        note="Prototype graph: real towns/corridors, estimated terrain attributes. See docs/DATA.md.",
        nodes=nodes, edges=edges, corridors=corridors, met_zones=zones,
    )
    path = Path(__file__).with_name("network.json")
    path.write_text(json.dumps(out, indent=1))
    print(f"wrote {path}: {len(nodes)} nodes, {len(edges)} edges, {len(corridors)} corridors")


if __name__ == "__main__":
    build()
