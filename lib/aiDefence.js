'use strict';

// ── AI Defence Module ────────────────────────────────────────────────────────
// Inspired by Ruflo's AIDefence: prompt injection detection, PII scanning,
// secret detection, and CVE-aware dependency checking.

// ── Prompt Injection Detection ───────────────────────────────────────────────
const INJECTION_PATTERNS = [
  // Direct instruction override attempts
  /ignore\s+(all\s+)?previous\s+instructions/i,
  /ignore\s+(all\s+)?above\s+instructions/i,
  /disregard\s+(all\s+)?previous/i,
  /forget\s+(all\s+)?(your\s+)?instructions/i,
  /override\s+(your\s+)?(system\s+)?prompt/i,
  /new\s+instructions?\s*:/i,
  /you\s+are\s+now\s+(?:a\s+)?(?:different|new|my)/i,
  // Jailbreak patterns
  /\bDAN\s+mode\b/i,
  /\bdev(?:eloper)?\s+mode\b/i,
  /\bjailbreak\b/i,
  /\bbypass\s+(?:your\s+)?(?:safety|filter|restriction)/i,
  // Command injection via content
  /system\s*\(\s*['"`]/i,
  /exec\s*\(\s*['"`]/i,
  /eval\s*\(\s*['"`].*(?:rm\s+-rf|del\s+\/|format\s+c|shutdown)/i,
  // Social engineering
  /pretend\s+(?:you\s+)?(?:are|to\s+be)\s+(?:a\s+)?(?:unrestricted|unfiltered)/i,
  /act\s+as\s+(?:if\s+)?(?:you\s+)?(?:have\s+)?no\s+(?:restrictions|limitations|rules)/i,
  /\bno\s+ethical\s+(?:guidelines|restrictions|boundaries)\b/i
];

const INJECTION_IN_CODE_PATTERNS = [
  // Injection hidden in code comments
  /\/\/\s*(?:TODO|NOTE|HACK):\s*(?:the\s+)?(?:AI|assistant|model)\s+(?:should|must|will)\s+now/i,
  /\/\*\s*(?:instruction|prompt):/i,
  /#\s*(?:instruction|prompt)\s*:/i,
  // Hidden in strings
  /['"`](?:ignore|override|forget)\s+(?:all\s+)?(?:previous|system)\s+(?:instructions|prompt|rules)['"`]/i
];

function detectPromptInjection(text) {
  const content = String(text || '');
  const findings = [];

  for (const pattern of INJECTION_PATTERNS) {
    const match = content.match(pattern);
    if (match) {
      findings.push({
        type: 'prompt_injection',
        severity: 'high',
        pattern: pattern.source,
        match: match[0],
        index: match.index
      });
    }
  }

  for (const pattern of INJECTION_IN_CODE_PATTERNS) {
    const match = content.match(pattern);
    if (match) {
      findings.push({
        type: 'code_injection',
        severity: 'medium',
        pattern: pattern.source,
        match: match[0],
        index: match.index
      });
    }
  }

  return {
    safe: findings.length === 0,
    findings,
    blocked: findings.some(f => f.severity === 'high')
  };
}

// ── PII Detection ────────────────────────────────────────────────────────────
const PII_PATTERNS = [
  { type: 'email', pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g, severity: 'medium' },
  { type: 'phone_international', pattern: /\+?\d{1,4}[\s.-]?\(?\d{1,3}\)?[\s.-]?\d{3,4}[\s.-]?\d{3,4}\b/g, severity: 'medium' },
  { type: 'credit_card', pattern: /\b(?:4[0-9]{12}(?:[0-9]{3})?|5[1-5][0-9]{14}|3[47][0-9]{13}|6(?:011|5[0-9]{2})[0-9]{12})\b/g, severity: 'high' },
  { type: 'ssn_us', pattern: /\b\d{3}-\d{2}-\d{4}\b/g, severity: 'high' },
  { type: 'ip_address', pattern: /\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\b/g, severity: 'low' },
  { type: 'aws_key', pattern: /\b(?:AKIA|ABIA|ACCA|ASIA)[0-9A-Z]{16}\b/g, severity: 'critical' },
  { type: 'private_key', pattern: /-----BEGIN\s+(?:RSA\s+)?PRIVATE\s+KEY-----/g, severity: 'critical' },
  { type: 'jwt_token', pattern: /\beyJ[A-Za-z0-9-_]+\.eyJ[A-Za-z0-9-_]+\.[A-Za-z0-9-_.+/=]+\b/g, severity: 'high' }
];

function scanForPII(text) {
  const content = String(text || '');
  const findings = [];

  for (const { type, pattern, severity } of PII_PATTERNS) {
    const regex = new RegExp(pattern.source, pattern.flags);
    let match;
    while ((match = regex.exec(content)) !== null) {
      findings.push({
        type,
        severity,
        match: match[0].length > 20 ? `${match[0].slice(0, 10)}...${match[0].slice(-5)}` : match[0],
        index: match.index
      });
    }
  }

  return {
    clean: findings.length === 0,
    findings,
    hasCritical: findings.some(f => f.severity === 'critical'),
    hasHigh: findings.some(f => f.severity === 'high')
  };
}

function redactPII(text) {
  let result = String(text || '');
  for (const { type, pattern } of PII_PATTERNS) {
    const regex = new RegExp(pattern.source, pattern.flags);
    result = result.replace(regex, `[REDACTED:${type}]`);
  }
  return result;
}

// ── Secret Detection ─────────────────────────────────────────────────────────
const SECRET_PATTERNS = [
  { type: 'generic_api_key', pattern: /(?:api[_-]?key|apikey)\s*[:=]\s*['"`]([^'"`\s]{10,})['"`]/gi },
  { type: 'generic_secret', pattern: /(?:secret|password|passwd|pwd)\s*[:=]\s*['"`]([^'"`\s]{6,})['"`]/gi },
  { type: 'generic_token', pattern: /(?:token|auth_token|access_token|bearer)\s*[:=]\s*['"`]([^'"`\s]{10,})['"`]/gi },
  { type: 'connection_string', pattern: /(?:mongodb|postgres|mysql|redis):\/\/[^'"`\s]{10,}/gi },
  { type: 'aws_secret', pattern: /(?:aws_secret_access_key|AWS_SECRET_ACCESS_KEY)\s*[:=]\s*['"`]?([A-Za-z0-9/+=]{40})['"`]?/g },
  { type: 'stripe_key', pattern: /\b(?:sk|pk)_(?:live|test)_[A-Za-z0-9]{20,}\b/g },
  { type: 'github_token', pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b/g },
  { type: 'supabase_key', pattern: /\beyJ[A-Za-z0-9-_]{50,}\.[A-Za-z0-9-_]{50,}\.[A-Za-z0-9-_]{20,}\b/g },
  { type: 'hf_token', pattern: /\bhf_[A-Za-z0-9]{30,}\b/g }
];

function scanForSecrets(text) {
  const content = String(text || '');
  const findings = [];

  for (const { type, pattern } of SECRET_PATTERNS) {
    const regex = new RegExp(pattern.source, pattern.flags);
    let match;
    while ((match = regex.exec(content)) !== null) {
      findings.push({
        type,
        severity: 'critical',
        match: `${match[0].slice(0, 8)}...`,
        index: match.index
      });
    }
  }

  return {
    clean: findings.length === 0,
    findings
  };
}

// ── Shell Command Policy ─────────────────────────────────────────────────────
const DANGEROUS_SHELL_PATTERNS = [
  /\brm\s+-rf\s+[\/~]/i,
  /\bformat\s+[a-z]:/i,
  /\bdel\s+\/[sq]/i,
  /\bmkfs\b/i,
  /\bdd\s+if=/i,
  /\b:\(\)\s*\{\s*:\|:\s*&\s*\}\s*;/,  // Fork bomb
  /\bcurl\b.*\|\s*(?:bash|sh|zsh)/i,    // Pipe to shell
  /\bwget\b.*\|\s*(?:bash|sh|zsh)/i,
  /\bchmod\s+777\b/i,
  /\bchown\s+-R\s+root/i,
  /\bnc\s+-[el]/i,                       // Netcat listener
  /\breverse\s*shell\b/i,
  /\b(?:LD_PRELOAD|NODE_OPTIONS|DYLD_)\s*=/i  // Loader hijack (inspired by Ruflo audit)
];

function validateShellCommand(command) {
  const cmd = String(command || '');
  const findings = [];

  for (const pattern of DANGEROUS_SHELL_PATTERNS) {
    if (pattern.test(cmd)) {
      findings.push({
        type: 'dangerous_command',
        severity: 'critical',
        pattern: pattern.source,
        command: cmd.length > 80 ? `${cmd.slice(0, 77)}...` : cmd
      });
    }
  }

  return {
    safe: findings.length === 0,
    findings,
    blocked: findings.length > 0
  };
}

// ── Unified Defence Check ────────────────────────────────────────────────────
function runDefenceCheck(text, options = {}) {
  const results = {
    injection: options.checkInjection !== false ? detectPromptInjection(text) : { safe: true, findings: [] },
    pii: options.checkPII !== false ? scanForPII(text) : { clean: true, findings: [] },
    secrets: options.checkSecrets !== false ? scanForSecrets(text) : { clean: true, findings: [] }
  };

  const allFindings = [
    ...results.injection.findings,
    ...results.pii.findings,
    ...results.secrets.findings
  ];

  return {
    safe: results.injection.safe && results.pii.clean && results.secrets.clean,
    blocked: results.injection.blocked,
    totalFindings: allFindings.length,
    criticalCount: allFindings.filter(f => f.severity === 'critical').length,
    highCount: allFindings.filter(f => f.severity === 'high').length,
    results,
    summary: allFindings.length === 0
      ? 'All checks passed.'
      : `Found ${allFindings.length} issue(s): ${allFindings.map(f => `${f.type}(${f.severity})`).join(', ')}`
  };
}

// ── Exports ──────────────────────────────────────────────────────────────────
module.exports = {
  detectPromptInjection,
  scanForPII,
  redactPII,
  scanForSecrets,
  validateShellCommand,
  runDefenceCheck,
  INJECTION_PATTERNS,
  PII_PATTERNS,
  SECRET_PATTERNS,
  DANGEROUS_SHELL_PATTERNS
};
