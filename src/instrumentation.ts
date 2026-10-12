// Next.js startup hook.
//   - WORKER process (same image, PROCESS_ROLE=worker — scripts/worker-entry.mjs): starts the job
//     worker; the web app never starts it.
//   - WEB process: refuses to start in production without Turnstile keys (rule 27, task 1.4).
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  if (process.env.PROCESS_ROLE === 'worker') {
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
