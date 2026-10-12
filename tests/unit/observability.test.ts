import { describe, expect, it } from 'vitest';
import { scrubEvent, scrubText, sensitiveKeySet } from '@/server/observability/scrub';

// Rule 20 / task 1.7: nothing personal leaves for Sentry or alarms — e-mail, name, PIB.

const EVENT_ID = '7f3c2a4e-9b7d-4c1e-8a2b-5d6e7f8a9b0c';

describe('Sentry beforeSend scrubbing', () => {
  const keys = sensitiveKeySet(['contact_person']); // + registry columns at runtime

  it('email, name and PIB do not pass — keys, free text, user, cookies, headers', () => {
    const event = {
      message: `Import failed for petar.petrovic@firma.rs (PIB 101234567, MB 07012345) id ${EVENT_ID}`,
      user: { email: 'petar.petrovic@firma.rs', username: 'Petar Petrović' },
      tags: { request_id: EVENT_ID, process_role: 'web' },
      extra: {
        display_name: 'Petar Petrović',
        legal_name: 'Petrović d.o.o.',
        tax_id: '101234567',
        contact_person: 'Marko Marković',
        nested: { email_enc: 'AAAA', note: 'call 0641234567 or mail ana@x.rs' },
        count: 3,
      },
      request: {
        url: '/api/users/x',
        cookies: { 'better-auth.session_token': 'secret' },
        headers: { cookie: 'a=b', authorization: 'Bearer x', 'x-request-id': EVENT_ID },
        data: { email: 'ana@x.rs' },
      },
      exception: { values: [{ type: 'Error', value: 'duplicate key for ana@x.rs / 101234567' }] },
    };
    const out = JSON.stringify(scrubEvent(event, keys));
    for (const leak of [
      'petar.petrovic@firma.rs',
      'ana@x.rs',
      'Petar Petrović',
      'Petrović d.o.o.',
      'Marko Marković',
      '101234567',
      '07012345',
      '0641234567',
      'Bearer',
      'session_token',
    ]) {
      expect(out).not.toContain(leak);
    }
    // ids and counts survive — they are what support needs
    expect(out).toContain(EVENT_ID);
    expect(out).toContain('"count":3');
    expect(out).toContain('"process_role":"web"');
  });

  it('free text keeps UUIDs and short numbers, masks e-mail / long digits / IBAN', () => {
    expect(scrubText(`row ${EVENT_ID} failed 3 times`)).toBe(`row ${EVENT_ID} failed 3 times`);
    expect(scrubText('pay to RS35260005601001611379 from a@b.co')).toBe(
      'pay to [iban] from [email]',
    );
    expect(scrubText('JMBG 0101990710123')).toBe('JMBG [number]');
  });
});
