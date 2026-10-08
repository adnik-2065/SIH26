import { PerceptionResultSchema, type PerceptionAdapter, type PerceptionInput } from './contracts';

export class MockPerceptionAdapter implements PerceptionAdapter {
  inspect(input: PerceptionInput, signal: AbortSignal) {
    return new Promise<ReturnType<typeof PerceptionResultSchema.parse>>((resolve, reject) => {
      if (signal.aborted) { input.image.close(); reject(new Error('STOPPED')); return; }
      if (input.fixtureId !== 'synthetic-details') { input.image.close(); reject(new Error('MOCK_REQUIRES_FIXED_FIXTURE')); return; }
      let worker: Worker;
      try { worker = new Worker(new URL('./mock.worker.ts', import.meta.url), { type: 'module' }); }
      catch { input.image.close(); reject(new Error('WORKER_FAILED')); return; }
      const cleanup = () => { clearTimeout(deadline); worker.terminate(); signal.removeEventListener('abort', abort); };
      const abort = () => { cleanup(); reject(new Error('STOPPED')); };
      const deadline = setTimeout(() => { cleanup(); reject(new Error('WORKER_TIMEOUT')); }, 5000);
      signal.addEventListener('abort', abort, { once: true });
      worker.onmessage = event => {
        cleanup();
        const result = PerceptionResultSchema.safeParse(event.data);
        if (!result.success || result.data.observationId !== input.observationId || result.data.source !== 'mock') reject(new Error('INVALID_WORKER_RESULT'));
        else resolve(result.data);
      };
      worker.onerror = () => { cleanup(); reject(new Error('WORKER_FAILED')); };
      worker.postMessage({ observationId: input.observationId, fixtureId: input.fixtureId, width: input.image.width, height: input.image.height });
      input.image.close();
    });
  }
}
