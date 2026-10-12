import { describe, expect, it, vi } from 'vitest';
import { alertChannels, renderAlert, sendAlert } from '@/server/alerts/adapter';
import { evaluateAlerts, initialAlertState, type AlertInputs } from '@/server/alerts/checks';

// Task 1.7: alarms carry no PII, go to Telegram/Slack when configured (log otherwise), and fire
// on the four conditions — once per hour while they last.

describe('alert adapter', () => {
  it('no PII in the message even if a value smuggles one in', () => {
    const text = renderAlert(
      {
        kind: 'health_red',
        values: { consecutive: 2, reason: 'db down for ana@firma.rs PIB 101234567' },
      },
      'Product',
    );
    expect(text).not.toContain('ana@firma.rs');
    expect(text).not.toContain('101234567');
    expect(text).toContain('[Product] health_red');
  });

  it('without env: log only; with Telegram + Slack: both get the same text', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 }));
    const alert = { kind: 'events_failed', values: { failed: 3 } } as const;
    expect((await sendAlert(alert, {}, fetchImpl)).delivered).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();

    const env = {
      ALERT_TELEGRAM_BOT_TOKEN: 'tkn',
      ALERT_TELEGRAM_CHAT_ID: '42',
      ALERT_SLACK_WEBHOOK_URL: 'https://hooks.slack.test/x',
    };
    expect(alertChannels(env)).toEqual(['telegram', 'slack']);
    const sent = await sendAlert(alert, env, fetchImpl);
    expect(sent.delivered).toEqual(['telegram', 'slack']);
    const bodies = fetchImpl.mock.calls.map((c) =>
      JSON.parse(String((c as unknown as [string, RequestInit])[1].body)),
    );
    expect(bodies[0]).toMatchObject({ chat_id: '42', text: sent.text });
    expect(bodies[1]).toMatchObject({ text: sent.text });
  });

  it('a failing channel never throws', async () => {
    const down = vi.fn(async () => {
      throw new Error('ECONNRESET');
    });
    await expect(
      sendAlert(
        { kind: 'events_failed', values: { failed: 1 } },
        { ALERT_SLACK_WEBHOOK_URL: 'https://x' },
        down,
      ),
    ).resolves.toMatchObject({ delivered: [] });
  });
});

describe('alert rules', () => {
  const base: AlertInputs = {
    now: new Date('2026-10-12T05:30:00Z'), // 07:30 in Belgrade (CEST)
    platformTimezone: 'Europe/Belgrade',
    lastBackupOkAt: new Date('2026-10-12T02:05:00Z'),
    lastRestoreTest: { status: 'ok', finishedAt: new Date('2026-10-11T03:10:00Z') },
    lastRestoreOkAt: new Date('2026-10-11T03:10:00Z'),
    jobs: { failed: 0, oldestPendingSeconds: 10 },
    healthOk: true,
    healthReason: 'ok',
  };
  const kinds = (input: AlertInputs, state = initialAlertState()) =>
    evaluateAlerts(input, state).map((a) => a.kind);

  it('all good → nothing', () => {
    expect(kinds(base)).toEqual([]);
  });

  it('backup: missing after 06:00 local of tenant #0; before 06:00 not yet', () => {
    const yesterday = { ...base, lastBackupOkAt: new Date('2026-10-11T02:05:00Z') };
    expect(kinds(yesterday)).toEqual(['backup_missing']);
    expect(kinds({ ...yesterday, now: new Date('2026-10-12T03:30:00Z') })).toEqual([]); // 05:30 local
  });

  it('failed jobs, pending older than 15 min, failed restore test', () => {
    expect(kinds({ ...base, jobs: { failed: 2, oldestPendingSeconds: 901 } })).toEqual([
      'events_failed',
      'events_stuck',
    ]);
    expect(kinds({ ...base, lastRestoreTest: { status: 'failed', finishedAt: base.now } })).toEqual(
      ['restore_test_failed'],
    );
  });

  it('health: red only on the second failure in a row; repeats at most hourly; re-arms when clear', () => {
    const state = initialAlertState();
    const red = { ...base, healthOk: false, healthReason: 'db' };
    expect(kinds(red, state)).toEqual([]);
    expect(kinds({ ...red, now: new Date(base.now.getTime() + 5 * 60_000) }, state)).toEqual([
      'health_red',
    ]);
    expect(kinds({ ...red, now: new Date(base.now.getTime() + 10 * 60_000) }, state)).toEqual([]);
    expect(kinds({ ...red, now: new Date(base.now.getTime() + 70 * 60_000) }, state)).toEqual([
      'health_red',
    ]);
    expect(kinds({ ...base, now: new Date(base.now.getTime() + 75 * 60_000) }, state)).toEqual([]);
  });
});
