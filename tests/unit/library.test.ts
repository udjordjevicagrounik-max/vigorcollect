import { describe, expect, it } from 'vitest';
import { parseCsv } from '@/server/imports/csv';
import {
  detectColumns,
  detectDateOrder,
  detectDecimal,
  IMPORT_FIELDS,
} from '@/server/imports/rows';
import { genericTemplateCsv } from '@/server/library/import-templates';
import {
  POLICY_TEMPLATES,
  proposeTemplate,
  TEMPLATE_RULES,
  type Answers,
} from '@/server/library/policy-templates';
import { definitionSchema } from '@/server/workflows/definition';

const base: Answers = {
  payment_terms: '30',
  reminder_before_due: 'yes',
  first_reminder: 'd1',
  tone: 'neutral',
  phone_followup: 'yes',
  escalation: 'd30',
  legal_handover: 'd60',
  seasonal: 'no',
  natural_persons: 'no',
  disputes_common: 'no',
};

describe('library: policy templates (6.4)', () => {
  it('every template rule is a valid workflow definition with a unique key', () => {
    const keys = new Set<string>();
    for (const t of POLICY_TEMPLATES) {
      expect(TEMPLATE_RULES[t].length).toBeGreaterThan(0);
      for (const r of TEMPLATE_RULES[t]) {
        expect(definitionSchema.safeParse(r.definition).success, r.key).toBe(true);
        expect(keys.has(r.key)).toBe(false);
        keys.add(r.key);
      }
    }
  });

  it('a legal-effect notice goes only to legal entities (rule 19)', () => {
    for (const t of POLICY_TEMPLATES)
      for (const r of TEMPLATE_RULES[t]) {
        const d = r.definition as {
          conditions: { field: string; value: unknown }[];
          actions: { template?: string }[];
        };
        if (d.actions.some((a) => a.template === 'pre_litigation_notice'))
          expect(d.conditions).toContainEqual({
            field: 'is_natural_person',
            op: 'eq',
            value: false,
          });
      }
  });

  it('the questionnaire proposes a template', () => {
    expect(proposeTemplate(base)).toBe('standard');
    expect(proposeTemplate({ ...base, seasonal: 'yes' })).toBe('agro_seasonal');
    expect(proposeTemplate({ ...base, tone: 'firm' })).toBe('strict');
    expect(proposeTemplate({ ...base, tone: 'friendly' })).toBe('friendly');
  });
});

describe('library: generic import template (6.4)', () => {
  it('the wizard maps every column of the template on its own', () => {
    const grid = parseCsv(genericTemplateCsv(), 10);
    const columns = detectColumns(grid[0] ?? []);
    expect(Object.keys(columns).sort()).toEqual([...IMPORT_FIELDS].sort());
    expect(detectDecimal(grid, columns)).toBe('comma');
    expect(detectDateOrder(grid, columns)).toBe('dmy');
  });
});
