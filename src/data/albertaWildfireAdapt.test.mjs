// src/data/albertaWildfireAdapt.test.mjs
// Pure converter tests for the Alberta Wildfire agency-record adapter.
// No viewer/DOM needed; every export is imported directly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FIRE_STATUS_ORDER,
  UNKNOWN_STATUS_COLOR,
  classifyPolygonRings,
  fireJoinKey,
  fireStatusColor,
  fireStatusRank,
  mapAnalystRecord,
  normalizePerimeterSnapshot,
  normalizeWildfireSnapshot,
  parseAlbertaWildfireDate,
} from './albertaWildfireAdapt.js';

/** One live-shaped active-fire feature (fields copied from GWF-058-2026). */
const FIRE_FEATURE = {
  type: 'Feature',
  id: 83016318,
  geometry: { type: 'Point', coordinates: [-119.951083, 54.998183] },
  properties: {
    LABEL: 'GWF-058-2026',
    FIRE_NUMBER: 'GWF058',
    LATITUDE: 54.998183,
    LONGITUDE: -119.951083,
    FIRE_YEAR: 2026,
    FIRE_TYPE: 'Wildfire',
    FIRE_STATUS: 'Under Control',
    FIRE_STATUS_DATE: '2026/09/01 17:36:00',
    AREA_ESTIMATE: 25,
    SIZE_CLASS: 'C',
    GENERAL_CAUSE: 'Lightning',
    RESPONSE_TYPE: 'Full response',
    RESP_AREA: 'Grande Prairie Forest Area',
    FIRE_COMPLEX_NAME: null,
  },
};

const collection = (features) => ({ type: 'FeatureCollection', features });
const square = (x, y, size) => [
  [x, y], [x, y + size], [x + size, y + size], [x + size, y], [x, y],
];

// ── status ramp ────────────────────────────────────────────────────────────

test('fire status rank orders by severity and sorts unknown last', () => {
  assert.equal(fireStatusRank('Out of Control'), 0);
  assert.ok(fireStatusRank('Being Held') < fireStatusRank('Under Control'));
  assert.equal(fireStatusRank('Turned Over'), FIRE_STATUS_ORDER.length - 1);
  for (const unknown of ['Extinguished', '', null, undefined, 'nonsense']) {
    assert.equal(fireStatusRank(unknown), FIRE_STATUS_ORDER.length);
  }
});

test('fire status color falls back to neutral for unassessed records', () => {
  assert.notEqual(fireStatusColor('Out of Control'), UNKNOWN_STATUS_COLOR);
  assert.match(fireStatusColor('Being Held'), /^#[0-9a-f]{6}$/);
  assert.equal(fireStatusColor('Extinguished'), UNKNOWN_STATUS_COLOR);
  assert.equal(fireStatusColor(null), UNKNOWN_STATUS_COLOR);
});

// ── timestamps ─────────────────────────────────────────────────────────────

test('status date parses as Mountain Time, not UTC', () => {
  // 17:36 MDT (UTC-6) is 23:36Z the same day. Reading it as UTC would be a
  // six-hour error on every displayed fire time.
  const parsed = parseAlbertaWildfireDate('2026/09/01 17:36:00');
  assert.equal(new Date(parsed).toISOString(), '2026-09-01T23:36:00.000Z');
});

test('status date honours the MST/MDT transition', () => {
  // January is MST (UTC-7); July is MDT (UTC-6). A fixed offset gets one wrong.
  assert.equal(new Date(parseAlbertaWildfireDate('2026/01/15 12:00:00')).toISOString(),
    '2026-01-15T19:00:00.000Z');
  assert.equal(new Date(parseAlbertaWildfireDate('2026/07/15 12:00:00')).toISOString(),
    '2026-07-15T18:00:00.000Z');
});

test('status date rejects absent, malformed, and calendar-invalid input', () => {
  for (const bad of [null, undefined, '', 'not a date', '2026/09/01', '2026/02/31 10:00:00']) {
    assert.equal(parseAlbertaWildfireDate(bad), null);
  }
  assert.equal(typeof parseAlbertaWildfireDate('2026-09-01T17:36'), 'number');
});

// ── join key ───────────────────────────────────────────────────────────────

test('join key reduces every published spelling of a fire number to one token', () => {
  const expected = 'GWF058';
  for (const spelling of ['GWF-058-2026', 'GWF058', 'gwf 058 2026', 'GWF_058_2026']) {
    assert.equal(fireJoinKey(spelling), expected, spelling);
  }
});

test('join key strips only a plausible trailing year, and never yields empty', () => {
  assert.equal(fireJoinKey('PWF001'), 'PWF001');
  assert.equal(fireJoinKey('2026'), '2026'); // nothing precedes it — keep as-is
  assert.equal(fireJoinKey(''), null);
  assert.equal(fireJoinKey(null), null);
  assert.equal(fireJoinKey('---'), null);
});

// ── fire points ────────────────────────────────────────────────────────────

test('wildfire snapshot maps a live-shaped record onto the row contract', () => {
  const [row] = normalizeWildfireSnapshot(collection([FIRE_FEATURE]));
  assert.equal(row.stableId, 'GWF-058-2026');
  assert.equal(row.joinKey, 'GWF058');
  assert.equal(row.status, 'Under Control');
  assert.equal(row.areaHa, 25);
  assert.equal(row.cause, 'Lightning');
  assert.equal(row.lat, 54.998183);
  assert.equal(row.complexName, null); // null stays null, never "null"
});

test('wildfire snapshot falls back to attribute coordinates when geometry is stripped', () => {
  const [row] = normalizeWildfireSnapshot(collection([{ ...FIRE_FEATURE, geometry: null }]));
  assert.equal(row.lat, 54.998183);
  assert.equal(row.lon, -119.951083);
});

test('wildfire snapshot rejects a structurally broken feed atomically', () => {
  assert.equal(normalizeWildfireSnapshot(null), null);
  assert.equal(normalizeWildfireSnapshot({ features: 'nope' }), null);
  assert.equal(normalizeWildfireSnapshot(collection([{ properties: null }])), null);
  // Out-of-range coordinates are corruption, not an out-of-scope record.
  assert.equal(normalizeWildfireSnapshot(collection([{
    ...FIRE_FEATURE, geometry: { type: 'Point', coordinates: [-119.9, 200] },
  }])), null);
  // A non-point geometry means this is not the service we think it is.
  assert.equal(normalizeWildfireSnapshot(collection([{
    ...FIRE_FEATURE, geometry: { type: 'LineString', coordinates: [[0, 0], [1, 1]] },
  }])), null);
});

test('wildfire snapshot skips out-of-scope rows without discarding the feed', () => {
  const outside = {
    ...FIRE_FEATURE,
    properties: { ...FIRE_FEATURE.properties, LABEL: 'XWF-001-2026' },
    geometry: { type: 'Point', coordinates: [-79.38, 43.65] }, // Toronto
  };
  const rows = normalizeWildfireSnapshot(collection([FIRE_FEATURE, outside]));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].stableId, 'GWF-058-2026');
});

test('wildfire snapshot deduplicates repeated fire numbers', () => {
  const rows = normalizeWildfireSnapshot(collection([FIRE_FEATURE, { ...FIRE_FEATURE }]));
  assert.equal(rows.length, 1);
});

test('empty feed is a valid empty snapshot, not a rejection', () => {
  assert.deepEqual(normalizeWildfireSnapshot(collection([])), []);
});

// ── ring classification ────────────────────────────────────────────────────

test('disjoint rings in one Polygon become separate burn areas, not a hole', () => {
  // The real 2026-09-04 GWF-058-2026 shape: two same-winding disjoint rings.
  // Treating ring[1] as a hole erased an area ~34x the ring that was kept.
  const shapes = classifyPolygonRings([square(0, 0, 1), square(5, 5, 4)]);
  assert.equal(shapes.length, 2);
  assert.deepEqual(shapes.map((s) => s.holes.length), [0, 0]);
});

test('a genuine hole is still recognised as a hole', () => {
  const shapes = classifyPolygonRings([square(0, 0, 10), square(2, 2, 2)]);
  assert.equal(shapes.length, 1);
  assert.equal(shapes[0].holes.length, 1);
});

test('an island inside a hole is an exterior again', () => {
  const shapes = classifyPolygonRings([square(0, 0, 10), square(2, 2, 4), square(3, 3, 1)]);
  assert.equal(shapes.length, 2);
  assert.equal(shapes.reduce((n, s) => n + s.holes.length, 0), 1);
});

test('ring classification ignores winding order', () => {
  // Same donut, exterior reversed to clockwise. Containment must still decide.
  const reversed = [...square(0, 0, 10)].reverse();
  const shapes = classifyPolygonRings([reversed, square(2, 2, 2)]);
  assert.equal(shapes.length, 1);
  assert.equal(shapes[0].holes.length, 1);
});

// ── perimeters ─────────────────────────────────────────────────────────────

const perimeterFeature = (geometry) => ({
  type: 'Feature',
  geometry,
  properties: {
    FireNumber: 'GWF-058-2026',
    FireNumber_Short: 'GWF058',
    FIRE_STATUS: 'Under Control',
    FIRE_STATUS_DATE: '2026/09/01 17:36:00',
    SumAreaHa: 24.77,
    AREA_ESTIMATE: 25,
    SIZE_CLASS: 'C',
    GENERAL_CAUSE: 'Lightning',
    DataSource: 'GPS',
    GISFeatureLastUpdated_MT: '2026-09-04 09:41:41',
  },
});

test('perimeter snapshot accepts both Polygon and MultiPolygon for the same fire', () => {
  // The service has returned this same perimeter under both types.
  const asPolygon = normalizePerimeterSnapshot(collection([
    perimeterFeature({ type: 'Polygon', coordinates: [square(0, 0, 1)] }),
  ]));
  const asMulti = normalizePerimeterSnapshot(collection([
    perimeterFeature({ type: 'MultiPolygon', coordinates: [[square(0, 0, 1)]] }),
  ]));
  assert.equal(asPolygon.length, 1);
  assert.equal(asMulti.length, 1);
  assert.deepEqual(asPolygon[0].shapes, asMulti[0].shapes);
});

test('perimeter prefers the measured area over the assessed estimate', () => {
  const [row] = normalizePerimeterSnapshot(collection([
    perimeterFeature({ type: 'Polygon', coordinates: [square(0, 0, 1)] }),
  ]));
  assert.equal(row.areaHa, 24.77);
  assert.equal(row.joinKey, 'GWF058'); // joins to the point record
  assert.equal(row.capturedText, '2026-09-04 09:41:41');
});

test('perimeter snapshot rejects degenerate and malformed geometry', () => {
  assert.equal(normalizePerimeterSnapshot(null), null);
  // A ring of three positions cannot close.
  assert.equal(normalizePerimeterSnapshot(collection([
    perimeterFeature({ type: 'Polygon', coordinates: [[[0, 0], [0, 1], [0, 0]]] }),
  ])), null);
  assert.equal(normalizePerimeterSnapshot(collection([
    perimeterFeature({ type: 'Point', coordinates: [0, 0] }),
  ])), null);
  assert.equal(normalizePerimeterSnapshot(collection([
    perimeterFeature({ type: 'Polygon', coordinates: [[[0, 0], [0, 1], [1, 'x'], [0, 0]]] }),
  ])), null);
});

// ── analyst seam ───────────────────────────────────────────────────────────

test('analyst record is JSON-safe with nulls for everything missing', () => {
  const [row] = normalizeWildfireSnapshot(collection([FIRE_FEATURE]));
  const record = mapAnalystRecord({ ...row, hasPerimeter: true }, 0);
  assert.deepEqual(JSON.parse(JSON.stringify(record)), record);
  assert.equal(record.hasPerimeter, true);
  const empty = mapAnalystRecord(undefined, 7);
  assert.equal(empty.id, 'AB-FIRE-0007');
  assert.equal(empty.hasPerimeter, false);
  for (const [key, value] of Object.entries(empty)) {
    assert.notEqual(value, undefined, `${key} must not be undefined`);
    if (typeof value === 'number') assert.ok(Number.isFinite(value), `${key} must not be NaN`);
  }
});
