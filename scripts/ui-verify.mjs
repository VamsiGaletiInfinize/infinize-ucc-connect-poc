/**
 * Drive the UCC console in a real browser and report what actually renders.
 *
 * Visits every route, screenshots it, and captures console errors, page errors and
 * failed network requests. A route that renders an empty shell, throws in React, or
 * silently 404s its data is reported as a failure — a clean build proves none of that.
 *
 * Usage: node scripts/ui-verify.mjs [outDir]
 */
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';

const WEB = process.env.WEB_ORIGIN ?? 'http://localhost:5173';
const API = process.env.API_ORIGIN ?? 'http://localhost:4000';
const OUT = process.argv[2] ?? 'ui-shots';

const j = async (p) => (await fetch(`${API}${p}`)).json();

const [calls, tickets] = await Promise.all([j('/api/calls'), j('/api/tickets')]);
const callId = calls[0]?.id;
const ticketId = tickets[0]?.id;

if (!callId || !ticketId) {
  console.error('No seeded call/ticket — create one before running so detail pages have data.');
  process.exit(1);
}

const routes = [
  ['01-dashboard', '/dashboard'],
  ['02-calls', '/calls'],
  ['03-call-detail', `/calls/${callId}`],
  ['04-tickets', '/tickets'],
  ['05-ticket-detail', `/tickets/${ticketId}`],
  ['06-agents', '/agents'],
  ['07-queues', '/queues'],
  ['08-outbound', '/outbound'],
  ['09-knowledge', '/knowledge'],
  ['10-supervisor', '/supervisor'],
];

mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const results = [];

for (const [name, path] of routes) {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1100 } });
  const page = await ctx.newPage();

  const consoleErrors = [];
  const pageErrors = [];
  const failedRequests = [];

  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text().slice(0, 200)));
  page.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 200)));
  page.on('response', (r) => {
    if (r.status() >= 400) failedRequests.push(`${r.status()} ${r.url().replace(API, '')}`);
  });

  let navError = null;
  try {
    await page.goto(`${WEB}${path}`, { waitUntil: 'networkidle', timeout: 30_000 });
    // Let polling/SSE-driven panels settle before judging emptiness.
    await page.waitForTimeout(1200);
  } catch (e) {
    navError = String(e).slice(0, 200);
  }

  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true });

  const text = (await page.locator('body').innerText().catch(() => '')).trim();

  results.push({
    name,
    path,
    textLength: text.length,
    // A shell with only chrome/nav and no content is the failure this catches.
    looksEmpty: text.length < 200,
    consoleErrors,
    pageErrors,
    failedRequests,
    navError,
    sample: text.replace(/\s+/g, ' ').slice(0, 160),
  });

  await ctx.close();
}

await browser.close();
writeFileSync(`${OUT}/report.json`, JSON.stringify(results, null, 2));

let bad = 0;
for (const r of results) {
  const problems = [
    r.navError && `NAV: ${r.navError}`,
    r.looksEmpty && `EMPTY (${r.textLength} chars)`,
    r.pageErrors.length && `REACT: ${r.pageErrors[0]}`,
    r.consoleErrors.length && `CONSOLE(${r.consoleErrors.length}): ${r.consoleErrors[0]}`,
    r.failedRequests.length && `HTTP: ${[...new Set(r.failedRequests)].join(', ')}`,
  ].filter(Boolean);

  if (problems.length) bad += 1;
  console.log(`${problems.length ? 'FAIL' : 'ok  '}  ${r.name.padEnd(16)} ${String(r.textLength).padStart(5)}ch  ${problems.length ? problems.join(' | ') : r.sample}`);
}

console.log(`\n${results.length - bad}/${results.length} routes clean. Screenshots in ${OUT}/`);
process.exit(bad ? 1 : 0);
