import { getZaloApi, resetZaloApi, triggerQRLogin } from './zalo/client.js';
import { CloseReason } from 'zca-js';
import { setupZaloHandler } from './zalo/handler.js';
import { backfillGroups } from './backfill.js';
import { config } from './config.js';
import { slack } from './slack/client.js';
import { existsSync } from 'fs';

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
    const api = existsSync(config.zalo.credentialsPath)
      ? await getZaloApi()
      : await triggerQRLogin();
    await startZalo(api);

    // Background backfill for group history
    void (async () => {
      await new Promise(r => setTimeout(r, 3000)); // Wait 3s for listener to settle
      console.log('[Backfill] Starting group history backfill...');
      try {
        const result = await backfillGroups(api, 2, (done, total, group) => {
          console.log(`[Backfill] Progress: ${done}/${total} - ${group}`);
        });
        console.log(`[Backfill] Complete: ${result.succeeded} succeeded, ${result.failed} failed, ${result.skipped} skipped`);
      } catch (err) {
        console.error('[Backfill] Error:', err);
      }
    })();
  } catch (err) {
    console.error('[Boot] Zalo login failed:', err);
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