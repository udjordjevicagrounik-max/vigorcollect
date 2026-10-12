// Display of an amount that arrives as a decimal STRING (numeric from the API). Intl formats the
// string exactly — no float on the way (rule 18). Browser and server.
export function formatAmount(decimal: string, currency: string, locale: string): string {
  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(decimal as Intl.StringNumericLiteral);
  } catch {
    return `${decimal} ${currency}`;
  }
}
