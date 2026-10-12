// Next.js startup hook.
//   - Both processes: Sentry when SENTRY_DSN is set (src/server/observability/sentry.ts).
//   - WORKER process (same image, PROCESS_ROLE=worker — scripts/worker-entry.mjs): starts the job
//     worker; the web app never starts it.
//   - WEB process: refuses to start in production without Turnstile keys (rule 27, task 1.4).
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
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

export async function onRequestError(
  error: unknown,
  request: { path: string; method: string; headers: Record<string, string | string[] | undefined> },
): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { reportRequestError } = await import('./server/observability/sentry');
  reportRequestError(error, request);
}
