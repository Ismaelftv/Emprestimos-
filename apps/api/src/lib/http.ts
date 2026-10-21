import type { z } from 'zod';
import { badRequest } from './errors.js';
export function parse<T extends z.ZodTypeAny>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data ?? {});
  if (!r.success) throw badRequest(r.error.issues.map((i) => `${i.path.join('.') || 'campo'}: ${i.message}`).join('; '));
  return r.data;
}
export const emailNorm = (s: string) => s.trim().toLowerCase();
