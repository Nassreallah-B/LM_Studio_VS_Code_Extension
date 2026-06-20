'use strict';

// ── Multi-Provider LLM Router ────────────────────────────────────────────────
// Inspired by Ruflo's 5-provider support with smart routing and failover.
// Supports HuggingFace (default), OpenAI-compatible, Ollama, and Anthropic.

const http = require('http');
const https = require('https');
const zlib = require('zlib');

// ── Provider Definitions ─────────────────────────────────────────────────────
const PROVIDER_TEMPLATES = {
  'huggingface': {
    name: 'HuggingFace Router',
    host: 'router.huggingface.co',
    basePath: '/v1',
    authHeader: 'Authorization',
    authPrefix: 'Bearer ',
    protocol: 'https',
    supportsStreaming: true,
    format: 'openai'
  },
  'openai': {
    name: 'OpenAI',
    host: 'api.openai.com',
    basePath: '/v1',
    authHeader: 'Authorization',
    authPrefix: 'Bearer ',
    protocol: 'https',
    supportsStreaming: true,
    format: 'openai'
  },
  'openrouter': {
    name: 'OpenRouter',
    host: 'openrouter.ai',
    basePath: '/api/v1',
    authHeader: 'Authorization',
    authPrefix: 'Bearer ',
    protocol: 'https',
    supportsStreaming: true,
    format: 'openai'
  },
  'ollama': {
    name: 'Ollama (Local)',
    host: 'localhost',
    port: 11434,
    basePath: '/v1',
    authHeader: null,
    authPrefix: '',
    protocol: 'http',
    supportsStreaming: true,
    format: 'openai'
  },
  'anthropic': {
    name: 'Anthropic',
    host: 'api.anthropic.com',
    basePath: '/v1',
    authHeader: 'x-api-key',
    authPrefix: '',
    protocol: 'https',
    supportsStreaming: true,
    format: 'anthropic',
    extraHeaders: { 'anthropic-version': '2023-06-01' }
  },
  'custom': {
    name: 'Custom OpenAI-Compatible',
    host: '',
    basePath: '/v1',
    authHeader: 'Authorization',
    authPrefix: 'Bearer ',
    protocol: 'https',
    supportsStreaming: true,
    format: 'openai'
  }
};

// ── Provider Router ──────────────────────────────────────────────────────────
class ProviderRouter {
  constructor() {
    this.providers = new Map();
    this.healthStatus = new Map();
    this.routingMode = 'failover'; // failover | round-robin | cost-optimized
    this._lastUsedIndex = -1;
  }

  // Add or update a provider configuration
  addProvider(id, config) {
    const template = PROVIDER_TEMPLATES[config.type || 'custom'] || PROVIDER_TEMPLATES.custom;
    const provider = {
      id,
      ...template,
      ...config,
      enabled: config.enabled !== false,
      priority: config.priority || 0,
      failCount: 0,
      lastFailure: null,
      lastSuccess: null,
      avgLatencyMs: 0,
      totalCalls: 0
    };
    this.providers.set(id, provider);
    this.healthStatus.set(id, { healthy: true, lastCheck: null });
  }

  removeProvider(id) {
    this.providers.delete(id);
    this.healthStatus.delete(id);
  }

  setRoutingMode(mode) {
    if (['failover', 'round-robin', 'cost-optimized'].includes(mode)) {
      this.routingMode = mode;
    }
  }

  // Get the next provider to try based on routing mode
  getNextProvider() {
    const enabled = [...this.providers.values()]
      .filter(p => p.enabled)
      .filter(p => {
        const health = this.healthStatus.get(p.id);
        if (!health || health.healthy) return true;
        // Allow retry after 60 seconds
        const cooldown = Date.now() - (health.lastCheck || 0);
        return cooldown > 60000;
      });

    if (enabled.length === 0) return null;

    switch (this.routingMode) {
      case 'round-robin': {
        this._lastUsedIndex = (this._lastUsedIndex + 1) % enabled.length;
        return enabled[this._lastUsedIndex];
      }
      case 'cost-optimized': {
        // Prefer providers with lowest latency and highest success rate
        return enabled.sort((a, b) => {
          const scoreA = a.avgLatencyMs * (a.failCount + 1);
          const scoreB = b.avgLatencyMs * (b.failCount + 1);
          return scoreA - scoreB;
        })[0];
      }
      case 'failover':
      default: {
        // Try by priority, skip failed ones
        return enabled.sort((a, b) => a.priority - b.priority)[0];
      }
    }
  }

  // Get ordered list of providers to try (for failover)
  getProviderChain() {
    return [...this.providers.values()]
      .filter(p => p.enabled)
      .sort((a, b) => a.priority - b.priority);
  }

  // Record a successful call
  recordSuccess(providerId, latencyMs) {
    const provider = this.providers.get(providerId);
    if (provider) {
      provider.totalCalls++;
      provider.lastSuccess = Date.now();
      provider.avgLatencyMs = provider.avgLatencyMs
        ? (provider.avgLatencyMs * 0.8 + latencyMs * 0.2)
        : latencyMs;
      provider.failCount = Math.max(0, provider.failCount - 1);
    }
    this.healthStatus.set(providerId, { healthy: true, lastCheck: Date.now() });
  }

  // Record a failed call
  recordFailure(providerId, error) {
    const provider = this.providers.get(providerId);
    if (provider) {
      provider.totalCalls++;
      provider.failCount++;
      provider.lastFailure = Date.now();
    }
    // Mark unhealthy after 3 consecutive failures
    if (provider && provider.failCount >= 3) {
      this.healthStatus.set(providerId, { healthy: false, lastCheck: Date.now(), error: String(error) });
    }
  }

  // Build the request for a specific provider
  buildRequest(provider, body, apiKey) {
    const url = new URL(`${provider.protocol}://${provider.host}${provider.port ? ':' + provider.port : ''}${provider.basePath}/chat/completions`);

    const headers = {
      'Content-Type': 'application/json',
      'Accept': 'text/event-stream',
      ...(provider.extraHeaders || {})
    };

    if (provider.authHeader && apiKey) {
      headers[provider.authHeader] = `${provider.authPrefix}${apiKey}`;
    }

    // Convert body format for Anthropic if needed
    let requestBody = body;
    if (provider.format === 'anthropic') {
      requestBody = this._convertToAnthropicFormat(body);
    }

    return { url, headers, body: requestBody };
  }

  // Get provider status summary
  getStatus() {
    return [...this.providers.values()].map(p => ({
      id: p.id,
      name: p.name,
      enabled: p.enabled,
      healthy: (this.healthStatus.get(p.id) || {}).healthy !== false,
      totalCalls: p.totalCalls,
      failCount: p.failCount,
      avgLatencyMs: Math.round(p.avgLatencyMs),
      lastSuccess: p.lastSuccess ? new Date(p.lastSuccess).toISOString() : null,
      lastFailure: p.lastFailure ? new Date(p.lastFailure).toISOString() : null
    }));
  }

  // ── Private helpers ────────────────────────────────────────────────────────
  _convertToAnthropicFormat(openaiBody) {
    const messages = (openaiBody.messages || []).filter(m => m.role !== 'system');
    const systemMessages = (openaiBody.messages || []).filter(m => m.role === 'system');
    const system = systemMessages.map(m => m.content).join('\n\n');

    return {
      model: openaiBody.model,
      max_tokens: openaiBody.max_tokens || 4096,
      system: system || undefined,
      messages: messages.map(m => ({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: m.content
      })),
      stream: openaiBody.stream
    };
  }
}

// ── Smart Task Router ────────────────────────────────────────────────────────
// Routes tasks to the optimal agent type based on keywords and past performance.

const ROUTING_RULES = [
  { keywords: ['sql', 'rls', 'migration', 'database', 'postgres', 'supabase', 'schema', 'table', 'index', 'trigger', 'policy'], agent: 'database-expert', confidence: 0.85 },
  { keywords: ['rtl', 'arabic', 'css', 'tailwind', 'ui', 'design', 'layout', 'responsive', 'glassmorphism', 'animation', 'hover', 'gradient'], agent: 'rtl-ui-auditor', confidence: 0.80 },
  { keywords: ['security', 'audit', 'vulnerability', 'xss', 'csrf', 'injection', 'owasp', 'secrets', 'password', 'token', 'auth'], agent: 'security-sentinel', confidence: 0.90 },
  { keywords: ['refactor', 'clean', 'solid', 'debt', 'duplicate', 'extract', 'modularize', 'split', 'organize', 'architecture'], agent: 'refactoring-expert', confidence: 0.80 },
  { keywords: ['performance', 'speed', 'memory', 'leak', 'bundle', 'lighthouse', 'core web vitals', 'optimization', 'cache'], agent: 'performance-monitor', confidence: 0.75 },
  { keywords: ['convention', 'onboarding', 'readme', 'documentation', 'standard', 'guideline', 'setup'], agent: 'onboarding-expert', confidence: 0.70 }
];

function routeTaskToAgent(prompt, learningEngine) {
  const text = String(prompt || '').toLowerCase();
  let bestMatch = { agent: 'general-purpose', confidence: 0, reason: 'default' };

  for (const rule of ROUTING_RULES) {
    const matchCount = rule.keywords.filter(k => text.includes(k)).length;
    const matchRatio = matchCount / rule.keywords.length;
    const adjustedConfidence = matchRatio * rule.confidence;

    if (adjustedConfidence > bestMatch.confidence && matchCount >= 2) {
      bestMatch = {
        agent: rule.agent,
        confidence: Math.round(adjustedConfidence * 100) / 100,
        reason: `Matched ${matchCount} keywords: ${rule.keywords.filter(k => text.includes(k)).join(', ')}`,
        matchedKeywords: rule.keywords.filter(k => text.includes(k))
      };
    }
  }

  // Learning engine override: if past tasks with this agent failed, try alternative
  if (learningEngine && bestMatch.agent !== 'general-purpose') {
    const recommendation = learningEngine.recommendToolSequence(prompt, bestMatch.agent);
    if (recommendation && recommendation.confidence > 0.7) {
      bestMatch.learningBoost = true;
      bestMatch.pastSuccess = recommendation.basedOn;
    }
  }

  return bestMatch;
}

module.exports = {
  PROVIDER_TEMPLATES,
  ProviderRouter,
  routeTaskToAgent,
  ROUTING_RULES
};
