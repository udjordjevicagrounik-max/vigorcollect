import { Pool } from 'pg';
import { logEvent } from '@/lib/log';
import { renderPdf, type PdfResult } from './pdf';

/**
 * The renderer service (review S-10): the ONLY process that starts Chromium. Same image as the
 * worker, PROCESS_ROLE=renderer (scripts/renderer-entry.mjs), and its environment holds exactly
 * one credential: RENDER_DATABASE_URL (role vigor_renderer — SELECT/UPDATE on render_jobs, no
 * other table; migration 021). No PII key, no backup role, no tenant data beyond the HTML it is
 * handed. Chromium still runs with --no-sandbox (pdf.ts), but a compromised renderer finds no
 * secret to steal and no table to read.
 *
 * Loop: claim the oldest queued job (FOR UPDATE SKIP LOCKED — several renderers may run), render
 * with JavaScript off and every request aborted, write the PDF (or an error code) back. The PDF
 * dates are pinned by the worker; the renderer never sees the document date.
 */

const IDLE_MS = 500;

type Job = { id: string; html_in: string };

export type RenderFn = (html: string, at: Date) => Promise<PdfResult>;

/** Renders at most one queued job; true when a job was handled. */
export async function renderNext(pool: Pool, render: RenderFn = renderPdf): Promise<boolean> {
  const { rows } = await pool.query<Job>(
    `UPDATE render_jobs SET status = 'rendering'
     WHERE id = (SELECT id FROM render_jobs WHERE status = 'queued' AND expires_at > now()
                 ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED)
     RETURNING id, html_in`,
  );
  const job = rows[0];
  if (!job) return false;
  const started = Date.now();
  try {
    const { pdf, renderer } = await render(job.html_in, new Date(0));
    await pool.query(
      `UPDATE render_jobs SET status = 'done', pdf_out = $2, renderer = $3 WHERE id = $1`,
      [job.id, pdf, renderer],
    );
    logEvent('render.done', { jobId: job.id, bytes: pdf.length, ms: Date.now() - started });
  } catch (error) {
    await pool
      .query(`UPDATE render_jobs SET status = 'failed', error = 'render.failed' WHERE id = $1`, [
        job.id,
      ])
      .catch(() => undefined);
    logEvent('render.error', {
      level: 'error',
      jobId: job.id,
      name: error instanceof Error ? error.name : 'unknown',
    });
  }
  return true;
}

// Next bundles instrumentation (the loop) and the /health route as SEPARATE module instances in
// one process — a module variable would never be seen by the route. The heartbeat lives on
// globalThis instead.
const HEARTBEAT = Symbol.for('collect.renderer.heartbeat');
type Heartbeat = { [HEARTBEAT]?: number };

export function markRendererAlive(at = Date.now()): void {
  (globalThis as Heartbeat)[HEARTBEAT] = at;
}

/** /health of the renderer process: the loop ran within the last 30 s. */
export function rendererAlive(now = Date.now()): boolean {
  return now - ((globalThis as Heartbeat)[HEARTBEAT] ?? 0) < 30_000;
}

/** Entry for PROCESS_ROLE=renderer. Fails fast without its one database URL. */
export async function runRendererFromEnv(): Promise<void> {
  const url = process.env.RENDER_DATABASE_URL;
  if (!url) throw new Error('RENDER_DATABASE_URL is required.');
  const pool = new Pool({ connectionString: url, max: 2 });
  let stopping = false;
  const stop = () => {
    stopping = true;
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  logEvent('renderer.started', {});
  void (async () => {
    while (!stopping) {
      markRendererAlive();
      const busy = await renderNext(pool).catch((error: unknown) => {
        logEvent('renderer.loop_error', {
          level: 'error',
          name: error instanceof Error ? error.name : 'unknown',
        });
        return false;
      });
      if (!busy) await new Promise((r) => setTimeout(r, IDLE_MS));
    }
    await pool.end();
    process.exit(0);
  })();
}
