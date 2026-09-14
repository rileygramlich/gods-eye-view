// src/data/albertaWildfire.test.mjs
// Layer-level tests for Alberta Wildfire: presentation math, the season
// fallback, and the failure contract. Network is stubbed; no viewer is needed
// beyond a data-source sink.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import {
  ALBERTA_WILDFIRE_OVERLAY_COHORT_LIMIT,
  createAlbertaWildfireLayer,
  createWildfireOverlayEntry,
  fireMarkerRadiusM,
  selectWildfireOverlayCohort,
  wildfireSummaryText,
} from './albertaWildfire.js';

const firePoint = (label, overrides = {}) => ({
  type: 'Feature',
  geometry: { type: 'Point', coordinates: [overrides.lon ?? -114.0, overrides.lat ?? 53.5] },
  properties: {
    LABEL: label,
    FIRE_NUMBER: label.replace(/-/g, '').slice(0, 6),
    FIRE_STATUS: overrides.status ?? 'Under Control',
    FIRE_STATUS_DATE: overrides.date ?? '2026/09/01 17:36:00',
    AREA_ESTIMATE: overrides.areaHa ?? 25,
    SIZE_CLASS: 'C',
    GENERAL_CAUSE: 'Lightning',
    RESPONSE_TYPE: 'Full response',
    RESP_AREA: 'Grande Prairie Forest Area',
  },
});

const square = (x, y, size) => [
  [x, y], [x, y + size], [x + size, y + size], [x + size, y], [x, y],
];

const perimeterOf = (fireNumber) => ({
  type: 'Feature',
  geometry: { type: 'Polygon', coordinates: [square(-114.01, 53.49, 0.02)] },
  properties: { FireNumber: fireNumber, FIRE_STATUS: 'Under Control', SumAreaHa: 24.77 },
});

const collection = (features) => ({ type: 'FeatureCollection', features });

/** Route stubbed responses by which service the URL names. */
function stubFetch(routes) {
  return async (url) => {
    const key = url.includes('Wildfire_year_to_date') ? 'ytd'
      : url.includes('Wildfire_Perimeter_Active') ? 'perimeters'
        : 'active';
    const handler = routes[key];
    if (handler === undefined) return { ok: false, status: 404, json: async () => ({}) };
    if (handler instanceof Error) throw handler;
    return { ok: true, status: 200, json: async () => handler };
  };
}

function harness(routes) {
  const overlayCalls = [];
  const overlayHost = {
    setEntries: (id, entries) => overlayCalls.push({ id, entries }),
    setVisible: () => {},
    clearSource: () => {},
  };
  const layer = createAlbertaWildfireLayer({ overlayHost, fetchImpl: stubFetch(routes) });
  const viewer = { dataSources: { add() {}, remove() {} } };
  layer.init(viewer);
  layer.enable(viewer);
  return { layer, viewer, overlayCalls };
}

// ── presentation math ──────────────────────────────────────────────────────

test('marker radius is clamped at both ends and rises with area', () => {
  assert.equal(fireMarkerRadiusM(0), 900);
  assert.equal(fireMarkerRadiusM(null), 900);
  assert.equal(fireMarkerRadiusM(1e9), 26_000);
  assert.ok(fireMarkerRadiusM(1000) > fireMarkerRadiusM(10));
  // Cube-root ramp: five orders of magnitude of area must not become five
  // orders of magnitude of radius.
  assert.ok(fireMarkerRadiusM(100_000) / fireMarkerRadiusM(1) < 40);
});

test('overlay priority puts severity above size', () => {
  const position = Cesium.Cartesian3.fromDegrees(-114, 53.5);
  const huge = createWildfireOverlayEntry({
    id: 'a', position, title: 'a', accent: '#fff', statusRank: 2, areaHa: 99_000,
  });
  const severe = createWildfireOverlayEntry({
    id: 'b', position, title: 'b', accent: '#fff', statusRank: 0, areaHa: 1,
  });
  // A small out-of-control fire outranks a huge contained one.
  assert.ok(severe.priority > huge.priority);
});

test('overlay cohort is capped and deterministic', () => {
  const position = Cesium.Cartesian3.fromDegrees(-114, 53.5);
  const entries = Array.from({ length: 120 }, (_, i) => createWildfireOverlayEntry({
    id: `fire-${i}`, position, title: `f${i}`, accent: '#fff', statusRank: 1, areaHa: i,
  }));
  const cohort = selectWildfireOverlayCohort(entries);
  assert.equal(cohort.length, ALBERTA_WILDFIRE_OVERLAY_COHORT_LIMIT);
  assert.deepEqual(cohort.map((e) => e.id), selectWildfireOverlayCohort(entries).map((e) => e.id));
  assert.deepEqual(selectWildfireOverlayCohort(entries, 0), []);
});

test('summary text omits fields the agency did not supply', () => {
  assert.equal(wildfireSummaryText({ status: 'Being Held', areaHa: 2.8, cause: 'Lightning' }),
    'Being Held · 2.8 ha · Lightning');
  assert.equal(wildfireSummaryText({ status: 'Out of Control' }), 'Out of Control');
  assert.equal(wildfireSummaryText({}), '');
  // Large areas get thousands separators and lose the misleading decimal.
  assert.match(wildfireSummaryText({ areaHa: 12345.6 }), /12,346 ha/);
});

// ── update lifecycle ───────────────────────────────────────────────────────

test('active fires render and join to their perimeter', async () => {
  const { layer } = harness({
    active: collection([firePoint('GWF-058-2026'), firePoint('LWF-090-2026')]),
    perimeters: collection([perimeterOf('GWF-058-2026')]),
  });
  assert.equal(await layer.update(), true);
  const stats = layer.getStats();
  assert.equal(stats.count, 2);
  assert.equal(stats.perimeters, 1);
  assert.equal(stats.seasonState, 'active');
  assert.equal(stats.error, null);

  const records = layer.getAnalystRecords();
  const joined = records.find((r) => r.fireNumber === 'GWF058');
  const unjoined = records.find((r) => r.id === 'LWF-090-2026');
  // The perimeter is published under the long number, the point under the
  // short one — the join must survive that.
  assert.equal(joined.hasPerimeter, true);
  assert.equal(unjoined.hasPerimeter, false);
  assert.equal(records.every((r) => r.historical === false), true);
});

test('an empty active feed falls back to year-to-date and marks it historical', async () => {
  const { layer } = harness({
    active: collection([]),
    perimeters: collection([]),
    ytd: collection([firePoint('GWF-001-2026'), firePoint('GWF-002-2026')]),
  });
  assert.equal(await layer.update(), true);
  assert.equal(layer.getStats().seasonState, 'quiet');
  const records = layer.getAnalystRecords();
  assert.equal(records.length, 2);
  // Off-season records are evidence of a past fire and must never be
  // presented as something currently burning.
  assert.equal(records.every((r) => r.historical === true), true);
});

test('zero fires everywhere is a clean empty answer, not an error', async () => {
  const { layer } = harness({
    active: collection([]), perimeters: collection([]), ytd: collection([]),
  });
  assert.equal(await layer.update(), true);
  assert.equal(layer.getStats().count, 0);
  assert.equal(layer.getStats().error, null);
});

test('a malformed fire feed is rejected without clearing the last good snapshot', async () => {
  const { layer } = harness({
    active: collection([firePoint('GWF-058-2026')]),
    perimeters: collection([]),
  });
  await layer.update();
  assert.equal(layer.getStats().count, 1);

  const broken = createAlbertaWildfireLayer({
    overlayHost: { setEntries() {}, setVisible() {}, clearSource() {} },
    fetchImpl: stubFetch({ active: { features: 'not an array' } }),
  });
  broken.init({ dataSources: { add() {}, remove() {} } });
  broken.enable();
  assert.equal(await broken.update(), false);
  assert.match(broken.getStats().error, /Malformed/);
});

test('a perimeter outage keeps the fire points', async () => {
  const { layer } = harness({
    active: collection([firePoint('GWF-058-2026')]),
    perimeters: new Error('upstream down'),
  });
  assert.equal(await layer.update(), true);
  assert.equal(layer.getStats().count, 1);
  assert.equal(layer.getStats().perimeters, 0);
  assert.equal(layer.getStats().error, null);
});

test('a network failure reports an error and returns false', async () => {
  const { layer } = harness({ active: new Error('ENOTFOUND') });
  assert.equal(await layer.update(), false);
  assert.match(layer.getStats().error, /network error/i);
});

// ── query seams ────────────────────────────────────────────────────────────

test('analyst records are empty while the layer is disabled', async () => {
  const { layer } = harness({
    active: collection([firePoint('GWF-058-2026')]), perimeters: collection([]),
  });
  await layer.update();
  assert.equal(layer.getAnalystRecords().length, 1);
  layer.disable();
  assert.deepEqual(layer.getAnalystRecords(), []);
});

test('nearestFire finds the closest record and reports its distance', async () => {
  const { layer } = harness({
    active: collection([
      firePoint('GWF-058-2026', { lat: 55.0, lon: -119.95 }),
      firePoint('RWF-068-2026', { lat: 51.05, lon: -114.06 }),
    ]),
    perimeters: collection([]),
  });
  await layer.update();
  // From Calgary, the Calgary-area fire wins.
  const nearest = layer.nearestFire(51.0447, -114.0719);
  assert.equal(nearest.label, 'RWF-068-2026');
  assert.ok(nearest.distanceKm < 50, `expected a nearby fire, got ${nearest.distanceKm} km`);
  assert.equal(layer.nearestFire(NaN, 0), null);
});
