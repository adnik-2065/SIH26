$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath (Join-Path $PSScriptRoot '.')

function Append-Before([string]$Path, [string]$Anchor, [string]$Insert) {
  $text = [IO.File]::ReadAllText($Path)
  $idx = $text.IndexOf($Anchor)
  if ($idx -lt 0) { throw "anchor not found in $Path" }
  $text = $text.Substring(0, $idx) + $Insert + "`r`n" + $text.Substring($idx)
  [IO.File]::WriteAllText($Path, $text)
  Write-Host "appended regression block to $Path"
}

$anchor = "describe('Preferences and Grades UI regression'"
$insert = (@'
describe('My Courses localized over-masking regressions', () => {
  it('keeps unclassified label words off the pixels in context mode', () => {
    // Runtime-proven: "CBE311 Database Security", "Home", footer words — every
    // word the allowlist could not clear became an unclassified document
    // finding with redactPixels: true and painted the control's full bounds.
    const result = sanitizeText('CBE311 Database Security', 'element_description');
    const unclassified = result.findings.filter(finding => finding.unclassified);
    expect(unclassified.length).toBeGreaterThan(0);
    expect(unclassified.every(finding => finding.redactPixels === false)).toBe(true);
    // Still withheld from export: the placeholder text must appear.
    expect(result.sanitized).toContain('[DOCUMENT_1]');
    // Classified PII keeps pixel redaction.
    const pii = sanitizeText('email nora@example.test', 'element_description', new Placeholders());
    expect(pii.findings.filter(finding => finding.kind === 'email').every(finding => finding.redactPixels === true)).toBe(true);
  });

  it('rejects a page-scale model detection but keeps a bounded card document', () => {
    const data = fixture();
    // The proven My-Courses false positive: conf 0.846, 1237x1515 on 1268x1843.
    data.documents = { status: 'complete', required: true, observationId: data.observation.dom.observationId,
      detector: 'onnx', regions: [{ kind: 'document', category: 'identity_card', confidence: .846,
        bounds: { x: 23, y: 149, width: 1237, height: 1515 } }] };
    const pageScale = detectLocalDocuments(data.observation, data.ocr.result!, 'sensitive_only');
    expect(pageScale.regions).toHaveLength(0);
    // A genuinely bounded artefact still becomes document evidence.
    data.documents = { status: 'complete', required: true, observationId: data.observation.dom.observationId,
      detector: 'onnx', regions: [{ kind: 'document', category: 'identity_card', confidence: .8,
        bounds: { x: 60, y: 700, width: 480, height: 300 } }] };
    expect(detectLocalDocuments(data.observation, data.ocr.result!, 'sensitive_only').regions).toHaveLength(1);
  });

  it('keeps ordinary UI text visible while a classified value still masks in context mode', () => {
    const data = fixture();
    const plan = normalize(data, new Placeholders());
    // Whatever else the fixture carries, the unclassified prose must not paint.
    expect(plan.findings.filter(finding => finding.unclassified).every(finding => finding.redactPixels === false)).toBe(true);
    const maskedText = plan.findings.filter(finding => finding.redactPixels && finding.bounds);
    expect(maskedText.length).toBeGreaterThan(0);
  });
});

'@) -replace "`n", "`r`n"

$anchor = "describe('Preferences and Grades UI regression'"

Append-Before 'tests/unit/repair-regressions.test.ts' $anchor $insert

Write-Host 'OK'
