import { getZaloApi, resetZaloApi } from './zalo/client.js';
import { CloseReason } from 'zca-js';
import { setupZaloHandler } from './zalo/handler.js';
import { config } from './config.js';
import { slack } from './slack/client.js';

process.on('unhandledRejection', (reason) => {
  console.error('[Boot] Unhandled rejection (ignored):', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[Boot] Uncaught exception (ignored):', err);
});

async function startZalo(
  api: Awaited<ReturnType<typeof getZaloApi>>,
  isReconnect = false,
): Promise<void> {
  await setupZaloHandler(api);
  api.listener.start();
  console.log(`[Boot] Zalo listener ${isReconnect ? 're' : ''}started ✓`);

  api.listener.once('disconnected', (code: CloseReason, _reason: string) => {
    if ((code as number) === 1000) return;
    console.warn(`[Boot] Zalo disconnected (code=${code}), reconnecting in 5 s…`);
    setTimeout(() => {
      void (async () => {
        try {
          resetZaloApi();
          const newApi = await getZaloApi();
          await startZalo(newApi, true);
          console.log('[Boot] Zalo reconnected ✓');
        } catch (err) {
          console.error('[Boot] Zalo reconnect failed:', err);
        }
      })();
    }, 5_000);
  });
}

async function main(): Promise<void> {
  console.log('╔════════════════════════════════════╗');
  console.log('║   Zalo → Slack Archiver  v1.0.0    ║');
  console.log('╚════════════════════════════════════╝');

  // Verify Slack connection
  try {
    const auth = await slack.auth.test();
    console.log(`[Boot] Connected to Slack as @${auth.user} (${auth.team})`);
  } catch (err) {
    console.error('[Boot] Failed to connect to Slack:', err);
    process.exit(1);
  }

  // Start Zalo
  try {
    const api = await getZaloApi();
    await startZalo(api);
  } catch (err) {
    console.error('[Boot] Zalo login failed:', err);
    console.log('[Boot] Make sure credentials.json exists or run the Zalo login flow.');
    process.exit(1);
  }

  console.log('[Boot] Bridge is running 🚀 (Ctrl+C to stop)');

  const shutdown = (signal: string) => {
    console.log(`\n[Boot] Received ${signal}, shutting down...`);
    try { getZaloApi().then(api => api.listener.stop()).catch(() => undefined); } catch { /* ignore */ }
    process.exit(0);
  };

  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err: unknown) => {
  console.error('[Boot] Fatal error:', err);
  process.exit(1);
});