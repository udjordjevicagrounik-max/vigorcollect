import type { TenantContext } from '@/server/auth/with-tenant';
import { listDefinitions } from '@/server/custom-fields/service';
import { DATASET_KEYS, DATASETS } from './datasets';

/** Fields per dataset for the builder (white list + P0 custom fields of the dataset's entities). */
export async function builderCatalog(ctx: TenantContext, locale: string) {
  const custom = (await listDefinitions(ctx, { locale })).filter(
    (d) => d.piiClass === 'P0' && d.type !== 'multiselect',
  );
  return DATASET_KEYS.map((key) => {
    const ds = DATASETS[key];
    return {
      key,
      fields: [
        ...ds.fields.map((f) => ({ key: f.key, kind: f.kind, type: f.type })),
        ...custom
          .filter((d) => ds.customEntities[d.entityType as 'customer'])
          .map((d) => ({
            key: `cf.${d.key}`,
            kind: (d.type === 'number' || d.type === 'currency' ? 'both' : 'dimension') as
              'both' | 'dimension',
            type: d.type === 'currency' ? 'money' : d.type === 'select' ? 'code' : d.type,
            label: d.label,
          })),
      ],
    };
  });
}
