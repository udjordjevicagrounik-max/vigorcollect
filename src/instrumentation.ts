// Next.js startup hook. Everything Node-only (Sentry, worker start, the Turnstile startup check
// with process.exit) lives in instrumentation-node.ts and is imported only in the Node.js runtime.
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { registerNode } = await import('./instrumentation-node');
    await registerNode();
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
