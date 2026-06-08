#!/usr/bin/env python3
"""Extract 16x16 tiles from map_background.png, dedupe, classify, emit tileset + meta."""

import json
import struct
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "assets/images/map_background.png"
OUT_IMAGE = ROOT / "assets/images/map_tileset.png"
OUT_META = ROOT / "assets/data/map_tile_meta.json"
TILE = 16


def paeth(a, b, c):
    p = a + b - c
    pa = abs(p - a)
    pb = abs(p - b)
    pc = abs(p - c)
    if pa <= pb and pa <= pc:
        return a
    if pb <= pc:
        return b
    return c


def read_png_rgba(path):
    with path.open("rb") as f:
        if f.read(8) != b"\x89PNG\r\n\x1a\n":
            raise ValueError("not png")
        width = height = None
        bit_depth = color_type = None
        palette = []
        idat = b""
        while True:
            header = f.read(8)
            if len(header) < 8:
                break
            length = struct.unpack(">I", header[:4])[0]
            ctype = header[4:]
            data = f.read(length)
            f.read(4)
            if ctype == b"IHDR":
                width, height, bit_depth, color_type, _, _, _ = struct.unpack(">IIBBBBB", data)
            elif ctype == b"PLTE":
                for i in range(0, len(data), 3):
                    palette.append(tuple(data[i : i + 3]))
            elif ctype == b"tRNS":
                pass
            elif ctype == b"IDAT":
                idat += data
            elif ctype == b"IEND":
                break

    raw = zlib.decompress(idat)
    if color_type == 3:
        bpp = 1
    elif color_type == 2:
        bpp = 3
    elif color_type == 6:
        bpp = 4
    else:
        raise ValueError(f"unsupported color type {color_type}")

    stride = width * bpp
    out = []
    prev = [0] * stride
    pos = 0
    for _y in range(height):
        filt = raw[pos]
        pos += 1
        row = list(raw[pos : pos + stride])
        pos += stride
        recon = []
        for i in range(stride):
            x = row[i]
            a = recon[i - bpp] if i >= bpp else 0
            b = prev[i]
            c = prev[i - bpp] if i >= bpp else 0
            if filt == 0:
                v = x
            elif filt == 1:
                v = (x + a) & 255
            elif filt == 2:
                v = (x + b) & 255
            elif filt == 3:
                v = (x + ((a + b) // 2)) & 255
            elif filt == 4:
                v = (x + paeth(a, b, c)) & 255
            else:
                v = x
            recon.append(v)
        prev = recon
        out.extend(recon)

    rgba = []
    for y in range(height):
        for x in range(width):
            i = y * width + x
            if color_type == 3:
                idx = out[i]
                if idx < len(palette):
                    r, g, b = palette[idx]
                else:
                    r = g = b = 0
                rgba.append((r, g, b, 255))
            elif color_type == 2:
                base = i * 3
                rgba.append((out[base], out[base + 1], out[base + 2], 255))
            else:
                base = i * 4
                rgba.append((out[base], out[base + 1], out[base + 2], out[base + 3]))

    return width, height, rgba


def write_png_rgb(path, width, height, pixels):
    def chunk(tag, data):
        crc = zlib.crc32(tag + data) & 0xFFFFFFFF
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", crc)

    raw = bytearray()
    for y in range(height):
        raw.append(0)
        for x in range(width):
            r, g, b = pixels[y * width + x]
            raw.extend((r, g, b))
    compressed = zlib.compress(bytes(raw), 9)
    ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", ihdr)
    png += chunk(b"IDAT", compressed)
    png += chunk(b"IEND", b"")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(png)


def tile_bytes(rgba, src_w, tx, ty):
    parts = []
    for y in range(ty * TILE, ty * TILE + TILE):
        for x in range(tx * TILE, tx * TILE + TILE):
            parts.extend(rgba[y * src_w + x])
    return bytes(parts)


def classify_tile(rgba_tile, src_tx=0, src_ty=0):
    n = blue = green = dark_green = brown = gray = 0
    rs = gs = bs = 0
    for i in range(0, len(rgba_tile), 4):
        r, g, b, a = rgba_tile[i : i + 4]
        if a < 128:
            continue
        n += 1
        rs += r
        gs += g
        bs += b
        if b > r + 18 and b > g + 8:
            blue += 1
        if g > r and g > b and g > 70:
            green += 1
            if g < 110 and r < 90:
                dark_green += 1
        if r > 95 and g > 65 and b < 105 and r > b + 12:
            brown += 1
        lum = 0.299 * r + 0.587 * g + 0.114 * b
        if lum > 95 and abs(r - g) < 22 and abs(g - b) < 22:
            gray += 1

    if n == 0:
        return "misc"
    br = blue / n
    gr = green / n
    dgr = dark_green / n
    brn = brown / n
    gry = gray / n
    avg_g = gs / n

    if br > 0.22:
        return "water"
    if gry > 0.35 and avg_g > 85 and brn < 0.2:
        return "stairs"
    if gry > 0.28 and brn < 0.22:
        if src_ty >= 12:
            return "fort"
        return "stairs"
    if dgr > 0.28 or (gr > 0.42 and avg_g < 105):
        return "forest"
    if gr > 0.38:
        return "grass"
    if brn > 0.28:
        if avg_g > 95:
            return "sand"
        return "mountain"
    if brn > 0.15:
        return "sand"
    return "misc"


def main():
    src_w, src_h, rgba = read_png_rgba(SOURCE)
    tiles_x = src_w // TILE
    tiles_y = src_h // TILE

    hash_to_id = {}
    tiles = []
    categories = {
        "grass": [],
        "sand": [],
        "water": [],
        "mountain": [],
        "forest": [],
        "fort": [],
        "stairs": [],
        "misc": [],
    }

    for ty in range(tiles_y):
        for tx in range(tiles_x):
            raw = tile_bytes(rgba, src_w, tx, ty)
            if raw not in hash_to_id:
                tile_id = len(tiles)
                hash_to_id[raw] = tile_id
                category = classify_tile(raw, tx, ty)
                tiles.append(
                    {
                        "id": tile_id,
                        "category": category,
                        "srcTx": tx,
                        "srcTy": ty,
                    }
                )
                categories[category].append(tile_id)

    sheet_cols = max(1, int(len(tiles) ** 0.5 + 0.999))
    sheet_rows = (len(tiles) + sheet_cols - 1) // sheet_cols
    sheet_w = sheet_cols * TILE
    sheet_h = sheet_rows * TILE
    sheet_pixels = [(0, 0, 0)] * (sheet_w * sheet_h)

    raw_by_id = {tile_id: raw for raw, tile_id in hash_to_id.items()}
    for tile_id in range(len(tiles)):
        raw = raw_by_id[tile_id]
        cx = tile_id % sheet_cols
        cy = tile_id // sheet_cols
        tiles[tile_id]["sheetX"] = cx
        tiles[tile_id]["sheetY"] = cy
        for y in range(TILE):
            for x in range(TILE):
                src_i = (y * TILE + x) * 4
                r, g, b, _a = raw[src_i : src_i + 4]
                dst_x = cx * TILE + x
                dst_y = cy * TILE + y
                sheet_pixels[dst_y * sheet_w + dst_x] = (r, g, b)

    write_png_rgb(OUT_IMAGE, sheet_w, sheet_h, sheet_pixels)

    meta = {
        "tileSize": TILE,
        "sourceTilesX": tiles_x,
        "sourceTilesY": tiles_y,
        "sheetCols": sheet_cols,
        "sheetRows": sheet_rows,
        "uniqueCount": len(tiles),
        "tiles": tiles,
        "categories": categories,
    }
    OUT_META.parent.mkdir(parents=True, exist_ok=True)
    OUT_META.write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"unique tiles: {len(tiles)}")
    print(f"sheet: {sheet_w}x{sheet_h}")
    for cat, ids in categories.items():
        if ids:
            print(f"  {cat}: {len(ids)}")


if __name__ == "__main__":
    main()
