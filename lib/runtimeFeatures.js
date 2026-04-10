'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');

const MAX_EVENT_ENTRIES = 240;
const MAX_AGENT_LOG_ENTRIES = 120;
const MAX_PENDING_QUESTIONS = 80;
const MAX_TODO_ITEMS = 64;

const AGENT_TYPE_CATALOG = {
  'aria-orchestrator': {
    title: 'ARIA Lead Orchestrator',
    description: 'Lead Architect and Main Event Router. Expert at coordinating specialized agents and maintaining project vision.',
    readOnly: true,
    allowWrite: false,
    allowShell: false,
    allowSpawn: true,
    orchestrationOnly: true,
    instruction: 'You are ARIA, the Lead Orchestrator. Your role is to analyze complex needs, identify impact areas (UI, DB, Security), and delegate to specialized subagents. Do not code directly; coordinate, verify proofs of test, and provide the final GO for deployment. IMPORTANT: You MUST report your current phase at the start of your message using `[PHASE: PLANNING]`, `[PHASE: EXECUTION]`, or `[PHASE: VERIFICATION]`.'
  },
  'general-purpose': {
    title: 'General Purpose',
    description: 'Generalist coding agent for multi-step implementation and debugging. Follows ARIA standards.',
    readOnly: false,
    allowWrite: true,
    allowShell: true,
    allowSpawn: true,
    orchestrationOnly: false,
    instruction: 'Act as a high-performance execution agent. Follow Clean Code principles, SOLID patterns, and project conventions. Every UI change must follow "Premium" standards (Gradients, Glassmorphism). IMPORTANT: Report your phase at the start of your message using `[PHASE: PLANNING]`, `[PHASE: EXECUTION]`, or `[PHASE: VERIFICATION]`.'
  },
  'rtl-ui-auditor': {
    title: 'RTL UI Auditor',
    description: 'Expert in Arabic/RTL, Internationalization, and Premium design standards (Tailwind, Shadcn).',
    readOnly: true,
    allowWrite: false,
    allowShell: false,
    allowSpawn: false,
    orchestrationOnly: false,
    instruction: 'Audit UI components for RTL support, accessibility (A11y), and "Premium" aesthetics. Ensure fluid transitions between FR/EN and Arabic (RTL). Master of Glassmorphism and Outfit typography.'
  },
  'database-expert': {
    title: 'Database Expert',
    description: 'PostgreSQL and Supabase specialist. Focused on schema integrity, complex SQL, and RLS policies.',
    readOnly: true,
    allowWrite: false,
    allowShell: true,
    allowSpawn: false,
    orchestrationOnly: false,
    instruction: 'Analyze and design PostgreSQL structures. Ensure strict multi-tenant isolation via RLS (user_id/tenant_id). Optimize queries and design robust migrations. Request Security Audit for any RLS change.'
  },
  'security-sentinel': {
    title: 'Security Sentinel',
    description: 'Permanent security guardian. Inspects Row Level Security (RLS) and detects vulnerabilities.',
    readOnly: true,
    allowWrite: false,
    allowShell: true,
    allowSpawn: false,
    orchestrationOnly: false,
    instruction: 'Inspect changes for OWASP risks, SQL injections, and secret leaks. You MUST provide a verdict: [VERDICT: PASS], [VERDICT: FAIL], or [VERDICT: PARTIAL]. Your approval is mandatory for any deployment.'
  },
  'refactoring-expert': {
    title: 'Refactoring Expert',
    description: 'Technical debt specialist and master of Clean Code. Authorized for large-scale code modernization.',
    readOnly: false,
    allowWrite: true,
    allowShell: true,
    allowSpawn: false,
    orchestrationOnly: false,
    instruction: 'Identify and cleanup technical debt. Extract reusable hooks/components, enforce strict TS types, and reduce complexity. Your decision on implementation patterns is final. Procceed incrementally.'
  },
  'performance-monitor': {
    title: 'Performance Monitor',
    description: 'Guardian of production metrics and performance. Expert in Core Web Vitals and error tracking.',
    readOnly: true,
    allowWrite: false,
    allowShell: true,
    allowSpawn: false,
    orchestrationOnly: false,
    instruction: 'Analyze performance logs and monitor Core Web Vitals. Identify bottlenecks and recommend optimizations. Coordinate with Database Expert for query performance.'
  },
  'onboarding-expert': {
    title: 'Onboarding Expert',
    description: 'Guardian of project conventions and architectural integrity.',
    readOnly: true,
    allowWrite: false,
    allowShell: false,
    allowSpawn: false,
    orchestrationOnly: false,
    instruction: 'Ensure every contribution adheres to project documentation and standards. Verify that migrations and features follow established patterns. Use the AGENTS_GUIDE.md as your source of truth.'
  },
  'Explore': {
    title: 'Explore',
    description: 'Fast read-only explorer focused on code search and architecture mapping.',
    readOnly: true,
    allowWrite: false,
    allowShell: false,
    allowSpawn: false,
    orchestrationOnly: false,
    instruction: 'Focus on discovery and mapping. Locate suspicious code or missing connections. Do not modify files.'
  },
  'Plan': {
    title: 'Plan',
    description: 'Read-only planning agent for architecture and sequencing.',
    readOnly: true,
    allowWrite: false,
    allowShell: false,
    allowSpawn: false,
    orchestrationOnly: false,
    instruction: 'Produce implementation plans and sequence charts. Analyze risks and trade-offs. No execution.'
  },
  'verification': {
    title: 'Verification',
    description: 'Quality validator. Runs tests and produces a Final Verdict.',
    readOnly: true,
    allowWrite: false,
    allowShell: true,
    allowSpawn: false,
    orchestrationOnly: false,
    instruction: 'Verify claims and run regression tests. Every task must end with [VERDICT: PASS], [VERDICT: FAIL], or [VERDICT: PARTIAL].'
  },
  'worker': {
    title: 'Worker',
    description: 'Execution agent for a narrow slice of work. Follows ARIA Lead instructions.',
    readOnly: false,
    allowWrite: true,
    allowShell: true,
    allowSpawn: false,
    orchestrationOnly: false,
    instruction: 'Execute a specific task slice with high precision. Preference for concrete changes and validation.'
  },
  'team-lead': {
    title: 'Team Lead',
    description: 'Coordinator agent for multi-agent squads.',
    readOnly: true,
    allowWrite: false,
    allowShell: false,
    allowSpawn: true,
    orchestrationOnly: true,
    instruction: 'Delegate to specialized workers and collect results. Request verification for all work.'
  },
  'fork': {
    title: 'Fork',
    description: 'Context-inheriting branch agent.',
    readOnly: false,
    allowWrite: true,
    allowShell: true,
    allowSpawn: true,
    orchestrationOnly: false,
    instruction: 'Pursue a new branch of thought while maintaining context continuity from the parent.'
  },
  'guide': {
    title: 'Guide',
    description: 'Instructional support for architecture and project usage.',
    readOnly: true,
    allowWrite: false,
    allowShell: false,
    allowSpawn: false,
    orchestrationOnly: false,
    instruction: 'Provide documentation and guidance. Focus on "How-To" and "Why" over direct implementation.'
  }
};

const ADVANCED_AGENT_TOOL_SPECS = [
  { name: 'spawn_agent', description: 'Spawn a named subagent or remote/background agent.', example: '{"description":"Audit parser","prompt":"Review the parser for edge cases","subagent_type":"Explore","run_in_background":true,"name":"parser-audit"}' },
  { name: 'send_message', description: 'Send a follow-up message to an existing agent.', example: '{"to":"agent_123","message":"Focus only on tests and edge cases."}' },
  { name: 'wait_agent', description: 'Wait for one or more agents to finish or time out.', example: '{"targets":["agent_123"],"timeoutMs":30000,"returnWhen":"all"}' },
  { name: 'stop_agent', description: 'Stop a pending or running agent.', example: '{"agentId":"agent_123"}' },
  { name: 'resume_agent', description: 'Resume a stopped, failed, awaiting-user, or interrupted agent.', example: '{"agentId":"agent_123","message":"Continue with the same plan."}' },
  { name: 'fork_agent', description: 'Fork an agent or task into a new branch with optional new goal.', example: '{"agentId":"agent_123","prompt":"Try a safer implementation","name":"safe-branch"}' },
  { name: 'list_agents', description: 'List recent agents and their current state.', example: '{}' },
  { name: 'get_agent', description: 'Inspect one agent, including logs, todos, and linked task.', example: '{"agentId":"agent_123"}' },
  { name: 'create_team', description: 'Create a logical agent team.', example: '{"team_name":"migration","description":"Migration strike team","agent_type":"team-lead"}' },
  { name: 'list_teams', description: 'List known teams and members.', example: '{}' },
  { name: 'delete_team', description: 'Delete a logical team record.', example: '{"teamId":"team_123"}' },
  { name: 'orchestrate_team', description: 'Create a lead, workers, and optional verifier for a multi-agent objective.', example: '{"goal":"Migrate auth module","aspects":["backend","tests","docs"],"teamName":"auth-squad","verify":true}' },
  { name: 'task_output', description: 'Return the output, status, and logs of one task.', example: '{"taskId":"task_123"}' },
  { name: 'task_update', description: 'Update metadata on a task, such as title, priority, or custom labels.', example: '{"taskId":"task_123","changes":{"title":"Parser audit","labels":["audit"]}}' },
  { name: 'todo_write', description: 'Replace or merge the todo list for an agent.', example: '{"agentId":"agent_123","mode":"replace","todos":[{"text":"Add parser regression tests","done":false}]}' },
  { name: 'web_fetch', description: 'Fetch a web page and return normalized text content.', example: '{"url":"https://example.com/docs","maxChars":4000}' },
  { name: 'web_search', description: 'Run a lightweight web search and return top results.', example: '{"query":"VS Code WebviewViewProvider documentation","limit":5}' },
  { name: 'list_hooks', description: 'List configured runtime hooks and policies.', example: '{}' },
  { name: 'upsert_hook', description: 'Create or update a hook or policy.', example: '{"phase":"pre_tool","name":"block-delete","match":{"toolNames":["delete_path"]},"action":"block","message":"Deletion requires manual review."}' },
  { name: 'delete_hook', description: 'Delete a hook or policy by id.', example: '{"hookId":"hook_123"}' },
  { name: 'list_mcp_profiles', description: 'List stored MCP profiles and live connections.', example: '{}' },
  { name: 'upsert_mcp_profile', description: 'Create or replace an MCP profile.', example: '{"name":"local","description":"Local profile","connections":[{"name":"docs","config":{"transport":"static","resources":[{"id":"readme","label":"README","content":"Hello"}]}}]}' },
  { name: 'activate_mcp_profile', description: 'Activate an MCP profile by name.', example: '{"name":"local"}' },
  { name: 'deactivate_mcp_profile', description: 'Deactivate the current MCP profile.', example: '{}' },
  { name: 'mcp_connect', description: 'Connect one MCP-like manifest source or static resource catalog.', example: '{"name":"docs","config":{"transport":"static","resources":[{"id":"arch","label":"Architecture","content":"..."}]}}' },
  { name: 'mcp_disconnect', description: 'Disconnect an MCP-like manifest source.', example: '{"name":"docs"}' },
  { name: 'mcp_list_resources', description: 'List available MCP-like resources.', example: '{"connection":"docs"}' },
  { name: 'mcp_read_resource', description: 'Read one MCP-like resource.', example: '{"connection":"docs","resourceId":"arch"}' },
  { name: 'mcp_list_tools', description: 'List tools published by connected MCP-like catalogs.', example: '{"connection":"docs"}' },
  { name: 'get_onboarding', description: 'Read the stored project onboarding summary, commands, risks, and conventions.', example: '{}' },
  { name: 'update_onboarding', description: 'Update onboarding memory for this workspace.', example: '{"summary":"Monorepo with API and web app","commands":{"test":"npm test"},"conventions":["Use absolute imports"]}' },
  { name: 'list_events', description: 'Read recent runtime, tool, and audit events.', example: '{"limit":20}' }
];

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

function appendJsonLine(filePath, value) {
  ensureDirSync(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`, 'utf8');
}

function createId(prefix) {
  return `${prefix}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
}

function truncateText(text, maxChars) {
  const value = String(text || '');
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 3))}...`;
}

function normalizeWhitespace(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function htmlDecode(value) {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x2F;/g, '/');
}

function httpRequest(urlString, options = {}) {
  return new Promise((resolve, reject) => {
    const targetUrl = new URL(urlString);
    const transport = targetUrl.protocol === 'http:' ? http : https;
    const bodyText = options.body == null
      ? ''
      : (typeof options.body === 'string' ? options.body : JSON.stringify(options.body));
    const headers = {
      'Accept': options.accept || 'application/json, text/plain;q=0.8, */*;q=0.5',
      'User-Agent': options.userAgent || 'Code-Runtime/1.0',
      ...(options.headers || {})
    };
    if (bodyText && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
    if (bodyText && !headers['Content-Length']) headers['Content-Length'] = Buffer.byteLength(bodyText);

    const req = transport.request({
      protocol: targetUrl.protocol,
      hostname: targetUrl.hostname,
      port: targetUrl.port || (targetUrl.protocol === 'http:' ? 80 : 443),
      path: `${targetUrl.pathname}${targetUrl.search}`,
      method: options.method || 'GET',
      headers,
      timeout: options.timeoutMs || 30000
    }, (res) => {
      let raw = '';
      res.on('data', chunk => raw += chunk.toString('utf8'));
      res.on('end', () => resolve({
        statusCode: res.statusCode || 0,
        headers: res.headers,
        raw
      }));
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Request timeout after ${options.timeoutMs || 30000}ms`));
    });
    if (bodyText) req.write(bodyText);
    req.end();
  });
}

function normalizeAgentType(agentType) {
  const value = String(agentType || '').trim();
  if (!value) return 'general-purpose';
  return AGENT_TYPE_CATALOG[value] ? value : 'general-purpose';
}

function agentDefinition(agentType) {
  return AGENT_TYPE_CATALOG[normalizeAgentType(agentType)] || AGENT_TYPE_CATALOG['general-purpose'];
}

function buildAgentRolePromptSection(agentType) {
  const normalized = normalizeAgentType(agentType);
  const definition = agentDefinition(normalized);
  const rules = [];
  if (definition.readOnly) rules.push('Stay read-only.');
  if (!definition.allowWrite) rules.push('Do not use write/delete patch-producing tools.');
  if (!definition.allowShell) rules.push('Avoid shell execution.');
  if (!definition.allowSpawn) rules.push('Do not spawn other agents.');
  if (definition.orchestrationOnly) rules.push('Coordinate other agents instead of editing files directly.');
  return [
    `[Agent role: ${normalized}]`,
    definition.instruction,
    rules.join(' ')
  ].filter(Boolean).join('\n');
}

function buildTaskMessage(description, prompt) {
  return [description, prompt].filter(Boolean).join('\n\n').trim();
}

function matchHook(hook, payload = {}) {
  if (!hook || hook.enabled === false) return false;
  const match = hook.match || {};
  if (Array.isArray(match.toolNames) && match.toolNames.length && !match.toolNames.includes(payload.toolName)) return false;
  if (Array.isArray(match.agentTypes) && match.agentTypes.length && !match.agentTypes.includes(payload.agentType)) return false;
  if (Array.isArray(match.statuses) && match.statuses.length && !match.statuses.includes(payload.status)) return false;
  if (match.pathPattern) {
    const regex = new RegExp(String(match.pathPattern), 'i');
    if (!regex.test(payload.path || '')) return false;
  }
  return true;
}

class RuntimeFeatureStore {
  constructor(options) {
    this.providerId = options.providerId || 'runtime';
    this.workspaceRoot = options.workspaceRoot;
    this.globalRoot = options.globalRoot;
    this.bridge = options.bridge || {};
    this.stateRoot = path.join(this.workspaceRoot, 'agent-runtime');
    this.globalStateRoot = path.join(this.globalRoot, `${this.providerId}-agent-runtime`);
    this.agentsIndex = { version: 1, agents: [] };
    this.teamsIndex = { version: 1, teams: [] };
    this.questionsIndex = { version: 1, questions: [] };
    this.eventsState = { version: 1, events: [] };
    this.hooksState = { version: 1, hooks: [] };
    this.costState = { version: 1, totals: { calls: 0, promptTokens: 0, completionTokens: 0, embeddingTokens: 0 }, byChat: {}, byTask: {}, byAgent: {} };
    this.onboardingState = {
      version: 1,
      summary: '',
      conventions: [],
      riskyZones: [],
      commands: { build: '', test: '', lint: '' },
      importantFiles: [],
      updatedAt: '',
      source: 'auto'
    };
    this.mcpProfiles = { version: 1, activeProfile: '', profiles: [] };
    this.mcpConnections = { version: 1, connections: [] };
  }

  initialize() {
    ensureDirSync(this.stateRoot);
    ensureDirSync(this.globalStateRoot);
    ensureDirSync(this.getAgentsRoot());
    ensureDirSync(this.getTeamsRoot());
    ensureDirSync(this.getQuestionsRoot());
    ensureDirSync(this.getLogsRoot());
    this.agentsIndex = readJsonFile(this.getAgentsIndexPath(), { version: 1, agents: [] });
    this.teamsIndex = readJsonFile(this.getTeamsIndexPath(), { version: 1, teams: [] });
    this.questionsIndex = readJsonFile(this.getQuestionsIndexPath(), { version: 1, questions: [] });
    this.eventsState = readJsonFile(this.getEventsPath(), { version: 1, events: [] });
    this.hooksState = readJsonFile(this.getHooksPath(), { version: 1, hooks: [] });
    this.costState = readJsonFile(this.getCostsPath(), this.costState);
    this.onboardingState = readJsonFile(this.getOnboardingPath(), this.onboardingState);
    this.mcpProfiles = readJsonFile(this.getMcpProfilesPath(), { version: 1, activeProfile: '', profiles: [] });
    this.mcpConnections = readJsonFile(this.getMcpConnectionsPath(), { version: 1, connections: [] });
    this.agentsIndex.agents = Array.isArray(this.agentsIndex.agents) ? this.agentsIndex.agents : [];
    this.teamsIndex.teams = Array.isArray(this.teamsIndex.teams) ? this.teamsIndex.teams : [];
    this.questionsIndex.questions = Array.isArray(this.questionsIndex.questions) ? this.questionsIndex.questions : [];
    this.eventsState.events = Array.isArray(this.eventsState.events) ? this.eventsState.events : [];
    this.hooksState.hooks = Array.isArray(this.hooksState.hooks) ? this.hooksState.hooks : [];
    if (!this.onboardingState.updatedAt) {
      const discovered = this.discoverOnboarding();
      this.onboardingState = {
        ...this.onboardingState,
        ...discovered,
        updatedAt: new Date().toISOString(),
        source: discovered.summary ? 'auto' : this.onboardingState.source || 'auto'
      };
      this.saveOnboarding();
    }
  }

  getAgentsRoot() {
    return path.join(this.stateRoot, 'agents');
  }

  getAgentsIndexPath() {
    return path.join(this.getAgentsRoot(), 'index.json');
  }

  getAgentPath(agentId) {
    return path.join(this.getAgentsRoot(), `${agentId}.json`);
  }

  getTeamsRoot() {
    return path.join(this.stateRoot, 'teams');
  }

  getTeamsIndexPath() {
    return path.join(this.getTeamsRoot(), 'index.json');
  }

  getTeamPath(teamId) {
    return path.join(this.getTeamsRoot(), `${teamId}.json`);
  }

  getQuestionsRoot() {
    return path.join(this.stateRoot, 'questions');
  }

  getQuestionsIndexPath() {
    return path.join(this.getQuestionsRoot(), 'index.json');
  }

  getQuestionPath(questionId) {
    return path.join(this.getQuestionsRoot(), `${questionId}.json`);
  }

  getEventsPath() {
    return path.join(this.stateRoot, 'events.json');
  }

  getHooksPath() {
    return path.join(this.stateRoot, 'hooks.json');
  }

  getCostsPath() {
    return path.join(this.stateRoot, 'costs.json');
  }

  getOnboardingPath() {
    return path.join(this.stateRoot, 'onboarding.json');
  }

  getMcpProfilesPath() {
    return path.join(this.stateRoot, 'mcp-profiles.json');
  }

  getMcpConnectionsPath() {
    return path.join(this.stateRoot, 'mcp-connections.json');
  }

  getLogsRoot() {
    return path.join(this.stateRoot, 'logs');
  }

  getRuntimeLogPath() {
    return path.join(this.getLogsRoot(), 'runtime.log');
  }

  getAuditLogPath() {
    return path.join(this.getLogsRoot(), 'audit.log');
  }

  saveAgentsIndex() {
    this.agentsIndex.agents = [...this.agentsIndex.agents].sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
    writeJsonFile(this.getAgentsIndexPath(), this.agentsIndex);
  }

  saveTeamsIndex() {
    this.teamsIndex.teams = [...this.teamsIndex.teams].sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
    writeJsonFile(this.getTeamsIndexPath(), this.teamsIndex);
  }

  saveQuestionsIndex() {
    this.questionsIndex.questions = [...this.questionsIndex.questions].sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
    writeJsonFile(this.getQuestionsIndexPath(), this.questionsIndex);
  }

  saveEvents() {
    this.eventsState.events = [...this.eventsState.events].slice(-MAX_EVENT_ENTRIES);
    writeJsonFile(this.getEventsPath(), this.eventsState);
  }

  saveHooks() {
    writeJsonFile(this.getHooksPath(), this.hooksState);
  }

  saveCosts() {
    writeJsonFile(this.getCostsPath(), this.costState);
  }

  saveOnboarding() {
    writeJsonFile(this.getOnboardingPath(), this.onboardingState);
  }

  saveMcpProfiles() {
    writeJsonFile(this.getMcpProfilesPath(), this.mcpProfiles);
  }

  saveMcpConnections() {
    writeJsonFile(this.getMcpConnectionsPath(), this.mcpConnections);
  }

  listAgents() {
    return [...this.agentsIndex.agents].sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  }

  loadAgent(agentId) {
    return readJsonFile(this.getAgentPath(agentId), null);
  }

  syncAgentRecord(agent) {
    const summary = {
      id: agent.id,
      name: agent.name,
      description: agent.description || '',
      agentType: agent.agentType,
      status: agent.status,
      createdAt: agent.createdAt,
      updatedAt: agent.updatedAt,
      taskId: agent.taskId || '',
      teamId: agent.teamId || '',
      teamName: agent.teamName || '',
      parentAgentId: agent.parentAgentId || '',
      chatId: agent.chatId || '',
      background: agent.background !== false,
      mode: agent.mode || 'default',
      isolation: agent.isolation || 'sandbox',
      model: agent.model || '',
      resultPreview: truncateText(normalizeWhitespace(agent.resultText || agent.resultPreview || ''), 180),
      error: truncateText(normalizeWhitespace(agent.error || ''), 180),
      todoCount: Array.isArray(agent.todos) ? agent.todos.length : 0
    };
    const existing = this.agentsIndex.agents.findIndex(item => item.id === agent.id);
    if (existing === -1) this.agentsIndex.agents.push(summary);
    else this.agentsIndex.agents[existing] = summary;
    this.saveAgentsIndex();
    return summary;
  }

  saveAgent(agent) {
    writeJsonFile(this.getAgentPath(agent.id), agent);
    this.syncAgentRecord(agent);
    return agent;
  }

  createAgent(input = {}) {
    const now = new Date().toISOString();
    const agent = {
      id: input.id || createId('agent'),
      name: truncateText(normalizeWhitespace(input.name || input.description || input.prompt || 'Agent'), 72),
      description: truncateText(normalizeWhitespace(input.description || ''), 160),
      agentType: normalizeAgentType(input.agentType || input.subagent_type),
      status: input.status || 'pending',
      createdAt: now,
      updatedAt: now,
      taskId: input.taskId || '',
      teamId: input.teamId || '',
      teamName: input.teamName || '',
      parentAgentId: input.parentAgentId || '',
      parentTaskId: input.parentTaskId || '',
      forkedFromAgentId: input.forkedFromAgentId || '',
      chatId: input.chatId || '',
      background: input.background !== false,
      mode: input.mode || 'default',
      isolation: input.isolation || 'sandbox',
      model: input.model || '',
      cwd: input.cwd || '',
      inbox: [],
      todos: [],
      logs: [],
      resultText: '',
      resultPreview: '',
      error: ''
    };
    this.appendEvent('agent.spawned', {
      agentId: agent.id,
      name: agent.name,
      agentType: agent.agentType,
      parentAgentId: agent.parentAgentId,
      teamName: agent.teamName
    });
    return this.saveAgent(agent);
  }

  updateAgent(agentId, updater) {
    const agent = this.loadAgent(agentId);
    if (!agent) return null;
    const nextAgent = typeof updater === 'function'
      ? (updater(agent) || agent)
      : Object.assign(agent, updater || {});
    nextAgent.updatedAt = new Date().toISOString();
    return this.saveAgent(nextAgent);
  }

  appendAgentLog(agentId, message, level = 'info') {
    return this.updateAgent(agentId, agent => {
      agent.logs = Array.isArray(agent.logs) ? agent.logs : [];
      agent.logs.push({
        id: createId('alog'),
        createdAt: new Date().toISOString(),
        level,
        message: truncateText(String(message || ''), 1000)
      });
      agent.logs = agent.logs.slice(-MAX_AGENT_LOG_ENTRIES);
      return agent;
    });
  }

  queueAgentMessage(agentId, message, meta = {}) {
    return this.updateAgent(agentId, agent => {
      agent.inbox = Array.isArray(agent.inbox) ? agent.inbox : [];
      agent.inbox.push({
        id: createId('msg'),
        createdAt: new Date().toISOString(),
        type: meta.type || 'user',
        message: typeof message === 'string' ? message : JSON.stringify(message),
        from: meta.from || 'runtime'
      });
      return agent;
    });
  }

  consumeAgentInbox(agentId) {
    const agent = this.loadAgent(agentId);
    if (!agent) return [];
    const inbox = Array.isArray(agent.inbox) ? clone(agent.inbox) : [];
    this.updateAgent(agentId, currentAgent => {
      currentAgent.inbox = [];
      return currentAgent;
    });
    return inbox;
  }

  syncAgentFromTask(task) {
    if (!task || !task.agentId) return null;
    const taskStatus = task.status === 'completed'
      ? 'completed'
      : task.status === 'failed'
        ? 'failed'
        : task.status === 'stopped'
          ? 'stopped'
          : task.status === 'awaiting_user'
            ? 'awaiting_user'
            : task.status;
    return this.updateAgent(task.agentId, agent => {
      agent.taskId = task.id;
      agent.status = taskStatus || agent.status;
      agent.resultText = task.resultText || agent.resultText;
      agent.resultPreview = truncateText(normalizeWhitespace(task.resultText || task.resultPreview || agent.resultPreview || ''), 220);
      agent.error = task.error || '';
      return agent;
    });
  }

  listTeams() {
    return [...this.teamsIndex.teams].sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  }

  loadTeam(teamId) {
    return readJsonFile(this.getTeamPath(teamId), null);
  }

  saveTeam(team) {
    writeJsonFile(this.getTeamPath(team.id), team);
    const summary = {
      id: team.id,
      teamName: team.teamName,
      description: team.description || '',
      agentType: team.agentType || 'team-lead',
      createdAt: team.createdAt,
      updatedAt: team.updatedAt,
      memberCount: Array.isArray(team.members) ? team.members.length : 0,
      status: team.status || 'idle'
    };
    const existing = this.teamsIndex.teams.findIndex(item => item.id === team.id);
    if (existing === -1) this.teamsIndex.teams.push(summary);
    else this.teamsIndex.teams[existing] = summary;
    this.saveTeamsIndex();
    return team;
  }

  createTeam(input = {}) {
    const now = new Date().toISOString();
    const team = {
      id: input.id || createId('team'),
      teamName: truncateText(normalizeWhitespace(input.teamName || input.team_name || 'team'), 72),
      description: truncateText(normalizeWhitespace(input.description || ''), 160),
      agentType: normalizeAgentType(input.agentType || input.agent_type || 'team-lead'),
      createdAt: now,
      updatedAt: now,
      members: Array.isArray(input.members) ? input.members : [],
      status: input.status || 'idle'
    };
    this.appendEvent('coordinator.team_created', {
      teamId: team.id,
      teamName: team.teamName
    });
    return this.saveTeam(team);
  }

  updateTeam(teamId, updater) {
    const team = this.loadTeam(teamId);
    if (!team) return null;
    const nextTeam = typeof updater === 'function'
      ? (updater(team) || team)
      : Object.assign(team, updater || {});
    nextTeam.updatedAt = new Date().toISOString();
    return this.saveTeam(nextTeam);
  }

  deleteTeam(teamId) {
    const team = this.loadTeam(teamId);
    if (!team) return false;
    this.teamsIndex.teams = this.teamsIndex.teams.filter(item => item.id !== teamId);
    try { fs.rmSync(this.getTeamPath(teamId), { force: true }); } catch (_) {}
    this.saveTeamsIndex();
    this.appendEvent('coordinator.team_deleted', { teamId, teamName: team.teamName });
    return true;
  }

  createQuestion(input = {}) {
    const now = new Date().toISOString();
    const question = {
      id: input.id || createId('question'),
      agentId: input.agentId || '',
      taskId: input.taskId || '',
      chatId: input.chatId || '',
      question: truncateText(String(input.question || ''), 1200),
      choices: Array.isArray(input.choices) ? input.choices.slice(0, 8) : [],
      context: truncateText(String(input.context || ''), 2000),
      status: input.status || 'pending',
      answer: '',
      createdAt: now,
      updatedAt: now
    };
    writeJsonFile(this.getQuestionPath(question.id), question);
    this.questionsIndex.questions.push({
      id: question.id,
      agentId: question.agentId,
      taskId: question.taskId,
      chatId: question.chatId,
      status: question.status,
      question: truncateText(normalizeWhitespace(question.question), 180),
      createdAt: question.createdAt,
      updatedAt: question.updatedAt
    });
    this.questionsIndex.questions = this.questionsIndex.questions.slice(-MAX_PENDING_QUESTIONS);
    this.saveQuestionsIndex();
    this.appendEvent('agent.awaiting_user', {
      questionId: question.id,
      agentId: question.agentId,
      taskId: question.taskId
    });
    return question;
  }

  loadQuestion(questionId) {
    return readJsonFile(this.getQuestionPath(questionId), null);
  }

  updateQuestion(questionId, updater) {
    const question = this.loadQuestion(questionId);
    if (!question) return null;
    const nextQuestion = typeof updater === 'function'
      ? (updater(question) || question)
      : Object.assign(question, updater || {});
    nextQuestion.updatedAt = new Date().toISOString();
    writeJsonFile(this.getQuestionPath(questionId), nextQuestion);
    const existing = this.questionsIndex.questions.findIndex(item => item.id === questionId);
    const summary = {
      id: nextQuestion.id,
      agentId: nextQuestion.agentId,
      taskId: nextQuestion.taskId,
      chatId: nextQuestion.chatId,
      status: nextQuestion.status,
      question: truncateText(normalizeWhitespace(nextQuestion.question), 180),
      createdAt: nextQuestion.createdAt,
      updatedAt: nextQuestion.updatedAt
    };
    if (existing === -1) this.questionsIndex.questions.push(summary);
    else this.questionsIndex.questions[existing] = summary;
    this.saveQuestionsIndex();
    return nextQuestion;
  }

  resolveQuestion(questionId, answer) {
    const question = this.updateQuestion(questionId, currentQuestion => {
      currentQuestion.status = 'answered';
      currentQuestion.answer = String(answer || '');
      return currentQuestion;
    });
    if (question) {
      this.appendEvent('agent.question_answered', {
        questionId,
        agentId: question.agentId,
        taskId: question.taskId
      });
    }
    return question;
  }

  getPendingQuestionForChat(chatId) {
    const summary = this.questionsIndex.questions.find(item => item.chatId === chatId && item.status === 'pending');
    return summary ? this.loadQuestion(summary.id) : null;
  }

  appendEvent(type, payload = {}, level = 'info') {
    const event = {
      id: createId('evt'),
      type,
      level,
      createdAt: new Date().toISOString(),
      payload
    };
    this.eventsState.events.push(event);
    this.saveEvents();
    appendJsonLine(this.getRuntimeLogPath(), event);
    if (level === 'audit' || /^mcp\.|^hook\.|^patch\.|^agent\.(spawned|stopped|resumed|completed|failed)$/.test(type)) {
      appendJsonLine(this.getAuditLogPath(), event);
    }
    return event;
  }

  getRecentEvents(limit = 40) {
    return [...this.eventsState.events].slice(-Math.max(1, Math.min(200, Number(limit || 40))));
  }

  listHooks() {
    return [...(this.hooksState.hooks || [])];
  }

  upsertHook(input = {}) {
    const now = new Date().toISOString();
    const hook = {
      id: input.id || createId('hook'),
      phase: String(input.phase || 'pre_tool'),
      name: truncateText(normalizeWhitespace(input.name || input.id || 'hook'), 80),
      enabled: input.enabled !== false,
      match: typeof input.match === 'object' && input.match ? clone(input.match) : {},
      action: String(input.action || 'annotate'),
      message: truncateText(String(input.message || ''), 500),
      createdAt: input.id ? input.createdAt || now : now,
      updatedAt: now
    };
    const existing = this.hooksState.hooks.findIndex(item => item.id === hook.id);
    if (existing === -1) this.hooksState.hooks.push(hook);
    else this.hooksState.hooks[existing] = hook;
    this.saveHooks();
    this.appendEvent('hook.updated', { hookId: hook.id, phase: hook.phase }, 'audit');
    return hook;
  }

  deleteHook(hookId) {
    const before = this.hooksState.hooks.length;
    this.hooksState.hooks = this.hooksState.hooks.filter(hook => hook.id !== hookId);
    this.saveHooks();
    if (before !== this.hooksState.hooks.length) {
      this.appendEvent('hook.deleted', { hookId }, 'audit');
      return true;
    }
    return false;
  }

  evaluatePreToolPolicies(toolCall, context = {}) {
    const agentType = normalizeAgentType(context.agentType || 'general-purpose');
    const definition = agentDefinition(agentType);
    const toolName = toolCall && toolCall.name ? String(toolCall.name) : '';
    const writeTools = new Set(['write_file', 'delete_path']);
    if (definition.readOnly && (writeTools.has(toolName) || toolName === 'apply_patch')) {
      return { blocked: true, reason: `${agentType} is read-only and cannot modify files.` };
    }
    if (!definition.allowShell && toolName === 'run_shell') {
      return { blocked: true, reason: `${agentType} is not allowed to use shell commands.` };
    }
    if (!definition.allowSpawn && ['spawn_agent', 'orchestrate_team'].includes(toolName)) {
      return { blocked: true, reason: `${agentType} cannot spawn subagents.` };
    }
    if (definition.orchestrationOnly && writeTools.has(toolName)) {
      return { blocked: true, reason: `${agentType} coordinates work and does not edit files directly.` };
    }

    const notes = [];
    for (const hook of this.listHooks().filter(item => item.phase === 'pre_tool')) {
      if (!matchHook(hook, {
        toolName,
        agentType,
        path: toolCall && toolCall.input ? toolCall.input.path : ''
      })) continue;
      if (hook.action === 'block') {
        return { blocked: true, reason: hook.message || `Blocked by hook ${hook.name}` };
      }
      if (hook.message) notes.push(hook.message);
    }
    return { blocked: false, notes };
  }

  buildPrePromptSections(context = {}) {
    const sections = [];
    const agentType = normalizeAgentType(context.agentType || 'general-purpose');
    sections.push(buildAgentRolePromptSection(agentType));
    if (this.onboardingState.summary) {
      const onboardingLines = [`[Project onboarding]\n${this.onboardingState.summary}`];
      if (Array.isArray(this.onboardingState.conventions) && this.onboardingState.conventions.length) {
        onboardingLines.push(`Conventions:\n- ${this.onboardingState.conventions.join('\n- ')}`);
      }
      if (Array.isArray(this.onboardingState.riskyZones) && this.onboardingState.riskyZones.length) {
        onboardingLines.push(`Risky zones:\n- ${this.onboardingState.riskyZones.join('\n- ')}`);
      }
      sections.push(onboardingLines.join('\n'));
    }
    for (const hook of this.listHooks().filter(item => item.phase === 'pre_prompt' && item.enabled !== false)) {
      if (!matchHook(hook, { agentType })) continue;
      if (hook.message) sections.push(`[Hook instruction: ${hook.name}]\n${hook.message}`);
    }
    return sections;
  }

  recordUsage(input = {}) {
    const promptTokens = Number(input.promptTokens || 0);
    const completionTokens = Number(input.completionTokens || 0);
    const embeddingTokens = Number(input.embeddingTokens || 0);
    const bucketNames = [
      ['byChat', input.chatId],
      ['byTask', input.taskId],
      ['byAgent', input.agentId]
    ];
    this.costState.totals.calls = Number(this.costState.totals.calls || 0) + 1;
    this.costState.totals.promptTokens = Number(this.costState.totals.promptTokens || 0) + promptTokens;
    this.costState.totals.completionTokens = Number(this.costState.totals.completionTokens || 0) + completionTokens;
    this.costState.totals.embeddingTokens = Number(this.costState.totals.embeddingTokens || 0) + embeddingTokens;
    for (const [bucketName, key] of bucketNames) {
      if (!key) continue;
      if (!this.costState[bucketName][key]) {
        this.costState[bucketName][key] = {
          calls: 0,
          promptTokens: 0,
          completionTokens: 0,
          embeddingTokens: 0,
          provider: this.providerId,
          model: input.model || ''
        };
      }
      const bucket = this.costState[bucketName][key];
      bucket.calls += 1;
      bucket.promptTokens += promptTokens;
      bucket.completionTokens += completionTokens;
      bucket.embeddingTokens += embeddingTokens;
      bucket.model = input.model || bucket.model;
      bucket.provider = this.providerId;
    }
    this.saveCosts();
  }

  getCostSummary() {
    return clone(this.costState);
  }

  discoverOnboarding() {
    const result = {
      summary: '',
      conventions: [],
      riskyZones: [],
      commands: { build: '', test: '', lint: '' },
      importantFiles: []
    };
    try {
      const packageJsonPath = path.join(this.workspaceRoot, 'package.json');
      if (fs.existsSync(packageJsonPath)) {
        const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
        const scripts = packageJson.scripts || {};
        result.commands.build = scripts.build || '';
        result.commands.test = scripts.test || '';
        result.commands.lint = scripts.lint || '';
        result.summary = packageJson.description || result.summary;
        result.importantFiles.push('package.json');
      }
    } catch (_) {}
    try {
      const readmePath = path.join(this.workspaceRoot, 'README.md');
      if (fs.existsSync(readmePath)) {
        const readme = fs.readFileSync(readmePath, 'utf8');
        if (!result.summary) {
          const firstParagraph = readme.split(/\r?\n\r?\n/).find(block => normalizeWhitespace(block));
          result.summary = truncateText(normalizeWhitespace(firstParagraph || ''), 400);
        }
        result.importantFiles.push('README.md');
      }
    } catch (_) {}
    return result;
  }

  getOnboarding() {
    return clone(this.onboardingState);
  }

  updateOnboarding(input = {}) {
    this.onboardingState = {
      ...this.onboardingState,
      summary: truncateText(String(input.summary || this.onboardingState.summary || ''), 4000),
      conventions: Array.isArray(input.conventions) ? input.conventions.map(item => truncateText(String(item), 240)).filter(Boolean).slice(0, 24) : this.onboardingState.conventions,
      riskyZones: Array.isArray(input.riskyZones) ? input.riskyZones.map(item => truncateText(String(item), 240)).filter(Boolean).slice(0, 24) : this.onboardingState.riskyZones,
      commands: {
        build: input.commands && input.commands.build != null ? String(input.commands.build || '') : this.onboardingState.commands.build,
        test: input.commands && input.commands.test != null ? String(input.commands.test || '') : this.onboardingState.commands.test,
        lint: input.commands && input.commands.lint != null ? String(input.commands.lint || '') : this.onboardingState.commands.lint
      },
      importantFiles: Array.isArray(input.importantFiles) ? input.importantFiles.map(item => truncateText(String(item), 240)).filter(Boolean).slice(0, 24) : this.onboardingState.importantFiles,
      updatedAt: new Date().toISOString(),
      source: input.source || 'manual'
    };
    this.saveOnboarding();
    this.appendEvent('onboarding.updated', {}, 'audit');
    return this.getOnboarding();
  }

  redactConfig(config = {}) {
    const secretKeys = /(token|secret|password|authorization|api[-_]?key|cookie)/i;
    const cloneValue = clone(config);
    for (const key of Object.keys(cloneValue)) {
      if (secretKeys.test(key)) cloneValue[key] = '[redacted]';
    }
    return cloneValue;
  }

  async loadMcpManifest(config = {}) {
    const transport = String(config.transport || 'static');
    if (transport === 'static') {
      return {
        tools: Array.isArray(config.tools) ? clone(config.tools) : [],
        resources: Array.isArray(config.resources) ? clone(config.resources) : [],
        prompts: Array.isArray(config.prompts) ? clone(config.prompts) : []
      };
    }
    if ((transport === 'http' || transport === 'sse' || transport === 'ws' || transport === 'http-json') && config.url) {
      const candidates = [String(config.url).replace(/\/+$/, ''), `${String(config.url).replace(/\/+$/, '')}/manifest`];
      for (const candidate of candidates) {
        try {
          const response = await httpRequest(candidate, { method: 'GET', accept: 'application/json' });
          if (response.statusCode >= 200 && response.statusCode < 300) {
            const payload = JSON.parse(response.raw || '{}');
            return {
              tools: Array.isArray(payload.tools) ? payload.tools : [],
              resources: Array.isArray(payload.resources) ? payload.resources : [],
              prompts: Array.isArray(payload.prompts) ? payload.prompts : []
            };
          }
        } catch (_) {}
      }
      throw new Error(`Unable to load MCP manifest from ${config.url}`);
    }
    throw new Error(`Unsupported MCP transport for live initialization: ${transport}`);
  }

  async connectMcp(name, config = {}) {
    const connection = {
      id: createId('mcp'),
      name: truncateText(normalizeWhitespace(name || config.name || 'mcp'), 80),
      config: this.redactConfig(config),
      transport: String(config.transport || 'static'),
      initialized: false,
      detail: '',
      connectedAt: new Date().toISOString(),
      manifest: { tools: [], resources: [], prompts: [] }
    };
    try {
      connection.manifest = await this.loadMcpManifest(config);
      connection.initialized = true;
    } catch (error) {
      connection.detail = error instanceof Error ? error.message : String(error);
    }
    const existing = this.mcpConnections.connections.findIndex(item => item.name === connection.name);
    if (existing === -1) this.mcpConnections.connections.push(connection);
    else this.mcpConnections.connections[existing] = connection;
    this.saveMcpConnections();
    this.appendEvent('mcp.connected', { name: connection.name, initialized: connection.initialized }, 'audit');
    return connection;
  }

  disconnectMcp(name) {
    const before = this.mcpConnections.connections.length;
    this.mcpConnections.connections = this.mcpConnections.connections.filter(item => item.name !== name);
    this.saveMcpConnections();
    if (before !== this.mcpConnections.connections.length) {
      this.appendEvent('mcp.disconnected', { name }, 'audit');
      return true;
    }
    return false;
  }

  listMcpProfiles() {
    return {
      activeProfile: this.mcpProfiles.activeProfile || '',
      profiles: clone(this.mcpProfiles.profiles || []),
      connections: clone(this.mcpConnections.connections || [])
    };
  }

  upsertMcpProfile(input = {}) {
    const profile = {
      name: truncateText(normalizeWhitespace(input.name || 'profile'), 80),
      description: truncateText(String(input.description || ''), 200),
      connections: Array.isArray(input.connections) ? clone(input.connections) : []
    };
    const existing = this.mcpProfiles.profiles.findIndex(item => item.name === profile.name);
    if (existing === -1) this.mcpProfiles.profiles.push(profile);
    else this.mcpProfiles.profiles[existing] = profile;
    this.saveMcpProfiles();
    this.appendEvent('mcp.profile_upserted', { name: profile.name }, 'audit');
    return profile;
  }

  activateMcpProfile(name) {
    this.mcpProfiles.activeProfile = String(name || '').trim();
    this.saveMcpProfiles();
    this.appendEvent('mcp.profile_activated', { name: this.mcpProfiles.activeProfile }, 'audit');
    return this.mcpProfiles.activeProfile;
  }

  deactivateMcpProfile() {
    const oldName = this.mcpProfiles.activeProfile || '';
    this.mcpProfiles.activeProfile = '';
    this.saveMcpProfiles();
    if (oldName) this.appendEvent('mcp.profile_deactivated', { name: oldName }, 'audit');
    return '';
  }

  async hydrateProfileConnections(name) {
    const profile = this.mcpProfiles.profiles.find(item => item.name === name);
    if (!profile) throw new Error(`MCP profile not found: ${name}`);
    const results = [];
    for (const connection of profile.connections || []) {
      results.push(await this.connectMcp(connection.name, connection.config || {}));
    }
    return results;
  }

  getActiveMcpConnections(connectionName = '') {
    const connections = clone(this.mcpConnections.connections || []);
    if (connectionName) return connections.filter(item => item.name === connectionName);
    return connections;
  }

  listMcpResources(connectionName = '') {
    const connections = this.getActiveMcpConnections(connectionName);
    const resources = [];
    for (const connection of connections) {
      for (const resource of connection.manifest && Array.isArray(connection.manifest.resources) ? connection.manifest.resources : []) {
        resources.push({ connection: connection.name, ...resource });
      }
    }
    return resources;
  }

  async readMcpResource(connectionName, resourceId) {
    const connection = this.getActiveMcpConnections(connectionName)[0];
    if (!connection) throw new Error(`MCP connection not found: ${connectionName}`);
    const resource = (connection.manifest.resources || []).find(item => item.id === resourceId || item.uri === resourceId);
    if (!resource) throw new Error(`MCP resource not found: ${resourceId}`);
    if (typeof resource.content === 'string') {
      return { connection: connection.name, resource, content: resource.content };
    }
    if (typeof resource.path === 'string') {
      const absolutePath = path.isAbsolute(resource.path) ? resource.path : path.join(this.workspaceRoot, resource.path);
      const content = fs.readFileSync(absolutePath, 'utf8');
      return { connection: connection.name, resource, content };
    }
    if (typeof resource.url === 'string') {
      const response = await httpRequest(resource.url, { method: 'GET', accept: 'text/plain, application/json;q=0.9, */*;q=0.5' });
      return { connection: connection.name, resource, content: response.raw };
    }
    throw new Error(`Resource ${resourceId} does not expose readable content.`);
  }

  listMcpTools(connectionName = '') {
    const connections = this.getActiveMcpConnections(connectionName);
    const tools = [];
    for (const connection of connections) {
      for (const tool of connection.manifest && Array.isArray(connection.manifest.tools) ? connection.manifest.tools : []) {
        tools.push({ connection: connection.name, ...tool });
      }
    }
    return tools;
  }

  _getWebConfig(key, defaultValue) {
    if (typeof this.configGetter === 'function') {
      return this.configGetter(key, defaultValue);
    }
    return defaultValue;
  }

  async fetchWebPage(url, maxChars) {
    const defaultMaxChars = this._getWebConfig('web.fetchMaxChars', 4000);
    maxChars = maxChars != null ? Number(maxChars) : defaultMaxChars;
    maxChars = Math.max(200, maxChars);
    const response = await httpRequest(url, {
      method: 'GET',
      accept: 'text/html, text/plain;q=0.9, application/json;q=0.8, */*;q=0.5',
      timeoutMs: 30000
    });
    if (response.statusCode < 200 || response.statusCode >= 400) {
      throw new Error(`Fetch failed with HTTP ${response.statusCode}`);
    }
    const raw = response.raw || '';
    const titleMatch = raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const text = raw
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return {
      url,
      statusCode: response.statusCode,
      title: titleMatch ? htmlDecode(titleMatch[1]) : '',
      text: truncateText(htmlDecode(text), maxChars)
    };
  }

  async searchWeb(query, limit = 5) {
    const provider = this._getWebConfig('web.searchProvider', 'duckduckgo');
    const apiKey = this._getWebConfig('web.searchApiKey', '');
    const providers = ['duckduckgo', 'bing', 'google'];
    const useProvider = providers.includes(provider) ? provider : 'duckduckgo';
    const order = [useProvider, ...providers.filter(item => item !== useProvider)];
    const errors = [];

    for (const currentProvider of order) {
      try {
        switch (currentProvider) {
          case 'duckduckgo':
            return await this._searchDuckDuckGo(query, limit);
          case 'bing':
            if (!apiKey) {
              errors.push('Bing selected but no API key configured');
              continue;
            }
            return await this._searchBing(query, limit, apiKey);
          case 'google':
            if (!apiKey) {
              errors.push('Google selected but no API key configured');
              continue;
            }
            return await this._searchGoogle(query, limit, apiKey);
          default:
            errors.push(`Unknown provider: ${currentProvider}`);
        }
      } catch (error) {
        errors.push(`${currentProvider}: ${error.message}`);
      }
    }

    throw new Error(`All search providers failed: ${errors.join('; ')}`);
  }

  async _searchDuckDuckGo(query, limit = 5) {
    const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const response = await httpRequest(searchUrl, {
      method: 'GET',
      accept: 'text/html, */*;q=0.5',
      timeoutMs: 30000
    });
    if (response.statusCode < 200 || response.statusCode >= 400) {
      throw new Error(`DuckDuckGo search failed with HTTP ${response.statusCode}`);
    }
    const html = response.raw || '';
    const results = [];
    const regex = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    let match;
    while ((match = regex.exec(html)) && results.length < Math.max(1, Math.min(10, Number(limit || 5)))) {
      results.push({
        url: htmlDecode(match[1]),
        title: truncateText(htmlDecode(match[2].replace(/<[^>]+>/g, ' ')).trim(), 180)
      });
    }
    return { query, results };
  }

  async _searchBing(query, limit = 5, apiKey) {
    const count = Math.max(1, Math.min(10, Number(limit || 5)));
    const searchUrl = `https://api.bing.microsoft.com/v7.0/search?q=${encodeURIComponent(query)}&count=${count}`;
    const response = await httpRequest(searchUrl, {
      method: 'GET',
      accept: 'application/json',
      headers: { 'Ocp-Apim-Subscription-Key': apiKey },
      timeoutMs: 30000
    });
    if (response.statusCode < 200 || response.statusCode >= 400) {
      throw new Error(`Bing search failed with HTTP ${response.statusCode}`);
    }
    const parsed = JSON.parse(response.raw || '{}');
    const results = [];
    const webResults = (parsed.webPages && parsed.webPages.value) || [];
    for (const item of webResults) {
      if (results.length >= count) break;
      results.push({
        url: item.url || '',
        title: truncateText(item.name || '', 180),
        snippet: truncateText(item.snippet || '', 300)
      });
    }
    return { query, results };
  }

  async _searchGoogle(query, limit = 5, apiKey) {
    const count = Math.max(1, Math.min(10, Number(limit || 5)));
    let googleApiKey = apiKey;
    let cx = '';
    if (typeof apiKey === 'string' && apiKey.includes('|')) {
      const parts = apiKey.split('|');
      googleApiKey = parts[0].trim();
      cx = parts[1] ? parts[1].trim() : '';
    }
    if (!googleApiKey || !cx) {
      throw new Error('Google search requires localai.web.searchApiKey formatted as API_KEY|CX.');
    }
    const searchUrl = `https://www.googleapis.com/customsearch/v1?key=${encodeURIComponent(googleApiKey)}&cx=${encodeURIComponent(cx)}&q=${encodeURIComponent(query)}&num=${count}`;
    const response = await httpRequest(searchUrl, {
      method: 'GET',
      accept: 'application/json',
      timeoutMs: 30000
    });
    if (response.statusCode < 200 || response.statusCode >= 400) {
      throw new Error(`Google search failed with HTTP ${response.statusCode}`);
    }
    const parsed = JSON.parse(response.raw || '{}');
    const results = [];
    const items = parsed.items || [];
    for (const item of items) {
      if (results.length >= count) break;
      results.push({
        url: item.link || '',
        title: truncateText(item.title || '', 180),
        snippet: truncateText(item.snippet || '', 300)
      });
    }
    return { query, results };
  }

  getSnapshot() {
    return {
      agents: this.listAgents().slice(0, 24),
      teams: this.listTeams().slice(0, 12),
      pendingQuestions: this.questionsIndex.questions.filter(item => item.status === 'pending').slice(0, 12),
      recentEvents: this.getRecentEvents(24),
      hooks: this.listHooks(),
      onboarding: this.getOnboarding(),
      costs: this.getCostSummary(),
      mcp: {
        activeProfile: this.mcpProfiles.activeProfile || '',
        connectionCount: (this.mcpConnections.connections || []).length,
        initializedConnections: (this.mcpConnections.connections || []).filter(item => item.initialized).length
      }
    };
  }

  async executeTool(name, input = {}, context = {}) {
    switch (name) {
      case 'list_agents':
        return { count: this.listAgents().length, agents: this.listAgents() };

      case 'get_agent': {
        const agentId = String(input.agentId || input.id || '').trim();
        if (!agentId) throw new Error('get_agent requires agentId.');
        const agent = this.loadAgent(agentId);
        if (!agent) throw new Error(`Agent not found: ${agentId}`);
        return agent;
      }

      case 'spawn_agent': {
        if (typeof input.prompt !== 'string' || !input.prompt.trim()) {
          throw new Error('spawn_agent requires a prompt.');
        }
        if (!this.bridge.createTask) {
          throw new Error('Task bridge is unavailable.');
        }
        const runInBackground = input.run_in_background !== false;
        const agent = this.createAgent({
          name: input.name || input.description || input.prompt,
          description: input.description || '',
          agentType: input.subagent_type || 'general-purpose',
          teamName: input.team_name || '',
          parentAgentId: context.agentId || '',
          parentTaskId: context.taskId || '',
          chatId: context.chatId || '',
          background: runInBackground,
          mode: input.mode || 'default',
          isolation: input.isolation || 'sandbox',
          model: input.model || ''
        });
        const task = await this.bridge.createTask({
          title: input.name || input.description || agent.name,
          prompt: buildTaskMessage(input.description, input.prompt),
          chatId: context.chatId || '',
          parentTaskId: context.taskId || '',
          runtimeKind: input.isolation === 'remote' ? 'cloud' : undefined,
          background: runInBackground,
          executionRoot: input.cwd || context.rootPath || '',
          agentId: agent.id,
          agentType: agent.agentType,
          agentName: agent.name,
          teamName: input.team_name || '',
          modelOverride: input.model || '',
          mode: input.mode || 'default',
          isolation: input.isolation || 'sandbox'
        });
        this.updateAgent(agent.id, currentAgent => {
          currentAgent.taskId = task.id;
          currentAgent.status = task.status || currentAgent.status;
          currentAgent.teamName = input.team_name || currentAgent.teamName;
          return currentAgent;
        });
        if (input.team_name) {
          const team = this.listTeams().find(item => item.teamName === input.team_name);
          if (team) {
            this.updateTeam(team.id, currentTeam => {
              currentTeam.members = Array.isArray(currentTeam.members) ? currentTeam.members : [];
              currentTeam.members.push({ agentId: agent.id, taskId: task.id, role: agent.agentType, name: agent.name });
              return currentTeam;
            });
          }
        }
        return this.loadAgent(agent.id);
      }

      case 'send_message': {
        const target = String(input.to || input.agentId || '').trim();
        const message = input.message;
        if (!target) throw new Error('send_message requires a target agent id.');
        if (!message) throw new Error('send_message requires a message.');
        const agent = this.loadAgent(target);
        if (!agent) throw new Error(`Agent not found: ${target}`);
        this.queueAgentMessage(target, typeof message === 'string' ? message : JSON.stringify(message), {
          from: context.agentId || 'runtime'
        });
        if (agent.taskId && this.bridge.appendTaskMessage) {
          await this.bridge.appendTaskMessage(agent.taskId, typeof message === 'string' ? message : JSON.stringify(message), {
            agentId: target,
            senderAgentId: context.agentId || ''
          });
        }
        this.appendEvent('agent.message_sent', {
          from: context.agentId || '',
          to: target
        });
        return this.loadAgent(target);
      }

      case 'wait_agent': {
        const targets = Array.isArray(input.targets) && input.targets.length
          ? input.targets.map(String)
          : [String(input.agentId || '').trim()].filter(Boolean);
        if (!targets.length) throw new Error('wait_agent requires one or more targets.');
        const timeoutMs = Math.max(1000, Math.min(30 * 60 * 1000, Number(input.timeoutMs || 30000)));
        const returnWhen = String(input.returnWhen || 'all');
        const startedAt = Date.now();
        for (;;) {
          const states = targets.map(target => this.loadAgent(target) || { id: target, status: 'missing' });
          const completed = states.filter(state => ['completed', 'failed', 'stopped'].includes(state.status));
          const done = returnWhen === 'any'
            ? completed.length > 0
            : completed.length === states.length;
          if (done || (Date.now() - startedAt) >= timeoutMs) {
            return {
              waitedMs: Date.now() - startedAt,
              completed: completed.length,
              agents: states
            };
          }
          if (this.bridge.waitForTaskAgents) {
            await this.bridge.waitForTaskAgents(states, 1000);
          } else {
            await new Promise(resolve => setTimeout(resolve, 500));
          }
        }
      }

      case 'stop_agent': {
        const agentId = String(input.agentId || input.id || '').trim();
        if (!agentId) throw new Error('stop_agent requires agentId.');
        const agent = this.loadAgent(agentId);
        if (!agent) throw new Error(`Agent not found: ${agentId}`);
        if (agent.taskId && this.bridge.stopTask) {
          await this.bridge.stopTask(agent.taskId);
        }
        this.updateAgent(agentId, currentAgent => {
          currentAgent.status = 'stopped';
          return currentAgent;
        });
        this.appendEvent('agent.stopped', { agentId }, 'audit');
        return this.loadAgent(agentId);
      }

      case 'resume_agent': {
        const agentId = String(input.agentId || '').trim();
        if (!agentId) throw new Error('resume_agent requires agentId.');
        const agent = this.loadAgent(agentId);
        if (!agent) throw new Error(`Agent not found: ${agentId}`);
        if (input.message) this.queueAgentMessage(agentId, String(input.message), { from: context.agentId || 'runtime' });
        if (agent.taskId && this.bridge.resumeTask) {
          await this.bridge.resumeTask(agent.taskId, { message: input.message ? String(input.message) : '' });
        }
        this.updateAgent(agentId, currentAgent => {
          currentAgent.status = 'resuming';
          return currentAgent;
        });
        this.appendEvent('agent.resumed', { agentId }, 'audit');
        return this.loadAgent(agentId);
      }

      case 'fork_agent': {
        const agentId = String(input.agentId || '').trim();
        if (!agentId) throw new Error('fork_agent requires agentId.');
        const sourceAgent = this.loadAgent(agentId);
        if (!sourceAgent) throw new Error(`Agent not found: ${agentId}`);
        if (!sourceAgent.taskId || !this.bridge.getTask) throw new Error('Source agent has no linked task.');
        const sourceTask = this.bridge.getTask(sourceAgent.taskId);
        if (!sourceTask) throw new Error(`Source task not found: ${sourceAgent.taskId}`);
        const forkAgent = this.createAgent({
          name: input.name || `${sourceAgent.name} fork`,
          description: input.description || `Fork of ${sourceAgent.name}`,
          agentType: 'fork',
          background: input.run_in_background !== false,
          parentAgentId: sourceAgent.id,
          parentTaskId: sourceTask.id,
          chatId: sourceAgent.chatId || context.chatId || '',
          teamName: sourceAgent.teamName || ''
        });
        const extraPrompt = typeof input.prompt === 'string' && input.prompt.trim()
          ? input.prompt.trim()
          : 'Continue from the parent context and pursue this forked branch.';
        const task = await this.bridge.createTask({
          title: forkAgent.name,
          prompt: extraPrompt,
          background: input.run_in_background !== false,
          runtimeKind: input.isolation === 'remote' ? 'cloud' : sourceTask.runtimeKind,
          executionRoot: input.cwd || sourceTask.executionRoot || context.rootPath || '',
          chatId: sourceAgent.chatId || context.chatId || '',
          parentTaskId: sourceTask.id,
          agentId: forkAgent.id,
          agentType: 'fork',
          agentName: forkAgent.name,
          teamName: sourceAgent.teamName || '',
          modelOverride: input.model || sourceAgent.model || '',
          mode: input.mode || sourceAgent.mode || 'default',
          isolation: input.isolation || sourceAgent.isolation || 'sandbox',
          messages: Array.isArray(sourceTask.messages) ? clone(sourceTask.messages) : undefined
        });
        this.updateAgent(forkAgent.id, currentAgent => {
          currentAgent.taskId = task.id;
          currentAgent.forkedFromAgentId = sourceAgent.id;
          return currentAgent;
        });
        return this.loadAgent(forkAgent.id);
      }

      case 'create_team':
        return this.createTeam(input);

      case 'list_teams':
        return { count: this.listTeams().length, teams: this.listTeams() };

      case 'delete_team': {
        const teamId = String(input.teamId || input.id || '').trim();
        if (!teamId) throw new Error('delete_team requires teamId.');
        return { deleted: this.deleteTeam(teamId) };
      }

      case 'orchestrate_team': {
        if (typeof input.goal !== 'string' || !input.goal.trim()) throw new Error('orchestrate_team requires goal.');
        const aspects = Array.isArray(input.aspects) ? input.aspects.map(item => String(item)).filter(Boolean) : [];
        const team = this.createTeam({
          teamName: input.teamName || input.team_name || `team-${Date.now()}`,
          description: input.goal,
          agentType: 'team-lead'
        });
        const lead = await this.executeTool('spawn_agent', {
          description: `Lead orchestration for team ${team.teamName}`,
          prompt: [
            `Goal: ${input.goal}`,
            aspects.length ? `Aspects:\n- ${aspects.join('\n- ')}` : '',
            'Coordinate workers, collect outputs, and synthesize a final plan.'
          ].filter(Boolean).join('\n\n'),
          subagent_type: 'team-lead',
          run_in_background: true,
          team_name: team.teamName,
          name: `${team.teamName}-lead`
        }, context);
        const workers = [];
        for (const aspect of aspects) {
          workers.push(await this.executeTool('spawn_agent', {
            description: `${aspect} worker for ${input.goal}`,
            prompt: `Work only on this aspect: ${aspect}\n\nMain goal: ${input.goal}`,
            subagent_type: 'worker',
            run_in_background: true,
            team_name: team.teamName,
            name: `${team.teamName}-${aspect}`.replace(/[^a-z0-9._-]+/gi, '-')
          }, context));
        }
        let verifier = null;
        if (input.verify !== false) {
          verifier = await this.executeTool('spawn_agent', {
            description: `Verification for ${input.goal}`,
            prompt: `Verify the outputs for: ${input.goal}`,
            subagent_type: 'verification',
            run_in_background: true,
            team_name: team.teamName,
            name: `${team.teamName}-verification`
          }, context);
        }
        this.updateTeam(team.id, currentTeam => {
          currentTeam.status = 'running';
          currentTeam.members = [
            { agentId: lead.id, role: 'team-lead', name: lead.name },
            ...workers.map(worker => ({ agentId: worker.id, role: 'worker', name: worker.name })),
            ...(verifier ? [{ agentId: verifier.id, role: 'verification', name: verifier.name }] : [])
          ];
          return currentTeam;
        });
        this.appendEvent('coordinator.orchestrated', {
          teamId: team.id,
          workerCount: workers.length,
          verifier: Boolean(verifier)
        });
        return {
          team: this.loadTeam(team.id),
          lead,
          workers,
          verifier
        };
      }

      case 'task_output': {
        const taskId = String(input.taskId || '').trim();
        if (!taskId || !this.bridge.getTaskOutput) throw new Error('task_output requires taskId.');
        return this.bridge.getTaskOutput(taskId);
      }

      case 'task_update': {
        const taskId = String(input.taskId || '').trim();
        if (!taskId || !this.bridge.updateTask) throw new Error('task_update requires taskId.');
        return this.bridge.updateTask(taskId, input.changes || {});
      }

      case 'todo_write': {
        const agentId = String(input.agentId || context.agentId || '').trim();
        if (!agentId) throw new Error('todo_write requires agentId.');
        const mode = String(input.mode || 'replace');
        const todos = Array.isArray(input.todos) ? input.todos : [];
        this.updateAgent(agentId, agent => {
          const normalized = todos.map(item => ({
            id: item.id || createId('todo'),
            text: truncateText(String(item.text || item), 240),
            done: Boolean(item.done)
          })).slice(0, MAX_TODO_ITEMS);
          if (mode === 'append') {
            const current = Array.isArray(agent.todos) ? agent.todos : [];
            agent.todos = [...current, ...normalized].slice(0, MAX_TODO_ITEMS);
          } else {
            agent.todos = normalized;
          }
          return agent;
        });
        return this.loadAgent(agentId);
      }

      case 'web_fetch':
        if (!input.url) throw new Error('web_fetch requires url.');
        return this.fetchWebPage(String(input.url), Number(input.maxChars || 6000));

      case 'web_search':
        if (!input.query) throw new Error('web_search requires query.');
        return this.searchWeb(String(input.query), Number(input.limit || 5));

      case 'list_hooks':
        return { hooks: this.listHooks() };

      case 'upsert_hook':
        return this.upsertHook(input);

      case 'delete_hook':
        if (!input.hookId) throw new Error('delete_hook requires hookId.');
        return { deleted: this.deleteHook(String(input.hookId)) };

      case 'list_mcp_profiles':
        return this.listMcpProfiles();

      case 'upsert_mcp_profile':
        return this.upsertMcpProfile(input);

      case 'activate_mcp_profile': {
        const profileName = String(input.name || '').trim();
        if (!profileName) throw new Error('activate_mcp_profile requires name.');
        this.activateMcpProfile(profileName);
        return {
          activeProfile: profileName,
          connections: await this.hydrateProfileConnections(profileName)
        };
      }

      case 'deactivate_mcp_profile':
        this.deactivateMcpProfile();
        return this.listMcpProfiles();

      case 'mcp_connect':
        if (!input.name) throw new Error('mcp_connect requires name.');
        return this.connectMcp(String(input.name), input.config || {});

      case 'mcp_disconnect':
        if (!input.name) throw new Error('mcp_disconnect requires name.');
        return { disconnected: this.disconnectMcp(String(input.name)) };

      case 'mcp_list_resources':
        return { resources: this.listMcpResources(String(input.connection || '')) };

      case 'mcp_read_resource':
        if (!input.connection || !(input.resourceId || input.uri)) {
          throw new Error('mcp_read_resource requires connection and resourceId/uri.');
        }
        return this.readMcpResource(String(input.connection), String(input.resourceId || input.uri));

      case 'mcp_list_tools':
        return { tools: this.listMcpTools(String(input.connection || '')) };

      case 'get_onboarding':
        return this.getOnboarding();

      case 'update_onboarding':
        return this.updateOnboarding(input);

      case 'list_events':
        return { events: this.getRecentEvents(Number(input.limit || 20)) };

      default:
        return null;
    }
  }
}

module.exports = {
  AGENT_TYPE_CATALOG,
  ADVANCED_AGENT_TOOL_SPECS,
  buildAgentRolePromptSection,
  normalizeAgentType,
  agentDefinition,
  RuntimeFeatureStore
};
