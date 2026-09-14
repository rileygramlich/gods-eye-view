import * as Cesium from 'cesium';
import {
  clearOverlaySource,
  setOverlayEntries,
  setOverlaySourceVisible,
} from '../overlays/worldOverlay.js';
import { fireAnchorHeight, warmFireAnchorFloors } from './fireAnchors.js';
import {
  fireJoinKey,
  mapAnalystRecord,
  normalizePerimeterSnapshot,
  normalizeWildfireSnapshot,
} from './albertaWildfireAdapt.js';

/**
 * Alberta Wildfire — official agency fire records and current-season perimeters.
 *
 * Keyless. The Alberta Wildfire Management Branch publishes the services behind
 * its public status map on ArcGIS Online, `Query`-only and without a token, so
 * this layer fetches them directly the way the USGS earthquake layer fetches
 * its feed. There is no credential to broker, and therefore no proxy.
 *
 * This is deliberately NOT a second FIRMS. FIRMS is satellite thermal detection
 * — it sees heat, including heat nobody has assessed yet. These are the records
 * of the agency fighting the fire: a fire number, an assessed status, a cause, a
 * response type, and a surveyed perimeter. The two legitimately disagree (a
 * hotspot with no fire record; a contained fire still radiating), so both stay
 * on, and this layer never claims to supersede the other.
 *
 * Cadence. Fire points refresh on the layer's 5-minute tick. Perimeters are
 * surveyed products that change far more slowly than status text, so they
 * refresh every third tick (~15 min) — PERIMETER_REFRESH_EVERY below. Alberta
 * publishes no documented rate limit for these services; the cadence is set by
 * how fast the data actually changes, not by how fast we are allowed to ask.
 *
 * Off season. Alberta's fire season runs March–October, and the active-fire
 * service legitimately returns zero rows for months. Zero active fires is a
 * real answer, not a failure: the layer reports `seasonState: 'quiet'` and,
 * when nothing is burning, falls back to the year-to-date service so the globe
 * still shows where this season's fires were. A fallback record is flagged
 * `historical: true` and is never described as an active fire.
 */

const SERVICES_ROOT = 'https://services.arcgis.com/Eb8P5h4CJk8utIBz/arcgis/rest/services';
const ACTIVE_FIRES_URL = `${SERVICES_ROOT}/${encodeURIComponent('Active_Wildfires_(PROD)')}/FeatureServer/0/query`;
const ACTIVE_PERIMETERS_URL = `${SERVICES_ROOT}/${encodeURIComponent('Wildfire_Perimeter_Active_(PROD)')}/FeatureServer/3/query`;
const YEAR_TO_DATE_URL = `${SERVICES_ROOT}/Wildfire_year_to_date/FeatureServer/0/query`;

const QUERY_PARAMS = 'where=1%3D1&outFields=*&outSR=4326&f=geojson';
/** Upstream is a shared public service; bound a stalled fetch rather than hang the tick. */
const FETCH_TIMEOUT_MS = 20_000;
/** Perimeters are surveyed geometry — refresh every third 5-minute tick. */
const PERIMETER_REFRESH_EVERY = 3;
/** Off-season fallback cap: enough to show the season's shape, not the whole database. */
const HISTORICAL_LIMIT = 200;

export const ALBERTA_WILDFIRE_OVERLAY_SOURCE_ID = 'alberta-wildfire';
export const ALBERTA_WILDFIRE_OVERLAY_COHORT_LIMIT = 48;
export const ALBERTA_WILDFIRE_OVERLAY_COLLISION_CAPACITY = 32;

const DEFAULT_OVERLAY_HOST = Object.freeze({
  setEntries: setOverlayEntries,
  setVisible: setOverlaySourceVisible,
  clearSource: clearOverlaySource,
});

/**
 * Marker radius for a fire, scaled by assessed area.
 *
 * Area estimates span five orders of magnitude (0.01 ha spot fires to
 * 100,000 ha complexes), so radius follows a cube root rather than the area
 * itself: a linear or square-root ramp makes a large fire swallow the province
 * while a small one disappears. Clamped at both ends so every fire stays
 * clickable and no fire becomes a continent.
 *
 * @param {number|null} areaHa - Assessed area in hectares.
 * @returns {number} Ellipse semi-axis in metres.
 */
export function fireMarkerRadiusM(areaHa) {
  const area = Number(areaHa);
  if (!Number.isFinite(area) || area <= 0) return 900;
  return Math.max(900, Math.min(26_000, Math.cbrt(area) * 1_400));
}

/**
 * Build the source-owned presentation for one fire label.
 * @param {object} input
 * @param {string} input.id - Stable fire id.
 * @param {Cesium.Cartesian3} input.position - Shared ground anchor.
 * @param {string} input.title - Label text.
 * @param {string} input.accent - Status-derived color.
 * @param {number} input.statusRank - 0 is most severe.
 * @param {number|null} input.areaHa - Assessed area, breaks ties within a status.
 * @returns {object}
 */
export function createWildfireOverlayEntry({ id, position, title, accent, statusRank, areaHa }) {
  return {
    id: String(id),
    position,
    variant: 'label',
    title,
    accent,
    // Severity dominates; area only orders fires sharing a status. Both are
    // folded into one integer so the shared cohort selector needs no custom
    // comparator.
    priority: (10 - Math.min(statusRank, 9)) * 100_000 + Math.round(Math.min(Number(areaHa) || 0, 99_999)),
    collisionGroup: 'ambient-label',
    paintLane: 'ambient-label',
    interactive: false,
    edgeFade: 'keyhole',
    horizonCull: true,
    terrainOcclusion: false,
    gapPx: 14,
    verticalOnly: true,
    placement: 'above',
  };
}

/** Keep the most severe fires, with stable identity as the tie-break. */
export function selectWildfireOverlayCohort(entries, limit = ALBERTA_WILDFIRE_OVERLAY_COHORT_LIMIT) {
  const cap = Math.max(0, Math.min(
    ALBERTA_WILDFIRE_OVERLAY_COHORT_LIMIT,
    Math.floor(Number(limit) || 0),
  ));
  if (!Array.isArray(entries) || cap === 0) return [];
  return entries.slice().sort((a, b) => (
    b.priority - a.priority || String(a.id).localeCompare(String(b.id))
  )).slice(0, cap);
}

/**
 * Compose the human-readable status line for a fire card.
 * @param {object} row - Normalized fire row.
 * @returns {string}
 */
export function wildfireSummaryText(row) {
  const parts = [];
  if (row?.status) parts.push(row.status);
  if (Number.isFinite(row?.areaHa)) {
    parts.push(row.areaHa >= 100 ? `${Math.round(row.areaHa).toLocaleString()} ha` : `${row.areaHa} ha`);
  }
  if (row?.cause) parts.push(row.cause);
  return parts.join(' · ');
}

export function createAlbertaWildfireLayer({
  overlayHost = DEFAULT_OVERLAY_HOST,
  fetchImpl = null,
} = {}) {
  let _fireSource = null;
  let _perimeterSource = null;
  let _rows = [];
  let _perimeters = [];
  let _count = 0;
  let _perimeterCount = 0;
  let _lastUpdate = null;
  let _lastError = null;
  let _enabled = false;
  let _tick = 0;
  let _seasonState = 'unknown';

  const doFetch = (...args) => (fetchImpl || globalThis.fetch)(...args);

  /** Fetch one service as GeoJSON. Throws on transport or HTTP failure. */
  async function fetchCollection(url) {
    const response = await doFetch(`${url}?${QUERY_PARAMS}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }

  const layer = {
    id: 'alberta-wildfire',
    name: 'Alberta Wildfire',
    icon: '🔥',
    source: 'Alberta Wildfire',
    updateInterval: 300_000,

    init(viewer) {
      _fireSource = new Cesium.CustomDataSource('alberta-wildfire');
      _perimeterSource = new Cesium.CustomDataSource('alberta-wildfire-perimeters');
      _fireSource.show = false;
      _perimeterSource.show = false;
      viewer.dataSources.add(_perimeterSource);
      viewer.dataSources.add(_fireSource);
      _rows = [];
      _perimeters = [];
      _count = 0;
      _perimeterCount = 0;
      _lastUpdate = null;
      _lastError = null;
      _enabled = false;
      _tick = 0;
      _seasonState = 'unknown';
      overlayHost.setVisible(ALBERTA_WILDFIRE_OVERLAY_SOURCE_ID, false);
      console.log('[Data:AlbertaWildfire] Initialized');
    },

    enable() {
      _enabled = true;
      if (_fireSource) _fireSource.show = true;
      if (_perimeterSource) _perimeterSource.show = true;
      overlayHost.setVisible(ALBERTA_WILDFIRE_OVERLAY_SOURCE_ID, true);
    },

    disable() {
      _enabled = false;
      if (_fireSource) _fireSource.show = false;
      if (_perimeterSource) _perimeterSource.show = false;
      overlayHost.clearSource(ALBERTA_WILDFIRE_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(ALBERTA_WILDFIRE_OVERLAY_SOURCE_ID, false);
    },

    async update() {
      try {
        const active = normalizeWildfireSnapshot(await fetchCollection(ACTIVE_FIRES_URL));
        if (!active) {
          _lastError = 'Malformed Alberta Wildfire response';
          return false;
        }

        let rows = active;
        let historical = false;
        // Zero active fires is a real off-season answer. Show where this
        // season's fires were rather than an empty province, and mark them.
        if (rows.length === 0) {
          const ytd = normalizeWildfireSnapshot(await fetchCollection(YEAR_TO_DATE_URL));
          if (ytd?.length) {
            rows = ytd
              .slice()
              .sort((a, b) => (b.statusDateMs ?? 0) - (a.statusDateMs ?? 0))
              .slice(0, HISTORICAL_LIMIT);
            historical = true;
          }
        }
        _seasonState = historical ? 'quiet' : 'active';

        // Perimeters change slowly; refresh them on a slower multiple of the tick.
        if (_tick % PERIMETER_REFRESH_EVERY === 0 || _perimeters.length === 0) {
          try {
            const perimeters = normalizePerimeterSnapshot(await fetchCollection(ACTIVE_PERIMETERS_URL));
            // A malformed perimeter feed must not discard good fire points —
            // keep the last good geometry and carry on.
            if (perimeters) _perimeters = perimeters;
          } catch (error) {
            console.warn('[Data:AlbertaWildfire] Perimeter fetch failed:', error?.message || error);
          }
        }
        _tick += 1;

        const perimeterKeys = new Set(_perimeters.map((p) => p.joinKey).filter(Boolean));
        _rows = rows.map((row) => ({
          ...row,
          historical,
          hasPerimeter: row.joinKey != null && perimeterKeys.has(row.joinKey),
        }));

        this._render(false);
        _count = _rows.length;
        _perimeterCount = _perimeters.length;
        _lastUpdate = Date.now();
        _lastError = null;
        console.log(
          `[Data:AlbertaWildfire] Updated: ${_count} ${historical ? 'season-to-date' : 'active'} fires, `
          + `${_perimeterCount} perimeters`,
        );
        return true;
      } catch (error) {
        console.warn('[Data:AlbertaWildfire] Fetch error:', error?.message || error);
        _lastError = 'Alberta Wildfire network error';
        return false;
      }
    },

    /**
     * Rebuild entities and overlay labels from the current snapshot.
     * @param {boolean} [skipWarm=false] - Set on the re-render that a ground-floor
     *   warm triggers, so warm -> render -> warm cannot recurse.
     */
    _render(skipWarm = false) {
      if (!_fireSource || !_perimeterSource) return;
      const overlayEntries = [];

      _perimeterSource.entities.removeAll();
      for (const perimeter of _perimeters) {
        perimeter.shapes.forEach((shape, index) => {
          const color = Cesium.Color.fromCssColorString(perimeter.statusColor);
          _perimeterSource.entities.add(new Cesium.Entity({
            id: `alberta-wildfire-perimeter:${perimeter.stableId}:${index}`,
            polygon: {
              hierarchy: new Cesium.PolygonHierarchy(
                Cesium.Cartesian3.fromDegreesArray(shape.outer.flat()),
                shape.holes.map((hole) => new Cesium.PolygonHierarchy(
                  Cesium.Cartesian3.fromDegreesArray(hole.flat()),
                )),
              ),
              material: new Cesium.ColorMaterialProperty(color.withAlpha(0.26)),
              outline: true,
              outlineColor: color.withAlpha(0.85),
              outlineWidth: 2,
              // Drape onto terrain — a perimeter is a ground footprint.
              heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
              classificationType: Cesium.ClassificationType.TERRAIN,
            },
            properties: {
              fireNumber: perimeter.fireNumber,
              status: perimeter.status,
              areaHa: perimeter.areaHa,
              dataSource: perimeter.dataSource,
            },
          }));
        });
      }

      _fireSource.entities.removeAll();
      for (const row of _rows) {
        const height = fireAnchorHeight(row.lat, row.lon);
        const position = Cesium.Cartesian3.fromDegrees(row.lon, row.lat, height);
        const color = Cesium.Color.fromCssColorString(row.statusColor);
        const radius = fireMarkerRadiusM(row.areaHa);
        // Historical rows are evidence of a past fire, not a burning one —
        // draw them dimmer so the two are never read as the same thing.
        const alpha = row.historical ? 0.18 : 0.42;
        _fireSource.entities.add(new Cesium.Entity({
          id: `alberta-wildfire:${row.stableId}`,
          position,
          ellipse: {
            // Static axes, like the earthquake discs: a per-frame axis would
            // re-tessellate every clamped ground primitive every frame.
            semiMajorAxis: radius,
            semiMinorAxis: radius,
            material: new Cesium.ColorMaterialProperty(color.withAlpha(alpha)),
            outline: true,
            outlineColor: color.withAlpha(row.historical ? 0.5 : 0.95),
            outlineWidth: row.historical ? 1 : 2,
            heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          },
          properties: {
            fireNumber: row.fireNumber,
            label: row.label,
            status: row.status,
            statusTimeMs: row.statusDateMs,
            areaHa: row.areaHa,
            sizeClass: row.sizeClass,
            cause: row.cause,
            responseType: row.responseType,
            respArea: row.respArea,
            hasPerimeter: row.hasPerimeter,
            historical: row.historical,
            summary: wildfireSummaryText(row),
            lat: row.lat,
            lon: row.lon,
          },
        }));
        overlayEntries.push(createWildfireOverlayEntry({
          id: row.stableId,
          position,
          title: row.label || row.fireNumber || 'Fire',
          accent: row.statusColor,
          statusRank: row.statusRank,
          areaHa: row.areaHa,
        }));
      }

      if (_enabled) {
        overlayHost.setEntries(
          ALBERTA_WILDFIRE_OVERLAY_SOURCE_ID,
          selectWildfireOverlayCohort(overlayEntries),
          {
            cohortLimit: ALBERTA_WILDFIRE_OVERLAY_COHORT_LIMIT,
            collisionCapacity: ALBERTA_WILDFIRE_OVERLAY_COLLISION_CAPACITY,
            moving: false,
          },
        );
      }
      // Warm the shared ground floor so fires anchor on real terrain instead of
      // the ellipsoid, then redraw once if anything actually warmed. Same
      // fire-and-forget chain FIRMS uses; `skipWarm` on the redraw is what
      // stops warm -> render -> warm from recursing.
      if (!skipWarm) {
        warmFireAnchorFloors(_rows.map(({ lat, lon }) => ({ lat, lon }))).then((warmed) => {
          if (warmed && _enabled) this._render(true);
        });
      }
    },

    destroy(viewer) {
      _enabled = false;
      overlayHost.clearSource(ALBERTA_WILDFIRE_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(ALBERTA_WILDFIRE_OVERLAY_SOURCE_ID, false);
      if (_fireSource) {
        viewer.dataSources.remove(_fireSource, true);
        _fireSource = null;
      }
      if (_perimeterSource) {
        viewer.dataSources.remove(_perimeterSource, true);
        _perimeterSource = null;
      }
      _rows = [];
      _perimeters = [];
      _count = 0;
      _perimeterCount = 0;
      _lastUpdate = null;
      _lastError = null;
    },

    /**
     * Snapshot the layer's fire records as plain JSON-safe objects for the
     * analyst query engine. On-demand only; returns [] while disabled.
     * @param {number} [maxCount=2000] - Maximum records to return.
     * @returns {Array<object>}
     */
    getAnalystRecords(maxCount = 2000) {
      if (!_enabled || _rows.length === 0) return [];
      const limit = Number.isFinite(maxCount) ? Math.max(1, Math.floor(maxCount)) : 2000;
      return _rows.slice(0, limit).map((row, index) => ({
        ...mapAnalystRecord(row, index),
        historical: row.historical === true,
      }));
    },

    /**
     * The fire nearest a point, for the camera handoff. Pure great-circle
     * distance over the current snapshot — no scene queries.
     * @param {number} lat
     * @param {number} lon
     * @returns {object|null} Nearest fire row, or null when none are loaded.
     */
    nearestFire(lat, lon) {
      if (!Number.isFinite(lat) || !Number.isFinite(lon) || _rows.length === 0) return null;
      let best = null;
      let bestDistance = Infinity;
      for (const row of _rows) {
        const dLat = (row.lat - lat) * 111.32;
        const dLon = (row.lon - lon) * 111.32 * Math.cos((lat * Math.PI) / 180);
        const distance = Math.hypot(dLat, dLon);
        if (distance < bestDistance) {
          bestDistance = distance;
          best = row;
        }
      }
      return best ? { ...best, distanceKm: bestDistance } : null;
    },

    getStats() {
      return {
        count: _count,
        lastUpdate: _lastUpdate,
        error: _lastError,
        perimeters: _perimeterCount,
        seasonState: _seasonState,
      };
    },
  };
  return layer;
}

const albertaWildfireLayer = createAlbertaWildfireLayer();

export default albertaWildfireLayer;
