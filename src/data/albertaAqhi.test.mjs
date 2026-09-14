// src/data/albertaAqhi.test.mjs
// The load-bearing behaviour here is the province filter: a bounding box alone
// pulls British Columbia stations into an Alberta layer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  OBSERVATION_MAX_AGE_MS,
  createAlbertaAqhiLayer,
  normalizeAqhiObservations,
  normalizeAqhiStations,
} from './albertaAqhi.js';

const NOW = Date.parse('2026-09-11T18:30:00Z');
const RECENT = '2026-09-11T18:00:00Z';

const station = (id, name, zone, lon, lat) => ({
  type: 'Feature',
  geometry: { type: 'Point', coordinates: [lon, lat] },
  properties: { location_id: id, location_name_en: name, 'eccc_administrative-zone': zone },
});

const observation = (id, aqhi, when = RECENT) => ({
  type: 'Feature',
  geometry: { type: 'Point', coordinates: [0, 0] },
  properties: { location_id: id, aqhi, observation_datetime: when, special_notes_en: '' },
});

const collection = (features) => ({ type: 'FeatureCollection', features });

const ALBERTA_STATIONS = collection([
  station('IAKID', 'Calgary', 'pnr', -114.0575, 51.0458),
  station('IACMP', 'Edmonton', 'pnr', -113.49, 53.53),
]);

test('stations normalize into an id-keyed catalog', () => {
  const stations = normalizeAqhiStations(ALBERTA_STATIONS);
  assert.equal(stations.size, 2);
  assert.equal(stations.get('IAKID').name, 'Calgary');
  assert.equal(stations.get('IAKID').lat, 51.0458);
});

test('a malformed station payload is rejected atomically', () => {
  assert.equal(normalizeAqhiStations(null), null);
  assert.equal(normalizeAqhiStations({ features: 'nope' }), null);
  assert.equal(normalizeAqhiStations(collection([{ properties: null }])), null);
});

test('observations for stations outside the allowlist are dropped', () => {
  // This is the BC exclusion. The observations collection carries no zone
  // field, so a bbox query returns Cranbrook and the Okanagans alongside
  // Alberta. Only allowlisted stations may produce a reading.
  const stations = normalizeAqhiStations(ALBERTA_STATIONS);
  const readings = normalizeAqhiObservations(collection([
    observation('IAKID', 2.3),
    observation('JAIQY', 5.1), // Cranbrook, BC — not in the allowlist
    observation('JAFUV', 4.0), // Central Okanagan, BC
  ]), stations, NOW);
  assert.equal(readings.length, 1);
  assert.equal(readings[0].stationId, 'IAKID');
});

test('readings are ordered worst-air-first and carry their band', () => {
  const stations = normalizeAqhiStations(ALBERTA_STATIONS);
  const readings = normalizeAqhiObservations(collection([
    observation('IAKID', 2), observation('IACMP', 8),
  ]), stations, NOW);
  assert.deepEqual(readings.map((r) => r.stationId), ['IACMP', 'IAKID']);
  assert.equal(readings[0].risk, 'High health risk');
  assert.equal(readings[0].label, '8');
});

test('a stale reading is dropped rather than shown as current', () => {
  const stations = normalizeAqhiStations(ALBERTA_STATIONS);
  const old = new Date(NOW - OBSERVATION_MAX_AGE_MS - 60_000).toISOString();
  const readings = normalizeAqhiObservations(collection([
    observation('IAKID', 3, old), observation('IACMP', 4, RECENT),
  ]), stations, NOW);
  assert.deepEqual(readings.map((r) => r.stationId), ['IACMP']);
});

test('the newest reading per station wins', () => {
  const stations = normalizeAqhiStations(ALBERTA_STATIONS);
  const readings = normalizeAqhiObservations(collection([
    observation('IAKID', 3, '2026-09-11T16:00:00Z'),
    observation('IAKID', 7, '2026-09-11T18:00:00Z'),
  ]), stations, NOW);
  assert.equal(readings.length, 1);
  assert.equal(readings[0].aqhi, 7);
});

test('a station reporting no value produces no reading', () => {
  const stations = normalizeAqhiStations(ALBERTA_STATIONS);
  const readings = normalizeAqhiObservations(collection([
    observation('IAKID', null), observation('IACMP', ''),
  ]), stations, NOW);
  assert.deepEqual(readings, []);
});

test('a malformed observation payload is rejected atomically', () => {
  const stations = normalizeAqhiStations(ALBERTA_STATIONS);
  assert.equal(normalizeAqhiObservations(null, stations, NOW), null);
  assert.equal(normalizeAqhiObservations(collection([{ properties: null }]), stations, NOW), null);
  assert.equal(normalizeAqhiObservations(collection([]), 'not a map', NOW), null);
});

// ── layer lifecycle ────────────────────────────────────────────────────────

function harness({ stations = ALBERTA_STATIONS, observations, failStations = false } = {}) {
  const fetchImpl = async (url) => {
    if (url.includes('aqhi-stations')) {
      if (failStations) throw new Error('upstream down');
      return { ok: true, status: 200, json: async () => stations };
    }
    return { ok: true, status: 200, json: async () => observations };
  };
  const layer = createAlbertaAqhiLayer({
    overlayHost: { setEntries() {}, setVisible() {}, clearSource() {} },
    fetchImpl,
    now: () => NOW,
  });
  layer.init({ dataSources: { add() {}, remove() {} } });
  layer.enable();
  return layer;
}

test('the layer requests only the Alberta zone', async () => {
  const urls = [];
  const layer = createAlbertaAqhiLayer({
    overlayHost: { setEntries() {}, setVisible() {}, clearSource() {} },
    fetchImpl: async (url) => {
      urls.push(url);
      return {
        ok: true,
        status: 200,
        json: async () => (url.includes('aqhi-stations')
          ? ALBERTA_STATIONS
          : collection([observation('IAKID', 2)])),
      };
    },
    now: () => NOW,
  });
  layer.init({ dataSources: { add() {}, remove() {} } });
  layer.enable();
  await layer.update();
  const stationUrl = urls.find((u) => u.includes('aqhi-stations'));
  assert.match(stationUrl, /eccc_administrative-zone=pnr/);
  assert.match(stationUrl, /bbox=-120,49,-110,60/);
  assert.match(urls.find((u) => u.includes('observations')), /latest=true/);
});

test('update renders Alberta readings and reports station count', async () => {
  const layer = harness({ observations: collection([observation('IAKID', 2), observation('IACMP', 5)]) });
  assert.equal(await layer.update(), true);
  const stats = layer.getStats();
  assert.equal(stats.count, 2);
  assert.equal(stats.stations, 2);
  assert.equal(stats.error, null);
  assert.equal(layer.getAnalystRecords().length, 2);
});

test('a station-catalog outage reports an error instead of an empty province', async () => {
  const layer = harness({ failStations: true, observations: collection([]) });
  assert.equal(await layer.update(), false);
  assert.match(layer.getStats().error, /network error/i);
});

test('analyst records are empty while disabled, and nearest reading resolves', async () => {
  const layer = harness({ observations: collection([observation('IAKID', 2), observation('IACMP', 9)]) });
  await layer.update();
  const nearest = layer.nearestReading(51.0447, -114.0719);
  assert.equal(nearest.name, 'Calgary');
  assert.ok(nearest.distanceKm < 10);
  layer.disable();
  assert.deepEqual(layer.getAnalystRecords(), []);
});
