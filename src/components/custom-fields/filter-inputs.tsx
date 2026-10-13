import { getTranslations } from 'next-intl/server';

// Filter inputs of filterable custom fields (6.1) for a GET list form: name `cf.<key>`.

type Def = {
  key: string;
  type: string;
  label: string;
  options: { code: string; label: string; active: boolean }[];
};

const field = 'min-h-11 rounded-md border border-border bg-surface px-3';
const BOOL_TRUE = 'true';
const BOOL_FALSE = 'false';

export async function CustomFieldFilters({
  fields,
  values,
}: {
  fields: Def[];
  values: Record<string, string>;
}) {
  if (fields.length === 0) return null;
  const t = await getTranslations('customFields');
  return (
    <>
      {fields.map((d) => {
        const name = `cf.${d.key}`;
        const current = values[name] ?? '';
        return (
          <label
            key={d.key}
            className="flex flex-col gap-1 text-sm font-medium text-text"
            data-cf-filter={d.key}
          >
            {d.label}
            {d.type === 'select' || d.type === 'multiselect' ? (
              <select name={name} defaultValue={current} className={field}>
                <option value="">{t('any')}</option>
                {d.options.map((o) => (
                  <option key={o.code} value={o.code}>
                    {o.label}
                  </option>
                ))}
              </select>
            ) : d.type === 'bool' ? (
              <select name={name} defaultValue={current} className={field}>
                <option value="">{t('any')}</option>
                <option value={BOOL_TRUE}>{t('yes')}</option>
                <option value={BOOL_FALSE}>{t('no')}</option>
              </select>
            ) : (
              <input
                name={name}
                type={d.type === 'date' ? 'date' : 'text'}
                inputMode={d.type === 'number' || d.type === 'currency' ? 'decimal' : undefined}
                defaultValue={current}
                className={field}
              />
            )}
          </label>
        );
      })}
    </>
  );
}
