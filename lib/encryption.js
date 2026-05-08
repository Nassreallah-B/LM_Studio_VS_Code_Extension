'use strict';

// ── Encryption at Rest ───────────────────────────────────────────────────────
// Inspired by Ruflo's ADR-096 (AES-256-GCM vault with RFE1 magic bytes).
// Provides opt-in encryption for sensitive stored data (chats, memory, learning).

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MAGIC = Buffer.from('HFA1'); // LocalAI v1 encrypted file marker
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;
const SALT_LENGTH = 32;
const KEY_ITERATIONS = 100000;
const KEY_LENGTH = 32;

class EncryptionVault {
  constructor(options = {}) {
    this.enabled = options.enabled === true;
    this._masterKey = null;
    this._keySource = options.keySource || 'secretStorage'; // 'secretStorage' | 'passphrase' | 'env'
  }

  // ── Key Management ───────────────────────────────────────────────────────
  async initializeKey(secretStorage) {
    if (!this.enabled) return;

    if (this._keySource === 'env') {
      const envKey = process.env.localai_ENCRYPTION_KEY;
      if (envKey) {
        this._masterKey = Buffer.from(envKey, 'hex');
        if (this._masterKey.length !== KEY_LENGTH) {
          throw new Error('localai_ENCRYPTION_KEY must be 64 hex characters (32 bytes)');
        }
        return;
      }
    }

    if (this._keySource === 'secretStorage' && secretStorage) {
      let stored = await secretStorage.get('localai.encryptionKey');
      if (!stored) {
        // Generate and store a new key
        const newKey = crypto.randomBytes(KEY_LENGTH);
        stored = newKey.toString('hex');
        await secretStorage.store('localai.encryptionKey', stored);
      }
      this._masterKey = Buffer.from(stored, 'hex');
      return;
    }

    throw new Error('No encryption key source available');
  }

  setEnabled(enabled) {
    this.enabled = enabled;
  }

  hasKey() {
    return this._masterKey !== null && this._masterKey.length === KEY_LENGTH;
  }

  // ── Derive a per-file key from master key + salt ─────────────────────────
  _deriveKey(salt) {
    if (!this._masterKey) throw new Error('Encryption key not initialized');
    return crypto.pbkdf2Sync(this._masterKey, salt, KEY_ITERATIONS, KEY_LENGTH, 'sha256');
  }

  // ── Encrypt ──────────────────────────────────────────────────────────────
  encrypt(plaintext) {
    if (!this.enabled || !this.hasKey()) return Buffer.from(plaintext);

    const salt = crypto.randomBytes(SALT_LENGTH);
    const key = this._deriveKey(salt);
    const iv = crypto.randomBytes(IV_LENGTH);

    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();

    // Format: MAGIC(4) + SALT(32) + IV(16) + AUTH_TAG(16) + ENCRYPTED(variable)
    return Buffer.concat([MAGIC, salt, iv, authTag, encrypted]);
  }

  // ── Decrypt ──────────────────────────────────────────────────────────────
  decrypt(cipherBuffer) {
    if (!Buffer.isBuffer(cipherBuffer)) {
      cipherBuffer = Buffer.from(cipherBuffer);
    }

    // Check magic bytes — if not encrypted, return as-is
    if (!cipherBuffer.slice(0, 4).equals(MAGIC)) {
      return cipherBuffer.toString('utf8');
    }

    if (!this.hasKey()) {
      throw new Error('Cannot decrypt: encryption key not initialized');
    }

    const salt = cipherBuffer.slice(4, 4 + SALT_LENGTH);
    const iv = cipherBuffer.slice(4 + SALT_LENGTH, 4 + SALT_LENGTH + IV_LENGTH);
    const authTag = cipherBuffer.slice(4 + SALT_LENGTH + IV_LENGTH, 4 + SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH);
    const encrypted = cipherBuffer.slice(4 + SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH);

    const key = this._deriveKey(salt);
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);

    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
  }

  // ── File operations ────────────────────────────────────────────────────
  encryptFile(filePath) {
    if (!this.enabled || !this.hasKey()) return false;
    if (!fs.existsSync(filePath)) return false;

    const content = fs.readFileSync(filePath);
    // Skip if already encrypted
    if (content.length >= 4 && content.slice(0, 4).equals(MAGIC)) return false;

    const encrypted = this.encrypt(content.toString('utf8'));
    fs.writeFileSync(filePath, encrypted);
    return true;
  }

  decryptFile(filePath) {
    if (!fs.existsSync(filePath)) return null;
    const content = fs.readFileSync(filePath);
    return this.decrypt(content);
  }

  // ── JSON file operations (most common use case) ────────────────────────
  readJsonEncrypted(filePath, fallback) {
    try {
      if (!fs.existsSync(filePath)) return fallback;
      const content = fs.readFileSync(filePath);
      const decrypted = this.decrypt(content);
      return JSON.parse(decrypted);
    } catch (_) {
      return fallback;
    }
  }

  writeJsonEncrypted(filePath, value) {
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    const json = JSON.stringify(value, null, 2);
    if (this.enabled && this.hasKey()) {
      fs.writeFileSync(filePath, this.encrypt(json));
    } else {
      fs.writeFileSync(filePath, json, 'utf8');
    }
  }

  // ── Migrate plaintext files to encrypted ───────────────────────────────
  migrateDirectory(dirPath, extensions = ['.json']) {
    if (!this.enabled || !this.hasKey() || !fs.existsSync(dirPath)) return 0;

    let migrated = 0;
    const entries = fs.readdirSync(dirPath, { withFileTypes: true, recursive: true });

    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name);
      if (!extensions.includes(ext)) continue;

      const filePath = path.join(entry.parentPath || dirPath, entry.name);
      if (this.encryptFile(filePath)) migrated++;
    }

    return migrated;
  }

  // ── Tamper detection ───────────────────────────────────────────────────
  verifyIntegrity(filePath) {
    try {
      const content = fs.readFileSync(filePath);
      if (!content.slice(0, 4).equals(MAGIC)) {
        return { encrypted: false, valid: true, reason: 'plaintext' };
      }
      // Try decryption — if auth tag fails, file was tampered
      this.decrypt(content);
      return { encrypted: true, valid: true };
    } catch (err) {
      return { encrypted: true, valid: false, reason: err.message };
    }
  }

  getStatus() {
    return {
      enabled: this.enabled,
      hasKey: this.hasKey(),
      keySource: this._keySource,
      algorithm: ALGORITHM,
      magicBytes: MAGIC.toString('ascii')
    };
  }
}

module.exports = { EncryptionVault, MAGIC, ALGORITHM };

