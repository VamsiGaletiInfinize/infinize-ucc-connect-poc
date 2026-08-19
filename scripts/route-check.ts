/**
 * Boot the API and print every registered route.
 *
 * Cheap guard against a route silently failing to register — a plugin that throws during
 * registration otherwise shows up only when a webhook 404s mid-call.
 */
import { buildContainer } from '../apps/ucc-api/src/bootstrap/container.ts';
import { createServer } from '../apps/ucc-api/src/server.ts';

const c = await buildContainer();
const app = await createServer(c);
await app.ready();

const lines = app
  .printRoutes({ commonPrefix: false })
  .split('\n')
  .filter((l) => /\((GET|POST|PUT|PATCH|DELETE|HEAD)/.test(l));

console.log(lines.join('\n'));
console.log(`\n${lines.length} routes registered`);

await app.close();
process.exit(0);
