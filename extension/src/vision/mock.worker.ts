// Fixture plumbing only. This worker does not read pixels or run an AI model.
self.onmessage = (event: MessageEvent<{ observationId: string; fixtureId: string; width: number; height: number }>) => {
  const input = event.data;
  if (input.fixtureId !== 'synthetic-details' || input.width !== 720 || input.height !== 240) {
    self.postMessage({ error: 'MOCK_REQUIRES_FIXED_FIXTURE' }); return;
  }
  const start = performance.now();
  setTimeout(() => self.postMessage({
    observationId: input.observationId, source: 'mock', elapsedMs: performance.now() - start,
    regions: [{ kind: 'text', text: 'Email: student@example.test', bounds: { x: 30, y: 128, width: 645, height: 38 } }],
  }), 350);
};
