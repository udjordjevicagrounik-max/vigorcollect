/**
 * Safe template rendering (task 3.2) — no eval, no property access by name at render time:
 * a template is a list of tokens over a FIXED whitelist of variables. A placeholder outside the
 * whitelist, an unknown section, an unbalanced section, a tag outside the HTML whitelist or any
 * attribute is rejected when the template is saved AND again when it is rendered.
 * Values are prepared (formatted, Money through Intl) by context.ts and HTML-escaped here.
 *
 *   {{customer.name}}  {{#invoices}} … {{invoice.number}} … {{/invoices}}
 */

export const VARIABLES = [
  'customer.name',
  'customer.tax_id',
  'customer.external_id',
  'customer.open_total',
  'customer.overdue_total',
  'company.name',
  'company.tax_id',
  'collector.name',
  'today',
  'invoice.number',
  'invoice.issue_date',
  'invoice.due_date',
  'invoice.amount_total',
  'invoice.amount_open',
  'invoice.days_overdue',
] as const;
export type Variable = (typeof VARIABLES)[number];
const VARIABLE_SET: ReadonlySet<string> = new Set(VARIABLES);
const SECTIONS: ReadonlySet<string> = new Set(['invoices']);

// Tags a tenant may use in a body; no attributes at all (no on*, style, href, src).
const TAGS: ReadonlySet<string> = new Set([
  'p',
  'br',
  'strong',
  'em',
  'h1',
  'h2',
  'h3',
  'ul',
  'ol',
  'li',
  'table',
  'thead',
  'tbody',
  'tr',
  'th',
  'td',
  'span',
  'div',
]);

export class TemplateError extends Error {
  constructor(
    readonly reason:
      'unknown_variable' | 'unknown_section' | 'unbalanced_section' | 'forbidden_markup',
  ) {
    super(`template: ${reason}`);
    this.name = 'TemplateError';
  }
}

type Token =
  | { kind: 'text'; value: string }
  | { kind: 'var'; name: Variable }
  | { kind: 'open' | 'close'; name: string };

export function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  const re = /\{\{\s*([#/]?)([a-z_.]+)\s*\}\}/g;
  let last = 0;
  for (const m of source.matchAll(re)) {
    if (m.index > last) tokens.push({ kind: 'text', value: source.slice(last, m.index) });
    const [, sigil = '', name = ''] = m;
    if (sigil === '#') tokens.push({ kind: 'open', name });
    else if (sigil === '/') tokens.push({ kind: 'close', name });
    else if (VARIABLE_SET.has(name)) tokens.push({ kind: 'var', name: name as Variable });
    else throw new TemplateError('unknown_variable');
    last = m.index + m[0].length;
  }
  if (last < source.length) tokens.push({ kind: 'text', value: source.slice(last) });
  // Any "{{" left in plain text is a malformed placeholder — never passed through.
  if (tokens.some((t) => t.kind === 'text' && t.value.includes('{{')))
    throw new TemplateError('unknown_variable');
  const stack: string[] = [];
  for (const t of tokens) {
    if (t.kind === 'open') {
      if (!SECTIONS.has(t.name)) throw new TemplateError('unknown_section');
      stack.push(t.name);
    } else if (t.kind === 'close' && stack.pop() !== t.name) {
      throw new TemplateError('unbalanced_section');
    }
  }
  if (stack.length) throw new TemplateError('unbalanced_section');
  return tokens;
}

/** Markup check for a body: only whitelisted tags, never an attribute, comment or entity trick. */
export function assertSafeMarkup(body: string): void {
  if (/<!|<\?|javascript:|&#|\\u00/i.test(body)) throw new TemplateError('forbidden_markup');
  for (const m of body.matchAll(/<\/?\s*([a-zA-Z0-9]+)([^>]*)>/g)) {
    const tag = (m[1] ?? '').toLowerCase();
    const rest = (m[2] ?? '').trim();
    if (!TAGS.has(tag) || (rest !== '' && rest !== '/'))
      throw new TemplateError('forbidden_markup');
  }
  // A "<" that does not open a whitelisted tag is not allowed either.
  if (/<(?!\/?\s*[a-zA-Z0-9]+[^>]*>)/.test(body)) throw new TemplateError('forbidden_markup');
}

export function validateTemplate(subject: string, body: string): void {
  tokenize(subject);
  tokenize(body);
  assertSafeMarkup(subject);
  assertSafeMarkup(body);
  if (/<[^>]*>/.test(subject)) throw new TemplateError('forbidden_markup');
}

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};
export const escapeHtml = (v: string) => v.replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);

export type InvoiceValues = Record<
  'number' | 'issue_date' | 'due_date' | 'amount_total' | 'amount_open' | 'days_overdue',
  string
>;
export type RenderContext = {
  customer: Record<'name' | 'tax_id' | 'external_id' | 'open_total' | 'overdue_total', string>;
  company: Record<'name' | 'tax_id', string>;
  collector: Record<'name', string>;
  today: string;
  invoice: InvoiceValues | null;
  invoices: InvoiceValues[];
};

function lookup(ctx: RenderContext, name: Variable, row: InvoiceValues | null): string {
  if (name === 'today') return ctx.today;
  const [scope, field] = name.split('.') as [string, string];
  if (scope === 'invoice') return (row ?? ctx.invoice)?.[field as keyof InvoiceValues] ?? '';
  const group = ctx[scope as 'customer' | 'company' | 'collector'] as Record<string, string>;
  return group[field] ?? '';
}

/** Renders validated tokens; every value is escaped (html) — the template text itself was checked. */
export function render(source: string, ctx: RenderContext, mode: 'html' | 'text'): string {
  if (mode === 'html') assertSafeMarkup(source);
  const tokens = tokenize(source);
  const out = (list: Token[], row: InvoiceValues | null): string => {
    let s = '';
    for (let i = 0; i < list.length; i += 1) {
      const t = list[i];
      if (!t) continue;
      if (t.kind === 'text') s += t.value;
      else if (t.kind === 'var') {
        const v = lookup(ctx, t.name, row);
        s += mode === 'html' ? escapeHtml(v) : v;
      } else if (t.kind === 'open') {
        let depth = 1;
        let j = i + 1;
        for (; j < list.length; j += 1) {
          const u = list[j];
          if (u?.kind === 'open') depth += 1;
          if (u?.kind === 'close') depth -= 1;
          if (depth === 0) break;
        }
        const inner = list.slice(i + 1, j);
        for (const r of ctx.invoices) s += out(inner, r);
        i = j;
      }
    }
    return s;
  };
  return out(tokens, null);
}
