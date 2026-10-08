$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot

$js = @'
import { readFileSync, writeFileSync } from 'node:fs';
const LF = String.fromCharCode(10);

// --- Fix: label-based financial_document classification --------------------
{
  const path = 'src/dom/visuals.ts';
  const text = readFileSync(path, 'utf8');
  const oldStr = `  if (/bank|financial|statement|cheque|checkbook|invoice/i.test(label)) return 'financial_document';`;
  const newStr = [
    `  // A bare word like "financial" or "bank" matches ordinary page wording`,
    `  // (course titles, nav links) and blanked legitimate UI at runtime. The`,
    `  // label evidence must name a document artefact, mirroring the OCR cue`,
    `  // rules that already refuse common-word triggers.`,
    `  if (/financial\\s+(?:document|record|statement)|bank\\s+statement|\\b(?:invoice|cheque|checkbook)\\b/i.test(label)) return 'financial_document';`,
  ].join(LF);
  const count = text.split(oldStr).length - 1;
  if (count !== 1) throw new Error(`visuals.ts: expected 1 occurrence, found ${count}`);
  writeFileSync(path, text.replace(oldStr, newStr));
  console.log('patched src/dom/visuals.ts');
}

// --- Regression test -------------------------------------------------------
{
  const path = 'tests/unit/repair-regressions.test.ts';
  const text = readFileSync(path, 'utf8');
  const anchor = `describe('My Courses localized over-masking regressions', () => {`;
  const idx = text.indexOf(anchor);
  if (idx < 0) throw new Error('anchor not found');
  const block = [
    anchor,
    `  it('does not classify ordinary course-title wording as document evidence', () => {`,
    `    // Runtime-proven false positive: the EIS314 alt text with the word`,
    `    // financial matched the bare label rule and masked the course thumbnail.`,
    `    // Document-style phrases still classify.`,
    `    expect(documentCategory('EIS314 Financial Crime Motivations and Typologies course thumbnail')).toBeUndefined();`,
    `    expect(documentCategory('World Bank annual report')).toBeUndefined();`,
    `    expect(documentCategory('Scanned bank statement front page')).toBe('financial_document');`,
    `    expect(documentCategory('Signed invoice')).toBe('financial_document');`,
    `  });`,
    ``,
  ].join(LF);
  const patched = text.slice(0, idx) + block + text.slice(idx);
  if (patched === text) throw new Error('insert failed');
  writeFileSync(path, patched);
  console.log('patched tests/unit/repair-regressions.test.ts');
}
'@

Set-Content -LiteralPath '.tmp-patch-financial.mjs' -Value $js -Encoding UTF8
node .tmp-patch-financial.mjs
$code = $LASTEXITCODE
Remove-Item -LiteralPath '.tmp-patch-financial.mjs' -ErrorAction SilentlyContinue
if ($code -ne 0) { exit $code }
Write-Host 'OK'
