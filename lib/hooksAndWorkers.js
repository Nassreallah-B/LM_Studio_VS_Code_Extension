'use strict';

// ── Extended Hooks System ────────────────────────────────────────────────────
// Inspired by Ruflo's 27 lifecycle hooks. Extends the existing pre_prompt and
// pre_tool hooks with post_tool, post_task, on_error, on_patch_accept/reject,
// and pre_spawn hooks.

class HookRegistry {
  constructor() {
    this.hooks = new Map();
    // Register default hook phases
    const phases = [
      'pre_prompt',    // Before building the system prompt
      'pre_tool',      // Before executing a tool
      'post_tool',     // After a tool completes (success or failure)
      'pre_task',      // Before starting an agent task
      'post_task',     // After an agent task completes
      'on_error',      // When an error occurs during agent execution
      'on_patch_accept', // When user accepts a generated patch
      'on_patch_reject', // When user rejects a generated patch
      'pre_spawn',     // Before spawning a sub-agent
      'on_round_start', // At the beginning of each agent round
      'on_round_end'   // At the end of each agent round
    ];
    for (const phase of phases) {
      this.hooks.set(phase, []);
    }
  }

  // Register a hook handler for a specific phase
  register(phase, handler, options = {}) {
    if (!this.hooks.has(phase)) {
      this.hooks.set(phase, []);
    }
    const entry = {
      id: options.id || `hook_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      phase,
      handler,
      priority: options.priority || 0,
      pluginId: options.pluginId || null,
      description: options.description || '',
      enabled: options.enabled !== false
    };
    this.hooks.get(phase).push(entry);
    // Sort by priority (lower = earlier)
    this.hooks.get(phase).sort((a, b) => a.priority - b.priority);
    return entry.id;
  }

  // Unregister a hook by ID
  unregister(hookId) {
    for (const [phase, handlers] of this.hooks) {
      const idx = handlers.findIndex(h => h.id === hookId);
      if (idx >= 0) {
        handlers.splice(idx, 1);
        return true;
      }
    }
    return false;
  }

  // Unregister all hooks from a specific plugin
  unregisterPlugin(pluginId) {
    let count = 0;
    for (const [phase, handlers] of this.hooks) {
      const before = handlers.length;
      this.hooks.set(phase, handlers.filter(h => h.pluginId !== pluginId));
      count += before - this.hooks.get(phase).length;
    }
    return count;
  }

  // Execute all hooks for a phase, passing payload through each
  async execute(phase, payload = {}) {
    const handlers = this.hooks.get(phase) || [];
    const results = [];
    let currentPayload = { ...payload };

    for (const hook of handlers) {
      if (!hook.enabled) continue;
      try {
        const result = await hook.handler(currentPayload);
        results.push({ hookId: hook.id, phase, ok: true, result });
        // Allow hooks to modify the payload for the next hook
        if (result && typeof result === 'object' && result._modifiedPayload) {
          currentPayload = { ...currentPayload, ...result._modifiedPayload };
        }
      } catch (err) {
        results.push({ hookId: hook.id, phase, ok: false, error: err.message });
        // Don't break the chain for non-critical hooks
        if (hook.priority < 0) {
          // Critical priority hooks break the chain on error
          throw err;
        }
      }
    }

    return { results, modifiedPayload: currentPayload };
  }

  // Get all registered hooks
  list(phase = null) {
    if (phase) {
      return (this.hooks.get(phase) || []).map(h => ({
        id: h.id,
        phase: h.phase,
        priority: h.priority,
        pluginId: h.pluginId,
        description: h.description,
        enabled: h.enabled
      }));
    }
    const all = [];
    for (const [phase, handlers] of this.hooks) {
      for (const h of handlers) {
        all.push({ id: h.id, phase, priority: h.priority, pluginId: h.pluginId, description: h.description, enabled: h.enabled });
      }
    }
    return all;
  }

  getStats() {
    const stats = {};
    for (const [phase, handlers] of this.hooks) {
      stats[phase] = handlers.length;
    }
    return { totalHooks: this.list().length, byPhase: stats };
  }
}

// ── Background Workers ───────────────────────────────────────────────────────
// Inspired by Ruflo's 12 auto-triggered background workers.

class BackgroundWorker {
  constructor(config) {
    this.id = config.id;
    this.name = config.name;
    this.trigger = config.trigger; // 'post_task' | 'periodic' | 'on_event'
    this.intervalMs = config.intervalMs || 0;
    this.handler = config.handler;
    this.enabled = config.enabled !== false;
    this.lastRun = null;
    this.runCount = 0;
    this.errorCount = 0;
    this._intervalId = null;
  }

  start() {
    if (this.trigger === 'periodic' && this.intervalMs > 0) {
      this._intervalId = setInterval(async () => {
        if (!this.enabled) return;
        await this.execute();
      }, this.intervalMs);
    }
  }

  stop() {
    if (this._intervalId) {
      clearInterval(this._intervalId);
      this._intervalId = null;
    }
  }

  async execute(payload = {}) {
    if (!this.enabled || !this.handler) return null;
    this.lastRun = Date.now();
    this.runCount++;
    try {
      return await this.handler(payload);
    } catch (err) {
      this.errorCount++;
      console.warn(`[BackgroundWorker:${this.id}] Error:`, err.message);
      return { error: err.message };
    }
  }

  getStatus() {
    return {
      id: this.id,
      name: this.name,
      trigger: this.trigger,
      enabled: this.enabled,
      runCount: this.runCount,
      errorCount: this.errorCount,
      lastRun: this.lastRun ? new Date(this.lastRun).toISOString() : null,
      running: !!this._intervalId
    };
  }
}

class WorkerPool {
  constructor() {
    this.workers = new Map();
  }

  addWorker(config) {
    const worker = new BackgroundWorker(config);
    this.workers.set(worker.id, worker);
    return worker;
  }

  removeWorker(id) {
    const worker = this.workers.get(id);
    if (worker) {
      worker.stop();
      this.workers.delete(id);
      return true;
    }
    return false;
  }

  startAll() {
    for (const worker of this.workers.values()) {
      worker.start();
    }
  }

  stopAll() {
    for (const worker of this.workers.values()) {
      worker.stop();
    }
  }

  // Trigger all workers matching a specific trigger type
  async triggerByEvent(triggerType, payload = {}) {
    const results = [];
    for (const worker of this.workers.values()) {
      if (worker.trigger === triggerType && worker.enabled) {
        const result = await worker.execute(payload);
        results.push({ workerId: worker.id, result });
      }
    }
    return results;
  }

  getStatus() {
    return [...this.workers.values()].map(w => w.getStatus());
  }

  dispose() {
    this.stopAll();
    this.workers.clear();
  }
}

module.exports = { HookRegistry, BackgroundWorker, WorkerPool };
