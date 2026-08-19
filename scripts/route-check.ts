/** Boot the API and print the registered Twilio routes. */
import { buildContainer } from '../apps/ucc-api/src/bootstrap/container.ts';
import { createServer } from '../apps/ucc-api/src/server.ts';

const c = await buildContainer();
const app = await createServer(c);
await app.ready();
const routes = app.printRoutes({ commonPrefix: false });
const twilioRoutes = routes.split('\n').filter((l) => /twilio|relay/.test(l));
console.log(twilioRoutes.length ? twilioRoutes.join('\n') : 'NO TWILIO ROUTES FOUND');
await app.close();
process.exit(0);
