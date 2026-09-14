// src/data/aqhiScale.test.mjs
// The AQHI scale is a published health index with a specific reporting form:
// integers from 1, "10+" above ten. These tests pin that form.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AQHI_BANDS,
  AQHI_UNKNOWN_COLOR,
  aqhiBand,
  aqhiColor,
  aqhiDisplayValue,
  aqhiLabel,
  aqhiRiskText,
} from './aqhiScale.js';

test('display value rounds to the published integer form and floors at 1', () => {
  assert.equal(aqhiDisplayValue(1.08), 1);
  assert.equal(aqhiDisplayValue(2.32), 2);
  assert.equal(aqhiDisplayValue(3.5), 4);
  assert.equal(aqhiDisplayValue('3'), 3);
  // There is no AQHI 0 — a very low reading is published as 1.
  assert.equal(aqhiDisplayValue(0), 1);
  assert.equal(aqhiDisplayValue(0.4), 1);
});

test('an absent reading never becomes a confident AQHI 1', () => {
  // Number(null) and Number('') are both 0, which would floor to 1. A station
  // that reported nothing must stay reported as nothing.
  for (const empty of [null, undefined, '', '   ', NaN, true, {}, [], -1]) {
    assert.equal(aqhiDisplayValue(empty), null, `${JSON.stringify(empty)} must be null`);
    assert.equal(aqhiLabel(empty), '--');
    assert.equal(aqhiColor(empty), AQHI_UNKNOWN_COLOR);
    assert.equal(aqhiRiskText(empty), null);
  }
});

test('bands follow the published ECCC risk categories', () => {
  const bandOf = (v) => aqhiBand(v).id;
  assert.equal(bandOf(1), 'low');
  assert.equal(bandOf(3), 'low');
  assert.equal(bandOf(4), 'moderate');
  assert.equal(bandOf(6), 'moderate');
  assert.equal(bandOf(7), 'high');
  assert.equal(bandOf(10), 'high');
  assert.equal(bandOf(11), 'very-high');
  assert.equal(bandOf(40), 'very-high');
});

test('values above ten collapse to the open-ended 10+ label', () => {
  assert.equal(aqhiLabel(10), '10');
  assert.equal(aqhiLabel(11), '10+');
  assert.equal(aqhiLabel(99), '10+');
});

test('every band has a distinct colour and severity rises monotonically', () => {
  const colors = AQHI_BANDS.map((b) => b.color);
  assert.equal(new Set(colors).size, colors.length);
  assert.notEqual(aqhiColor(1), aqhiColor(11));
  const maxima = AQHI_BANDS.map((b) => b.max);
  assert.deepEqual(maxima, [...maxima].sort((a, b) => a - b));
});

test('risk text names the band', () => {
  assert.equal(aqhiRiskText(2), 'Low health risk');
  assert.equal(aqhiRiskText(8), 'High health risk');
  assert.equal(aqhiRiskText(12), 'Very High health risk');
});
