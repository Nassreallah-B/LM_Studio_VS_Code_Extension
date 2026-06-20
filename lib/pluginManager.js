'use strict';

// ── Plugin System ────────────────────────────────────────────────────────────
// Inspired by Ruflo's 32-plugin marketplace architecture.
// Plugins can register tools, agents, hooks, and context providers.

const fs = require('fs');
const path = require('path');

class PluginManager {
  constructor(pluginDirs = []) {
    this.pluginDirs = pluginDirs;
    this.plugins = new Map();
    this.registeredTools = new Map();
    this.registeredAgents = new Map();
    this.registeredHooks = [];
    this.registeredContextProviders = [];
  }

  // ── Load plugins from directories ──────────────────────────────────────
  loadAll() {
    for (const dir of this.pluginDirs) {
      if (!fs.existsSync(dir)) continue;
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const manifestPath = path.join(dir, entry.name, 'plugin.json');
        if (!fs.existsSync(manifestPath)) continue;
        try {
          this.loadPlugin(path.join(dir, entry.name), manifestPath);
        } catch (err) {
          console.warn(`[PluginManager] Failed to load plugin ${entry.name}:`, err.message);
        }
      }
    }
    return this.getStatus();
  }

  loadPlugin(pluginDir, manifestPath) {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const id = manifest.id || path.basename(pluginDir);

    // Validate manifest
    if (!manifest.name) throw new Error(`Plugin manifest missing 'name' field`);

    const plugin = {
      id,
      name: manifest.name,
      version: manifest.version || '0.0.0',
      description: manifest.description || '',
      author: manifest.author || '',
      dir: pluginDir,
      manifest,
      enabled: manifest.enabled !== false,
      loadedAt: new Date().toISOString()
    };

    // Register tools
    if (Array.isArray(manifest.tools)) {
      for (const toolDef of manifest.tools) {
        if (!toolDef.name) continue;
        const tool = {
          ...toolDef,
          pluginId: id,
          handler: null
        };
        // Load handler if specified
        if (toolDef.handler) {
          const handlerPath = path.join(pluginDir, toolDef.handler);
          if (fs.existsSync(handlerPath)) {
            try {
              tool.handler = require(handlerPath);
            } catch (err) {
              console.warn(`[PluginManager] Failed to load handler for tool ${toolDef.name}:`, err.message);
            }
          }
        }
        this.registeredTools.set(`${id}:${toolDef.name}`, tool);
      }
    }

    // Register agents
    if (Array.isArray(manifest.agents)) {
      for (const agentDef of manifest.agents) {
        if (!agentDef.type) continue;
        this.registeredAgents.set(`${id}:${agentDef.type}`, {
          ...agentDef,
          pluginId: id
        });
      }
    }

    // Register hooks
    if (Array.isArray(manifest.hooks)) {
      for (const hookDef of manifest.hooks) {
        this.registeredHooks.push({
          ...hookDef,
          pluginId: id
        });
      }
    }

    // Register context providers
    if (Array.isArray(manifest.contextProviders)) {
      for (const providerDef of manifest.contextProviders) {
        const provider = { ...providerDef, pluginId: id, handler: null };
        if (providerDef.handler) {
          const handlerPath = path.join(pluginDir, providerDef.handler);
          if (fs.existsSync(handlerPath)) {
            try { provider.handler = require(handlerPath); } catch (_) {}
          }
        }
        this.registeredContextProviders.push(provider);
      }
    }

    this.plugins.set(id, plugin);
    return plugin;
  }

  // ── Plugin queries ─────────────────────────────────────────────────────
  getPlugin(id) {
    return this.plugins.get(id) || null;
  }

  listPlugins() {
    return [...this.plugins.values()].map(p => ({
      id: p.id,
      name: p.name,
      version: p.version,
      description: p.description,
      enabled: p.enabled,
      toolCount: [...this.registeredTools.values()].filter(t => t.pluginId === p.id).length,
      agentCount: [...this.registeredAgents.values()].filter(a => a.pluginId === p.id).length,
      hookCount: this.registeredHooks.filter(h => h.pluginId === p.id).length
    }));
  }

  getToolSpecs() {
    return [...this.registeredTools.values()]
      .filter(t => this.plugins.get(t.pluginId)?.enabled)
      .map(t => ({
        name: t.name,
        description: t.description || '',
        example: t.example || '',
        pluginId: t.pluginId
      }));
  }

  getAgentTypes() {
    return [...this.registeredAgents.values()]
      .filter(a => this.plugins.get(a.pluginId)?.enabled);
  }

  getHooks(phase) {
    return this.registeredHooks
      .filter(h => this.plugins.get(h.pluginId)?.enabled)
      .filter(h => !phase || h.phase === phase);
  }

  getContextProviders() {
    return this.registeredContextProviders
      .filter(p => this.plugins.get(p.pluginId)?.enabled);
  }

  // ── Execute a plugin tool ──────────────────────────────────────────────
  async executeTool(toolName, input, context = {}) {
    // Find the tool across all plugins
    let tool = null;
    for (const [key, t] of this.registeredTools) {
      if (t.name === toolName && this.plugins.get(t.pluginId)?.enabled) {
        tool = t;
        break;
      }
    }
    if (!tool) return { ok: false, error: `Plugin tool '${toolName}' not found` };
    if (!tool.handler || typeof tool.handler.execute !== 'function') {
      return { ok: false, error: `Plugin tool '${toolName}' has no executable handler` };
    }

    try {
      const result = await tool.handler.execute(input, context);
      return { ok: true, result, pluginId: tool.pluginId };
    } catch (err) {
      return { ok: false, error: err.message, pluginId: tool.pluginId };
    }
  }

  // ── Run hooks for a phase ──────────────────────────────────────────────
  async runHooks(phase, payload = {}) {
    const hooks = this.getHooks(phase);
    const results = [];
    for (const hook of hooks) {
      if (hook.handler) {
        const handlerPath = path.join(this.plugins.get(hook.pluginId)?.dir || '', hook.handler);
        if (fs.existsSync(handlerPath)) {
          try {
            const mod = require(handlerPath);
            if (typeof mod.execute === 'function') {
              const result = await mod.execute(payload);
              results.push({ pluginId: hook.pluginId, phase, result });
            }
          } catch (err) {
            results.push({ pluginId: hook.pluginId, phase, error: err.message });
          }
        }
      }
    }
    return results;
  }

  // ── Enable/disable ─────────────────────────────────────────────────────
  enablePlugin(id) {
    const plugin = this.plugins.get(id);
    if (plugin) { plugin.enabled = true; return true; }
    return false;
  }

  disablePlugin(id) {
    const plugin = this.plugins.get(id);
    if (plugin) { plugin.enabled = false; return true; }
    return false;
  }

  getStatus() {
    return {
      pluginCount: this.plugins.size,
      enabledCount: [...this.plugins.values()].filter(p => p.enabled).length,
      toolCount: this.registeredTools.size,
      agentCount: this.registeredAgents.size,
      hookCount: this.registeredHooks.length,
      contextProviderCount: this.registeredContextProviders.length
    };
  }
}

// ── Plugin Manifest Schema ───────────────────────────────────────────────────
// Example plugin.json:
// {
//   "id": "design-system",
//   "name": "Design System Generator",
//   "version": "1.0.0",
//   "description": "UI/UX Pro Max design system generation",
//   "author": "CloudZIR",
//   "tools": [
//     {
//       "name": "generate_design_system",
//       "description": "Generate a complete design system",
//       "example": "{\"query\":\"beauty spa\",\"projectName\":\"Spa\"}",
//       "handler": "tools/designSystem.js"
//     }
//   ],
//   "agents": [
//     {
//       "type": "design-system-expert",
//       "title": "Design System Expert",
//       "stepBudget": 20,
//       "systemPrompt": "You are a design system specialist..."
//     }
//   ],
//   "hooks": [
//     { "phase": "pre_prompt", "handler": "hooks/injectDesignContext.js" }
//   ],
//   "contextProviders": [
//     { "name": "design-system", "handler": "context/designProvider.js" }
//   ]
// }

module.exports = { PluginManager };
