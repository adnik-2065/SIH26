// Native lazy images can be decoded without scrolling. Restore their loading
// attributes afterwards; site-specific infinite-scroll/data-src loaders are not
// executed by the extension.
export async function prepareImages(signal: AbortSignal): Promise<void> {
  const images = Array.from(document.querySelectorAll<HTMLImageElement>('img[loading]'))
    .filter(image => image.loading === 'lazy' && !image.complete && !!(image.currentSrc || image.getAttribute('src')))
    .map(image => ({ image, loading: image.getAttribute('loading')! }));
  if (!images.length) return;
  let rejectWait!: (error: Error) => void;
  const interrupted = new Promise<never>((_resolve, reject) => { rejectWait = reject; });
  const abort = () => rejectWait(new Error('STOPPED'));
  const deadline = setTimeout(() => rejectWait(new Error('CAPTURE_FAILED')), 3000);
  signal.addEventListener('abort', abort, { once: true });
  try {
    if (signal.aborted) throw new Error('STOPPED');
    for (const { image } of images) image.loading = 'eager';
    // Broken images are already missing from the page; a slow pending image must
    // instead time out explicitly, rather than silently yielding an incomplete scan.
    await Promise.race([Promise.all(images.map(({ image }) => image.decode().catch(() => {}))), interrupted]);
  } finally {
    clearTimeout(deadline);
    signal.removeEventListener('abort', abort);
    for (const { image, loading } of images) if (image.loading === 'eager') image.setAttribute('loading', loading);
  }
}
