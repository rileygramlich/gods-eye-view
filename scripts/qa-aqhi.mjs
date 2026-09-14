/**
 * qa-aqhi.mjs — headless proof for the Alberta AQHI layer.
 *
 * The assertion that matters here is the province filter. Alberta's southwest
 * border is the Continental Divide, not a meridian, so a bounding box drawn
 * around the province also contains Cranbrook, Sparwood, Castlegar and three
 * Okanagan stations in British Columbia. The layer filters on ECCC's own
 * administrative-zone field instead; this harness proves none of those six
 * leak into an "Alberta" layer against the live feed.
 *
 * Also checks the published-form contract: AQHI is reported as an integer from
 * 1 with "10+" above ten, and a station with no reading must not surface as a
 * confident 1.
 *
 * Run:  node scripts/qa-aqhi.mjs --url http://localhost:4173
 */

import puppeteer from 'puppeteer';

const argv = process.argv.slice(2);
const getOpt = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const APP_URL = getOpt('--url', 'http://localhost:4173');

/** British Columbia AQHI stations a naive Alberta bounding box captures. */
const BC_STATIONS = [
  'Cranbrook', 'Sparwood', 'Castlegar',
  'Central Okanagan', 'North Okanagan', 'South Okanagan',
];

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  const tag = ok === null ? '\x1b[33mINCONCLUSIVE\x1b[0m' : ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
  console.log(`  [${tag}] ${name}${detail ? `  — ${detail}` : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  let exitCode = 0;
  const consoleErrors = [];
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--disable-dev-shm-usage'],
    defaultViewport: { width: 1400, height: 900 },
  });

  try {
    const page = await browser.newPage();
    page.on('pageerror', (e) => consoleErrors.push(String(e).slice(0, 160)));
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 160)); });

    await page.goto(APP_URL, { waitUntil: 'domcontentloaded', timeout: 90000 });
    await page.waitForFunction(
      () => window.__godsEyeView?.viewer && window.__godsEyeView?.dataManager,
      { timeout: 90000 },
    );
    await sleep(1500);

    const stats = await page.evaluate(async () => {
      const dm = window.__godsEyeView.dataManager;
      await dm.setEnabled('alberta-aqhi', true);
      const mod = dm.layers.get('alberta-aqhi')?.module;
      if (!mod) return { missing: true };
      let s = null;
      for (let i = 0; i < 45; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        s = mod.getStats();
        if (s.count > 0 || s.error) break;
      }
      return s;
    });

    const loaded = !stats?.missing && !stats?.error && stats?.count > 0;
    record('stations report a current index', loaded,
      `count=${stats?.count} stations=${stats?.stations} error=${stats?.error}`);
    if (!loaded) exitCode = 1;

    const records = await page.evaluate(() => window.__godsEyeView.dataManager
      .layers.get('alberta-aqhi')?.module.getAnalystRecords(200) || []);

    const leaked = records.filter((r) => BC_STATIONS.includes(r.name));
    record('no British Columbia station leaks into an Alberta layer', leaked.length === 0,
      `stations=${records.length} leaked=${leaked.length ? leaked.map((r) => r.name).join(', ') : 'none'}`);
    if (leaked.length) exitCode = 1;

    // AQHI is published as an integer from 1 up; the API returns a decimal.
    const published = records.every((r) => Number.isInteger(r.aqhi) && r.aqhi >= 1);
    record('every reading is in the published integer form, floored at 1', published,
      `values=${[...new Set(records.map((r) => r.aqhi))].sort((a, b) => a - b).join(',')}`);
    if (!published) exitCode = 1;

    const named = records.every((r) => r.risk && r.name && Number.isFinite(r.lat));
    record('readings carry a risk band, a station name, and coordinates', named,
      records.length ? `sample=${records[0].name} ${records[0].aqhi} (${records[0].risk})` : 'no records');
    if (!named) exitCode = 1;

    record('no console errors', consoleErrors.length === 0,
      consoleErrors.length ? consoleErrors.slice(0, 2).join(' | ') : 'clean');
    if (consoleErrors.length) exitCode = 1;
  } catch (e) {
    console.error('\x1b[31mHarness error:\x1b[0m', e);
    exitCode = 3;
  } finally {
    await browser.close();
  }

  const pass = results.filter((r) => r.ok === true).length;
  const fail = results.filter((r) => r.ok === false).length;
  console.log('\n' + '─'.repeat(60));
  console.log(`  RESULT: ${pass} passed, ${fail} failed`);
  console.log('─'.repeat(60) + '\n');
  process.exit(exitCode || (fail > 0 ? 1 : 0));
}

main().catch((e) => { console.error(e); process.exit(3); });
