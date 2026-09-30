export const patterns: ReadonlyArray<{ type: string; regex: RegExp; validator?: (value: string, context: string) => boolean }>;
export interface FalsePositiveRule { patternType: string | string[]; matcher: (value: string, context: string) => boolean; description: string; severity: 'high' | 'medium' | 'low' }
export const commonFalsePositives: ReadonlyArray<FalsePositiveRule>;
export function isFalsePositive(value: string, patternType: string, context: string, rules?: ReadonlyArray<FalsePositiveRule>): { isFalsePositive: boolean; confidence: number };
export function analyzeFullContext(text: string, value: string, patternType: string, startPos: number, endPos: number): { confidence: number };
