import * as Cesium from 'cesium';
import {
  clearOverlaySource,
  setOverlayEntries,
  setOverlaySourceVisible,
} from '../overlays/worldOverlay.js';
import {
  aqhiColor,
  aqhiDisplayValue,
  aqhiLabel,
  aqhiRiskText,
} from './aqhiScale.js';

/**
 * Air Quality Health Index — Alberta stations, live.
 *
 * Keyless. Environment and Climate Change Canada publishes AQHI through the MSC
 * GeoMet OGC API (`api.weather.gc.ca`), so this layer fetches it directly the
 * way the USGS earthquake layer fetches its feed. No credential, no proxy.
 *
 * Why it belongs beside the wildfire layer: AQHI is the downwind consequence of
 * a fire. A perimeter tells you where something is burning; AQHI tells you where
 * the smoke went, which is frequently hundreds of kilometres away and over the
 * places people actually live.
 *
 * KEEPING IT TO ALBERTA. A bounding box will not do it. Alberta's southwestern
 * border is the Continental Divide, not a meridian, so the box that contains
 * Alberta also contains Cranbrook, Sparwood, Castlegar and three Okanagan
 * stations in British Columbia. The stations collection carries ECCC's own
 * administrative zone, and BC sits in `pyr` while Alberta sits in `pnr`, so
 * bbox + `eccc_administrative-zone=pnr` resolves to exactly the 22 Alberta
 * stations with no boundary polygon and nothing bundled.
 *
 * The observations collection does NOT carry that zone field, so observations
 * are filtered against the station allowlist rather than trusted to be in
 * province. That join is also what supplies each reading its coordinates.
 *
 * CADENCE. AQHI is published hourly, so the layer polls every 20 minutes and
 * the station catalog — which changes a few times a year at most — is refetched
 * only every 12 hours.
 */

const COLLECTIONS_ROOT = 'https://api.weather.gc.ca/collections';
const STATIONS_URL = `${COLLECTIONS_ROOT}/aqhi-stations/items`;
const OBSERVATIONS_URL = `${COLLECTIONS_ROOT}/aqhi-observations-realtime/items`;

/** Alberta's extent. The east and north edges are the province's real borders. */
const ALBERTA_BBOX = '-120,49,-110,60';
/** ECCC administrative zone for the Prairies and North — Alberta's zone. */
const ALBERTA_ZONE = 'pnr';
/** Comfortably above the ~22 Alberta stations, without inviting a huge page. */
const STATION_LIMIT = 200;
const OBSERVATION_LIMIT = 300;
const FETCH_TIMEOUT_MS = 20_000;
/** Station geometry is near-static; refetch twice a day. */
const STATION_TTL_MS = 12 * 60 * 60 * 1000;
/** A reading this old is stale enough that showing it would misinform. */
export const OBSERVATION_MAX_AGE_MS = 6 * 60 * 60 * 1000;

export const AQHI_OVERLAY_SOURCE_ID = 'alberta-aqhi';
export const AQHI_OVERLAY_COHORT_LIMIT = 32;
export const AQHI_OVERLAY_COLLISION_CAPACITY = 24;
/** Marker radius in metres — AQHI is a station reading, not an extent. */
const STATION_MARKER_RADIUS_M = 6_000;

const DEFAULT_OVERLAY_HOST = Object.freeze({
  setEntries: setOverlayEntries,
  setVisible: setOverlaySourceVisible,
  clearSource: clearOverlaySource,
});

/**
 * Validate a station FeatureCollection into an id → station map.
 *
 * Atomic: a structurally broken response returns null so the caller keeps its
 * last good catalog. A station missing coordinates is skipped, since one
 * unusable station is not evidence the catalog is broken.
 *
 * @param {object} geojson - GeoJSON FeatureCollection from aqhi-stations.
 * @returns {Map<string, object>|null} Stations by location_id, or null.
 */
export function normalizeAqhiStations(geojson) {
  if (!Array.isArray(geojson?.features)) return null;
  const stations = new Map();
  for (const feature of geojson.features) {
    const properties = feature?.properties;
    if (!properties || typeof properties !== 'object' || Array.isArray(properties)) return null;
    const coordinates = feature?.geometry?.coordinates;
    if (!Array.isArray(coordinates) || coordinates.length < 2) continue;
    const [lon, lat] = coordinates.map(Number);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
    const id = String(properties.location_id ?? feature.id ?? '').trim();
    if (!id) continue;
    stations.set(id, {
      id,
      name: String(properties.location_name_en || id).trim(),
      zone: String(properties['eccc_administrative-zone'] || '').trim(),
      lat,
      lon,
    });
  }
  return stations;
}

/**
 * Join latest observations onto known stations, newest reading per station.
 *
 * Observations arriving for stations outside the allowlist are dropped — that
 * is what keeps British Columbia out of an Alberta layer. Readings older than
 * OBSERVATION_MAX_AGE_MS are dropped too: a six-hour-old air-quality number
 * presented as current is worse than no number.
 *
 * @param {object} geojson - GeoJSON FeatureCollection from the observations collection.
 * @param {Map<string, object>} stations - Allowlisted stations by location_id.
 * @param {number} [now=Date.now()] - Clock seam for tests.
 * @returns {Array<object>|null} Normalized readings, or null when malformed.
 */
export function normalizeAqhiObservations(geojson, stations, now = Date.now()) {
  if (!Array.isArray(geojson?.features)) return null;
  if (!(stations instanceof Map)) return null;
  const newest = new Map();
  for (const feature of geojson.features) {
    const properties = feature?.properties;
    if (!properties || typeof properties !== 'object' || Array.isArray(properties)) return null;
    const stationId = String(properties.location_id ?? '').trim();
    const station = stations.get(stationId);
    if (!station) continue; // Out of province, or a station we have no geometry for.

    const value = aqhiDisplayValue(properties.aqhi);
    if (value === null) continue;
    const observedMs = Date.parse(properties.observation_datetime);
    if (!Number.isFinite(observedMs)) continue;
    if (now - observedMs > OBSERVATION_MAX_AGE_MS) continue;

    const previous = newest.get(stationId);
    if (previous && previous.observedMs >= observedMs) continue;
    newest.set(stationId, {
      stationId,
      name: station.name,
      lat: station.lat,
      lon: station.lon,
      aqhi: value,
      rawAqhi: Number(properties.aqhi),
      observedMs,
      color: aqhiColor(properties.aqhi),
      label: aqhiLabel(properties.aqhi),
      risk: aqhiRiskText(properties.aqhi),
      note: String(properties.special_notes_en || '').trim() || null,
    });
  }
  return [...newest.values()].sort((a, b) => b.aqhi - a.aqhi
    || a.stationId.localeCompare(b.stationId));
}

/**
 * Build the source-owned presentation for one AQHI station label.
 * @param {object} input
 * @param {string} input.id
 * @param {Cesium.Cartesian3} input.position
 * @param {string} input.title
 * @param {string} input.accent
 * @param {number} input.aqhi
 * @returns {object}
 */
export function createAqhiOverlayEntry({ id, position, title, accent, aqhi }) {
  return {
    id: String(id),
    position,
    variant: 'label',
    title,
    accent,
    // Worse air wins the label budget — the reading people need to see first.
    priority: Math.round(Number(aqhi) || 0) * 1000,
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

/** Keep the worst readings, with stable identity as the tie-break. */
export function selectAqhiOverlayCohort(entries, limit = AQHI_OVERLAY_COHORT_LIMIT) {
  const cap = Math.max(0, Math.min(AQHI_OVERLAY_COHORT_LIMIT, Math.floor(Number(limit) || 0)));
  if (!Array.isArray(entries) || cap === 0) return [];
  return entries.slice().sort((a, b) => (
    b.priority - a.priority || String(a.id).localeCompare(String(b.id))
  )).slice(0, cap);
}

export function createAlbertaAqhiLayer({
  overlayHost = DEFAULT_OVERLAY_HOST,
  fetchImpl = null,
  now = () => Date.now(),
} = {}) {
  let _dataSource = null;
  let _stations = new Map();
  let _stationsFetchedAt = 0;
  let _readings = [];
  let _count = 0;
  let _lastUpdate = null;
  let _lastError = null;
  let _enabled = false;

  const doFetch = (...args) => (fetchImpl || globalThis.fetch)(...args);

  async function fetchJson(url) {
    const response = await doFetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }

  const layer = {
    id: 'alberta-aqhi',
    name: 'Air Quality (AQHI)',
    icon: '◍',
    source: 'ECCC MSC GeoMet',
    updateInterval: 1_200_000,

    init(viewer) {
      _dataSource = new Cesium.CustomDataSource('alberta-aqhi');
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
      _stations = new Map();
      _stationsFetchedAt = 0;
      _readings = [];
      _count = 0;
      _lastUpdate = null;
      _lastError = null;
      _enabled = false;
      overlayHost.setVisible(AQHI_OVERLAY_SOURCE_ID, false);
      console.log('[Data:AlbertaAQHI] Initialized');
    },

    enable() {
      _enabled = true;
      if (_dataSource) _dataSource.show = true;
      overlayHost.setVisible(AQHI_OVERLAY_SOURCE_ID, true);
    },

    disable() {
      _enabled = false;
      if (_dataSource) _dataSource.show = false;
      overlayHost.clearSource(AQHI_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(AQHI_OVERLAY_SOURCE_ID, false);
    },

    async update() {
      try {
        const clock = now();
        // Station geometry is near-static; refetch only twice a day.
        if (_stations.size === 0 || clock - _stationsFetchedAt > STATION_TTL_MS) {
          const url = `${STATIONS_URL}?f=json&bbox=${ALBERTA_BBOX}`
            + `&eccc_administrative-zone=${ALBERTA_ZONE}&limit=${STATION_LIMIT}`;
          const stations = normalizeAqhiStations(await fetchJson(url));
          if (!stations) {
            _lastError = 'Malformed AQHI station response';
            return false;
          }
          // An empty catalog must not wipe a good one — serve the last good list.
          if (stations.size > 0) {
            _stations = stations;
            _stationsFetchedAt = clock;
          }
        }
        if (_stations.size === 0) {
          _lastError = 'No Alberta AQHI stations available';
          return false;
        }

        const observationsUrl = `${OBSERVATIONS_URL}?f=json&bbox=${ALBERTA_BBOX}`
          + `&latest=true&limit=${OBSERVATION_LIMIT}`;
        const readings = normalizeAqhiObservations(
          await fetchJson(observationsUrl), _stations, clock,
        );
        if (!readings) {
          _lastError = 'Malformed AQHI observation response';
          return false;
        }

        _readings = readings;
        this._render();
        _count = _readings.length;
        _lastUpdate = Date.now();
        _lastError = null;
        console.log(`[Data:AlbertaAQHI] Updated: ${_count} Alberta stations reporting`);
        return true;
      } catch (error) {
        console.warn('[Data:AlbertaAQHI] Fetch error:', error?.message || error);
        _lastError = 'AQHI network error';
        return false;
      }
    },

    /** Rebuild entities and overlay labels from the current readings. */
    _render() {
      if (!_dataSource) return;
      _dataSource.entities.removeAll();
      const overlayEntries = [];
      for (const reading of _readings) {
        const position = Cesium.Cartesian3.fromDegrees(reading.lon, reading.lat);
        const color = Cesium.Color.fromCssColorString(reading.color);
        _dataSource.entities.add(new Cesium.Entity({
          id: `alberta-aqhi:${reading.stationId}`,
          position,
          ellipse: {
            // Static axes, as in the earthquake layer: a per-frame axis
            // re-tessellates the clamped ground primitive every frame.
            semiMajorAxis: STATION_MARKER_RADIUS_M,
            semiMinorAxis: STATION_MARKER_RADIUS_M,
            material: new Cesium.ColorMaterialProperty(color.withAlpha(0.35)),
            outline: true,
            outlineColor: color.withAlpha(0.9),
            outlineWidth: 2,
            heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          },
          properties: {
            stationId: reading.stationId,
            name: reading.name,
            aqhi: reading.aqhi,
            risk: reading.risk,
            observedMs: reading.observedMs,
            note: reading.note,
            lat: reading.lat,
            lon: reading.lon,
          },
        }));
        overlayEntries.push(createAqhiOverlayEntry({
          id: reading.stationId,
          position,
          title: `${reading.name} ${reading.label}`,
          accent: reading.color,
          aqhi: reading.aqhi,
        }));
      }
      if (_enabled) {
        overlayHost.setEntries(AQHI_OVERLAY_SOURCE_ID, selectAqhiOverlayCohort(overlayEntries), {
          cohortLimit: AQHI_OVERLAY_COHORT_LIMIT,
          collisionCapacity: AQHI_OVERLAY_COLLISION_CAPACITY,
          moving: false,
        });
      }
    },

    destroy(viewer) {
      _enabled = false;
      overlayHost.clearSource(AQHI_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(AQHI_OVERLAY_SOURCE_ID, false);
      if (_dataSource) {
        viewer.dataSources.remove(_dataSource, true);
        _dataSource = null;
      }
      _stations = new Map();
      _readings = [];
      _count = 0;
      _lastUpdate = null;
      _lastError = null;
    },

    /**
     * The current reading nearest a point — what "the air quality here" means.
     * @param {number} lat
     * @param {number} lon
     * @returns {object|null} Reading with distanceKm, or null when none loaded.
     */
    nearestReading(lat, lon) {
      if (!Number.isFinite(lat) || !Number.isFinite(lon) || _readings.length === 0) return null;
      let best = null;
      let bestDistance = Infinity;
      for (const reading of _readings) {
        const dLat = (reading.lat - lat) * 111.32;
        const dLon = (reading.lon - lon) * 111.32 * Math.cos((lat * Math.PI) / 180);
        const distance = Math.hypot(dLat, dLon);
        if (distance < bestDistance) {
          bestDistance = distance;
          best = reading;
        }
      }
      return best ? { ...best, distanceKm: bestDistance } : null;
    },

    /**
     * Snapshot readings as JSON-safe records for the analyst query engine.
     * @param {number} [maxCount=200]
     * @returns {Array<object>}
     */
    getAnalystRecords(maxCount = 200) {
      if (!_enabled || _readings.length === 0) return [];
      const limit = Number.isFinite(maxCount) ? Math.max(1, Math.floor(maxCount)) : 200;
      return _readings.slice(0, limit).map((reading) => ({
        id: reading.stationId,
        name: reading.name,
        aqhi: reading.aqhi,
        risk: reading.risk,
        lat: reading.lat,
        lon: reading.lon,
        observedMs: reading.observedMs,
      }));
    },

    getStats() {
      return {
        count: _count,
        lastUpdate: _lastUpdate,
        error: _lastError,
        stations: _stations.size,
      };
    },
  };
  return layer;
}

const albertaAqhiLayer = createAlbertaAqhiLayer();

export default albertaAqhiLayer;
