$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath (Join-Path $PSScriptRoot '.')
node --input-type=module -e @'
import { readFileSync, writeFileSync } from 'node:fs';
const path = 'src/vision/documents.ts';
const text = readFileSync(path, 'utf8');
const LF = String.fromCharCode(10);
const oldStr = `        const existing = regions.find(region => region.category === detection.type && intersection(region.bounds, pageBox));
        if (existing) existing.bounds = union(existing.bounds, pageBox);
        else regions.push({ kind: kind(detection.type), category: detection.type, confidence: detection.confidence, bounds: pageBox });`;
const newStr = `        const existing = regions.find(region => region.category === detection.type && intersection(region.bounds, pageBox));
        if (existing) existing.bounds = union(existing.bounds, pageBox);
        else regions.push({ kind: kind(detection.type), category: detection.type, confidence: detection.confidence, bounds: pageBox });
        // eslint-disable-next-line no-console -- temporary runtime provenance diagnostic
        console.log('[DOC-PROBE] accepted', JSON.stringify({ category: detection.type, confidence: detection.confidence, pageBox, tile: { y: tile.y, width: tile.width, height: tile.height } }));`;
const count = text.split(oldStr).length - 1;
if (count !== 1) throw new Error(`expected 1 occurrence, found ${count}`);
writeFileSync(path, text.replace(oldStr, newStr));
console.log('instrumented accept');
'@
Write-Host 'OK'
