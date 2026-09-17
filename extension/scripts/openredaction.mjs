// Reproducible browser-only subset of the pinned MIT OpenRedaction catalog.
// No page/user data is processed here. Do not bundle the upstream Node loader.
import { LiteOpenRedaction } from '@openredaction/core/lite';
import ts from 'typescript';
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';

const root = dirname(createRequire(import.meta.url).resolve('@openredaction/core/lite'));
const names = ['IBAN', 'SSN', 'MAC_ADDRESS', 'GOOGLE_API_KEY', 'SLACK_TOKEN', 'DATABASE_CONNECTION'];
const patterns = new LiteOpenRedaction({ patterns: names, enableCache: false, debug: false }).getPatterns();
if (patterns.length !== names.length) throw new Error('OpenRedaction catalog changed');
const helpers = new Map();
for (const file of await readdir(root)) {
  if (!file.endsWith('.mjs')) continue;
  const source = await readFile(resolve(root, file), 'utf8');
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  for (const node of ast.statements) if (ts.isFunctionDeclaration(node) &&
    ['validateIBAN', 'mod97', 'validateSSN'].includes(node.name?.text)) helpers.set(node.name.text, node.getText(ast));
}
if (helpers.size !== 3) throw new Error('OpenRedaction validator layout changed');
const output = '// Generated from @openredaction/core 1.1.5 (MIT). See LICENSE and scripts/openredaction.mjs.\n' +
  [...helpers.values()].join('\n') + '\nexport const patterns = [\n' + patterns.map(p =>
    `{ type: ${JSON.stringify(p.type)}, regex: ${p.regex}, validator: ${p.validator?.toString() ?? 'undefined'} }`).join(',\n') + '\n];\n';
const directory = new URL('../vendor/openredaction/', import.meta.url);
await mkdir(directory, { recursive: true });
const target = new URL('patterns.js', directory);
if (process.argv.includes('--check')) {
  if (await readFile(target, 'utf8') !== output) throw new Error('Regenerate the OpenRedaction browser subset');
} else await writeFile(target, output);
