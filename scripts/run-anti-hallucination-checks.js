'use strict';
const assert = require('assert');
const anti = require('../lib/antiHallucination');

const auditIntent = anti.classifyRequestIntent('fais un audit complet et anti-hallucination du projet');
assert.strictEqual(auditIntent, 'audit');

const securityIntent = anti.classifyRequestIntent('security review for auth, xss and csrf');
assert.strictEqual(securityIntent, 'security');

const featureIntent = anti.classifyRequestIntent('create a feature for fork chat');
assert.strictEqual(featureIntent, 'feature');

const architectureIntent = anti.classifyRequestIntent('propose une architecture réaliste du projet');
assert.strictEqual(architectureIntent, 'architecture');

const intentContext = anti.injectIntentFormatInstructions([{ role: 'system', content: 'See src/index.js and function runTask()' }], 'fais un audit complet', {
  contextMeta: { recentMessages: 3, ragSnippets: 2, summaryAvailable: true }
});
assert.strictEqual(intentContext.intent, 'audit');
assert.strictEqual(intentContext.strictAuditMode, true);
assert(intentContext.evidenceSummary.includes('Available evidence'));

const passing = anti.postValidateAssistantResponse('Affirmation: X\nVerdict: CONFIRMED\nEvidence: src/index.js\nCritical comment: ok', {
  intent: 'audit',
  strictAuditMode: true
});
assert.strictEqual(passing.validation.status, 'passed');

const failing = anti.postValidateAssistantResponse('This is production-ready and secure.', {
  intent: 'security',
  strictAuditMode: true
});
assert.notStrictEqual(failing.validation.status, 'passed');
assert(failing.text.includes('Post-validation notice:'));

console.log('anti-hallucination checks passed');

