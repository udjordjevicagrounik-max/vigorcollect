import { describe, expect, it } from 'vitest';
import {
  render,
  TemplateError,
  validateTemplate,
  type RenderContext,
} from '@/server/templates/render';

const ctx: RenderContext = {
  customer: {
    name: 'A & <b>B</b>',
    tax_id: '100',
    external_id: 'X',
    open_total: '10,00 RSD',
    overdue_total: '5,00 RSD',
  },
  company: { name: 'Firma', tax_id: '200' },
  collector: { name: 'Pera' },
  today: '12. okt 2026.',
  invoice: null,
  invoices: [
    {
      number: 'F-1',
      issue_date: 'd1',
      due_date: 'd2',
      amount_total: '1',
      amount_open: '1',
      days_overdue: '3',
    },
    {
      number: 'F-2',
      issue_date: 'd1',
      due_date: 'd2',
      amount_total: '2',
      amount_open: '2',
      days_overdue: '4',
    },
  ],
};

describe('templates: safe render', () => {
  it('only whitelisted variables, sections and tags', () => {
    for (const bad of [
      ['{{customer.email}}', 'unknown_variable'],
      ['{{constructor}}', 'unknown_variable'],
      ['{{ customer.name.length }}', 'unknown_variable'],
      ['{{#customers}}x{{/customers}}', 'unknown_section'],
      ['{{#invoices}}x', 'unbalanced_section'],
      ['<script>x</script>', 'forbidden_markup'],
      ['<p onclick="x">y</p>', 'forbidden_markup'],
      ['<a href="javascript:x">y</a>', 'forbidden_markup'],
      ['<img src=x>', 'forbidden_markup'],
      ['<!-- x -->', 'forbidden_markup'],
      ['{{customer.name}', 'unknown_variable'],
    ] as const) {
      expect(() => validateTemplate('S', bad[0]), bad[0]).toThrow(new TemplateError(bad[1]));
    }
    expect(() => validateTemplate('<p>S</p>', '<p>x</p>')).toThrow(TemplateError);
    expect(() =>
      validateTemplate(
        'Opomena {{customer.name}}',
        '<p>{{customer.name}}</p><ul>{{#invoices}}<li>{{invoice.number}}</li>{{/invoices}}</ul>',
      ),
    ).not.toThrow();
  });

  it('escapes every value in HTML and loops invoices', () => {
    expect(
      render(
        '<p>{{customer.name}}</p><ul>{{#invoices}}<li>{{invoice.number}} {{invoice.days_overdue}}</li>{{/invoices}}</ul>',
        ctx,
        'html',
      ),
    ).toBe('<p>A &amp; &lt;b&gt;B&lt;/b&gt;</p><ul><li>F-1 3</li><li>F-2 4</li></ul>');
    expect(render('Opomena — {{customer.name}}', ctx, 'text')).toBe('Opomena — A & <b>B</b>');
  });
});
