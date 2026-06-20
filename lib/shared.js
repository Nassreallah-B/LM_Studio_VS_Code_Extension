'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function createId(prefix) {
  return `${prefix}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
}

function ensureDirSync(targetPath) {
  fs.mkdirSync(targetPath, { recursive: true });
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

function truncateText(text, maxChars) {
  const value = String(text || '');
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 3))}...`;
}

function normalizeWhitespace(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function cloneMessages(messages) {
  return Array.isArray(messages) ? messages.map(message => ({ ...message })) : [];
}

function cloneLogs(logs) {
  return Array.isArray(logs) ? logs.map(log => ({ ...log })) : [];
}

function mergeLogEntries(existingLogs, incomingLogs, maxLogEntries = 320) {
  const merged = new Map();
  for (const entry of [...cloneLogs(existingLogs), ...cloneLogs(incomingLogs)]) {
    if (!entry || typeof entry !== 'object') continue;
    const key = entry.id || `${entry.createdAt || ''}:${entry.level || ''}:${entry.message || ''}`;
    merged.set(key, entry);
  }
  return [...merged.values()]
    .sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')))
    .slice(-maxLogEntries);
}

module.exports = {
  createId,
  ensureDirSync,
  readJsonFile,
  writeJsonFile,
  truncateText,
  normalizeWhitespace,
  cloneMessages,
  cloneLogs,
  mergeLogEntries
};
