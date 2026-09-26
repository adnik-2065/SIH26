$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath (Join-Path $PSScriptRoot '.')

function Replace-Once([string]$Path, [string]$Old, [string]$New) {
  $text = [IO.File]::ReadAllText($Path)
  $count = ([regex]::Matches($text, [regex]::Escape($Old))).Count
  if ($count -ne 1) { throw "Expected exactly 1 occurrence in $Path but found $count" }
  $text = $text.Replace($Old, $New)
  [IO.File]::WriteAllText($Path, $text)
  Write-Host "patched $Path"
}

# --- Fix 1: unclassified findings must not redact pixels -------------------
# Runtime-proven false-positive engine: every DOM element label word that the
# allowlist cannot clear became an unclassified 'document' finding with
# redactPixels: true, and normalize() painted the element's full bounds black.
# On the My-Courses fixture (zero PII) that alone produced 19 text findings and
# the majority of the 26.3% black coverage (course titles, nav, footer).
$old1 = @'
redactPixels: context !== 'instruction', ...(span.unclassified ? { unclassified: true } : {}) });
'@
$new1 = (@'
// An unclassified span is a word the rules could not clear, never positive
// evidence of PII. It stays withheld from the export (placeholder text,
// redactText), but painting its region black blanked ordinary UI - course
// titles, navigation, footer links - which is the localized over-masking
// defect proven at runtime. Positively classified spans still redact pixels
// in both policies.
redactPixels: context !== 'instruction' && !span.unclassified, ...(span.unclassified ? { unclassified: true } : {}) });
'@) -replace "`n", "`r`n"
Replace-Once 'src/privacy/text.ts' $old1 $new1

# --- Fix 2: punctuation-only OCR word boxes are not text PII ---------------
# Runtime-proven: tesseract emits word boxes like '--' and '||' over thumbnail
# borders; in sensitive_only the confidence < 0.35 rule masked them. A box with
# no letter or digit carries nothing any PII rule could classify.
$old2 = @'
    if (textPolicy === 'all_text' || region.confidence < 0.35) masks.push(paddedMask(region.bounds, 'document', width, height));
'@
$new2 = (@'
    // A word box without a single letter or digit carries nothing any PII rule
    // could classify: '—' and '||' over thumbnails and borders are OCR noise,
    // and context mode keeps them visible. Strict mode still covers every
    // word, and every real word keeps the low-confidence conservative mask.
    const garbage = !/\p{L}|\p{N}/u.test(region.text);
    if (textPolicy === 'all_text' || (region.confidence < 0.35 && !garbage)) masks.push(paddedMask(region.bounds, 'document', width, height));
'@) -replace "`n", "`r`n"
Replace-Once 'src/privacy/normalize.ts' $old2 $new2

Write-Host 'OK'
