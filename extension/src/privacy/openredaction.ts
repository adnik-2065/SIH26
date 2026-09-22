import { patterns } from '../../vendor/openredaction/patterns.js';
import { LIMITS, privacyError, PrivacyError, type PiiKind } from './contracts';
import type { Span } from './classify';

// Only reviewed additions. Indian IDs, names, email, phone and Luhn remain
// owned by the existing rules. Never call detect()/restore(): those allocate
// original-text/restoration maps and a persistent placeholder value map.
const kinds: Record<string, PiiKind> = {
  IBAN: 'bank_account', SSN: 'document', MAC_ADDRESS: 'token',
  GOOGLE_API_KEY: 'api_key', SLACK_TOKEN: 'token', DATABASE_CONNECTION: 'token',
};

export function additionalTextCandidates(text: string): Span[] {
  if (text.length > LIMITS.text) throw new PrivacyError('LIMIT_EXCEEDED');
  const spans: Span[] = [];
  try {
    for (const pattern of patterns) {
      const regex = new RegExp(pattern.regex.source, pattern.regex.flags);
      for (const match of text.matchAll(regex)) {
        const value = match[1] ?? match[0];
        // Use bounded context for SSN; checksum validation for IBAN. Do not let
        // prose such as "test IBAN" disable protection of a valid account.
        const context = pattern.type === 'IBAN' ? '' : text.slice(Math.max(0, match.index! - 50), match.index! + match[0].length + 50);
        if (pattern.validator && !pattern.validator(value, context)) continue;
        spans.push({ start: match.index!, end: match.index! + match[0].length,
          kind: kinds[pattern.type], detector: 'openredaction', confidence: pattern.validator ? .99 : .9 });
        if (spans.length > LIMITS.findings) throw new PrivacyError('LIMIT_EXCEEDED');
      }
    }
    return spans;
  } catch (error) {
    throw error instanceof PrivacyError ? error : privacyError('INCOMPLETE_DETECTION_OCR', 'PRIVACY_NORMALIZATION',
      'The additional text detector failed, so its coverage of the page is unknown.',
      { errorName: error instanceof Error ? error.name : typeof error }, 'openredaction threw');
  }
}
