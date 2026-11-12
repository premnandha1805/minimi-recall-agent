import { loadConfig, loadEnvIfPresent } from './config.js';
import { buildServer } from './server.js';

const SHUTDOWN_TIMEOUT_MS = 5_000;

async function start(): Promise<void> {
  loadEnvIfPresent();
  const config = loadConfig();
  const app = buildServer({ config });

  let shuttingDown = false;

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;

    app.log.info({ signal }, 'Shutting down server gracefully');

    const forceTimer = setTimeout(() => {
      app.log.error('Graceful shutdown timed out; forcing exit');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    forceTimer.unref();

    try {
      await app.close();
      clearTimeout(forceTimer);
      app.log.info('Server stopped cleanly');
      process.exit(0);
    } catch (error) {
      clearTimeout(forceTimer);
      app.log.error({ err: error }, 'Error during server shutdown');
      process.exit(1);
    }
  };

  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));

  try {
    await app.listen({ port: config.PORT, host: config.HOST });
    app.log.info(
      { host: config.HOST, port: config.PORT, env: config.NODE_ENV },
      'Recall Agent HTTP server listening'
    );
  } catch (error) {
    app.log.error({ err: error }, 'Failed to start server');
    process.exit(1);
  }
}

void start();
