import { describe, expect, it } from 'vitest';
import { ActionResponseSchema, PanelCommandSchema, StepRequestSchema } from '../../src/contracts';
const envelope = { protocolVersion: 1, requestId: 'request_1', taskId: 'task_1', observationId: 'obs_1' };
describe('action contract', () => {
  it.each([
    { type: 'click', target: 'element_1' }, { type: 'fill', target: 'element_1', valueRef: 'value_1' },
    { type: 'select', target: 'element_1', optionRef: 'option_1' }, { type: 'scroll', direction: 'down', pixels: 500 },
    { type: 'wait', milliseconds: 500 }, { type: 'done' },
  ])('accepts supported action %j', action => expect(ActionResponseSchema.safeParse({ ...envelope, action }).success).toBe(true));
  it.each([
    { type: 'execute', code: 'document.body.click()' }, { type: 'click', target: 'element_1', script: 'alert(1)' },
    { type: 'fill', target: 'element_1', value: 'private@example.test' },
    { type: 'scroll', direction: 'down', pixels: -10 }, { type: 'wait', milliseconds: 999999 },
    { type: 'done', target: 'element_1' }, { type: 'click', target: '' },
  ])('rejects unsupported or invalid action %j', action => expect(ActionResponseSchema.safeParse({ ...envelope, action }).success).toBe(false));
  it('rejects missing IDs and unknown top-level fields', () => {
    expect(ActionResponseSchema.safeParse({ action: { type: 'done' } }).success).toBe(false);
    expect(ActionResponseSchema.safeParse({ ...envelope, action: { type: 'done' }, extra: true }).success).toBe(false);
  });
  it('separates the future export format from local observation', () => {
    const request = { ...envelope, sanitizedInstruction: 'Inspect the form', elements: [], valueRefs: [] };
    expect(StepRequestSchema.safeParse(request).success).toBe(true);
    for (const key of ['screenshot', 'dom', 'selectors', 'valueMap', 'password']) {
      expect(StepRequestSchema.safeParse({ ...request, [key]: 'raw' }).success).toBe(false);
    }
  });
  it('validates panel commands at runtime', () => {
    expect(PanelCommandSchema.safeParse({ type: 'START', instruction: '  ' }).success).toBe(false);
    expect(PanelCommandSchema.safeParse({ type: 'START', instruction: 'Read form', tabId: 99 }).success).toBe(false);
    expect(PanelCommandSchema.safeParse({ type: 'STOP' }).success).toBe(true);
  });
});
