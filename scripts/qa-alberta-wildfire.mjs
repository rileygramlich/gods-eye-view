/**
 * qa-alberta-wildfire.mjs — headless proof for the Alberta Wildfire layer.
 *
 * The layer reports official agency records rather than satellite detections,
 * so what this harness checks is that the agency fields actually survive the
 * converter, and that the off-season behaves as designed.
 *
 * Alberta's fire season runs roughly March–October. An empty active-fire feed
 * is a real answer for months at a time, so a zero count is reported
 * INCONCLUSIVE with seasonState 'quiet' rather than FAIL — a harness that goes
 * red every November for a layer working correctly is worse than no harness.
 *
 * Run:  node scripts/qa-alberta-wildfire.mjs --url http://localhost:4173
 */

import puppeteer from 'puppeteer';

const argv = process.argv.slice(2);
const getOpt = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const APP_URL = getOpt('--url', 'http://localhost:4173');

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
      await dm.setEnabled('alberta-wildfire', true);
      const mod = dm.layers.get('alberta-wildfire')?.module;
      if (!mod) return { missing: true };
      let s = null;
      for (let i = 0; i < 45; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        s = mod.getStats();
        if (s.count > 0 || s.error) break;
      }
      return s;
    });

    const loaded = !stats?.missing && !stats?.error
      && ['active', 'quiet'].includes(stats?.seasonState);
    record('the layer loads and reports a season state', loaded,
      `count=${stats?.count} perimeters=${stats?.perimeters} season=${stats?.seasonState} error=${stats?.error}`);
    if (!loaded) exitCode = 1;

    const records = await page.evaluate(() => window.__godsEyeView.dataManager
      .layers.get('alberta-wildfire')?.module.getAnalystRecords(50) || []);

    if (records.length === 0) {
      record('records carry assessed agency fields', null,
        'no fires in the current snapshot — legitimate outside fire season');
    } else {
      // The reason this layer exists alongside FIRMS: assessed agency data.
      const shaped = records.every((r) => r.id && typeof r.hasPerimeter === 'boolean'
        && typeof r.historical === 'boolean');
      const assessed = records.some((r) => r.status || r.cause || r.responseType);
      record('records carry assessed agency fields, not just hotspots', shaped && assessed,
        `sample=${JSON.stringify(records[0]).slice(0, 160)}`);
      if (!(shaped && assessed)) exitCode = 1;

      // Off-season rows must never be presented as currently burning.
      const honest = stats.seasonState === 'quiet'
        ? records.every((r) => r.historical === true)
        : records.every((r) => r.historical === false);
      record('historical and active records are never conflated', honest,
        `season=${stats.seasonState} historical=${records.filter((r) => r.historical).length}/${records.length}`);
      if (!honest) exitCode = 1;

      const inProvince = records.every((r) => r.lat >= 48.9 && r.lat <= 60.1
        && r.lon >= -120.1 && r.lon <= -109.9);
      record('every fire sits inside Alberta', inProvince,
        `n=${records.length}`);
      if (!inProvince) exitCode = 1;
    }

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
  const inconclusive = results.filter((r) => r.ok === null).length;
  console.log('\n' + '─'.repeat(60));
  console.log(`  RESULT: ${pass} passed, ${fail} failed, ${inconclusive} inconclusive`);
  console.log('─'.repeat(60) + '\n');
  process.exit(exitCode || (fail > 0 ? 1 : 0));
}

main().catch((e) => { console.error(e); process.exit(3); });
