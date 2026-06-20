'use strict';

// ── Swarm Topologies ─────────────────────────────────────────────────────────
// Inspired by Ruflo's multi-agent orchestration (mesh, pipeline, hub-spoke).
// Enables complex task decomposition across specialized agent types.

const crypto = require('crypto');

// ── Topology Types ───────────────────────────────────────────────────────────
const TOPOLOGY = {
  PIPELINE: 'pipeline',     // Sequential: Agent A → Agent B → Agent C
  HUB_SPOKE: 'hub-spoke',   // Central coordinator dispatches to specialist agents
  MESH: 'mesh',             // All agents can communicate with each other
  MAP_REDUCE: 'map-reduce', // Split task, process in parallel, merge results
  CHAIN: 'chain'            // Like pipeline but with feedback loops
};

// ── Swarm Task States ────────────────────────────────────────────────────────
const SWARM_STATE = {
  PENDING: 'pending',
  RUNNING: 'running',
  WAITING: 'waiting',     // Waiting for sub-agent results
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled'
};

// ── Agent Node ───────────────────────────────────────────────────────────────
class AgentNode {
  constructor(config) {
    this.id = config.id || `agent_${crypto.randomBytes(4).toString('hex')}`;
    this.agentType = config.agentType;       // e.g. 'database-expert', 'security-sentinel'
    this.role = config.role || '';            // Human-readable role description
    this.stepBudget = config.stepBudget || 15;
    this.state = SWARM_STATE.PENDING;
    this.input = null;
    this.output = null;
    this.error = null;
    this.startedAt = null;
    this.completedAt = null;
    this.dependencies = config.dependencies || []; // IDs of nodes that must complete first
    this.metadata = config.metadata || {};
  }

  toJSON() {
    return {
      id: this.id,
      agentType: this.agentType,
      role: this.role,
      state: this.state,
      stepBudget: this.stepBudget,
      hasOutput: this.output !== null,
      error: this.error,
      startedAt: this.startedAt,
      completedAt: this.completedAt,
      dependencies: this.dependencies
    };
  }
}

// ── Swarm Orchestrator ───────────────────────────────────────────────────────
class SwarmOrchestrator {
  constructor(options = {}) {
    this.topology = options.topology || TOPOLOGY.PIPELINE;
    this.nodes = new Map();
    this.edges = [];         // { from, to, condition }
    this.state = SWARM_STATE.PENDING;
    this.coordinatorId = options.coordinatorId || null;
    this.maxConcurrency = options.maxConcurrency || 3;
    this.timeoutMs = options.timeoutMs || 5 * 60 * 1000; // 5 min default
    this.onNodeComplete = options.onNodeComplete || null;
    this.onSwarmComplete = options.onSwarmComplete || null;
    this.results = new Map();
    this.executionLog = [];
  }

  // ── Build the swarm ────────────────────────────────────────────────────
  addNode(config) {
    const node = new AgentNode(config);
    this.nodes.set(node.id, node);
    return node;
  }

  addEdge(fromId, toId, condition = null) {
    this.edges.push({ from: fromId, to: toId, condition });
  }

  setCoordinator(nodeId) {
    this.coordinatorId = nodeId;
  }

  // ── Topology builders (convenience methods) ────────────────────────────

  // Pipeline: A → B → C (sequential)
  static pipeline(agents) {
    const swarm = new SwarmOrchestrator({ topology: TOPOLOGY.PIPELINE });
    let prevId = null;
    for (const agentConfig of agents) {
      const node = swarm.addNode(agentConfig);
      if (prevId) {
        swarm.addEdge(prevId, node.id);
        node.dependencies = [prevId];
      }
      prevId = node.id;
    }
    return swarm;
  }

  // Hub-Spoke: Central coordinator dispatches to specialist agents
  static hubSpoke(coordinatorConfig, specialistConfigs) {
    const swarm = new SwarmOrchestrator({ topology: TOPOLOGY.HUB_SPOKE });
    const hub = swarm.addNode({ ...coordinatorConfig, role: 'coordinator' });
    swarm.setCoordinator(hub.id);

    for (const specConfig of specialistConfigs) {
      const spoke = swarm.addNode(specConfig);
      swarm.addEdge(hub.id, spoke.id);
      spoke.dependencies = [hub.id];
    }
    return swarm;
  }

  // Map-Reduce: Split into parallel tasks, then merge
  static mapReduce(mapperConfigs, reducerConfig) {
    const swarm = new SwarmOrchestrator({ topology: TOPOLOGY.MAP_REDUCE });

    const mapperIds = [];
    for (const mapConfig of mapperConfigs) {
      const mapper = swarm.addNode({ ...mapConfig, role: 'mapper' });
      mapperIds.push(mapper.id);
    }

    const reducer = swarm.addNode({ ...reducerConfig, role: 'reducer' });
    reducer.dependencies = mapperIds;
    for (const mapperId of mapperIds) {
      swarm.addEdge(mapperId, reducer.id);
    }

    return swarm;
  }

  // ── Execution plan ─────────────────────────────────────────────────────
  getExecutionPlan() {
    const plan = [];
    const completed = new Set();
    const remaining = new Set(this.nodes.keys());

    while (remaining.size > 0) {
      const batch = [];
      for (const nodeId of remaining) {
        const node = this.nodes.get(nodeId);
        const depsReady = node.dependencies.every(dep => completed.has(dep));
        if (depsReady) {
          batch.push(nodeId);
        }
      }

      if (batch.length === 0 && remaining.size > 0) {
        // Circular dependency detected
        plan.push({ batch: [...remaining], warning: 'circular-dependency' });
        break;
      }

      // Respect max concurrency
      const limitedBatch = batch.slice(0, this.maxConcurrency);
      plan.push({ batch: limitedBatch, parallel: limitedBatch.length > 1 });

      for (const nodeId of limitedBatch) {
        completed.add(nodeId);
        remaining.delete(nodeId);
      }
    }

    return plan;
  }

  // ── Execute swarm (async, uses a provided agent runner function) ────────
  async execute(agentRunner) {
    this.state = SWARM_STATE.RUNNING;
    const startTime = Date.now();
    const plan = this.getExecutionPlan();

    this.executionLog.push({
      event: 'swarm_start',
      topology: this.topology,
      nodeCount: this.nodes.size,
      plan: plan.map(p => p.batch),
      timestamp: Date.now()
    });

    try {
      for (const step of plan) {
        if (Date.now() - startTime > this.timeoutMs) {
          throw new Error(`Swarm timed out after ${this.timeoutMs}ms`);
        }

        if (step.parallel && step.batch.length > 1) {
          // Execute batch in parallel
          const promises = step.batch.map(nodeId =>
            this._executeNode(nodeId, agentRunner)
          );
          await Promise.all(promises);
        } else {
          // Execute sequentially
          for (const nodeId of step.batch) {
            await this._executeNode(nodeId, agentRunner);
          }
        }
      }

      this.state = SWARM_STATE.COMPLETED;
      this.executionLog.push({
        event: 'swarm_complete',
        duration: Date.now() - startTime,
        results: this._collectResults(),
        timestamp: Date.now()
      });

      if (this.onSwarmComplete) {
        await this.onSwarmComplete(this._collectResults());
      }

      return this._collectResults();
    } catch (err) {
      this.state = SWARM_STATE.FAILED;
      this.executionLog.push({
        event: 'swarm_failed',
        error: err.message,
        duration: Date.now() - startTime,
        timestamp: Date.now()
      });
      throw err;
    }
  }

  async _executeNode(nodeId, agentRunner) {
    const node = this.nodes.get(nodeId);
    if (!node) throw new Error(`Node ${nodeId} not found`);

    node.state = SWARM_STATE.RUNNING;
    node.startedAt = Date.now();

    // Build input from dependencies' outputs
    const depOutputs = {};
    for (const depId of node.dependencies) {
      const dep = this.nodes.get(depId);
      if (dep && dep.output) {
        depOutputs[depId] = dep.output;
      }
    }

    node.input = {
      agentType: node.agentType,
      role: node.role,
      stepBudget: node.stepBudget,
      dependencyResults: depOutputs,
      metadata: node.metadata,
      swarmContext: {
        topology: this.topology,
        nodeId: node.id,
        totalNodes: this.nodes.size,
        isCoordinator: node.id === this.coordinatorId
      }
    };

    this.executionLog.push({
      event: 'node_start',
      nodeId: node.id,
      agentType: node.agentType,
      timestamp: Date.now()
    });

    try {
      const result = await agentRunner(node.input);
      node.output = result;
      node.state = SWARM_STATE.COMPLETED;
      node.completedAt = Date.now();
      this.results.set(node.id, result);

      this.executionLog.push({
        event: 'node_complete',
        nodeId: node.id,
        duration: node.completedAt - node.startedAt,
        timestamp: Date.now()
      });

      if (this.onNodeComplete) {
        await this.onNodeComplete(node, result);
      }
    } catch (err) {
      node.state = SWARM_STATE.FAILED;
      node.error = err.message;
      node.completedAt = Date.now();

      this.executionLog.push({
        event: 'node_failed',
        nodeId: node.id,
        error: err.message,
        duration: node.completedAt - node.startedAt,
        timestamp: Date.now()
      });

      // Don't fail the entire swarm for a single node failure in mesh/hub-spoke
      if (this.topology === TOPOLOGY.PIPELINE || this.topology === TOPOLOGY.CHAIN) {
        throw err; // Pipeline breaks on any failure
      }
    }
  }

  // ── Query state ────────────────────────────────────────────────────────
  _collectResults() {
    return {
      topology: this.topology,
      state: this.state,
      nodes: [...this.nodes.values()].map(n => n.toJSON()),
      results: Object.fromEntries(this.results),
      executionLog: this.executionLog,
      completedCount: [...this.nodes.values()].filter(n => n.state === SWARM_STATE.COMPLETED).length,
      failedCount: [...this.nodes.values()].filter(n => n.state === SWARM_STATE.FAILED).length,
      totalNodes: this.nodes.size
    };
  }

  getStatus() {
    return {
      topology: this.topology,
      state: this.state,
      nodeCount: this.nodes.size,
      completed: [...this.nodes.values()].filter(n => n.state === SWARM_STATE.COMPLETED).length,
      failed: [...this.nodes.values()].filter(n => n.state === SWARM_STATE.FAILED).length,
      running: [...this.nodes.values()].filter(n => n.state === SWARM_STATE.RUNNING).length,
      pending: [...this.nodes.values()].filter(n => n.state === SWARM_STATE.PENDING).length,
      nodes: [...this.nodes.values()].map(n => n.toJSON())
    };
  }

  cancel() {
    this.state = SWARM_STATE.CANCELLED;
    for (const node of this.nodes.values()) {
      if (node.state === SWARM_STATE.PENDING || node.state === SWARM_STATE.RUNNING) {
        node.state = SWARM_STATE.CANCELLED;
      }
    }
  }
}

// ── Task Decomposer ──────────────────────────────────────────────────────────
// Splits a complex task prompt into a swarm of specialized agent tasks.

function decomposeTask(prompt, availableAgents = []) {
  const promptLower = prompt.toLowerCase();
  const subtasks = [];

  // Pattern matching for common multi-domain tasks
  const domainKeywords = {
    'database-expert': ['sql', 'database', 'migration', 'rls', 'schema', 'table', 'query', 'index', 'supabase'],
    'security-sentinel': ['security', 'vulnerability', 'xss', 'csrf', 'injection', 'auth', 'permission', 'owasp'],
    'rtl-ui-auditor': ['css', 'ui', 'layout', 'rtl', 'responsive', 'design', 'component', 'style', 'tailwind'],
    'api-architect': ['api', 'endpoint', 'rest', 'graphql', 'webhook', 'route', 'middleware'],
    'test-engineer': ['test', 'coverage', 'vitest', 'playwright', 'e2e', 'unit test', 'assertion'],
    'general-purpose': []
  };

  const detectedDomains = [];
  for (const [agent, keywords] of Object.entries(domainKeywords)) {
    const matches = keywords.filter(k => promptLower.includes(k));
    if (matches.length > 0) {
      detectedDomains.push({ agent, matches, score: matches.length });
    }
  }

  // Sort by relevance
  detectedDomains.sort((a, b) => b.score - a.score);

  if (detectedDomains.length <= 1) {
    // Single domain — no decomposition needed
    return {
      decomposed: false,
      topology: null,
      reason: 'Single-domain task, no decomposition needed',
      suggestedAgent: detectedDomains[0]?.agent || 'general-purpose'
    };
  }

  // Multi-domain task — create subtasks
  for (const domain of detectedDomains) {
    subtasks.push({
      agentType: domain.agent,
      role: `Handle ${domain.matches.join(', ')} aspects`,
      stepBudget: Math.max(8, Math.min(20, domain.score * 5)),
      metadata: { matchedKeywords: domain.matches, score: domain.score }
    });
  }

  // Choose topology based on task nature
  let suggestedTopology = TOPOLOGY.PIPELINE;
  if (detectedDomains.length >= 3) {
    suggestedTopology = TOPOLOGY.HUB_SPOKE;
  } else if (promptLower.includes('parallel') || promptLower.includes('simultanément')) {
    suggestedTopology = TOPOLOGY.MAP_REDUCE;
  }

  return {
    decomposed: true,
    topology: suggestedTopology,
    subtasks,
    reason: `Detected ${detectedDomains.length} domains: ${detectedDomains.map(d => d.agent).join(', ')}`
  };
}

module.exports = {
  TOPOLOGY,
  SWARM_STATE,
  AgentNode,
  SwarmOrchestrator,
  decomposeTask
};
