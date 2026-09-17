// Keep the existing single-image path for ordinary pages. Large pages use
// overlapping, bounded images at the same resolution, never one giant canvas.
export function captureTiles(width: number, height: number, viewportHeight = 8192) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0 || width > 32_767) {
    throw new Error('CAPTURE_TOO_LARGE');
  }
  if (height <= 32_767 && width * height <= 32_000_000) return [{ y: 0, height, start: 0, end: height }];
  // Repeated native captures must keep the rendering surface the same size.
  // Changing tile height can expose Chrome's temporary 1×1 layout override on
  // high-DPI displays. Keep first/last tiles the same size as the middle ones.
  const tileHeight = Math.max(1, Math.min(Math.round(viewportHeight), 8192, Math.floor(8_000_000 / width)));
  const margin = Math.min(256, Math.floor(tileHeight / 4));
  const bandHeight = tileHeight - margin * 2;
  const count = Math.ceil(height / bandHeight);
  if (count > 2048) throw new Error('CAPTURE_TOO_LARGE');
  return Array.from({ length: count }, (_, index) => {
    const start = index * bandHeight, end = Math.min(height, start + bandHeight);
    const y = Math.min(Math.max(0, start - margin), height - tileHeight);
    return { y, height: tileHeight, start, end };
  });
}
