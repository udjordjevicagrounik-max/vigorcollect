// Node.js-only part of the startup hook (src/instrumentation.ts imports it only when
// NEXT_RUNTIME === 'nodejs', so the Edge bundle never sees process.exit — task 2.5).
//   - Both processes: Sentry when SENTRY_DSN is set (src/server/observability/sentry.ts).
//   - WORKER process (same image, PROCESS_ROLE=worker — scripts/worker-entry.mjs): starts the job
//     worker; the web app never starts it.
//   - RENDERER process (PROCESS_ROLE=renderer — scripts/renderer-entry.mjs, review S-10): only the
//     render loop. No Sentry, no Turnstile check: its environment holds RENDER_DATABASE_URL and
//     nothing else.
//   - WEB process: refuses to start in production without Turnstile keys (rule 27, task 1.4).
export async function registerNode(): Promise<void> {
  if (process.env.PROCESS_ROLE === 'renderer') {
    const { runRendererFromEnv } = await import('./server/documents/renderer');
    await runRendererFromEnv();
    return;
  }
  const worker = process.env.PROCESS_ROLE === 'worker';
  const { initSentry } = await import('./server/observability/sentry');
  await initSentry(worker ? 'worker' : 'web');
  if (worker) {
    const { runWorkerFromEnv } = await import('./server/jobs/worker');
    await runWorkerFromEnv();
    return;
  }
  const { assertTurnstileConfigured } = await import('./server/security/turnstile');
  try {
    assertTurnstileConfigured();
  } catch (error) {
    // Refuse to start: exit instead of a half-started server that never listens.
    console.error(error instanceof Error ? error.message : 'startup configuration error');
    process.exit(1);
  }
}
