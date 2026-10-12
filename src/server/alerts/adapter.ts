import { logEvent } from '@/lib/log';
import { scrubText } from '@/server/observability/scrub';

/**
 * Operational alarms (task 1.7) — Telegram bot and/or Slack incoming webhook from env; without
 * them the alarm is only logged. Messages are built from FIXED templates and P0 values only
 * (counts, seconds, ISO times, codes) and pass the PII scrubber anyway (rule 20). A failing
 * channel never throws — alarms must not take the worker down.
 */

export type AlertKind =
  'backup_missing' | 'events_failed' | 'events_stuck' | 'health_red' | 'restore_test_failed';

export type Alert = { kind: AlertKind; values: Record<string, number | string | null> };

export type AlertEnv = {
  ALERT_TELEGRAM_BOT_TOKEN?: string | undefined;
  ALERT_TELEGRAM_CHAT_ID?: string | undefined;
  ALERT_SLACK_WEBHOOK_URL?: string | undefined;
  PRODUCT_NAME?: string | undefined;
};

const TEMPLATES: Record<AlertKind, (v: Alert['values']) => string> = {
  backup_missing: (v) =>
    `Backup not finished by 06:00 (${v.timezone}). Last successful backup: ${v.lastBackupAt ?? 'never'}.`,
  events_failed: (v) =>
    `${v.failed} background job(s) failed. Check the worker log (outbox.failed).`,
  events_stuck: (v) =>
    `Oldest pending job waits ${v.oldestPendingSeconds} s (limit ${v.limitSeconds} s). Is the worker running?`,
  health_red: (v) => `Health check failed ${v.consecutive} times in a row (${v.reason}).`,
  restore_test_failed: (v) =>
    `Weekly restore test failed (${v.reason}). Last good: ${v.lastOkAt ?? 'never'}.`,
};

export function renderAlert(alert: Alert, productName = 'App'): string {
  return scrubText(`[${productName}] ${alert.kind}: ${TEMPLATES[alert.kind](alert.values)}`);
}

export function alertChannels(env: AlertEnv): ('telegram' | 'slack')[] {
  const channels: ('telegram' | 'slack')[] = [];
  if (env.ALERT_TELEGRAM_BOT_TOKEN?.trim() && env.ALERT_TELEGRAM_CHAT_ID?.trim())
    channels.push('telegram');
  if (env.ALERT_SLACK_WEBHOOK_URL?.trim()) channels.push('slack');
  return channels;
}

export async function sendAlert(
  alert: Alert,
  env: AlertEnv = process.env as AlertEnv,
  fetchImpl: typeof fetch = fetch,
): Promise<{ text: string; delivered: string[] }> {
  const text = renderAlert(alert, env.PRODUCT_NAME || 'App');
  const delivered: string[] = [];
  for (const channel of alertChannels(env)) {
    try {
      const res =
        channel === 'telegram'
          ? await fetchImpl(
              `https://api.telegram.org/bot${env.ALERT_TELEGRAM_BOT_TOKEN}/sendMessage`,
              {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ chat_id: env.ALERT_TELEGRAM_CHAT_ID, text }),
                signal: AbortSignal.timeout(10_000),
              },
            )
          : await fetchImpl(env.ALERT_SLACK_WEBHOOK_URL ?? '', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ text }),
              signal: AbortSignal.timeout(10_000),
            });
      if (res.ok) delivered.push(channel);
      else logEvent('alert.channel_failed', { level: 'error', channel, status: res.status });
    } catch {
      logEvent('alert.channel_failed', { level: 'error', channel, status: null });
    }
  }
  logEvent('alert', {
    level: 'error',
    kind: alert.kind,
    delivered: delivered.join(',') || 'log_only',
  });
  return { text, delivered };
}
