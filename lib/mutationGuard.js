'use strict';

// ── MutationGuard ────────────────────────────────────────────────────────────
// Inspired by Ruflo's fail-closed MutationGuard.
// Validates all write/shell operations against configurable policies.
// Every mutation is logged for audit trail.

const path = require('path');

// ── Default Policies ─────────────────────────────────────────────────────────
const DEFAULT_POLICIES = {
  // Files that should NEVER be modified by agents
  blockedPaths: [
    '.env',
    '.env.local',
    '.env.production',
    'package-lock.json',
    'yarn.lock',
    'pnpm-lock.yaml',
    '.git/',
    'node_modules/',
    '.vscode/settings.json'
  ],

  // Patterns that require explicit user approval
  approvalRequired: [
    '*.sql',            // Migration files
    'supabase/migrations/*',
    'vercel.json',
    'tsconfig.json',
    'vite.config.*',
    '.github/workflows/*'
  ],

  // Max file size an agent can write (bytes)
  maxWriteSize: 500 * 1024, // 500KB

  // Shell commands that need approval (beyond aiDefence)
  shellApprovalPatterns: [
    /npm\s+(publish|unpublish)/i,
    /git\s+(push|force|reset\s+--hard)/i,
    /docker\s+(rm|rmi|system\s+prune)/i,
    /supabase\s+(db\s+reset|migration\s+repair)/i,
    /vercel\s+(--prod|deploy\s+--prod)/i
  ],

  // Agent roles and their write permissions
  rolePermissions: {
    'aria-orchestrator': { canWrite: false, canShell: false, canDelete: false },
    'general-purpose':   { canWrite: true,  canShell: true,  canDelete: false },
    'rtl-ui-auditor':    { canWrite: false, canShell: false, canDelete: false },
    'database-expert':   { canWrite: false, canShell: true,  canDelete: false },
    'security-sentinel': { canWrite: false, canShell: true,  canDelete: false },
    'refactoring-expert':{ canWrite: true,  canShell: true,  canDelete: false },
    'worker':            { canWrite: true,  canShell: true,  canDelete: false },
    'fork':              { canWrite: true,  canShell: true,  canDelete: false },
    'Explore':           { canWrite: false, canShell: false, canDelete: false },
    'Plan':              { canWrite: false, canShell: false, canDelete: false },
    'verification':      { canWrite: false, canShell: true,  canDelete: false },
    'team-lead':         { canWrite: false, canShell: false, canDelete: false },
    'guide':             { canWrite: false, canShell: false, canDelete: false },
    'performance-monitor': { canWrite: false, canShell: true, canDelete: false },
    'onboarding-expert': { canWrite: false, canShell: false, canDelete: false }
  }
};

class MutationGuard {
  constructor(options = {}) {
    this.policies = { ...DEFAULT_POLICIES, ...options.policies };
    this.auditLog = [];
    this.maxAuditEntries = options.maxAuditEntries || 1000;
    this.onApprovalNeeded = options.onApprovalNeeded || null; // async callback
  }

  // ── Check write permission ─────────────────────────────────────────────
  checkWrite(filePath, agentType, content = '') {
    const normalizedPath = filePath.replace(/\\/g, '/');
    const fileName = path.basename(normalizedPath);
    const result = { allowed: true, reason: '', requiresApproval: false };

    // 1. Check role permissions
    const perms = this.policies.rolePermissions[agentType];
    if (perms && !perms.canWrite) {
      result.allowed = false;
      result.reason = `Agent type "${agentType}" does not have write permission`;
      this._audit('write_blocked', filePath, agentType, result.reason);
      return result;
    }

    // 2. Check blocked paths
    for (const blocked of this.policies.blockedPaths) {
      if (blocked.endsWith('/')) {
        if (normalizedPath.includes(blocked)) {
          result.allowed = false;
          result.reason = `Path contains blocked directory: ${blocked}`;
          this._audit('write_blocked', filePath, agentType, result.reason);
          return result;
        }
      } else if (fileName === blocked || normalizedPath.endsWith(blocked)) {
        result.allowed = false;
        result.reason = `File is in the blocked list: ${blocked}`;
        this._audit('write_blocked', filePath, agentType, result.reason);
        return result;
      }
    }

    // 3. Check file size
    if (content && Buffer.byteLength(content, 'utf8') > this.policies.maxWriteSize) {
      result.allowed = false;
      result.reason = `Content exceeds max write size (${this.policies.maxWriteSize} bytes)`;
      this._audit('write_blocked', filePath, agentType, result.reason);
      return result;
    }

    // 4. Check approval-required patterns
    for (const pattern of this.policies.approvalRequired) {
      const regex = new RegExp('^' + pattern.replace(/\*/g, '.*').replace(/\//g, '\\/') + '$', 'i');
      if (regex.test(normalizedPath) || regex.test(fileName)) {
        result.requiresApproval = true;
        result.reason = `File matches approval-required pattern: ${pattern}`;
        this._audit('write_approval_needed', filePath, agentType, result.reason);
        break;
      }
    }

    if (result.allowed && !result.requiresApproval) {
      this._audit('write_allowed', filePath, agentType, 'Policy check passed');
    }

    return result;
  }

  // ── Check shell command permission ─────────────────────────────────────
  checkShell(command, agentType) {
    const result = { allowed: true, reason: '', requiresApproval: false };

    // 1. Check role permissions
    const perms = this.policies.rolePermissions[agentType];
    if (perms && !perms.canShell) {
      result.allowed = false;
      result.reason = `Agent type "${agentType}" does not have shell permission`;
      this._audit('shell_blocked', command, agentType, result.reason);
      return result;
    }

    // 2. Check approval-required shell patterns
    for (const pattern of this.policies.shellApprovalPatterns) {
      if (pattern.test(command)) {
        result.requiresApproval = true;
        result.reason = `Command matches approval-required pattern: ${pattern.source}`;
        this._audit('shell_approval_needed', command, agentType, result.reason);
        break;
      }
    }

    if (result.allowed && !result.requiresApproval) {
      this._audit('shell_allowed', command, agentType, 'Policy check passed');
    }

    return result;
  }

  // ── Check delete permission ────────────────────────────────────────────
  checkDelete(filePath, agentType) {
    const perms = this.policies.rolePermissions[agentType];
    if (perms && !perms.canDelete) {
      this._audit('delete_blocked', filePath, agentType, 'No delete permission for this role');
      return { allowed: false, reason: `Agent type "${agentType}" cannot delete files` };
    }

    // Check blocked paths
    const normalizedPath = filePath.replace(/\\/g, '/');
    for (const blocked of this.policies.blockedPaths) {
      if (normalizedPath.includes(blocked)) {
        this._audit('delete_blocked', filePath, agentType, `Blocked path: ${blocked}`);
        return { allowed: false, reason: `Cannot delete files in blocked path: ${blocked}` };
      }
    }

    this._audit('delete_allowed', filePath, agentType, 'Policy check passed');
    return { allowed: true, reason: '' };
  }

  // ── Request approval (async) ───────────────────────────────────────────
  async requestApproval(operation, target, agentType, reason) {
    if (this.onApprovalNeeded) {
      const approved = await this.onApprovalNeeded({
        operation, target, agentType, reason, timestamp: Date.now()
      });
      this._audit(
        approved ? 'approval_granted' : 'approval_denied',
        target, agentType, reason
      );
      return approved;
    }
    // Default: deny if no approval handler is set
    this._audit('approval_denied', target, agentType, 'No approval handler configured');
    return false;
  }

  // ── Audit log ──────────────────────────────────────────────────────────
  _audit(action, target, agentType, reason) {
    this.auditLog.push({
      action,
      target: String(target || '').slice(0, 200),
      agentType,
      reason,
      timestamp: Date.now()
    });
    if (this.auditLog.length > this.maxAuditEntries) {
      this.auditLog = this.auditLog.slice(-Math.floor(this.maxAuditEntries * 0.8));
    }
  }

  getAuditLog(limit = 50) {
    return this.auditLog.slice(-limit);
  }

  getStats() {
    const counts = {};
    for (const entry of this.auditLog) {
      counts[entry.action] = (counts[entry.action] || 0) + 1;
    }
    return {
      totalEntries: this.auditLog.length,
      actions: counts,
      blockedPaths: this.policies.blockedPaths.length,
      approvalPatterns: this.policies.approvalRequired.length,
      configuredRoles: Object.keys(this.policies.rolePermissions).length
    };
  }

  // ── Update policies at runtime ─────────────────────────────────────────
  addBlockedPath(pathPattern) {
    if (!this.policies.blockedPaths.includes(pathPattern)) {
      this.policies.blockedPaths.push(pathPattern);
    }
  }

  removeBlockedPath(pathPattern) {
    this.policies.blockedPaths = this.policies.blockedPaths.filter(p => p !== pathPattern);
  }

  setRolePermission(agentType, permissions) {
    this.policies.rolePermissions[agentType] = {
      ...this.policies.rolePermissions[agentType],
      ...permissions
    };
  }
}

module.exports = { MutationGuard, DEFAULT_POLICIES };
