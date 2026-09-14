/**
 * @module aqhiScale
 *
 * The Canadian Air Quality Health Index scale — banding, display value, and
 * colour ramp. Pure; no Cesium, no network.
 *
 * AQHI is a health-risk index, not a pollutant concentration. Environment and
 * Climate Change Canada reports it as an INTEGER from 1 to 10, with anything
 * above 10 reported as the open-ended category "10+". The API returns a decimal
 * (1.08, 2.32), which is the underlying computed value — publishing that
 * decimal as-is would invent a precision the index does not claim, so
 * `aqhiDisplayValue` rounds to the published form and floors at 1.
 *
 * Bands follow ECCC's published health-risk categories:
 *   1-3 Low · 4-6 Moderate · 7-10 High · above 10 Very High
 */

/** ECCC health-risk bands, in ascending severity. */
export const AQHI_BANDS = Object.freeze([
  Object.freeze({ id: 'low', label: 'Low', max: 3, color: '#4cc9f0' }),
  Object.freeze({ id: 'moderate', label: 'Moderate', max: 6, color: '#ffd43b' }),
  Object.freeze({ id: 'high', label: 'High', max: 10, color: '#ff6b35' }),
  Object.freeze({ id: 'very-high', label: 'Very High', max: Infinity, color: '#c1121f' }),
]);

/** Colour used when a station reports no usable reading. */
export const AQHI_UNKNOWN_COLOR = '#6b7785';

/**
 * The published AQHI value for a raw reading: an integer from 1 up, or null.
 *
 * ECCC reports whole numbers with a floor of 1 — there is no "AQHI 0" and no
 * "AQHI 1.08". A raw value below 1 is a legitimate low reading, not an error,
 * and is published as 1.
 *
 * @param {number|string|null|undefined} raw - Raw `aqhi` value from the API.
 * @returns {number|null} Published integer AQHI, or null when unusable.
 */
export function aqhiDisplayValue(raw) {
  // Guard the empty forms BEFORE coercing: Number(null) and Number('') are both
  // 0, which would otherwise floor to a confident "AQHI 1" for a station that
  // reported nothing at all.
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw !== 'number' && typeof raw !== 'string') return null;
  if (typeof raw === 'string' && raw.trim() === '') return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return null;
  return Math.max(1, Math.round(value));
}

/**
 * The health-risk band for a reading.
 * @param {number|string|null|undefined} raw - Raw or published AQHI value.
 * @returns {object|null} Band descriptor, or null when the reading is unusable.
 */
export function aqhiBand(raw) {
  const value = aqhiDisplayValue(raw);
  if (value === null) return null;
  return AQHI_BANDS.find((band) => value <= band.max) || AQHI_BANDS[AQHI_BANDS.length - 1];
}

/**
 * Accent colour for a reading, falling back to neutral grey when absent.
 * @param {number|string|null|undefined} raw
 * @returns {string} CSS hex colour.
 */
export function aqhiColor(raw) {
  return aqhiBand(raw)?.color || AQHI_UNKNOWN_COLOR;
}

/**
 * Label text for a marker: the published value, with "+" above 10.
 * @param {number|string|null|undefined} raw
 * @returns {string} e.g. "3", "10+", or "--" when there is no reading.
 */
export function aqhiLabel(raw) {
  const value = aqhiDisplayValue(raw);
  if (value === null) return '--';
  return value > 10 ? '10+' : String(value);
}

/**
 * Plain-language risk phrase for a reading, for voice and card text.
 * @param {number|string|null|undefined} raw
 * @returns {string|null} e.g. "Low health risk", or null when unusable.
 */
export function aqhiRiskText(raw) {
  const band = aqhiBand(raw);
  return band ? `${band.label} health risk` : null;
}
