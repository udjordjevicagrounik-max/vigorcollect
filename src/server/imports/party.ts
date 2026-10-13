/**
 * Who is the customer of an imported row (security review S-02, rules 19, 20, 25)?
 *
 * The identifier rules come from jurisdiction_profiles.party_id_rules of the customer's country
 * (never from code): {"natural_person": "<regex>", "company": "<regex>"}. The optional import
 * column "natural person" (yes / no) states it explicitly. The answer:
 *   - company      — a business subject: canonical legal entity, as before;
 *   - sole_trader  — stated as a natural person but holding a business identifier (registered
 *                    entrepreneur, ADR 0002 decision 4): legal entity + is_natural_person;
 *   - consumer     — a personal identifier: NEVER a legal entity, the identifier is not stored,
 *                    the name only encrypted (createConsumer);
 *   - uncertain    — anything else (no rules for the country, no match, a contradiction): the row
 *                    is not imported, a person decides (exception review_required).
 */

export type PartyRules = { natural_person?: string; company?: string };
export type PartyKind = 'company' | 'sole_trader' | 'consumer' | 'uncertain';

function matches(pattern: string | undefined, value: string): boolean {
  if (!pattern) return false;
  try {
    return new RegExp(pattern).test(value);
  } catch {
    return false; // a broken rule never decides
  }
}

export function classifyParty(
  rules: PartyRules,
  identifier: string,
  statedNaturalPerson: boolean | null,
): PartyKind {
  const id = identifier.trim();
  const personal = matches(rules.natural_person, id);
  const business = matches(rules.company, id);
  if (personal && business) return 'uncertain';
  if (statedNaturalPerson === true) {
    if (personal) return 'consumer';
    if (business) return 'sole_trader';
    return 'uncertain';
  }
  if (statedNaturalPerson === false) {
    // "Not a natural person" with a personal identifier is a contradiction.
    if (personal) return 'uncertain';
    if (business) return 'company';
    // The file vouches for a company the rules cannot check (e.g. a country without rules).
    return 'company';
  }
  if (personal) return 'consumer';
  if (business) return 'company';
  return 'uncertain';
}

/** "natural person" column: yes / no / empty (unknown). */
export function parseYesNo(value: string): boolean | null | 'invalid' {
  const v = value.trim().toLowerCase();
  if (v === '') return null;
  if (['da', 'yes', 'y', 'true', '1', 'x', 'fizičko', 'fizicko'].includes(v)) return true;
  if (['ne', 'no', 'n', 'false', '0', 'pravno'].includes(v)) return false;
  return 'invalid';
}
