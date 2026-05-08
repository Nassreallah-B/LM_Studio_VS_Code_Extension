'use strict';

// ── Structured Memory Database ───────────────────────────────────────────────
// Inspired by Ruflo's SQLite memory system. Provides table-based structured
// storage with namespaces, queries, TTL, and cross-agent shared state.
// Uses JSON persistence (zero native deps). Drop-in upgradeable to SQLite.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class MemoryDB {
  constructor(dbPath) {
    this.dbPath = dbPath;
    this.tables = {
      memory_store: [],      // KV store with namespaces
      sessions: [],           // User/agent sessions
      agents: [],             // Agent registry + configs
      tasks: [],              // Task tracking + status
      agent_memory: [],       // Per-agent private memory
      shared_state: [],       // Inter-agent shared state
      events: [],             // Full event journal
      patterns: [],           // Learned patterns (error-handling-001, etc.)
      performance_metrics: [], // System performance tracking
      workflow_state: []       // Workflow persistence for resume
    };
    this._dirty = false;
    this._autoSaveTimer = null;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────
  load() {
    try {
      if (fs.existsSync(this.dbPath)) {
        const raw = JSON.parse(fs.readFileSync(this.dbPath, 'utf8'));
        for (const table of Object.keys(this.tables)) {
          if (Array.isArray(raw[table])) {
            this.tables[table] = raw[table];
          }
        }
      }
    } catch (err) {
      console.error(`[MemoryDB] Failed to load: ${err.message}`);
    }
    return this;
  }

  save() {
    try {
      const dir = path.dirname(this.dbPath);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.dbPath, JSON.stringify(this.tables, null, 2), 'utf8');
      this._dirty = false;
    } catch (err) {
      console.error(`[MemoryDB] Failed to save: ${err.message}`);
    }
  }

  _markDirty() {
    this._dirty = true;
    if (!this._autoSaveTimer) {
      this._autoSaveTimer = setTimeout(() => {
        this._autoSaveTimer = null;
        if (this._dirty) this.save();
      }, 2000);
    }
  }

  dispose() {
    if (this._autoSaveTimer) {
      clearTimeout(this._autoSaveTimer);
      this._autoSaveTimer = null;
    }
    if (this._dirty) this.save();
  }

  // ── memory_store: Namespaced KV store ──────────────────────────────────
  store(namespace, key, value, options = {}) {
    const now = Date.now();
    const existing = this.tables.memory_store.findIndex(
      r => r.namespace === namespace && r.key === key
    );
    const record = {
      id: existing >= 0 ? this.tables.memory_store[existing].id : `mem_${crypto.randomBytes(4).toString('hex')}`,
      namespace,
      key,
      value,
      type: typeof value,
      createdAt: existing >= 0 ? this.tables.memory_store[existing].createdAt : now,
      updatedAt: now,
      expiresAt: options.ttlMs ? now + options.ttlMs : null,
      tags: options.tags || []
    };

    if (existing >= 0) {
      this.tables.memory_store[existing] = record;
    } else {
      this.tables.memory_store.push(record);
    }
    this._markDirty();
    return record;
  }

  retrieve(namespace, key) {
    const record = this.tables.memory_store.find(
      r => r.namespace === namespace && r.key === key
    );
    if (!record) return null;
    if (record.expiresAt && Date.now() > record.expiresAt) {
      this.delete('memory_store', record.id);
      return null;
    }
    return record.value;
  }

  query(namespace, filter = {}) {
    let results = this.tables.memory_store.filter(r => r.namespace === namespace);

    // TTL cleanup
    const now = Date.now();
    results = results.filter(r => !r.expiresAt || r.expiresAt > now);

    if (filter.keyPrefix) {
      results = results.filter(r => r.key.startsWith(filter.keyPrefix));
    }
    if (filter.tags && filter.tags.length) {
      results = results.filter(r =>
        Array.isArray(r.tags) && filter.tags.some(t => r.tags.includes(t))
      );
    }
    if (filter.since) {
      results = results.filter(r => r.updatedAt >= filter.since);
    }
    if (filter.limit) {
      results = results.slice(0, filter.limit);
    }

    return results;
  }

  // ── sessions ───────────────────────────────────────────────────────────
  createSession(sessionData = {}) {
    const session = {
      id: sessionData.id || `sess_${crypto.randomBytes(4).toString('hex')}`,
      agentId: sessionData.agentId || null,
      userId: sessionData.userId || 'local',
      status: 'active',
      context: sessionData.context || {},
      createdAt: Date.now(),
      updatedAt: Date.now(),
      expiresAt: sessionData.ttlMs ? Date.now() + sessionData.ttlMs : null
    };
    this.tables.sessions.push(session);
    this._markDirty();
    return session;
  }

  getSession(sessionId) {
    return this.tables.sessions.find(s => s.id === sessionId) || null;
  }

  updateSession(sessionId, updates) {
    const session = this.getSession(sessionId);
    if (!session) return null;
    Object.assign(session, updates, { updatedAt: Date.now() });
    this._markDirty();
    return session;
  }

  // ── agent_memory: Per-agent private memory ─────────────────────────────
  storeAgentMemory(agentType, key, value) {
    const existing = this.tables.agent_memory.findIndex(
      r => r.agentType === agentType && r.key === key
    );
    const record = {
      id: existing >= 0 ? this.tables.agent_memory[existing].id : `amem_${crypto.randomBytes(4).toString('hex')}`,
      agentType,
      key,
      value,
      updatedAt: Date.now()
    };
    if (existing >= 0) this.tables.agent_memory[existing] = record;
    else this.tables.agent_memory.push(record);
    this._markDirty();
    return record;
  }

  getAgentMemory(agentType, key) {
    const record = this.tables.agent_memory.find(
      r => r.agentType === agentType && r.key === key
    );
    return record ? record.value : null;
  }

  queryAgentMemory(agentType) {
    return this.tables.agent_memory.filter(r => r.agentType === agentType);
  }

  // ── shared_state: Cross-agent coordination ─────────────────────────────
  setSharedState(key, value, writerId = 'system') {
    const existing = this.tables.shared_state.findIndex(r => r.key === key);
    const record = {
      id: existing >= 0 ? this.tables.shared_state[existing].id : `ss_${crypto.randomBytes(4).toString('hex')}`,
      key,
      value,
      writerId,
      version: existing >= 0 ? (this.tables.shared_state[existing].version || 0) + 1 : 1,
      updatedAt: Date.now()
    };
    if (existing >= 0) this.tables.shared_state[existing] = record;
    else this.tables.shared_state.push(record);
    this._markDirty();
    return record;
  }

  getSharedState(key) {
    const record = this.tables.shared_state.find(r => r.key === key);
    return record ? record.value : null;
  }

  // ── events: Full event journal ─────────────────────────────────────────
  appendEvent(type, data = {}, source = 'system') {
    const event = {
      id: `evt_${crypto.randomBytes(4).toString('hex')}`,
      type,
      data,
      source,
      timestamp: Date.now()
    };
    this.tables.events.push(event);
    // Cap at 5000 events
    if (this.tables.events.length > 5000) {
      this.tables.events = this.tables.events.slice(-4000);
    }
    this._markDirty();
    return event;
  }

  queryEvents(filter = {}) {
    let results = this.tables.events;
    if (filter.type) results = results.filter(e => e.type === filter.type);
    if (filter.source) results = results.filter(e => e.source === filter.source);
    if (filter.since) results = results.filter(e => e.timestamp >= filter.since);
    if (filter.limit) results = results.slice(-filter.limit);
    return results;
  }

  // ── patterns: Learned patterns ─────────────────────────────────────────
  storePattern(pattern) {
    const record = {
      id: pattern.id || `pat_${crypto.randomBytes(4).toString('hex')}`,
      name: pattern.name,
      category: pattern.category || 'general', // error-handling, performance, security, ui
      description: pattern.description || '',
      trigger: pattern.trigger || '',         // When to apply this pattern
      action: pattern.action || '',           // What to do
      confidence: pattern.confidence || 0.5,  // 0-1 confidence score
      usageCount: 0,
      lastUsedAt: null,
      createdAt: Date.now(),
      metadata: pattern.metadata || {}
    };
    this.tables.patterns.push(record);
    this._markDirty();
    return record;
  }

  findPatterns(category, trigger = '') {
    let results = this.tables.patterns.filter(p => p.category === category);
    if (trigger) {
      const triggerLower = trigger.toLowerCase();
      results = results.filter(p =>
        p.trigger.toLowerCase().includes(triggerLower) ||
        p.name.toLowerCase().includes(triggerLower)
      );
    }
    return results.sort((a, b) => b.confidence - a.confidence);
  }

  reinforcePattern(patternId, positive = true) {
    const pattern = this.tables.patterns.find(p => p.id === patternId);
    if (!pattern) return null;
    pattern.usageCount += 1;
    pattern.lastUsedAt = Date.now();
    pattern.confidence = Math.min(1, Math.max(0,
      pattern.confidence + (positive ? 0.05 : -0.1)
    ));
    this._markDirty();
    return pattern;
  }

  // ── performance_metrics ────────────────────────────────────────────────
  recordMetric(name, value, tags = {}) {
    const metric = {
      id: `met_${crypto.randomBytes(4).toString('hex')}`,
      name,
      value,
      tags,
      timestamp: Date.now()
    };
    this.tables.performance_metrics.push(metric);
    if (this.tables.performance_metrics.length > 10000) {
      this.tables.performance_metrics = this.tables.performance_metrics.slice(-8000);
    }
    this._markDirty();
    return metric;
  }

  getMetrics(name, since = 0, limit = 100) {
    return this.tables.performance_metrics
      .filter(m => m.name === name && m.timestamp >= since)
      .slice(-limit);
  }

  // ── workflow_state: Workflow persistence for resume ─────────────────────
  saveWorkflowState(workflowId, state) {
    const existing = this.tables.workflow_state.findIndex(w => w.workflowId === workflowId);
    const record = {
      workflowId,
      state,
      updatedAt: Date.now(),
      checkpointAt: Date.now()
    };
    if (existing >= 0) this.tables.workflow_state[existing] = record;
    else this.tables.workflow_state.push(record);
    this._markDirty();
    return record;
  }

  loadWorkflowState(workflowId) {
    const record = this.tables.workflow_state.find(w => w.workflowId === workflowId);
    return record ? record.state : null;
  }

  // ── Generic operations ─────────────────────────────────────────────────
  delete(table, id) {
    if (!this.tables[table]) return false;
    const before = this.tables[table].length;
    this.tables[table] = this.tables[table].filter(r => r.id !== id);
    if (this.tables[table].length < before) {
      this._markDirty();
      return true;
    }
    return false;
  }

  cleanup(options = {}) {
    const now = Date.now();
    let cleaned = 0;

    // Clean expired memory_store entries
    const before = this.tables.memory_store.length;
    this.tables.memory_store = this.tables.memory_store.filter(
      r => !r.expiresAt || r.expiresAt > now
    );
    cleaned += before - this.tables.memory_store.length;

    // Clean expired sessions
    const beforeSess = this.tables.sessions.length;
    this.tables.sessions = this.tables.sessions.filter(
      s => !s.expiresAt || s.expiresAt > now
    );
    cleaned += beforeSess - this.tables.sessions.length;

    // Clean old events (keep last 30 days by default)
    const maxAge = options.maxEventAgeMs || 30 * 24 * 60 * 60 * 1000;
    const beforeEvt = this.tables.events.length;
    this.tables.events = this.tables.events.filter(
      e => e.timestamp > now - maxAge
    );
    cleaned += beforeEvt - this.tables.events.length;

    // Clean low-confidence patterns
    const beforePat = this.tables.patterns.length;
    this.tables.patterns = this.tables.patterns.filter(
      p => p.confidence > 0.1 || p.usageCount > 0
    );
    cleaned += beforePat - this.tables.patterns.length;

    if (cleaned > 0) this._markDirty();
    return cleaned;
  }

  getStats() {
    return {
      tables: Object.fromEntries(
        Object.entries(this.tables).map(([k, v]) => [k, v.length])
      ),
      totalRecords: Object.values(this.tables).reduce((sum, t) => sum + t.length, 0),
      namespaces: [...new Set(this.tables.memory_store.map(r => r.namespace))],
      patternCategories: [...new Set(this.tables.patterns.map(p => p.category))],
      dirty: this._dirty
    };
  }
}

module.exports = { MemoryDB };
