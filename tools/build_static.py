"""
Build the browser-only version of the app (static-site/) from the current frontend.

The Python backend is replaced by its JavaScript port (frontend/js/localserver.js) running in the page,
and the map uses the built-in basemap (national highways, railways, towns) instead of online tiles,
so the result works on any static host, including sandboxed pages that block outside requests.

    python -m tools.build_static            # static-site/  (built-in map only, for sandboxed hosts like claude.ai)
    python -m tools.build_static --vercel   # vercel-site/  (OpenStreetMap tiles online, built-in map as fallback + vercel.json)
"""
from __future__ import annotations

import json
import math
import re
import shutil
import tempfile
from pathlib import Path

ROOT = Path(__file__).parents[1]
FRONT = ROOT / "frontend"
OUT = ROOT / "static-site"
MAPLIBRE_CDN = "https://cdn.jsdelivr.net/npm/maplibre-gl@5.24.0/dist/maplibre-gl.js"


def export_network():
    from backend.engine import Engine
    eng = Engine(db_path=Path(tempfile.mkdtemp()) / "build.db")      # applies the committed road geometry
    net = json.loads(json.dumps(eng.network))
    for e in net["edges"]:
        for k in ("straight_geometry", "est_length_km", "est_base_time_h"):
            e.pop(k, None)
    return net


def export_model():
    m = json.loads((ROOT / "backend/risk/artifacts/hazard_xgb.json").read_text())
    L = m["learner"]
    base = float(L["learner_model_param"]["base_score"].strip("[]"))
    trees = [dict(l=t["left_children"], r=t["right_children"], f=t["split_indices"],
                  c=[round(v, 7) for v in t["split_conditions"]], h=[round(v, 5) for v in t["sum_hessian"]])
             for t in L["gradient_booster"]["model"]["trees"]]
    return dict(base_margin=math.log(base / (1 - base)), trees=trees)


def page(builtin_only=True):
    src = (FRONT / "index.html").read_text()
    body = src[src.index('<div class="app">'):src.index('<script src="/static/vendor/maplibre-gl.js">')]
    # top bar: no separate driver page or API docs here; driver phones open in-page instead
    body = re.sub(r'\s*<a class="btn small" href="/driver".*?</a>', "", body, flags=re.S)
    body = re.sub(r'\s*<a class="btn small ghost hide-sm" href="/docs".*?</a>', "", body, flags=re.S)
    body = body.replace('<span class="chip hide-sm hide-md" id="model-chip">model –</span>',
                        '<span class="chip hide-sm" title="The Python backend is ported to JavaScript and runs inside this page. '
                        'Nothing is sent anywhere; everything resets when you reload.">Browser version</span>\n'
                        '    <span class="chip hide-sm hide-md" id="model-chip">model –</span>\n'
                        '    <button class="btn small" id="btn-phones" type="button">Driver phones</button>')
    body = body.replace('<div class="drawer hidden" id="drawer"></div>',
                        '<div class="drawer hidden" id="drawer"></div>\n'
                        '      <div class="dock hidden" id="dock" aria-label="Driver phones">\n'
                        '        <button class="btn small dock-head" id="dock-close" type="button">Close phones</button>\n'
                        '        <div class="phone" id="phone-a"></div>\n        <div class="phone" id="phone-b"></div>\n      </div>')
    return ("<title>NER-LogiSense</title>\n"
            '<link rel="stylesheet" href="vendor/maplibre-gl.css">\n<link rel="stylesheet" href="css/app.css">\n'
            "<style>html,body{height:100%;overflow:hidden}.app{height:100%}@media(max-width:900px){html,body{overflow:auto}}</style>\n"
            + body +
            '<script>window.NER_CONFIG = { local: true, builtinMapOnly: ' + ("true" if builtin_only else "false") + ', assetBase: "./", dataBase: "data/", fontsJson: "data/fonts.json" };</script>\n'
            f'<script src="{MAPLIBRE_CDN}"></script>\n<script type="module" src="js/dispatcher.js"></script>\n')


VERCEL_JSON = {
    "cleanUrls": True,
    "headers": [
        {"source": "/(data|basemap)/(.*)", "headers": [{"key": "Cache-Control", "value": "public, max-age=3600"}]},
        {"source": "/(js|css|vendor)/(.*)", "headers": [{"key": "Cache-Control", "value": "public, max-age=300"}]},
    ],
}


def main():
    import sys
    vercel = "--vercel" in sys.argv
    global OUT
    if vercel:
        OUT = ROOT / "vercel-site"
    if OUT.exists():
        shutil.rmtree(OUT)
    (OUT / "data").mkdir(parents=True)
    (OUT / "data" / "network.json").write_text(json.dumps(export_network(), separators=(",", ":")))
    (OUT / "data" / "model.json").write_text(json.dumps(export_model(), separators=(",", ":")))
    shutil.copy(ROOT / "backend/risk/artifacts/metrics.json", OUT / "data" / "metrics.json")
    for sub in ("css", "js", "basemap"):
        shutil.copytree(FRONT / sub, OUT / sub, ignore=shutil.ignore_patterns("driver.js"))
    # label glyphs as one JSON bundle (static hosts may not serve .pbf)
    import base64
    glyphs = {f"{p.parent.name}/{p.stem}": base64.b64encode(p.read_bytes()).decode()
              for p in sorted((FRONT / "fonts").rglob("*.pbf"))}
    (OUT / "data" / "fonts.json").write_text(json.dumps(glyphs, separators=(",", ":")))
    (OUT / "vendor").mkdir()
    shutil.copy(FRONT / "vendor" / "maplibre-gl.css", OUT / "vendor" / "maplibre-gl.css")
    html = page(builtin_only=not vercel)
    if vercel:      # a full document (the claude.ai host adds these itself)
        head, _, rest = html.partition('<div class="app">')
        html = ('<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n'
                '<meta name="viewport" content="width=device-width, initial-scale=1">\n'
                '<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 32 32%22%3E'
                '%3Crect width=%2232%22 height=%2232%22 rx=%227%22 fill=%22%231a56db%22/%3E%3Cpath d=%22M6 22l7-10 5 6 3-4 5 8z%22 fill=%22white%22/%3E%3C/svg%3E">\n'
                + head + '</head>\n<body>\n<div class="app">' + rest + '</body>\n</html>\n')
    (OUT / "index.html").write_text(html)
    if vercel:
        (OUT / "vercel.json").write_text(json.dumps(VERCEL_JSON, indent=2))
    files = sorted(str(p.relative_to(OUT)) for p in OUT.rglob("*") if p.is_file())
    size = sum((OUT / f).stat().st_size for f in files)
    print(f"{len(files)} files, {size / 1024:.0f} KB → {OUT}")
    if not vercel:
        (OUT / "files.json").write_text(json.dumps({f: str(OUT / f) for f in files if f != "index.html"}, indent=1))


if __name__ == "__main__":
    main()
