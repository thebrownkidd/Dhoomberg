import { createApp } from './app';
import { HOST, PORT } from './paths';
import { demoTick } from './plugins/datasources';

async function main() {
  const { app, py, rules } = createApp();
  await py.start().catch((e) => console.warn('[py] disabled:', e.message));
  setInterval(demoTick, 1500);
  rules.start();
  await app.listen({ host: HOST, port: PORT });
  console.log(`Dhoomberg server on http://${HOST}:${PORT}  (python plugins: ${py.available ? py.plugins.length : `off: ${py.error}`})`);

  const shutdown = () => { rules.stop(); py.stop(); app.close().finally(() => process.exit(0)); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
