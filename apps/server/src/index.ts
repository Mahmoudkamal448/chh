import { buildApp } from './app';
import { loadConfig } from './config';
import { MemoryStore } from './store/memory';
import { PostgresStore } from './store/postgres';

const config = loadConfig();
const store = config.store === 'memory' ? new MemoryStore() : new PostgresStore(config.databaseUrl!);
await store.migrate();
const app = await buildApp({ config, store });
if (config.store === 'memory') app.log.warn('STORE=memory: data is NOT persisted. Use Postgres in production.');

const shutdown = async () => {
  await app.close();
  await store.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await app.listen({ port: config.port, host: config.host });
