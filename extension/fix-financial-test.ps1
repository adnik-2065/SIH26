$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot

$js = @'
import { readFileSync, writeFileSync } from 'node:fs';
const LF = String.fromCharCode(10);

const path = 'tests/unit/repair-regressions.test.ts';
let text = readFileSync(path, 'utf8');

// 1) Remove the misplaced block (it got inserted inside the last describe).
const oldBlock = [
  `describe(` + String.fromCharCode(39) + `My Courses localized over-masking regressions` + String.fromCharCode(39) + `, () => {`,
  `  it(` + String.fromCharCode(39) + `does not classify ordinary course-title wording as document evidence` + String.fromCharCode(39) + `, () => {`,
  `    // Runtime-proven false positive: the EIS314 alt text with the word`,
  `    // financial matched the bare label rule and masked the course thumbnail.`,
  `    // Document-style phrases still classify.`,
  `    expect(documentCategory(` + String.fromCharCode(39) + `EIS314 Financial Crime Motivations and Typologies course thumbnail` + String.fromCharCode(39) + `)).toBeUndefined();`,
  `    expect(documentCategory(` + String.fromCharCode(39) + `World Bank annual report` + String.fromCharCode(39) + `)).toBeUndefined();`,
  `    expect(documentCategory(` + String.fromCharCode(39) + `Scanned bank statement front page` + String.fromCharCode(39) + `)).toBe(` + String.fromCharCode(39) + `financial_document` + String.fromCharCode(39) + `);`,
  `    expect(documentCategory(` + String.fromCharCode(39) + `Signed invoice` + String.fromCharCode(39) + `)).toBe(` + String.fromCharCode(39) + `financial_document` + String.fromCharCode(39) + `);`,
  `  });`,
  ``,
].join(LF);
const removeCount = text.split(oldBlock).length - 1;
if (removeCount !== 1) throw new Error(`expected exactly 1 misplaced block, found ${removeCount}`);
text = text.replace(oldBlock, '');

// 2) Append the corrected block at end-of-file, importing documentCategory if
//    missing.
const block = [
  ``,
  `describe(` + String.fromCharCode(39) + `My Courses localized over-masking regressions` + String.fromCharCode(39) + `, () => {`,
  `  it(` + String.fromCharCode(39) + `does not classify ordinary course-title wording as document evidence` + String.fromCharCode(39) + `, () => {`,
  `    // Runtime-proven false positive: the EIS314 alt text with the word`,
  `    // financial matched the bare label rule and masked the course thumbnail.`,
  `    // Document-style phrases still classify.`,
  `    expect(documentCategory(` + String.fromCharCode(39) + `EIS314 Financial Crime Motivations and Typologies course thumbnail` + String.fromCharCode(39) + `)).toBeUndefined();`,
  `    expect(documentCategory(` + String.fromCharCode(39) + `World Bank annual report` + String.fromCharCode(39) + `)).toBeUndefined();`,
  `    expect(documentCategory(` + String.fromCharCode(39) + `Scanned bank statement front page` + String.fromCharCode(39) + `)).toBe(` + String.fromCharCode(39) + `financial_document` + String.fromCharCode(39) + `);`,
  `    expect(documentCategory(` + String.fromCharCode(39) + `Signed invoice` + String.fromCharCode(39) + `)).toBe(` + String.fromCharCode(39) + `financial_document` + String.fromCharCode(39) + `);`,
  `  });`,
  `});`,
  ``,
].join(LF);

if (!/documentCategory/.test(text.split(LF).filter((l) => l.startsWith('import')).join(LF))) {
  const lines = text.split(LF);
  const firstImport = lines.findIndex((l) => l.startsWith('import '));
  if (firstImport < 0) throw new Error('no import lines found');
  lines.splice(firstImport, 0, `import { documentCategory } from '../src/dom/visuals';`);
  text = lines.join(LF);
}

text = text.trimEnd() + LF + block;
writeFileSync(path, text);
console.log('test block relocated');
'@

Set-Content -LiteralPath '.tmp-fix-test.mjs' -Value $js -Encoding UTF8
node .tmp-fix-test.mjs
$code = $LASTEXITCODE
Remove-Item -LiteralPath '.tmp-fix-test.mjs' -ErrorAction SilentlyContinue
if ($code -ne 0) { exit $code }
Write-Host 'OK'
