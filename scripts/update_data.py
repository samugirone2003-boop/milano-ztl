"""Scarica dai dati aperti del Comune di Milano i perimetri di Area C e delle ZTL e i varchi di Area C.

Uso:
    python3 scripts/update_data.py

Scrive data/zones.geojson, data/varchi.geojson e data/meta.json. Controlla anche se le pagine
ufficiali con le regole (data/rules.json -> watch) sono state aggiornate dal Comune: in quel caso
scrive data/rules_changed.txt, che il workflow di GitHub usa per aprire una segnalazione.
Funziona solo con la libreria standard di Python.
"""
import json
import math
import os
import re
import sys
import urllib.request
from datetime import date, datetime, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")
CKAN = "https://dati.comune.milano.it/api/3/action/package_show?id="
AREAS_DATASET = "ds51_trafficotrasporti_aree_pedonali_ztl"
GATES_DATASET = "ds82_infogeo_varchi_elettronici_localizzazione_"
HEADERS = {"User-Agent": "Mozilla/5.0 (compatible; milano-ztl/1.0; +https://github.com/samugirone2003-boop/milano-ztl)"}


def fetch(url):
    req = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read()


def dataset(name):
    """Restituisce i metadati del dataset e il file GeoJSON più recente (gli URL possono cambiare)."""
    meta = json.loads(fetch(CKAN + name))["result"]
    res = next(r for r in meta["resources"] if (r.get("format") or "").lower() == "geojson")
    geo = json.loads(fetch(res["url"]))
    return meta, res, geo


def valid_today(props, today):
    start = (props.get("val_inizio") or "")[:10]
    end = (props.get("val_fine") or "")[:10]
    return (not start or start <= today) and (not end or end > today)


def clean(text):
    return re.sub(r"\s+", " ", text or "").strip() or None


def zone_name(text):
    """'ZTL SAN DALMAZIO, PAOLO FERRARI' -> 'San Dalmazio, Paolo Ferrari'."""
    name = re.sub(r"^ZTL\s+", "", clean(text) or "", flags=re.I)
    if name.isupper():
        name = " ".join(w.capitalize() for w in name.lower().split())
        name = re.sub(r"\b(Dell|Della|Del|Di|Da|E)\b", lambda m: m.group(0).lower(), name)
    return name


def round_coords(coords):
    return json.loads(json.dumps(coords), parse_float=lambda v: round(float(v), 6))


# Le zone da evitare nel calcolo dei percorsi sono semplificate (meno punti, richieste più leggere).
# Il perimetro di Area C corre lungo la cerchia dei Bastioni, che invece è percorribile: lo stringo
# di qualche metro verso l'interno perché il navigatore non escluda anche la cerchia.
SIMPLIFY_M = 4
AREA_C_INSET = 12


def _xy(ring):
    lat0 = sum(p[1] for p in ring) / len(ring)
    kx, ky = 111320 * math.cos(math.radians(lat0)), 110540
    return [((lon) * kx, (lat) * ky) for lon, lat in ring], kx, ky


def _simplify(pts, tol):
    """Douglas-Peucker su coordinate in metri."""
    if len(pts) < 3:
        return pts
    (ax, ay), (bx, by) = pts[0], pts[-1]
    dx, dy = bx - ax, by - ay
    norm = math.hypot(dx, dy) or 1
    far, idx = 0, 0
    for i, (px, py) in enumerate(pts[1:-1], 1):
        d = abs(dy * px - dx * py + bx * ay - by * ax) / norm
        if d > far:
            far, idx = d, i
    if far <= tol:
        return [pts[0], pts[-1]]
    return _simplify(pts[:idx + 1], tol)[:-1] + _simplify(pts[idx:], tol)


def avoid_ring(ring, inset):
    pts, kx, ky = _xy(ring)
    if pts[0] == pts[-1]:
        pts = pts[:-1]
    # un anello chiuso va diviso in due metà (dal primo punto al più lontano e ritorno)
    k = max(range(len(pts)), key=lambda i: math.hypot(pts[i][0] - pts[0][0], pts[i][1] - pts[0][1]))
    pts = _simplify(pts[:k + 1], SIMPLIFY_M)[:-1] + _simplify(pts[k:] + [pts[0]], SIMPLIFY_M)[:-1]
    if inset:
        area = sum(x1 * y2 - x2 * y1 for (x1, y1), (x2, y2) in zip(pts, pts[1:] + pts[:1])) / 2
        sign = 1 if area > 0 else -1  # antiorario: l'interno è a sinistra dei lati
        moved = []
        for i, (x, y) in enumerate(pts):
            (px, py), (nx, ny) = pts[i - 1], pts[(i + 1) % len(pts)]
            n1 = (-(y - py), x - px)
            n2 = (-(ny - y), nx - x)
            n1 = [c * sign / (math.hypot(*n1) or 1) for c in n1]
            n2 = [c * sign / (math.hypot(*n2) or 1) for c in n2]
            bx, by = n1[0] + n2[0], n1[1] + n2[1]
            blen = math.hypot(bx, by) or 1
            cos_half = max(0.5, blen / 2)  # limita l'allungamento sugli angoli molto acuti
            moved.append((x + bx / blen * inset / cos_half, y + by / blen * inset / cos_half))
        pts = moved
    out = [[round(x / kx, 6), round(y / ky, 6)] for x, y in pts]
    return out + [out[0]]


def check_rule_pages(rules):
    """Confronta la data 'Ultimo aggiornamento' delle pagine ufficiali con quella registrata.

    Se il sito del Comune non risponde alle richieste automatiche lo segnala e basta: in ogni caso,
    dopo 30 giorni dall'ultimo controllo a mano delle regole, chiede di ricontrollarle.
    """
    changes, errors = [], []
    age = (date.today() - date.fromisoformat(rules["checked"])).days
    if age > 30:
        changes.append(f"- Le regole sono state controllate l'ultima volta il {rules['checked']} ({age} giorni fa): ricontrolla le pagine ufficiali.")
    for page in rules["watch"]:
        try:
            html = fetch(page["url"]).decode("utf-8", "replace")
        except Exception as e:  # il sito del Comune a volte blocca le richieste automatiche
            errors.append(f"{page['name']}: pagina non raggiungibile ({e})")
            continue
        m = re.search(r"Ultimo aggiornamento:?\s*(?:</[^>]+>\s*)*(\d{2}/\d{2}/\d{4})", html)
        if not m:
            errors.append(f"{page['name']}: data di aggiornamento non trovata")
        elif m.group(1) != page["lastUpdate"]:
            changes.append(f"- {page['name']}: aggiornata il {m.group(1)} (registrata: {page['lastUpdate']}) {page['url']}")
    return changes, errors


def main():
    today = date.today().isoformat()
    rules = json.load(open(os.path.join(DATA, "rules.json"), encoding="utf-8"))
    manual = json.load(open(os.path.join(DATA, "manual_zones.geojson"), encoding="utf-8"))

    areas_meta, areas_res, areas = dataset(AREAS_DATASET)
    zones, official_names = [], []
    for f in areas["features"]:
        p = f["properties"]
        if p.get("tipo") not in ("AREA_C", "ZTL") or not valid_today(p, today):
            continue
        name = "Area C" if p["tipo"] == "AREA_C" else zone_name(p.get("nome"))
        official_names.append(name)
        zones.append({
            "type": "Feature",
            "properties": {
                "kind": "AREA_C" if p["tipo"] == "AREA_C" else "ZTL",
                "name": name,
                "schedule": clean(p.get("note")),
                "rules": clean(p.get("deroghe")),
                "order": clean(p.get("ordinanza")),
                "source": "Dati aperti del Comune di Milano",
                "sourceUrl": f"https://dati.comune.milano.it/dataset/{AREAS_DATASET}",
            },
            "geometry": {"type": f["geometry"]["type"], "coordinates": round_coords(f["geometry"]["coordinates"])},
        })

    # Le zone disegnate a mano servono solo finché il Comune non le pubblica nei dati aperti.
    manual_used = []
    for f in manual["features"]:
        key = f["properties"]["officialName"].lower()
        if any(key in (n or "").lower() for n in official_names):
            print(f"'{f['properties']['name']}' ora è nei dati aperti: uso quella ufficiale")
            continue
        f["properties"]["manual"] = True
        zones.append(f)
        manual_used.append(f["properties"]["name"])

    gates_meta, gates_res, gates = dataset(GATES_DATASET)
    varchi = [{
        "type": "Feature",
        "properties": {"id": g["properties"].get("id"), "name": clean(g["properties"].get("label"))},
        "geometry": {"type": "Point", "coordinates": round_coords(g["geometry"]["coordinates"][:2])},
    } for g in gates["features"] if g.get("geometry")]

    avoid = [{
        "type": "Feature",
        "properties": {"kind": z["properties"]["kind"], "name": z["properties"]["name"]},
        "geometry": {"type": "MultiPolygon", "coordinates": [
            [avoid_ring(poly[0], AREA_C_INSET if z["properties"]["kind"] == "AREA_C" else 0)]
            for poly in (z["geometry"]["coordinates"] if z["geometry"]["type"] == "MultiPolygon" else [z["geometry"]["coordinates"]])
        ]},
    } for z in zones]

    os.makedirs(DATA, exist_ok=True)
    for name, features in (("zones.geojson", zones), ("varchi.geojson", varchi), ("avoid.geojson", avoid)):
        with open(os.path.join(DATA, name), "w", encoding="utf-8") as fh:
            json.dump({"type": "FeatureCollection", "features": features}, fh, ensure_ascii=False, separators=(",", ":"))

    changes, errors = check_rule_pages(rules)
    meta = {
        "checkedAt": datetime.now(timezone.utc).isoformat(timespec="minutes"),
        "sources": [
            {"name": areas_meta["title"], "url": f"https://dati.comune.milano.it/dataset/{AREAS_DATASET}",
             "updated": (areas_res.get("last_modified") or areas_meta.get("metadata_modified") or "")[:10]},
            {"name": gates_meta["title"], "url": f"https://dati.comune.milano.it/dataset/{GATES_DATASET}",
             "updated": (gates_res.get("last_modified") or gates_meta.get("metadata_modified") or "")[:10]},
        ],
        "manualZones": manual_used,
        "rulePagesChanged": bool(changes),
        "rulePagesErrors": errors,
    }
    with open(os.path.join(DATA, "meta.json"), "w", encoding="utf-8") as fh:
        json.dump(meta, fh, ensure_ascii=False, indent=2)

    flag = os.path.join(DATA, "rules_changed.txt")
    if changes:
        with open(flag, "w", encoding="utf-8") as fh:
            fh.write("Il Comune ha aggiornato le pagine con le regole. Controlla e aggiorna data/rules.json:\n\n" + "\n".join(changes) + "\n")
    elif os.path.exists(flag):
        os.remove(flag)

    print(f"{sum(z['properties']['kind'] == 'ZTL' for z in zones)} ZTL, Area C: {any(z['properties']['kind'] == 'AREA_C' for z in zones)}, "
          f"{len(varchi)} varchi, zone a mano: {manual_used or 'nessuna'}")
    for line in changes + errors:
        print(line)
    return 0


if __name__ == "__main__":
    sys.exit(main())
