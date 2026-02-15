/**
 * Parse reMarkable v6 .rm binary files.
 *
 * Extracts stroke (line) data — tool, colour, thickness, and point arrays —
 * from the tagged-block CRDT format used since firmware 3.x.
 *
 * Based on the rmscene Python library by Rick Lupton and ddvk's Go reader.
 */

'use strict';

// ── Constants ───────────────────────────────────────

const HEADER_V6 = 'reMarkable .lines file, version=6          '; // 43 bytes
const HEADER_LEN = 43;

// Tag types (lower 4 bits of the varuint tag)
const TAG = { ID: 0xf, LEN4: 0xc, BYTE8: 0x8, BYTE4: 0x4, BYTE1: 0x1 };

// Pen tool IDs
const PEN = {
  PAINTBRUSH_1: 0, PENCIL_1: 1, BALLPOINT_1: 2, MARKER_1: 3,
  FINELINER_1: 4, HIGHLIGHTER_1: 5, ERASER: 6, MECH_PENCIL_1: 7,
  ERASER_AREA: 8, SELECTION: 9, PAINTBRUSH_2: 12, MECH_PENCIL_2: 13,
  PENCIL_2: 14, BALLPOINT_2: 15, MARKER_2: 16, FINELINER_2: 17,
  HIGHLIGHTER_2: 18, CALLIGRAPHY: 21, SHADER: 23, SPRAY: 24,
};

// Colour IDs → CSS colours
const COLORS = {
  0: '#000000', // BLACK
  1: '#808080', // GRAY
  2: '#ffffff', // WHITE
  3: '#fbde5a', // YELLOW
  4: '#5ab95a', // GREEN
  5: '#ff7878', // PINK
  6: '#5566ff', // BLUE
  7: '#ff4444', // RED
  8: '#808080', // GRAY_OVERLAP
  9: '#ffff00', // HIGHLIGHT
  10: '#3baa3b', // GREEN_2
  11: '#00c8ff', // CYAN
  12: '#d040d0', // MAGENTA
};

// ── Low-level reader ────────────────────────────────

class BufReader {
  constructor(buffer) {
    this.buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
    this.pos = 0;
  }

  get remaining() { return this.buf.length - this.pos; }

  u8()  { const v = this.buf.readUInt8(this.pos);     this.pos += 1; return v; }
  u16() { const v = this.buf.readUInt16LE(this.pos);  this.pos += 2; return v; }
  u32() { const v = this.buf.readUInt32LE(this.pos);  this.pos += 4; return v; }
  f32() { const v = this.buf.readFloatLE(this.pos);   this.pos += 4; return v; }
  f64() { const v = this.buf.readDoubleLE(this.pos);  this.pos += 8; return v; }

  varuint() {
    let result = 0;
    let factor = 1;
    for (;;) {
      const b = this.u8();
      result += (b & 0x7f) * factor;
      if (!(b & 0x80)) return result;
      factor *= 128;
    }
  }

  /** Read a tag and return {index, type}. */
  tag() {
    const x = this.varuint();
    return { index: x >> 4, type: x & 0xf };
  }

  /** Read and verify a tag at expected index & type; throws if mismatch. */
  expectTag(index, type) {
    const saved = this.pos;
    const t = this.tag();
    if (t.index !== index || t.type !== type) {
      this.pos = saved;
      throw new TagMismatch(index, type, t);
    }
  }

  /** Check if the next tag matches without consuming it. */
  checkTag(index, type) {
    const saved = this.pos;
    try {
      const t = this.tag();
      return t.index === index && t.type === type;
    } catch { return false; }
    finally { this.pos = saved; }
  }

  /** Read CrdtId (uint8 + varuint). */
  crdtId() { return { a: this.u8(), b: this.varuint() }; }

  // ── Tagged high-level reads ──────────────────────

  taggedId(i)     { this.expectTag(i, TAG.ID);    return this.crdtId(); }
  taggedBool(i)   { this.expectTag(i, TAG.BYTE1); return !!this.u8();  }
  taggedInt(i)    { this.expectTag(i, TAG.BYTE4); return this.u32();    }
  taggedFloat(i)  { this.expectTag(i, TAG.BYTE4); return this.f32();    }
  taggedDouble(i) { this.expectTag(i, TAG.BYTE8); return this.f64();    }
  subblockLen(i)  { this.expectTag(i, TAG.LEN4);  return this.u32();    }

  /** Skip a subblock entirely (read its length tag then advance past it). */
  skipSubblock(i) { this.pos += this.subblockLen(i); }

  /** Read a LWW<bool> at tag index i.  Returns the bool value. */
  readLwwBool(i) {
    const len = this.subblockLen(i);
    const end = this.pos + len;
    this.taggedId(1);         // timestamp
    this.expectTag(2, TAG.BYTE1);
    const val = !!this.u8();
    this.pos = end;
    return val;
  }
}

class TagMismatch extends Error {
  constructor(ei, et, got) {
    super(`Expected tag(${ei},0x${et.toString(16)}) got tag(${got.index},0x${got.type.toString(16)})`);
  }
}

// ── Scene-tree helpers ──────────────────────────────

/**
 * Parse a SceneTreeTag block (type 0x01).
 *
 * Extracts parent-child relationships from tree move operations.
 * Format: tag(1,ID) nodeId · tag(2,ID) secondaryId · tag(3,BYTE1) isUpdate
 *         · tag(4,LEN4) ItemInfo{ tag(1,ID) parentId, ... }
 *
 * NOTE: tag(3) is IsUpdate, NOT visibility. Visibility lives in type 0x02.
 */
function parseSceneTreeBlock(r, nodeParent) {
  const nodeId = r.taggedId(1);
  const nodeKey = `${nodeId.a}:${nodeId.b}`;

  // tag(2, ID) — secondary node reference (optional)
  if (r.checkTag(2, TAG.ID)) r.taggedId(2);

  // tag(3, BYTE1) — isUpdate flag (skip — NOT visibility!)
  if (r.checkTag(3, TAG.BYTE1)) r.taggedBool(3);

  // tag(4, LEN4) — ItemInfo subblock containing ParentId
  if (r.checkTag(4, TAG.LEN4)) {
    const subLen = r.subblockLen(4);
    const subEnd = r.pos + subLen;
    try {
      const parentId = r.taggedId(1);
      nodeParent.set(nodeKey, `${parentId.a}:${parentId.b}`);
    } catch { /* skip malformed subblock */ }
    r.pos = subEnd;
  }
}

/**
 * Parse a SceneTreeNodeTag block (type 0x02).
 *
 * Extracts node metadata — specifically the visibility flag.
 * Format: tag(1,ID) nodeId · tag(2,LEN4) LWW<string> name
 *         · tag(3,LEN4) LWW<bool> visible · ...anchors...
 */
function parseSceneTreeNodeBlock(r, nodeVisible) {
  const nodeId = r.taggedId(1);
  const nodeKey = `${nodeId.a}:${nodeId.b}`;

  // tag(2, LEN4) — LWW<string> name (skip)
  if (r.checkTag(2, TAG.LEN4)) r.skipSubblock(2);

  // tag(3, LEN4) — LWW<bool> visible — the authoritative visibility flag
  if (r.checkTag(3, TAG.LEN4)) {
    nodeVisible.set(nodeKey, r.readLwwBool(3));
  }
}

// ── Parser ──────────────────────────────────────────

/**
 * Parse a v6 .rm buffer and return an array of line objects.
 *
 * Properly builds the scene tree from type 0x01/0x02 blocks, resolves layer
 * visibility, and only returns strokes from visible layers.
 *
 * Handles all scene-item block types (0x03, 0x04, 0x05, 0x08) so that
 * deletions from any block type are tracked — fixing erased strokes that
 * previously remained visible.
 *
 * Each line: { tool, color, thicknessScale, points: [{x, y, width, pressure}] }
 */
function parseRmFile(buffer) {
  const r = new BufReader(buffer);

  // Validate header
  const hdr = r.buf.toString('ascii', 0, HEADER_LEN);
  if (!hdr.startsWith('reMarkable .lines file, version=6')) {
    throw new Error('Not a v6 .rm file: ' + hdr.slice(0, 40));
  }
  r.pos = HEADER_LEN;

  const liveLines   = new Map();  // itemKey → { line, parentKey }
  const liveGroups  = new Map();  // itemKey → { parentKey, leftKey, nodeRefKey }
  const nodeParent  = new Map();  // nodeKey → parentKey  (from type 0x01)
  const nodeVisible = new Map();  // nodeKey → boolean    (from type 0x02)

  while (r.pos < r.buf.length - 4) {
    let blockLen, blockType, blockEnd, currentVersion;
    try {
      blockLen       = r.u32();
      /* unknown */    r.u8();
      /* minVer */     r.u8();
      currentVersion = r.u8();
      blockType      = r.u8();
      blockEnd       = r.pos + blockLen;
    } catch { break; }

    try {
      switch (blockType) {
        case 0x01: // SceneTreeTag — tree structure (parent-child)
          parseSceneTreeBlock(r, nodeParent);
          break;
        case 0x02: // SceneTreeNodeTag — layer visibility
          parseSceneTreeNodeBlock(r, nodeVisible);
          break;
        case 0x03: // GlyphItemTag
        case 0x05: // LineItemTag
        case 0x08: // Additional scene items
          parseSceneItemBlock(r, currentVersion, liveLines);
          break;
        case 0x04: // GroupItemTag
          parseGroupItemBlock(r, liveGroups, liveLines);
          break;
        // 0x00 MigrationInfo, 0x06 TextItem, 0x07 RootText,
        // 0x09 UUIDIndex, 0x0A PageInfo — safely skipped
      }
    } catch {
      // Skip blocks we can't parse
    }

    // Advance to block end regardless of what we consumed
    r.pos = Math.min(blockEnd, r.buf.length);
  }

  // ── Resolve effective visibility ──
  const ROOT_KEY = '0:1';

  function isVisible(key) {
    if (!key || key === ROOT_KEY) return true;
    const v = nodeVisible.get(key);
    if (v === false) return false;
    const parent = nodeParent.get(key);
    return parent ? isVisible(parent) : true;
  }

  // ── Collect visible strokes grouped by parent ──
  const result = [];
  for (const { line, parentKey } of liveLines.values()) {
    if (isVisible(parentKey)) {
      line.groupKey = parentKey;
      result.push(line);
    }
  }

  // ── Compute per-group Y offsets for sub-grouped pages ──
  // Sort groups within each parent by CRDT left-right ordering,
  // then stack them vertically so their local coordinates don't overlap.
  if (liveGroups.size > 0) {
    applyGroupOffsets(result, liveGroups);
  }

  return result;
}

/**
 * Parse a SceneGroupItemBlock (type 0x04).
 *
 * Shares the same CRDT envelope as other scene items.  The value (item type
 * 0x02) contains a CrdtId referencing the scene tree node this group maps to.
 * The left/right IDs establish the vertical ordering of groups within a layer.
 */
function parseGroupItemBlock(r, liveGroups, liveLines) {
  const parentId = r.taggedId(1);
  const parentKey = `${parentId.a}:${parentId.b}`;
  const itemId = r.taggedId(2);
  const itemKey = `${itemId.a}:${itemId.b}`;
  const leftId = r.taggedId(3);
  const leftKey = `${leftId.a}:${leftId.b}`;
  r.taggedId(4);                     // right_id
  const del = r.taggedInt(5);
  if (del > 0) {
    liveGroups.delete(itemKey);
    liveLines.delete(itemKey);
    return;
  }

  if (!r.checkTag(6, TAG.LEN4)) return;
  const subLen = r.subblockLen(6);
  const subEnd = r.pos + subLen;
  const itemType = r.u8();

  if (itemType === 0x02) {
    // Value is a CrdtId referencing the scene tree node for this group
    const nodeRefId = r.taggedId(2);
    const nodeRefKey = `${nodeRefId.a}:${nodeRefId.b}`;
    liveGroups.delete(itemKey);
    liveGroups.set(itemKey, { parentKey, leftKey, nodeRefKey });
  }

  r.pos = subEnd;
}

/**
 * Sort CRDT sequence items by their left-id chain and return ordered keys.
 */
function crdtSort(items) {
  const END = '0:0';
  const byLeft = new Map();
  for (const [itemKey, entry] of items) {
    byLeft.set(entry.leftKey, itemKey);
  }

  const sorted = [];
  const used = new Set();
  let key = byLeft.get(END);
  while (key && !used.has(key)) {
    used.add(key);
    sorted.push(key);
    key = byLeft.get(key);
  }
  // Append any items not reachable from the chain start
  for (const [itemKey] of items) {
    if (!used.has(itemKey)) sorted.push(itemKey);
  }
  return sorted;
}

/**
 * Apply cumulative Y offsets to strokes in sub-grouped pages.
 *
 * On pages with typed text, handwritten strokes are organized into sub-groups
 * whose coordinates are local (Y centred near 0).  The CRDT ordering of the
 * group items defines their top-to-bottom sequence on the page.  We stack
 * groups vertically by their bounding-box height so they no longer overlap.
 */
function applyGroupOffsets(lines, liveGroups) {
  // Map nodeRefKey → groupKey (the key that strokes reference)
  const nodeToGroup = new Map();
  for (const [, g] of liveGroups) {
    nodeToGroup.set(g.nodeRefKey, g.nodeRefKey);
  }

  // Collect the set of groupKeys that actually have strokes
  const groupKeys = new Set();
  for (const ln of lines) {
    if (ln.groupKey) groupKeys.add(ln.groupKey);
  }

  // Only process if there are multiple groups with strokes
  if (groupKeys.size <= 1) return;

  // Compute local bounding box for each group
  const bounds = {};
  for (const ln of lines) {
    const gk = ln.groupKey;
    if (!gk) continue;
    if (!bounds[gk]) bounds[gk] = { minY: Infinity, maxY: -Infinity };
    const b = bounds[gk];
    for (const p of ln.points) {
      if (p.y < b.minY) b.minY = p.y;
      if (p.y > b.maxY) b.maxY = p.y;
    }
  }

  // Sort groups by CRDT order
  const groupsWithStrokes = new Map();
  for (const [itemKey, g] of liveGroups) {
    if (groupKeys.has(g.nodeRefKey)) {
      groupsWithStrokes.set(itemKey, g);
    }
  }

  const sortedItemKeys = crdtSort(groupsWithStrokes);

  // Assign cumulative Y offset by stacking groups top-to-bottom
  const groupOffset = {};
  let yPos = 0;
  for (const itemKey of sortedItemKeys) {
    const g = liveGroups.get(itemKey);
    if (!g) continue;
    const b = bounds[g.nodeRefKey];
    if (!b) continue;
    // Offset = current stack position minus the group's local top
    groupOffset[g.nodeRefKey] = yPos - b.minY;
    yPos += (b.maxY - b.minY);
  }

  // Apply offsets to all stroke points
  for (const ln of lines) {
    const off = groupOffset[ln.groupKey];
    if (off != null && off !== 0) {
      for (const p of ln.points) {
        p.y += off;
      }
    }
  }
}

/**
 * Parse a scene-item block (types 0x03, 0x05, 0x08).
 *
 * All scene-item block types share the same CRDT envelope.  Only line items
 * (scene type 0x03) produce renderable data; the others still contribute
 * deletion tracking — an eraser or selection may emit a block of type 0x08
 * that deletes a previously-recorded line item.
 */
function parseSceneItemBlock(r, blockVersion, liveLines) {
  // ── CRDT envelope ──
  const parentId = r.taggedId(1);   // parent_id (layer this stroke belongs to)
  const parentKey = `${parentId.a}:${parentId.b}`;
  const itemId = r.taggedId(2);   // item_id
  const itemKey = `${itemId.a}:${itemId.b}`;
  r.taggedId(3);   // left_id
  r.taggedId(4);   // right_id
  const del = r.taggedInt(5); // deleted_length
  if (del > 0) {
    liveLines.delete(itemKey);
    return;
  }

  // ── Value sub-block ──
  if (!r.checkTag(6, TAG.LEN4)) return;
  const subLen = r.subblockLen(6);
  const subEnd = r.pos + subLen;

  const itemType = r.u8();
  if (itemType !== 0x03) { // 0x03 = Line item (only renderable type)
    r.pos = subEnd;
    return;
  }

  // ── Line data ──
  const tool           = r.taggedInt(1);
  const color          = r.taggedInt(2);
  const thicknessScale = r.taggedDouble(3);
  const startingLength = r.taggedFloat(4);

  // Points sub-block
  const pointsLen = r.subblockLen(5);
  const v2 = blockVersion >= 2;
  const ptSize = v2 ? 14 : 24;
  const count = Math.floor(pointsLen / ptSize);

  const points = new Array(count);
  for (let i = 0; i < count; i++) {
    const x = r.f32();
    const y = r.f32();
    let width, pressure;
    if (v2) {
      /* speed */ r.u16();
      width    = r.u16();
      /* dir */  r.u8();
      pressure = r.u8();
    } else {
      /* speed */ r.f32();
      /* dir */   r.f32();
      width    = Math.round(r.f32() * 4);
      pressure = Math.round(r.f32() * 255);
    }
    points[i] = { x, y, width, pressure };
  }

  // Skip any remaining bytes (timestamp, move_id, etc.)
  r.pos = subEnd;

  liveLines.delete(itemKey);
  liveLines.set(itemKey, {
    line: { tool, color, thicknessScale, points },
    parentKey,
  });
}

// ── Rendering helpers ───────────────────────────────

/** Returns CSS colour string for a pen-colour ID. */
function colorForId(id) {
  return COLORS[id] || '#000000';
}

/** Returns opacity for a given tool. */
function opacityForTool(tool) {
  switch (tool) {
    case PEN.HIGHLIGHTER_1:
    case PEN.HIGHLIGHTER_2:
      return 0.15;
    case PEN.SHADER:
      return 0.15;
    case PEN.MARKER_1:
    case PEN.MARKER_2:
      return 0.7;
    case PEN.PENCIL_1:
    case PEN.PENCIL_2:
      return 0.6;
    default:
      return 1.0;
  }
}

/**
 * Compute the actual stroke width in device-pixels for a given point.
 *
 * The `width` field in v2 is pre-multiplied by ~4 relative to device units.
 * thicknessScale comes from the user's line-weight selection (typically 1.0–2.0).
 */
function strokeWidth(point, thicknessScale, tool) {
  let base = (point.width / 4.0) * thicknessScale;

  switch (tool) {
    case PEN.FINELINER_1:
    case PEN.FINELINER_2:
      return Math.max(base * 0.8, 0.8);
    case PEN.HIGHLIGHTER_1:
    case PEN.HIGHLIGHTER_2:
      return Math.max(base * 3.0, 8);
    case PEN.BALLPOINT_1:
    case PEN.BALLPOINT_2:
      return Math.max(base * 0.7, 0.6);
    case PEN.MECH_PENCIL_1:
    case PEN.MECH_PENCIL_2:
      return Math.max(base * 0.5, 0.5);
    case PEN.CALLIGRAPHY:
      return Math.max(base * 1.0, 1.0);
    case PEN.MARKER_1:
    case PEN.MARKER_2:
      return Math.max(base * 1.5, 2.0);
    case PEN.SHADER:
      return Math.max(base * 2.5, 4.0);
    default:
      return Math.max(base, 0.5);
  }
}

module.exports = { parseRmFile, colorForId, opacityForTool, strokeWidth, PEN };
