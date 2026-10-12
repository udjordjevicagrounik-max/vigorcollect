// Next.js startup hook. In the WORKER process (same image, PROCESS_ROLE=worker — see
// scripts/worker-entry.mjs) it starts the pg-boss worker; the web app never starts it.
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs' || process.env.PROCESS_ROLE !== 'worker') return;
  const { runWorkerFromEnv } = await import('./server/jobs/worker');
  await runWorkerFromEnv();
}
