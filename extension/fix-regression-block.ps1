$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath (Join-Path $PSScriptRoot '.')
node --input-type=module -e @'
import { readFileSync, writeFileSync } from 'node:fs';
const path = 'tests/unit/repair-regressions.test.ts';
let text = readFileSync(path, 'utf8');
const LF = String.fromCharCode(10);
const oldStr = `    // A genuinely bounded artefact still becomes document evidence.${LF}    data.documents = { status: 'complete', required: true, observationId: data.observation.dom.observationId,${LF}      detector: 'onnx', regions: [{ kind: 'document', category: 'identity_card', confidence: .8,${LF}        bounds: { x: 60, y: 700, width: 480, height: 300 } }] };${LF}    expect(detectLocalDocuments(data.observation, data.ocr.result!, 'sensitive_only').regions).toHaveLength(1);`;
const newStr = `    // A genuinely bounded artefact still becomes document evidence: the model${LF}    // path merges it in exactly as review.tsx does.${LF}    const merged = mergeDocumentEvidence(detectLocalDocuments(data.observation, data.ocr.result!, 'sensitive_only'),${LF}      { status: 'complete', required: true, observationId: data.observation.dom.observationId,${LF}        regions: [{ kind: 'document', category: 'identity_card', confidence: .8,${LF}          bounds: { x: 60, y: 700, width: 480, height: 300 } }] });${LF}    expect(merged.regions).toHaveLength(1);`;
const count = text.split(oldStr).length - 1;
if (count !== 1) throw new Error(`expected 1 occurrence, found ${count}`);
writeFileSync(path, text.replace(oldStr, newStr));
console.log('patched block');
'@
Write-Host 'OK'
