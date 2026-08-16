#!/usr/bin/env python3
"""Build index.html for Particle Earth.

Embeds into tools/template.html:
  __THREE_DATA_URI__  three.module.min.js (three@0.185.1) as a base64 ES-module data URI
  __MASK_B64__        1024x512 1-bit equirectangular land mask (world-atlas land-110m,
                      Natural Earth public domain), packed MSB-first, base64
  __MASK_W__ / __MASK_H__
  __TONE__            three.js tone-mapping + colorspace shader chunks

Vendor inputs are looked up in tools/vendor/ first; if absent they are fetched
with `npm pack three@0.185.1 world-atlas@2.0.2` into a temp dir.

Usage: python3 tools/build.py [--three PATH] [--land PATH] [--out PATH]
"""
import argparse
import base64
import json
import math
import subprocess
import sys
import tarfile
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TOOLS = Path(__file__).resolve().parent
MASK_W, MASK_H = 1024, 512
THREE_SPEC = "three@0.185.1"
ATLAS_SPEC = "world-atlas@2.0.2"


def fetch_vendor(tmp: Path) -> tuple[Path, Path]:
    """npm-pack the pinned packages and return (three.module.min.js, land-110m.json)."""
    subprocess.run(
        ["npm", "pack", THREE_SPEC, ATLAS_SPEC], cwd=tmp, check=True,
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    three_js = land_json = None
    for tgz in tmp.glob("*.tgz"):
        with tarfile.open(tgz) as tf:
            for m in tf.getmembers():
                if m.name.endswith("build/three.module.min.js"):
                    tf.extract(m, tmp, filter="data")
                    three_js = tmp / m.name
                elif m.name.endswith("land-110m.json"):
                    tf.extract(m, tmp, filter="data")
                    land_json = tmp / m.name
    if not three_js or not land_json:
        sys.exit("could not locate vendor files inside npm tarballs")
    return three_js, land_json


def decode_topojson(path: Path):
    """TopoJSON 'land' object -> list of rings in (lon, lat)."""
    topo = json.loads(path.read_text())
    sx, sy = topo["transform"]["scale"]
    tx, ty = topo["transform"]["translate"]
    arcs = []
    for arc in topo["arcs"]:
        x = y = 0
        pts = []
        for dx, dy in arc:
            x += dx
            y += dy
            pts.append((x * sx + tx, y * sy + ty))
        arcs.append(pts)

    def ring_coords(ring):
        out = []
        for idx in ring:
            pts = arcs[idx] if idx >= 0 else arcs[~idx][::-1]
            out.extend(pts if not out else pts[1:])
        return out

    rings = []

    def walk(geom):
        t = geom["type"]
        if t == "GeometryCollection":
            for g in geom["geometries"]:
                walk(g)
        elif t == "Polygon":
            for ring in geom["arcs"]:  # exterior + holes; global even-odd handles both
                rings.append(ring_coords(ring))
        elif t == "MultiPolygon":
            for polygon in geom["arcs"]:
                for ring in polygon:
                    rings.append(ring_coords(ring))
        else:
            sys.exit(f"unhandled topojson geometry type: {t}")

    walk(topo["objects"]["land"])
    return rings


def rasterize(rings) -> bytearray:
    """Even-odd scanline fill of all rings into a packed MSB-first bit mask.

    Longitudes are unwrapped per ring so edges never jump across the +-180 seam
    (which would flip scanline parity mid-row — e.g. Fiji), and each ring is
    rasterized at x offsets {-W, 0, +W} with fills clipped to [0, W) so unwrapped
    geometry still lands on the correct pixels.
    """
    edges_by_row = [[] for _ in range(MASK_H)]
    for ring in rings:
        # unwrap: keep successive longitudes continuous
        lons = []
        for lon, _ in ring:
            if lons:
                while lon - lons[-1] > 180:
                    lon -= 360
                while lon - lons[-1] < -180:
                    lon += 360
            lons.append(lon)
        g = [((lon + 180.0) / 360.0 * MASK_W, (90.0 - lat) / 180.0 * MASK_H)
             for lon, (_, lat) in zip(lons, ring)]
        for off in (-MASK_W, 0, MASK_W):
            for (x1, y1), (x2, y2) in zip(g, g[1:] + g[:1]):
                if y1 == y2:
                    continue
                y_lo, y_hi = sorted((y1, y2))
                r0 = max(0, int(math.ceil(y_lo - 0.5)))
                r1 = min(MASK_H - 1, int(math.floor(y_hi - 0.5)))
                for r in range(r0, r1 + 1):
                    edges_by_row[r].append((x1 + off, y1, x2 + off, y2))

    mask = bytearray(MASK_W * MASK_H // 8)
    for row in range(MASK_H):
        yc = row + 0.5
        xs = []
        for x1, y1, x2, y2 in edges_by_row[row]:
            if (y1 <= yc < y2) or (y2 <= yc < y1):
                xs.append(x1 + (yc - y1) * (x2 - x1) / (y2 - y1))
        xs.sort()
        for k in range(0, len(xs) - 1, 2):
            x_start = max(0, int(math.ceil(xs[k] - 0.5)))
            x_end = min(MASK_W - 1, int(math.floor(xs[k + 1] - 0.5)))
            for x in range(x_start, x_end + 1):     # clipped to [0, W)
                i = row * MASK_W + x
                mask[i >> 3] |= 0x80 >> (i & 7)
    return mask


def pack_cities(path: Path) -> bytes:
    """cities-pop.json [[lon, lat, pop], ...] -> 5 bytes/city:
    lat*100 int16 LE, lon*100 int16 LE, weight uint8 (log-scaled population)."""
    import struct
    cities = json.loads(path.read_text())
    lo, hi = math.log10(2e5), math.log10(2.5e7)
    out = bytearray()
    for lon, lat, pop in cities:
        w = round(255 * (math.log10(max(pop, 2e5)) - lo) / (hi - lo))
        out += struct.pack("<hhB", round(lat * 100), round(lon * 100),
                           max(0, min(255, w)))
    print(f"cities: {len(cities)} packed into {len(out):,} bytes")
    return bytes(out)


def ascii_preview(mask: bytearray, w=96, h=30) -> str:
    lines = []
    for j in range(h):
        row = []
        for i in range(w):
            x = int(i / w * MASK_W)
            y = int(j / h * MASK_H)
            k = y * MASK_W + x
            row.append("#" if (mask[k >> 3] >> (7 - (k & 7))) & 1 else ".")
        lines.append("".join(row))
    return "\n".join(lines)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--three", type=Path, default=None)
    ap.add_argument("--land", type=Path, default=None)
    ap.add_argument("--cities", type=Path, default=TOOLS / "vendor" / "cities-pop.json")
    ap.add_argument("--out", type=Path, default=ROOT / "index.html")
    args = ap.parse_args()

    three_js, land_json = args.three, args.land
    vend = TOOLS / "vendor"
    if not three_js and (vend / "three.module.min.js").exists():
        three_js = vend / "three.module.min.js"
    if not land_json and (vend / "land-110m.json").exists():
        land_json = vend / "land-110m.json"

    tmp_ctx = None
    if not three_js or not land_json:
        tmp_ctx = tempfile.TemporaryDirectory()
        print(f"fetching {THREE_SPEC} + {ATLAS_SPEC} via npm pack ...")
        t, l = fetch_vendor(Path(tmp_ctx.name))
        three_js = three_js or t
        land_json = land_json or l

    print(f"three:  {three_js} ({three_js.stat().st_size:,} bytes)")
    print(f"land:   {land_json} ({land_json.stat().st_size:,} bytes)")

    # r167+ split the min build (three.module.min.js imports ./three.core.min.js);
    # a data-URI module cannot resolve relative imports, so flatten with esbuild.
    if 'from"./three.core' in three_js.read_text(errors="ignore")[:200_000]:
        flat = three_js.parent / "three.flat.min.js"
        if not flat.exists():
            print("flattening split build with esbuild ...")
            subprocess.run(
                ["npx", "-y", "esbuild@0.25.6", str(three_js), "--bundle", "--minify",
                 "--format=esm", f"--outfile={flat}", "--log-level=warning"],
                check=True,
            )
        three_js = flat
        print(f"flat:   {three_js} ({three_js.stat().st_size:,} bytes)")

    rings = decode_topojson(land_json)
    n_pts = sum(len(r) for r in rings)
    print(f"rings:  {len(rings)} ({n_pts:,} vertices) -> rasterizing {MASK_W}x{MASK_H} ...")
    mask = rasterize(rings)
    land_frac = sum(bin(b).count("1") for b in mask) / (MASK_W * MASK_H)
    print(f"land pixel fraction: {land_frac:.3f} (equirect; expect ~0.30-0.37)")
    print(ascii_preview(mask))
    if not 0.20 < land_frac < 0.50:
        sys.exit("land fraction looks wrong — aborting")

    three_b64 = base64.b64encode(three_js.read_bytes()).decode()
    mask_b64 = base64.b64encode(bytes(mask)).decode()
    cities_b64 = base64.b64encode(pack_cities(args.cities)).decode()

    html = (TOOLS / "template.html").read_text()
    for token, value in [
        ("__THREE_DATA_URI__", "data:text/javascript;base64," + three_b64),
        ("__MASK_B64__", mask_b64),
        ("__MASK_W__", str(MASK_W)),
        ("__MASK_H__", str(MASK_H)),
        ("__CITIES_B64__", cities_b64),
        ("__TONE__", "#include <tonemapping_fragment>\n      #include <colorspace_fragment>"),
    ]:
        if token not in html:
            sys.exit(f"template missing token {token}")
        html = html.replace(token, value)

    args.out.write_text(html)
    print(f"wrote {args.out} ({args.out.stat().st_size:,} bytes)")
    if tmp_ctx:
        tmp_ctx.cleanup()


if __name__ == "__main__":
    main()
