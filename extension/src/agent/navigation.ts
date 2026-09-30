// Where the reasoning server may send the tab directly. A link click can only
// follow what the page offers; a typed URL can point anywhere, so it is held to
// the stricter rule: plain http(s), no embedded credentials, and — unless it
// stays on the origin already under observation — a public host name. Every
// other scheme (javascript:, data:, file:, chrome:, blob:, …) is refused.
// Leaving the origin still lands in the ordinary ACCESS_REQUIRED wait: the
// user grants the new site exactly as after a cross-origin link.
export const NAVIGATION_URL_MAX = 2048;

export function normalizeNavigationUrl(value: string): string | undefined {
  const text = value.trim();
  // eslint-disable-next-line no-control-regex -- refusing control characters is the point
  if (!text || text.length > NAVIGATION_URL_MAX || /[\s\u0000-\u001f\u007f\\]/.test(text)) return undefined;
  // "en.wikipedia.org/wiki/X" is how models usually write an address.
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text.replace(/^\/\//, '')}`;
  let url: URL;
  try { url = new URL(withScheme); } catch { return undefined; }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password || !url.hostname) return undefined;
  return url.href.length > NAVIGATION_URL_MAX ? undefined : url.href;
}

// Loopback, private, link-local, CGNAT, multicast and reserved IPv4 ranges,
// every IPv6 literal, single-label names and the local-only suffixes. The URL
// parser has already rewritten IPv4 shorthands (0x7f.1, 2130706433) to dotted
// decimal, so they are caught here too.
function publicHost(hostname: string) {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (host.startsWith('[') || !host.includes('.')) return false;
  if (/(^|\.)(localhost|local|internal|intranet|lan|home|corp|localdomain|home\.arpa)$/.test(host)) return false;
  const octets = host.split('.');
  if (octets.length === 4 && octets.every(part => /^\d{1,3}$/.test(part))) {
    const [a, b] = octets.map(Number);
    if (a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19))) return false;
  }
  return true;
}

export function navigationAllowed(href: string, origin: string | undefined) {
  const normalized = normalizeNavigationUrl(href);
  if (!normalized || normalized !== href) return false;
  const url = new URL(normalized);
  return url.origin === origin || publicHost(url.hostname);
}
