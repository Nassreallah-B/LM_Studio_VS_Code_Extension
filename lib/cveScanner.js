'use strict';

// ── CVE Scanner ──────────────────────────────────────────────────────────────
// Inspired by Ruflo's CVE remediation. Scans package.json dependencies for
// known vulnerable patterns and runs npm audit when available.

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// Known critical vulnerabilities that are commonly exploited
// Updated subset - the full CVE database would come from npm audit
const KNOWN_VULN_PATTERNS = [
  { package: 'lodash', below: '4.17.21', cve: 'CVE-2021-23337', severity: 'critical', fix: '>=4.17.21', description: 'Prototype pollution via template' },
  { package: 'minimist', below: '1.2.6', cve: 'CVE-2021-44906', severity: 'critical', fix: '>=1.2.6', description: 'Prototype pollution' },
  { package: 'node-fetch', below: '2.6.7', cve: 'CVE-2022-0235', severity: 'high', fix: '>=2.6.7', description: 'Information exposure via headers' },
  { package: 'glob-parent', below: '5.1.2', cve: 'CVE-2020-28469', severity: 'high', fix: '>=5.1.2', description: 'ReDoS vulnerability' },
  { package: 'trim-newlines', below: '3.0.1', cve: 'CVE-2021-33623', severity: 'high', fix: '>=3.0.1', description: 'ReDoS vulnerability' },
  { package: 'semver', below: '7.5.2', cve: 'CVE-2022-25883', severity: 'medium', fix: '>=7.5.2', description: 'ReDoS via regex' },
  { package: 'json5', below: '2.2.2', cve: 'CVE-2022-46175', severity: 'high', fix: '>=2.2.2', description: 'Prototype pollution' },
  { package: 'axios', below: '1.6.0', cve: 'CVE-2023-45857', severity: 'medium', fix: '>=1.6.0', description: 'CSRF via XSRF-TOKEN cookie' },
  { package: 'express', below: '4.19.2', cve: 'CVE-2024-29041', severity: 'medium', fix: '>=4.19.2', description: 'Open redirect via URL parsing' },
  { package: 'ip', below: '2.0.1', cve: 'CVE-2024-29415', severity: 'high', fix: '>=2.0.1', description: 'SSRF via IPv4-mapped IPv6' },
  { package: 'tar', below: '6.2.1', cve: 'CVE-2024-28863', severity: 'medium', fix: '>=6.2.1', description: 'Denial of service' },
  { package: 'braces', below: '3.0.3', cve: 'CVE-2024-4068', severity: 'high', fix: '>=3.0.3', description: 'ReDoS via unbalanced braces' }
];

function parseVersion(version) {
  const clean = String(version || '').replace(/^[~^>=<\s]+/, '').split('-')[0];
  const parts = clean.split('.').map(Number);
  return { major: parts[0] || 0, minor: parts[1] || 0, patch: parts[2] || 0 };
}

function isVersionBelow(version, threshold) {
  const v = parseVersion(version);
  const t = parseVersion(threshold);
  if (v.major !== t.major) return v.major < t.major;
  if (v.minor !== t.minor) return v.minor < t.minor;
  return v.patch < t.patch;
}

// ── Quick scan using known patterns ──────────────────────────────────────────
function scanPackageJson(packageJsonPath) {
  const findings = [];

  try {
    if (!fs.existsSync(packageJsonPath)) {
      return { findings, error: 'package.json not found' };
    }

    const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    const allDeps = {
      ...(pkg.dependencies || {}),
      ...(pkg.devDependencies || {})
    };

    for (const vuln of KNOWN_VULN_PATTERNS) {
      const installedVersion = allDeps[vuln.package];
      if (!installedVersion) continue;

      if (isVersionBelow(installedVersion, vuln.below)) {
        findings.push({
          package: vuln.package,
          installedVersion,
          cve: vuln.cve,
          severity: vuln.severity,
          description: vuln.description,
          fix: `Update to ${vuln.fix}`,
          autoFixCommand: `npm install ${vuln.package}@latest`
        });
      }
    }
  } catch (err) {
    return { findings, error: err.message };
  }

  return {
    findings,
    error: '',
    summary: findings.length === 0
      ? 'No known vulnerabilities detected in direct dependencies.'
      : `Found ${findings.length} vulnerable package(s): ${findings.map(f => `${f.package}(${f.severity})`).join(', ')}`,
    criticalCount: findings.filter(f => f.severity === 'critical').length,
    highCount: findings.filter(f => f.severity === 'high').length
  };
}

// ── Full scan using npm audit ────────────────────────────────────────────────
function runNpmAudit(workspaceRoot) {
  return new Promise((resolve) => {
    const proc = spawn('npm', ['audit', '--json', '--omit=dev'], {
      cwd: workspaceRoot,
      timeout: 60000,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: true
    });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d; });
    proc.stderr.on('data', (d) => { stderr += d; });

    proc.on('close', (code) => {
      try {
        const audit = JSON.parse(stdout);
        const vulns = audit.vulnerabilities || {};
        const findings = Object.entries(vulns).map(([name, info]) => ({
          package: name,
          severity: info.severity || 'unknown',
          via: Array.isArray(info.via) ? info.via.filter(v => typeof v === 'string').join(', ') : '',
          fixAvailable: !!info.fixAvailable,
          range: info.range || ''
        }));

        resolve({
          source: 'npm-audit',
          findings,
          metadata: audit.metadata || {},
          summary: `npm audit found ${findings.length} vulnerabilities`
        });
      } catch (_) {
        resolve({
          source: 'npm-audit',
          findings: [],
          error: stderr || 'Failed to parse npm audit output',
          summary: 'npm audit failed or produced no parsable output'
        });
      }
    });

    proc.on('error', (err) => {
      resolve({
        source: 'npm-audit',
        findings: [],
        error: err.message,
        summary: `npm audit failed: ${err.message}`
      });
    });
  });
}

// ── Combined scan ────────────────────────────────────────────────────────────
async function fullScan(workspaceRoot) {
  const packageJsonPath = path.join(workspaceRoot, 'package.json');

  // Quick pattern scan (instant)
  const quickResult = scanPackageJson(packageJsonPath);

  // npm audit (may take a few seconds)
  let auditResult = { findings: [], error: 'skipped' };
  if (fs.existsSync(path.join(workspaceRoot, 'node_modules'))) {
    auditResult = await runNpmAudit(workspaceRoot);
  }

  // Merge results (dedupe by package name)
  const seenPackages = new Set();
  const allFindings = [];

  for (const f of quickResult.findings) {
    seenPackages.add(f.package);
    allFindings.push({ ...f, source: 'pattern-match' });
  }

  for (const f of auditResult.findings) {
    if (!seenPackages.has(f.package)) {
      allFindings.push({ ...f, source: 'npm-audit' });
    }
  }

  return {
    findings: allFindings,
    quickScan: quickResult,
    npmAudit: auditResult,
    totalVulnerabilities: allFindings.length,
    criticalCount: allFindings.filter(f => f.severity === 'critical').length,
    highCount: allFindings.filter(f => f.severity === 'high').length,
    summary: allFindings.length === 0
      ? 'No vulnerabilities found.'
      : `${allFindings.length} vulnerabilities: ${allFindings.filter(f => f.severity === 'critical').length} critical, ${allFindings.filter(f => f.severity === 'high').length} high`
  };
}

module.exports = { scanPackageJson, runNpmAudit, fullScan, KNOWN_VULN_PATTERNS };
