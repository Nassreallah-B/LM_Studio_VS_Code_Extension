'use strict';

/**
 * Tests unitaires pour lib/antiHallucination.js — LocalAI Code
 * Run: node test/antiHallucination.test.js
 */

const path = require('path');

const libPath = path.join(__dirname, '..', 'lib', 'antiHallucination.js');
let antiHallucination;
try {
  antiHallucination = require(libPath);
} catch (e) {
  console.error('Cannot load antiHallucination.js:', e.message);
  process.exit(1);
}

let passed = 0;
let failed = 0;
const results = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    results.push({ name, status: 'PASS' });
  } catch (err) {
    failed++;
    results.push({ name, status: 'FAIL', error: err.message });
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message || 'Assertion failed');
}

function assertContains(str, substr, message) {
  if (!String(str || '').includes(substr)) {
    throw new Error(message || `Expected "${str}" to contain "${substr}"`);
  }
}

function assertNoThrow(fn) {
  try { fn(); } catch (e) { throw new Error(`Expected no throw but got: ${e.message}`); }
}

test('Module loads without throwing', () => {
  assert(typeof antiHallucination === 'object' || typeof antiHallucination === 'function');
});

test('Exports validation function', () => {
  const hasValidate = typeof antiHallucination.postValidateAssistantResponse === 'function'
    || typeof antiHallucination.validateResponse === 'function';
  assert(hasValidate, 'Expected at least one validation function');
});

test('Valid response passes through unchanged', () => {
  const fn = antiHallucination.postValidateAssistantResponse
    || antiHallucination.validateResponse;
  if (!fn) return;
  const validText = 'Here is the implementation:\n```javascript\nconst router = express.Router();\n```';
  const result = fn(validText, {});
  assert(result && typeof result.text === 'string');
  assertContains(result.text, 'express.Router');
});

test('Empty response handled gracefully', () => {
  const fn = antiHallucination.postValidateAssistantResponse
    || antiHallucination.validateResponse;
  if (!fn) return;
  assertNoThrow(() => fn('', {}));
  assertNoThrow(() => fn(null, {}));
});

test('Dangerous commands are processed', () => {
  const fn = antiHallucination.postValidateAssistantResponse
    || antiHallucination.validateResponse;
  if (!fn) return;
  const result = fn('sudo rm -rf /* will fix your problem', {});
  assert(result && typeof result.text === 'string');
});

test('Code blocks preserved', () => {
  const fn = antiHallucination.postValidateAssistantResponse
    || antiHallucination.validateResponse;
  if (!fn) return;
  const result = fn('```ts\nconst x: number = 42;\n```', {});
  assertContains(result.text, 'const x');
});

test('localai tool tags stripped from visible text', () => {
  const fn = antiHallucination.sanitizeAgentVisibleText;
  if (!fn) return;
  const withTag = 'Text <localai-tool name="read_file">{"path":"x"}</localai-tool> end';
  const result = fn(withTag);
  assert(typeof result === 'string');
  assert(!result.includes('<localai-tool'), 'Tool tags should be stripped');
});

test('Null context does not throw', () => {
  const fn = antiHallucination.postValidateAssistantResponse
    || antiHallucination.validateResponse;
  if (!fn) return;
  assertNoThrow(() => fn('Test', null));
  assertNoThrow(() => fn('Test', undefined));
});

console.log('\n=== Anti-Hallucination Test Results (LocalAI Code) ===\n');
for (const r of results) {
  const icon = r.status === 'PASS' ? '✅' : '❌';
  console.log(`${icon} ${r.name}`);
  if (r.error) console.log(`   Error: ${r.error}`);
}
console.log(`\nTotal: ${passed + failed} | Passed: ${passed} | Failed: ${failed}\n`);
if (failed > 0) process.exit(1);
