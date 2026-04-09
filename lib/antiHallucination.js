'use strict';

const VERDICTS = ['CONFIRMED', 'PROBABLE', 'UNCERTAIN', 'NON-VERIFIED', 'FALSE'];
const STRICT_AUDIT_INTENTS = new Set(['audit', 'security', 'review']);
const REQUEST_INTENT_PRIORITY = ['security', 'audit', 'review', 'architecture', 'feature', 'configuration'];
const ABSOLUTE_CLAIM_PATTERNS = [
  /\bproduction-ready\b/i,
  /\bsecure\b/i,
  /\bsecur(?:e|ise|isee|isé|isee)\b/i,
  /\bscalable\b/i,
  /\brobust\b/i,
  /\brobuste\b/i,
  /\bcomplete\b/i,
  /\bcomplet\b/i,
  /\bfinished\b/i,
  /\bfini\b/i
];
const JUSTIFICATION_PATTERN = /\b(?:because|justified|justification|evidence|proof|preuve|supported by|based on)\b/i;
const INTENT_PATTERNS = {
  security: [
    /\bsecurity audit\b/i,
    /\baudit s[eé]curit[eé]\b/i,
    /\bsecurity review\b/i,
    /\brevue s[eé]curit[eé]\b/i,
    /\bvuln(?:erability|[eé]rabilit[ée])?\b/i,
    /\bxss\b/i,
    /\bcsrf\b/i,
    /\bssrf\b/i,
    /\bsql injection\b/i,
    /\bpath traversal\b/i,
    /\bauth(?:entication|entification|orization|orisation)\b/i,
    /\bsecrets?\b/i
  ],
  audit: [
    /\baudit\b/i,
    /\banaly[sz]e the project\b/i,
    /\banalyse (?:le )?projet\b/i,
    /\banalyse compl[eè]te\b/i,
    /\breview the project\b/i,
    /\banti-hallucination\b/i,
    /\bhallucinat(?:ion|e|es|ing)?\b/i
  ],
  review: [
    /\bcode review\b/i,
    /\breview this code\b/i,
    /\brevue de code\b/i,
    /\brelis ce code\b/i,
    /\binspect this code\b/i,
    /\breview du code\b/i
  ],
  architecture: [
    /\barchitecture\b/i,
    /\brefactor architecture\b/i,
    /\bpropose une architecture\b/i,
    /\bstructure du projet\b/i,
    /\borganis(?:e|er) le projet\b/i,
    /\bdesign the architecture\b/i
  ],
  feature: [
    /\bcreate a feature\b/i,
    /\bcr[eé]e une fonctionnalit[eé]\b/i,
    /\bajoute une fonctionnalit[eé]\b/i,
    /\bimpl[eé]mente une fonctionnalit[eé]\b/i,
    /\bnew feature\b/i,
    /\bnouvelle feature\b/i,
    /\bimplement this feature\b/i
  ],
  configuration: [
    /\bconfiguration\b/i,
    /\bconfig\b/i,
    /\br[eè]glages?\b/i,
    /\bsettings?\b/i,
    /\bparam[eè]tres?\b/i,
    /\bmodel id\b/i,
    /\bbase url\b/i,
    /\btoken\b/i
  ]
};

function cloneMessages(messages) {
  return Array.isArray(messages)
    ? messages.map(message => (message && typeof message === 'object' ? { ...message } : message))
    : [];
}

function normalizeWhitespace(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function shouldEnableStrictAudit(intent) {
  return STRICT_AUDIT_INTENTS.has(String(intent || '').trim());
}

function countIntentMatches(value, patterns) {
  return patterns.reduce((total, pattern) => total + (pattern.test(value) ? 1 : 0), 0);
}

function classifyRequestIntent(text) {
  const value = String(text || '').trim().toLowerCase();
  if (!value) return '';

  const scores = {};
  for (const [intent, patterns] of Object.entries(INTENT_PATTERNS)) {
    const count = countIntentMatches(value, patterns);
    if (count > 0) scores[intent] = count;
  }
  const ranked = REQUEST_INTENT_PRIORITY.filter(intent => scores[intent]).sort((a, b) => {
    const diff = scores[b] - scores[a];
    if (diff !== 0) return diff;
    return REQUEST_INTENT_PRIORITY.indexOf(a) - REQUEST_INTENT_PRIORITY.indexOf(b);
  });
  return ranked[0] || '';
}

function buildIntentFormatInstructions(intent, options = {}) {
  const strictAuditMode = options.strictAuditMode !== false && shouldEnableStrictAudit(intent);
  switch (intent) {
    case 'audit':
      return [
        'For this request, use this response order:',
        '- Short summary',
        '- Table of important points using: Affirmation / Verdict / Evidence / Critical comment',
        '- What is only partially confirmed',
        '- What is not proven or false',
        '- Real risks',
        '- Prioritized recommendations',
        '- Confidence level',
        strictAuditMode ? 'Do not skip explicit verdicts or evidence for important claims.' : 'Tie important conclusions to exact evidence when available.'
      ].join('\n');
    case 'security':
      return [
        'For this request, use this response order:',
        '- Exposed surface',
        '- Risk',
        '- Severity',
        '- Evidence',
        '- Impact',
        '- Recommended fix',
        '- Confidence level',
        'Separate confirmed vulnerabilities from plausible risks and unverified hypotheses.'
      ].join('\n');
    case 'feature':
      return [
        'For this request, use this response order:',
        '- Request understanding',
        '- Project constraints',
        '- Existing reusable code',
        '- Minimal correct proposal',
        '- Regression risks',
        '- Files to change',
        '- Implementation',
        '- Validation',
        'Start from the existing architecture and avoid duplicate modules or unnecessary abstractions.'
      ].join('\n');
    case 'architecture':
      return [
        'For this request, use this response order:',
        '- Current state',
        '- Constraints',
        '- Existing reusable pieces',
        '- Realistic target architecture',
        '- Incremental plan',
        '- Risks',
        '- Validation',
        'Distinguish ideal target from realistic short-term target.'
      ].join('\n');
    case 'review':
      return [
        'For this request, use this response order:',
        '- Short summary',
        '- Confirmed findings ordered by severity',
        '- Plausible but unproven risks',
        '- Regressions to test',
        '- Confidence level',
        'Do not pad the response with praise. Prioritize concrete bugs, regressions, and missing tests.'
      ].join('\n');
    case 'configuration':
      return [
        'For this request, use this response order:',
        '- Current configuration',
        '- What is configured but not proven active',
        '- What is runtime-validated',
        '- Risks or mismatches',
        '- Recommended changes',
        '- Validation steps',
        'Distinguish configured, enabled, runtime-validated, and production-confirmed states.'
      ].join('\n');
    default:
      return '';
  }
}

function upsertTaggedSystemMessage(messages, tag, content) {
  const nextMessages = cloneMessages(messages);
  const marker = `[${tag}]`;
  const taggedContent = `${marker}\n${content}`;
  const existingIndex = nextMessages.findIndex(
    message => message && message.role === 'system' && String(message.content || '').startsWith(marker)
  );
  if (!content) {
    if (existingIndex !== -1) nextMessages.splice(existingIndex, 1);
    return nextMessages;
  }
  const systemMessage = { role: 'system', content: taggedContent };
  if (existingIndex === -1) {
    const firstNonSystemIndex = nextMessages.findIndex(message => !message || message.role !== 'system');
    if (firstNonSystemIndex === -1) nextMessages.push(systemMessage);
    else nextMessages.splice(firstNonSystemIndex, 0, systemMessage);
  } else {
    nextMessages[existingIndex] = systemMessage;
  }
  return nextMessages;
}

function collectAvailableEvidence(messages, contextMeta = null) {
  const filePaths = new Set();
  const functionNames = new Set();
  const commands = new Set();
  const logs = new Set();
  let documentationMentions = 0;
  let codeBlocks = 0;

  for (const message of Array.isArray(messages) ? messages : []) {
    const content = String((message && message.content) || '');
    if (!content) continue;

    const pathMatches = content.match(/\b(?:[A-Za-z]:\\[^\s"'`]+|(?:\.{0,2}[\\/])?[\w.-]+(?:[\\/][\w.-]+)+\.\w+)\b/g) || [];
    for (const match of pathMatches.slice(0, 8)) filePaths.add(match);

    const functionRegex = /\bfunction\s+([A-Za-z_]\w*)\s*\(/g;
    let functionMatch;
    while ((functionMatch = functionRegex.exec(content))) {
      functionNames.add(functionMatch[1]);
      if (functionNames.size >= 6) break;
    }

    const commandMatches = content.match(/(?:^|\n)(?:PS>|>|[$#])\s*[^\n]+/g) || [];
    for (const match of commandMatches.slice(0, 4)) commands.add(normalizeWhitespace(match));

    const logMatches = content.match(/\[[^\]\n]{2,80}\]|(?:^|\n)(?:PASS|FAIL|WARN|ERROR|INFO)\b[^\n]*/gi) || [];
    for (const match of logMatches.slice(0, 4)) logs.add(normalizeWhitespace(match));

    documentationMentions += (content.match(/\b(?:README|docs?|documentation|AGENTS\.md)\b/gi) || []).length;
    codeBlocks += (content.match(/```/g) || []).length / 2;
  }

  const directEvidence = [];
  if (filePaths.size) directEvidence.push(`Files: ${[...filePaths].slice(0, 4).join(', ')}`);
  if (functionNames.size) directEvidence.push(`Functions: ${[...functionNames].slice(0, 4).join(', ')}`);
  if (codeBlocks > 0) directEvidence.push(`Code excerpts: ${Math.max(1, Math.floor(codeBlocks))}`);

  const runtimeEvidence = [];
  if (commands.size) runtimeEvidence.push(`Commands seen: ${[...commands].slice(0, 2).join(' | ')}`);
  if (logs.size) runtimeEvidence.push(`Logs/tests seen: ${[...logs].slice(0, 2).join(' | ')}`);

  const indirectEvidence = [];
  if (contextMeta && Number.isFinite(Number(contextMeta.recentMessages))) {
    indirectEvidence.push(`Recent turns: ${Number(contextMeta.recentMessages)}`);
  }
  if (contextMeta && Number.isFinite(Number(contextMeta.ragSnippets))) {
    indirectEvidence.push(`RAG snippets: ${Number(contextMeta.ragSnippets)}`);
  }
  if (contextMeta && contextMeta.summaryAvailable) {
    indirectEvidence.push('Chat summary available');
  }

  const documentationOnly = documentationMentions > 0
    ? [`Documentation mentions: ${documentationMentions}`]
    : [];

  const promptSummary = [
    'Available evidence for this request:',
    directEvidence.length ? `- Direct evidence: ${directEvidence.join('; ')}` : '- Direct evidence: none extracted from the current context.',
    runtimeEvidence.length ? `- Runtime evidence: ${runtimeEvidence.join('; ')}` : '- Runtime evidence: not validated from commands/logs/tests in this request.',
    indirectEvidence.length ? `- Indirect evidence: ${indirectEvidence.join('; ')}` : '- Indirect evidence: no additional context metadata extracted.',
    documentationOnly.length ? `- Documentation-only indicators: ${documentationOnly.join('; ')}` : '- Documentation-only indicators: none detected.'
  ].join('\n');

  return {
    directEvidence,
    runtimeEvidence,
    indirectEvidence,
    documentationOnly,
    promptSummary
  };
}

function buildStrictAuditModeInstructions(intent, evidenceSummary) {
  const normalizedIntent = String(intent || '').trim() || 'general';
  return [
    'Strict audit mode is active for this request.',
    `Detected intent: ${normalizedIntent}.`,
    'Do not conclude an important point without an explicit verdict and evidence.',
    `Use the exact verdict vocabulary: ${VERDICTS.join(', ')}.`,
    'If evidence is missing, explicitly downgrade the point and say that it cannot be confirmed with the available evidence.',
    'Do not present documentation alone as proof of implementation or runtime behavior.',
    evidenceSummary || 'Available evidence summary is limited for this request.'
  ].join('\n');
}

function injectIntentFormatInstructions(messages, userText, options = {}) {
  const intent = classifyRequestIntent(userText);
  const strictAuditMode = options.strictAuditMode === true || shouldEnableStrictAudit(intent);
  const evidence = collectAvailableEvidence(messages, options.contextMeta || null);
  let nextMessages = cloneMessages(messages);

  const instructions = buildIntentFormatInstructions(intent, { strictAuditMode });
  nextMessages = upsertTaggedSystemMessage(nextMessages, 'INTENT-FORMAT', instructions);

  if (intent || strictAuditMode) {
    nextMessages = upsertTaggedSystemMessage(nextMessages, 'EVIDENCE-SUMMARY', evidence.promptSummary);
  } else {
    nextMessages = upsertTaggedSystemMessage(nextMessages, 'EVIDENCE-SUMMARY', '');
  }

  if (strictAuditMode) {
    nextMessages = upsertTaggedSystemMessage(
      nextMessages,
      'STRICT-AUDIT',
      buildStrictAuditModeInstructions(intent, evidence.promptSummary)
    );
  } else {
    nextMessages = upsertTaggedSystemMessage(nextMessages, 'STRICT-AUDIT', '');
  }

  return {
    messages: nextMessages,
    intent,
    strictAuditMode,
    evidenceSummary: evidence.promptSummary,
    evidence
  };
}

function validateAssistantResponse(text, options = {}) {
  const content = String(text || '').trim();
  const intent = String(options.intent || '').trim();
  const strictAuditMode = Boolean(options.strictAuditMode);
  const issues = [];

  if (!content) {
    issues.push('Assistant response is empty.');
  }

  const hasVerdict = /\bVerdict\s*:|\b(CONFIRMED|PROBABLE|UNCERTAIN|NON-VERIFIED|FALSE)\b/i.test(content);
  const hasEvidence = /\b(?:Evidence|Preuve)\s*:|\b(?:file|fichier|function|line|command|log|test|trace|snippet)\b/i.test(content) || /`[^`]+`/.test(content);
  const explicitUncertainty = /I cannot confirm this point with the available evidence\.|Je ne peux pas confirmer ce point/i.test(content);

  if (strictAuditMode && !hasVerdict) {
    issues.push('Missing explicit verdict classification for a strict audit response.');
  }
  if (strictAuditMode && !hasEvidence && !explicitUncertainty) {
    issues.push('Missing explicit evidence reference for a strict audit response.');
  }

  if (intent === 'security') {
    if (!/\bRisk\b|\bRisque\b/i.test(content)) issues.push('Security response is missing a risk section.');
    if (!/\bSeverity\b|\bS[ée]v[ée]rit[ée]\b/i.test(content)) issues.push('Security response is missing a severity section.');
    if (!/\bEvidence\b|\bPreuve\b/i.test(content) && !explicitUncertainty) issues.push('Security response is missing an evidence section.');
  }

  if ((intent === 'feature' || intent === 'architecture') && !/\b(existing|existant|reuse|r[eé]util|hypoth[eè]s|assumption|constraint|contrainte)\b/i.test(content)) {
    issues.push('Feature or architecture response does not clearly mention existing code, constraints, or assumptions.');
  }

  if (/\b(?:README|docs?|documentation)\b/i.test(content) && /\b(?:implemented|implements|proves|works|fonctionne|impl[eé]ment[ée])\b/i.test(content) && !hasEvidence) {
    issues.push('Documentation appears to be presented as implementation proof without evidence.');
  }

  const absoluteClaims = ABSOLUTE_CLAIM_PATTERNS.filter(pattern => pattern.test(content));
  if (absoluteClaims.length && !JUSTIFICATION_PATTERN.test(content)) {
    issues.push('Contains absolute quality or security claims without explicit justification.');
  }

  const status = issues.length
    ? (strictAuditMode ? 'warning' : 'advisory')
    : 'passed';

  return {
    status,
    issues,
    hasVerdict,
    hasEvidence,
    explicitUncertainty
  };
}

function buildValidationNotice(validation) {
  if (!validation || !Array.isArray(validation.issues) || !validation.issues.length) return '';
  return [
    'Post-validation notice:',
    ...validation.issues.map(issue => `- ${issue}`),
    '- Treat any unsupported conclusion above as NON-VERIFIED until direct evidence is provided.'
  ].join('\n');
}

function postValidateAssistantResponse(text, options = {}) {
  const validation = validateAssistantResponse(text, options);
  if (validation.status === 'passed') {
    return {
      text: String(text || ''),
      validation
    };
  }

  const strictAuditMode = Boolean(options.strictAuditMode);
  const notice = buildValidationNotice(validation);
  const nextText = strictAuditMode && notice
    ? `${String(text || '').trim()}\n\n${notice}`.trim()
    : String(text || '');

  return {
    text: nextText,
    validation
  };
}

function buildResponseMeta(intentContext = {}, validation = {}, extras = {}) {
  return {
    intent: intentContext.intent || '',
    strictAuditMode: Boolean(intentContext.strictAuditMode),
    postValidationStatus: validation.status || 'pending',
    postValidationIssues: Array.isArray(validation.issues) ? validation.issues : [],
    evidenceSummary: intentContext.evidenceSummary || '',
    updatedAt: new Date().toISOString(),
    ...extras
  };
}

module.exports = {
  VERDICTS,
  REQUEST_INTENT_PRIORITY,
  STRICT_AUDIT_INTENTS,
  shouldEnableStrictAudit,
  classifyRequestIntent,
  buildIntentFormatInstructions,
  injectIntentFormatInstructions,
  validateAssistantResponse,
  postValidateAssistantResponse,
  buildResponseMeta
};
