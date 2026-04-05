'use strict';

const http = require('http');
const https = require('https');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { DockerSandboxManager } = require('../lib/dockerSandbox');

const PORT = Number(process.env.PORT || 7788);
const DATA_ROOT = path.resolve(process.env.CLOUD_EXECUTOR_DATA_DIR || path.join(__dirname, '.cloud-executor-data'));
const TASKS_ROOT = path.join(DATA_ROOT, 'tasks');
const TASK_INDEX_PATH = path.join(TASKS_ROOT, 'index.json');
const MAX_BODY_BYTES = 10 * 1024 * 1024;
const MAX_LOG_ENTRIES = 320;
const MAX_TOOL_OUTPUT_CHARS = 12000;
const DEFAULT_MODEL_ID = process.env.LOCALAI_MODEL_ID || 'auto';
const DEFAULT_MAX_ROUNDS = Math.max(1, Math.min(12, Number(process.env.CLOUD_EXECUTOR_MAX_ROUNDS || 6)));
const DEFAULT_SHELL_TIMEOUT_MS = Math.max(1000, Math.min(600000, Number(process.env.CLOUD_EXECUTOR_SHELL_TIMEOUT_MS || 30000)));
const MAX_CONCURRENT_TASKS = Math.max(1, Math.min(8, Number(process.env.CLOUD_EXECUTOR_MAX_CONCURRENT_TASKS || 2)));
const DEFAULT_SANDBOX_IMAGE = process.env.CLOUD_EXECUTOR_SANDBOX_IMAGE || 'localai-code-sandbox:latest';
const DEFAULT_SANDBOX_NETWORK = process.env.CLOUD_EXECUTOR_SANDBOX_NETWORK || 'none';
const DEFAULT_SANDBOX_TOOL_TIMEOUT_MS = Math.max(1000, Math.min(30 * 60 * 1000, Number(process.env.CLOUD_EXECUTOR_SANDBOX_TOOL_TIMEOUT_MS || 120000)));
const DEFAULT_MODEL_BASE_URL = String(process.env.LOCALAI_BASE_URL || 'http://127.0.0.1:1234/v1').trim().replace(/\/+$/, '');
const DEFAULT_NATIVE_BASE_URL = String(process.env.LOCALAI_NATIVE_BASE_URL || 'http://127.0.0.1:1234').trim().replace(/\/+$/, '');

function createId(prefix) {
  return `${prefix}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
}

function ensureDirSync(targetPath) {
  fs.mkdirSync(targetPath, { recursive: true });
}

function fileExists(targetPath) {
  try {
    fs.accessSync(targetPath);
    return true;
  } catch (_) {
    return false;
  }
}

function readJsonFile(filePath, fallback) {
  try {
    if (!fileExists(filePath)) return fallback;
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

function extractErrorMessage(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(extractErrorMessage).filter(Boolean).join(' ');
  if (typeof value === 'object') {
    return extractErrorMessage(value.message || value.error || value.detail || JSON.stringify(value));
  }
  return String(value);
}

function tryParseJson(text) {
  try {
    return JSON.parse(text);
  } catch (_) {
    return null;
  }
}

function extractJsonFromText(text) {
  const value = String(text || '').trim();
  if (!value) return null;
  const direct = tryParseJson(value);
  if (direct) return direct;
  const codeFence = value.match(/```json\s*([\s\S]*?)```/i) || value.match(/```\s*([\s\S]*?)```/i);
  if (codeFence) return tryParseJson(codeFence[1].trim());
  const start = value.indexOf('{');
  const end = value.lastIndexOf('}');
  if (start !== -1 && end !== -1 && end > start) return tryParseJson(value.slice(start, end + 1));
  return null;
}

function validateInput(schema, input) {
  if (!schema || typeof schema !== 'object') {
    throw new Error('Invalid validation schema.');
  }
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error(`Expected an object for input, got ${input === null ? 'null' : Array.isArray(input) ? 'array' : typeof input}.`);
  }
  const errors = [];
  const required = Array.isArray(schema.required) ? schema.required : [];
  const fields = schema.fields || {};

  for (const fieldName of required) {
    if (input[fieldName] === undefined || input[fieldName] === null) {
      errors.push(`Missing required field: "${fieldName}".`);
    } else {
      const fieldSchema = fields[fieldName];
      if (fieldSchema && fieldSchema.type) {
        const actualType = typeof input[fieldName];
        if (actualType !== fieldSchema.type) {
          errors.push(`Field "${fieldName}" must be of type ${fieldSchema.type}, got ${actualType}.`);
        }
      }
      if (fieldSchema && fieldSchema.min != null && typeof input[fieldName] === 'number' && input[fieldName] < fieldSchema.min) {
        errors.push(`Field "${fieldName}" must be at least ${fieldSchema.min}, got ${input[fieldName]}.`);
      }
      if (fieldSchema && fieldSchema.max != null && typeof input[fieldName] === 'number' && input[fieldName] > fieldSchema.max) {
        errors.push(`Field "${fieldName}" must be at most ${fieldSchema.max}, got ${input[fieldName]}.`);
      }
    }
  }

  for (const [fieldName, fieldSchema] of Object.entries(fields)) {
    if (input[fieldName] !== undefined && fieldSchema && fieldSchema.type) {
      const actualType = typeof input[fieldName];
      if (actualType !== fieldSchema.type && !errors.some(e => e.includes(`"${fieldName}" must be of type`))) {
        errors.push(`Field "${fieldName}" must be of type ${fieldSchema.type}, got ${actualType}.`);
      }
    }
  }

  if (errors.length) {
    throw new Error(`Validation error: ${errors.join(' ')}`);
  }
  return true;
}

function cloneMessages(messages) {
  return Array.isArray(messages) ? messages.map(message => ({ ...message })) : [];
}

function cloneLogs(logs) {
  return Array.isArray(logs) ? logs.map(log => ({ ...log })) : [];
}

function mergeLogEntries(existingLogs, incomingLogs) {
  const merged = new Map();
  for (const entry of [...cloneLogs(existingLogs), ...cloneLogs(incomingLogs)]) {
    if (!entry || typeof entry !== 'object') continue;
    const key = entry.id || `${entry.createdAt || ''}:${entry.level || ''}:${entry.message || ''}`;
    merged.set(key, entry);
  }
  return [...merged.values()]
    .sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')))
    .slice(-MAX_LOG_ENTRIES);
}

function extractStreamDeltaText(payload) {
  const choice = payload?.choices?.[0];
  const deltaContent = choice?.delta?.content;
  if (typeof deltaContent === 'string') return deltaContent;
  if (Array.isArray(deltaContent)) return deltaContent.map(part => typeof part === 'string' ? part : (part?.text || '')).join('');
  const messageContent = choice?.message?.content;
  if (typeof messageContent === 'string') return messageContent;
  if (Array.isArray(messageContent)) return messageContent.map(part => typeof part === 'string' ? part : (part?.text || '')).join('');
  return '';
}

function extractAssistantTextFromResult(result) {
  if (!result || !Array.isArray(result.choices) || !result.choices.length) return '';
  return extractStreamDeltaText({ choices: result.choices });
}

function parseAgentToolCalls(text) {
  const toolCalls = [];
  let cleanedText = String(text || '');
  const toolRegex = /<localai-tool\s+name="([^"]+)"\s*>([\s\S]*?)<\/localai-tool>/gi;
  cleanedText = cleanedText.replace(toolRegex, (_, name, rawInput = '') => {
    const input = extractJsonFromText(String(rawInput || '').trim());
    if (name && input && typeof input === 'object') toolCalls.push({ name: String(name).trim(), input });
    return '';
  });
  cleanedText = cleanedText.replace(/\n{3,}/g, '\n\n').trim();
  return { toolCalls, cleanedText };
}

function parseAssistantActions(text) {
  const actions = [];
  let cleanedText = String(text || '');
  const actionRegex = /<localai-(write|delete|open)\s+path="([^"]+)"(?:\s*\/>|>([\s\S]*?)<\/localai-write>)/gi;
  cleanedText = cleanedText.replace(actionRegex, (_, type, filePath, content = '') => {
    if (type === 'write') actions.push({ type, path: String(filePath || '').trim(), content: String(content || '').replace(/^\n/, '') });
    else actions.push({ type, path: String(filePath || '').trim() });
    return '';
  });
  cleanedText = cleanedText.replace(/\n{3,}/g, '\n\n').trim();
  return { actions, cleanedText };
}

function summarizeToolInput(name, input) {
  if (!input || typeof input !== 'object') return name;
  switch (name) {
    case 'read_file':
    case 'write_file':
    case 'delete_path':
      return `${name} ${input.path || ''}`.trim();
    case 'list_files':
      return `${name} ${input.path || '.'}`.trim();
    case 'search_text':
      return `${name} "${truncateText(input.pattern || '', 40)}"`;
    case 'run_shell':
      return `${name} ${truncateText(input.command || '', 60)}`;
    default:
      return `${name} ${truncateText(JSON.stringify(input), 60)}`;
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error(`Request body exceeds ${MAX_BODY_BYTES} bytes.`));
        req.destroy();
        return;
      }
      raw += chunk.toString();
    });
    req.on('end', () => resolve(raw));
    req.on('error', reject);
  });
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function authenticate(req) {
  const requiredApiKey = String(process.env.CLOUD_EXECUTOR_API_KEY || '').trim();
  if (!requiredApiKey) return true;
  return String(req.headers.authorization || '') === `Bearer ${requiredApiKey}`;
}

function normalizeSandboxConfig(input = {}) {
  return {
    enabled: input.enabled !== false,
    runtimeRequired: input.runtimeRequired !== false,
    image: String(input.image || DEFAULT_SANDBOX_IMAGE).trim() || DEFAULT_SANDBOX_IMAGE,
    autoBuildImage: input.autoBuildImage !== false,
    networkMode: String(input.networkMode || DEFAULT_SANDBOX_NETWORK).trim() || DEFAULT_SANDBOX_NETWORK,
    toolTimeoutMs: Math.max(1000, Math.min(30 * 60 * 1000, Number(input.toolTimeoutMs || DEFAULT_SANDBOX_TOOL_TIMEOUT_MS))),
    retainOnFailure: input.retainOnFailure !== false,
    containerModelBaseUrl: String(input.containerModelBaseUrl || '').trim(),
    containerNativeBaseUrl: String(input.containerNativeBaseUrl || '').trim()
  };
}

function sandboxKey(config) {
  const raw = JSON.stringify({
    image: config.image,
    networkMode: config.networkMode,
    toolTimeoutMs: config.toolTimeoutMs,
    retainOnFailure: config.retainOnFailure
  });
  return crypto.createHash('sha1').update(raw).digest('hex').slice(0, 12);
}

function getModelBaseUrl(task) {
  return String(task?.lmStudio?.baseUrl || DEFAULT_MODEL_BASE_URL).trim().replace(/\/+$/, '') || DEFAULT_MODEL_BASE_URL;
}

async function fetchAvailableModels(baseUrl) {
  const url = new URL(`${baseUrl}/models`);
  const transport = url.protocol === 'http:' ? http : https;
  return new Promise((resolve, reject) => {
    const req = transport.request({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || (url.protocol === 'http:' ? 80 : 443),
      path: `${url.pathname}${url.search}`,
      method: 'GET',
      headers: {
        'Accept': 'application/json'
      },
      timeout: 10000
    }, (res) => {
      let raw = '';
      res.on('data', chunk => raw += chunk.toString());
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`LM Studio models endpoint error (${res.statusCode}): ${extractErrorMessage(raw) || raw}`));
          return;
        }
        try {
          const parsed = JSON.parse(raw);
          const entries = Array.isArray(parsed?.data) ? parsed.data : [];
          resolve(entries.map(entry => entry?.id).filter(Boolean));
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('LM Studio models request timeout')); });
    req.end();
  });
}

async function resolveTaskModelId(task) {
  const configured = String(task?.modelId || DEFAULT_MODEL_ID).trim() || DEFAULT_MODEL_ID;
  if (configured && configured !== 'auto') return configured;
  const available = await fetchAvailableModels(getModelBaseUrl(task));
  const picked = available.find(id => !/\b(embed|embedding|bge|e5|gte|nomic|snowflake)\b/i.test(String(id || ''))) || available[0];
  if (!picked) throw new Error('LM Studio is reachable but no loaded model is available for cloud execution.');
  return picked;
}

async function requestLocalChat(messages, task) {
  const url = new URL(`${getModelBaseUrl(task)}/chat/completions`);
  const transport = url.protocol === 'http:' ? http : https;
  const modelId = await resolveTaskModelId(task);
  const body = JSON.stringify({
    model: modelId,
    messages,
    temperature: task.temperature ?? 0.2,
    max_tokens: task.maxTokens ?? 4096,
    stream: false
  });
  return new Promise((resolve, reject) => {
    const req = transport.request({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || (url.protocol === 'http:' ? 80 : 443),
      path: `${url.pathname}${url.search}`,
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      },
      timeout: 120000
    }, (res) => {
      let raw = '';
      res.on('data', chunk => raw += chunk.toString());
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`LM Studio error (${res.statusCode}): ${extractErrorMessage(raw) || raw}`));
          return;
        }
        try { resolve(JSON.parse(raw)); } catch (error) { reject(error); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('LM Studio request timeout')); });
    req.write(body);
    req.end();
  });
}

class CloudTaskStore {
  constructor() {
    this.taskIndex = { version: 1, tasks: [] };
  }

  initialize() {
    ensureDirSync(TASKS_ROOT);
    this.taskIndex = readJsonFile(TASK_INDEX_PATH, { version: 1, tasks: [] });
  }

  getTaskPath(taskId) {
    return path.join(TASKS_ROOT, `${taskId}.json`);
  }

  saveTaskIndex() {
    writeJsonFile(TASK_INDEX_PATH, this.taskIndex);
  }

  syncTaskRecord(task) {
    const summary = {
      id: task.id,
      title: task.title,
      status: task.status,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      startedAt: task.startedAt || '',
      finishedAt: task.finishedAt || '',
      rounds: Number(task.rounds || 0),
      agentId: task.agentId || '',
      agentType: task.agentType || 'general-purpose',
      teamName: task.teamName || '',
      resultPreview: truncateText(normalizeWhitespace(task.resultText || task.resultPreview || ''), 180),
      error: truncateText(normalizeWhitespace(task.error || ''), 180),
      sandboxId: task.sandboxId || '',
      sandboxState: task.sandboxState || '',
      checkpointAt: task.checkpointAt || '',
      resumeCount: Number(task.resumeCount || 0),
      awaitingQuestionId: task.awaitingQuestionId || '',
      patchSummary: truncateText(normalizeWhitespace(task.patchSummary || ''), 180),
      containerImage: task.containerImage || ''
    };
    const existing = this.taskIndex.tasks.findIndex(entry => entry.id === task.id);
    if (existing === -1) this.taskIndex.tasks.push(summary);
    else this.taskIndex.tasks[existing] = summary;
    this.saveTaskIndex();
  }

  saveTask(task) {
    writeJsonFile(this.getTaskPath(task.id), task);
    this.syncTaskRecord(task);
    return task;
  }

  loadTask(taskId) {
    return readJsonFile(this.getTaskPath(taskId), null);
  }

  updateTask(taskId, updater) {
    const task = this.loadTask(taskId);
    if (!task) return null;
    const nextTask = typeof updater === 'function'
      ? (updater(task) || task)
      : Object.assign(task, updater || {});
    nextTask.updatedAt = new Date().toISOString();
    this.saveTask(nextTask);
    return nextTask;
  }

  listTaskRecords() {
    return [...(this.taskIndex.tasks || [])].sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  }

  listTasks() {
    return this.listTaskRecords()
      .map(task => this.loadTask(task.id))
      .filter(Boolean)
      .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  }

  createTask(input) {
    const now = new Date().toISOString();
    const task = {
      id: input.id || createId('rtask'),
      title: truncateText(normalizeWhitespace(input.title || input.prompt || 'Remote Task'), 72),
      prompt: input.prompt || '',
      status: input.status || 'pending',
      createdAt: now,
      updatedAt: now,
      startedAt: '',
      finishedAt: '',
      rounds: 0,
      messages: cloneMessages(input.messages),
      logs: [],
      resultText: '',
      resultPreview: '',
      error: '',
      stopRequested: false,
      modelId: input.modelId || DEFAULT_MODEL_ID,
      temperature: input.temperature ?? 0.2,
      maxTokens: input.maxTokens ?? 4096,
      maxRounds: Math.max(1, Math.min(12, Number(input.maxRounds || DEFAULT_MAX_ROUNDS))),
      allowShell: input.allowShell !== false,
      shellTimeoutMs: Math.max(1000, Math.min(600000, Number(input.shellTimeoutMs || DEFAULT_SHELL_TIMEOUT_MS))),
      agentId: input.agentId || '',
      agentType: input.agentType || 'general-purpose',
      agentName: input.agentName || '',
      teamName: input.teamName || '',
      mode: input.mode || 'default',
      isolation: input.isolation || 'sandbox',
      sandboxConfig: normalizeSandboxConfig(input.sandboxConfig || {}),
      sandboxId: input.sandboxId || '',
      sandboxState: input.sandboxState || 'pending',
      checkpointAt: '',
      checkpoint: input.checkpoint || null,
      resumeCount: Number(input.resumeCount || 0),
      externalMessages: [],
      awaitingQuestionId: '',
      patch: input.patch || null,
      patchSummary: input.patchSummary || '',
      containerImage: input.containerImage || '',
      workspaceName: input.workspaceName || '',
      lmStudio: {
        baseUrl: String(input.lmStudio?.baseUrl || DEFAULT_MODEL_BASE_URL).trim().replace(/\/+$/, '') || DEFAULT_MODEL_BASE_URL,
        nativeBaseUrl: String(input.lmStudio?.nativeBaseUrl || DEFAULT_NATIVE_BASE_URL).trim().replace(/\/+$/, '') || DEFAULT_NATIVE_BASE_URL
      }
    };
    this.saveTask(task);
    return task;
  }

  appendLog(taskId, message, level = 'info') {
    return this.updateTask(taskId, task => {
      task.logs = mergeLogEntries(task.logs, [{
        id: createId('log'),
        createdAt: new Date().toISOString(),
        level,
        message: truncateText(String(message || ''), 1000)
      }]);
      return task;
    });
  }
}

class CloudTaskManager {
  constructor() {
    this.store = new CloudTaskStore();
    this.running = new Map();
    this.sandboxManagers = new Map();
  }

  getSandboxManager(config) {
    const normalized = normalizeSandboxConfig(config);
    const key = sandboxKey(normalized);
    if (!this.sandboxManagers.has(key)) {
      this.sandboxManagers.set(key, new DockerSandboxManager({
        repoRoot: path.resolve(__dirname, '..'),
        storageRoot: path.join(DATA_ROOT, 'sandboxes', key),
        image: normalized.image,
        dockerfilePath: path.join(path.resolve(__dirname, '..'), 'sandbox', 'Dockerfile'),
        networkMode: normalized.networkMode,
        autoBuild: normalized.autoBuildImage,
        keepSandboxes: normalized.retainOnFailure,
        maxToolTimeoutMs: normalized.toolTimeoutMs,
        containerNamePrefix: 'localai-cloud-sbx'
      }));
    }
    return this.sandboxManagers.get(key);
  }

  async initialize() {
    this.store.initialize();
    const staleTasks = this.store.listTaskRecords().filter(task => ['pending', 'running', 'resuming', 'interrupted'].includes(task.status));
    for (const task of staleTasks) {
      this.store.updateTask(task.id, currentTask => {
        currentTask.status = currentTask.checkpoint && currentTask.checkpoint.phase === 'executing_tools'
          ? 'interrupted'
          : 'resuming';
        currentTask.stopRequested = false;
        currentTask.finishedAt = '';
        currentTask.error = '';
        currentTask.resumeCount = Number(currentTask.resumeCount || 0) + 1;
        return currentTask;
      });
      if (task.status === 'running') {
        this.store.appendLog(task.id, 'Executor restarted. Resuming task from persisted sandbox checkpoint.');
      }
    }
    this.schedule();
  }

  getTask(taskId) {
    return this.store.loadTask(taskId);
  }

  listTasks() {
    return this.store.listTasks();
  }

  async createSandboxForTask(taskId, files, sandboxConfig) {
    const manager = this.getSandboxManager(sandboxConfig);
    const sandbox = await manager.createFromFiles({
      sandboxId: `remote_${taskId}`,
      files
    });
    return { manager, sandbox };
  }

  async createTask(input) {
    const sandboxConfig = normalizeSandboxConfig(input.sandbox || {});
    const taskId = createId('rtask');
    const { sandbox } = await this.createSandboxForTask(taskId, input.files || [], sandboxConfig);
    const task = this.store.createTask({
      id: taskId,
      title: input.title,
      prompt: input.prompt,
      messages: input.messages || [],
      workspaceName: input.workspaceName || '',
      modelId: input.modelId || DEFAULT_MODEL_ID,
      temperature: input.temperature,
      maxTokens: input.maxTokens,
      maxRounds: input.maxRounds,
      allowShell: input.allowShell !== false,
      shellTimeoutMs: input.shellTimeoutMs,
      sandboxConfig,
      sandboxId: sandbox.id,
      sandboxState: 'ready',
      containerImage: sandbox.image,
      lmStudio: input.lmStudio || {}
    });

    this.store.appendLog(task.id, `Task created in sandbox ${sandbox.id}.`);
    this.schedule();
    return this.getTask(task.id);
  }

  async ensureSandbox(task) {
    const manager = this.getSandboxManager(task.sandboxConfig || {});
    const sandbox = task.sandboxId ? manager.loadSandbox(task.sandboxId) : null;
    if (!sandbox) throw new Error(`Sandbox not found for task ${task.id}`);
    const attached = await manager.attach(sandbox);
    this.store.updateTask(task.id, currentTask => {
      currentTask.sandboxState = attached.state || 'ready';
      currentTask.containerImage = attached.image || currentTask.containerImage;
      return currentTask;
    });
    return { manager, sandbox: attached };
  }

  stopTask(taskId) {
    const task = this.getTask(taskId);
    if (!task) return null;

    if (['pending', 'resuming', 'interrupted'].includes(task.status)) {
      this.store.updateTask(taskId, currentTask => {
        currentTask.status = 'stopped';
        currentTask.stopRequested = true;
        currentTask.finishedAt = new Date().toISOString();
        return currentTask;
      });
      this.store.appendLog(taskId, 'Task stopped before execution.', 'warn');
      return this.getTask(taskId);
    }

    const runtimeState = this.running.get(taskId);
    if (runtimeState) {
      runtimeState.stopRequested = true;
      if (runtimeState.activeChild && typeof runtimeState.activeChild.kill === 'function') {
        try { runtimeState.activeChild.kill(); } catch (_) {}
      }
    }
    this.store.updateTask(taskId, currentTask => {
      currentTask.stopRequested = true;
      return currentTask;
    });
    this.store.appendLog(taskId, 'Stop requested by API.', 'warn');
    return this.getTask(taskId);
  }

  appendExternalMessage(taskId, message, meta = {}) {
    const task = this.getTask(taskId);
    if (!task) return null;
    return this.store.updateTask(taskId, currentTask => {
      currentTask.externalMessages = Array.isArray(currentTask.externalMessages) ? currentTask.externalMessages : [];
      currentTask.externalMessages.push({
        id: createId('extmsg'),
        createdAt: new Date().toISOString(),
        content: String(message || ''),
        senderAgentId: meta.senderAgentId || '',
        agentId: meta.agentId || ''
      });
      if (currentTask.status === 'awaiting_user') {
        currentTask.status = 'resuming';
        currentTask.awaitingQuestionId = '';
        currentTask.awaitingSince = '';
        currentTask.finishedAt = '';
        currentTask.error = '';
      }
      return currentTask;
    });
  }

  resumeTask(taskId) {
    const task = this.getTask(taskId);
    if (!task) return null;
    return this.store.updateTask(taskId, currentTask => {
      currentTask.status = 'resuming';
      currentTask.stopRequested = false;
      currentTask.finishedAt = '';
      currentTask.error = '';
      currentTask.awaitingQuestionId = '';
      currentTask.awaitingSince = '';
      currentTask.resumeCount = Number(currentTask.resumeCount || 0) + 1;
      return currentTask;
    });
  }

  getTaskOutput(taskId) {
    const task = this.getTask(taskId);
    if (!task) return null;
    return {
      id: task.id,
      status: task.status,
      resultText: task.resultText || '',
      error: task.error || '',
      logs: cloneLogs(task.logs || []),
      messages: cloneMessages(task.messages || []),
      patch: task.patch || null,
      patchSummary: task.patchSummary || ''
    };
  }

  updateTaskMetadata(taskId, changes = {}) {
    return this.store.updateTask(taskId, currentTask => Object.assign(currentTask, changes || {}));
  }

  schedule() {
    const availableSlots = Math.max(0, MAX_CONCURRENT_TASKS - this.running.size);
    if (!availableSlots) return;
    const pending = this.store.listTaskRecords()
      .filter(task => ['pending', 'resuming', 'interrupted'].includes(task.status))
      .slice(0, availableSlots);
    for (const task of pending) {
      this.startTask(task.id).catch(() => {});
    }
  }

  async executeTool(task, toolCall, runtimeState, sandboxRef) {
    if (toolCall.name === 'run_shell' && task.allowShell === false) {
      throw new Error('Shell execution is disabled for this task.');
    }
    return sandboxRef.manager.execTool(sandboxRef.sandbox, toolCall, {
      runtimeState,
      timeoutMs: Math.max(1000, Math.min(task.shellTimeoutMs || DEFAULT_SHELL_TIMEOUT_MS, Number(toolCall.input?.timeoutMs || task.shellTimeoutMs || DEFAULT_SHELL_TIMEOUT_MS)))
    });
  }

  async applyAssistantActionsToSandbox(actions, sandboxRef) {
    if (!Array.isArray(actions) || !actions.length) return;
    for (const action of actions) {
      if (action.type === 'write') {
        await sandboxRef.manager.execTool(sandboxRef.sandbox, {
          name: 'write_file',
          input: { path: action.path, content: action.content || '' }
        }, { timeoutMs: DEFAULT_SANDBOX_TOOL_TIMEOUT_MS });
      } else if (action.type === 'delete') {
        await sandboxRef.manager.execTool(sandboxRef.sandbox, {
          name: 'delete_path',
          input: { path: action.path }
        }, { timeoutMs: DEFAULT_SANDBOX_TOOL_TIMEOUT_MS });
      }
    }
  }

  async startTask(taskId) {
    if (this.running.has(taskId)) return;
    const task = this.getTask(taskId);
    if (!task || !['pending', 'resuming', 'interrupted'].includes(task.status)) return;

    const runtimeState = {
      stopRequested: false,
      activeChild: null,
      priorStatus: task.status
    };
    this.running.set(taskId, runtimeState);
    this.store.updateTask(taskId, currentTask => {
      currentTask.status = 'running';
      currentTask.startedAt = currentTask.startedAt || new Date().toISOString();
      currentTask.stopRequested = false;
      currentTask.sandboxState = currentTask.sandboxId ? 'resuming' : 'preparing';
      return currentTask;
    });
    this.store.appendLog(taskId, `Task started in sandbox ${task.sandboxId}.`);

    try {
      const sandboxRef = await this.ensureSandbox(this.getTask(taskId));

      for (;;) {
        const currentTask = this.getTask(taskId);
        if (!currentTask) throw new Error(`Task not found: ${taskId}`);
        if (runtimeState.stopRequested || currentTask.stopRequested) throw new Error('Task stopped by user.');

        let conversation = cloneMessages(currentTask.messages || []);
        let checkpoint = currentTask.checkpoint || null;
        let round = Number(currentTask.rounds || 0);
        let pendingToolCalls = [];
        let toolResultBlocks = [];
        let nextToolIndex = 0;
        const externalMessages = Array.isArray(currentTask.externalMessages)
          ? currentTask.externalMessages.map(message => ({ ...message }))
          : [];
        if (externalMessages.length) {
          conversation.push({
            role: 'user',
            content: externalMessages.map(item => `[External message]\n${item.content || ''}`).join('\n\n')
          });
          this.store.updateTask(taskId, taskState => {
            taskState.messages = cloneMessages(conversation);
            taskState.externalMessages = [];
            return taskState;
          });
        }

        if (checkpoint && checkpoint.phase === 'executing_tools' && Array.isArray(checkpoint.pendingToolCalls) && checkpoint.pendingToolCalls.length) {
          round = Math.max(1, Number(checkpoint.round || round || 1));
          conversation = cloneMessages(checkpoint.conversation || conversation);
          pendingToolCalls = checkpoint.pendingToolCalls;
          toolResultBlocks = Array.isArray(checkpoint.toolResultBlocks) ? [...checkpoint.toolResultBlocks] : [];
          nextToolIndex = Math.max(0, Number(checkpoint.nextToolIndex || 0));
          if (checkpoint.gitRef && (runtimeState.priorStatus === 'interrupted' || currentTask.status === 'interrupted')) {
            await sandboxRef.manager.restoreToRef(sandboxRef.sandbox, checkpoint.gitRef);
          }
          this.store.appendLog(taskId, `Round ${round}/${currentTask.maxRounds} (resumed)`);
        } else {
          round += 1;
          if (round > currentTask.maxRounds) {
            throw new Error(`Agent stopped after ${currentTask.maxRounds} rounds without producing a final answer.`);
          }

          this.store.updateTask(taskId, taskState => {
            taskState.rounds = round;
            taskState.checkpointAt = new Date().toISOString();
            taskState.checkpoint = {
              phase: 'await_model',
              round,
              conversation: cloneMessages(conversation),
              pendingToolCalls: [],
              nextToolIndex: 0,
              toolResultBlocks: [],
              gitRef: taskState.checkpoint && taskState.checkpoint.gitRef ? taskState.checkpoint.gitRef : ''
            };
            return taskState;
          });
          this.store.appendLog(taskId, `Round ${round}/${currentTask.maxRounds}`);

          const result = await requestLocalChat(conversation, currentTask);
          const assistantText = extractAssistantTextFromResult(result);
          const { toolCalls, cleanedText } = parseAgentToolCalls(assistantText);

          if (!toolCalls.length) {
            const { actions, cleanedText: cleanedAnswer } = parseAssistantActions(assistantText);
            if (actions.length) await this.applyAssistantActionsToSandbox(actions, sandboxRef);
            const patch = await sandboxRef.manager.collectPatch(sandboxRef.sandbox);
            conversation.push({ role: 'assistant', content: assistantText });
            this.store.updateTask(taskId, taskState => {
              taskState.status = runtimeState.stopRequested ? 'stopped' : 'completed';
              taskState.finishedAt = new Date().toISOString();
              taskState.messages = cloneMessages(conversation);
              taskState.resultText = cleanedAnswer || assistantText;
              taskState.resultPreview = truncateText(normalizeWhitespace(cleanedAnswer || assistantText), 220);
              taskState.error = '';
              taskState.patch = patch.files.length ? patch : null;
              taskState.patchSummary = patch.files.length ? patch.summary : '';
              taskState.checkpointAt = new Date().toISOString();
              taskState.checkpoint = {
                phase: 'completed',
                round,
                conversation: cloneMessages(conversation),
                pendingToolCalls: [],
                nextToolIndex: 0,
                toolResultBlocks: [],
                gitRef: taskState.checkpoint && taskState.checkpoint.gitRef ? taskState.checkpoint.gitRef : ''
              };
              taskState.sandboxState = 'completed';
              return taskState;
            });
            this.store.appendLog(taskId, patch.files.length ? `Patch ready: ${patch.summary}` : 'Task completed.');
            break;
          }

          conversation.push({
            role: 'assistant',
            content: cleanedText || `Using ${toolCalls.length} tool(s).`
          });
          this.store.updateTask(taskId, taskState => {
            taskState.rounds = round;
            taskState.messages = cloneMessages(conversation);
            taskState.checkpointAt = new Date().toISOString();
            taskState.checkpoint = {
              phase: 'executing_tools',
              round,
              conversation: cloneMessages(conversation),
              pendingToolCalls: toolCalls,
              nextToolIndex: 0,
              toolResultBlocks: [],
              gitRef: taskState.checkpoint && taskState.checkpoint.gitRef ? taskState.checkpoint.gitRef : ''
            };
            return taskState;
          });
          if (cleanedText) this.store.appendLog(taskId, `Assistant note: ${truncateText(cleanedText, 220)}`);
          pendingToolCalls = toolCalls;
        }

        for (let index = nextToolIndex; index < pendingToolCalls.length; index += 1) {
          if (runtimeState.stopRequested) throw new Error('Task stopped by user.');
          const toolCall = pendingToolCalls[index];
          this.store.appendLog(taskId, `Tool: ${summarizeToolInput(toolCall.name, toolCall.input)}`);

          let ok = true;
          let resultValue = null;
          try {
            resultValue = await this.executeTool(this.getTask(taskId), toolCall, runtimeState, sandboxRef);
          } catch (error) {
            ok = false;
            resultValue = error instanceof Error ? error.message : String(error);
          }

          const formatted = ok ? JSON.stringify(resultValue, null, 2) : String(resultValue);
          toolResultBlocks.push(
            ok
              ? `Tool: ${toolCall.name}\nInput:\n${JSON.stringify(toolCall.input, null, 2)}\nResult:\n${truncateText(formatted, MAX_TOOL_OUTPUT_CHARS)}`
              : `Tool: ${toolCall.name}\nInput:\n${JSON.stringify(toolCall.input, null, 2)}\nError:\n${truncateText(formatted, 4000)}`
          );

          const gitRef = await sandboxRef.manager.commitCheckpoint(sandboxRef.sandbox, `remote-${taskId}-${round}-${index + 1}`);
          this.store.updateTask(taskId, taskState => {
            taskState.checkpointAt = new Date().toISOString();
            taskState.checkpoint = {
              phase: 'executing_tools',
              round,
              conversation: cloneMessages(conversation),
              pendingToolCalls,
              nextToolIndex: index + 1,
              toolResultBlocks: [...toolResultBlocks],
              gitRef
            };
            return taskState;
          });
          this.store.appendLog(taskId, `${toolCall.name}: ${ok ? 'ok' : 'error'} ${truncateText(formatted, 260)}`, ok ? 'info' : 'error');
        }

        conversation.push({
          role: 'user',
          content: [
            `[Tool results for round ${round}]`,
            toolResultBlocks.join('\n\n'),
            'Continue working. If the task is complete, provide the final answer. Otherwise request more tools with <localai-tool> tags.'
          ].join('\n\n')
        });
        this.store.updateTask(taskId, taskState => {
          taskState.messages = cloneMessages(conversation);
          taskState.checkpointAt = new Date().toISOString();
          taskState.checkpoint = {
            phase: 'await_model',
            round,
            conversation: cloneMessages(conversation),
            pendingToolCalls: [],
            nextToolIndex: 0,
            toolResultBlocks: [],
            gitRef: taskState.checkpoint && taskState.checkpoint.gitRef ? taskState.checkpoint.gitRef : ''
          };
          return taskState;
        });
      }
    } catch (error) {
      const errorText = error instanceof Error ? error.message : String(error);
      this.store.updateTask(taskId, currentTask => {
        currentTask.status = runtimeState.stopRequested ? 'stopped' : 'failed';
        currentTask.finishedAt = new Date().toISOString();
        currentTask.error = errorText;
        currentTask.sandboxState = currentTask.sandboxId ? (runtimeState.priorStatus === 'interrupted' ? 'interrupted' : 'failed') : currentTask.sandboxState;
        return currentTask;
      });
      this.store.appendLog(taskId, errorText, 'error');
    } finally {
      const finalTask = this.getTask(taskId);
      if (finalTask && finalTask.sandboxId) {
        const manager = this.getSandboxManager(finalTask.sandboxConfig || {});
        const sandbox = manager.loadSandbox(finalTask.sandboxId);
        if (sandbox && (!normalizeSandboxConfig(finalTask.sandboxConfig || {}).retainOnFailure && finalTask.status === 'completed')) {
          await manager.destroy(sandbox, { removeDir: true });
        } else if (sandbox && finalTask.status === 'completed') {
          await manager.stop(sandbox);
        }
      }
      this.running.delete(taskId);
      this.schedule();
    }
  }
}

const taskManager = new CloudTaskManager();

async function handleRequest(req, res) {
  try {
    const requestUrl = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
    if (requestUrl.pathname !== '/health' && !authenticate(req)) {
      sendJson(res, 401, { ok: false, error: 'Unauthorized' });
      return;
    }

    if (req.method === 'GET' && requestUrl.pathname === '/health') {
      const health = await taskManager.getSandboxManager(normalizeSandboxConfig({})).getHealth(true);
      sendJson(res, 200, {
        ok: true,
        mode: 'sandbox-container',
        tasks: taskManager.store.listTaskRecords().length,
        running: taskManager.running.size,
        dataRoot: DATA_ROOT,
        modelBaseUrl: DEFAULT_MODEL_BASE_URL,
        nativeBaseUrl: DEFAULT_NATIVE_BASE_URL,
        sandbox: {
          dockerReady: Boolean(health.dockerReady),
          imageReady: Boolean(health.imageReady),
          image: health.image,
          networkMode: health.networkMode,
          detail: health.detail || ''
        }
      });
      return;
    }

    if (req.method === 'GET' && requestUrl.pathname === '/tasks') {
      sendJson(res, 200, { ok: true, tasks: taskManager.listTasks() });
      return;
    }

    const taskMatch = requestUrl.pathname.match(/^\/tasks\/([^/]+)$/);
    if (req.method === 'GET' && taskMatch) {
      const task = taskManager.getTask(taskMatch[1]);
      if (!task) {
        sendJson(res, 404, { ok: false, error: 'Task not found' });
        return;
      }
      sendJson(res, 200, { ok: true, task });
      return;
    }

    const outputMatch = requestUrl.pathname.match(/^\/tasks\/([^/]+)\/output$/);
    if (req.method === 'GET' && outputMatch) {
      const output = taskManager.getTaskOutput(outputMatch[1]);
      if (!output) {
        sendJson(res, 404, { ok: false, error: 'Task not found' });
        return;
      }
      sendJson(res, 200, { ok: true, output });
      return;
    }

    const stopMatch = requestUrl.pathname.match(/^\/tasks\/([^/]+)\/stop$/);
    if (req.method === 'POST' && stopMatch) {
      const task = taskManager.stopTask(stopMatch[1]);
      if (!task) {
        sendJson(res, 404, { ok: false, error: 'Task not found' });
        return;
      }
      sendJson(res, 200, { ok: true, task });
      return;
    }

    const resumeMatch = requestUrl.pathname.match(/^\/tasks\/([^/]+)\/resume$/);
    if (req.method === 'POST' && resumeMatch) {
      const task = taskManager.resumeTask(resumeMatch[1]);
      if (!task) {
        sendJson(res, 404, { ok: false, error: 'Task not found' });
        return;
      }
      taskManager.schedule();
      sendJson(res, 200, { ok: true, task });
      return;
    }

    const messageMatch = requestUrl.pathname.match(/^\/tasks\/([^/]+)\/messages$/);
    if (req.method === 'POST' && messageMatch) {
      const raw = await readBody(req);
      const payload = raw ? JSON.parse(raw) : {};
      validateInput({
        required: ['message'],
        fields: { message: { type: 'string' } }
      }, payload);
      const task = taskManager.appendExternalMessage(messageMatch[1], payload.message, payload || {});
      if (!task) {
        sendJson(res, 404, { ok: false, error: 'Task not found' });
        return;
      }
      taskManager.schedule();
      sendJson(res, 200, { ok: true, task });
      return;
    }

    if (req.method === 'PATCH' && taskMatch) {
      const raw = await readBody(req);
      const payload = raw ? JSON.parse(raw) : {};
      if (!payload || typeof payload !== 'object') {
        sendJson(res, 400, { ok: false, error: 'Request body must be a JSON object.' });
        return;
      }
      const task = taskManager.updateTaskMetadata(taskMatch[1], payload.changes || payload || {});
      if (!task) {
        sendJson(res, 404, { ok: false, error: 'Task not found' });
        return;
      }
      sendJson(res, 200, { ok: true, task });
      return;
    }

    if (req.method === 'POST' && requestUrl.pathname === '/tasks') {
      const raw = await readBody(req);
      const payload = raw ? JSON.parse(raw) : {};
      validateInput({
        required: ['prompt'],
        fields: {
          prompt: { type: 'string' },
          title: { type: 'string' },
          modelId: { type: 'string' },
          temperature: { type: 'number', min: 0, max: 2 },
          maxTokens: { type: 'number', min: 1 },
          maxRounds: { type: 'number', min: 1, max: 12 },
          allowShell: { type: 'boolean' },
          shellTimeoutMs: { type: 'number', min: 1000, max: 600000 },
          agentId: { type: 'string' },
          agentType: { type: 'string' },
          teamName: { type: 'string' },
          mode: { type: 'string' },
          workspaceName: { type: 'string' }
        }
      }, payload);
      const task = await taskManager.createTask(payload || {});
      sendJson(res, 201, { ok: true, task });
      return;
    }

    sendJson(res, 404, { ok: false, error: 'Not found' });
  } catch (error) {
    sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
  }
}

async function main() {
  await taskManager.initialize();
  const server = http.createServer((req, res) => {
    handleRequest(req, res).catch(error => {
      sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
    });
  });

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`LocalAI cloud executor listening on http://127.0.0.1:${PORT}`);
  });
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
