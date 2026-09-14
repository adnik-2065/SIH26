import { z } from 'zod';
import { RectSchema } from '../contracts';

export interface PerceptionInput {
  observationId: string;
  image: ImageBitmap;
  fixtureId?: 'synthetic-details';
}
export const PerceptionResultSchema = z.object({
  observationId: z.string().min(1).max(100),
  source: z.enum(['mock', 'model']),
  // A completed inference is not a privacy clearance. Phase 2 owns export policy.
  regions: z.array(z.object({
    kind: z.enum(['text', 'face', 'unknown']), bounds: RectSchema,
    text: z.string().max(1000).optional(), confidence: z.number().min(0).max(1).optional(),
  }).strict()).max(500),
  elapsedMs: z.number().nonnegative(),
}).strict();
export type PerceptionResult = z.infer<typeof PerceptionResultSchema>;
export interface PerceptionAdapter {
  inspect(input: PerceptionInput, signal: AbortSignal): Promise<PerceptionResult>;
}
