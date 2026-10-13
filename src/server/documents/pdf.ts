import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * HTML → PDF (task 3.3) with the system Chromium of the worker image (Debian package, pinned in
 * the Dockerfile) driven by puppeteer-core. Only the worker renders; the web app never starts a
 * browser. The input is a document we generated ourselves (whitelisted tags, escaped values,
 * no scripts), and the page is locked down anyway:
 *   - JavaScript off, every network request aborted (nothing is fetched — no SSRF, no tracking);
 *   - nothing that needs root: the worker runs as the unprivileged `node` user, no capabilities
 *     (compose cap_drop ALL, no-new-privileges), Docker's default seccomp/AppArmor unchanged.
 *     Chromium's own sandbox needs user namespaces or a setuid helper, which exactly those
 *     defaults forbid — so it runs with --no-sandbox INSIDE that container boundary instead of
 *     loosening the container (SYS_ADMIN / privileged / custom seccomp were rejected, NEXT.md);
 *   - a fresh profile per render, deleted afterwards.
 * Deterministic output (stable checksum for the same HTML): the PDF's creation/modification
 * dates are pinned to the document's own date, in place (same byte length, xref offsets intact).
 */

export const CHROMIUM_PATH_DEFAULT = '/usr/bin/chromium';

export function chromiumPath(): string | null {
  const path = process.env.CHROMIUM_PATH || CHROMIUM_PATH_DEFAULT;
  return existsSync(/* turbopackIgnore: true */ path) ? path : null;
}

/** "D:YYYYMMDDHHmmSS" + zone, as Skia writes it; pinned to `at` (UTC) keeping the length. */
export function pinPdfDates(pdf: Buffer, at: Date): Buffer {
  const iso = at.toISOString(); // 2026-10-13T13:37:00.000Z
  const stamp = `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}`;
  const text = pdf.toString('latin1');
  const pinned = text.replace(
    /\/(CreationDate|ModDate) \(D:(\d{14})([^)]*)\)/g,
    (_m, key: string, _d: string, zone: string) =>
      `/${key} (D:${stamp}${zone.replace(/[0-9]/g, '0').replace(/[+-]/, '+')})`,
  );
  return Buffer.from(pinned, 'latin1');
}

export type PdfResult = { pdf: Buffer; renderer: string };

export async function renderPdf(html: string, documentDate: Date): Promise<PdfResult> {
  const executablePath = chromiumPath();
  if (!executablePath) throw new Error('pdf: chromium is not installed');
  const { launch } = await import('puppeteer-core');
  const profile = await mkdtemp(join(tmpdir(), 'pdf-'));
  const browser = await launch({
    executablePath,
    headless: true,
    userDataDir: profile,
    args: [
      // See the header: the container is the sandbox (non-root, no caps, default seccomp).
      '--no-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--disable-extensions',
      '--disable-background-networking',
      '--no-first-run',
      '--no-default-browser-check',
      '--font-render-hinting=none',
    ],
  });
  try {
    const version = (await browser.version()).replace(/^[^/]*\//, '');
    const page = await browser.newPage();
    await page.setJavaScriptEnabled(false);
    await page.setRequestInterception(true);
    page.on('request', (request) => {
      void request.abort('blockedbyclient');
    });
    await page.setContent(html, { waitUntil: 'load' });
    const raw = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '20mm', bottom: '20mm', left: '18mm', right: '18mm' },
    });
    return {
      pdf: pinPdfDates(Buffer.from(raw), documentDate),
      renderer: `chromium/${version.replace(/[^0-9A-Za-z._-]/g, '').slice(0, 40)}`,
    };
  } finally {
    await browser.close().catch(() => undefined);
    await rm(profile, { recursive: true, force: true });
  }
}
