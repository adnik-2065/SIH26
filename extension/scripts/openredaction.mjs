// Reproducible browser-only subset of the pinned MIT OpenRedaction catalog.
// No page/user data is processed here. Do not bundle the upstream Node loader.
import { LiteOpenRedaction } from '@openredaction/core/lite';
import ts from 'typescript';
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';

const root = dirname(createRequire(import.meta.url).resolve('@openredaction/core/lite'));
// Curated for the SIH26 privacy pipeline: identity documents, contact data,
// payment instruments and credentials. Pattern-level iteration with validators
// is the detection contract (see src/privacy/openredaction.ts); the full
// runtime detect() is intentionally NOT bundled.
const names = [
  'NAME', 'EMAIL', 'PHONE_INTERNATIONAL', 'PHONE_US', 'PHONE_UK', 'PHONE_UK_MOBILE',
  'INDIAN_AADHAAR', 'IFSC', 'CREDIT_CARD', 'IBAN', 'SSN',
  'GOOGLE_API_KEY', 'OPENAI_API_KEY', 'GENERIC_API_KEY', 'GENERIC_SECRET',
  'AWS_ACCESS_KEY', 'GITHUB_TOKEN', 'JWT_TOKEN', 'BEARER_TOKEN', 'PRIVATE_KEY',
  'URL_WITH_AUTH', 'DATABASE_CONNECTION', 'SLACK_TOKEN', 'DOCKER_AUTH',
  'KUBERNETES_SECRET', 'NPM_TOKEN', 'PYPI_TOKEN', 'OAUTH_TOKEN', 'OAUTH_CLIENT_SECRET',
  'FIREBASE_API_KEY', 'HEROKU_API_KEY', 'MAILGUN_API_KEY', 'SENDGRID_API_KEY',
  'STRIPE_API_KEY', 'TWILIO_API_KEY', 'GCP_SERVICE_ACCOUNT',
  'PASSPORT_UK', 'PASSPORT_US', 'PASSPORT_MRZ_TD3', 'TURKMENISTAN_PASSPORT',
  'ADDRESS_STREET', 'DATE_OF_BIRTH', 'CVV', 'CARD_EXPIRY',
  'ENROLLMENT_NUMBER', 'STUDENT_ID', 'UNIVERSITY_ID', 'MAC_ADDRESS',
];
const patterns = new LiteOpenRedaction({ patterns: names, enableCache: false, debug: false }).getPatterns();
if (patterns.length !== names.length) throw new Error('OpenRedaction catalog changed');
// Validators, plus the engine's own post-validator stages: the false-positive
// filter (isFalsePositive over commonFalsePositives) and context confidence
// scoring (analyzeFullContext and the helpers it calls).
const helperNames = ['validateIBAN', 'mod97', 'validateSSN', 'validateEmail', 'validateLuhn', 'validateUKPassport', 'validateName',
  'extractContext', 'extractSentence', 'findSentenceStart', 'findSentenceEnd', 'inferDocumentType', 'analyzeContextFeatures',
  'calculateContextConfidence', 'analyzeFullContext', 'commonFalsePositives', 'isFalsePositive'];
const helpers = new Map();
for (const file of await readdir(root)) {
  if (!file.endsWith('.mjs')) continue;
  const source = await readFile(resolve(root, file), 'utf8');
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  for (const node of ast.statements) {
    const name = ts.isFunctionDeclaration(node) ? node.name?.text
      : ts.isVariableStatement(node) && node.declarationList.declarations.length === 1 ? node.declarationList.declarations[0].name.getText(ast) : undefined;
    if (helperNames.includes(name)) helpers.set(name, node.getText(ast));
  }
}
if (helpers.size !== helperNames.length) throw new Error('OpenRedaction helper layout changed: ' + [...helpers.keys()].join(','));
const output = '// Generated from ' + '@openredaction/core 1.1.5 (MIT). See LICENSE and scripts/openredaction.mjs.\n' +
  [...helpers.values()].join('\n') + '\nexport { analyzeFullContext, commonFalsePositives, isFalsePositive };\nexport const patterns = [\n' + patterns.map(p =>
    '{ type: ' + JSON.stringify(p.type) + ', regex: ' + p.regex + ', validator: ' + (p.validator?.toString() ?? 'undefined') + ' }').join(',\n') + '\n];\n';
const directory = new URL('../vendor/openredaction/', import.meta.url);
await mkdir(directory, { recursive: true });
const target = new URL('patterns.js', directory);
if (process.argv.includes('--check')) {
  if (await readFile(target, 'utf8') !== output) throw new Error('Regenerate the OpenRedaction browser subset');
} else await writeFile(target, output);