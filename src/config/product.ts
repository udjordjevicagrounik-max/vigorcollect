import { z } from 'zod';

// Product name is never hardcoded (rule 21). It is configured per deployment.
const productSchema = z.object({
  PRODUCT_NAME: z.string().trim().min(1),
});

export type ProductConfig = { productName: string };

export function getProductConfig(): ProductConfig {
  const env = productSchema.parse(process.env);
  return { productName: env.PRODUCT_NAME };
}
