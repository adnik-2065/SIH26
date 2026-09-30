import type { LocalObservation } from '../contracts';

type Tile = LocalObservation['tiles'][number];

// A detector's answer depends only on the pixels it is given. Between rounds
// most of a page is pixel-identical (typing into one field leaves the rest of a
// long page as it was), yet every tile was decoded and run through OCR, face
// and document inference again. Results are keyed by a SHA-256 of the tile's
// screenshot plus the crop geometry, so a changed pixel is a different key and
// can never be answered from an older capture. Entries hold detector output in
// tile coordinates only; every caller re-applies its current observation's
// placement and filters, so nothing observation-bound is reused.
const digests = new WeakMap<Tile, Promise<string>>();
export function tileDigest(tile: Tile): Promise<string> {
  let digest = digests.get(tile);
  if (!digest) {
    digest = crypto.subtle.digest('SHA-256', new TextEncoder().encode(tile.screenshot)).then(hash =>
      Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join(''));
    digests.set(tile, digest);
  }
  return digest;
}

// Bounded and in memory only. OCR entries carry page text, so the panel clears
// every cache when a run stops or a new one starts. The counters feed the run
// log: `misses` are detector runs, `skips` are inputs a detector could not
// have contributed to and so never ran on.
export class ResultCache<T> {
  private readonly entries = new Map<string, T>();
  hits = 0; misses = 0; skips = 0;
  constructor(private readonly limit = 64) {}
  get(key: string): T | undefined {
    const value = this.entries.get(key);
    if (value === undefined) { this.misses++; return undefined; }
    // Least recently used goes first.
    this.entries.delete(key); this.entries.set(key, value);
    this.hits++;
    return value;
  }
  set(key: string, value: T) {
    this.entries.delete(key); this.entries.set(key, value);
    while (this.entries.size > this.limit) this.entries.delete(this.entries.keys().next().value!);
  }
  clear() { this.entries.clear(); this.resetCounts(); }
  resetCounts() { this.hits = 0; this.misses = 0; this.skips = 0; }
  get size() { return this.entries.size; }
}
