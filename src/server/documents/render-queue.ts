import type { Pool } from 'pg';
import { logEvent } from '@/lib/log';
import { pinPdfDates, type PdfResult } from './pdf';

/**
 * Worker side of HTML → PDF (review S-10). Chromium no longer runs in the worker — it runs in the
 * renderer service (src/server/documents/renderer.ts), a container that holds no secret at all.
 * The worker hands the HTML over through render_jobs (migration 021):
 *
 *   1. INSERT the job in its own COMMITTED tenant transaction (the renderer must see it);
 *   2. wait until the renderer marks it done / failed (short reads, never one long transaction);
 *   3. take the PDF, pin its dates to the document date, DELETE the row — the caller encrypts
 *      and stores the PDF (renderDocumentPdf).
 * No answer within the timeout → the row is deleted and the job fails (the domain event retries
 * with backoff). Expired rows of a dead worker are removed by retention.
 */

export const RENDER_TIMEOUT_MS = 60_000;
const POLL_MS = 250;

export class RenderError extends Error {
  constructor(readonly code: 'timeout' | 'failed' | 'gone') {
    super(`render: ${code}`);
    this.name = 'RenderError';
  }
}

async function inTenant<T>(
  pool: Pool,
  tenantId: string,
  fn: (q: Pool['query']) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const result = await fn(client.query.bind(client) as Pool['query']);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export type QueuedRender = (
  html: string,
  documentDate: Date,
  job: { tenantId: string; documentId: string },
) => Promise<PdfResult>;

/** A render function for renderDocumentPdf that goes through the renderer service. */
export function queuedRender(
  pool: Pool,
  opts: { timeoutMs?: number; pollMs?: number } = {},
): QueuedRender {
  const timeoutMs = opts.timeoutMs ?? RENDER_TIMEOUT_MS;
  const pollMs = opts.pollMs ?? POLL_MS;
  return async (html, documentDate, { tenantId, documentId }) => {
    const id = await inTenant(pool, tenantId, async (q) => {
      const { rows } = await q<{ id: string }>(
        `INSERT INTO render_jobs (tenant_id, document_id, html_in) VALUES (app_tenant_id(), $1, $2) RETURNING id`,
        [documentId, html],
      );
      return rows[0]?.id ?? '';
    });
    const deadline = Date.now() + timeoutMs;
    try {
      for (;;) {
        const row = await inTenant(pool, tenantId, async (q) => {
          const { rows } = await q<{
            status: string;
            pdf_out: Buffer | null;
            renderer: string | null;
            error: string | null;
          }>('SELECT status, pdf_out, renderer, error FROM render_jobs WHERE id = $1', [id]);
          return rows[0];
        });
        if (!row) throw new RenderError('gone');
        if (row.status === 'done' && row.pdf_out) {
          return {
            pdf: pinPdfDates(row.pdf_out, documentDate),
            renderer: row.renderer ?? 'chromium/unknown',
          };
        }
        if (row.status === 'failed') {
          logEvent('render.failed', { level: 'error', tenantId, documentId, code: row.error });
          throw new RenderError('failed');
        }
        if (Date.now() >= deadline) throw new RenderError('timeout');
        await new Promise((r) => setTimeout(r, pollMs));
      }
    } finally {
      // The HTML (and PDF) never outlive the job: done, failed or timed out.
      await inTenant(pool, tenantId, (q) => q('DELETE FROM render_jobs WHERE id = $1', [id])).catch(
        () => logEvent('render.cleanup_failed', { level: 'warn', tenantId, documentId }),
      );
    }
  };
}
