/**
 * @module albertaWildfireAdapt
 *
 * Pure converters for Alberta Wildfire agency fire records.
 *
 * Source: the Alberta Wildfire Management Branch ArcGIS Online org
 * (`services.arcgis.com/Eb8P5h4CJk8utIBz`) — the services behind the official
 * Alberta Wildfire Status Map. Public, keyless, `Query`-only, and it answers
 * `f=geojson` directly, so no Esri-JSON geometry translation is needed.
 *
 * This layer is deliberately NOT a second FIRMS. FIRMS is a satellite hotspot
 * detector: it sees thermal anomalies, including ones nobody has assessed.
 * These are *agency records* — a fire number, an assessed status, a cause, and
 * a response type, produced by the people fighting the fire. The two disagree
 * often and usefully (a hotspot with no fire record, a contained fire still
 * radiating heat), so both are kept.
 *
 * Two upstream quirks are handled here rather than at the call site:
 *
 * 1. TIMESTAMPS. Records carry both epoch-ms fields and Mountain-Time strings,
 *    and they DISAGREE. On the 2026-09-04 perimeter for GWF-058-2026,
 *    `GISFeatureLastUpdated` decodes to 21:41:41 UTC while the record's own
 *    `GISFeatureLastUpdated_MT` reads 09:41:41 — 15:41:41 UTC as MDT, a 12-hour
 *    gap consistent with a 12/24-hour clock fault somewhere upstream. The epoch
 *    fields are therefore treated as UNTRUSTED for display. `FIRE_STATUS_DATE`
 *    ("YYYY/MM/DD HH:MM:SS", no zone marker) is parsed as America/Edmonton
 *    wall-clock, which is what Alberta Wildfire publishes against.
 *
 * 2. PERIMETER JOIN. Perimeters key on `FireNumber` ("GWF-058-2026") while
 *    points key on `LABEL` (same form) and `FIRE_NUMBER` (short, "GWF058").
 *    `fireJoinKey` normalizes all three onto one comparable token so a
 *    perimeter can be matched to its point without trusting either spelling.
 */

/** America/Edmonton — Alberta Wildfire publishes status times in Mountain Time. */
const MOUNTAIN_ZONE = 'America/Edmonton';

/**
 * Alberta's extent with a small slack margin, used as a coordinate sanity
 * check. Mirrors the bounding-box guard the CCTV Austin loader applies: a
 * record that lands outside the province is a source fault, not a fire.
 */
const ALBERTA_BOUNDS = Object.freeze({
  minLat: 48.9, maxLat: 60.1, minLon: -120.1, maxLon: -109.9,
});

/**
 * Assessed fire statuses, most severe first. Order drives both the display
 * ramp and the cohort priority, so an out-of-control fire outranks a contained
 * one when the label budget is tight.
 */
export const FIRE_STATUS_ORDER = Object.freeze([
  'Out of Control',
  'Being Held',
  'Under Control',
  'Turned Over',
]);

/** Status → accent color. Unknown/unassessed statuses stay neutral grey. */
const STATUS_COLORS = Object.freeze({
  'Out of Control': '#ff3b1f',
  'Being Held': '#ff9d2e',
  'Under Control': '#ffd43b',
  'Turned Over': '#9ba7b4',
});

/** Neutral accent for a record whose status is absent or unrecognized. */
export const UNKNOWN_STATUS_COLOR = '#9ba7b4';

/**
 * Severity rank for an assessed status: 0 is most severe, higher is calmer,
 * and an unknown status sorts last.
 * @param {string|null|undefined} status - Raw FIRE_STATUS value.
 * @returns {number} Index into FIRE_STATUS_ORDER, or its length when unknown.
 */
export function fireStatusRank(status) {
  const index = FIRE_STATUS_ORDER.indexOf(String(status ?? '').trim());
  return index === -1 ? FIRE_STATUS_ORDER.length : index;
}

/**
 * Accent color for an assessed status.
 * @param {string|null|undefined} status - Raw FIRE_STATUS value.
 * @returns {string} CSS hex color.
 */
export function fireStatusColor(status) {
  return STATUS_COLORS[String(status ?? '').trim()] || UNKNOWN_STATUS_COLOR;
}

/** Offset (ms) to add to a UTC instant to read it as wall-clock in `timeZone`. */
function zoneOffsetMs(utcMs, timeZone) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const parts = {};
  for (const part of formatter.formatToParts(new Date(utcMs))) {
    if (part.type !== 'literal') parts[part.type] = part.value;
  }
  const wallMs = Date.UTC(
    Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    Number(parts.hour) % 24, Number(parts.minute), Number(parts.second),
  );
  return wallMs - utcMs;
}

/**
 * Parse an Alberta Wildfire status date ("YYYY/MM/DD HH:MM:SS") as Mountain
 * Time and return epoch ms.
 *
 * The field carries no zone marker. Reading it as UTC would shift every
 * displayed fire time by 6–7 hours, so it is resolved against
 * America/Edmonton, including its DST transitions. The offset is applied
 * twice: the first pass uses the naive instant to pick an offset, the second
 * re-resolves using the corrected instant so a timestamp inside a DST
 * changeover lands on the right side of the jump.
 *
 * @param {string|null|undefined} text - Raw FIRE_STATUS_DATE value.
 * @returns {number|null} Epoch ms, or null when absent/unparseable.
 */
export function parseAlbertaWildfireDate(text) {
  const match = String(text ?? '').trim()
    .match(/^(\d{4})[/-](\d{2})[/-](\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) return null;
  const [, year, month, day, hour, minute, second] = match;
  const wallMs = Date.UTC(
    Number(year), Number(month) - 1, Number(day),
    Number(hour), Number(minute), Number(second || 0),
  );
  if (!Number.isFinite(wallMs)) return null;
  // Reject calendar-invalid input (e.g. 2026/02/31) that Date.UTC would roll over.
  const rolled = new Date(wallMs);
  if (rolled.getUTCFullYear() !== Number(year)
    || rolled.getUTCMonth() !== Number(month) - 1
    || rolled.getUTCDate() !== Number(day)) return null;
  let instant = wallMs - zoneOffsetMs(wallMs, MOUNTAIN_ZONE);
  instant = wallMs - zoneOffsetMs(instant, MOUNTAIN_ZONE);
  return instant;
}

/**
 * Normalize any of the three fire-number spellings onto one comparable token,
 * so a perimeter's `FireNumber` matches its point's `LABEL`/`FIRE_NUMBER`.
 *
 * The same fire is published three ways: "GWF-058-2026" (point `LABEL` and
 * perimeter `FireNumber`), "GWF058" (point `FIRE_NUMBER` and perimeter
 * `FireNumber_Short`), and occasionally with spacing. Dropping separators alone
 * is NOT enough — it leaves "GWF0582026" and "GWF058", which never match — so a
 * trailing four-digit year is stripped too, reducing every spelling to the
 * year-free core "GWF058".
 *
 * The year is only removed when a plausible one (1900-2100) trails at least two
 * other characters, so a short number that merely ends in digits survives
 * intact. A record with no usable number returns null rather than an empty key,
 * so unkeyed records never collide with each other.
 *
 * @param {string|null|undefined} value - FireNumber, LABEL, or FIRE_NUMBER.
 * @returns {string|null} Comparable join token, or null when unusable.
 */
export function fireJoinKey(value) {
  const token = String(value ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!token) return null;
  const withoutYear = token.replace(/(?<=.{2})(19|20|21)\d{2}$/, '');
  return withoutYear || token;
}

/**
 * Is a position inside a closed ring? Ray-casting, boundary cases unspecified.
 * @param {Array<number>} point - [lon, lat].
 * @param {Array<Array<number>>} ring - Closed ring of [lon, lat] positions.
 * @returns {boolean}
 */
function pointInRing(point, ring) {
  const [x, y] = point;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (((yi > y) !== (yj > y)) && (x < ((xj - xi) * (y - yi)) / (yj - yi) + xi)) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * Is ring `inner` contained by ring `outer`?
 *
 * Decided by majority vote over the first few vertices rather than a single
 * probe: one vertex can sit exactly on the other ring's boundary, where the
 * ray-cast result is arbitrary. Three samples make a shared-edge coincidence
 * far less likely to flip the classification.
 */
function ringContains(outer, inner) {
  const samples = Math.min(3, inner.length);
  let hits = 0;
  for (let i = 0; i < samples; i += 1) {
    if (pointInRing(inner[i], outer)) hits += 1;
  }
  return hits * 2 > samples;
}

/**
 * Sort a polygon's rings into exterior rings and the holes belonging to each.
 *
 * GeoJSON says ring[0] is the exterior and the rest are holes, but this source
 * does not honour that. The 2026-09-04 perimeter for GWF-058-2026 arrived as a
 * two-ring Polygon whose rings are DISJOINT — same clockwise winding, neither
 * containing the other, the second ring ~34x the area of the first. They are
 * two separate burn areas. Reading ring[1] as a hole would have drawn a tiny
 * polygon with the real fire punched out of it.
 *
 * Winding order is no help either: RFC 7946 wants exteriors counter-clockwise,
 * and both of those rings are clockwise. So containment decides. Nesting depth
 * is counted per ring — an even depth is an exterior (including an island
 * inside a hole), an odd depth is a hole, and each hole attaches to the
 * smallest ring that encloses it.
 *
 * @param {Array<Array<Array<number>>>} rings - Rings of one GeoJSON polygon.
 * @returns {Array<{outer: Array<Array<number>>, holes: Array<Array<Array<number>>>}>}
 */
export function classifyPolygonRings(rings) {
  const depths = rings.map((ring, index) => {
    let depth = 0;
    for (let other = 0; other < rings.length; other += 1) {
      if (other !== index && ringContains(rings[other], ring)) depth += 1;
    }
    return depth;
  });
  const shapes = [];
  const shapeByRing = new Map();
  rings.forEach((ring, index) => {
    if (depths[index] % 2 === 0) {
      const shape = { outer: ring, holes: [] };
      shapeByRing.set(index, shape);
      shapes.push(shape);
    }
  });
  rings.forEach((ring, index) => {
    if (depths[index] % 2 === 0) return;
    // Attach to the innermost enclosing exterior: the deepest even-depth ring
    // that contains this one.
    let bestIndex = -1;
    for (const [candidate] of shapeByRing) {
      if (depths[candidate] >= depths[index]) continue;
      if (!ringContains(rings[candidate], ring)) continue;
      if (bestIndex === -1 || depths[candidate] > depths[bestIndex]) bestIndex = candidate;
    }
    if (bestIndex !== -1) shapeByRing.get(bestIndex).holes.push(ring);
    else shapes.push({ outer: ring, holes: [] });
  });
  return shapes;
}

/** Finite number, or null. Never NaN/undefined — analyst-record contract. */
function num(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Trimmed non-empty string, or null. */
function text(value) {
  const trimmed = String(value ?? '').trim();
  return trimmed || null;
}

/** Is this coordinate plausibly inside Alberta? */
function isAlbertaCoordinate(lat, lon) {
  return lat >= ALBERTA_BOUNDS.minLat && lat <= ALBERTA_BOUNDS.maxLat
    && lon >= ALBERTA_BOUNDS.minLon && lon <= ALBERTA_BOUNDS.maxLon;
}

/**
 * Validate and convert an active-fire point FeatureCollection.
 *
 * Atomic, matching `normalizeEarthquakeSnapshot`: a structurally broken feed
 * returns null so the caller keeps its last good snapshot rather than
 * rendering a half-parsed one. Individual records that are merely out of scope
 * (no coordinates, outside Alberta, duplicate id) are skipped, because one
 * bad row is not evidence the feed is broken.
 *
 * @param {object} geojson - GeoJSON FeatureCollection from the fire service.
 * @returns {Array<object>|null} Normalized rows, or null when malformed.
 */
export function normalizeWildfireSnapshot(geojson) {
  if (!Array.isArray(geojson?.features)) return null;
  const rows = [];
  const seen = new Set();
  for (const [index, feature] of geojson.features.entries()) {
    const properties = feature?.properties;
    if (!properties || typeof properties !== 'object' || Array.isArray(properties)) return null;
    const geometry = feature?.geometry;
    if (geometry && geometry.type != null && geometry.type !== 'Point') return null;
    const coordinates = geometry?.coordinates;
    // LATITUDE/LONGITUDE are carried on the record too; prefer the geometry and
    // fall back to the attributes so a geometry-stripped response still plots.
    const lon = num(Array.isArray(coordinates) ? coordinates[0] : properties.LONGITUDE);
    const lat = num(Array.isArray(coordinates) ? coordinates[1] : properties.LATITUDE);
    if (lon === null || lat === null) continue;
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
    if (!isAlbertaCoordinate(lat, lon)) continue;

    const label = text(properties.LABEL);
    const fireNumber = text(properties.FIRE_NUMBER);
    const stableId = label || fireNumber
      || (feature.id != null && feature.id !== '' ? String(feature.id) : `fire-${index + 1}`);
    if (seen.has(stableId)) continue;
    seen.add(stableId);

    const status = text(properties.FIRE_STATUS);
    rows.push({
      stableId,
      joinKey: fireJoinKey(label || fireNumber),
      label,
      fireNumber,
      lat,
      lon,
      status,
      statusRank: fireStatusRank(status),
      statusColor: fireStatusColor(status),
      statusDateMs: parseAlbertaWildfireDate(properties.FIRE_STATUS_DATE),
      fireYear: num(properties.FIRE_YEAR),
      fireType: text(properties.FIRE_TYPE),
      areaHa: num(properties.AREA_ESTIMATE),
      sizeClass: text(properties.SIZE_CLASS),
      cause: text(properties.GENERAL_CAUSE),
      responseType: text(properties.RESPONSE_TYPE),
      respArea: text(properties.RESP_AREA),
      complexName: text(properties.FIRE_COMPLEX_NAME),
    });
  }
  return rows;
}

/**
 * Validate and convert an active-perimeter FeatureCollection into closed rings.
 *
 * Polygon and MultiPolygon both reduce to a list of exterior rings with their
 * holes, classified by containment rather than by position or winding (see
 * classifyPolygonRings — this source violates both GeoJSON conventions). A ring
 * with fewer than four positions cannot close, so the whole feed is rejected
 * rather than drawing a degenerate polygon on the globe.
 *
 * @param {object} geojson - GeoJSON FeatureCollection from the perimeter service.
 * @returns {Array<object>|null} Normalized perimeter rows, or null when malformed.
 */
export function normalizePerimeterSnapshot(geojson) {
  if (!Array.isArray(geojson?.features)) return null;
  const rows = [];
  for (const [index, feature] of geojson.features.entries()) {
    const properties = feature?.properties;
    if (!properties || typeof properties !== 'object' || Array.isArray(properties)) return null;
    const geometry = feature?.geometry;
    if (!geometry) continue;
    if (geometry.type !== 'Polygon' && geometry.type !== 'MultiPolygon') return null;
    const polygons = geometry.type === 'Polygon'
      ? [geometry.coordinates]
      : geometry.coordinates;
    if (!Array.isArray(polygons)) return null;

    const shapes = [];
    for (const polygon of polygons) {
      if (!Array.isArray(polygon) || polygon.length === 0) return null;
      const rings = [];
      for (const ring of polygon) {
        if (!Array.isArray(ring) || ring.length < 4) return null;
        const positions = [];
        for (const position of ring) {
          const lon = num(Array.isArray(position) ? position[0] : null);
          const lat = num(Array.isArray(position) ? position[1] : null);
          if (lon === null || lat === null) return null;
          if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
          positions.push([lon, lat]);
        }
        rings.push(positions);
      }
      // NOT rings[0]-is-exterior: this source ships disjoint rings in a single
      // Polygon. See classifyPolygonRings.
      for (const shape of classifyPolygonRings(rings)) shapes.push(shape);
    }
    if (shapes.length === 0) continue;

    const fireNumber = text(properties.FireNumber) || text(properties.FireNumber_Short);
    const status = text(properties.FIRE_STATUS);
    rows.push({
      stableId: fireNumber || `perimeter-${index + 1}`,
      joinKey: fireJoinKey(fireNumber),
      fireNumber,
      shapes,
      status,
      statusRank: fireStatusRank(status),
      statusColor: fireStatusColor(status),
      statusDateMs: parseAlbertaWildfireDate(properties.FIRE_STATUS_DATE),
      // SumAreaHa is the measured perimeter area; AREA_ESTIMATE is the assessed
      // figure carried over from the point record. Prefer the measurement.
      areaHa: num(properties.SumAreaHa) ?? num(properties.AREA_ESTIMATE),
      sizeClass: text(properties.SIZE_CLASS),
      cause: text(properties.GENERAL_CAUSE),
      respArea: text(properties.RESP_AREA),
      dataSource: text(properties.DataSource),
      // _MT strings are preferred over the epoch fields; see the module header.
      capturedText: text(properties.GISFeatureLastUpdated_MT),
    });
  }
  return rows;
}

/**
 * Map one fire row to a JSON-safe analyst record (analyst query engine seam).
 * Pure — no Cesium types. Missing/unknown fields are null, never NaN.
 * @param {object|null|undefined} raw - A row from normalizeWildfireSnapshot.
 * @param {number} [index=0] - Position in the snapshot (fallback id only).
 * @returns {object} Analyst record.
 */
export function mapAnalystRecord(raw, index = 0) {
  return {
    id: text(raw?.stableId) || `AB-FIRE-${String(index).padStart(4, '0')}`,
    fireNumber: text(raw?.fireNumber),
    lat: num(raw?.lat),
    lon: num(raw?.lon),
    status: text(raw?.status),
    statusTimeMs: num(raw?.statusDateMs),
    areaHa: num(raw?.areaHa),
    sizeClass: text(raw?.sizeClass),
    cause: text(raw?.cause),
    responseType: text(raw?.responseType),
    respArea: text(raw?.respArea),
    hasPerimeter: raw?.hasPerimeter === true,
  };
}
