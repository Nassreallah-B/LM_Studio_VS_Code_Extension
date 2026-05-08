'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// ── Token Management ─────────────────────────────────────────────────────────
// SecretStorage API Token — in-memory cache for synchronous access everywhere.
// Cache is loaded at extension startup via loadApiTokenCache()
// and updated on every saveToken / setToken.

let _apiTokenCache = '';
let _extensionContext = null;

function setExtensionContext(context) {
  _extensionContext = context;
}

async function loadApiTokenCache() {
  try {
    if (_extensionContext) {
      const stored = await _extensionContext.secrets.get('localai.apiToken');
      if (stored) { _apiTokenCache = stored; return; }
    }
  } catch (_) {}
  _apiTokenCache = '';
}

function getApiToken() {
  return _apiTokenCache || '';
}

async function saveApiTokenSecure(token) {
  _apiTokenCache = token || '';
  if (_extensionContext) {
    await _extensionContext.secrets.store('localai.apiToken', token || '');
  }
}

// ── File Utilities ───────────────────────────────────────────────────────────
function hashText(text) {
  return crypto.createHash('sha256').update(String(text || ''), 'utf8').digest('hex');
}

function createId(prefix) {
  return `${prefix}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
}

function ensureDirSync(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJsonFile(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

function writeJsonFile(filePath, value) {
  ensureDirSync(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
}

function fileExists(filePath) {
  try { return fs.existsSync(filePath); } catch (_) { return false; }
}

// ── Text Utilities ───────────────────────────────────────────────────────────
function normalizeWhitespace(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function truncateText(text, maxChars) {
  const value = String(text || '');
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 3))}...`;
}

function summarizeInstructionPreview(text, maxChars = 140) {
  const value = normalizeWhitespace(text);
  return value ? truncateText(value, maxChars) : 'Off';
}

function cloneMessages(messages) {
  return Array.isArray(messages) ? messages.map(msg => ({ ...msg })) : [];
}

function cloneLogs(logs) {
  return Array.isArray(logs) ? logs.map(log => ({ ...log })) : [];
}

function mergeLogEntries(existingLogs, incomingLogs) {
  const merged = new Map();
  for (const entry of [...cloneLogs(existingLogs), ...cloneLogs(incomingLogs)]) {
    if (!entry || typeof entry !== 'object') continue;
    const key = entry.id || `${entry.timestamp || ''}_${entry.message || ''}`;
    merged.set(key, entry);
  }
  return [...merged.values()];
}

function estimateTokens(text) {
  return Math.ceil(String(text || '').length / 4);
}

function stableStringify(value) {
  if (typeof value !== 'object' || value === null) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

function extractJsonFromText(text) {
  const value = String(text || '').trim();
  const braceStart = value.indexOf('{');
  const bracketStart = value.indexOf('[');
  let start = -1;
  if (braceStart >= 0 && (bracketStart < 0 || braceStart < bracketStart)) start = braceStart;
  else if (bracketStart >= 0) start = bracketStart;
  if (start < 0) return null;
  const opening = value[start];
  const closing = opening === '{' ? '}' : ']';
  let depth = 0;
  for (let i = start; i < value.length; i++) {
    if (value[i] === opening) depth++;
    else if (value[i] === closing) depth--;
    if (depth === 0) {
      try { return JSON.parse(value.slice(start, i + 1)); } catch (_) { return null; }
    }
  }
  return null;
}

function tryParseJson(text) {
  try { return JSON.parse(text); } catch (_) { return extractJsonFromText(text); }
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function wildcardToRegExp(pattern) {
  return new RegExp(`^${escapeRegExp(pattern).replace(/\\\*/g, '.*')}$`, 'i');
}

// ── Path Utilities ───────────────────────────────────────────────────────────
function detectLanguageFromPath(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const map = {
    '.js': 'javascript', '.jsx': 'javascript', '.ts': 'typescript', '.tsx': 'typescript',
    '.py': 'python', '.java': 'java', '.c': 'c', '.cpp': 'cpp', '.cc': 'cpp',
    '.cs': 'csharp', '.go': 'go', '.rs': 'rust', '.rb': 'ruby', '.php': 'php',
    '.swift': 'swift', '.kt': 'kotlin', '.scala': 'scala', '.sh': 'bash',
    '.ps1': 'powershell', '.sql': 'sql', '.html': 'html', '.css': 'css',
    '.scss': 'scss', '.json': 'json', '.yaml': 'yaml', '.yml': 'yaml',
    '.toml': 'toml', '.md': 'markdown', '.xml': 'xml'
  };
  return map[ext] || '';
}

function normalizeRelativeFilePath(value) {
  return String(value || '').replace(/\\/g, '/').replace(/^\.\//, '');
}

function formatTextWithLineNumbers(text, startLine = 1) {
  const lines = String(text || '').split('\n');
  return lines.map((line, i) => `${startLine + i}: ${line}`).join('\n');
}

// ── Workspace Utilities ──────────────────────────────────────────────────────
function getWorkspaceFolder() {
  return (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0)
    ? vscode.workspace.workspaceFolders[0]
    : null;
}

function getWorkspaceStorageRoot(context) {
  if (context.storageUri && context.storageUri.fsPath) return context.storageUri.fsPath;
  const folder = getWorkspaceFolder();
  if (folder) return path.join(folder.uri.fsPath, '.localai', 'storage');
  return path.join(context.globalStorageUri.fsPath, 'no-workspace');
}

function safeRelativeToWorkspace(fsPath) {
  const folder = getWorkspaceFolder();
  if (!folder) return path.basename(fsPath);
  return path.relative(folder.uri.fsPath, fsPath).replace(/\\/g, '/');
}

// ── Exports ──────────────────────────────────────────────────────────────────
module.exports = {
  // Token management
  setExtensionContext, loadApiTokenCache, getApiToken, saveApiTokenSecure,
  // File utilities
  hashText, createId, ensureDirSync, readJsonFile, writeJsonFile, fileExists,
  // Text utilities
  normalizeWhitespace, truncateText, summarizeInstructionPreview,
  cloneMessages, cloneLogs, mergeLogEntries, estimateTokens,
  stableStringify, extractJsonFromText, tryParseJson, escapeRegExp, wildcardToRegExp,
  // Path utilities
  detectLanguageFromPath, normalizeRelativeFilePath, formatTextWithLineNumbers,
  // Workspace utilities
  getWorkspaceFolder, getWorkspaceStorageRoot, safeRelativeToWorkspace
};

