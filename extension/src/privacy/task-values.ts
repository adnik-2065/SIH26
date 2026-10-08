import type { Binding } from './contracts';
import { LocalValueVault } from './value-vault';
import { Placeholders, opaqueIdentifier, sanitizeText } from './text';
import type { AgentBody } from '../agent/wire';

// Owned by the panel's run, not by a capture or a worker task (which changes
// after a new site's activeTab grant). No persistence and no page-facing API.
export class TaskValues {
  readonly id = crypto.randomUUID();
  readonly controller = new AbortController();
  readonly placeholders = new Placeholders();
  vault?: LocalValueVault;
  bind(binding: Binding, current: () => Binding | undefined) {
    if (this.controller.signal.aborted) throw new Error('LOCAL_VALUE_TASK_CLOSED');
    if (!this.vault) this.vault = new LocalValueVault(binding, this.controller.signal, current, Date.now, true);
    else this.vault.bind(binding, current);
    return this.vault;
  }
  guard = (body: AgentBody): AgentBody => {
    if (this.controller.signal.aborted) throw new Error('LOCAL_VALUE_TASK_CLOSED');
    const clean = (value: unknown): unknown => {
      if (typeof value === 'string') return opaqueIdentifier(value) ? value : sanitizeText(
        this.vault?.scrub(value, this.placeholders) ?? value, 'instruction', this.placeholders).sanitized;
      if (Array.isArray(value)) return value.map(clean);
      if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, clean(child)]));
      return value;
    };
    // The image is generated and verified by the gateway. Never rewrite PNG bytes.
    const safe = { ...clean({ ...body, ss: null }) as AgentBody, ss: body.ss };
    if (this.vault?.hasLeak(JSON.stringify({ ...safe, ss: null }))) throw new Error('LOCAL_VALUE_PAYLOAD_LEAK');
    return safe;
  };
  clear = () => { this.controller.abort(); this.vault?.clear(); this.placeholders.clear(); };
}
