# reMarkable 2 → Mac Note Sync: Concepts & Assessment

_Last updated: 2026-02-11_

---

## 1. Executive Summary / Winning Concept

**The winning approach in 2026 is direct SSH + rsync/scp to pull the raw
xochitl data tree from the reMarkable 2, then render notes to PDF locally.**

Specifically:

| Layer | Recommended Tool | Status (Feb 2026) |
|---|---|---|
| **Transport** | `rsync` over SSH (Wi-Fi) | Rock-solid, no dependencies on rM cloud or firmware version |
| **Raw backup** | `scp -rp` or `rsync -avz` of `/home/root/.local/share/remarkable/xochitl/` | Works on every firmware including 3.x |
| **Rendering (notes → PDF)** | [`rmscene`](https://github.com/ricklupton/rmscene) + PyMuPDF, or the device's own USB web-interface renderer | `rmscene` actively maintained; handles v6 `.rm` format |
| **Folder-mirror with PDF export** | [`rmirro`](https://github.com/hersle/rmirro) (Python, ~120★, last commit 2024) | Best "just works" one-shot mirror script |
| **Rich GUI preview/export** | [`ReMy`](https://github.com/bordaigorl/remy) (PyQt5, ~300★) | Excellent SSH & rsync modes; **does NOT support v3/v6 file format yet** |
| **Cloud API (alternative)** | [`ddvk/rmapi`](https://github.com/ddvk/rmapi) (Go, ~220★, **release v0.0.32 Nov 2025**) | Actively maintained fork; `brew install io41/tap/rmapi`; requires Connect subscription |
| **Local viewing** | macOS Preview (PDF), or any PDF reader | PDFs are standard once rendered |

### Why SSH wins over alternatives

| Criterion | SSH/rsync | Cloud API (`ddvk/rmapi`) | Syncthing | USB Web UI |
|---|---|---|---|---|
| Needs internet | No | Yes | No (LAN) | No |
| Needs Connect subscription | No | **Yes** | No | No |
| Install on device | Nothing | Nothing | **Yes** (opkg, Toltec) | Already there |
| Firmware-proof | Yes (SSH is 1st-party) | Depends on cloud proto | Toltec may break | Enabled in settings |
| Speed on Wi-Fi | ~10 MB/s | Variable | Good once running | Slow (renders per-doc) |
| Bidirectional | Easy with rsync | Yes | Yes | Upload only |
| Complexity | Low (~20 lines shell) | Medium (auth dance) | High (services, ports) | Manual |

**Bottom line**: SSH + rsync is the simplest, most robust, subscription-free
approach for one-way download. It has been proven for years, doesn't install
anything on the device, and survives firmware updates. For rendering the
proprietary `.rm` line files to PDF, use `rmscene` (Python) or the device's own
web-interface PDF export (slower, but pixel-perfect).

---

## 2. How the reMarkable Stores Notes — Deep Dive

### 2.1 Device Overview

The reMarkable 2 runs Linux (armv7, codename "zero-sugar"). The internal storage
is an 8 GB eMMC with the following relevant partitions:

| Mount | Partition | Size | Purpose |
|---|---|---|---|
| `/` | `/dev/mmcblk1p2` | ~227 MB | Root filesystem (OS, xochitl binary) |
| `/home` | `/dev/mmcblk1p7` | ~6.5 GB | All user data |

The UI application is called **xochitl** (`/usr/bin/xochitl`). It manages
documents, syncs with the cloud, and renders to the e-ink display.

### 2.2 Filesystem Layout

All user data lives under a single flat directory:

```
/home/root/.local/share/remarkable/xochitl/
```

There are **no human-readable filenames** and **no nested directories** matching
the folder structure you see on the tablet. Every document and folder is
identified by a **UUID**. The visible hierarchy is encoded in metadata JSON
files.

For a **notebook** called "My Notes" you get these sibling files/dirs:

```
a02cdfbb-a75c-4b20-b813-33dd977c4bf8.metadata       # identity & hierarchy
a02cdfbb-a75c-4b20-b813-33dd977c4bf8.content         # page list & settings
a02cdfbb-a75c-4b20-b813-33dd977c4bf8.pagedata        # template per page
a02cdfbb-a75c-4b20-b813-33dd977c4bf8/                # per-page stroke data
  <page-uuid>.rm                                     # binary handwriting strokes
  <page-uuid>-metadata.json                          # per-page layer info
a02cdfbb-a75c-4b20-b813-33dd977c4bf8.thumbnails/     # pre-rendered JPG thumbnails
  0.jpg                                              # page 0 thumbnail
a02cdfbb-a75c-4b20-b813-33dd977c4bf8.cache/          # rendering cache (PNG)
  0.png
a02cdfbb-a75c-4b20-b813-33dd977c4bf8.highlights/     # highlight data (JSON)
a02cdfbb-a75c-4b20-b813-33dd977c4bf8.textconversion/  # on-device OCR text results
```

For an **imported PDF** that has been annotated:

```
f21a3d3d-efb2-4292-aff2-55142b7221e5.metadata
f21a3d3d-efb2-4292-aff2-55142b7221e5.content
f21a3d3d-efb2-4292-aff2-55142b7221e5.pdf             # ← original PDF file
f21a3d3d-efb2-4292-aff2-55142b7221e5.pagedata
f21a3d3d-efb2-4292-aff2-55142b7221e5/
  <page-uuid>.rm                                     # annotation strokes
f21a3d3d-efb2-4292-aff2-55142b7221e5.thumbnails/
f21a3d3d-efb2-4292-aff2-55142b7221e5.highlights/
```

For a **folder**, only two files exist:

```
00de970e-5a17-4e52-b19e-a8fda3347f9f.metadata
00de970e-5a17-4e52-b19e-a8fda3347f9f.content
```

### 2.3 The `.metadata` File (JSON)

This is the **identity card** of every item. Example for a notebook:

```json
{
    "deleted": false,
    "lastModified": "1510442047333",
    "metadatamodified": false,
    "modified": true,
    "parent": "00de970e-5a17-4e52-b19e-a8fda3347f9f",
    "pinned": false,
    "synced": false,
    "type": "DocumentType",
    "version": 0,
    "visibleName": "Notebook"
}
```

Example for a folder:

```json
{
    "deleted": false,
    "lastModified": "1499259452366",
    "metadatamodified": true,
    "modified": true,
    "parent": "",
    "pinned": false,
    "synced": false,
    "type": "CollectionType",
    "version": 0,
    "visibleName": "Personal"
}
```

**Key fields:**

| Field | Type | Meaning |
|---|---|---|
| `visibleName` | string | Human-readable name shown on the tablet |
| `type` | string | `"DocumentType"` (notebook/PDF/EPUB) or `"CollectionType"` (folder) |
| `parent` | string | UUID of the parent folder. `""` = root. `"trash"` = trashed item. |
| `deleted` | bool | Whether the item is soft-deleted |
| `lastModified` | string | Unix timestamp in **milliseconds** (not seconds!) |
| `pinned` | bool | Whether starred/pinned |
| `synced` | bool | Whether synced with cloud |
| `version` | int | Version counter for sync |

### 2.4 The `.content` File (JSON)

Describes the internal structure and settings of a document:

```json
{
    "extraMetadata": {
        "LastColor": "Black",
        "LastTool": "Ballpoint",
        "ThicknessScale": "1"
    },
    "fileType": "",
    "fontName": "",
    "lastOpenedPage": 0,
    "lineHeight": -1,
    "margins": 100,
    "pageCount": 1,
    "textScale": 1,
    "transform": {
        "m11": 1, "m12": 1, "m13": 1,
        "m21": 1, "m22": 1, "m23": 1,
        "m31": 1, "m32": 1, "m33": 1
    }
}
```

**Key fields:**

| Field | Meaning |
|---|---|
| `fileType` | `""` for notebook, `"pdf"` for PDF, `"epub"` for EPUB |
| `pageCount` | Number of pages |
| `lastOpenedPage` | 0-indexed page the user last viewed |
| `extraMetadata` | Last-used pen, color, thickness settings |
| `transform` | Viewport transform from crop/zoom. `m11` = vertical scale, `m22` = horizontal scale. |
| `pages` | (fw 3.x) Array of page UUIDs in order — critical for mapping `.rm` files to pages. |

On firmware 3.x, the `pages` array lists UUIDs explicitly, e.g.:
```json
"pages": [
    "d4f5a6b7-c8d9-4e0f-a1b2-c3d4e5f67890",
    "e5f6a7b8-d9e0-5f1a-b2c3-d4e5f6789012"
]
```

Each UUID corresponds to a `<page-uuid>.rm` file inside the document's
subdirectory.

### 2.5 The `.pagedata` File (Plain Text)

One line per page, naming the **template** used for that page's background:

```
P Lines small
P Lines small
Blank
```

These template names map to PNG files in `/usr/share/remarkable/templates/` on
the device. Common templates include:
- `Blank`, `P Lines small`, `P Lines medium`, `P Grid small`, `P Dots S`
- `P Cornell`, `P Checklist`, `P Day`, `P Week`
- Landscape variants prefixed with `LS `

### 2.6 Folder Hierarchy Reconstruction

Since the filesystem is flat, the **visible folder tree** must be reconstructed
from `.metadata` files by walking `parent` pointers:

```
Algorithm:
1. Read ALL *.metadata files.
2. Build a dict: uuid → {visibleName, type, parent, deleted, ...}
3. Filter out deleted items and items with parent="trash".
4. For each item, walk the parent chain to build the full path:
   e.g. parent="abc" → parent="" means /FolderABC/<item>
5. Create the directory tree on the local filesystem.
```

Pseudo-code (Python):
```python
import json, pathlib

def load_tree(raw_dir):
    items = {}
    for meta_file in pathlib.Path(raw_dir).glob("*.metadata"):
        uuid = meta_file.stem
        with open(meta_file) as f:
            data = json.load(f)
        data["uuid"] = uuid
        items[uuid] = data
    return items

def full_path(items, uuid):
    parts = []
    current = uuid
    while current and current in items:
        parts.append(items[current]["visibleName"])
        current = items[current].get("parent", "")
    return "/".join(reversed(parts))
```

### 2.7 The `.rm` Binary Stroke Format

The `.rm` files contain the actual handwriting data — every pen stroke as a
sequence of sampled points. The format has evolved through several versions:

#### Version 3 (firmware ~1.x–2.x early)

Header: ASCII string `reMarkable .lines file, version=3` + padding (43 bytes total).

```
[Header: 43 bytes ASCII + padding]
[int32: num_layers]          # 1–5 layers per page
  FOR each layer:
    [int32: num_strokes]
    FOR each stroke:
      [int32: pen_type]      # 0=Brush, 1=Pencil-Tilt, 2=Pen, 3=Marker,
                             # 4=Fineliner, 5=Highlighter, 6=Eraser,
                             # 7=Pencil-Sharp, 8=Erase-area
      [int32: color]         # 0=Black, 1=Grey, 2=White
      [int32: padding]       # usually 0 (selection-related)
      [float32: stroke_width] # 1.875=small, 2.0=medium, 2.125=large
      [int32: num_points]
      FOR each point:
        [float32: x]         # 0.0 – 1404.0 (display width in px)
        [float32: y]         # 0.0 – 1872.0 (display height in px)
        [float32: speed]     # (v3: pressure)
        [float32: direction] # (v3: tilt)
        [float32: width]     # (v3: pen rotation X)
        [float32: pressure]  # (v3: pen rotation Y)
```

All integers are **little-endian int32**. All floats are **IEEE 754 float32**.
The display resolution is **1404 × 1872 pixels** (portrait).

#### Version 5 (firmware 2.x late)

Same as v3 but header says `version=5` and each stroke has an **extra 4-byte
unknown field** after the stroke width (before point count). Adds more pen
types and a wider color palette.

#### Version 6 / "rmscene" (firmware ≥3.0)

Completely new **tagged binary block format**. Major changes:

- **Block-based**: the file is a sequence of typed blocks (each with a type tag
  and length), not a flat struct.
- **CRDT-based**: uses Conflict-free Replicated Data Types for text editing,
  enabling collaborative features and undo history.
- **Scene tree**: strokes are organized into a tree of groups (layers) and
  items, not a flat layer→stroke list.
- **Text support**: typed text (from Type Folio keyboard) is stored as CRDT
  sequences with formatting (bold, italic, font).
- **New pen types**: Ballpoint v2, Fineliner v2, Marker v2, Pencil v2,
  Calligraphy, Paintbrush, and the full color palette.
- **GlyphRange items**: highlighted text ranges in PDFs.
- **SceneInfo blocks**: document metadata like paper size.

Key block types (hex IDs):

| Block ID | Name | Meaning |
|---|---|---|
| `0x03` | `SceneTreeBlock` | Root of the scene tree |
| `0x04` | `TreeNodeBlock` | A group/layer node |
| `0x05` | `SceneGroupItemBlock` | An item within a group |
| `0x06` | `SceneLineItemBlock` | A single stroke with points |
| `0x07` | `RootTextBlock` | Text content (CRDT) |
| `0x08` | `SceneTombstoneItemBlock` | Deleted item marker |
| `0x09` | `PageInfoBlock` | Page dimensions & metadata |
| `0x0A` | `GlyphRangeBlock` | PDF highlight range |
| `0x0B` | `MigrationInfoBlock` | Format migration data |
| `0x0D` | `SceneInfoBlock` | Paper size, scene metadata |

The authoritative parser is **`rmscene`** (Python, MIT license):
```bash
pip install rmscene
```
```python
from rmscene import read_blocks
with open("page.rm", "rb") as f:
    blocks = read_blocks(f)
for block in blocks:
    print(block)
```

### 2.8 Other On-Device Locations

| Path | Contents |
|---|---|
| `/usr/share/remarkable/templates/` | Template PNG/SVG files + `templates.json` catalog |
| `/usr/share/remarkable/` | Splash screens (`sleeping.png`, `poweroff.png`, `starting.png`, etc.) |
| `/home/root/.config/remarkable/xochitl.conf` | Xochitl configuration (device token, sync state) |
| `/home/root/.ssh/authorized_keys` | SSH public keys for passwordless login |

### 2.9 What Gets Synced and What Matters for Download

For a **one-way pull to Mac**, you need:

| Must sync | Why |
|---|---|
| `*.metadata` | To know document names, hierarchy, types |
| `*.content` | To know page list, file type, page count |
| `<uuid>/` directories | Contains the `.rm` stroke files (the actual notes) |
| `*.pdf` | Original PDFs (to overlay annotations on) |
| `*.epub` | Original EPUBs |
| `*.pagedata` | To know which template each page uses (for rendering backgrounds) |

| Optional | Why |
|---|---|
| `*.thumbnails/` | Pre-rendered page thumbnails (useful for quick preview) |
| `*.highlights/` | Highlight ranges (for text extraction from PDFs) |
| `*.textconversion/` | On-device OCR results (already extracted text) |
| `*.cache/` | Rendering cache PNGs (can be regenerated) |

A full `rsync` grabs everything (~200–800 MB depending on library size).
A selective sync can skip `.cache/` and `.thumbnails/` to save bandwidth.

---

## 2A. Rendering Pipeline — From Raw Data to Viewable PDFs on Mac

### 2A.1 Overview

The `.rm` binary files are not directly viewable on macOS. They must be
**rendered** into a standard format (PDF, SVG, PNG). The pipeline:

```
.rm file  ──→  Parse strokes  ──→  Render to vector/raster  ──→  PDF/SVG/PNG
  │                │                       │
  │  rmscene (v6)  │    rmc / PyMuPDF      │     macOS Preview
  │  or struct     │    or device web UI   │     or any PDF reader
  │  unpack (v3/5) │                       │
```

### 2A.2 Rendering Options Comparison

| Method | Input | Output | V6 support | Speed | Quality | Offline |
|---|---|---|---|---|---|---|
| **`rmc`** (ricklupton) | `.rm` v6 files | PDF, SVG, Markdown | Yes | Fast | Good (strokes only) | Yes |
| **`remarks`** (Scrybble) | Raw backup tree | PDF, PNG, SVG, Markdown | Yes (partial) | Medium | Good | Yes |
| **`rmrl`** | Raw backup tree | PDF (with annotations) | **No** (v3/v5 only) | Fast | Excellent | Yes |
| **Device web UI** | UUID via HTTP | PDF | Yes (rendered by device) | Slow (5-10s/doc) | **Pixel-perfect** | Requires device |
| **`rmirro`** | Raw backup + renderer | PDF (mirrored tree) | Depends on renderer chosen | Medium | Good | If local renderer used |
| **PyMuPDF** custom | Parsed strokes | PDF | If combined with `rmscene` | Fast | Custom | Yes |

### 2A.3 Using `rmc` (Recommended for v6)

`rmc` wraps `rmscene` and produces PDF/SVG/Markdown:

```bash
pip install rmc

# Convert a single page to PDF:
rmc page.rm -o page.pdf

# Convert to SVG:
rmc page.rm -o page.svg

# Extract typed text to Markdown:
rmc -t markdown page.rm
```

**Limitations (as of v0.3.0):**
- Text boxes with multiple lines may render on a single line.
- Stroke positions can be slightly off when text boxes are present.
- No built-in support for overlaying annotations onto original PDFs.

For annotated PDFs, you need to:
1. Render the annotations to SVG/PDF with `rmc`.
2. Overlay them onto the original PDF using PyMuPDF.

### 2A.4 Rendering Annotated PDFs

When a document is a PDF with handwritten annotations:

```python
import fitz  # PyMuPDF
from rmc import convert  # hypothetical — actual API may differ

# 1. Open original PDF
original = fitz.open("raw/<uuid>.pdf")

# 2. For each page, render the .rm annotations to SVG
#    and overlay onto the PDF page
for page_num, page_uuid in enumerate(page_uuids):
    rm_file = f"raw/<uuid>/{page_uuid}.rm"
    # Parse and render strokes...
    # Insert as overlay on original[page_num]

# 3. Save
original.save("export/Annotated Document.pdf")
```

### 2A.5 Rendering Pure Notebooks (No Underlying PDF)

For notebooks (no original PDF), create pages from scratch:

1. Create a blank PDF page at 1404 × 1872 points (the rM canvas size).
2. Optionally draw the template background (from `.pagedata` + template PNG).
3. Render `.rm` strokes as vector paths (lines with varying width/opacity).
4. Each stroke becomes a series of bezier curves or line segments.
5. Pen pressure → line width modulation. Color → stroke color.

### 2A.6 Stroke Rendering Details

Each stroke in the `.rm` file has:
- **Pen type** → determines the brush texture/behavior
- **Color** → Black, Grey, White, Blue, Red, Green, Yellow, etc. (v6 has full palette)
- **Base width** → small/medium/large
- **Points** → each with (x, y, speed, direction, width, pressure)

Rendering a stroke:
1. Walk the point list pairwise.
2. For each segment, compute the rendered width from: `base_width × point.pressure × point.width`.
3. Draw a line/curve segment with that width.
4. Pen type affects opacity and texture:
   - **Ballpoint/Fineliner**: solid lines, full opacity
   - **Pencil**: textured, slightly transparent
   - **Highlighter**: wide, ~30% opacity, drawn behind other strokes
   - **Marker**: medium opacity, wider strokes
   - **Eraser**: removes previous strokes (handled during render by clipping)

Coordinate system:
- Origin: top-left
- X range: 0 – 1404 (pixels, ~5.58 inches at 226 DPI)
- Y range: 0 – 1872 (pixels, ~8.28 inches at 226 DPI)
- Physical page size: ~5.6" × 8.3" (close to A5)

### 2A.7 Viewing on macOS

Once rendered to PDF:

| Viewer | How | Notes |
|---|---|---|
| **Preview.app** | `open file.pdf` | Built-in, supports Live Text OCR (Ventura+) |
| **Skim** | Free PDF reader | Better annotation support, SyncTeX |
| **PDF Expert** | Commercial | Excellent annotation and organization |
| **Finder Quick Look** | Spacebar on file | Quick preview without opening |
| **Spotlight** | Indexes PDF text | Searchable if PDF contains text layer |

For browsing an entire exported library, a simple Finder folder structure works:
```
~/remarkable/export/
  Personal/
    Journal.pdf
    Ideas.pdf
  Work/
    Meeting Notes 2026-02.pdf
    Project Alpha/
      Design Specs.pdf
```

Templates live under `/usr/share/remarkable/templates/`.

---

## 3. Tool-by-Tool Viability Assessment (Feb 2026)

### 3.1 Still working / actively maintained

| Tool | What it does | Last activity | 2026 verdict |
|---|---|---|---|
| **`ddvk/rmapi`** | Cloud API CLI (Go). `mget /` mirrors everything. Incremental with `-i`. | Nov 2025 (v0.0.32) | **Works.** Handles sync protocol v3→v4 schema. Needs Connect subscription. `brew install io41/tap/rmapi`. |
| **`rmirro`** | SSH-based bi-dir mirror (Python). Pulls PDFs of all docs. Uses USB web interface or `rmrl`/`rmc` for rendering. | 2024 | **Works** for SSH pull. Requires rsync + `ssh remarkable` alias. |
| **`remarkable-cli-tooling`** (`resync.py`) | SSH push/pull/backup (Python). Uses device web-interface for PDF rendering. | 2023, tested up to fw 2.14 | **Likely works** on 3.x for raw pull; PDF rendering via web UI still available. |
| **`remarkable-mcp`** | MCP server (Python). SSH or Cloud. `uvx remarkable-mcp --ssh`. Browse, read, OCR, export via AI tooling. | Feb 2026 (3 days ago!) | **Actively developed.** Great for AI workflows. Uses `rmscene` under the hood. |
| **`rm-exporter`** | GUI exporter (Go/Wails). USB web interface, handles large notes. | Jan 2026 (v0.3.0) | **Works** on fw 3.10+. GUI only, USB-only (not Wi-Fi SSH). |
| **`remarks`** (Scrybble) | Convert `.rm` → PDF/Markdown/PNG/SVG (Python). Supports v6 files. | Dec 2025 | **Works.** Good for offline rendering of raw backups. |
| **`rmscene`** (ricklupton) | Python parser for v6 `.rm` format. | Active (used by remarkable-mcp, remarks) | **Core library.** Essential for any Python rendering pipeline. |
| **`rmrl`** | Python lib: annotated docs → PDF. | 2021–2022 | Handles v3/v5 only. **Will not work** for v6 notebooks created on fw 3.x. |

### 3.2 Dead / archived / broken in 2026

| Tool | Status | Why |
|---|---|---|
| **`juruen/rmapi`** (original) | **Archived** Jul 2024 | Use `ddvk/rmapi` instead. |
| **`rmapy`** | Unmaintained | Python cloud lib, old sync protocol. |
| **`pyrmexplorer`** (rMExplorer) | Last update Jun 2019 | Windows-centric GUI; depends on ImageMagick + Ghostscript; ancient. |
| **`remarkable_syncthing`** | Last update 2022 | Requires Toltec on device (may not work on fw 3.x); complex; networking caveats. |
| **`rMsync`** (lschwetlick) | Last update 2021 | Depends on old `maxio` rm_tools; only supports v3/v5 `.rm` format. |
| **`ReMy`** (bordaigorl) | Last commit 2022 | **Does NOT support firmware v3 / v6 format.** See issue #49. Still usable for fw ≤2 or for raw data viewing. |
| **`RCU`** (davisr.me) | Still sold ($12) | Closed-source; works over SSH; supports v6. Not open-source so hard to script around. |

---

## 4. Recommended Architecture for Our CLI Tool

### 4.1 Phases

```
Phase 1: RAW PULL (SSH+rsync)     → local mirror of xochitl/
Phase 2: RENDER   (rmscene+PDF)   → human-readable PDFs in folder tree
Phase 3: VIEW     (macOS open)    → open PDFs in Preview / any viewer
```

### 4.2 Phase 1: Raw Pull

```bash
#!/bin/zsh
REMARKABLE_HOST="${REMARKABLE_HOST:-remarkable}"    # SSH config alias
REMARKABLE_DATA="/home/root/.local/share/remarkable/xochitl/"
LOCAL_RAW="$HOME/remarkable/raw/"

mkdir -p "$LOCAL_RAW"
rsync -avz --delete \
  -e ssh \
  "root@${REMARKABLE_HOST}:${REMARKABLE_DATA}" \
  "$LOCAL_RAW"
```

This gives you a 1:1 copy of the device filesystem. Incremental on subsequent
runs (rsync's delta algorithm). Typically takes <30 seconds after first sync.

**Requirements:**
- SSH key auth configured (`~/.ssh/config` with `Host remarkable`)
- Wi-Fi SSH enabled on the reMarkable (Settings → General → Developer Mode)
- No software installed on the device

### 4.3 Phase 2: Render Notes to PDF

Two options:

#### Option A: Local rendering with `rmscene` + PyMuPDF (recommended)

Use `remarks` or write a small Python script that:
1. Walks the `.metadata` files to reconstruct the folder tree and visible names.
2. For each notebook (type `"DocumentType"`):
   - If it has a `.pdf` → copy the PDF, overlay annotations.
   - If it's a pure notebook → render each `<page>.rm` to PDF using `rmscene`.
3. Save the rendered PDFs into a mirror folder structure.

```
~/remarkable/
  raw/              ← rsync'd binary data
  export/           ← rendered PDFs in human-readable folder tree
    My Notebook.pdf
    Work/
      Meeting Notes.pdf
      Project Plan.pdf
```

Libraries:
- `rmscene` — parse v6 `.rm` files
- `PyMuPDF` (fitz) — create and annotate PDFs
- `rmc` (ricklupton) — higher-level render from rmscene to SVG/PDF

#### Option B: Device-side rendering via USB/Wi-Fi web interface

The reMarkable exposes `http://10.11.99.1/` (USB) or the same over Wi-Fi when
the web interface is enabled. You can `curl` individual documents as PDF:

```bash
curl -s "http://${REMARKABLE_HOST}:80/download/${UUID}/placeholder" -o doc.pdf
```

Pro: pixel-perfect rendering by the device's own software.
Con: slow (~5-10s per document); must iterate; device must be awake and not in sleep mode.

`remarkable-cli-tooling`'s `resync.py` uses this method. `rmirro` can use either.

### 4.4 Phase 3: Local Viewing

Once you have PDFs:
```bash
open ~/remarkable/export/  # opens Finder
# or
open ~/remarkable/export/My\ Notebook.pdf  # opens in Preview
```

For richer annotation viewing, `ReMy` can be pointed at the raw backup as a
"local source" (if you're on firmware ≤2 files).

For text extraction / OCR of handwritten notes:
- `remarkable-mcp` with `sampling` or `google` OCR backend
- `tesseract` on rendered PNGs
- macOS built-in OCR (Live Text in Preview, macOS Ventura+)

---

## 5. Implementation Options

### Option A: Pure Shell Script (~50 lines of zsh)
- rsync pull
- Walk `.metadata` with `jq` to build folder tree
- Use `curl` against device web interface to render PDFs
- Simple, no Python dependency
- **Downside**: can't render v6 `.rm` files locally; relies on device for PDF rendering

### Option B: Python Script (~200 lines)
- rsync pull (via `subprocess` or pure `paramiko`)
- Parse `.metadata` with `json` module
- Render with `rmscene` + `rmc` or `PyMuPDF`
- **Best balance** of capability and simplicity
- Can run offline after first rsync

### Option C: Wrap existing tool
- Use `rmirro` directly (it already does phases 1–3)
- Use `ddvk/rmapi mget -o ~/remarkable/export -i /` for cloud-based
- Least custom code, but less control

### Recommendation: **Option B (Python)** with Option A as a fallback mode

---

## 6. What's New / Proven in 2026

1. **`rmscene`** has matured into the de-facto standard for parsing the v6 file
   format used by firmware 3.x. It's used by `remarkable-mcp`, `remarks`, and
   `rmc`.

2. **`ddvk/rmapi`** is the clear winner for cloud-based access — actively
   maintained, Homebrew-installable, handles the latest sync protocol v4 with
   content-based hashing (as of Dec 2025).

3. **`remarkable-mcp`** is the newest entrant (late 2025) — an MCP server that
   lets AI assistants read your notes via SSH. Great for Copilot/Claude
   integration but also useful as a standalone Python library for note access.

4. **SSH + rsync remains the most reliable transport** — it has worked unchanged
   since the reMarkable 1 and survives every firmware update. No subscription,
   no cloud, no software on device.

5. **Syncthing is no longer recommended** — Toltec (the package manager needed
   to install it on the device) has compatibility issues with firmware 3.x, and
   the setup complexity isn't justified for one-way sync.

6. **ReMy is stuck on firmware ≤2** — the v6 format support hasn't landed
   (issue #49 open since 2022). Still excellent if you export raw data and use
   it as viewer for older-format files.

---

## 7. Quick-Start: Minimum Viable Sync (Shell Only)

```bash
# 1. Set up SSH (one-time)
#    Get your SSH password from: Settings > Help > Copyrights and licenses
#    Scroll to bottom for IP address
ssh-copy-id root@remarkable    # or use the IP shown on the tablet

# 2. Add to ~/.ssh/config:
#    Host remarkable
#      HostName 192.168.1.XXX   # your tablet's Wi-Fi IP
#      User root
#      IdentityFile ~/.ssh/id_ed25519

# 3. Pull everything
rsync -avz -e ssh root@remarkable:/home/root/.local/share/remarkable/xochitl/ \
  ~/remarkable/raw/

# 4. Render via device web interface (if enabled)
# List docs:
ssh remarkable 'ls /home/root/.local/share/remarkable/xochitl/*.metadata' | head

# 5. Or install rmscene + render locally:
pip install rmscene rmc pymupdf
# (then use a Python script to walk metadata and render)
```

---

## 8. Bidirectional Sync — Editing on Mac & Pushing Back to reMarkable

### 8.1 Is It Possible? — Yes, With Caveats

Bidirectional sync (Mac ↔ reMarkable) **is possible** and there are multiple
proven approaches. However, the depth of what you can edit on the Mac and push
back varies significantly by approach.

### 8.2 Is the Format Open or Closed?

**The format is proprietary but fully reverse-engineered and documented:**

| Format component | Type | Openness |
|---|---|---|
| `.metadata`, `.content` | Plain JSON | **Fully open** — human-readable, trivially editable |
| `.pagedata` | Plain text (one template name per line) | **Fully open** |
| `.rm` v3/v5 (firmware ≤2.x) | Binary (flat struct, little-endian) | **Fully documented** — simple struct with floats/ints; parsers exist in Python, Go, C |
| `.rm` v6 (firmware ≥3.0) | Binary (tagged blocks, CRDT-based) | **Reverse-engineered** — `rmscene` can both **read and write** v6 files. Not officially documented by reMarkable, but community understanding is very thorough. |
| Cloud sync protocol (v3/v4) | HTTPS API | **Reverse-engineered** — `ddvk/rmapi` handles both schema v3 and v4 (content-hashing, Dec 2025). Requires Connect subscription. |

**Bottom line**: Nothing is encrypted or DRM'd. The format is binary but
**completely open to read AND write** from third-party tools. reMarkable has
never taken action against community tools.

### 8.3 Bidirectional Sync Approaches — What's Possible

#### Tier 1: Upload PDFs / EPUBs to the reMarkable (fully proven)

This is the simplest bidirectional workflow — you create or edit a PDF on the
Mac and push it to the device. The reMarkable renders it natively and you can
annotate on top.

| Method | How | Complexity |
|---|---|---|
| **`ddvk/rmapi put`** | `rmapi put document.pdf /folder` — uploads via Cloud API | Low. `brew install io41/tap/rmapi`. Appears on device within seconds. Needs Connect subscription. |
| **`ddvk/rmapi put --content-only`** | Replaces only the PDF content while **preserving existing annotations** | Low. Great for updated drafts. |
| **ReMy** drag-and-drop | Drag PDF/EPUB onto folder in ReMy GUI — uploads via SSH | Low. Only works with fw ≤2 format. |
| **`scp` + metadata creation** | Manually copy `.pdf` + create `.metadata`/`.content` JSON files, then restart xochitl | Medium. No dependencies, but you must craft the UUID and metadata. Works on all firmware. |
| **Device USB web interface** | `http://10.11.99.1/upload` — built-in upload via browser | Trivial. USB only, one file at a time. |

#### Tier 2: Push handwritten note data (.rm files) back to the device (advanced)

This is where it gets interesting. `rmscene` has a **write mode** and `rmc` can
**create `.rm` files from Markdown text**:

```bash
# Create a .rm file containing typed text from a Markdown file:
rmc -t rm text.md -o text.rm
```

```python
# Programmatic write with rmscene:
from rmscene import write_blocks
# Construct blocks (SceneTreeBlock, TreeNodeBlock, SceneLineItemBlock, etc.)
# and write them to a .rm file
with open("page.rm", "wb") as f:
    write_blocks(f, blocks, options={"version": "3.6"})
```

**What this enables:**
- Create new notebooks on the Mac with typed text and push them to the device
- Programmatically generate handwriting-like content
- Round-trip: pull `.rm` → modify blocks → write `.rm` → push back

**What's hard/risky:**
- Editing existing handwritten strokes on the Mac is technically possible (parse,
  modify, rewrite) but there's no GUI tool for this — you'd be editing raw
  stroke coordinates programmatically
- The CRDT structure in v6 means you must maintain consistency of IDs and
  sequence counters, or xochitl may reject/corrupt the file
- After pushing modified `.rm` files, you must restart xochitl:
  `ssh remarkable systemctl restart xochitl`

#### Tier 3: Full bidirectional rsync (raw filesystem sync)

Since the data is just files on a Linux filesystem, you can `rsync` in **both
directions**:

```bash
# Pull (device → Mac):
rsync -avz root@remarkable:/home/root/.local/share/remarkable/xochitl/ ~/remarkable/raw/

# Push (Mac → device) — CAUTION:
rsync -avz ~/remarkable/raw/ root@remarkable:/home/root/.local/share/remarkable/xochitl/

# Then restart the UI so it picks up changes:
ssh remarkable systemctl restart xochitl
```

**Danger zone**: pushing files while xochitl is running can cause data loss or
corruption. Always stop xochitl before pushing, then restart:

```bash
ssh remarkable systemctl stop xochitl
rsync -avz ~/remarkable/raw/ root@remarkable:/home/root/.local/share/remarkable/xochitl/
ssh remarkable systemctl restart xochitl
```

### 8.4 Realistic "Edit on Mac" Workflows

| Workflow | Feasibility | How |
|---|---|---|
| **Annotate a PDF on Mac, push updated PDF to rM** | **Easy** | Edit PDF in Preview/PDF Expert → `rmapi put --content-only updated.pdf /path` |
| **Create a new notebook with typed text on Mac** | **Possible** | Write Markdown → `rmc -t rm text.md -o page.rm` → craft metadata/content JSON → scp + restart xochitl |
| **View handwritten notes as PDF on Mac** | **Easy** | Pull via rsync → render with `rmc`/`rmscene` → open PDF |
| **Edit handwritten strokes on Mac with a GUI** | **Not yet possible** | No tool exists that lets you visually edit `.rm` strokes on Mac and push back. ReMy is read-only for notes. RCU (closed-source, $12) has limited editing. |
| **Merge changes from both sides** | **Fragile** | The CRDT structure in v6 was designed for this (cloud sync uses it), but no open-source tool exposes merge/conflict resolution. Cloud sync via `rmapi` is the safest bidirectional path. |

### 8.5 How Far Can We Take This?

**Realistic ceiling in 2026:**

1. **One-way pull + render** (our Phase 1–3): Rock-solid, fully automated,
   no limitations.

2. **Push PDFs back**: Fully production-ready via `rmapi put` or `scp`.
   This is probably the most useful bidirectional workflow — prepare reading
   material or reference docs on Mac, push to rM, annotate there, pull back.

3. **Push new text notebooks**: Works via `rmc -t rm`, but creating the full
   metadata envelope (UUID, `.metadata`, `.content`, `.pagedata`) requires
   scripting. Doable in ~50 lines of Python.

4. **Edit existing handwritten notes on Mac**: Technically possible by modifying
   the parsed block tree in `rmscene` and writing back, but no visual editor
   exists. You'd be operating on raw coordinates. Useful for programmatic
   transforms (e.g., "move all strokes 100px down") but not for freehand editing.

5. **True real-time bidirectional sync**: Not achievable without reMarkable's
   own cloud sync protocol. The CRDT format was built for this, but the
   protocol isn't fully open. `ddvk/rmapi` comes closest but operates at the
   file level, not the CRDT merge level.

---

## 9. OneDrive Integration — Archiving Exported Notes

### 9.1 Mac-Side: Sync Exported PDFs into OneDrive (Recommended)

The simplest and most robust approach: **point the PDF export directory at a
OneDrive folder**. OneDrive for Mac will automatically sync it to the cloud.

```
Sync pipeline:
  reMarkable ──SSH/rsync──→ Mac (~/remarkable/raw/)
                               │
                          render to PDF
                               │
                               ▼
                   ~/OneDrive/remarkable/export/
                               │
                      OneDrive client auto-syncs
                               │
                               ▼
                        OneDrive cloud
```

**Implementation:**

```bash
# In the sync script, set the export directory to be inside OneDrive:
EXPORT_DIR="$HOME/Library/CloudStorage/OneDrive-Personal/remarkable/export"
# or for OneDrive Business:
EXPORT_DIR="$HOME/Library/CloudStorage/OneDrive-YourOrg/remarkable/export"

mkdir -p "$EXPORT_DIR"

# After rendering PDFs, they land in $EXPORT_DIR
# OneDrive client picks them up automatically — done.
```

You can also archive the **raw xochitl data** into OneDrive for a full binary
backup:

```bash
RAW_ARCHIVE="$HOME/Library/CloudStorage/OneDrive-Personal/remarkable/raw-backup"
rsync -avz ~/remarkable/raw/ "$RAW_ARCHIVE/"
```

**Advantages:**
- Zero additional infrastructure
- OneDrive handles versioning (File History)
- Notes searchable in OneDrive if PDFs contain text layers (OCR or typed text)
- Accessible from any device with OneDrive access
- Automatic — just run the sync script and OneDrive does the rest

**Scheduling with launchd:**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.user.remarkable-sync</string>
    <key>ProgramArguments</key>
    <array>
        <string>/Users/YOU/remarkable/sync.sh</string>
    </array>
    <key>StartInterval</key>
    <integer>1800</integer>  <!-- every 30 minutes -->
    <key>StandardOutPath</key>
    <string>/tmp/remarkable-sync.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/remarkable-sync.err</string>
</dict>
</plist>
```

Install: `cp com.user.remarkable-sync.plist ~/Library/LaunchAgents/ && launchctl load ~/Library/LaunchAgents/com.user.remarkable-sync.plist`

### 9.2 On-Device: Running a OneDrive Client on the reMarkable — Not Practical

**Short answer: No, you cannot run a OneDrive client directly on the reMarkable.**

Here's why:

| Constraint | Detail |
|---|---|
| **Architecture** | reMarkable 2 is ARMv7 (32-bit ARM). No Microsoft OneDrive client exists for this platform. |
| **OS** | Minimal Linux (no glibc desktop stack, no systemd user services by default, ~227 MB root partition). |
| **RAM** | 1 GB total, most consumed by xochitl. Very little headroom for background services. |
| **No official package manager** | Toltec (community opkg) exists but has **compatibility issues with firmware 3.x** and offers no OneDrive package. |
| **OAuth complexity** | OneDrive requires OAuth2 browser-based authentication — no browser available on the device. Token refresh adds fragility. |
| **rclone** | Theoretically `rclone` could be cross-compiled for armv7 and run on the device. But: it's ~50 MB binary, needs OAuth tokens, and would compete with xochitl for RAM and network. **Extremely fragile.** |
| **Firmware updates** | reMarkable firmware updates can wipe `/home` modifications. Any installed software is at risk. |

#### Could a Cron Job on the reMarkable Push to OneDrive?

Technically conceivable but **strongly discouraged**:

```
Hypothetical (NOT RECOMMENDED):
  1. Cross-compile rclone for armv7
  2. scp it to /home/root/bin/rclone on the device
  3. Configure rclone with OneDrive tokens (requires browser auth once,
     then store tokens on device)
  4. Add cron job:
     */30 * * * * /home/root/bin/rclone sync \
       /home/root/.local/share/remarkable/xochitl/ \
       onedrive:remarkable-backup/
```

**Problems:**
- rclone binary is ~50 MB; device has limited storage
- OAuth tokens expire; no browser for re-auth
- rclone syncing while xochitl is writing = potential corruption
- Firmware update may wipe the binary + cron job
- Increased battery drain from periodic network activity
- If it breaks, you need SSH access to debug — which requires the tablet to be
  on the same network

#### Better Alternative: Mac as the Hub

The far more reliable pattern is:

```
reMarkable ──(SSH/rsync, triggered from Mac)──→ Mac ──(OneDrive client)──→ Cloud
```

The Mac acts as the bridge. The reMarkable doesn't need any modification. The
Mac is always on (or wakes for the launchd job), has reliable networking, has
the OneDrive client running, and has the processing power for rendering.

If you want something even closer to "automatic from the device," consider:

1. **Enable reMarkable Cloud sync** (requires Connect subscription, $3/month).
   Notes sync to reMarkable's cloud.
2. Use `ddvk/rmapi mget -o ~/OneDrive/.../remarkable -i /` on a schedule on
   the Mac to pull from the cloud to OneDrive.
3. This gives you cloud→cloud transfer without needing the tablet on the same
   Wi-Fi.

### 9.3 Summary: Recommended OneDrive Architecture

```
┌─────────────┐     SSH/rsync      ┌──────────────┐     auto-sync     ┌─────────────┐
│  reMarkable  │ ───────────────→  │   Mac (hub)   │ ───────────────→ │   OneDrive   │
│   (Wi-Fi)    │   every 30 min    │ ~/remarkable/ │   OneDrive app   │    Cloud     │
│              │   via launchd     │  raw/ + export/│                  │              │
│              │ ←───────────────  │  (in OneDrive  │ ←─────────────── │              │
│              │   push PDFs back  │   folder)      │   OneDrive app   │              │
└─────────────┘   via rmapi/scp   └──────────────┘                   └─────────────┘
```

| Direction | Method | Automatic? |
|---|---|---|
| rM → Mac | rsync over SSH (launchd, every 30 min) | Yes |
| Mac → OneDrive | OneDrive desktop client | Yes (instant) |
| OneDrive → Mac | OneDrive desktop client | Yes (instant) |
| Mac → rM | `rmapi put` or `scp` (manual or scripted) | Manual or scripted |

---

## 10. Open Questions / TBD

- [ ] Shell-only vs Python vs hybrid? (Recommendation: Python for rendering, shell for transport)
- [ ] Incremental PDF export (only re-render changed docs)?
- [ ] Support for typed text extraction (Type Folio)?
- [ ] OCR integration for handwritten → searchable PDF?
- [ ] Cron/launchd scheduling for automatic sync?
- [ ] Notification when sync completes?
- [ ] Bidirectional conflict resolution strategy?
- [ ] Should raw backup also go to OneDrive, or only rendered PDFs?
- [ ] Test `rmc -t rm` round-trip quality (Markdown → .rm → render back)?

---

## 11. References

| Resource | URL |
|---|---|
| awesome-reMarkable | https://github.com/reHackable/awesome-reMarkable |
| ddvk/rmapi (maintained fork) | https://github.com/ddvk/rmapi |
| rmirro | https://github.com/hersle/rmirro |
| remarkable-cli-tooling | https://github.com/cherti/remarkable-cli-tooling |
| remarkable-mcp | https://github.com/SamMorrowDrums/remarkable-mcp |
| rmscene (v6 parser) | https://github.com/ricklupton/rmscene |
| rmc (renderer) | https://github.com/ricklupton/rmc |
| remarks (Scrybble) | https://github.com/Scrybbling-together/remarks |
| rm-exporter (GUI) | https://github.com/chopikus/rm-exporter |
| ReMy | https://github.com/bordaigorl/remy |
| reMarkable file format wiki | https://web.archive.org/web/20230616050052/https://remarkablewiki.com/tech/filesystem |
| .rm binary format blog (ax3l) | https://plasma.ninja/blog/devices/remarkable/binary/format/2017/12/26/reMarkable-lines-file-format.html |
| reMarkable Kaitai Struct specs | https://github.com/matomatical/reMarkable-kaitai |
| Syncthing on rM | https://github.com/Evidlo/remarkable_syncthing |
| pyrmexplorer | https://github.com/bruot/pyrmexplorer/wiki |
| juruen/rmapi (archived) | https://github.com/juruen/rmapi |
