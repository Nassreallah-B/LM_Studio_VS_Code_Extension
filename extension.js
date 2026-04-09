'use strict';

const vscode = require('vscode');
const http = require('http');
const https = require('https');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { DockerSandboxManager } = require('./lib/dockerSandbox');
const antiHallucination = require('./lib/antiHallucination');
const {
  AGENT_TYPE_CATALOG,
  ADVANCED_AGENT_TOOL_SPECS,
  buildAgentRolePromptSection,
  normalizeAgentType,
  agentDefinition,
  RuntimeFeatureStore
} = require('./lib/runtimeFeatures');

// ── State ─────────────────────────────────────────────────────────────────────
let chatProvider;
let statusBarItem;
let inlineCompletionProvider;
let isConnected = false;
let debounceTimer;
let lastConnectionError = '';
let extensionContext;
let appRuntime;

const DEFAULT_BASE_URL = 'http://localhost:1234/v1';
const DEFAULT_NATIVE_BASE_URL = 'http://localhost:1234';
const DEFAULT_CONTAINER_MODEL_BASE_URL = 'http://host.docker.internal:1234/v1';
const DEFAULT_CONTAINER_NATIVE_BASE_URL = 'http://host.docker.internal:1234';
const DEFAULT_MODEL_ID = 'auto';
const FALLBACK_MODEL_ID = 'auto';
const DEFAULT_EMBEDDING_MODEL = 'auto';
const EMBEDDING_MODEL_HINTS = /\b(embed|embedding|bge|e5|gte|nomic|snowflake)\b/i;
const WORKSPACE_FILE_LIMIT = 400;
const WORKSPACE_CONTEXT_EXCLUDES = '**/{node_modules,.git,dist,build,coverage,.next,out,target,.venv,venv,__pycache__}/**';
const CHATS_DIR = 'chats';
const CHAT_INDEX_FILE = 'index.json';
const CHAT_MESSAGES_DIR = 'messages';
const CHAT_SUMMARIES_DIR = 'summaries';
const TASKS_DIR = 'tasks';
const TASK_INDEX_FILE = 'index.json';
const PATCHES_DIR = 'patches';
const PATCH_INDEX_FILE = 'index.json';
const MEMORY_DIR = 'memory';
const GLOBAL_MEMORY_FILE = 'global.json';
const WORKSPACE_MEMORY_FILE = 'workspace.json';
const RAG_DIR = 'rag';
const RAG_INDEX_FILE = 'index.json';
const SANDBOXES_DIR = 'sandboxes';
const MAX_FILE_CONTEXT_CHARS = 12000;
const MAX_RAG_SNIPPET_CHARS = 10000;
const DEFAULT_MAX_RECENT_MESSAGES = 12;
const DEFAULT_COMPACTION_THRESHOLD = 12;
const DEFAULT_RAG_TOP_K = 8;
const DEFAULT_RAG_CANDIDATES = 24;
const DEFAULT_CHUNK_SIZE = 1200;
const DEFAULT_CHUNK_OVERLAP = 200;
const DEFAULT_AGENT_MAX_ROUNDS = 6;
const DEFAULT_AGENT_SHELL_TIMEOUT_MS = 30000;
const DEFAULT_AGENT_MAX_CONCURRENT_TASKS = 2;
const DEFAULT_CLOUD_POLL_INTERVAL_MS = 5000;
const DEFAULT_SANDBOX_IMAGE = 'localai-code-sandbox:latest';
const DEFAULT_SANDBOX_NETWORK = 'none';
const DEFAULT_SANDBOX_MAX_CONCURRENT = 2;
const DEFAULT_SANDBOX_TOOL_TIMEOUT_MS = 120000;
const DOCKER_AUTO_START_READY_TIMEOUT_MS = 45000;
const DOCKER_AUTO_START_COOLDOWN_MS = 30000;
const DOCKER_AUTO_START_POLL_MS = 2000;
const MAX_INDEX_FILE_BYTES = 350000;
const MAX_EMBED_CANDIDATES = 12;
const MAX_AGENT_TOOL_OUTPUT_CHARS = 12000;
const MAX_AGENT_TOOL_MODEL_RESULT_CHARS = 5000;
const MAX_AGENT_TOOL_MODEL_STDIO_CHARS = 2500;
const MAX_AGENT_TOOL_MODEL_LIST_ITEMS = 24;
const MAX_AGENT_TOOL_MODEL_MATCHES = 20;
const MAX_AGENT_FILE_READ_CHARS = 24000;
const MAX_AGENT_LIST_RESULTS = 250;
const MAX_AGENT_SEARCH_RESULTS = 120;
const MAX_TASK_LOG_ENTRIES = 240;
const MAX_CLOUD_SNAPSHOT_FILES = 280;
const MAX_CLOUD_SNAPSHOT_TOTAL_BYTES = 3 * 1024 * 1024;
const MAX_CLOUD_SNAPSHOT_FILE_BYTES = 220000;
const INDEXABLE_EXTENSIONS = new Set([
  '.js', '.jsx', '.ts', '.tsx', '.py', '.java', '.c', '.cpp', '.cc', '.cs',
  '.go', '.rs', '.rb', '.php', '.swift', '.kt', '.kts', '.scala', '.sh',
  '.ps1', '.sql', '.html', '.css', '.scss', '.sass', '.less', '.json',
  '.jsonc', '.yaml', '.yml', '.toml', '.ini', '.md', '.txt', '.xml'
]);
const EXCLUDED_PATH_PARTS = new Set([
  'node_modules', '.git', 'dist', 'build', 'coverage', '.next', 'out',
  'target', '.venv', 'venv', '__pycache__', '.idea', '.vscode-test'
]);
const CLOUD_SNAPSHOT_BASENAMES = new Set([
  'AGENTS.md',
  'Dockerfile',
  'Makefile',
  'package.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lockb',
  'requirements.txt',
  'requirements-dev.txt',
  'pyproject.toml',
  'Pipfile',
  'Pipfile.lock',
  'Cargo.toml',
  'Cargo.lock',
  'go.mod',
  'go.sum',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'settings.gradle',
  'settings.gradle.kts',
  '.gitignore',
  '.npmrc',
  '.env.example'
]);
const WORKSPACE_ACTION_INSTRUCTIONS = [
  'You are running inside a VS Code extension with workspace context.',
  'Do not claim that you cannot access or modify files when file or workspace context is provided.',
  'When the user asks you to create, modify, rename, delete, or manage files, you may emit workspace action tags that the extension can apply.',
  'Use paths relative to the workspace root.',
  'For file edits, emit the complete final file content.',
  'Supported action tags:',
  '<localai-write path="relative/path.ext">',
  'FULL FILE CONTENT',
  '</localai-write>',
  '<localai-delete path="relative/path.ext" />',
  '<localai-open path="relative/path.ext" />',
  'Keep a short human explanation outside the tags.'
].join('\n');

const AGENT_TOOL_SPECS = [
  { name: 'list_files', description: 'List files or folders inside the workspace.', example: '{"path":"src","depth":2,"pattern":"*.js"}' },
  { name: 'read_file', description: 'Read a file, optionally by line range.', example: '{"path":"src/index.js","startLine":1,"endLine":120}' },
  { name: 'search_text', description: 'Search text across the workspace or a subdirectory.', example: '{"pattern":"createServer","path":"src","isRegex":false,"caseSensitive":false,"maxResults":20}' },
  { name: 'write_file', description: 'Create or overwrite a workspace file inside the sandbox. Host changes are only applied later as a reviewed patch.', example: '{"path":"src/new-file.js","content":"export const ok = true;\\n"}' },
  { name: 'delete_path', description: 'Delete a workspace file or directory inside the sandbox. Host changes are only applied later as a reviewed patch.', example: '{"path":"src/old-file.js"}' },
  { name: 'run_shell', description: 'Run a shell command inside the sandboxed workspace to build, test, lint, or inspect.', example: '{"command":"npm test","cwd":".","timeoutMs":30000}' },
  { name: 'git_status', description: 'Read git status inside the sandboxed workspace snapshot.', example: '{"cwd":"."}' },
  { name: 'git_diff', description: 'Read git diff output inside the sandboxed workspace snapshot.', example: '{"cwd":".","staged":false}' },
  { name: 'list_tasks', description: 'List local background tasks.', example: '{}' },
  { name: 'get_task', description: 'Inspect one background task and its latest logs.', example: '{"taskId":"task_123"}' },
  { name: 'stop_task', description: 'Stop a pending or running background task.', example: '{"taskId":"task_123"}' },
  { name: 'spawn_task', description: 'Spawn a new background agent task with its own prompt and optional cwd.', example: '{"title":"Backend patch","prompt":"Fix the failing API tests","cwd":"."}' }
];
const CLOUD_AGENT_TOOL_SPECS = [
  { name: 'list_files', description: 'List files or folders inside the isolated task workspace.', example: '{"path":"src","depth":2,"pattern":"*.js"}' },
  { name: 'read_file', description: 'Read a file from the isolated task workspace, optionally by line range.', example: '{"path":"src/index.js","startLine":1,"endLine":120}' },
  { name: 'search_text', description: 'Search text across the isolated task workspace or a subdirectory.', example: '{"pattern":"createServer","path":"src","isRegex":false,"caseSensitive":false,"maxResults":20}' },
  { name: 'write_file', description: 'Create or overwrite a file inside the isolated task workspace.', example: '{"path":"src/new-file.js","content":"export const ok = true;\\n"}' },
  { name: 'delete_path', description: 'Delete a file or directory inside the isolated task workspace.', example: '{"path":"src/old-file.js"}' },
  { name: 'run_shell', description: 'Run a shell command inside the isolated task workspace to build, test, lint, or inspect.', example: '{"command":"npm test","cwd":".","timeoutMs":30000}' }
];
const LOCAL_ONLY_AGENT_TOOL_SPECS = [
  { name: 'ask_user_question', description: 'Pause the current task and ask the user a clarifying question.', example: '{"question":"Should the migration target Postgres 15?","choices":["yes","no"]}' },
  { name: 'lsp_symbols', description: 'Read document symbols from the VS Code language server for a file.', example: '{"path":"src/index.ts"}' },
  { name: 'lsp_definitions', description: 'Resolve definitions at a given position in a file.', example: '{"path":"src/index.ts","line":12,"character":8}' },
  { name: 'lsp_references', description: 'Find references at a given position in a file.', example: '{"path":"src/index.ts","line":12,"character":8}' },
  { name: 'lsp_diagnostics', description: 'Read diagnostics for a file from the VS Code language service.', example: '{"path":"src/index.ts"}' },
  { name: 'workflow_run', description: 'Run a named workflow or orchestrated team pattern.', example: '{"kind":"team","goal":"Harden the auth module","aspects":["backend","tests"],"verify":true}' },
  { name: 'fork_chat', description: 'Fork the current chat into a new branch.', example: '{"title":"Investigate safer migration"}' }
];
const LOCAL_AGENT_TOOL_SPECS = [...AGENT_TOOL_SPECS, ...ADVANCED_AGENT_TOOL_SPECS, ...LOCAL_ONLY_AGENT_TOOL_SPECS];
const CLOUD_RUNTIME_SYSTEM_INSTRUCTIONS = [
  'You are running inside an isolated remote task workspace snapshot.',
  'Every file modification only affects this task workspace until the task finishes.',
  'Prefer tool tags over guessing, and do not claim that you cannot access or modify files in the task workspace.',
  'Shell commands, file reads, searches, and file writes happen remotely inside that isolated workspace.'
].join('\n');
const ANTI_HALLUCINATION_SYSTEM_INSTRUCTIONS = [
  'Never present an unverified claim as established fact.',
  'When the task is analytical, technical, or audit-oriented, explicitly distinguish: CONFIRMED, PROBABLE, UNCERTAIN, NON-VERIFIED, or FALSE.',
  'Documentation alone is not proof of implementation.',
  'A TODO, commented config, named file, unexecuted script, isolated test, or placeholder is not proof that a feature works.',
  'Distinguish clearly between: existing code, missing code, broken code, dead code, documentation, future intent, inactive configuration, and configuration proven active.',
  'If a point cannot be verified from the available code, files, logs, commands, or test outputs, say: "I cannot confirm this point with the available evidence."',
  'When auditing a project, cite exact evidence when available: file path, function name, command output, test result, or log origin.',
  'Do not invent numeric scores unless the scoring method is explicit and each sub-score is justified.',
  'If you detect a contradiction between documentation and code, call it out immediately.',
  'For recommendations, be concrete, applicable, project-specific, prioritized, and justified by real impact.',
  'For improvement proposals, separate quick wins, medium efforts, and heavy efforts, and avoid decorative recommendations.',
  'For code or file creation tasks, analyze the existing architecture first, identify the real files to change, reuse what already exists when possible, avoid duplication, state assumptions explicitly, and produce maintainable output.',
  'Prefer modifying the existing implementation cleanly over creating duplicate modules, layers, or APIs.',
  'Do not present a result as complete, production-ready, secure, scalable, robust, or finished without technical proof.',
  'Prefer simple, readable, testable code over premature abstraction, hidden hacks, or unnecessary dependencies.',
  'When proposing code, consider validation, authentication, authorization, secret handling, injection risk, XSS, CSRF, SSRF, path traversal, open redirect, dangerous deserialization, rate limits, sensitive logging, webhook verification, replay protection, timeout behavior, fail-open versus fail-closed, and minimum privileges when applicable.',
  'Never hardcode a secret, expose a token in frontend code, trust client input blindly, return sensitive stack traces to clients, use eval carelessly, build shell execution from unsafe input, concatenate unparameterized SQL, or log passwords, tokens, cookies, OTPs, or API keys.',
  'If runtime execution was not verified, say whether it is present in code, non-executed, non-validated in runtime, or non-confirmed in production.'
].join('\n');

const AGENT_EXECUTION_PLAYBOOK = [
  'Default execution playbook:',
  '1. Ground yourself in the workspace first with read_file, search_text, list_files, LSP tools, and existing tests before editing.',
  '2. If the request is about bugs, failing builds, or regressions, reproduce or inspect the failure before changing files.',
  '3. If you modify code, run the narrowest useful validation after the edit: diagnostics, tests, lint, build, or targeted shell checks.',
  '4. Prefer minimal, high-confidence edits over broad rewrites.',
  '5. For multi-file, risky, or cross-cutting work, consider workflow_run, spawn_agent, or orchestrate_team instead of doing everything blindly in one pass.',
  '6. If you used fresh web research, incorporate the verified findings into the solution and mention the relevant sources in the final answer.'
].join('\n');

// ── Helpers ───────────────────────────────────────────────────────────────────
function cfg(key) {
  return vscode.workspace.getConfiguration('localai').get(key);
}

function getBaseUrl() {
  return String(cfg('baseUrl') || DEFAULT_BASE_URL).trim().replace(/\/+$/, '') || DEFAULT_BASE_URL;
}

function getNativeBaseUrl() {
  return String(cfg('nativeBaseUrl') || DEFAULT_NATIVE_BASE_URL).trim().replace(/\/+$/, '') || DEFAULT_NATIVE_BASE_URL;
}

function getModelId() {
  return cfg('modelId') || DEFAULT_MODEL_ID;
}

function normalizeModelId(modelId) {
  const value = String(modelId || '').trim();
  if (!value) return DEFAULT_MODEL_ID;
  return value;
}

function getBaseModelId(modelId) {
  return normalizeModelId(modelId).split(':')[0];
}

function getEmbeddingModel() {
  return cfg('rag.embeddingModel') || DEFAULT_EMBEDDING_MODEL;
}

function getSandboxContainerModelBaseUrl() {
  return String(cfg('sandbox.containerModelBaseUrl') || DEFAULT_CONTAINER_MODEL_BASE_URL).trim().replace(/\/+$/, '') || DEFAULT_CONTAINER_MODEL_BASE_URL;
}

function getSandboxContainerNativeBaseUrl() {
  return String(cfg('sandbox.containerNativeBaseUrl') || DEFAULT_CONTAINER_NATIVE_BASE_URL).trim().replace(/\/+$/, '') || DEFAULT_CONTAINER_NATIVE_BASE_URL;
}

function memoryEnabled() {
  return cfg('memory.enabled') !== false;
}

function ragEnabled() {
  return cfg('rag.enabled') !== false;
}

function getMaxRecentMessages() {
  return Math.max(4, Number(cfg('memory.maxRecentMessages') || DEFAULT_MAX_RECENT_MESSAGES));
}

function getCompactionThreshold() {
  return Math.max(4, Number(cfg('memory.compactionThresholdMessages') || DEFAULT_COMPACTION_THRESHOLD));
}

function getRagTopK() {
  return Math.max(1, Number(cfg('rag.topK') || DEFAULT_RAG_TOP_K));
}

function getChunkSizeChars() {
  return Math.max(300, Number(cfg('rag.chunkSizeChars') || DEFAULT_CHUNK_SIZE));
}

function getChunkOverlapChars() {
  return Math.max(0, Math.min(getChunkSizeChars() - 50, Number(cfg('rag.chunkOverlapChars') || DEFAULT_CHUNK_OVERLAP)));
}

function getEmbedMaxRetries() {
  return Math.max(0, Math.min(10, Number(cfg('rag.embeddingMaxRetries') || 3)));
}

function getAutoRefreshIntervalMinutes() {
  return Math.max(0, Math.min(120, Number(cfg('rag.autoRefreshIntervalMinutes') || 30)));
}

function agentEnabled() {
  return cfg('agent.enabled') !== false;
}

function getAgentMaxRounds() {
  return Math.max(1, Math.min(12, Number(cfg('agent.maxRounds') || DEFAULT_AGENT_MAX_ROUNDS)));
}

function agentAllowShell() {
  return cfg('agent.allowShell') !== false;
}

function getAgentShellTimeoutMs() {
  return Math.max(1000, Math.min(600000, Number(cfg('agent.shellTimeoutMs') || DEFAULT_AGENT_SHELL_TIMEOUT_MS)));
}

function agentPreferWebForFreshInfo() {
  return cfg('agent.preferWebForFreshInfo') !== false;
}

function getAgentMaxConcurrentTasks() {
  return Math.max(1, Math.min(8, Number(cfg('agent.maxConcurrentTasks') || DEFAULT_AGENT_MAX_CONCURRENT_TASKS)));
}

function cloudEnabled() {
  return cfg('cloud.enabled') === true;
}

function getCloudExecutorUrl() {
  return String(cfg('cloud.executorUrl') || '').trim().replace(/\/+$/, '');
}

function getCloudApiKey() {
  return String(cfg('cloud.apiKey') || '').trim();
}

function getCloudPollIntervalMs() {
  return Math.max(1000, Math.min(60000, Number(cfg('cloud.pollIntervalMs') || DEFAULT_CLOUD_POLL_INTERVAL_MS)));
}

function cloudForwardApiToken() {
  return cfg('cloud.forwardApiToken') === true;
}

function getCloudMaxSnapshotFiles() {
  return Math.max(10, Math.min(1000, Number(cfg('cloud.maxSnapshotFiles') || MAX_CLOUD_SNAPSHOT_FILES)));
}

function getCloudMaxSnapshotTotalBytes() {
  const configured = cfg('cloud.maxSnapshotTotalBytes');
  if (configured != null && configured !== '') {
    const value = Number(configured);
    if (!isNaN(value) && value > 0) return value;
  }
  return MAX_CLOUD_SNAPSHOT_TOTAL_BYTES;
}

function getCloudMaxSnapshotFileBytes() {
  const configured = cfg('cloud.maxSnapshotFileBytes');
  if (configured != null && configured !== '') {
    const value = Number(configured);
    if (!isNaN(value) && value > 0) return value;
  }
  return MAX_CLOUD_SNAPSHOT_FILE_BYTES;
}

function getMemoryScope() {
  return cfg('memory.scope') || 'global+workspace';
}

function getMemoryScopeExplanation(scope) {
  const s = scope || getMemoryScope();
  switch (s) {
    case 'workspace':
      return 'Project-only memory: notes are stored per workspace and shared across chats in this project.';
    case 'global':
      return 'Global-only memory: notes are shared across all workspaces for personal preferences.';
    case 'global+workspace':
    default:
      return 'Global + project memory: personal preferences plus workspace-specific notes.';
  }
}

function getGlobalUserInstructions() {
  return normalizeInstructionText(cfg('instructions.global'));
}

function getWorkspaceUserInstructions() {
  return normalizeInstructionText(cfg('instructions.workspace'));
}

function sandboxEnabled() {
  return cfg('sandbox.enabled') !== false;
}

function sandboxRuntimeRequired() {
  return cfg('sandbox.runtimeRequired') !== false;
}

function getSandboxImage() {
  return String(cfg('sandbox.image') || DEFAULT_SANDBOX_IMAGE).trim() || DEFAULT_SANDBOX_IMAGE;
}

function sandboxAutoBuildImage() {
  return cfg('sandbox.autoBuildImage') !== false;
}

function sandboxAutoStartDocker() {
  return cfg('sandbox.autoStartDocker') !== false;
}

function getSandboxNetworkMode() {
  return String(cfg('sandbox.networkMode') || DEFAULT_SANDBOX_NETWORK).trim() || DEFAULT_SANDBOX_NETWORK;
}

function getSandboxMaxConcurrent() {
  return Math.max(1, Math.min(8, Number(cfg('sandbox.maxConcurrentSandboxes') || DEFAULT_SANDBOX_MAX_CONCURRENT)));
}

function getSandboxToolTimeoutMs() {
  return Math.max(1000, Math.min(30 * 60 * 1000, Number(cfg('sandbox.toolTimeoutMs') || DEFAULT_SANDBOX_TOOL_TIMEOUT_MS)));
}

function sandboxRetainOnFailure() {
  return cfg('sandbox.retainOnFailure') !== false;
}

function getDockerDesktopExecutableCandidates() {
  const candidates = [
    process.env.ProgramFiles ? path.join(process.env.ProgramFiles, 'Docker', 'Docker', 'Docker Desktop.exe') : '',
    process.env.ProgramW6432 ? path.join(process.env.ProgramW6432, 'Docker', 'Docker', 'Docker Desktop.exe') : '',
    process.env['ProgramFiles(x86)'] ? path.join(process.env['ProgramFiles(x86)'], 'Docker', 'Docker', 'Docker Desktop.exe') : '',
    process.env.LocalAppData ? path.join(process.env.LocalAppData, 'Docker', 'Docker Desktop.exe') : ''
  ];
  return [...new Set(candidates.filter(Boolean).map(candidate => path.normalize(candidate)))];
}

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
  } catch (error) {
    console.error(`[localai-code] Failed to read JSON file ${filePath}: ${error.message}`);
    return fallback;
  }
}

function writeJsonFile(filePath, value) {
  ensureDirSync(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
}

function fileExists(filePath) {
  try {
    return fs.existsSync(filePath);
  } catch (error) {
    console.error(`[localai-code] Failed to check file existence for ${filePath}: ${error.message}`);
    return false;
  }
}

function getWorkspaceStorageRoot(context) {
  if (context.storageUri && context.storageUri.fsPath) return context.storageUri.fsPath;
  return path.join(context.globalStorageUri.fsPath, 'no-workspace');
}

function safeRelativeToWorkspace(fsPath) {
  const folder = getWorkspaceFolder();
  if (!folder) return path.basename(fsPath);
  return path.relative(folder.uri.fsPath, fsPath).replace(/\\/g, '/');
}

function normalizeWhitespace(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function truncateText(text, maxChars) {
  const value = String(text || '');
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 3))}...`;
}

function normalizeInstructionText(text, maxChars = 12000) {
  const value = String(text || '').replace(/\r\n/g, '\n').trim();
  if (!value) return '';
  return truncateText(value, maxChars);
}

function summarizeInstructionPreview(text, maxChars = 140) {
  const value = normalizeWhitespace(text);
  return value ? truncateText(value, maxChars) : 'Off';
}

function cloneMessages(messages) {
  return Array.isArray(messages)
    ? messages.map(message => ({ ...message }))
    : [];
}

function cloneLogs(logs) {
  return Array.isArray(logs)
    ? logs.map(log => ({ ...log }))
    : [];
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
    .slice(-MAX_TASK_LOG_ENTRIES);
}

function estimateTokens(text) {
  return Math.ceil(String(text || '').length / 4);
}

function tokenize(text) {
  const matches = String(text || '').toLowerCase().match(/[a-z0-9_./-]{2,}/g);
  return matches || [];
}

function scoreTokenOverlap(queryTokens, text) {
  if (!queryTokens.length || !text) return 0;
  const targetTokens = new Set(tokenize(text));
  if (!targetTokens.size) return 0;
  let hits = 0;
  for (const token of queryTokens) {
    if (targetTokens.has(token)) hits += 1;
  }
  return hits / Math.max(queryTokens.length, targetTokens.size);
}

function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || !a.length || a.length !== b.length) return 0;
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = Number(a[i]) || 0;
    const y = Number(b[i]) || 0;
    dot += x * y;
    magA += x * x;
    magB += y * y;
  }
  if (!magA || !magB) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
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
  if (start !== -1 && end !== -1 && end > start) {
    return tryParseJson(value.slice(start, end + 1));
  }
  return null;
}

function tryParseJson(text) {
  try {
    return JSON.parse(text);
  } catch (error) {
    console.error(`[localai-code] Failed to parse JSON snippet: ${error.message}`);
    return null;
  }
}

async function retryWithBackoff(fn, maxRetries = 3, baseDelayMs = 1000) {
  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt < maxRetries) {
        const delayMs = baseDelayMs * Math.pow(2, attempt);
        const jitterMs = Math.floor(Math.random() * 200);
        const totalDelayMs = delayMs + jitterMs;
        console.warn(`[localai-code] Embedding API attempt ${attempt + 1}/${maxRetries} failed, retrying in ${totalDelayMs}ms: ${error.message}`);
        await new Promise(resolve => setTimeout(resolve, totalDelayMs));
      }
    }
  }
  throw lastError;
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

function extractStreamDeltaText(payload) {
  const choice = payload?.choices?.[0];
  const deltaContent = choice?.delta?.content;
  if (typeof deltaContent === 'string') return deltaContent;
  if (Array.isArray(deltaContent)) {
    return deltaContent
      .map(part => typeof part === 'string' ? part : (part?.text || ''))
      .join('');
  }

  const messageContent = choice?.message?.content;
  if (typeof messageContent === 'string') return messageContent;
  if (Array.isArray(messageContent)) {
    return messageContent
      .map(part => typeof part === 'string' ? part : (part?.text || ''))
      .join('');
  }

  return '';
}

function detectLanguageFromPath(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return ext ? ext.slice(1) : 'text';
}

function isExcludedPath(relativePath) {
  const parts = String(relativePath || '').split(/[\\/]/).filter(Boolean);
  return parts.some(part => EXCLUDED_PATH_PARTS.has(part));
}

function isIndexablePath(relativePath) {
  if (!relativePath || isExcludedPath(relativePath)) return false;
  return INDEXABLE_EXTENSIONS.has(path.extname(relativePath).toLowerCase());
}

function isCloudSnapshotPath(relativePath) {
  if (!relativePath || isExcludedPath(relativePath)) return false;
  const normalized = String(relativePath || '').replace(/\\/g, '/');
  const baseName = path.basename(normalized);
  return CLOUD_SNAPSHOT_BASENAMES.has(baseName) || isIndexablePath(normalized);
}

function isLikelyBinary(buffer) {
  if (!buffer || !buffer.length) return false;
  const sample = buffer.slice(0, 512);
  let nullCount = 0;
  for (const byte of sample) {
    if (byte === 0) nullCount += 1;
  }
  return nullCount > 0;
}

function chunkText(text, chunkSize, overlap) {
  const chunks = [];
  const normalized = String(text || '').replace(/\r\n/g, '\n');
  if (!normalized.trim()) return chunks;

  const step = Math.max(1, chunkSize - overlap);
  for (let start = 0; start < normalized.length; start += step) {
    const end = Math.min(normalized.length, start + chunkSize);
    const slice = normalized.slice(start, end).trim();
    if (slice) chunks.push({ start, end, text: slice });
    if (end >= normalized.length) break;
  }
  return chunks;
}

function sortChats(chats) {
  return [...chats].sort((a, b) => {
    if (Boolean(a.pinned) !== Boolean(b.pinned)) return a.pinned ? -1 : 1;
    return (b.updatedAt || '').localeCompare(a.updatedAt || '');
  });
}

function buildChatTitleFromMessage(message) {
  return truncateText(normalizeWhitespace(message) || 'New Chat', 48);
}

function normalizeRelativeFilePath(value) {
  return String(value || '').replace(/\\/g, '/').replace(/^\/+/, '').trim();
}

function makeArtifactFileName(relativePath, suffix) {
  const normalized = normalizeRelativeFilePath(relativePath);
  const safeBase = normalized.replace(/[^a-zA-Z0-9._/-]/g, '_');
  const ext = path.extname(safeBase);
  const stem = ext ? safeBase.slice(0, -ext.length) : safeBase;
  const finalExt = ext || '.txt';
  return `${stem}${suffix}${finalExt}`.replace(/\//g, path.sep);
}

function summarizeMessagesLocally(messages) {
  const parts = messages.slice(-8).map(msg => `${msg.role}: ${truncateText(normalizeWhitespace(msg.content), 160)}`);
  return truncateText(parts.join('\n'), 1200);
}

function extractErrorMessage(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(extractErrorMessage).filter(Boolean).join('; ');
  if (typeof value === 'object') {
    return extractErrorMessage(value.message || value.error || value.detail) || JSON.stringify(value);
  }
  return String(value);
}

function parseModelList(responseData) {
  try {
    const parsed = JSON.parse(responseData);
    const entries = Array.isArray(parsed) ? parsed : Array.isArray(parsed.data) ? parsed.data : [];
    return entries
      .map(entry => {
        if (typeof entry === 'string') return entry;
        if (entry && typeof entry.id === 'string') return entry.id;
        return '';
      })
      .filter(Boolean);
  } catch (error) {
    console.error(`[localai-code] Failed to parse model list response: ${error.message}`);
    return [];
  }
}

function isLikelyEmbeddingModelId(modelId) {
  return EMBEDDING_MODEL_HINTS.test(String(modelId || ''));
}

function pickDefaultChatModelId(modelIds) {
  const ids = Array.isArray(modelIds) ? modelIds.filter(Boolean) : [];
  return ids.find(id => !isLikelyEmbeddingModelId(id)) || ids[0] || '';
}

function pickDefaultEmbeddingModelId(modelIds) {
  const ids = Array.isArray(modelIds) ? modelIds.filter(Boolean) : [];
  return ids.find(id => isLikelyEmbeddingModelId(id)) || '';
}

async function fetchAvailableModels() {
  const response = await httpJsonRequest(`${getBaseUrl()}/models`, {
    method: 'GET',
    timeoutMs: 10000
  });
  return parseModelList(response.raw || JSON.stringify(response.data || {}));
}

async function resolveChatModelId(preferredModelId) {
  const normalized = normalizeModelId(preferredModelId || getModelId());
  if (normalized && normalized !== 'auto') return normalized;
  const available = await fetchAvailableModels();
  const picked = pickDefaultChatModelId(available);
  if (!picked) {
    throw new Error('No loaded LM Studio chat model was found. Start the LM Studio server and load a model.');
  }
  return picked;
}

async function resolveEmbeddingModelId() {
  const configured = normalizeModelId(getEmbeddingModel());
  if (configured && configured !== 'auto') return configured;
  const available = await fetchAvailableModels();
  const picked = pickDefaultEmbeddingModelId(available);
  if (!picked) {
    throw new Error('No embedding-capable LM Studio model is loaded. Load one or set localai.rag.embeddingModel explicitly.');
  }
  return picked;
}

function getWorkspaceFolder() {
  return vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length
    ? vscode.workspace.workspaceFolders[0]
    : null;
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function wildcardToRegExp(pattern) {
  return new RegExp(`^${escapeRegExp(pattern).replace(/\\\*/g, '.*').replace(/\\\?/g, '.')}$`, 'i');
}

function resolveWorkspaceToolPath(relativePath, rootOverride) {
  const workspaceFolder = getWorkspaceFolder();
  const root = rootOverride || (workspaceFolder ? workspaceFolder.uri.fsPath : '');
  if (!root) return null;

  const input = String(relativePath || '.').trim() || '.';
  const targetPath = path.resolve(root, input);
  const relative = path.relative(root, targetPath);

  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return null;
  }

  return targetPath;
}

function getWorkspaceRelativeDisplayPath(fsPath, rootOverride) {
  const workspaceFolder = getWorkspaceFolder();
  const root = rootOverride || (workspaceFolder ? workspaceFolder.uri.fsPath : '');
  if (!root) return path.basename(fsPath);
  const relative = path.relative(root, fsPath).replace(/\\/g, '/');
  return relative || '.';
}

function formatTextWithLineNumbers(text, startLine = 1) {
  return String(text || '')
    .split(/\r?\n/)
    .map((line, index) => `${String(startLine + index).padStart(4, ' ')} | ${line}`)
    .join('\n');
}

function readWorkspaceAgentsInstructions() {
  const workspaceFolder = getWorkspaceFolder();
  if (!workspaceFolder) return '';

  const targetPath = path.join(workspaceFolder.uri.fsPath, 'AGENTS.md');
  if (!fileExists(targetPath)) return '';

  try {
    const content = fs.readFileSync(targetPath, 'utf8');
    return truncateText(content, 12000);
  } catch (error) {
    console.error(`[localai-code] Failed to read AGENTS.md from ${targetPath}: ${error.message}`);
    return '';
  }
}

function buildPersistentInstructionSections(options = {}) {
  const store = options.store || (appRuntime ? appRuntime.store : null);
  const chatId = options.chatId || '';
  const sections = [];
  const globalInstructions = getGlobalUserInstructions();
  const workspaceInstructions = getWorkspaceUserInstructions();
  const repoInstructions = readWorkspaceAgentsInstructions();
  const chatInstructions = store && chatId ? store.getChatInstructions(chatId) : '';

  if (globalInstructions) {
    sections.push(`[Global user instructions]\n${globalInstructions}`);
  }
  if (workspaceInstructions) {
    sections.push(`[Workspace instructions]\n${workspaceInstructions}`);
  }
  if (repoInstructions) {
    sections.push(`[Repository instructions: AGENTS.md]\n${repoInstructions}`);
  }
  if (chatInstructions) {
    sections.push(`[Chat instructions]\n${chatInstructions}`);
  }

  return sections;
}

function buildAgentToolInstructions(toolSpecs = LOCAL_AGENT_TOOL_SPECS, runtimeKind = 'local', agentType = 'general-purpose') {
  const toolLines = toolSpecs
    .map(tool => `- ${tool.name}: ${tool.description}\n  Example: ${tool.example}`)
    .join('\n');

  const runtimeLead = runtimeKind === 'cloud'
    ? 'You can work in multiple isolated remote rounds inside the uploaded task workspace snapshot.'
    : 'You can work in multiple local rounds: inspect files, search the codebase, modify files, run shell commands, run tests, then continue until the task is complete.';

  const webGuidance = agentPreferWebForFreshInfo()
    ? [
        'Use web_search or web_fetch by default when the request depends on current or time-sensitive information.',
        'This includes security updates, CVEs, package or dependency versions, release notes, breaking changes, documentation updates, API changes, and anything described as latest, recent, new, current, or updated.',
        'Do not browse for stable local codebase questions that can be answered from the workspace alone.'
      ].join('\n')
    : 'Use web_search or web_fetch only when the user clearly asks for web research or when workspace context is insufficient.';

  return [
    'Agent mode is enabled.',
    runtimeLead,
    AGENT_EXECUTION_PLAYBOOK,
    webGuidance,
    'Before write_file or delete_path, inspect the target area first unless the task is trivial.',
    'After code edits, prefer diagnostics, tests, lint, or build validation before you finalize.',
    'If a patch is ready, summarize what changed and what was validated.',
    'When you need tools, emit one or more exact tool tags and wait for tool results before answering.',
    'Tool format:',
    '<localai-tool name="read_file">{"path":"src/index.js"}</localai-tool>',
    'Do not wrap tool tags in markdown fences.',
    'When the task is complete, reply normally without any tool tags.',
    'Prefer tool use over guessing.',
    'Available tools:',
    toolLines
  ].join('\n');
}

function getAgentSystemPrompt(options = {}) {
  const runtimeKind = options.runtimeKind === 'cloud' ? 'cloud' : 'local';
  const agentType = normalizeAgentType(options.agentType || 'general-purpose');
  const toolSpecs = runtimeKind === 'cloud' ? CLOUD_AGENT_TOOL_SPECS : LOCAL_AGENT_TOOL_SPECS;
  const enableTools = options.enableTools !== false;
  const instructionSections = buildPersistentInstructionSections(options);
  const sections = [
    cfg('systemPrompt')
  ];

  if (!appRuntime || !appRuntime.features) {
    sections.push(buildAgentRolePromptSection(agentType));
  }

  if (instructionSections.length) {
    sections.push(instructionSections.join('\n\n'));
  }
  if (appRuntime && appRuntime.features) {
    const featureSections = appRuntime.features.buildPrePromptSections({ agentType });
    if (featureSections.length) sections.push(featureSections.join('\n\n'));
  }
  if (runtimeKind === 'cloud') {
    sections.push(CLOUD_RUNTIME_SYSTEM_INSTRUCTIONS);
  }
  sections.push(ANTI_HALLUCINATION_SYSTEM_INSTRUCTIONS);
  sections.push(WORKSPACE_ACTION_INSTRUCTIONS);

  if (agentEnabled() && enableTools) {
    sections.push(buildAgentToolInstructions(toolSpecs, runtimeKind, agentType));
  } else {
    sections.push([
      'Tool execution is unavailable for this response.',
      'Do not emit tool tags, JSON tool payloads, XML tool calls, or pretend to browse, read files, edit files, or run commands.',
      'Answer directly using the provided conversation context and clearly state any limitation only when it materially affects the answer.'
    ].join('\n'));
  }

  return sections.filter(Boolean).join('\n\n');
}

function rewriteMessagesForRuntime(messages, runtimeKind, options = {}) {
  const nextMessages = cloneMessages(messages);
  const systemPrompt = getAgentSystemPrompt({
    runtimeKind,
    chatId: options.chatId,
    store: options.store,
    enableTools: options.enableTools
  });
  const existingIndex = nextMessages.findIndex(message => message.role === 'system');
  if (existingIndex === -1) {
    nextMessages.unshift({ role: 'system', content: systemPrompt });
  } else {
    nextMessages[existingIndex] = {
      ...nextMessages[existingIndex],
      content: systemPrompt
    };
  }
  return nextMessages;
}

function classifyRequestIntent(text) {
  return antiHallucination.classifyRequestIntent(text);
}

function buildIntentFormatInstructions(intent, options = {}) {
  return antiHallucination.buildIntentFormatInstructions(intent, options);
}

function injectIntentFormatInstructions(messages, userText, contextMeta = null) {
  return antiHallucination.injectIntentFormatInstructions(messages, userText, { contextMeta });
}

function postValidateAssistantResponse(text, options = {}) {
  return antiHallucination.postValidateAssistantResponse(text, options);
}

function buildResponseMeta(intentContext, validation, extras = {}) {
  return antiHallucination.buildResponseMeta(intentContext, validation, extras);
}

function parseAssistantActions(text) {
  const actions = [];
  let cleanedText = String(text || '');

  const actionRegex = /<localai-(write|delete|open)\s+path="([^"]+)"(?:\s*\/>|>([\s\S]*?)<\/localai-write>)/gi;
  cleanedText = cleanedText.replace(actionRegex, (_, type, filePath, content = '') => {
    if (type === 'write') {
      actions.push({ type, path: filePath.trim(), content: content.replace(/^\n/, '') });
    } else {
      actions.push({ type, path: filePath.trim() });
    }
    return '';
  });

  cleanedText = cleanedText.replace(/\n{3,}/g, '\n\n').trim();
  return { actions, cleanedText };
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
    if (name && input && typeof input === 'object') {
      toolCalls.push({ name: String(name).trim(), input });
    }
    return '';
  });

  cleanedText = cleanedText.replace(/\n{3,}/g, '\n\n').trim();
  return { toolCalls, cleanedText };
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
    case 'spawn_agent':
      return `${name} ${input.subagent_type || 'general-purpose'} ${truncateText(input.name || input.description || '', 40)}`.trim();
    case 'send_message':
      return `${name} ${truncateText(input.to || input.agentId || '', 32)}`.trim();
    case 'wait_agent':
      return `${name} ${truncateText(JSON.stringify(input.targets || input.agentId || ''), 40)}`.trim();
    case 'orchestrate_team':
      return `${name} ${truncateText(input.goal || '', 50)}`.trim();
    case 'ask_user_question':
      return `${name} ${truncateText(input.question || '', 50)}`.trim();
    case 'workflow_run':
      return `${name} ${truncateText(input.goal || input.kind || '', 50)}`.trim();
    default:
      return `${name} ${truncateText(JSON.stringify(input), 60)}`;
  }
}

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map(item => stableStringify(item)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function createToolCallSignature(toolCall) {
  return `${toolCall && toolCall.name ? toolCall.name : 'tool'}:${stableStringify(toolCall && toolCall.input ? toolCall.input : {})}`;
}

function isDedupeEligibleTool(name) {
  return new Set([
    'list_files',
    'read_file',
    'search_text',
    'git_status',
    'git_diff',
    'web_search',
    'web_fetch',
    'lsp_symbols',
    'lsp_definitions',
    'lsp_references',
    'lsp_diagnostics',
    'list_tasks',
    'get_task',
    'list_agents',
    'get_agent',
    'list_teams',
    'mcp_list_resources',
    'mcp_read_resource',
    'mcp_list_tools',
    'list_events',
    'get_onboarding'
  ]).has(String(name || ''));
}

function toolMayMutateWorkspace(name) {
  return new Set(['write_file', 'delete_path', 'run_shell']).has(String(name || ''));
}

function sanitizeAgentVisibleText(text) {
  let value = String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (!value.trim()) return '';
  value = value.replace(/\n?\[Tool results for round \d+\][\s\S]*?(?:Continue working\.[^\n]*|Use only the verified tool summaries below\.[^\n]*)/gi, '\n');
  value = value.replace(/^\s*Continue working\..*$/gim, '');
  value = value.replace(/^\s*If the task is complete, provide the final answer\..*$/gim, '');
  value = value.replace(/^\s*Otherwise request (?:only )?the next missing tool call.*$/gim, '');
  value = value.replace(/\n{3,}/g, '\n\n').trim();
  return value;
}

function summarizeAssistantNoteForUi(note) {
  const sanitized = sanitizeAgentVisibleText(note);
  if (!sanitized) return '';
  const flat = normalizeWhitespace(sanitized);
  if (/^(?:i(?:'m| am)? going to|i will|let me|je vais(?: maintenant)?|maintenant je vais|je vais continuer|commençons par|on va commencer par)\b/i.test(flat)) {
    return '';
  }
  return truncateText(sanitized, 220);
}

function formatJsonForModel(value, maxChars = MAX_AGENT_TOOL_MODEL_RESULT_CHARS) {
  return truncateText(JSON.stringify(value, null, 2), maxChars);
}

function buildToolResultBlockForModel(toolCall, resultValue, ok) {
  const name = toolCall && toolCall.name ? String(toolCall.name) : 'tool';
  const input = toolCall && toolCall.input && typeof toolCall.input === 'object' ? toolCall.input : {};
  if (!ok) {
    return [
      `Tool: ${name}`,
      'Status: error',
      `Error: ${truncateText(String(resultValue || 'unknown error'), 1600)}`
    ].join('\n');
  }

  if (resultValue && resultValue.skipped && resultValue.duplicate) {
    return [
      `Tool: ${name}`,
      'Status: duplicate skipped',
      truncateText(String(resultValue.message || 'This exact read-only tool call was already executed earlier in the same task.'), 600)
    ].join('\n');
  }

  switch (name) {
    case 'read_file': {
      const pathValue = resultValue && resultValue.path ? resultValue.path : (input.path || '');
      const startLine = Number(resultValue && resultValue.startLine ? resultValue.startLine : (input.startLine || 1));
      const endLine = Number(resultValue && resultValue.endLine ? resultValue.endLine : (input.endLine || startLine));
      const totalLines = Number(resultValue && resultValue.totalLines ? resultValue.totalLines : endLine);
      const content = truncateText(String((resultValue && resultValue.content) || ''), MAX_AGENT_TOOL_MODEL_RESULT_CHARS);
      const note = content.length >= MAX_AGENT_TOOL_MODEL_RESULT_CHARS || endLine < totalLines
        ? 'Note: this is a truncated excerpt. Request a narrower line range if more detail is needed.'
        : '';
      return [
        'Tool: read_file',
        `Path: ${pathValue}`,
        `Lines: ${startLine}-${endLine} of ${totalLines}`,
        note,
        'Content excerpt:',
        content
      ].filter(Boolean).join('\n');
    }

    case 'list_files': {
      const entries = Array.isArray(resultValue && resultValue.entries) ? resultValue.entries : [];
      const sample = entries.slice(0, MAX_AGENT_TOOL_MODEL_LIST_ITEMS).map(entry => `- ${entry.type === 'directory' ? 'dir' : 'file'} ${entry.path}`);
      const omitted = entries.length - sample.length;
      return [
        'Tool: list_files',
        `Path: ${(resultValue && resultValue.path) || input.path || '.'}`,
        `Count: ${entries.length}`,
        sample.length ? `Entries:\n${sample.join('\n')}` : 'Entries: none',
        omitted > 0 ? `Note: ${omitted} additional entries omitted.` : ''
      ].filter(Boolean).join('\n');
    }

    case 'search_text': {
      const matches = Array.isArray(resultValue && resultValue.matches) ? resultValue.matches : [];
      const sample = matches.slice(0, MAX_AGENT_TOOL_MODEL_MATCHES).map(match => `- ${match.path}:${match.line} ${truncateText(match.preview || '', 180)}`);
      const omitted = matches.length - sample.length;
      return [
        'Tool: search_text',
        `Pattern: ${input.pattern || (resultValue && resultValue.pattern) || ''}`,
        `Matches: ${matches.length}`,
        sample.length ? `Top matches:\n${sample.join('\n')}` : 'Top matches: none',
        omitted > 0 ? `Note: ${omitted} additional matches omitted.` : ''
      ].filter(Boolean).join('\n');
    }

    case 'run_shell': {
      const exitCode = resultValue && resultValue.exitCode != null ? resultValue.exitCode : 0;
      const stdout = truncateText(String((resultValue && resultValue.stdout) || ''), MAX_AGENT_TOOL_MODEL_STDIO_CHARS);
      const stderr = truncateText(String((resultValue && resultValue.stderr) || ''), MAX_AGENT_TOOL_MODEL_STDIO_CHARS);
      return [
        'Tool: run_shell',
        `Command: ${truncateText(input.command || '', 160)}`,
        `Exit code: ${exitCode}`,
        stdout ? `Stdout:\n${stdout}` : '',
        stderr ? `Stderr:\n${stderr}` : ''
      ].filter(Boolean).join('\n');
    }

    case 'git_status':
    case 'git_diff':
      return [
        `Tool: ${name}`,
        formatJsonForModel(resultValue, MAX_AGENT_TOOL_MODEL_RESULT_CHARS)
      ].join('\n');

    case 'web_search': {
      const results = Array.isArray(resultValue && resultValue.results) ? resultValue.results : [];
      const sample = results.slice(0, 5).map(entry => `- ${truncateText(entry.title || entry.url || '', 120)}${entry.url ? ` (${entry.url})` : ''}`);
      return [
        'Tool: web_search',
        `Query: ${input.query || ''}`,
        `Results: ${results.length}`,
        sample.length ? sample.join('\n') : 'No results'
      ].join('\n');
    }

    case 'web_fetch':
      return [
        'Tool: web_fetch',
        `Source: ${(resultValue && (resultValue.title || resultValue.url)) || input.url || ''}`,
        truncateText(String((resultValue && (resultValue.content || resultValue.text || resultValue.excerpt)) || ''), MAX_AGENT_TOOL_MODEL_RESULT_CHARS)
      ].filter(Boolean).join('\n');

    case 'spawn_agent': {
      const lines = buildAgentToolStatusLines(resultValue);
      return [
        'Tool: spawn_agent',
        ...lines,
        'Note: this agent runs asynchronously. Use wait_agent or task_output to inspect progress or output.'
      ].filter(Boolean).join('\n');
    }

    case 'wait_agent': {
      const agents = Array.isArray(resultValue && resultValue.agents) ? resultValue.agents : [];
      const sample = agents.slice(0, 8).map(agent => `- ${agent.name || agent.id || 'agent'}: ${agent.status || 'unknown'}${agent.taskId ? ` (task ${agent.taskId})` : ''}`);
      return [
        'Tool: wait_agent',
        `Waited: ${Number(resultValue && resultValue.waitedMs || 0)}ms`,
        `Completed: ${Number(resultValue && resultValue.completed || 0)}/${agents.length}`,
        sample.length ? `Agents:\n${sample.join('\n')}` : 'Agents: none'
      ].filter(Boolean).join('\n');
    }

    case 'orchestrate_team':
    case 'workflow_run': {
      const team = resultValue && resultValue.team ? resultValue.team : {};
      const workers = Array.isArray(resultValue && resultValue.workers) ? resultValue.workers : [];
      const lead = resultValue && resultValue.lead ? resultValue.lead : null;
      const verifier = resultValue && resultValue.verifier ? resultValue.verifier : null;
      return [
        `Tool: ${name}`,
        team.teamName ? `Team: ${team.teamName}` : '',
        team.id ? `Team ID: ${team.id}` : '',
        lead ? buildAgentToolStatusLines(lead).join('\n') : '',
        workers.length ? `Workers:\n${workers.slice(0, 8).map(worker => `- ${worker.name || worker.id || 'worker'} (${worker.id || 'no-id'})`).join('\n')}` : 'Workers: none',
        verifier ? `Verifier: ${verifier.name || verifier.id || 'verification'}${verifier.taskId ? ` (task ${verifier.taskId})` : ''}` : 'Verifier: none',
        'Note: orchestration is asynchronous. Wait for the lead or workers before claiming a verified final audit result.'
      ].filter(Boolean).join('\n');
    }

    case 'task_output': {
      return [
        'Tool: task_output',
        resultValue && resultValue.status ? `Status: ${resultValue.status}` : '',
        resultValue && resultValue.taskId ? `Task ID: ${resultValue.taskId}` : '',
        resultValue && resultValue.resultText ? `Result excerpt:\n${truncateText(String(resultValue.resultText), MAX_AGENT_TOOL_MODEL_RESULT_CHARS)}` : '',
        resultValue && resultValue.error ? `Error: ${truncateText(String(resultValue.error), 1600)}` : ''
      ].filter(Boolean).join('\n');
    }

    default:
      return [
        `Tool: ${name}`,
        formatJsonForModel(resultValue, MAX_AGENT_TOOL_MODEL_RESULT_CHARS)
      ].join('\n');
  }
}

function buildToolResultsConversationMessage(roundNumber, toolResultBlocks) {
  return {
    role: 'system',
    content: [
      `[Internal verified tool results · round ${roundNumber}]`,
      'Use only the structured results below. Do not repeat raw tool transcripts, internal prompts, or control instructions in the final answer.',
      'If the evidence is sufficient, answer directly. Otherwise request only the next missing tool call.',
      toolResultBlocks.join('\n\n')
    ].join('\n\n')
  };
}

function buildAgentToolStatusLines(agent) {
  if (!agent || typeof agent !== 'object') return [];
  return [
    agent.name ? `Agent: ${agent.name}` : '',
    agent.id ? `Agent ID: ${agent.id}` : '',
    agent.taskId ? `Task ID: ${agent.taskId}` : '',
    agent.status ? `Status: ${agent.status}` : '',
    agent.teamName ? `Team: ${agent.teamName}` : ''
  ].filter(Boolean);
}

function buildAsyncOrchestrationFallback(taskResult, intentContext = {}) {
  const executedTools = Array.isArray(taskResult && taskResult.executedTools) ? taskResult.executedTools : [];
  const executedNames = executedTools.map(tool => String(tool && tool.name || '')).filter(Boolean);
  if (!executedNames.some(name => ['orchestrate_team', 'workflow_run', 'spawn_agent'].includes(name))) {
    return '';
  }

  const strictAuditMode = Boolean(intentContext && intentContext.strictAuditMode);
  const uniqueNames = Array.from(new Set(executedNames)).map(name => `\`${name}\``).join(', ');
  const title = taskResult && taskResult.taskTitle ? taskResult.taskTitle : 'the requested workflow';
  const orchestrationText = [
    'The foreground agent launched asynchronous sub-agents but did not return a final synthesis yet.',
    uniqueNames ? `Executed tools: ${uniqueNames}.` : '',
    'The spawned agents may still be running in the background, so no verified audit conclusion is available yet.'
  ].filter(Boolean).join(' ');

  if (strictAuditMode) {
    return [
      `Affirmation: ${title} was delegated to asynchronous sub-agents, but no verified audit synthesis is available yet.`,
      'Verdict: NON-VERIFIED',
      `Evidence: ${orchestrationText}`,
      'Commentaire critique: Wait for the spawned agents with `wait_agent`, inspect their outputs with `task_output`, or rerun this request in background mode if you want asynchronous orchestration without blocking the foreground chat.'
    ].join('\n');
  }

  return [
    'Multi-agent orchestration started, but no final synthesized answer is available yet.',
    orchestrationText,
    'Wait for the spawned agents with `wait_agent`, inspect outputs with `task_output`, or rerun the request in background mode if you want the orchestration to continue asynchronously.'
  ].join('\n\n');
}

function inferTaskWorkflowHints(userText) {
  const text = normalizeWhitespace(userText).toLowerCase();
  const hints = [];
  if (!text) return hints;
  if (/(fix|bug|error|broken|failing|failure|issue|regression|debug)/.test(text)) {
    hints.push('Reproduce or inspect the failure first, then make the smallest fix and rerun targeted validation.');
  }
  if (/(test|tests|coverage|spec|unit test|integration test)/.test(text)) {
    hints.push('Inspect existing test patterns first, then add or update the smallest focused tests that prove the behavior.');
  }
  if (/(refactor|cleanup|rename|migrate|restructure)/.test(text)) {
    hints.push('Map references and nearby call sites before editing, then run regression checks on the affected surface.');
  }
  if (/(security|cve|vulnerability|advisory|dependency|dependencies|upgrade|version|release notes?|breaking changes?|latest|recent|current|update)/.test(text)) {
    hints.push('Use web_search or web_fetch early to verify fresh security, version, or release information before changing code.');
  }
  if (/(build|lint|compile|typecheck|ci|pipeline)/.test(text)) {
    hints.push('Start with the narrowest failing command or diagnostic output, then broaden validation only if needed.');
  }
  if (/(performance|optimiz|slow|latency)/.test(text)) {
    hints.push('Inspect evidence or hotspots before editing; avoid speculative rewrites without a concrete signal.');
  }
  return hints.slice(0, 4);
}

function formatPatchSummary(files = [], fallback = '') {
  const normalized = Array.isArray(files) ? files.filter(file => file && file.path) : [];
  if (!normalized.length) return fallback || 'Patch ready for review';
  const sample = normalized.slice(0, 3).map(file => file.path);
  const suffix = normalized.length > sample.length ? ` +${normalized.length - sample.length} more` : '';
  return `${normalized.length} file change(s): ${sample.join(', ')}${suffix}`;
}

function summarizeToolResultForUi(toolCall, resultValue, ok) {
  const name = toolCall && toolCall.name ? String(toolCall.name) : '';
  if (!ok) {
    return `failed: ${truncateText(String(resultValue || 'unknown error'), 120)}`;
  }
  if (resultValue && resultValue.skipped && resultValue.duplicate) {
    return 'duplicate skipped';
  }
  switch (name) {
    case 'search_text':
      return `${Array.isArray(resultValue && resultValue.matches) ? resultValue.matches.length : 0} match(es)`;
    case 'list_files':
      return `${Array.isArray(resultValue && resultValue.entries) ? resultValue.entries.length : Array.isArray(resultValue) ? resultValue.length : 0} item(s)`;
    case 'read_file':
      return `${toolCall.input && toolCall.input.path ? toolCall.input.path : 'file'} loaded`;
    case 'run_shell': {
      const code = resultValue && resultValue.exitCode != null ? resultValue.exitCode : 0;
      const stderr = normalizeWhitespace(resultValue && resultValue.stderr ? resultValue.stderr : '');
      return stderr ? `exit ${code} · ${truncateText(stderr, 80)}` : `exit ${code}`;
    }
    case 'lsp_diagnostics':
      return `${Array.isArray(resultValue) ? resultValue.length : 0} diagnostic(s)`;
    case 'web_search':
      return `${Array.isArray(resultValue && resultValue.results) ? resultValue.results.length : 0} web result(s)`;
    case 'web_fetch':
      return truncateText((resultValue && (resultValue.title || resultValue.url)) || 'page fetched', 100);
    case 'git_diff':
    case 'git_status':
      return 'git state captured';
    case 'workflow_run':
    case 'orchestrate_team':
      return 'workflow launched';
    default:
      return 'ok';
  }
}

function formatSandboxFallbackMessage(error) {
  const detail = error instanceof Error ? error.message : String(error || '');
  return {
    userMessage: 'Tools mode unavailable right now. Direct chat is active.',
    detail: truncateText(detail, 240)
  };
}

function shouldBypassToolsForSandboxStatus(status) {
  if (!status) return true;
  if (status.enabled === false) return true;
  if (!status.dockerReady) return true;
  if (status.ok === false) return true;
  return false;
}

function describeSandboxBypass(status, fallback) {
  if (status && status.enabled === false) {
    return 'Tools are disabled in settings. Direct chat is active.';
  }
  return fallback && fallback.userMessage
    ? fallback.userMessage
    : 'Tools mode unavailable right now. Direct chat is active.';
}

function collectWorkspaceEntries(basePath, options = {}) {
  const depth = Math.max(0, Number(options.depth || 0));
  const pattern = options.pattern ? wildcardToRegExp(options.pattern) : null;
  const rootPath = options.rootPath || basePath;
  const entries = [];

  const visit = (currentPath, currentDepth) => {
    if (entries.length >= MAX_AGENT_LIST_RESULTS) return;

    let dirEntries = [];
    try {
      dirEntries = fs.readdirSync(currentPath, { withFileTypes: true });
    } catch (_) {
      return;
    }

    dirEntries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of dirEntries) {
      if (entries.length >= MAX_AGENT_LIST_RESULTS) break;
      const fullPath = path.join(currentPath, entry.name);
      const relativePath = getWorkspaceRelativeDisplayPath(fullPath, rootPath);
      if (isExcludedPath(relativePath)) continue;

      if (!pattern || pattern.test(entry.name) || pattern.test(relativePath)) {
        entries.push({
          path: relativePath,
          type: entry.isDirectory() ? 'directory' : 'file'
        });
      }

      if (entry.isDirectory() && currentDepth < depth) {
        visit(fullPath, currentDepth + 1);
      }
    }
  };

  visit(basePath, 0);
  return entries;
}

function buildSearchRegex(pattern, isRegex, caseSensitive) {
  const source = isRegex ? pattern : escapeRegExp(pattern);
  const flags = `g${caseSensitive ? '' : 'i'}`;
  return new RegExp(source, flags);
}

function searchWorkspaceText(pattern, options = {}) {
  const basePath = resolveWorkspaceToolPath(options.path || '.', options.rootPath);
  if (!basePath) {
    throw new Error(`Invalid workspace path: ${options.path || '.'}`);
  }

  const regex = buildSearchRegex(pattern, Boolean(options.isRegex), Boolean(options.caseSensitive));
  const rootPath = options.rootPath || basePath;
  const files = collectWorkspaceEntries(basePath, { depth: options.depth || 8, rootPath });
  const matches = [];

  for (const entry of files) {
    if (matches.length >= (options.maxResults || MAX_AGENT_SEARCH_RESULTS)) break;
    if (entry.type !== 'file') continue;

    const fullPath = resolveWorkspaceToolPath(entry.path, rootPath);
    if (!fullPath || !fileExists(fullPath)) continue;

    try {
      const buffer = fs.readFileSync(fullPath);
      if (isLikelyBinary(buffer)) continue;
      const content = buffer.toString('utf8');
      const lines = content.split(/\r?\n/);

      for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
        const line = lines[lineIndex];
        regex.lastIndex = 0;
        let match;
        while ((match = regex.exec(line)) && matches.length < (options.maxResults || MAX_AGENT_SEARCH_RESULTS)) {
          matches.push({
            path: entry.path,
            line: lineIndex + 1,
            column: (match.index || 0) + 1,
            preview: truncateText(line.trim(), 220)
          });
          if (!match[0]) regex.lastIndex += 1;
        }
        if (matches.length >= (options.maxResults || MAX_AGENT_SEARCH_RESULTS)) break;
      }
    } catch (error) {
      console.error(`[localai-code] Failed to search workspace text in ${entry.path}: ${error.message}`);
    }
  }

  return matches;
}

function enforceAgentShellPolicy(command) {
  if (!agentAllowShell()) {
    throw new Error('Shell access is disabled by settings.');
  }

  const blockedPatterns = [
    '\\brm\\s+-rf\\b',
    '\\bdel\\s+/s\\b',
    '\\bformat\\b',
    '\\bshutdown\\b',
    '\\bschtasks\\b.*\\/(create|change)\\b',
    '\\breg\\s+add\\b',
    '\\bcurl\\b.*\\|',
    '\\bwget\\b.*\\|',
    'Invoke-WebRequest.*iex',
    'powershell(?:\\.exe)?\\b.*-enc(?:odedcommand)?\\b',
    '\\bcertutil\\b.*-urlcache\\b'
  ];

  for (const pattern of blockedPatterns) {
    if (new RegExp(pattern, 'i').test(command)) {
      throw new Error(`Shell command blocked by policy: ${pattern}`);
    }
  }
}

async function runLocalShellCommand(command, cwd, timeoutMs, options = {}) {
  enforceAgentShellPolicy(command);
  const runtimeState = options.runtimeState || null;
  const rootPath = options.rootPath || undefined;

  return new Promise((resolve, reject) => {
    const shellCommand = process.platform === 'win32'
      ? { command: 'powershell.exe', args: ['-NoProfile', '-Command', command] }
      : { command: '/bin/sh', args: ['-lc', command] };

    const child = spawn(shellCommand.command, shellCommand.args, {
      cwd,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env
    });

    if (runtimeState) runtimeState.activeChild = child;

    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };

    const timer = setTimeout(() => {
      child.kill();
      finish(() => reject(new Error(`Shell command timed out after ${timeoutMs}ms`)));
    }, timeoutMs);

    child.stdout.on('data', chunk => {
      stdout += chunk.toString('utf8');
      if (Buffer.byteLength(stdout, 'utf8') > MAX_AGENT_TOOL_OUTPUT_CHARS) {
        stdout = truncateText(stdout, MAX_AGENT_TOOL_OUTPUT_CHARS);
      }
    });

    child.stderr.on('data', chunk => {
      stderr += chunk.toString('utf8');
      if (Buffer.byteLength(stderr, 'utf8') > MAX_AGENT_TOOL_OUTPUT_CHARS) {
        stderr = truncateText(stderr, MAX_AGENT_TOOL_OUTPUT_CHARS);
      }
    });

    child.on('error', error => finish(() => reject(error)));
    child.on('close', code => finish(() => resolve({
      command,
      cwd: getWorkspaceRelativeDisplayPath(cwd, rootPath),
      exitCode: code ?? 0,
      stdout: truncateText(stdout, MAX_AGENT_TOOL_OUTPUT_CHARS),
      stderr: truncateText(stderr, MAX_AGENT_TOOL_OUTPUT_CHARS)
    })));
  });
}

function sanitizeBranchFragment(value) {
  return String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9._/-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/\/+/g, '/')
    .slice(0, 80) || 'task';
}

async function runGitProcess(args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => stdout += chunk.toString('utf8'));
    child.stderr.on('data', chunk => stderr += chunk.toString('utf8'));
    child.on('error', reject);
    child.on('close', code => {
      if (code && code !== 0) {
        reject(new Error(truncateText(stderr || stdout || `git exited with code ${code}`, 4000)));
        return;
      }
      resolve({ stdout, stderr, exitCode: code ?? 0 });
    });
  });
}

async function findGitRoot(cwd) {
  const result = await runGitProcess(['rev-parse', '--show-toplevel'], cwd);
  return String(result.stdout || '').trim();
}

function parseGitWorktrees(output) {
  const blocks = String(output || '').split(/\r?\n\r?\n/).filter(Boolean);
  return blocks.map(block => {
    const data = {};
    for (const line of block.split(/\r?\n/)) {
      const spaceIndex = line.indexOf(' ');
      if (spaceIndex === -1) continue;
      const key = line.slice(0, spaceIndex).trim();
      const value = line.slice(spaceIndex + 1).trim();
      data[key] = value;
    }
    return {
      path: data.worktree || '',
      head: data.HEAD || '',
      branch: data.branch ? data.branch.replace(/^refs\/heads\//, '') : '',
      bare: Boolean(data.bare),
      detached: Boolean(data.detached)
    };
  }).filter(entry => entry.path);
}

async function ensureSandboxExecutionContext(execContext = {}) {
  if (execContext.sandboxMeta) return execContext.sandboxMeta;
  if (!execContext.runtime) {
    throw new Error('Sandbox runtime is unavailable for this task.');
  }
  await execContext.runtime.ensureSandboxReady();

  let task = execContext.taskId ? execContext.runtime.store.loadTask(execContext.taskId) : null;
  let sandboxMeta = task && task.sandboxId
    ? execContext.runtime.sandbox.loadSandbox(task.sandboxId)
    : null;

  if (!sandboxMeta) {
    const sourceRoot = execContext.rootPath || (getWorkspaceFolder() ? getWorkspaceFolder().uri.fsPath : '');
    if (!sourceRoot) throw new Error('No workspace root is available for sandbox creation.');
    sandboxMeta = await execContext.runtime.sandbox.createFromWorkspace({
      sandboxId: createId('sandbox'),
      sourceRoot
    });
    if (task) {
      execContext.runtime.store.updateTask(task.id, currentTask => {
        currentTask.sandboxId = sandboxMeta.id;
        currentTask.sandboxState = sandboxMeta.state || 'ready';
        currentTask.sandboxRootDir = sandboxMeta.rootDir;
        currentTask.sandboxWorkspaceDir = sandboxMeta.workspaceDir;
        currentTask.sandboxContainerName = sandboxMeta.containerName;
        currentTask.containerImage = sandboxMeta.image || getSandboxImage();
        return currentTask;
      });
      execContext.runtime.store.appendTaskLog(task.id, `Sandbox ready: ${sandboxMeta.id}`);
      task = execContext.runtime.store.loadTask(task.id);
    }
  } else {
    sandboxMeta = await execContext.runtime.sandbox.attach(sandboxMeta);
    if (task) {
      execContext.runtime.store.updateTask(task.id, currentTask => {
        currentTask.sandboxState = sandboxMeta.state || 'ready';
        currentTask.sandboxContainerName = sandboxMeta.containerName || currentTask.sandboxContainerName;
        currentTask.containerImage = sandboxMeta.image || currentTask.containerImage;
        return currentTask;
      });
    }
  }

  execContext.sandboxMeta = sandboxMeta;
  return sandboxMeta;
}

async function openWorkspaceDocumentForTool(relativePath, rootPath) {
  const targetPath = resolveWorkspaceToolPath(relativePath, rootPath);
  if (!targetPath) throw new Error(`Invalid workspace path: ${relativePath}`);
  return vscode.workspace.openTextDocument(vscode.Uri.file(targetPath));
}

function normalizeLspLocation(location, rootPath) {
  const uri = location && location.uri ? location.uri : location && location.targetUri ? location.targetUri : null;
  const range = location && location.range ? location.range : location && location.targetSelectionRange ? location.targetSelectionRange : null;
  if (!uri || !range) return null;
  return {
    path: safeRelativeToWorkspace(uri.fsPath || uri.path || ''),
    line: Number(range.start.line || 0) + 1,
    character: Number(range.start.character || 0) + 1
  };
}

async function executeAgentToolCall(toolCall, execContext = {}) {
  const workspaceFolder = getWorkspaceFolder();
  if (!workspaceFolder && !execContext.rootPath) {
    throw new Error('No workspace folder is open.');
  }

  if (execContext.runtimeState && execContext.runtimeState.stopRequested) {
    throw new Error('Task stopped by user.');
  }

  const rootPath = execContext.rootPath || workspaceFolder.uri.fsPath;
  const name = String(toolCall.name || '').trim();
  const input = toolCall.input && typeof toolCall.input === 'object' ? toolCall.input : {};
  const currentTask = execContext.taskId ? execContext.runtime.store.loadTask(execContext.taskId) : null;
  const agentType = currentTask && currentTask.agentType ? currentTask.agentType : 'general-purpose';

  const TOOL_INPUT_SCHEMAS = {
    list_files: {
      fields: {
        path: { type: 'string' },
        depth: { type: 'number', min: 0, max: 8 },
        pattern: { type: 'string' }
      }
    },
    read_file: {
      required: ['path'],
      fields: {
        path: { type: 'string' },
        startLine: { type: 'number', min: 1 },
        endLine: { type: 'number', min: 1 }
      }
    },
    search_text: {
      required: ['pattern'],
      fields: {
        pattern: { type: 'string' },
        path: { type: 'string' },
        isRegex: { type: 'boolean' },
        caseSensitive: { type: 'boolean' },
        maxResults: { type: 'number', min: 1, max: MAX_AGENT_SEARCH_RESULTS }
      }
    },
    write_file: {
      required: ['path', 'content'],
      fields: {
        path: { type: 'string' },
        content: { type: 'string' }
      }
    },
    delete_path: {
      required: ['path'],
      fields: {
        path: { type: 'string' }
      }
    },
    run_shell: {
      required: ['command'],
      fields: {
        command: { type: 'string' },
        cwd: { type: 'string' },
        timeoutMs: { type: 'number', min: 1000, max: 600000 }
      }
    },
    git_status: {
      fields: {
        cwd: { type: 'string' }
      }
    },
    git_diff: {
      fields: {
        cwd: { type: 'string' },
        staged: { type: 'boolean' }
      }
    },
    list_tasks: {},
    get_task: {
      required: ['taskId'],
      fields: {
        taskId: { type: 'string' }
      }
    },
    stop_task: {
      required: ['taskId'],
      fields: {
        taskId: { type: 'string' }
      }
    },
    spawn_task: {
      required: ['prompt'],
      fields: {
        prompt: { type: 'string' },
        title: { type: 'string' },
        cwd: { type: 'string' }
      }
    },
    ask_user_question: {
      required: ['question'],
      fields: {
        question: { type: 'string' },
        choices: { type: 'object' },
        context: { type: 'string' }
      }
    },
    lsp_symbols: {
      required: ['path'],
      fields: {
        path: { type: 'string' }
      }
    },
    lsp_definitions: {
      required: ['path'],
      fields: {
        path: { type: 'string' },
        line: { type: 'number', min: 1 },
        character: { type: 'number', min: 1 }
      }
    },
    lsp_references: {
      required: ['path'],
      fields: {
        path: { type: 'string' },
        line: { type: 'number', min: 1 },
        character: { type: 'number', min: 1 }
      }
    },
    lsp_diagnostics: {
      required: ['path'],
      fields: {
        path: { type: 'string' }
      }
    },
    workflow_run: {
      fields: {
        kind: { type: 'string' },
        goal: { type: 'string' },
        aspects: { type: 'object' },
        verify: { type: 'boolean' },
        teamName: { type: 'string' },
        prompt: { type: 'string' }
      }
    },
    fork_chat: {
      fields: {
        title: { type: 'string' }
      }
    }
  };

  const toolSchema = TOOL_INPUT_SCHEMAS[name];
  if (toolSchema) {
    validateInput(toolSchema, input);
  }

  if (execContext.runtime && execContext.runtime.features) {
    const policy = execContext.runtime.features.evaluatePreToolPolicies(toolCall, { agentType });
    if (policy.blocked) throw new Error(policy.reason || 'Tool blocked by policy.');
    if (Array.isArray(policy.notes) && policy.notes.length && execContext.taskId) {
      execContext.runtime.store.appendTaskLog(execContext.taskId, `Policy note: ${policy.notes.join(' | ')}`, 'warn');
    }
    const advancedResult = await execContext.runtime.features.executeTool(name, input, {
      agentId: currentTask ? currentTask.agentId : '',
      agentType,
      taskId: execContext.taskId || '',
      chatId: execContext.chatId || '',
      rootPath
    });
    if (advancedResult !== null && advancedResult !== undefined) {
      execContext.runtime.features.appendEvent('tool.completed', {
        tool: name,
        agentId: currentTask ? currentTask.agentId : '',
        taskId: execContext.taskId || ''
      });
      return advancedResult;
    }
  }
  const sandboxedTools = new Set(['list_files', 'read_file', 'search_text', 'write_file', 'delete_path', 'run_shell', 'git_status', 'git_diff']);
  const sandboxMeta = sandboxedTools.has(name) ? await ensureSandboxExecutionContext(execContext) : null;

  switch (name) {
    case 'list_files': {
      return execContext.runtime.sandbox.execTool(sandboxMeta, {
        name,
        input: {
          path: input.path || '.',
          depth: Math.max(0, Math.min(8, Number(input.depth || 1))),
          pattern: input.pattern || ''
        }
      }, { runtimeState: execContext.runtimeState, timeoutMs: getSandboxToolTimeoutMs() });
    }

    case 'read_file': {
      return execContext.runtime.sandbox.execTool(sandboxMeta, {
        name,
        input: {
          path: input.path,
          startLine: Math.max(1, Number(input.startLine || 1)),
          endLine: input.endLine != null ? Math.max(1, Number(input.endLine)) : undefined
        }
      }, { runtimeState: execContext.runtimeState, timeoutMs: getSandboxToolTimeoutMs() });
    }

    case 'search_text': {
      if (!input.pattern) throw new Error('search_text requires a pattern.');
      return execContext.runtime.sandbox.execTool(sandboxMeta, {
        name,
        input: {
          pattern: String(input.pattern),
          path: input.path || '.',
          isRegex: Boolean(input.isRegex),
          caseSensitive: Boolean(input.caseSensitive),
          maxResults: Math.max(1, Math.min(MAX_AGENT_SEARCH_RESULTS, Number(input.maxResults || 20)))
        }
      }, { runtimeState: execContext.runtimeState, timeoutMs: getSandboxToolTimeoutMs() });
    }

    case 'write_file': {
      if (typeof input.path !== 'string' || typeof input.content !== 'string') {
        throw new Error('write_file requires path and content.');
      }
      return execContext.runtime.sandbox.execTool(sandboxMeta, {
        name,
        input: {
          path: input.path,
          content: input.content
        }
      }, { runtimeState: execContext.runtimeState, timeoutMs: getSandboxToolTimeoutMs() });
    }

    case 'delete_path': {
      if (typeof input.path !== 'string') throw new Error('delete_path requires a path.');
      return execContext.runtime.sandbox.execTool(sandboxMeta, {
        name,
        input: {
          path: input.path
        }
      }, { runtimeState: execContext.runtimeState, timeoutMs: getSandboxToolTimeoutMs() });
    }

    case 'run_shell': {
      if (typeof input.command !== 'string' || !input.command.trim()) {
        throw new Error('run_shell requires a command.');
      }
      return execContext.runtime.sandbox.execTool(sandboxMeta, {
        name,
        input: {
          command: input.command,
          cwd: input.cwd || '.'
        }
      }, {
        runtimeState: execContext.runtimeState,
        timeoutMs: Math.max(1000, Math.min(getSandboxToolTimeoutMs(), Number(input.timeoutMs || getSandboxToolTimeoutMs())))
      });
    }

    case 'git_status': {
      return execContext.runtime.sandbox.execTool(sandboxMeta, {
        name,
        input: {
          cwd: input.cwd || '.'
        }
      }, { runtimeState: execContext.runtimeState, timeoutMs: getSandboxToolTimeoutMs() });
    }

    case 'git_diff': {
      return execContext.runtime.sandbox.execTool(sandboxMeta, {
        name,
        input: {
          cwd: input.cwd || '.',
          staged: Boolean(input.staged)
        }
      }, { runtimeState: execContext.runtimeState, timeoutMs: getSandboxToolTimeoutMs() });
    }

    case 'list_tasks': {
      if (!execContext.taskManager) throw new Error('Task manager is unavailable.');
      return {
        count: execContext.taskManager.getTasks().length,
        tasks: execContext.taskManager.getTasks()
      };
    }

    case 'get_task': {
      if (!execContext.taskManager) throw new Error('Task manager is unavailable.');
      if (typeof input.taskId !== 'string' || !input.taskId.trim()) throw new Error('get_task requires taskId.');
      const task = execContext.taskManager.getTask(input.taskId.trim());
      if (!task) throw new Error(`Task not found: ${input.taskId}`);
      return task;
    }

    case 'stop_task': {
      if (!execContext.taskManager) throw new Error('Task manager is unavailable.');
      if (typeof input.taskId !== 'string' || !input.taskId.trim()) throw new Error('stop_task requires taskId.');
      return execContext.taskManager.stopTask(input.taskId.trim());
    }

    case 'spawn_task': {
      if (!execContext.taskManager) throw new Error('Task manager is unavailable.');
      if (typeof input.prompt !== 'string' || !input.prompt.trim()) {
        throw new Error('spawn_task requires a prompt.');
      }
      const taskRoot = typeof input.cwd === 'string' && input.cwd.trim()
        ? resolveWorkspaceToolPath(input.cwd, rootPath)
        : rootPath;
      if (!taskRoot) throw new Error(`Invalid task cwd: ${input.cwd || '.'}`);

      return execContext.taskManager.createTaskFromPrompt({
        title: typeof input.title === 'string' && input.title.trim() ? input.title.trim() : buildChatTitleFromMessage(input.prompt),
        prompt: input.prompt,
        executionRoot: taskRoot,
        parentTaskId: execContext.parentTaskId || '',
        chatId: execContext.chatId || '',
        background: true
      });
    }

    case 'ask_user_question': {
      if (!execContext.runtime || !execContext.taskId) throw new Error('ask_user_question requires a task execution context.');
      if (typeof input.question !== 'string' || !input.question.trim()) {
        throw new Error('ask_user_question requires question.');
      }
      const question = execContext.runtime.features.createQuestion({
        agentId: currentTask ? currentTask.agentId : '',
        taskId: execContext.taskId,
        chatId: execContext.chatId || '',
        question: input.question,
        choices: Array.isArray(input.choices) ? input.choices : [],
        context: input.context || ''
      });
      execContext.runtime.store.updateTask(execContext.taskId, task => {
        task.awaitingQuestionId = question.id;
        return task;
      });
      if (execContext.chatId) {
        execContext.runtime.store.appendMessage(execContext.chatId, {
          role: 'system-msg',
          content: `Question from agent: ${question.question}`
        });
      }
      return {
        control: 'await_user',
        questionId: question.id,
        question: question.question,
        choices: question.choices
      };
    }

    case 'lsp_symbols': {
      const document = await openWorkspaceDocumentForTool(input.path, rootPath);
      const symbols = await vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', document.uri);
      return Array.isArray(symbols)
        ? symbols.map(symbol => ({
          name: symbol.name,
          kind: symbol.kind,
          line: symbol.range.start.line + 1,
          character: symbol.range.start.character + 1
        }))
        : [];
    }

    case 'lsp_definitions': {
      const document = await openWorkspaceDocumentForTool(input.path, rootPath);
      const position = new vscode.Position(Math.max(0, Number(input.line || 1) - 1), Math.max(0, Number(input.character || 1) - 1));
      const results = await vscode.commands.executeCommand('vscode.executeDefinitionProvider', document.uri, position);
      return Array.isArray(results) ? results.map(location => normalizeLspLocation(location, rootPath)).filter(Boolean) : [];
    }

    case 'lsp_references': {
      const document = await openWorkspaceDocumentForTool(input.path, rootPath);
      const position = new vscode.Position(Math.max(0, Number(input.line || 1) - 1), Math.max(0, Number(input.character || 1) - 1));
      const results = await vscode.commands.executeCommand('vscode.executeReferenceProvider', document.uri, position);
      return Array.isArray(results) ? results.map(location => normalizeLspLocation(location, rootPath)).filter(Boolean) : [];
    }

    case 'lsp_diagnostics': {
      const document = await openWorkspaceDocumentForTool(input.path, rootPath);
      const diagnostics = await vscode.commands.executeCommand('vscode.executeDiagnosticProvider', document.uri);
      return Array.isArray(diagnostics)
        ? diagnostics.map(item => ({
          message: item.message,
          severity: item.severity,
          line: item.range.start.line + 1,
          character: item.range.start.character + 1,
          source: item.source || ''
        }))
        : [];
    }

    case 'workflow_run': {
      if (input.kind === 'team' || input.goal || input.aspects) {
        return execContext.runtime.features.executeTool('orchestrate_team', {
          goal: input.goal || input.prompt || '',
          aspects: input.aspects || [],
          teamName: input.teamName || '',
          verify: input.verify !== false
        }, {
          agentId: currentTask ? currentTask.agentId : '',
          taskId: execContext.taskId || '',
          chatId: execContext.chatId || '',
          rootPath
        });
      }
      throw new Error('workflow_run currently supports the \"team\" workflow pattern.');
    }

    case 'fork_chat': {
      if (!execContext.runtime || !execContext.chatId) throw new Error('fork_chat requires an active chat.');
      const chat = execContext.runtime.store.forkChat(execContext.chatId, typeof input.title === 'string' ? input.title : '');
      if (!chat) throw new Error('Unable to fork chat.');
      return chat;
    }

    default:
      throw new Error(`Unknown agent tool: ${name}`);
  }
}

async function runAutonomousAgent(messages, hooks = {}, execContext = {}) {
  const conversation = [...messages];
  const executedTools = [];
  const priorToolResults = new Map();
  const maxRounds = getAgentMaxRounds();

  for (let round = 0; round < maxRounds; round += 1) {
    if (execContext.runtimeState && execContext.runtimeState.stopRequested) {
      throw new Error('Task stopped by user.');
    }

    if (hooks.onRoundStart) hooks.onRoundStart(round + 1, maxRounds);

    const result = await chatWithModel(conversation, null, {
      stream: false,
      temperature: cfg('temperature') ?? 0.2,
      max_tokens: cfg('maxTokens') ?? 4096
    });

    const assistantText = extractAssistantTextFromResult(result);
    const { toolCalls, cleanedText } = parseAgentToolCalls(assistantText);
    const safeAssistantText = sanitizeAgentVisibleText(assistantText) || assistantText;
    const safeCleanedText = sanitizeAgentVisibleText(cleanedText);

    if (!toolCalls.length) {
      conversation.push({
        role: 'assistant',
        content: safeAssistantText
      });
      if (hooks.onConversationUpdate) hooks.onConversationUpdate(cloneMessages(conversation), round + 1);
      return {
        finalText: safeAssistantText,
        executedTools,
        rounds: round + 1,
        conversation: cloneMessages(conversation)
      };
    }

    conversation.push({
      role: 'assistant',
      content: safeCleanedText || `Using ${toolCalls.length} tool(s).`
    });
    if (hooks.onConversationUpdate) hooks.onConversationUpdate(cloneMessages(conversation), round + 1);

    const noteForUi = summarizeAssistantNoteForUi(safeCleanedText);
    if (hooks.onAssistantNote && noteForUi) {
      hooks.onAssistantNote(noteForUi, round + 1);
    }

    const toolResultBlocks = [];
    for (const toolCall of toolCalls) {
      if (execContext.runtimeState && execContext.runtimeState.stopRequested) {
        throw new Error('Task stopped by user.');
      }

      if (hooks.onToolCall) hooks.onToolCall(toolCall, round + 1);
      const toolSignature = createToolCallSignature(toolCall);
      if (isDedupeEligibleTool(toolCall.name) && priorToolResults.has(toolSignature)) {
        const duplicateResult = {
          skipped: true,
          duplicate: true,
          message: 'This exact read-only tool call was already executed earlier in the same task. Reuse the previous result or request a narrower follow-up.'
        };
        executedTools.push({ name: toolCall.name, input: toolCall.input, ok: true, skipped: true, duplicate: true });
        toolResultBlocks.push(buildToolResultBlockForModel(toolCall, duplicateResult, true));
        if (hooks.onToolResult) hooks.onToolResult(toolCall, duplicateResult, true, round + 1);
        continue;
      }
      try {
        const resultValue = await executeAgentToolCall(toolCall, execContext);
        executedTools.push({ name: toolCall.name, input: toolCall.input, ok: true });
        const compactBlock = buildToolResultBlockForModel(toolCall, resultValue, true);
        toolResultBlocks.push(compactBlock);
        if (isDedupeEligibleTool(toolCall.name)) {
          priorToolResults.set(toolSignature, compactBlock);
        }
        if (toolMayMutateWorkspace(toolCall.name)) {
          priorToolResults.clear();
        }
        if (hooks.onToolResult) hooks.onToolResult(toolCall, resultValue, true, round + 1);
      } catch (error) {
        const errorText = error instanceof Error ? error.message : String(error);
        executedTools.push({ name: toolCall.name, input: toolCall.input, ok: false, error: errorText });
        toolResultBlocks.push(buildToolResultBlockForModel(toolCall, errorText, false));
        if (hooks.onToolResult) hooks.onToolResult(toolCall, errorText, false, round + 1);
      }
    }

    conversation.push(buildToolResultsConversationMessage(round + 1, toolResultBlocks));
    if (hooks.onConversationUpdate) hooks.onConversationUpdate(cloneMessages(conversation), round + 1);
  }

  throw new Error(`Agent stopped after ${maxRounds} rounds without producing a final answer.`);
}

function resolveWorkspacePath(relativePath) {
  const workspaceFolder = getWorkspaceFolder();
  if (!workspaceFolder) return null;

  const normalizedPath = String(relativePath || '').trim().replace(/^[/\\]+/, '');
  if (!normalizedPath) return null;

  const root = workspaceFolder.uri.fsPath;
  const targetPath = path.resolve(root, normalizedPath);
  const relative = path.relative(root, targetPath);

  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    return null;
  }

  return targetPath;
}

function getOpenDirtyDocument(fsPath) {
  return vscode.workspace.textDocuments.find(doc => doc.isDirty && doc.uri.fsPath === fsPath);
}

async function applyAssistantActions(actions) {
  if (!actions.length) return '';

  const workspaceFolder = getWorkspaceFolder();
  if (!workspaceFolder) {
    return 'Aucun workspace ouvert: impossible d’appliquer les actions fichiers.';
  }

  const choice = await vscode.window.showInformationMessage(
    `Apply ${actions.length} workspace change(s)?`,
    { modal: true },
    'Apply',
    'Skip'
  );

  if (choice !== 'Apply') {
    return `${actions.length} action(s) fichiers ignorées.`;
  }

  const results = [];

  for (const action of actions) {
    const targetPath = resolveWorkspacePath(action.path);
    if (!targetPath) {
      results.push(`Ignored invalid path: ${action.path}`);
      continue;
    }

    try {
      if (action.type === 'write') {
        if (getOpenDirtyDocument(targetPath)) {
          results.push(`Skipped dirty file: ${action.path}`);
          continue;
        }

        fs.mkdirSync(path.dirname(targetPath), { recursive: true });
        fs.writeFileSync(targetPath, action.content, 'utf8');
        results.push(`Wrote ${action.path}`);
        continue;
      }

      if (action.type === 'delete') {
        if (getOpenDirtyDocument(targetPath)) {
          results.push(`Skipped dirty file: ${action.path}`);
          continue;
        }

        if (fs.existsSync(targetPath)) {
          const stats = fs.lstatSync(targetPath);
          if (stats.isDirectory()) {
            fs.rmSync(targetPath, { recursive: true, force: true });
          } else {
            fs.unlinkSync(targetPath);
          }
          results.push(`Deleted ${action.path}`);
        } else {
          results.push(`File not found: ${action.path}`);
        }
        continue;
      }

      if (action.type === 'open') {
        const uri = vscode.Uri.file(targetPath);
        const doc = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(doc);
        results.push(`Opened ${action.path}`);
      }
    } catch (err) {
      results.push(`Failed ${action.type} ${action.path}: ${err.message}`);
    }
  }

  return results.join(' | ');
}

class PersistentState {
  constructor(context) {
    this.context = context;
    this.workspaceRoot = getWorkspaceStorageRoot(context);
    this.globalRoot = context.globalStorageUri.fsPath;
    this.chatIndex = { version: 1, chats: [], activeChatId: '' };
    this.taskIndex = { version: 1, tasks: [] };
    this.patchIndex = { version: 1, patches: [] };
    this.workspaceMemory = [];
    this.globalMemory = [];
  }

  async initialize() {
    ensureDirSync(this.workspaceRoot);
    ensureDirSync(this.globalRoot);
    ensureDirSync(this.getChatsRoot());
    ensureDirSync(this.getChatMessagesRoot());
    ensureDirSync(this.getChatSummariesRoot());
    ensureDirSync(this.getTasksRoot());
    ensureDirSync(this.getPatchesRoot());
    ensureDirSync(this.getMemoryRoot());
    ensureDirSync(this.getGlobalMemoryRoot());
    ensureDirSync(this.getRagRoot());
    ensureDirSync(this.getSandboxesRoot());

    this.chatIndex = readJsonFile(this.getChatIndexPath(), { version: 1, chats: [], activeChatId: '' });
    this.taskIndex = readJsonFile(this.getTaskIndexPath(), { version: 1, tasks: [] });
    this.patchIndex = readJsonFile(this.getPatchIndexPath(), { version: 1, patches: [] });
    this.workspaceMemory = readJsonFile(this.getWorkspaceMemoryPath(), []);
    this.globalMemory = readJsonFile(this.getGlobalMemoryPath(), []);

    if (!Array.isArray(this.chatIndex.chats)) this.chatIndex.chats = [];
    if (!Array.isArray(this.taskIndex.tasks)) this.taskIndex.tasks = [];
    if (!Array.isArray(this.patchIndex.patches)) this.patchIndex.patches = [];
    this.chatIndex.chats = this.chatIndex.chats.map(chat => ({
      ...chat,
      instructions: normalizeInstructionText(chat.instructions)
    }));
    if (!this.chatIndex.activeChatId || !this.chatIndex.chats.some(chat => chat.id === this.chatIndex.activeChatId)) {
      if (!this.chatIndex.chats.length) {
        const chat = this.createChat('New Chat');
        this.chatIndex.activeChatId = chat.id;
      } else {
        this.chatIndex.activeChatId = sortChats(this.chatIndex.chats)[0].id;
      }
      this.saveChatIndex();
    }
  }

  getChatsRoot() {
    return path.join(this.workspaceRoot, CHATS_DIR);
  }

  getChatIndexPath() {
    return path.join(this.getChatsRoot(), CHAT_INDEX_FILE);
  }

  getChatMessagesRoot() {
    return path.join(this.getChatsRoot(), CHAT_MESSAGES_DIR);
  }

  getChatMessagePath(chatId) {
    return path.join(this.getChatMessagesRoot(), `${chatId}.json`);
  }

  getChatSummariesRoot() {
    return path.join(this.getChatsRoot(), CHAT_SUMMARIES_DIR);
  }

  getChatSummaryPath(chatId) {
    return path.join(this.getChatSummariesRoot(), `${chatId}.json`);
  }

  getTasksRoot() {
    return path.join(this.workspaceRoot, TASKS_DIR);
  }

  getTaskIndexPath() {
    return path.join(this.getTasksRoot(), TASK_INDEX_FILE);
  }

  getTaskPath(taskId) {
    return path.join(this.getTasksRoot(), `${taskId}.json`);
  }

  getPatchesRoot() {
    return path.join(this.workspaceRoot, PATCHES_DIR);
  }

  getPatchIndexPath() {
    return path.join(this.getPatchesRoot(), PATCH_INDEX_FILE);
  }

  getPatchPath(patchId) {
    return path.join(this.getPatchesRoot(), `${patchId}.json`);
  }

  getPatchArtifactsRoot(patchId) {
    return path.join(this.getPatchesRoot(), patchId);
  }

  getMemoryRoot() {
    return path.join(this.workspaceRoot, MEMORY_DIR);
  }

  getWorkspaceMemoryPath() {
    return path.join(this.getMemoryRoot(), WORKSPACE_MEMORY_FILE);
  }

  getGlobalMemoryRoot() {
    return path.join(this.globalRoot, MEMORY_DIR);
  }

  getGlobalMemoryPath() {
    return path.join(this.getGlobalMemoryRoot(), GLOBAL_MEMORY_FILE);
  }

  getRagRoot() {
    return path.join(this.workspaceRoot, RAG_DIR);
  }

  getSandboxesRoot() {
    return path.join(this.workspaceRoot, SANDBOXES_DIR);
  }

  getRagIndexPath() {
    return path.join(this.getRagRoot(), RAG_INDEX_FILE);
  }

  saveChatIndex() {
    this.chatIndex.chats = sortChats(this.chatIndex.chats);
    writeJsonFile(this.getChatIndexPath(), this.chatIndex);
  }

  saveTaskIndex() {
    this.taskIndex.tasks = [...this.taskIndex.tasks].sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
    writeJsonFile(this.getTaskIndexPath(), this.taskIndex);
  }

  savePatchIndex() {
    this.patchIndex.patches = [...this.patchIndex.patches].sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
    writeJsonFile(this.getPatchIndexPath(), this.patchIndex);
  }

  getChats() {
    return sortChats(this.chatIndex.chats);
  }

  getActiveChatId() {
    return this.chatIndex.activeChatId;
  }

  getActiveChat() {
    return this.chatIndex.chats.find(chat => chat.id === this.chatIndex.activeChatId) || null;
  }

  getTasks() {
    return [...this.taskIndex.tasks].sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  }

  getTaskRecord(taskId) {
    return this.taskIndex.tasks.find(task => task.id === taskId) || null;
  }

  getPatches() {
    return [...this.patchIndex.patches].sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  }

  getPendingPatches() {
    return this.getPatches().filter(patch => patch.status === 'pending');
  }

  loadPatch(patchId) {
    return readJsonFile(this.getPatchPath(patchId), null);
  }

  loadTask(taskId) {
    return readJsonFile(this.getTaskPath(taskId), null);
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
      chatId: task.chatId || '',
      parentTaskId: task.parentTaskId || '',
      background: task.background !== false,
      runtimeKind: task.runtimeKind || 'local',
      agentId: task.agentId || '',
      agentType: task.agentType || 'general-purpose',
      agentName: task.agentName || '',
      teamName: task.teamName || '',
      mode: task.mode || 'default',
      isolation: task.isolation || 'sandbox',
      remoteTaskId: task.remoteTaskId || '',
      executorUrl: task.executorUrl || '',
      deliveredToChat: Boolean(task.deliveredToChat),
      chatDeliveryState: task.chatDeliveryState || '',
      rounds: Number(task.rounds || 0),
      progressSummary: truncateText(normalizeWhitespace(task.progressSummary || ''), 180),
      resultPreview: truncateText(normalizeWhitespace(task.resultText || task.resultPreview || ''), 180),
      error: truncateText(normalizeWhitespace(task.error || ''), 180),
      executionRoot: task.executionRoot || '',
      sandboxId: task.sandboxId || '',
      sandboxState: task.sandboxState || '',
      checkpointAt: task.checkpointAt || '',
      resumeCount: Number(task.resumeCount || 0),
      awaitingQuestionId: task.awaitingQuestionId || '',
      patchId: task.patchId || '',
      patchSummary: truncateText(normalizeWhitespace(task.patchSummary || ''), 180),
      containerImage: task.containerImage || '',
      labels: Array.isArray(task.labels) ? task.labels : []
    };

    const existing = this.taskIndex.tasks.findIndex(item => item.id === task.id);
    if (existing === -1) {
      this.taskIndex.tasks.push(summary);
    } else {
      this.taskIndex.tasks[existing] = summary;
    }
    this.saveTaskIndex();
    return summary;
  }

  saveTask(task) {
    writeJsonFile(this.getTaskPath(task.id), task);
    this.syncTaskRecord(task);
    return task;
  }

  createTask(input) {
    const now = new Date().toISOString();
    const task = {
      id: createId('task'),
      title: truncateText(normalizeWhitespace(input.title || input.prompt || 'New Task'), 72),
      prompt: input.prompt || '',
      status: input.status || 'pending',
      createdAt: now,
      updatedAt: now,
      startedAt: '',
      finishedAt: '',
      chatId: input.chatId || '',
      parentTaskId: input.parentTaskId || '',
      background: input.background !== false,
      rounds: 0,
      messages: cloneMessages(input.messages),
      logs: cloneLogs(input.logs),
      resultText: '',
      resultPreview: '',
      error: '',
      stopRequested: false,
      runtimeKind: input.runtimeKind || 'local',
      agentId: input.agentId || '',
      agentType: normalizeAgentType(input.agentType || 'general-purpose'),
      agentName: input.agentName || '',
      teamName: input.teamName || '',
      mode: input.mode || 'default',
      isolation: input.isolation || 'sandbox',
      modelOverride: input.modelOverride || '',
      remoteTaskId: input.remoteTaskId || '',
      executorUrl: input.executorUrl || '',
      deliveredToChat: Boolean(input.deliveredToChat),
      chatDeliveryState: input.chatDeliveryState || '',
      executionRoot: input.executionRoot || (getWorkspaceFolder() ? getWorkspaceFolder().uri.fsPath : this.workspaceRoot),
      sandboxId: input.sandboxId || '',
      sandboxState: input.sandboxState || 'pending',
      sandboxRootDir: input.sandboxRootDir || '',
      sandboxWorkspaceDir: input.sandboxWorkspaceDir || '',
      sandboxContainerName: input.sandboxContainerName || '',
      containerImage: input.containerImage || '',
      checkpointAt: input.checkpointAt || '',
      resumeCount: Number(input.resumeCount || 0),
      checkpoint: input.checkpoint || null,
      externalMessages: Array.isArray(input.externalMessages) ? input.externalMessages : [],
      awaitingQuestionId: input.awaitingQuestionId || '',
      labels: Array.isArray(input.labels) ? input.labels : [],
      patchId: input.patchId || '',
      patchSummary: input.patchSummary || '',
      progressSummary: input.progressSummary || '',
      patchArtifactPath: input.patchArtifactPath || '',
      lastSandboxDiffAt: '',
      liveMode: Boolean(input.liveMode)
    };
    this.saveTask(task);
    return task;
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

  appendTaskLog(taskId, message, level = 'info') {
    return this.updateTask(taskId, task => {
      task.logs = Array.isArray(task.logs) ? task.logs : [];
      task.logs.push({
        id: createId('log'),
        at: new Date().toISOString(),
        level,
        message: truncateText(String(message || ''), 1000)
      });
      task.logs = task.logs.slice(-MAX_TASK_LOG_ENTRIES);
      return task;
    });
  }

  savePatch(patch) {
    writeJsonFile(this.getPatchPath(patch.id), patch);
    const summary = {
      id: patch.id,
      taskId: patch.taskId || '',
      chatId: patch.chatId || '',
      status: patch.status || 'pending',
      createdAt: patch.createdAt || new Date().toISOString(),
      updatedAt: patch.updatedAt || patch.createdAt || new Date().toISOString(),
      summary: truncateText(normalizeWhitespace(patch.summary || ''), 220),
      fileCount: Array.isArray(patch.files) ? patch.files.length : 0
    };
    const existing = this.patchIndex.patches.findIndex(item => item.id === patch.id);
    if (existing === -1) this.patchIndex.patches.push(summary);
    else this.patchIndex.patches[existing] = summary;
    this.savePatchIndex();
    return patch;
  }

  createPatch(input) {
    const now = new Date().toISOString();
    const patch = {
      id: input.id || createId('patch'),
      taskId: input.taskId || '',
      chatId: input.chatId || '',
      sandboxId: input.sandboxId || '',
      source: input.source || 'local',
      status: input.status || 'pending',
      summary: input.summary || '',
      diffText: input.diffText || '',
      files: Array.isArray(input.files) ? input.files : [],
      createdAt: now,
      updatedAt: now
    };
    this.savePatch(patch);
    return patch;
  }

  updatePatch(patchId, updater) {
    const patch = this.loadPatch(patchId);
    if (!patch) return null;
    const nextPatch = typeof updater === 'function'
      ? (updater(patch) || patch)
      : Object.assign(patch, updater || {});
    nextPatch.updatedAt = new Date().toISOString();
    this.savePatch(nextPatch);
    return nextPatch;
  }

  createChat(title, options = {}) {
    const now = new Date().toISOString();
    const chat = {
      id: createId('chat'),
      title: title || 'New Chat',
      createdAt: now,
      updatedAt: now,
      pinned: false,
      archived: false,
      instructions: '',
      lastModel: normalizeModelId(getModelId()),
      workspaceId: safeRelativeToWorkspace(getWorkspaceFolder() ? getWorkspaceFolder().uri.fsPath : this.workspaceRoot),
      parentChatId: options.parentChatId || '',
      branchLabel: options.branchLabel || ''
    };
    this.chatIndex.chats.push(chat);
    writeJsonFile(this.getChatMessagePath(chat.id), Array.isArray(options.messages) ? options.messages : []);
    writeJsonFile(this.getChatSummaryPath(chat.id), options.summary || {
      chatId: chat.id,
      rollingSummary: '',
      openTasks: [],
      importantFacts: [],
      lastCompactedMessageCount: 0,
      updatedAt: now
    });
    this.chatIndex.activeChatId = chat.id;
    this.saveChatIndex();
    return chat;
  }

  forkChat(chatId, title = '') {
    const sourceChat = this.chatIndex.chats.find(item => item.id === chatId);
    if (!sourceChat) return null;
    const messages = this.loadMessages(chatId);
    const summary = this.getSummary(chatId);
    const forked = this.createChat(title || `${sourceChat.title} Fork`, {
      parentChatId: sourceChat.id,
      branchLabel: 'fork',
      messages
    });
    this.saveSummary(forked.id, {
      ...summary,
      chatId: forked.id,
      updatedAt: new Date().toISOString()
    });
    this.setChatInstructions(forked.id, sourceChat.instructions || '');
    return forked;
  }

  ensureActiveChat() {
    const active = this.getActiveChat();
    if (active) return active;
    return this.createChat('New Chat');
  }

  selectChat(chatId) {
    if (!this.chatIndex.chats.some(chat => chat.id === chatId)) return null;
    this.chatIndex.activeChatId = chatId;
    this.saveChatIndex();
    return this.getActiveChat();
  }

  renameChat(chatId, title) {
    const chat = this.chatIndex.chats.find(item => item.id === chatId);
    if (!chat) return null;
    chat.title = truncateText(normalizeWhitespace(title) || 'Untitled Chat', 60);
    chat.updatedAt = new Date().toISOString();
    this.saveChatIndex();
    return chat;
  }

  togglePin(chatId) {
    const chat = this.chatIndex.chats.find(item => item.id === chatId);
    if (!chat) return null;
    chat.pinned = !chat.pinned;
    chat.updatedAt = new Date().toISOString();
    this.saveChatIndex();
    return chat;
  }

  deleteChat(chatId) {
    const previousActive = this.chatIndex.activeChatId;
    this.chatIndex.chats = this.chatIndex.chats.filter(chat => chat.id !== chatId);
    try { fs.rmSync(this.getChatMessagePath(chatId), { force: true }); } catch (error) {
      console.error(`[localai-code] Failed to delete chat messages for ${chatId}: ${error.message}`);
    }
    try { fs.rmSync(this.getChatSummaryPath(chatId), { force: true }); } catch (error) {
      console.error(`[localai-code] Failed to delete chat summary for ${chatId}: ${error.message}`);
    }

    if (!this.chatIndex.chats.length) {
      return this.createChat('New Chat');
    }

    if (previousActive === chatId) {
      this.chatIndex.activeChatId = sortChats(this.chatIndex.chats)[0].id;
    }
    this.saveChatIndex();
    return this.getActiveChat();
  }

  getChatInstructions(chatId) {
    const chat = this.chatIndex.chats.find(item => item.id === chatId);
    return chat ? normalizeInstructionText(chat.instructions) : '';
  }

  setChatInstructions(chatId, text) {
    const chat = this.chatIndex.chats.find(item => item.id === chatId);
    if (!chat) return null;
    chat.instructions = normalizeInstructionText(text);
    chat.updatedAt = new Date().toISOString();
    this.saveChatIndex();
    return chat;
  }

  touchChat(chatId) {
    const chat = this.chatIndex.chats.find(item => item.id === chatId);
    if (!chat) return null;
    chat.updatedAt = new Date().toISOString();
    chat.lastModel = normalizeModelId(getModelId());
    this.saveChatIndex();
    return chat;
  }

  loadMessages(chatId) {
    return readJsonFile(this.getChatMessagePath(chatId), []);
  }

  saveMessages(chatId, messages) {
    writeJsonFile(this.getChatMessagePath(chatId), messages);
    this.touchChat(chatId);
  }

  appendMessage(chatId, message) {
    const messages = this.loadMessages(chatId);
    const entry = {
      id: createId(message.role || 'msg'),
      role: message.role,
      content: message.content,
      createdAt: message.createdAt || new Date().toISOString()
    };
    messages.push(entry);
    this.saveMessages(chatId, messages);

    const chat = this.chatIndex.chats.find(item => item.id === chatId);
    if (chat && (!chat.title || chat.title === 'New Chat') && message.role === 'user') {
      chat.title = buildChatTitleFromMessage(message.content);
      this.saveChatIndex();
    }
    return entry;
  }

  getSummary(chatId) {
    return readJsonFile(this.getChatSummaryPath(chatId), {
      chatId,
      rollingSummary: '',
      openTasks: [],
      importantFacts: [],
      lastCompactedMessageCount: 0,
      updatedAt: ''
    });
  }

  saveSummary(chatId, summary) {
    writeJsonFile(this.getChatSummaryPath(chatId), summary);
  }

  getMemory(scope) {
    if (scope === 'global') return Array.isArray(this.globalMemory) ? this.globalMemory : [];
    return Array.isArray(this.workspaceMemory) ? this.workspaceMemory : [];
  }

  saveMemory(scope, notes) {
    if (scope === 'global') {
      this.globalMemory = notes;
      writeJsonFile(this.getGlobalMemoryPath(), notes);
      return;
    }
    this.workspaceMemory = notes;
    writeJsonFile(this.getWorkspaceMemoryPath(), notes);
  }

  upsertMemoryNotes(scope, notes, sourceChatId) {
    if (!Array.isArray(notes) || !notes.length) return [];
    const current = [...this.getMemory(scope)];
    const now = new Date().toISOString();

    for (const note of notes) {
      const content = truncateText(normalizeWhitespace(typeof note === 'string' ? note : note.content), 300);
      if (!content) continue;
      const kind = note && typeof note === 'object' && note.kind ? note.kind : 'fact';
      const existing = current.find(item => item.content.toLowerCase() === content.toLowerCase());
      if (existing) {
        existing.updatedAt = now;
        existing.sourceChatId = sourceChatId;
        continue;
      }
      current.push({
        id: createId('mem'),
        scope,
        kind,
        content,
        sourceChatId,
        createdAt: now,
        updatedAt: now
      });
    }

    const limited = current.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || '')).slice(0, 120);
    this.saveMemory(scope, limited);
    return limited;
  }

  getUiSnapshot() {
    const activeChat = this.ensureActiveChat();
    const chatById = new Map();
    for (const chat of this.chatIndex.chats) {
      chatById.set(chat.id, chat);
    }
    const parentChat = (activeChat && activeChat.parentChatId && activeChat.branchLabel === 'fork')
      ? chatById.get(activeChat.parentChatId) || null
      : null;
    const childChats = (activeChat && Array.isArray(activeChat.childChatIds))
      ? activeChat.childChatIds.map(id => chatById.get(id)).filter(Boolean)
      : [];
    return {
      chats: this.getChats(),
      activeChatId: activeChat ? activeChat.id : '',
      activeChat,
      messages: activeChat ? this.loadMessages(activeChat.id) : [],
      summary: activeChat ? this.getSummary(activeChat.id) : null,
      parentChat,
      childChats,
      tasks: this.getTasks().slice(0, 12),
      patches: this.getPendingPatches().slice(0, 8),
      workspaceMemoryCount: this.getMemory('workspace').length,
      globalMemoryCount: this.getMemory('global').length
    };
  }
}

class RagIndexManager {
  constructor(context, store) {
    this.context = context;
    this.store = store;
    this.index = readJsonFile(store.getRagIndexPath(), {
      version: 1,
      chunks: [],
      status: 'idle',
      lastIndexedAt: '',
      lastError: ''
    });
    this.pendingPaths = new Set();
    this.rebuildTimer = null;
    this.autoRefreshTimer = null;
    this.watchers = [];
    this.running = false;
    this.lastManualRebuildAt = 0;
  }

  async initialize() {
    ensureDirSync(this.store.getRagRoot());
    this.startWatchers();
    this.scheduleInitialBuild();
    this.startAutoRefresh();
  }

  dispose() {
    for (const watcher of this.watchers) watcher.dispose();
    this.watchers = [];
    if (this.rebuildTimer) clearTimeout(this.rebuildTimer);
    if (this.autoRefreshTimer) clearTimeout(this.autoRefreshTimer);
    this.rebuildTimer = null;
    this.autoRefreshTimer = null;
  }

  getStatus() {
    const chunks = Array.isArray(this.index.chunks) ? this.index.chunks : [];
    const embedded = chunks.filter(chunk => Array.isArray(chunk.embedding) && chunk.embedding.length).length;
    return {
      enabled: ragEnabled(),
      mode: cfg('rag.mode') || 'hybrid-local',
      state: this.index.status || 'idle',
      chunkCount: chunks.length,
      fileCount: new Set(chunks.map(chunk => chunk.path)).size,
      semanticCoverage: chunks.length ? Math.round((embedded / chunks.length) * 100) : 0,
      lastIndexedAt: this.index.lastIndexedAt || '',
      lastError: this.index.lastError || '',
      embeddingModel: getEmbeddingModel()
    };
  }

  saveIndex() {
    writeJsonFile(this.store.getRagIndexPath(), this.index);
  }

  setStatus(status, error = '') {
    this.index.status = status;
    this.index.lastError = error;
    if (status === 'ready') this.index.lastIndexedAt = new Date().toISOString();
    this.saveIndex();
    if (chatProvider && chatProvider.syncState) chatProvider.syncState();
  }

  startAutoRefresh() {
    if (this.autoRefreshTimer) {
      clearTimeout(this.autoRefreshTimer);
      this.autoRefreshTimer = null;
    }
    const intervalMinutes = getAutoRefreshIntervalMinutes();
    if (intervalMinutes <= 0) return;
    const intervalMs = intervalMinutes * 60 * 1000;
    this.autoRefreshTimer = setTimeout(() => {
      this.autoRefreshTimer = null;
      this.performAutoRefresh().catch(error => {
        console.error(`[localai-code] RAG auto-refresh failed: ${error.message}`);
      });
    }, intervalMs);
    console.log(`[localai-code] RAG auto-refresh scheduled every ${intervalMinutes} minute(s).`);
  }

  async performAutoRefresh() {
    const now = Date.now();
    const recentThresholdMs = 60 * 1000;
    if (now - this.lastManualRebuildAt < recentThresholdMs) {
      console.log('[localai-code] RAG auto-refresh skipped, index was recently rebuilt.');
      this.startAutoRefresh();
      return;
    }
    console.log('[localai-code] RAG auto-refresh triggered.');
    await this.rebuildAll();
    this.startAutoRefresh();
  }

  startWatchers() {
    const watcher = vscode.workspace.createFileSystemWatcher('**/*');
    watcher.onDidCreate(uri => this.schedulePathRefresh(uri));
    watcher.onDidChange(uri => this.schedulePathRefresh(uri));
    watcher.onDidDelete(uri => this.removePath(uri));
    this.watchers.push(watcher);
  }

  scheduleInitialBuild() {
    if (!ragEnabled()) return;
    this.scheduleFullRebuild(this.index.chunks && this.index.chunks.length ? 1500 : 400);
  }

  scheduleFullRebuild(delayMs) {
    if (!ragEnabled()) return;
    if (this.rebuildTimer) clearTimeout(this.rebuildTimer);
    this.rebuildTimer = setTimeout(() => {
      this.rebuildTimer = null;
      this.rebuildAll().catch(error => this.setStatus('error', error.message));
    }, delayMs);
  }

  schedulePathRefresh(uri) {
    if (!ragEnabled()) return;
    const relativePath = safeRelativeToWorkspace(uri.fsPath);
    if (!isIndexablePath(relativePath)) return;
    this.pendingPaths.add(uri.fsPath);
    if (this.rebuildTimer) clearTimeout(this.rebuildTimer);
    this.rebuildTimer = setTimeout(() => {
      const targets = [...this.pendingPaths];
      this.pendingPaths.clear();
      this.rebuildTimer = null;
      this.refreshPaths(targets).catch(error => this.setStatus('error', error.message));
    }, 700);
  }

  async rebuildAll() {
    if (this.running || !ragEnabled()) return;
    this.running = true;
    this.lastManualRebuildAt = Date.now();
    this.setStatus('indexing');
    try {
      const files = await vscode.workspace.findFiles('**/*', WORKSPACE_CONTEXT_EXCLUDES, WORKSPACE_FILE_LIMIT);
      const oldByKey = new Map((this.index.chunks || []).map(chunk => [`${chunk.path}:${chunk.hash}`, chunk]));
      const chunks = [];
      for (const file of files) {
        const relativePath = safeRelativeToWorkspace(file.fsPath);
        if (!isIndexablePath(relativePath)) continue;
        const produced = await this.buildChunksForFile(file.fsPath, oldByKey);
        chunks.push(...produced);
      }
      this.index.chunks = chunks;
      this.setStatus('ready');
    } finally {
      this.running = false;
    }
  }

  async refreshPaths(paths) {
    if (this.running || !ragEnabled()) return;
    this.running = true;
    this.setStatus('indexing');
    try {
      const retained = (this.index.chunks || []).filter(chunk => !paths.some(fsPath => safeRelativeToWorkspace(fsPath) === chunk.path));
      const oldByKey = new Map((this.index.chunks || []).map(chunk => [`${chunk.path}:${chunk.hash}`, chunk]));
      for (const fsPath of paths) {
        const relativePath = safeRelativeToWorkspace(fsPath);
        if (!fileExists(fsPath) || !isIndexablePath(relativePath)) continue;
        const chunks = await this.buildChunksForFile(fsPath, oldByKey);
        retained.push(...chunks);
      }
      this.index.chunks = retained;
      this.setStatus('ready');
    } finally {
      this.running = false;
    }
  }

  removePath(uri) {
    const relativePath = safeRelativeToWorkspace(uri.fsPath);
    this.index.chunks = (this.index.chunks || []).filter(chunk => chunk.path !== relativePath);
    this.setStatus('ready');
  }

  async buildChunksForFile(fsPath, oldByKey) {
    try {
      const stat = fs.statSync(fsPath);
      if (!stat.isFile() || stat.size > MAX_INDEX_FILE_BYTES) return [];
      const buffer = fs.readFileSync(fsPath);
      if (isLikelyBinary(buffer)) return [];
      const text = buffer.toString('utf8');
      const relativePath = safeRelativeToWorkspace(fsPath);
      const language = detectLanguageFromPath(relativePath);
      const parts = chunkText(text, getChunkSizeChars(), getChunkOverlapChars());
      const chunks = [];
      for (let index = 0; index < parts.length; index += 1) {
        const part = parts[index];
        const hash = hashText(`${relativePath}:${part.start}:${part.end}:${part.text}`);
        const old = oldByKey.get(`${relativePath}:${hash}`);
        chunks.push({
          id: `${relativePath}:${index}:${hash.slice(0, 12)}`,
          path: relativePath,
          hash,
          mtimeMs: stat.mtimeMs,
          language,
          start: part.start,
          end: part.end,
          text: part.text,
          keywords: tokenize(`${relativePath} ${part.text}`).slice(0, 120),
          embedding: old && Array.isArray(old.embedding) ? old.embedding : null
        });
      }
      return chunks;
    } catch (error) {
      console.error(`[localai-code] Failed to chunk file for RAG ${fsPath}: ${error.message}`);
      return [];
    }
  }

  async ensureChunkEmbeddings(chunks) {
    if (!ragEnabled() || !chunks.length) return;
    const missing = chunks.filter(chunk => !Array.isArray(chunk.embedding) || !chunk.embedding.length).slice(0, MAX_EMBED_CANDIDATES);
    if (!missing.length) return;

    const inputs = missing.map(chunk => `passage: ${truncateText(chunk.text, 2000)}`);
    try {
      const maxRetries = getEmbedMaxRetries();
      const vectors = await retryWithBackoff(() => featureExtractionRequest(inputs), maxRetries);
      if (!Array.isArray(vectors)) return;
      for (let i = 0; i < missing.length; i += 1) {
        if (Array.isArray(vectors[i])) missing[i].embedding = vectors[i];
      }
      this.saveIndex();
    } catch (error) {
      console.error(`[localai-code] Embedding failed after retries: ${error.message}`);
      this.index.lastError = error.message;
      this.saveIndex();
    }
  }

  async getQueryEmbedding(queryText) {
    try {
      const maxRetries = getEmbedMaxRetries();
      const result = await retryWithBackoff(() => featureExtractionRequest(`query: ${truncateText(queryText, 2000)}`), maxRetries);
      if (Array.isArray(result) && Array.isArray(result[0])) return result[0];
      if (Array.isArray(result)) return result;
      return null;
    } catch (err) {
      console.error(`[localai-code] RAG query embedding failed: ${err.message}`);
      return null;
    }
  }

  async search(queryText, openPaths = []) {
    if (!ragEnabled()) return { snippets: [], usedSemantic: false, error: '' };

    const queryTokens = tokenize(queryText);
    const chunks = Array.isArray(this.index.chunks) ? this.index.chunks : [];
    if (!chunks.length) {
      this.scheduleFullRebuild(200);
      return { snippets: [], usedSemantic: false, error: 'Index not ready yet.' };
    }

    const lexicalCandidates = chunks
      .map(chunk => {
        const lexicalScore = scoreTokenOverlap(queryTokens, `${chunk.path} ${chunk.text}`) + (openPaths.includes(chunk.path) ? 0.08 : 0);
        return { ...chunk, lexicalScore, semanticScore: 0, finalScore: lexicalScore };
      })
      .filter(chunk => chunk.lexicalScore > 0)
      .sort((a, b) => b.lexicalScore - a.lexicalScore)
      .slice(0, DEFAULT_RAG_CANDIDATES);

    if (!lexicalCandidates.length) return { snippets: [], usedSemantic: false, error: '' };

    let usedSemantic = false;
    const allowSemantic = (cfg('rag.mode') || 'hybrid-local') !== 'lexical-only';
    if (allowSemantic) {
      await this.ensureChunkEmbeddings(lexicalCandidates);
      const queryEmbedding = await this.getQueryEmbedding(queryText);
      if (queryEmbedding) {
        usedSemantic = true;
        for (const chunk of lexicalCandidates) {
          if (Array.isArray(chunk.embedding) && chunk.embedding.length) {
            chunk.semanticScore = cosineSimilarity(queryEmbedding, chunk.embedding);
            chunk.finalScore = (chunk.lexicalScore * 0.35) + (chunk.semanticScore * 0.65);
          }
        }
      }
    }

    const selected = lexicalCandidates
      .sort((a, b) => b.finalScore - a.finalScore)
      .slice(0, getRagTopK())
      .map(chunk => ({
        path: chunk.path,
        language: chunk.language,
        preview: truncateText(chunk.text, 1200),
        lexicalScore: Number(chunk.lexicalScore.toFixed(4)),
        semanticScore: Number(chunk.semanticScore.toFixed(4)),
        finalScore: Number(chunk.finalScore.toFixed(4))
      }));

    return { snippets: selected, usedSemantic, error: '' };
  }
}

class LocalAIRuntime {
  constructor(context) {
    this.context = context;
    this.store = new PersistentState(context);
    this.features = new RuntimeFeatureStore({
      providerId: 'localai',
      workspaceRoot: this.store.workspaceRoot,
      globalRoot: this.store.globalRoot,
      configGetter: (key, defaultValue) => {
        const value = cfg(key);
        return value !== undefined && value !== null && value !== '' ? value : defaultValue;
      }
    });
    this.rag = new RagIndexManager(context, this.store);
    this.sandbox = new DockerSandboxManager({
      repoRoot: context.extensionUri.fsPath,
      storageRoot: this.store.getSandboxesRoot(),
      image: getSandboxImage(),
      dockerfilePath: path.join(context.extensionUri.fsPath, 'sandbox', 'Dockerfile'),
      networkMode: getSandboxNetworkMode(),
      autoBuild: sandboxAutoBuildImage(),
      keepSandboxes: sandboxRetainOnFailure(),
      maxToolTimeoutMs: getSandboxToolTimeoutMs(),
      containerNamePrefix: 'localai-sbx'
    });
    this.tasks = new AgentTaskManager(this);
    this.features.bridge = {
      createTask: (input) => this.tasks.createTaskFromPrompt(input),
      getTask: (taskId) => this.tasks.getTask(taskId),
      stopTask: (taskId) => this.tasks.stopTask(taskId),
      resumeTask: (taskId, options) => this.tasks.resumeTask(taskId, options),
      updateTask: (taskId, changes) => this.tasks.updateTask(taskId, changes),
      getTaskOutput: (taskId) => this.tasks.getTaskOutput(taskId),
      appendTaskMessage: (taskId, message, meta) => this.tasks.appendTaskMessage(taskId, message, meta),
      waitForTaskAgents: (agents, timeoutMs) => this.tasks.waitForAgents(agents, timeoutMs)
    };
    this.readyPromise = null;
    this.compactingChats = new Set();
    this.contextMetaByChat = new Map();
    this._lastDockerAutoStartAt = 0;
    this._lastDockerAutoStartResult = null;
  }

  async initialize() {
    if (!this.readyPromise) {
      this.readyPromise = (async () => {
        await this.store.initialize();
        this.features.initialize();
        await this.rag.initialize();
        await this.tasks.initialize();
        await this.refreshRuntimeContexts();
        void this.maybeAutoStartDocker({ reason: 'activation', waitForReady: false });
      })();
    }
    return this.readyPromise;
  }

  async refreshRuntimeContexts() {
    await vscode.commands.executeCommand('setContext', 'localai.viewingDiff', this.store.getPendingPatches().length > 0);
    await vscode.commands.executeCommand('setContext', 'localai.pendingQuestion', Boolean(this.features.getSnapshot().pendingQuestions.length));
  }

  async _waitForDockerReady(timeoutMs = DOCKER_AUTO_START_READY_TIMEOUT_MS) {
    const deadline = Date.now() + Math.max(DOCKER_AUTO_START_POLL_MS, Number(timeoutMs) || DOCKER_AUTO_START_READY_TIMEOUT_MS);
    while (Date.now() < deadline) {
      const health = await this.sandbox.getHealth(true);
      if (health.dockerReady) return health;
      await new Promise(resolve => setTimeout(resolve, DOCKER_AUTO_START_POLL_MS));
    }
    return null;
  }

  async maybeAutoStartDocker(options = {}) {
    const reason = String(options.reason || 'runtime');
    const waitForReady = options.waitForReady === true;
    const skippedResult = {
      attempted: false,
      launched: false,
      ready: false,
      reason,
      detail: ''
    };

    if (!sandboxEnabled() || !sandboxAutoStartDocker() || process.platform !== 'win32') {
      return skippedResult;
    }

    const initialHealth = await this.sandbox.getHealth(false);
    if (initialHealth.dockerReady) {
      const result = {
        attempted: false,
        launched: false,
        ready: true,
        reason,
        detail: 'Docker is already ready.'
      };
      this._lastDockerAutoStartResult = result;
      return result;
    }

    const now = Date.now();
    const inCooldown = this._lastDockerAutoStartAt && (now - this._lastDockerAutoStartAt) < DOCKER_AUTO_START_COOLDOWN_MS;
    if (inCooldown) {
      const readyHealth = waitForReady ? await this._waitForDockerReady() : null;
      const result = {
        attempted: true,
        launched: false,
        ready: Boolean(readyHealth && readyHealth.dockerReady),
        reason,
        detail: readyHealth && readyHealth.dockerReady
          ? 'Docker became ready after a recent auto-start request.'
          : 'Docker auto-start was already requested recently.'
      };
      this._lastDockerAutoStartResult = result;
      return result;
    }

    const dockerDesktopPath = getDockerDesktopExecutableCandidates().find(candidate => {
      try {
        return fs.existsSync(candidate);
      } catch (_) {
        return false;
      }
    });
    if (!dockerDesktopPath) {
      const result = {
        attempted: true,
        launched: false,
        ready: false,
        reason,
        detail: 'Docker Desktop executable was not found on this machine.'
      };
      this._lastDockerAutoStartAt = now;
      this._lastDockerAutoStartResult = result;
      console.warn(`[localai-code] Docker auto-start skipped (${reason}): ${result.detail}`);
      return result;
    }

    try {
      const child = spawn(dockerDesktopPath, [], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true
      });
      child.unref();
      this._lastDockerAutoStartAt = now;
      const readyHealth = waitForReady ? await this._waitForDockerReady() : null;
      const result = {
        attempted: true,
        launched: true,
        ready: Boolean(readyHealth && readyHealth.dockerReady),
        reason,
        detail: readyHealth && readyHealth.dockerReady
          ? 'Docker Desktop was launched and the daemon is ready.'
          : 'Docker Desktop launch was requested. The daemon may still be starting.'
      };
      this._lastDockerAutoStartResult = result;
      console.log(`[localai-code] Docker auto-start (${reason}): ${result.detail}`);
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const result = {
        attempted: true,
        launched: false,
        ready: false,
        reason,
        detail: `Failed to launch Docker Desktop: ${message}`
      };
      this._lastDockerAutoStartAt = now;
      this._lastDockerAutoStartResult = result;
      console.warn(`[localai-code] Docker auto-start failed (${reason}): ${message}`);
      return result;
    }
  }

  async getSandboxStatus(force = false) {
    const health = await this.sandbox.getHealth(force);
    return {
      enabled: sandboxEnabled(),
      required: sandboxRuntimeRequired(),
      dockerReady: Boolean(health.dockerReady),
      imageReady: Boolean(health.imageReady),
      ok: Boolean(health.ok && (!sandboxEnabled() || health.imageReady || sandboxAutoBuildImage())),
      image: health.image,
      networkMode: health.networkMode,
      autoStart: this._lastDockerAutoStartResult ? { ...this._lastDockerAutoStartResult } : null,
      detail: health.detail || (this._lastDockerAutoStartResult && this._lastDockerAutoStartResult.detail) || '',
      checkedAt: new Date(health.checkedAt || Date.now()).toISOString()
    };
  }

  async ensureSandboxReady() {
    if (!sandboxEnabled()) {
      throw new Error('Sandboxed agent execution is disabled in settings.');
    }
    try {
      await this.maybeAutoStartDocker({ reason: 'ensure-sandbox', waitForReady: true });
      await this.sandbox.ensureReady();
      return this.getSandboxStatus(true);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (sandboxRuntimeRequired()) {
        throw new Error(message);
      }
      return {
        enabled: sandboxEnabled(),
        required: sandboxRuntimeRequired(),
        dockerReady: false,
        imageReady: false,
        ok: false,
        image: getSandboxImage(),
        networkMode: getSandboxNetworkMode(),
        detail: message,
        checkedAt: new Date().toISOString()
      };
    }
  }

  async persistPatchArtifacts(patchLike) {
    const patchSummary = formatPatchSummary(patchLike.files, patchLike.summary || '');
    const patch = this.store.createPatch({
      taskId: patchLike.taskId || '',
      chatId: patchLike.chatId || '',
      sandboxId: patchLike.sandboxId || '',
      source: patchLike.source || 'local',
      status: patchLike.status || 'pending',
      summary: patchSummary,
      diffText: patchLike.diffText || '',
      files: []
    });
    const artifactRoot = this.store.getPatchArtifactsRoot(patch.id);
    const beforeRoot = path.join(artifactRoot, 'before');
    const afterRoot = path.join(artifactRoot, 'after');
    ensureDirSync(beforeRoot);
    ensureDirSync(afterRoot);

    const files = [];
    for (const entry of Array.isArray(patchLike.files) ? patchLike.files : []) {
      const relativePath = normalizeRelativeFilePath(entry.path || '');
      if (!relativePath) continue;
      const beforePath = entry.beforeText == null ? '' : path.join(beforeRoot, makeArtifactFileName(relativePath, '.before'));
      const afterPath = entry.afterText == null ? '' : path.join(afterRoot, makeArtifactFileName(relativePath, '.after'));
      if (beforePath) {
        ensureDirSync(path.dirname(beforePath));
        fs.writeFileSync(beforePath, String(entry.beforeText || ''), 'utf8');
      }
      if (afterPath) {
        ensureDirSync(path.dirname(afterPath));
        fs.writeFileSync(afterPath, String(entry.afterText || ''), 'utf8');
      }
      files.push({
        type: entry.type || 'modify',
        path: relativePath,
        oldPath: normalizeRelativeFilePath(entry.oldPath || ''),
        beforePath,
        afterPath
      });
    }
    const finalPatch = this.store.updatePatch(patch.id, currentPatch => {
      currentPatch.files = files;
      currentPatch.diffPath = path.join(artifactRoot, 'patch.diff');
      currentPatch.summary = patchSummary || currentPatch.summary;
      currentPatch.diffText = patchLike.diffText || '';
      return currentPatch;
    });
    fs.writeFileSync(path.join(artifactRoot, 'patch.diff'), String(patchLike.diffText || ''), 'utf8');
    await this.refreshRuntimeContexts();
    return finalPatch;
  }

  async createPatchFromAssistantActions(actions, meta = {}) {
    const files = [];
    for (const action of actions) {
      const relativePath = normalizeRelativeFilePath(action.path);
      if (!relativePath) continue;
      const targetPath = resolveWorkspacePath(relativePath);
      if (!targetPath) continue;
      let beforeText = null;
      if (fileExists(targetPath) && action.type !== 'open') {
        try { beforeText = fs.readFileSync(targetPath, 'utf8'); } catch (_) { beforeText = null; }
      }
      if (action.type === 'write') {
        files.push({ type: beforeText == null ? 'add' : 'modify', path: relativePath, beforeText, afterText: action.content });
      } else if (action.type === 'delete') {
        files.push({ type: 'delete', path: relativePath, beforeText, afterText: null });
      }
    }
    if (!files.length) return null;
    return this.persistPatchArtifacts({
      taskId: meta.taskId || '',
      chatId: meta.chatId || '',
      sandboxId: meta.sandboxId || '',
      source: meta.source || 'assistant-actions',
      summary: formatPatchSummary(files, `${files.length} file change(s) proposed by assistant tags`),
      diffText: '',
      files
    });
  }

  async reviewPatch(patchId, filePath = '') {
    const patch = this.store.loadPatch(patchId);
    if (!patch) throw new Error(`Patch not found: ${patchId}`);
    const target = filePath
      ? patch.files.find(item => item.path === normalizeRelativeFilePath(filePath))
      : (patch.files[0] || null);
    if (!target) throw new Error('Patch has no reviewable files.');
    const leftUri = vscode.Uri.file(target.beforePath || path.join(this.store.getPatchArtifactsRoot(patchId), 'empty.before'));
    const rightUri = vscode.Uri.file(target.afterPath || path.join(this.store.getPatchArtifactsRoot(patchId), 'empty.after'));
    if (!target.beforePath && !fileExists(leftUri.fsPath)) fs.writeFileSync(leftUri.fsPath, '', 'utf8');
    if (!target.afterPath && !fileExists(rightUri.fsPath)) fs.writeFileSync(rightUri.fsPath, '', 'utf8');
    await vscode.commands.executeCommand('vscode.diff', leftUri, rightUri, `LocalAI Patch Review: ${target.path}`);
    return patch;
  }

  async applyPatch(patchId) {
    const patch = this.store.loadPatch(patchId);
    if (!patch) throw new Error(`Patch not found: ${patchId}`);
    if (patch.status !== 'pending') return patch;
    const results = [];
    for (const file of patch.files || []) {
      const targetPath = resolveWorkspacePath(file.path);
      if (!targetPath) throw new Error(`Invalid workspace path in patch: ${file.path}`);
      if (getOpenDirtyDocument(targetPath)) {
        throw new Error(`Cannot apply patch because ${file.path} has unsaved changes.`);
      }
      if (file.type === 'delete') {
        if (fileExists(targetPath)) fs.rmSync(targetPath, { recursive: true, force: true });
        results.push(`deleted ${file.path}`);
        continue;
      }
      if (file.type === 'rename' && file.oldPath) {
        const oldPath = resolveWorkspacePath(file.oldPath);
        if (oldPath && fileExists(oldPath) && oldPath !== targetPath) {
          fs.rmSync(oldPath, { recursive: true, force: true });
        }
      }
      ensureDirSync(path.dirname(targetPath));
      const nextContent = file.afterPath ? fs.readFileSync(file.afterPath, 'utf8') : '';
      fs.writeFileSync(targetPath, nextContent, 'utf8');
      results.push(`${file.type === 'add' ? 'created' : 'updated'} ${file.path}`);
    }
    this.store.updatePatch(patchId, currentPatch => {
      currentPatch.status = 'accepted';
      currentPatch.appliedAt = new Date().toISOString();
      return currentPatch;
    });
    if (patch.taskId) {
      this.store.updateTask(patch.taskId, currentTask => {
        currentTask.patchSummary = `Applied patch ${patch.id}`;
        currentTask.progressSummary = `Applied patch: ${formatPatchSummary(patch.files, patch.summary || patch.id)}`;
        return currentTask;
      });
    }
    if (patch.chatId) {
      this.store.appendMessage(patch.chatId, {
        role: 'system-msg',
        content: `Patch applied: ${formatPatchSummary(patch.files, patch.summary || patch.id)}`
      });
    }
    if (results.length) {
      vscode.window.showInformationMessage(`Patch applied: ${results.join(' | ')}`);
    }
    await this.refreshRuntimeContexts();
    return { patchId, summary: results.join(' | ') };
  }

  async rejectPatch(patchId) {
    const patch = this.store.loadPatch(patchId);
    if (!patch) throw new Error(`Patch not found: ${patchId}`);
    this.store.updatePatch(patchId, currentPatch => {
      currentPatch.status = 'rejected';
      currentPatch.rejectedAt = new Date().toISOString();
      return currentPatch;
    });
    if (patch.chatId) {
      this.store.appendMessage(patch.chatId, {
        role: 'system-msg',
        content: `Patch rejected: ${formatPatchSummary(patch.files, patch.summary || patch.id)}`
      });
    }
    await this.refreshRuntimeContexts();
    return patch;
  }

  getContextMeta(chatId) {
    return this.contextMetaByChat.get(chatId) || null;
  }

  getInstructionStatus(chatId) {
    const activeChatId = chatId || this.store.getActiveChatId();
    const activeChat = activeChatId ? this.store.getChats().find(chat => chat.id === activeChatId) : null;
    const globalInstructions = getGlobalUserInstructions();
    const workspaceInstructions = getWorkspaceUserInstructions();
    const repoInstructions = readWorkspaceAgentsInstructions();
    const chatInstructions = activeChat ? this.store.getChatInstructions(activeChat.id) : '';
    return {
      global: {
        scope: 'global',
        enabled: Boolean(globalInstructions),
        chars: globalInstructions.length,
        preview: summarizeInstructionPreview(globalInstructions),
        text: globalInstructions
      },
      workspace: {
        scope: 'workspace',
        enabled: Boolean(workspaceInstructions),
        chars: workspaceInstructions.length,
        preview: summarizeInstructionPreview(workspaceInstructions),
        text: workspaceInstructions
      },
      repo: {
        scope: 'repo',
        enabled: Boolean(repoInstructions),
        chars: repoInstructions.length,
        preview: summarizeInstructionPreview(repoInstructions),
        text: repoInstructions
      },
      chat: {
        scope: 'chat',
        enabled: Boolean(chatInstructions),
        chars: chatInstructions.length,
        preview: summarizeInstructionPreview(chatInstructions),
        text: chatInstructions,
        chatId: activeChat ? activeChat.id : '',
        title: activeChat ? activeChat.title : ''
      }
    };
  }

  pickRelevantMemory(notes, queryText, limit) {
    const queryTokens = tokenize(queryText);
    return [...notes]
      .map(note => ({ note, score: scoreTokenOverlap(queryTokens, note.content) }))
      .filter(item => item.score > 0)
      .sort((a, b) => b.score - a.score || (b.note.updatedAt || '').localeCompare(a.note.updatedAt || ''))
      .slice(0, limit)
      .map(item => item.note);
  }

  async buildContext(chatId, userText, includeFile, editor, previousMessages) {
    const summary = this.store.getSummary(chatId);
    const memoryScope = getMemoryScope();
    const queryText = normalizeWhitespace(userText);
    const openPaths = editor && editor.document ? [safeRelativeToWorkspace(editor.document.fileName)] : [];
    const globalNotes = memoryScope.includes('global') ? this.pickRelevantMemory(this.store.getMemory('global'), queryText, 4) : [];
    const workspaceNotes = memoryScope.includes('workspace') ? this.pickRelevantMemory(this.store.getMemory('workspace'), queryText, 6) : [];
    const ragResults = await this.rag.search(`${queryText}\n${openPaths.join('\n')}`, openPaths);
    const contextSections = [];
    const workflowHints = inferTaskWorkflowHints(userText);

    if (workflowHints.length) {
      contextSections.push(`[Task workflow hints]\n- ${workflowHints.join('\n- ')}`);
    }

    if (globalNotes.length) {
      contextSections.push(`[Global memory - personal preferences shared across all workspaces]\n- ${globalNotes.map(note => `[${note.updatedAt ? note.updatedAt.slice(0, 10) : ''}] ${note.content}`).join('\n- ')}`);
    }
    if (workspaceNotes.length) {
      contextSections.push(`[Workspace memory - project-specific notes for this workspace]\n- ${workspaceNotes.map(note => `[${note.updatedAt ? note.updatedAt.slice(0, 10) : ''}] ${note.content}`).join('\n- ')}`);
    }
    if (summary && summary.rollingSummary) {
      const lines = [`[Chat summary]\n${summary.rollingSummary}`];
      if (Array.isArray(summary.openTasks) && summary.openTasks.length) lines.push(`Open tasks:\n- ${summary.openTasks.join('\n- ')}`);
      if (Array.isArray(summary.importantFacts) && summary.importantFacts.length) lines.push(`Important facts:\n- ${summary.importantFacts.join('\n- ')}`);
      contextSections.push(lines.join('\n'));
    }
    if (includeFile && editor && cfg('sendFileContext')) {
      const ctx = getEditorContext(editor, editor.selection);
      if (ctx) {
        const selected = ctx.selectedText;
        const fileContent = selected
          ? `Selected code from ${ctx.fileName}:\n\`\`\`${ctx.langId}\n${selected}\n\`\`\``
          : `Current file: ${ctx.fileName}\n\`\`\`${ctx.langId}\n${ctx.fullContent.substring(0, MAX_FILE_CONTEXT_CHARS)}\n\`\`\``;
        contextSections.push(`[Editor context]\n${fileContent}`);
      }
    }
    if (ragResults.snippets.length) {
      let charBudget = 0;
      const blocks = [];
      for (const snippet of ragResults.snippets) {
        const block = `${snippet.path}\n\`\`\`${snippet.language}\n${snippet.preview}\n\`\`\``;
        if (charBudget + block.length > MAX_RAG_SNIPPET_CHARS) break;
        blocks.push(block);
        charBudget += block.length;
      }
      if (blocks.length) contextSections.push(`[Workspace retrieval]\n${blocks.join('\n\n')}`);
    }

    const recentMessages = previousMessages.slice(-getMaxRecentMessages()).map(msg => ({ role: msg.role, content: msg.content }));
    const contextualUserText = contextSections.length
      ? `${userText}\n\n[Relevant context]\n${contextSections.join('\n\n')}`
      : userText;

    const contextMeta = {
      totalMessages: previousMessages.length + 1,
      recentMessages: recentMessages.length,
      summaryAvailable: Boolean(summary && summary.rollingSummary),
      workspaceMemories: workspaceNotes.length,
      globalMemories: globalNotes.length,
      ragSnippets: ragResults.snippets.length,
      ragMode: ragResults.usedSemantic ? 'hybrid' : 'lexical',
      ragError: ragResults.error || ''
    };
    this.contextMetaByChat.set(chatId, contextMeta);

    return {
      messages: [
        { role: 'system', content: getAgentSystemPrompt({ chatId, store: this.store }) },
        ...recentMessages,
        { role: 'user', content: contextualUserText }
      ],
      contextMeta
    };
  }

  async maybeCompactChat(chatId) {
    if (!memoryEnabled() || this.compactingChats.has(chatId)) return;
    const messages = this.store.loadMessages(chatId);
    const summary = this.store.getSummary(chatId);
    const lastCompacted = Number(summary.lastCompactedMessageCount || 0);
    const keepRecent = getMaxRecentMessages();
    const threshold = getCompactionThreshold();
    const targetCount = Math.max(0, messages.length - keepRecent);
    const candidates = messages.slice(lastCompacted, targetCount);
    if (candidates.length < threshold) return;

    this.compactingChats.add(chatId);
    try {
      const transcript = candidates.map(msg => `${msg.role.toUpperCase()}: ${msg.content}`).join('\n\n');
      const priorSummary = summary.rollingSummary || 'No previous summary.';
      let payload = null;

      try {
        const result = await chatWithModel([
          { role: 'system', content: 'You summarize coding conversations into compact JSON memories.' },
          {
            role: 'user',
            content: [
              'Return strict JSON with keys: summary, open_tasks, important_facts, global_notes, workspace_notes.',
              'Keep arrays short and factual. Do not use markdown.',
              `Existing summary:\n${priorSummary}`,
              `New messages:\n${transcript}`
            ].join('\n\n')
          }
        ], null, { stream: false, temperature: 0.1, max_tokens: 1200 });
        payload = extractJsonFromText(result?.choices?.[0]?.message?.content || '');
      } catch (error) {
        console.error(`[localai-code] LLM-based chat summary failed: ${error.message}`);
        payload = null;
      }

      const fallback = {
        summary: summarizeMessagesLocally(candidates),
        open_tasks: [],
        important_facts: [],
        global_notes: [],
        workspace_notes: []
      };
      const finalPayload = payload || fallback;
      this.store.saveSummary(chatId, {
        chatId,
        rollingSummary: truncateText(normalizeWhitespace(finalPayload.summary || fallback.summary), 4000),
        openTasks: Array.isArray(finalPayload.open_tasks) ? finalPayload.open_tasks.map(item => truncateText(normalizeWhitespace(item), 160)).filter(Boolean).slice(0, 8) : [],
        importantFacts: Array.isArray(finalPayload.important_facts) ? finalPayload.important_facts.map(item => truncateText(normalizeWhitespace(item), 180)).filter(Boolean).slice(0, 10) : [],
        lastCompactedMessageCount: targetCount,
        updatedAt: new Date().toISOString()
      });
      this.store.upsertMemoryNotes('workspace', finalPayload.workspace_notes || [], chatId);
      this.store.upsertMemoryNotes('global', finalPayload.global_notes || [], chatId);
    } finally {
      this.compactingChats.delete(chatId);
    }
  }
}

class CloudExecutorClient {
  constructor(runtime, taskManager) {
    this.runtime = runtime;
    this.taskManager = taskManager;
    this.syncTimer = null;
    this.syncInFlight = false;
  }

  isEnabled() {
    return cloudEnabled() && Boolean(getCloudExecutorUrl());
  }

  dispose() {
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
    }
  }

  hasTrackedCloudTasks() {
    return this.runtime.store.getTasks().some(task => task.runtimeKind === 'cloud');
  }

  async initialize() {
    this.restartPolling();
    await this.syncActiveTasks();
  }

  restartPolling() {
    this.dispose();
    if (!(this.isEnabled() || this.hasTrackedCloudTasks())) return;
    this.syncTimer = setInterval(() => {
      this.syncActiveTasks().catch(() => {});
    }, getCloudPollIntervalMs());
  }

  getExecutorUrl(task) {
    return String((task && task.executorUrl) || getCloudExecutorUrl() || '').trim().replace(/\/+$/, '');
  }

  getRequestHeaders() {
    const headers = {};
    const apiKey = getCloudApiKey();
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    return headers;
  }

  async buildWorkspaceSnapshot(rootPath) {
    const workspaceRoot = rootPath || (getWorkspaceFolder() ? getWorkspaceFolder().uri.fsPath : this.runtime.store.workspaceRoot);
    if (!workspaceRoot || !fileExists(workspaceRoot)) {
      return { rootPath: workspaceRoot || '', rootName: '', files: [], fileCount: 0, totalBytes: 0, truncated: false, warnings: [], summary: {} };
    }

    const files = [];
    let totalBytes = 0;
    let truncated = false;
    const warnings = [];
    const summary = {
      directoriesScanned: 0,
      filesIncluded: 0,
      skippedExcluded: 0,
      skippedBinary: 0,
      skippedTooLarge: 0,
      skippedUnreadable: 0,
      skippedNonSnapshot: 0
    };
    const queue = [''];
    const maxFiles = getCloudMaxSnapshotFiles();
    const maxTotalBytes = getCloudMaxSnapshotTotalBytes();
    const maxFileBytes = getCloudMaxSnapshotFileBytes();

    while (queue.length && files.length < maxFiles && !truncated) {
      const relativeDir = queue.shift();
      const absoluteDir = relativeDir ? path.join(workspaceRoot, relativeDir) : workspaceRoot;
      summary.directoriesScanned += 1;
      let dirEntries = [];
      try {
        dirEntries = fs.readdirSync(absoluteDir, { withFileTypes: true });
      } catch (error) {
        summary.skippedUnreadable += 1;
        console.error(`[localai-code] Failed to read cloud snapshot directory ${absoluteDir}: ${error.message}`);
        continue;
      }

      dirEntries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of dirEntries) {
        const relativePath = relativeDir
          ? path.posix.join(relativeDir.replace(/\\/g, '/'), entry.name)
          : entry.name;
        if (isExcludedPath(relativePath)) {
          summary.skippedExcluded += 1;
          continue;
        }
        const absolutePath = path.join(absoluteDir, entry.name);
        if (entry.isDirectory()) {
          queue.push(relativePath);
          continue;
        }
        if (!entry.isFile() || !isCloudSnapshotPath(relativePath)) {
          summary.skippedNonSnapshot += 1;
          continue;
        }

        let stat;
        try {
          stat = fs.statSync(absolutePath);
        } catch (error) {
          summary.skippedUnreadable += 1;
          console.error(`[localai-code] Failed to stat cloud snapshot file ${absolutePath}: ${error.message}`);
          continue;
        }
        if (!stat.isFile()) continue;
        if (stat.size > maxFileBytes) {
          summary.skippedTooLarge += 1;
          continue;
        }

        let buffer;
        try {
          buffer = fs.readFileSync(absolutePath);
        } catch (error) {
          summary.skippedUnreadable += 1;
          console.error(`[localai-code] Failed to read cloud snapshot file ${absolutePath}: ${error.message}`);
          continue;
        }
        if (isLikelyBinary(buffer)) {
          summary.skippedBinary += 1;
          continue;
        }

        const text = buffer.toString('utf8');
        const nextBytes = Buffer.byteLength(text, 'utf8');
        if ((totalBytes + nextBytes) > maxTotalBytes) {
          truncated = true;
          warnings.push(`Stopped at ${files.length} file(s) because snapshot would exceed ${maxTotalBytes} bytes.`);
          break;
        }

        files.push({
          path: relativePath.replace(/\\/g, '/'),
          content: text
        });
        totalBytes += nextBytes;
        summary.filesIncluded += 1;
      }
    }

    if (files.length >= maxFiles && queue.length) {
      truncated = true;
      warnings.push(`Stopped at ${maxFiles} file(s) because the snapshot hit the configured file limit.`);
    }

    return {
      rootPath: workspaceRoot,
      rootName: path.basename(workspaceRoot),
      files,
      fileCount: files.length,
      totalBytes,
      truncated,
      warnings,
      summary
    };
  }

  compressSnapshot(snapshot) {
    const jsonPayload = JSON.stringify({
      rootPath: snapshot.rootPath,
      rootName: snapshot.rootName,
      files: snapshot.files,
      fileCount: snapshot.fileCount,
      totalBytes: snapshot.totalBytes,
      truncated: snapshot.truncated,
      warnings: snapshot.warnings,
      summary: snapshot.summary
    });
    return new Promise((resolve, reject) => {
      zlib.deflate(jsonPayload, (err, buffer) => {
        if (err) return reject(err);
        resolve({
          compressed: buffer.toString('base64'),
          originalBytes: Buffer.byteLength(jsonPayload, 'utf8'),
          compressedBytes: buffer.length,
          compressionRatio: (buffer.length / Buffer.byteLength(jsonPayload, 'utf8')).toFixed(2)
        });
      });
    });
  }

  async createRemoteTask(localTask) {
    const executorUrl = this.getExecutorUrl(localTask);
    if (!executorUrl) throw new Error('Cloud executor URL is not configured.');

    const snapshot = await this.buildWorkspaceSnapshot(localTask.executionRoot);
    if (snapshot.truncated && snapshot.warnings && snapshot.warnings.length > 0) {
      vscode.window.showWarningMessage(
        `Cloud workspace snapshot was truncated: ${snapshot.warnings[0]}. Consider adjusting localai.cloud.maxSnapshotFiles or localai.cloud.maxSnapshotTotalBytes.`
      );
    }
    let useCompressed = false;
    let compressedData = null;
    try {
      compressedData = await this.compressSnapshot(snapshot);
      useCompressed = true;
      console.log(`[localai-code] Cloud snapshot compressed: ${compressedData.originalBytes}B -> ${compressedData.compressedBytes}B (${compressedData.compressionRatio}x)`);
    } catch (err) {
      console.warn(`[localai-code] Cloud snapshot compression failed, sending uncompressed: ${err.message}`);
    }
    const payload = {
      title: localTask.title,
      prompt: localTask.prompt,
      workspaceName: snapshot.rootName || path.basename(localTask.executionRoot || 'workspace'),
      files: snapshot.files,
      snapshotCompressed: useCompressed ? compressedData : undefined,
      messages: rewriteMessagesForRuntime(localTask.messages || [], 'cloud', {
        chatId: localTask.chatId || '',
        store: this.store,
        agentType: localTask.agentType || 'general-purpose'
      }),
      modelId: normalizeModelId(getModelId()),
      temperature: cfg('temperature') ?? 0.2,
      maxTokens: cfg('maxTokens') ?? 4096,
      maxRounds: getAgentMaxRounds(),
      allowShell: agentAllowShell(),
      shellTimeoutMs: getAgentShellTimeoutMs(),
      agentId: localTask.agentId || '',
      agentType: localTask.agentType || 'general-purpose',
      agentName: localTask.agentName || '',
      teamName: localTask.teamName || '',
      mode: localTask.mode || 'default',
      isolation: localTask.isolation || 'sandbox',
      sandbox: {
        enabled: sandboxEnabled(),
        runtimeRequired: sandboxRuntimeRequired(),
        image: getSandboxImage(),
        autoBuildImage: sandboxAutoBuildImage(),
        networkMode: getSandboxNetworkMode(),
        toolTimeoutMs: getSandboxToolTimeoutMs(),
        retainOnFailure: sandboxRetainOnFailure(),
        containerModelBaseUrl: getSandboxContainerModelBaseUrl(),
        containerNativeBaseUrl: getSandboxContainerNativeBaseUrl()
      },
      lmStudio: {
        baseUrl: getBaseUrl(),
        nativeBaseUrl: getNativeBaseUrl()
      }
    };

    const response = await httpJsonRequest(`${executorUrl}/tasks`, {
      method: 'POST',
      headers: this.getRequestHeaders(),
      body: payload,
      timeoutMs: 120000
    });
    const remoteTask = response.data && (response.data.task || response.data);
    if (!remoteTask || !remoteTask.id) {
      throw new Error('Cloud executor returned an invalid task payload.');
    }
    return { remoteTask, snapshot };
  }

  async syncTask(taskOrId) {
    const localTask = typeof taskOrId === 'string'
      ? this.runtime.store.loadTask(taskOrId)
      : taskOrId;
    if (!localTask || localTask.runtimeKind !== 'cloud' || !localTask.remoteTaskId) return localTask;

    const executorUrl = this.getExecutorUrl(localTask);
    if (!executorUrl) throw new Error('Cloud executor URL is missing for this task.');

    const response = await httpJsonRequest(`${executorUrl}/tasks/${encodeURIComponent(localTask.remoteTaskId)}`, {
      method: 'GET',
      headers: this.getRequestHeaders(),
      timeoutMs: 30000
    });
    const remoteTask = response.data && (response.data.task || response.data);
    if (!remoteTask) throw new Error('Cloud executor returned an empty task payload.');

    const updated = this.runtime.store.updateTask(localTask.id, currentTask => {
      currentTask.status = remoteTask.status || currentTask.status;
      currentTask.startedAt = remoteTask.startedAt || currentTask.startedAt || '';
      currentTask.finishedAt = remoteTask.finishedAt || currentTask.finishedAt || '';
      currentTask.rounds = Number(remoteTask.rounds || currentTask.rounds || 0);
      currentTask.messages = cloneMessages(remoteTask.messages || currentTask.messages);
      currentTask.logs = mergeLogEntries(currentTask.logs, remoteTask.logs || []);
      currentTask.resultText = typeof remoteTask.resultText === 'string' ? remoteTask.resultText : (currentTask.resultText || '');
      currentTask.resultPreview = truncateText(
        normalizeWhitespace(remoteTask.resultText || remoteTask.resultPreview || currentTask.resultPreview || ''),
        220
      );
      currentTask.error = typeof remoteTask.error === 'string' ? remoteTask.error : (currentTask.error || '');
      currentTask.remoteTaskId = remoteTask.id || currentTask.remoteTaskId;
      currentTask.executorUrl = executorUrl;
      currentTask.stopRequested = Boolean(remoteTask.stopRequested || currentTask.stopRequested);
      currentTask.sandboxId = remoteTask.sandboxId || currentTask.sandboxId;
      currentTask.sandboxState = remoteTask.sandboxState || currentTask.sandboxState;
      currentTask.checkpointAt = remoteTask.checkpointAt || currentTask.checkpointAt;
      currentTask.resumeCount = Number(remoteTask.resumeCount || currentTask.resumeCount || 0);
      currentTask.patchSummary = remoteTask.patchSummary || currentTask.patchSummary;
      currentTask.containerImage = remoteTask.containerImage || currentTask.containerImage;
      currentTask.awaitingQuestionId = remoteTask.awaitingQuestionId || currentTask.awaitingQuestionId;
      return currentTask;
    });

    if (remoteTask.patch && (!updated.patchId || !this.runtime.store.loadPatch(updated.patchId))) {
      const patch = await this.runtime.persistPatchArtifacts({
        ...remoteTask.patch,
        taskId: localTask.id,
        chatId: localTask.chatId || '',
        source: 'cloud'
      });
      this.runtime.store.updateTask(localTask.id, currentTask => {
        currentTask.patchId = patch.id;
        currentTask.patchSummary = patch.summary || currentTask.patchSummary;
        return currentTask;
      });
    }

    this.runtime.features.syncAgentFromTask(this.runtime.store.loadTask(localTask.id));

    if (updated && !updated.deliveredToChat && ['completed', 'failed', 'stopped'].includes(updated.status)) {
      await this.taskManager.deliverTaskToChat(updated.id);
    }
    if (chatProvider && chatProvider.syncState) await chatProvider.syncState();
    return this.runtime.store.loadTask(localTask.id);
  }

  async syncActiveTasks() {
    if (this.syncInFlight) return;

    const candidates = this.runtime.store.getTasks().filter(task => (
      task.runtimeKind === 'cloud' && (
        ['pending', 'running', 'awaiting_user'].includes(task.status) ||
        (!task.deliveredToChat && ['completed', 'failed', 'stopped'].includes(task.status))
      )
    ));
    if (!candidates.length) return;

    this.syncInFlight = true;
    try {
      for (const task of candidates) {
        try {
          await this.syncTask(task.id);
        } catch (error) {
          console.error(`[localai-code] Failed to sync remote task ${task.id}: ${error.message}`);
        }
      }
    } finally {
      this.syncInFlight = false;
    }
  }

  async stopRemoteTask(taskOrId) {
    const localTask = typeof taskOrId === 'string'
      ? this.runtime.store.loadTask(taskOrId)
      : taskOrId;
    if (!localTask || localTask.runtimeKind !== 'cloud' || !localTask.remoteTaskId) {
      return localTask;
    }

    const executorUrl = this.getExecutorUrl(localTask);
    if (!executorUrl) throw new Error('Cloud executor URL is missing for this task.');

    await httpJsonRequest(`${executorUrl}/tasks/${encodeURIComponent(localTask.remoteTaskId)}/stop`, {
      method: 'POST',
      headers: this.getRequestHeaders(),
      timeoutMs: 30000
    });
    return this.syncTask(localTask.id);
  }

  async sendRemoteMessage(taskId, message, meta = {}) {
    const localTask = this.runtime.store.loadTask(taskId);
    if (!localTask || !localTask.remoteTaskId) throw new Error(`Remote task not found: ${taskId}`);
    const executorUrl = this.getExecutorUrl(localTask);
    await httpJsonRequest(`${executorUrl}/tasks/${encodeURIComponent(localTask.remoteTaskId)}/messages`, {
      method: 'POST',
      headers: this.getRequestHeaders(),
      body: {
        message: String(message || ''),
        senderAgentId: meta.senderAgentId || '',
        agentId: meta.agentId || ''
      },
      timeoutMs: 30000
    });
    return this.syncTask(taskId);
  }

  async resumeRemoteTask(taskId) {
    const localTask = this.runtime.store.loadTask(taskId);
    if (!localTask || !localTask.remoteTaskId) throw new Error(`Remote task not found: ${taskId}`);
    const executorUrl = this.getExecutorUrl(localTask);
    await httpJsonRequest(`${executorUrl}/tasks/${encodeURIComponent(localTask.remoteTaskId)}/resume`, {
      method: 'POST',
      headers: this.getRequestHeaders(),
      timeoutMs: 30000
    });
    return this.syncTask(taskId);
  }
}

async function runLocalAgentTask(taskManager, taskId, runtimeState, liveHooks = {}) {
  const runtime = taskManager.runtime;
  const execContext = {
    runtime,
    runtimeState,
    taskManager,
    taskId,
    chatId: '',
    parentTaskId: taskId,
    rootPath: runtimeState.rootPath
  };
  let task = runtime.store.loadTask(taskId);
  if (!task) throw new Error(`Task not found: ${taskId}`);
  execContext.chatId = task.chatId || '';
  const maxRounds = Math.max(1, Math.min(12, Number(task.maxRounds || getAgentMaxRounds())));
  const executedTools = [];
  const priorToolResults = new Map();

  for (;;) {
    task = runtime.store.loadTask(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    if (runtimeState.stopRequested || task.stopRequested) {
      throw new Error('Task stopped by user.');
    }

    let conversation = cloneMessages(task.messages || []);
    let checkpoint = task.checkpoint || null;
    let round = Number(task.rounds || 0);
    let pendingToolCalls = [];
    let toolResultBlocks = [];
    let nextToolIndex = 0;
    const inboxMessages = task.agentId ? runtime.features.consumeAgentInbox(task.agentId) : [];
    const externalMessages = Array.isArray(task.externalMessages) ? cloneMessages(task.externalMessages) : [];
    if (inboxMessages.length || externalMessages.length) {
      const injectedBlocks = [
        ...inboxMessages.map(item => `[Message from ${item.from || 'runtime'}]\n${item.message}`),
        ...externalMessages.map(item => `[External message]\n${item.content || item.message || ''}`)
      ];
      conversation.push({
        role: 'user',
        content: injectedBlocks.join('\n\n')
      });
      runtime.store.updateTask(taskId, currentTask => {
        currentTask.messages = cloneMessages(conversation);
        currentTask.externalMessages = [];
        return currentTask;
      });
    }

    if (checkpoint && checkpoint.phase === 'executing_tools' && Array.isArray(checkpoint.pendingToolCalls) && checkpoint.pendingToolCalls.length) {
      round = Math.max(1, Number(checkpoint.round || round || 1));
      conversation = cloneMessages(checkpoint.conversation || conversation);
      pendingToolCalls = checkpoint.pendingToolCalls;
      toolResultBlocks = Array.isArray(checkpoint.toolResultBlocks) ? [...checkpoint.toolResultBlocks] : [];
      nextToolIndex = Math.max(0, Number(checkpoint.nextToolIndex || 0));
      if (liveHooks.onRoundStart) liveHooks.onRoundStart(round, maxRounds);
      if (checkpoint.gitRef && (task.status === 'resuming' || task.status === 'interrupted')) {
        const sandboxMeta = await ensureSandboxExecutionContext(execContext);
        await runtime.sandbox.restoreToRef(sandboxMeta, checkpoint.gitRef);
      }
    } else {
      round += 1;
      if (round > maxRounds) {
        throw new Error(`Agent stopped after ${maxRounds} rounds without producing a final answer.`);
      }

      runtime.store.updateTask(taskId, currentTask => {
        currentTask.rounds = round;
        currentTask.checkpointAt = new Date().toISOString();
        currentTask.checkpoint = {
          phase: 'await_model',
          round,
          conversation: cloneMessages(conversation),
          pendingToolCalls: [],
          nextToolIndex: 0,
          toolResultBlocks: [],
          gitRef: currentTask.checkpoint && currentTask.checkpoint.gitRef ? currentTask.checkpoint.gitRef : ''
        };
        return currentTask;
      });
      if (liveHooks.onRoundStart) liveHooks.onRoundStart(round, maxRounds);

      if (liveHooks.onModelRequestStart) liveHooks.onModelRequestStart(round, maxRounds);

      let result;
      try {
        result = await chatWithModel(conversation, null, {
          stream: false,
          temperature: cfg('temperature') ?? 0.2,
          max_tokens: cfg('maxTokens') ?? 4096,
          onRequestCreated: (req) => {
            runtimeState.activeRequest = req;
          }
        });
      } finally {
        runtimeState.activeRequest = null;
      }
      runtime.features.recordUsage({
        chatId: task.chatId || '',
        taskId,
        agentId: task.agentId || '',
        model: task.modelOverride || getModelId(),
        promptTokens: conversation.reduce((total, message) => total + estimateTokens(message.content || ''), 0),
        completionTokens: estimateTokens(extractAssistantTextFromResult(result))
      });
      const assistantText = extractAssistantTextFromResult(result);
      const { toolCalls, cleanedText } = parseAgentToolCalls(assistantText);
      const safeAssistantText = sanitizeAgentVisibleText(assistantText) || assistantText;
      const safeCleanedText = sanitizeAgentVisibleText(cleanedText);

      if (!toolCalls.length) {
        conversation.push({ role: 'assistant', content: safeAssistantText });
        runtime.store.updateTask(taskId, currentTask => {
          currentTask.rounds = round;
          currentTask.messages = cloneMessages(conversation);
          currentTask.checkpointAt = new Date().toISOString();
          currentTask.checkpoint = {
            phase: 'completed',
            round,
            conversation: cloneMessages(conversation),
            pendingToolCalls: [],
            nextToolIndex: 0,
            toolResultBlocks: [],
            gitRef: currentTask.checkpoint && currentTask.checkpoint.gitRef ? currentTask.checkpoint.gitRef : ''
          };
          return currentTask;
        });
        if (liveHooks.onConversationUpdate) liveHooks.onConversationUpdate(cloneMessages(conversation), round);
        return {
          finalText: safeAssistantText,
          conversation,
          executedTools,
          rounds: round
        };
      }

      conversation.push({
        role: 'assistant',
        content: safeCleanedText || `Using ${toolCalls.length} tool(s).`
      });
      runtime.store.updateTask(taskId, currentTask => {
        currentTask.rounds = round;
        currentTask.messages = cloneMessages(conversation);
        currentTask.checkpointAt = new Date().toISOString();
        currentTask.checkpoint = {
          phase: 'executing_tools',
          round,
          conversation: cloneMessages(conversation),
          pendingToolCalls: toolCalls,
          nextToolIndex: 0,
          toolResultBlocks: [],
          gitRef: currentTask.checkpoint && currentTask.checkpoint.gitRef ? currentTask.checkpoint.gitRef : ''
        };
        return currentTask;
      });
      if (liveHooks.onConversationUpdate) liveHooks.onConversationUpdate(cloneMessages(conversation), round);
      const noteForUi = summarizeAssistantNoteForUi(safeCleanedText);
      if (noteForUi && liveHooks.onAssistantNote) liveHooks.onAssistantNote(noteForUi, round);
      pendingToolCalls = toolCalls;
    }

    for (let index = nextToolIndex; index < pendingToolCalls.length; index += 1) {
      const toolCall = pendingToolCalls[index];
      if (runtimeState.stopRequested) throw new Error('Task stopped by user.');
      if (liveHooks.onToolCall) liveHooks.onToolCall(toolCall, round);
      const toolSignature = createToolCallSignature(toolCall);
      let ok = true;
      let resultValue = null;
      if (isDedupeEligibleTool(toolCall.name) && priorToolResults.has(toolSignature)) {
        resultValue = {
          skipped: true,
          duplicate: true,
          message: 'This exact read-only tool call was already executed earlier in the same task. Reuse the previous result or request a narrower follow-up.'
        };
        executedTools.push({ name: toolCall.name, input: toolCall.input, ok: true, skipped: true, duplicate: true });
        toolResultBlocks.push(buildToolResultBlockForModel(toolCall, resultValue, true));
        runtime.store.updateTask(taskId, currentTask => {
          currentTask.checkpointAt = new Date().toISOString();
          currentTask.checkpoint = {
            phase: 'executing_tools',
            round,
            conversation: cloneMessages(conversation),
            pendingToolCalls,
            nextToolIndex: index + 1,
            toolResultBlocks: [...toolResultBlocks],
            gitRef: currentTask.checkpoint && currentTask.checkpoint.gitRef ? currentTask.checkpoint.gitRef : ''
          };
          return currentTask;
        });
        if (liveHooks.onToolResult) liveHooks.onToolResult(toolCall, resultValue, true, round);
        continue;
      }
      try {
        runtime.features.appendEvent('tool.called', { tool: toolCall.name, taskId, agentId: task.agentId || '' });
        resultValue = await executeAgentToolCall(toolCall, execContext);
        executedTools.push({ name: toolCall.name, input: toolCall.input, ok: true });
      } catch (error) {
        ok = false;
        resultValue = error instanceof Error ? error.message : String(error);
        executedTools.push({ name: toolCall.name, input: toolCall.input, ok: false, error: resultValue });
      }
      runtime.features.appendEvent(ok ? 'tool.completed' : 'tool.failed', { tool: toolCall.name, taskId, agentId: task.agentId || '' }, ok ? 'info' : 'audit');

      const compactBlock = ok
        ? buildToolResultBlockForModel(toolCall, resultValue, true)
        : buildToolResultBlockForModel(toolCall, resultValue, false);
      toolResultBlocks.push(compactBlock);
      if (ok && isDedupeEligibleTool(toolCall.name)) {
        priorToolResults.set(toolSignature, compactBlock);
      }
      if (ok && toolMayMutateWorkspace(toolCall.name)) {
        priorToolResults.clear();
      }

      let gitRef = '';
      if (execContext.sandboxMeta) {
        gitRef = await runtime.sandbox.commitCheckpoint(execContext.sandboxMeta, `checkpoint-${taskId}-${round}-${index + 1}`);
      }
      runtime.store.updateTask(taskId, currentTask => {
        currentTask.checkpointAt = new Date().toISOString();
        currentTask.checkpoint = {
          phase: 'executing_tools',
          round,
          conversation: cloneMessages(conversation),
          pendingToolCalls,
          nextToolIndex: index + 1,
          toolResultBlocks: [...toolResultBlocks],
          gitRef
        };
        return currentTask;
      });
      if (liveHooks.onToolResult) liveHooks.onToolResult(toolCall, resultValue, ok, round);

      if (ok && resultValue && resultValue.control === 'await_user') {
        runtime.store.updateTask(taskId, currentTask => {
          currentTask.status = 'awaiting_user';
          currentTask.awaitingQuestionId = resultValue.questionId || '';
          currentTask.messages = cloneMessages(conversation);
          currentTask.checkpoint = {
            phase: 'await_model',
            round,
            conversation: cloneMessages(conversation),
            pendingToolCalls: [],
            nextToolIndex: 0,
            toolResultBlocks: [],
            gitRef: currentTask.checkpoint && currentTask.checkpoint.gitRef ? currentTask.checkpoint.gitRef : ''
          };
          return currentTask;
        });
        runtime.features.syncAgentFromTask(runtime.store.loadTask(taskId));
        return {
          finalText: `Waiting for user input: ${resultValue.question || 'Question pending.'}`,
          conversation,
          executedTools,
          rounds: round,
          awaitingUser: true
        };
      }
    }

    conversation.push(buildToolResultsConversationMessage(round, toolResultBlocks));
    runtime.store.updateTask(taskId, currentTask => {
      currentTask.messages = cloneMessages(conversation);
      currentTask.checkpointAt = new Date().toISOString();
      currentTask.checkpoint = {
        phase: 'await_model',
        round,
        conversation: cloneMessages(conversation),
        pendingToolCalls: [],
        nextToolIndex: 0,
        toolResultBlocks: [],
        gitRef: currentTask.checkpoint && currentTask.checkpoint.gitRef ? currentTask.checkpoint.gitRef : ''
      };
      return currentTask;
    });
    if (liveHooks.onConversationUpdate) liveHooks.onConversationUpdate(cloneMessages(conversation), round);
  }
}

class AgentTaskManager {
  constructor(runtime) {
    this.runtime = runtime;
    this.running = new Map();
    this.cloud = new CloudExecutorClient(runtime, this);
  }

  dispose() {
    this.cloud.dispose();
  }

  async initialize() {
    const staleTasks = this.runtime.store.getTasks().filter(task => ['pending', 'running', 'resuming', 'interrupted'].includes(task.status));
    for (const task of staleTasks) {
      if (task.runtimeKind === 'cloud') {
        if (task.status === 'running') {
          this.runtime.store.appendTaskLog(task.id, 'VS Code restarted. Reattaching to remote task state.');
        }
        continue;
      }

      this.runtime.store.updateTask(task.id, currentTask => {
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
        this.runtime.store.appendTaskLog(task.id, 'VS Code restarted. Resuming task from persisted conversation state and sandbox checkpoint.');
      }
    }

    await this.cloud.initialize();

    const undelivered = this.runtime.store.getTasks().filter(task => (
      !task.deliveredToChat &&
      ['completed', 'failed', 'stopped'].includes(task.status)
    ));
    for (const task of undelivered) {
      await this.deliverTaskToChat(task.id);
    }
    this._schedulePending();
  }

  getTasks() {
    return this.runtime.store.getTasks();
  }

  getTask(taskId) {
    return this.runtime.store.loadTask(taskId);
  }

  getTaskOutput(taskId) {
    const task = this.runtime.store.loadTask(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    return {
      id: task.id,
      status: task.status,
      resultText: task.resultText || '',
      error: task.error || '',
      logs: cloneLogs(task.logs || []),
      messages: cloneMessages(task.messages || []),
      patchId: task.patchId || '',
      patchSummary: task.patchSummary || ''
    };
  }

  async updateTask(taskId, changes = {}) {
    const task = this.runtime.store.updateTask(taskId, currentTask => Object.assign(currentTask, changes || {}));
    if (!task) throw new Error(`Task not found: ${taskId}`);
    if (chatProvider && chatProvider.syncState) await chatProvider.syncState();
    return this.runtime.store.getTaskRecord(taskId);
  }

  async appendTaskMessage(taskId, message, meta = {}) {
    const task = this.runtime.store.loadTask(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    if (task.runtimeKind === 'cloud' && task.remoteTaskId) {
      await this.cloud.sendRemoteMessage(taskId, message, meta);
      return this.runtime.store.loadTask(taskId);
    }
    this.runtime.store.updateTask(taskId, currentTask => {
      currentTask.externalMessages = Array.isArray(currentTask.externalMessages) ? currentTask.externalMessages : [];
      currentTask.externalMessages.push({
        id: createId('extmsg'),
        createdAt: new Date().toISOString(),
        role: 'user',
        content: String(message || ''),
        senderAgentId: meta.senderAgentId || '',
        agentId: meta.agentId || ''
      });
      return currentTask;
    });
    if (chatProvider && chatProvider.syncState) await chatProvider.syncState();
    return this.runtime.store.loadTask(taskId);
  }

  async resumeTask(taskId, options = {}) {
    const task = this.runtime.store.loadTask(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    if (options.message) {
      await this.appendTaskMessage(taskId, String(options.message), {
        agentId: task.agentId || '',
        senderAgentId: ''
      });
    }
    if (task.runtimeKind === 'cloud' && task.remoteTaskId) {
      await this.cloud.resumeRemoteTask(taskId);
      return this.runtime.store.getTaskRecord(taskId);
    }
    this.runtime.store.updateTask(taskId, currentTask => {
      currentTask.status = currentTask.status === 'awaiting_user' ? 'resuming' : 'resuming';
      currentTask.stopRequested = false;
      currentTask.error = '';
      currentTask.finishedAt = '';
      currentTask.awaitingQuestionId = '';
      currentTask.resumeCount = Number(currentTask.resumeCount || 0) + 1;
      return currentTask;
    });
    this._schedulePending();
    if (chatProvider && chatProvider.syncState) await chatProvider.syncState();
    return this.runtime.store.getTaskRecord(taskId);
  }

  async waitForAgents(agentStates, timeoutMs = 1000) {
    const taskIds = agentStates.map(state => state.taskId).filter(Boolean);
    if (!taskIds.length) {
      await new Promise(resolve => setTimeout(resolve, Math.max(100, timeoutMs)));
      return;
    }
    const startedAt = Date.now();
    while ((Date.now() - startedAt) < timeoutMs) {
      let done = true;
      for (const taskId of taskIds) {
        const task = this.runtime.store.loadTask(taskId);
        if (task && !['completed', 'failed', 'stopped'].includes(task.status)) {
          done = false;
          break;
        }
      }
      if (done) return;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }

  prefersCloudRuntime(input = {}) {
    if (input.runtimeKind === 'local') return false;
    if (input.runtimeKind === 'cloud') return true;
    return input.background !== false && cloudEnabled() && Boolean(getCloudExecutorUrl());
  }

  async createTaskFromPreparedMessages(input) {
    const runtimeKind = this.prefersCloudRuntime(input) ? 'cloud' : 'local';
    const executionRoot = input.executionRoot || (getWorkspaceFolder() ? getWorkspaceFolder().uri.fsPath : this.runtime.store.workspaceRoot);
    const preparedMessages = runtimeKind === 'cloud'
      ? rewriteMessagesForRuntime(input.messages || [], 'cloud', {
        chatId: input.chatId || '',
        store: this.runtime.store,
        agentType: input.agentType || 'general-purpose'
      })
      : cloneMessages(input.messages);
    const task = this.runtime.store.createTask({
      title: input.title,
      prompt: input.prompt,
      chatId: input.chatId || '',
      parentTaskId: input.parentTaskId || '',
      background: input.background !== false,
      runtimeKind,
      agentId: input.agentId || '',
      agentType: input.agentType || 'general-purpose',
      agentName: input.agentName || '',
      teamName: input.teamName || '',
      mode: input.mode || 'default',
      isolation: input.isolation || 'sandbox',
      modelOverride: input.modelOverride || '',
      executorUrl: runtimeKind === 'cloud' ? getCloudExecutorUrl() : '',
      executionRoot,
      messages: preparedMessages,
      maxRounds: getAgentMaxRounds(),
      containerImage: runtimeKind === 'local' ? getSandboxImage() : '',
      liveMode: Boolean(input.liveMode)
    });
    if (task.agentId) {
      this.runtime.features.syncAgentFromTask(task);
    }

    this.runtime.store.appendTaskLog(task.id, `Task created: ${task.title}`);
    if (runtimeKind === 'cloud') {
      try {
        this.runtime.store.appendTaskLog(task.id, `Submitting to cloud executor: ${task.executorUrl}`);
        const { remoteTask, snapshot } = await this.cloud.createRemoteTask(task);
        this.runtime.store.updateTask(task.id, currentTask => {
          currentTask.status = remoteTask.status || 'pending';
          currentTask.remoteTaskId = remoteTask.id || currentTask.remoteTaskId;
          currentTask.startedAt = remoteTask.startedAt || currentTask.startedAt || '';
          currentTask.finishedAt = remoteTask.finishedAt || currentTask.finishedAt || '';
          currentTask.rounds = Number(remoteTask.rounds || currentTask.rounds || 0);
          currentTask.messages = cloneMessages(remoteTask.messages || currentTask.messages);
          currentTask.logs = mergeLogEntries(currentTask.logs, remoteTask.logs || []);
          currentTask.resultText = typeof remoteTask.resultText === 'string' ? remoteTask.resultText : (currentTask.resultText || '');
          currentTask.resultPreview = truncateText(
            normalizeWhitespace(remoteTask.resultText || remoteTask.resultPreview || currentTask.resultPreview || ''),
            220
          );
          currentTask.error = typeof remoteTask.error === 'string' ? remoteTask.error : (currentTask.error || '');
          currentTask.sandboxId = remoteTask.sandboxId || currentTask.sandboxId;
          currentTask.sandboxState = remoteTask.sandboxState || currentTask.sandboxState;
          currentTask.checkpointAt = remoteTask.checkpointAt || currentTask.checkpointAt;
          currentTask.resumeCount = Number(remoteTask.resumeCount || currentTask.resumeCount || 0);
          currentTask.patchSummary = remoteTask.patchSummary || currentTask.patchSummary;
          currentTask.containerImage = remoteTask.containerImage || currentTask.containerImage;
          return currentTask;
        });
        this.runtime.store.appendTaskLog(
          task.id,
          `Uploaded ${snapshot.fileCount} files (${Math.max(1, Math.round(snapshot.totalBytes / 1024))} KB${snapshot.truncated ? ', truncated' : ''}).`
        );
        this.runtime.store.appendTaskLog(task.id, `Remote task created: ${remoteTask.id}`);
        if (remoteTask.patch && !task.patchId) {
          const patch = await this.runtime.persistPatchArtifacts({
            ...remoteTask.patch,
            taskId: task.id,
            chatId: task.chatId || ''
          });
          this.runtime.store.updateTask(task.id, currentTask => {
            currentTask.patchId = patch.id;
            currentTask.patchSummary = patch.summary || currentTask.patchSummary;
            return currentTask;
          });
        }
        this.cloud.restartPolling();
        await this.cloud.syncTask(task.id);
      } catch (error) {
        const errorText = error instanceof Error ? error.message : String(error);
        this.runtime.store.updateTask(task.id, currentTask => {
          currentTask.status = 'failed';
          currentTask.finishedAt = new Date().toISOString();
          currentTask.error = errorText;
          return currentTask;
        });
        this.runtime.store.appendTaskLog(task.id, errorText, 'error');
        if (chatProvider && chatProvider.syncState) await chatProvider.syncState();
        throw error;
      }
    } else if (input.background !== false) {
      this._schedulePending();
    }

    if (chatProvider && chatProvider.syncState) await chatProvider.syncState();
    return this.runtime.store.getTaskRecord(task.id);
  }

  async createTaskFromPrompt(input) {
    const runtimeKind = this.prefersCloudRuntime(input) ? 'cloud' : 'local';
    const systemPrompt = getAgentSystemPrompt({
      runtimeKind,
      chatId: input.chatId || '',
      store: this.runtime.store,
      agentType: input.agentType || 'general-purpose'
    });
    const extraSections = Array.isArray(input.systemPromptSections) ? input.systemPromptSections.filter(Boolean) : [];
    const messages = [
      { role: 'system', content: [systemPrompt, ...extraSections].filter(Boolean).join('\n\n') },
      {
        role: 'user',
        content: [
          input.context ? `[Task context]\n${input.context}` : '',
          input.prompt
        ].filter(Boolean).join('\n\n')
      }
    ];

    return this.createTaskFromPreparedMessages({
      title: input.title || buildChatTitleFromMessage(input.prompt),
      prompt: input.prompt,
      executionRoot: input.executionRoot,
      chatId: input.chatId || '',
      parentTaskId: input.parentTaskId || '',
      runtimeKind,
      agentId: input.agentId || '',
      agentType: input.agentType || 'general-purpose',
      agentName: input.agentName || '',
      teamName: input.teamName || '',
      mode: input.mode || 'default',
      isolation: input.isolation || 'sandbox',
      modelOverride: input.modelOverride || '',
      background: input.background !== false,
      messages
    });
  }

  async runForegroundTask(input, liveHooks = {}) {
    const taskRecord = await this.createTaskFromPreparedMessages({
      ...input,
      runtimeKind: 'local',
      background: false,
      liveMode: true
    });
    await this._startTask(taskRecord.id, liveHooks);
    await this.deliverTaskToChat(taskRecord.id);
    const finalTask = this.runtime.store.loadTask(taskRecord.id);
    if (finalTask && finalTask.status === 'failed') {
      throw new Error(finalTask.error || 'Foreground task failed.');
    }
    if (finalTask && finalTask.status === 'stopped') {
      throw new Error('Foreground task stopped.');
    }
    return finalTask;
  }

  async stopTask(taskId) {
    const runningState = this.running.get(taskId);
    const task = this.runtime.store.loadTask(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);

    if (task.runtimeKind === 'cloud') {
      this.runtime.store.updateTask(taskId, currentTask => {
        currentTask.stopRequested = true;
        return currentTask;
      });
      this.runtime.store.appendTaskLog(taskId, 'Stop requested by user.', 'warn');
      if (task.remoteTaskId) {
        try {
          await this.cloud.stopRemoteTask(taskId);
        } catch (error) {
          const errorText = error instanceof Error ? error.message : String(error);
          this.runtime.store.appendTaskLog(taskId, `Cloud stop failed: ${errorText}`, 'error');
          throw error;
        }
      } else {
        this.runtime.store.updateTask(taskId, currentTask => {
          currentTask.status = 'stopped';
          currentTask.finishedAt = new Date().toISOString();
          return currentTask;
        });
      }
      if (chatProvider && chatProvider.syncState) await chatProvider.syncState();
      this.runtime.features.syncAgentFromTask(this.runtime.store.loadTask(taskId));
      return this.runtime.store.getTaskRecord(taskId);
    }

    if (['pending', 'resuming', 'interrupted'].includes(task.status)) {
      this.runtime.store.updateTask(taskId, currentTask => {
        currentTask.status = 'stopped';
        currentTask.stopRequested = true;
        currentTask.finishedAt = new Date().toISOString();
        return currentTask;
      });
      this.runtime.store.appendTaskLog(taskId, 'Task stopped before execution.', 'warn');
      if (chatProvider && chatProvider.syncState) await chatProvider.syncState();
      this.runtime.features.syncAgentFromTask(this.runtime.store.loadTask(taskId));
      return this.runtime.store.getTaskRecord(taskId);
    }

    if (runningState) {
      runningState.stopRequested = true;
      this.runtime.store.updateTask(taskId, currentTask => {
        currentTask.stopRequested = true;
        return currentTask;
      });
      if (runningState.activeRequest && typeof runningState.activeRequest.destroy === 'function') {
        try {
          runningState.activeRequest.destroy(new Error('Request aborted by user.'));
        } catch (error) {
          console.error(`[localai-code] Failed to abort active model request for task ${taskId}: ${error.message}`);
        }
      }
      if (runningState.activeChild && typeof runningState.activeChild.kill === 'function') {
        try { runningState.activeChild.kill(); } catch (error) {
          console.error(`[localai-code] Failed to kill active child process for task ${taskId}: ${error.message}`);
        }
      }
      this.runtime.store.appendTaskLog(taskId, 'Stop requested by user.', 'warn');
    }

    this.runtime.features.syncAgentFromTask(this.runtime.store.loadTask(taskId));
    return this.runtime.store.getTaskRecord(taskId);
  }

  _schedulePending() {
    const capacity = Math.min(getAgentMaxConcurrentTasks(), getSandboxMaxConcurrent());
    const availableSlots = Math.max(0, capacity - this.running.size);
    if (!availableSlots) return;

    const pending = this.runtime.store.getTasks()
      .filter(task => ['pending', 'resuming', 'interrupted'].includes(task.status) && task.runtimeKind !== 'cloud')
      .slice(0, availableSlots);

    for (const task of pending) {
      this._startTask(task.id).catch(() => {});
    }
  }

  async deliverTaskToChat(taskId) {
    const task = this.runtime.store.loadTask(taskId);
    if (!task || !task.chatId) return task;
    if (task.deliveredToChat || task.chatDeliveryState === 'delivering') return task;

    this.runtime.store.updateTask(taskId, currentTask => {
      currentTask.chatDeliveryState = 'delivering';
      return currentTask;
    });

    const foregroundLabel = task.runtimeKind === 'cloud' ? 'Cloud task' : 'Task';
    const backgroundLabel = task.runtimeKind === 'cloud' ? 'Background cloud task' : 'Background task';
    const prefix = task.background === false ? foregroundLabel : backgroundLabel;
    try {
      if (task.status === 'completed') {
        if (task.background !== false) {
          this.runtime.store.appendMessage(task.chatId, {
            role: 'system-msg',
            content: `${prefix} completed: ${task.title}`
          });
        }
        if (task.resultText) {
          this.runtime.store.appendMessage(task.chatId, {
            role: 'assistant',
            content: task.resultText
          });
          await this.runtime.maybeCompactChat(task.chatId);
        }
        if (task.patchId) {
          const patch = this.runtime.store.loadPatch(task.patchId);
          if (patch && patch.status === 'pending') {
            this.runtime.store.appendMessage(task.chatId, {
              role: 'system-msg',
              content: `Patch ready for review: ${formatPatchSummary(patch.files, patch.summary || `${(patch.files || []).length} file change(s)`)}. Accept it to write the files into the workspace.`
            });
          }
        }
      } else if (task.status === 'failed') {
        this.runtime.store.appendMessage(task.chatId, {
          role: 'system-msg',
          content: `${prefix} failed: ${task.title}${task.error ? ` — ${truncateText(task.error, 220)}` : ''}`
        });
      } else if (task.status === 'stopped') {
        this.runtime.store.appendMessage(task.chatId, {
          role: 'system-msg',
          content: `${prefix} stopped: ${task.title}`
        });
      }

      this.runtime.store.updateTask(taskId, currentTask => {
        currentTask.deliveredToChat = true;
        currentTask.chatDeliveryState = '';
        return currentTask;
      });
    } catch (error) {
      this.runtime.store.updateTask(taskId, currentTask => {
        currentTask.chatDeliveryState = '';
        return currentTask;
      });
      throw error;
    }

    if (chatProvider && chatProvider.syncState) await chatProvider.syncState();
    return this.runtime.store.loadTask(taskId);
  }

  async _startTask(taskId, liveHooks = {}) {
    if (this.running.has(taskId)) return;

    const task = this.runtime.store.loadTask(taskId);
    if (!task || !['pending', 'resuming', 'interrupted'].includes(task.status) || task.runtimeKind === 'cloud') return;

    const runtimeState = {
      stopRequested: false,
      activeRequest: null,
      activeChild: null,
      rootPath: task.executionRoot || (getWorkspaceFolder() ? getWorkspaceFolder().uri.fsPath : ''),
      priorStatus: task.status
    };

    this.running.set(taskId, runtimeState);
    this.runtime.store.updateTask(taskId, currentTask => {
      currentTask.status = 'running';
      currentTask.startedAt = currentTask.startedAt || new Date().toISOString();
      currentTask.stopRequested = false;
      currentTask.sandboxState = currentTask.sandboxId ? 'resuming' : 'preparing';
      currentTask.progressSummary = currentTask.sandboxId ? 'Reattaching sandbox' : 'Preparing sandbox';
      return currentTask;
    });
    if (task.agentId) {
      this.runtime.features.syncAgentFromTask(this.runtime.store.loadTask(taskId));
      this.runtime.features.appendEvent('agent.running', { agentId: task.agentId, taskId });
    }
    this.runtime.store.appendTaskLog(taskId, `Task started in ${getWorkspaceRelativeDisplayPath(runtimeState.rootPath || '', runtimeState.rootPath || undefined)}`);
    if (chatProvider && chatProvider.syncState) await chatProvider.syncState();

    try {
      const taskResult = await runLocalAgentTask(this, taskId, runtimeState, {
        onRoundStart: (round, maxRounds) => {
          this.runtime.store.updateTask(taskId, currentTask => {
            currentTask.rounds = round;
            currentTask.progressSummary = `Round ${round}/${maxRounds}`;
            return currentTask;
          });
          this.runtime.store.appendTaskLog(taskId, `Round ${round}/${maxRounds}`);
          if (liveHooks.onRoundStart) liveHooks.onRoundStart(round, maxRounds);
          if (chatProvider && chatProvider.syncState) chatProvider.syncState();
        },
        onModelRequestStart: (round, maxRounds) => {
          const message = round === 1
            ? 'Waiting for the model to plan the first action. Docker stays idle until the first tool call.'
            : `Waiting for the model to continue round ${round}/${maxRounds}.`;
          this.runtime.store.appendTaskLog(taskId, message);
          this.runtime.store.updateTask(taskId, currentTask => {
            currentTask.progressSummary = round === 1
              ? 'Planning first action'
              : `Waiting for model response (round ${round}/${maxRounds})`;
            return currentTask;
          });
          if (liveHooks.onModelRequestStart) liveHooks.onModelRequestStart(round, maxRounds);
          if (chatProvider && chatProvider.syncState) chatProvider.syncState();
        },
        onAssistantNote: (note) => {
          const visibleNote = summarizeAssistantNoteForUi(note);
          if (visibleNote) {
            this.runtime.store.appendTaskLog(taskId, `Assistant note: ${truncateText(visibleNote, 220)}`);
            this.runtime.store.updateTask(taskId, currentTask => {
              currentTask.progressSummary = truncateText(normalizeWhitespace(visibleNote), 180);
              return currentTask;
            });
          }
          if (visibleNote && liveHooks.onAssistantNote) liveHooks.onAssistantNote(visibleNote);
          if (chatProvider && chatProvider.syncState) chatProvider.syncState();
        },
        onConversationUpdate: (conversation) => {
          this.runtime.store.updateTask(taskId, currentTask => {
            currentTask.messages = cloneMessages(conversation);
            return currentTask;
          });
          if (liveHooks.onConversationUpdate) liveHooks.onConversationUpdate(conversation);
        },
        onToolCall: (toolCall) => {
          this.runtime.store.appendTaskLog(taskId, `Tool: ${summarizeToolInput(toolCall.name, toolCall.input)}`);
          this.runtime.store.updateTask(taskId, currentTask => {
            currentTask.progressSummary = `Running ${summarizeToolInput(toolCall.name, toolCall.input)}`;
            return currentTask;
          });
          if (liveHooks.onToolCall) liveHooks.onToolCall(toolCall);
          if (chatProvider && chatProvider.syncState) chatProvider.syncState();
        },
        onToolResult: (toolCall, resultValue, ok) => {
          const label = ok ? 'ok' : 'error';
          const detail = typeof resultValue === 'string'
            ? resultValue
            : JSON.stringify(resultValue, null, 2);
          this.runtime.store.appendTaskLog(taskId, `${toolCall.name}: ${label} ${truncateText(detail, 260)}`, ok ? 'info' : 'error');
          this.runtime.store.updateTask(taskId, currentTask => {
            currentTask.progressSummary = `${toolCall.name}: ${summarizeToolResultForUi(toolCall, resultValue, ok)}`;
            return currentTask;
          });
          if (liveHooks.onToolResult) liveHooks.onToolResult(toolCall, resultValue, ok);
          if (chatProvider && chatProvider.syncState) chatProvider.syncState();
        }
      });

      if (taskResult && taskResult.awaitingUser) {
        this.runtime.features.syncAgentFromTask(this.runtime.store.loadTask(taskId));
        this.runtime.store.appendTaskLog(taskId, 'Task is waiting for user input.', 'warn');
        if (chatProvider && chatProvider.syncState) await chatProvider.syncState();
        return;
      }

      const { actions, cleanedText } = parseAssistantActions(taskResult.finalText || '');
      const taskIntentContext = injectIntentFormatInstructions(
        taskResult.conversation || task.messages || [],
        task.prompt || '',
        task.chatId ? this.runtime.getContextMeta(task.chatId) : null
      );
      const rawFinalText = cleanedText || taskResult.finalText || buildAsyncOrchestrationFallback(taskResult, taskIntentContext);
      const validatedTaskResult = postValidateAssistantResponse(rawFinalText, taskIntentContext);
      const finalText = validatedTaskResult.text;
      let patch = null;
      const latestTask = this.runtime.store.loadTask(taskId);
      if (latestTask && latestTask.sandboxId) {
        const sandboxMeta = this.runtime.sandbox.loadSandbox(latestTask.sandboxId);
        if (sandboxMeta) {
          const patchData = await this.runtime.sandbox.collectPatch(sandboxMeta);
          if (Array.isArray(patchData.files) && patchData.files.length) {
            patch = await this.runtime.persistPatchArtifacts({
              ...patchData,
              taskId,
              chatId: latestTask.chatId || '',
              source: 'sandbox'
            });
          }
        }
      }
      if (!patch && actions.length) {
        patch = await this.runtime.createPatchFromAssistantActions(actions, {
          taskId,
          chatId: task.chatId || '',
          source: 'assistant-actions'
        });
      }
      this.runtime.store.updateTask(taskId, currentTask => {
        currentTask.status = runtimeState.stopRequested ? 'stopped' : 'completed';
        currentTask.finishedAt = new Date().toISOString();
        currentTask.messages = cloneMessages(taskResult.conversation || currentTask.messages);
        currentTask.resultText = finalText;
        currentTask.resultPreview = truncateText(normalizeWhitespace(finalText), 220);
        currentTask.responseIntent = taskIntentContext.intent || '';
        currentTask.strictAuditMode = Boolean(taskIntentContext.strictAuditMode);
        currentTask.availableEvidenceSummary = taskIntentContext.evidenceSummary || '';
        currentTask.postValidationStatus = validatedTaskResult.validation.status;
        currentTask.postValidationIssues = Array.isArray(validatedTaskResult.validation.issues) ? validatedTaskResult.validation.issues : [];
        currentTask.error = '';
        currentTask.checkpointAt = new Date().toISOString();
        currentTask.checkpoint = {
          phase: 'completed',
          round: currentTask.rounds,
          conversation: cloneMessages(taskResult.conversation || currentTask.messages),
          pendingToolCalls: [],
          nextToolIndex: 0,
          toolResultBlocks: [],
          gitRef: currentTask.checkpoint && currentTask.checkpoint.gitRef ? currentTask.checkpoint.gitRef : ''
        };
        currentTask.patchId = patch ? patch.id : currentTask.patchId;
        currentTask.patchSummary = patch ? patch.summary : currentTask.patchSummary;
        currentTask.sandboxState = currentTask.sandboxId ? 'completed' : currentTask.sandboxState;
        return currentTask;
      });
      this.runtime.features.syncAgentFromTask(this.runtime.store.loadTask(taskId));
      if (task.agentId) {
        this.runtime.features.appendEvent(runtimeState.stopRequested ? 'agent.stopped' : 'agent.completed', { agentId: task.agentId, taskId }, runtimeState.stopRequested ? 'audit' : 'info');
      }
      this.runtime.store.appendTaskLog(taskId, runtimeState.stopRequested ? 'Task stopped.' : 'Task completed.');
      if (patch) {
        this.runtime.store.appendTaskLog(taskId, `Patch ready: ${patch.summary}`);
        if (liveHooks.onPatchReady) liveHooks.onPatchReady(patch);
      }

      if (!runtimeState.stopRequested) await this.deliverTaskToChat(taskId);
    } catch (error) {
      const errorText = error instanceof Error ? error.message : String(error);
      this.runtime.store.updateTask(taskId, currentTask => {
        currentTask.status = runtimeState.stopRequested ? 'stopped' : 'failed';
        currentTask.finishedAt = new Date().toISOString();
        currentTask.error = errorText;
        currentTask.sandboxState = currentTask.sandboxId ? (runtimeState.priorStatus === 'interrupted' ? 'interrupted' : 'failed') : currentTask.sandboxState;
        return currentTask;
      });
      this.runtime.features.syncAgentFromTask(this.runtime.store.loadTask(taskId));
      if (task.agentId) {
        this.runtime.features.appendEvent(runtimeState.stopRequested ? 'agent.stopped' : 'agent.failed', { agentId: task.agentId, taskId }, 'audit');
      }
      this.runtime.store.appendTaskLog(taskId, errorText, 'error');
      await this.deliverTaskToChat(taskId);
    } finally {
      this.running.delete(taskId);
      if (chatProvider && chatProvider.syncState) await chatProvider.syncState();
      this._schedulePending();
    }
  }
}

function setConnectionState(connected, detail = '') {
  isConnected = connected;
  lastConnectionError = connected ? '' : detail;
  updateStatus();
}

function formatApiError(statusCode, errorData, modelId) {
  let message = '';
  try {
    const parsed = JSON.parse(errorData);
    message = extractErrorMessage(parsed.error || parsed.message || parsed.detail || parsed) || errorData;
  } catch (error) {
    console.error(`[localai-code] Failed to parse API error payload: ${error.message}`);
    message = extractErrorMessage(errorData) || errorData;
  }

  message = String(message || '').trim();

  if (statusCode === 404) {
    return `LM Studio could not find the requested endpoint or model "${modelId}".`;
  }

  if (statusCode === 400) {
    return `LM Studio rejected model "${modelId}": ${message || 'Bad request'}`;
  }

  if (statusCode === 503) {
    return message || 'LM Studio is reachable, but no compatible model is loaded.';
  }

  return `API Error (${statusCode}): ${message || 'Unknown error'}`;
}

function httpJsonRequest(urlString, options = {}) {
  return new Promise((resolve, reject) => {
    const targetUrl = new URL(urlString);
    const transport = targetUrl.protocol === 'http:' ? http : https;
    const bodyText = options.body === undefined || options.body === null
      ? ''
      : (typeof options.body === 'string' ? options.body : JSON.stringify(options.body));
    const headers = {
      'Accept': 'application/json',
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
      res.on('data', chunk => raw += chunk.toString());
      res.on('end', () => {
        const contentType = String(res.headers['content-type'] || '').toLowerCase();
        let data = null;
        if (raw && contentType.includes('application/json')) {
          try {
            data = JSON.parse(raw);
          } catch (error) {
            console.error(`[localai-code] Failed to parse JSON HTTP response from ${urlString}: ${error.message}`);
            data = null;
          }
        }
        if ((res.statusCode || 500) >= 400) {
          const detail = extractErrorMessage(data?.error || data?.message || data?.detail || raw) || `HTTP ${res.statusCode || 500}`;
          reject(new Error(detail));
          return;
        }
        resolve({
          statusCode: res.statusCode || 200,
          headers: res.headers,
          raw,
          data
        });
      });
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

async function apiRequest(endpoint, body, onChunk, requestOptions = {}) {
  const modelId = await resolveChatModelId(body.model || getModelId());
  const url = new URL(`${getBaseUrl()}${endpoint || '/chat/completions'}`);
  const transport = url.protocol === 'http:' ? http : https;
  const requestBody = {
    ...body,
    model: modelId
  };

  return new Promise((resolve, reject) => {
    let settled = false;
    const payload = JSON.stringify(requestBody);
    const requestTimeoutMs = Number(requestOptions.timeoutMs || 120000) || 120000;
    const finishResolve = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const finishReject = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    const options = {
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || (url.protocol === 'http:' ? 80 : 443),
      path: `${url.pathname}${url.search}`,
      method: 'POST',
      headers: {
        'Accept': requestBody.stream ? 'text/event-stream' : 'application/json',
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      },
      timeout: requestTimeoutMs
    };

    const req = transport.request(options, (res) => {
      if (res.statusCode !== 200) {
        let errorData = '';
        res.on('data', c => errorData += c.toString());
        res.on('end', () => {
          const message = formatApiError(res.statusCode, errorData, modelId);
          setConnectionState(false, message);
          finishReject(new Error(message));
        });
        return;
      }

      setConnectionState(true);

      let fullText = '';
      let sseBuffer = '';
      const processSseEvent = (eventBlock) => {
        const dataPayload = String(eventBlock || '')
          .split('\n')
          .filter(line => line.startsWith('data:'))
          .map(line => line.slice(5).trimStart())
          .join('\n')
          .trim();

        if (!dataPayload || dataPayload === '[DONE]') return;

        try {
          const json = JSON.parse(dataPayload);
          const delta = extractStreamDeltaText(json);
          if (delta) {
            onChunk(delta);
            fullText += delta;
          }
        } catch (error) {
          console.error(`[localai-code] Failed to parse SSE chunk from LM Studio: ${error.message}`);
        }
      };

      res.on('data', (chunk) => {
        const raw = chunk.toString();
        if (onChunk && requestBody.stream) {
          // SSE frames can be split across TCP chunks, so keep a rolling buffer.
          sseBuffer = `${sseBuffer}${raw}`.replace(/\r\n/g, '\n');
          const events = sseBuffer.split('\n\n');
          sseBuffer = events.pop() || '';
          for (const eventBlock of events) {
            processSseEvent(eventBlock);
          }
        } else {
          fullText += raw;
        }
      });
      res.on('end', () => {
        if (onChunk && requestBody.stream) {
          if (sseBuffer.trim()) processSseEvent(sseBuffer);
          finishResolve(fullText);
          return;
        }
        try { finishResolve(JSON.parse(fullText)); } catch (e) { finishReject(e); }
      });
    });

    if (typeof requestOptions.onRequestCreated === 'function') {
      requestOptions.onRequestCreated(req);
    }
    req.on('error', (error) => {
      const message = formatLmStudioConnectionError(error instanceof Error ? error.message : String(error));
      setConnectionState(false, message);
      finishReject(new Error(message));
    });
    req.on('timeout', () => {
      const message = `LM Studio request timed out after ${requestTimeoutMs}ms at ${getBaseUrl()}.`;
      setConnectionState(false, message);
      req.destroy(new Error(message));
      finishReject(new Error(message));
    });
    req.write(payload);
    req.end();
  });
}

async function featureExtractionRequest(inputs) {
  const modelId = await resolveEmbeddingModelId();
  const inputList = Array.isArray(inputs) ? inputs : [inputs];
  let response;
  try {
    response = await httpJsonRequest(`${getBaseUrl()}/embeddings`, {
      method: 'POST',
      body: {
        model: modelId,
        input: inputList
      },
      timeoutMs: 120000
    });
  } catch (error) {
    const message = formatLmStudioConnectionError(error instanceof Error ? error.message : String(error));
    setConnectionState(false, message);
    throw new Error(message);
  }
  const vectors = Array.isArray(response.data?.data)
    ? response.data.data.map(entry => Array.isArray(entry.embedding) ? entry.embedding : [])
    : [];
  return Array.isArray(inputs) ? vectors : (vectors[0] || []);
}

function formatLmStudioConnectionError(detail) {
  const message = normalizeWhitespace(detail) || 'Unknown connection error.';
  return `Unable to reach LM Studio at ${getBaseUrl()}: ${message}`;
}

async function checkConnection() {
  try {
    const availableModels = await fetchAvailableModels();
    if (!availableModels.length) {
      setConnectionState(false, `LM Studio is reachable at ${getBaseUrl()}, but no model is loaded.`);
      return false;
    }

    const selectedModel = normalizeModelId(getModelId());
    if (selectedModel === 'auto') {
      const chatModels = availableModels.filter(id => !isLikelyEmbeddingModelId(id));
      if (!chatModels.length) {
        setConnectionState(false, `LM Studio is reachable at ${getBaseUrl()}, but no chat-capable model is loaded.`);
        return false;
      }
    }
    if (selectedModel && selectedModel !== 'auto') {
      const baseModel = getBaseModelId(selectedModel);
      const modelAvailable = availableModels.some(id => {
        const candidate = String(id || '');
        return candidate === selectedModel || candidate === baseModel || candidate.startsWith(`${baseModel}:`);
      });
      if (!modelAvailable) {
        setConnectionState(false, `Model "${selectedModel}" is not loaded in LM Studio. Try "${FALLBACK_MODEL_ID}" or set localai.modelId to "auto".`);
        return false;
      }
    }

    setConnectionState(true);
    return true;
  } catch (error) {
    setConnectionState(false, formatLmStudioConnectionError(error instanceof Error ? error.message : String(error)));
    return false;
  }
}

async function ensureChatBackendReady() {
  const connected = await checkConnection();
  if (connected) return true;
  throw new Error(`${lastConnectionError || formatLmStudioConnectionError('The local server did not answer.')} Start the LM Studio local server, load a chat model, or update localai.baseUrl/localai.modelId.`);
}

function updateStatus() {
  if (!statusBarItem) return;
  const modelId = normalizeModelId(getModelId());
  if (isConnected) {
    const label = modelId === 'auto' ? 'auto' : modelId.split('/').pop();
    statusBarItem.text = `$(sparkle) LocalAI: ${label}`;
    statusBarItem.tooltip = `LM Studio connected — Model: ${modelId}\nClick to change model`;
    statusBarItem.color = '#4ec9b0';
  } else {
    statusBarItem.text = '$(error) LocalAI: Disconnected';
    statusBarItem.tooltip = lastConnectionError
      ? `${lastConnectionError}\nClick to configure LM Studio URL or model`
      : 'Click to configure LM Studio URL or model';
    statusBarItem.color = '#f44747';
  }
}

// ── Chat with LM Studio ───────────────────────────────────────────────────────
async function chatWithModel(messages, onChunk, options = {}) {
  return apiRequest('', {
    messages,
    temperature: options.temperature !== undefined ? options.temperature : (cfg('temperature') ?? 0.2),
    max_tokens: options.max_tokens !== undefined ? options.max_tokens : (cfg('maxTokens') ?? 4096),
    stream: options.stream !== undefined ? options.stream : true
  }, onChunk, options);
}

function isUserAbortError(error) {
  const message = error instanceof Error ? error.message : String(error || '');
  return /aborted by user/i.test(message) || /request aborted/i.test(message);
}

// ── Code Context ──────────────────────────────────────────────────────────────
function getEditorContext(editor, selection) {
  if (!editor) return null;
  const doc = editor.document;
  const langId = doc.languageId;
  const fileName = path.basename(doc.fileName);
  const fullContent = doc.getText();
  const selectedText = selection && !selection.isEmpty ? doc.getText(selection) : null;
  const lineCount = doc.lineCount;
  const cursorLine = editor.selection.active.line;

  return { langId, fileName, fullContent, selectedText, lineCount, cursorLine };
}

// ── Inline Completion Provider ────────────────────────────────────────────────
class LocalAIInlineCompletionProvider {
  async provideInlineCompletionItems(document, position, context, token) {
    if (!cfg('enableInlineCompletions')) return [];
    if (!isConnected) return [];

    const debounceMs = cfg('completionDebounceMs') ?? 1000;
    await new Promise(r => { debounceTimer = setTimeout(r, debounceMs); });
    if (token.isCancellationRequested) return [];

    const contextLines = cfg('contextLines') ?? 80;
    const startLine = Math.max(0, position.line - contextLines);
    const endLine = Math.min(document.lineCount - 1, position.line + 20);
    const prefix = document.getText(new vscode.Range(startLine, 0, position.line, position.character));
    const suffix = document.getText(new vscode.Range(position.line, position.character, endLine, document.lineAt(endLine).range.end.character));
    const fileName = path.basename(document.fileName);
    const langId = document.languageId;

    if (prefix.trim().length < 3) return [];

    try {
      const result = await apiRequest('', {
        messages: [
          { role: 'system', content: 'You are a code completion engine. Complete the code at the cursor position. Output ONLY the completion text, no explanations, no markdown, no backticks. Output just the code that should follow the cursor.' },
          { role: 'user', content: `File: ${fileName} (${langId})\n\nCode before cursor:\n${prefix}\n\n[CURSOR]\n\nCode after cursor:\n${suffix}\n\nComplete the code at [CURSOR]. Output only the completion:` }
        ],
        temperature: 0.1,
        max_tokens: 128,
        stream: false
      }, null);

      if (token.isCancellationRequested) return [];
      const completion = result?.choices?.[0]?.message?.content;
      if (!completion) return [];

      return [{
        insertText: completion,
        range: new vscode.Range(position, position),
        command: { command: 'editor.action.inlineSuggest.commit', title: 'Accept' }
      }];
    } catch (error) {
      console.error(`[localai-code] Inline completion failed: ${error.message}`);
      return [];
    }
  }
}

// ── Chat WebView Panel Provider ───────────────────────────────────────────────
class LocalAIChatViewProvider {
  constructor(context) {
    this._context = context;
    this._view = null;
    this._streaming = false;
    this._abortActiveStream = null;
    this._activeForegroundTaskId = '';
    this._responseMetaByChatId = new Map();
  }

  async syncState() {
    if (!this._view || !appRuntime) return;
    await appRuntime.initialize();
    const snapshot = appRuntime.store.getUiSnapshot();
    const activeChatId = snapshot.activeChatId;
    const contextMeta = activeChatId ? appRuntime.getContextMeta(activeChatId) : null;
    const sandboxStatus = await appRuntime.getSandboxStatus();
    const featureSnapshot = appRuntime.features.getSnapshot();
    this._post({
      type: 'state',
      chats: snapshot.chats,
      activeChatId,
      messages: snapshot.messages,
      summary: snapshot.summary,
      parentChat: snapshot.parentChat,
      childChats: snapshot.childChats,
      tasks: snapshot.tasks,
      patches: snapshot.patches,
      contextMeta,
      ragStatus: appRuntime.rag.getStatus(),
      sandboxStatus,
      featureSnapshot,
      memoryStatus: {
        enabled: memoryEnabled(),
        scope: getMemoryScope(),
        scopeExplanation: getMemoryScopeExplanation(),
        workspaceMemoryCount: snapshot.workspaceMemoryCount,
        globalMemoryCount: snapshot.globalMemoryCount
      },
      instructionStatus: appRuntime.getInstructionStatus(activeChatId),
      responseMeta: activeChatId ? this._getResponseMeta(activeChatId) : null,
      connected: isConnected,
      model: getModelId(),
      baseUrl: getBaseUrl(),
      detail: lastConnectionError
    });
  }

  resolveWebviewView(webviewView) {
    this._view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this._context.extensionUri, 'media')]
    };
    webviewView.webview.html = this._getHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(async (msg) => {
      try {
        await appRuntime.initialize();
        switch (msg.type) {
        case 'ready':
          await this._onReady();
          break;
        case 'send':
          await this._handleSend(msg.text, msg.includeFile, Boolean(msg.background));
          break;
        case 'newChat':
          appRuntime.store.createChat('New Chat');
          await this.syncState();
          break;
        case 'forkChat':
          appRuntime.store.forkChat(msg.chatId || appRuntime.store.getActiveChatId(), msg.title || '');
          await this.syncState();
          break;
        case 'selectChat':
          appRuntime.store.selectChat(msg.chatId);
          await this.syncState();
          break;
        case 'selectFork': {
          const targetChatId = msg.chatId || '';
          if (targetChatId) {
            appRuntime.store.selectChat(targetChatId);
            await this.syncState();
          }
          break;
        }
        case 'renameChat': {
          const current = appRuntime.store.getChats().find(chat => chat.id === msg.chatId);
          const title = await vscode.window.showInputBox({
            prompt: 'Rename chat',
            value: current ? current.title : '',
            validateInput: value => normalizeWhitespace(value) ? null : 'Title is required'
          });
          if (title) {
            appRuntime.store.renameChat(msg.chatId, title);
            await this.syncState();
          }
          break;
        }
        case 'deleteChat': {
          const choice = await vscode.window.showWarningMessage('Delete this chat permanently?', { modal: true }, 'Delete');
          if (choice === 'Delete') {
            appRuntime.store.deleteChat(msg.chatId);
            await this.syncState();
          }
          break;
        }
        case 'togglePin':
          appRuntime.store.togglePin(msg.chatId);
          await this.syncState();
          break;
        case 'stopTask':
          await appRuntime.tasks.stopTask(msg.taskId);
          await this.syncState();
          break;
        case 'replyToTask': {
          const task = appRuntime.store.loadTask(msg.taskId);
          if (task && task.status === 'awaiting_user') {
            await appRuntime.tasks.resumeTask(msg.taskId, { message: 'User replied to resume.' });
            await this.syncState();
          }
          break;
        }
        case 'stopResponse':
          await this._stopActiveConversation();
          break;
        case 'interruptSend':
          await this._stopActiveConversation(false);
          await this._handleSend(msg.text, msg.includeFile, Boolean(msg.background));
          break;
        case 'acceptPatch':
          await appRuntime.applyPatch(msg.patchId);
          await this.syncState();
          break;
        case 'rejectPatch':
          await appRuntime.rejectPatch(msg.patchId);
          await this.syncState();
          break;
        case 'reviewPatch':
          await appRuntime.reviewPatch(msg.patchId, msg.filePath);
          break;
        case 'saveInstructions': {
          const scope = String(msg.scope || '').trim();
          const text = normalizeInstructionText(msg.text);
          if (scope === 'global') {
            await vscode.workspace.getConfiguration('localai').update('instructions.global', text, vscode.ConfigurationTarget.Global);
          } else if (scope === 'workspace') {
            if (!getWorkspaceFolder()) {
              vscode.window.showErrorMessage('Workspace instructions require an open workspace.');
              break;
            }
            await vscode.workspace.getConfiguration('localai').update('instructions.workspace', text, vscode.ConfigurationTarget.Workspace);
          } else if (scope === 'chat') {
            const targetChatId = msg.chatId || appRuntime.store.getActiveChatId();
            appRuntime.store.setChatInstructions(targetChatId, text);
          }
          await this.syncState();
          break;
        }
        case 'selectModel': await this._selectModel(); break;
        case 'checkConnection': await this._doCheckConnection(); break;
        case 'applyCode': await this._applyCode(msg.code, msg.language); break;
        case 'copyCode': vscode.env.clipboard.writeText(msg.code); vscode.window.showInformationMessage('Code copied!'); break;
        case 'createFile': await this._createFile(msg.code, msg.language); break;
        case 'saveBaseUrl':
          await vscode.workspace.getConfiguration('localai').update('baseUrl', String(msg.baseUrl || '').trim() || DEFAULT_BASE_URL, vscode.ConfigurationTarget.Global);
          await this._doCheckConnection();
          break;
        case 'saveModel': {
          const modelId = normalizeModelId(msg.model);
          await vscode.workspace.getConfiguration('localai').update('modelId', modelId, vscode.ConfigurationTarget.Global);
          await this._doCheckConnection();
          break;
        }
        }
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        this._post({ type: 'error', text });
        vscode.window.showErrorMessage(text);
        await this.syncState();
      }
    });
  }

  _post(msg) {
    if (this._view) this._view.webview.postMessage(msg);
  }

  _setResponseMeta(chatId, meta) {
    if (!chatId) return;
    if (!meta) {
      this._responseMetaByChatId.delete(chatId);
      return;
    }
    this._responseMetaByChatId.set(chatId, { ...meta });
  }

  _getResponseMeta(chatId) {
    return chatId ? (this._responseMetaByChatId.get(chatId) || null) : null;
  }

  _logAuditDecision(chatId, meta) {
    if (!meta) return;
    console.info('[localai-code] intent=' + (meta.intent || 'general') + ' strict=' + (meta.strictAuditMode ? 'on' : 'off') + ' validation=' + (meta.postValidationStatus || 'pending') + ' chat=' + (chatId || 'none'));
  }

  _finalizeAssistantResponse(chatId, assistantText, intentContext = {}, extras = {}) {
    const finalized = postValidateAssistantResponse(assistantText, intentContext);
    const meta = buildResponseMeta(intentContext, finalized.validation, extras);
    this._setResponseMeta(chatId, meta);
    this._logAuditDecision(chatId, meta);
    return {
      text: finalized.text,
      validation: finalized.validation,
      meta
    };
  }

  async _onReady() {
    await appRuntime.initialize();
    await checkConnection();
    await this.syncState();
  }

  async _doCheckConnection() {
    this._post({ type: 'checking' });
    const connected = await checkConnection();
    await this.syncState();
    if (connected) {
      vscode.window.showInformationMessage('Successfully connected to LM Studio.');
    } else {
      vscode.window.showErrorMessage(lastConnectionError || 'Connection failed. Check the LM Studio server URL and load a model.');
    }
  }

  async _selectModel() {
    const loadedModels = await fetchAvailableModels().catch(() => []);

    const pick = await vscode.window.showQuickPick(
      [
        { label: 'auto', detail: 'Use the first loaded LM Studio chat model' },
        ...loadedModels.map(m => ({ label: m, detail: 'Currently loaded in LM Studio' })),
        { label: 'Enter custom Model ID...', detail: 'Use a specific model identifier even if it is not currently detected.' }
      ],
      { placeHolder: 'Select or enter a model ID', title: 'LocalAI: Select Model' }
    );

    if (pick) {
      let finalModel = pick.label;
      if (pick.label === 'Enter custom Model ID...') {
        finalModel = await vscode.window.showInputBox({ 
          prompt: 'Enter an LM Studio chat model ID, or use "auto" to select the first loaded chat model.',
          placeHolder: 'e.g. qwen2.5-coder-32b-instruct or auto',
          value: normalizeModelId(getModelId())
        });
      }
      
      if (finalModel) {
        finalModel = normalizeModelId(finalModel);
        await vscode.workspace.getConfiguration('localai').update('modelId', finalModel, vscode.ConfigurationTarget.Global);
        this._post({ type: 'checking' });
        await this._doCheckConnection();
      }
    }
  }

  async _runDirectChatFallback(activeChat, messages, reasonText = '', options = {}) {
    const responseContext = options.intentContext || { intent: '', strictAuditMode: false, evidenceSummary: '' };
    const directMessages = rewriteMessagesForRuntime(messages, options.runtimeKind || 'local', {
      chatId: activeChat.id,
      store: appRuntime.store,
      enableTools: false
    });
    if (reasonText) {
      this._post({ type: 'systemMsg', text: reasonText });
    }

    if (options.showThinking !== false) {
      this._post({ type: 'thinking' });
    }
    this._streaming = true;
    try {
      let assistantText = '';
      await chatWithModel(directMessages, (chunk) => {
        assistantText += chunk;
        this._post({ type: 'chunk', text: chunk });
      }, {
        onRequestCreated: (req) => {
          this._abortActiveStream = () => req.destroy(new Error('Request aborted by user.'));
        }
      });
      const { actions, cleanedText } = parseAssistantActions(assistantText);
      const rawFinalText = cleanedText || (actions.length ? 'Prepared workspace changes.' : assistantText);
      const finalized = this._finalizeAssistantResponse(activeChat.id, rawFinalText, responseContext, {
        source: 'direct-chat',
        runtimeKind: options.runtimeKind || 'local'
      });
      const finalText = finalized.text;
      let patch = null;
      if (actions.length) {
        patch = await appRuntime.createPatchFromAssistantActions(actions, {
          chatId: activeChat.id,
          source: 'assistant-actions'
        });
      }
      appRuntime.store.appendMessage(activeChat.id, { role: 'assistant', content: finalText });
      this._post({ type: 'done', text: finalText });
      if (patch) this._post({ type: 'systemMsg', text: `Patch ready: ${formatPatchSummary(patch.files, patch.summary)}. Accept it to write the files into the workspace.` });
      await appRuntime.maybeCompactChat(activeChat.id);
      await this.syncState();
    } catch (err) {
      if (isUserAbortError(err)) {
        this._post({ type: 'systemMsg', text: 'Response stopped.' });
        await this.syncState();
        return;
      }
      this._post({ type: 'status', connected: isConnected, model: getModelId(), detail: lastConnectionError });
      this._post({ type: 'error', text: err.message });
      await this.syncState();
    } finally {
      this._abortActiveStream = null;
      this._streaming = false;
    }
  }

  async _stopActiveConversation(notify = true) {
    const stopStream = this._abortActiveStream;
    const taskId = this._activeForegroundTaskId;
    this._abortActiveStream = null;
    this._activeForegroundTaskId = '';
    this._streaming = false;

    if (stopStream) {
      stopStream();
    }
    if (taskId) {
      await appRuntime.tasks.stopTask(taskId);
    }
    if (notify) {
      this._post({ type: 'systemMsg', text: 'Response stopped.' });
      await this.syncState();
    }
  }

  async _handleSend(userText, includeFile, background = false) {
    const text = normalizeWhitespace(userText);
    if (!text || this._streaming) return;

    await appRuntime.initialize();
    const activeChat = appRuntime.store.ensureActiveChat();
    const pendingQuestion = appRuntime.features.getPendingQuestionForChat(activeChat.id);
    if (pendingQuestion && pendingQuestion.taskId) {
      appRuntime.features.resolveQuestion(pendingQuestion.id, userText);
      appRuntime.store.appendMessage(activeChat.id, { role: 'user', content: userText });
      await appRuntime.tasks.resumeTask(pendingQuestion.taskId, { message: userText });
      appRuntime.store.appendMessage(activeChat.id, {
        role: 'system-msg',
        content: `Resumed task after user answer: ${pendingQuestion.question}`
      });
      await this.syncState();
      return;
    }
    const previousMessages = appRuntime.store.loadMessages(activeChat.id);
    appRuntime.store.appendMessage(activeChat.id, { role: 'user', content: userText });

    this._post({ type: 'userMsg', text: userText });
    try {
      await ensureChatBackendReady();
    } catch (err) {
      this._post({ type: 'status', connected: isConnected, model: getModelId(), baseUrl: getBaseUrl(), detail: lastConnectionError });
      this._post({ type: 'error', text: err instanceof Error ? err.message : String(err) });
      await this.syncState();
      return;
    }
    this._post({ type: 'systemMsg', text: 'Building context from memory, workspace retrieval, and editor state.' });

    let messages;
    try {
      const editor = vscode.window.activeTextEditor;
      ({ messages } = await appRuntime.buildContext(activeChat.id, userText, includeFile, editor, previousMessages));
    } catch (err) {
      this._post({ type: 'status', connected: isConnected, model: getModelId(), detail: lastConnectionError });
      this._post({ type: 'error', text: `Context build failed: ${err.message}` });
      await this.syncState();
      return;
    }
    const contextMetaForIntent = appRuntime.getContextMeta(activeChat.id);
    const intentContext = injectIntentFormatInstructions(messages, userText, contextMetaForIntent);
    messages = intentContext.messages;
    this._setResponseMeta(activeChat.id, buildResponseMeta(intentContext, { status: 'pending', issues: [] }, {
      source: background ? 'background' : 'foreground',
      phase: 'preparing'
    }));
    this._logAuditDecision(activeChat.id, this._getResponseMeta(activeChat.id));
    await this.syncState();

    if (background) {
      if (!agentEnabled()) {
        this._post({ type: 'error', text: 'Background mode requires autonomous agent mode to be enabled.' });
        return;
      }
      this._post({ type: 'systemMsg', text: 'Preparing tools and queueing a background task.' });
      try {
        const sandboxStatus = await appRuntime.ensureSandboxReady();
        if (shouldBypassToolsForSandboxStatus(sandboxStatus)) {
          const fallback = formatSandboxFallbackMessage(sandboxStatus && sandboxStatus.detail);
          await this._runDirectChatFallback(
            activeChat,
            messages,
            `${describeSandboxBypass(sandboxStatus, fallback)} Background agent mode needs tools.`,
            { showThinking: false, intentContext }
          );
          return;
        }
      } catch (err) {
        const fallback = formatSandboxFallbackMessage(err);
        await this._runDirectChatFallback(
          activeChat,
          messages,
          `${fallback.userMessage} Background agent mode needs Docker.`,
          { intentContext }
        );
        return;
      }
      const task = await appRuntime.tasks.createTaskFromPreparedMessages({
        title: buildChatTitleFromMessage(userText),
        prompt: userText,
        chatId: activeChat.id,
        background: true,
        executionRoot: getWorkspaceFolder() ? getWorkspaceFolder().uri.fsPath : appRuntime.store.workspaceRoot,
        messages
      });
      appRuntime.store.appendMessage(activeChat.id, {
        role: 'system-msg',
        content: `Background task started: ${task.title} (${task.id})`
      });
      await this.syncState();
      return;
    }

    this._post({ type: 'thinking' });
    this._streaming = true;
    try {
      if (agentEnabled()) {
        this._post({ type: 'systemMsg', text: 'Preparing tools and runtime helpers.' });
        try {
          const sandboxStatus = await appRuntime.ensureSandboxReady();
          if (shouldBypassToolsForSandboxStatus(sandboxStatus)) {
            const fallback = formatSandboxFallbackMessage(sandboxStatus && sandboxStatus.detail);
            await this._runDirectChatFallback(
              activeChat,
              messages,
              describeSandboxBypass(sandboxStatus, fallback),
              { showThinking: false, intentContext }
            );
            return;
          }
        } catch (err) {
          const fallback = formatSandboxFallbackMessage(err);
          await this._runDirectChatFallback(
            activeChat,
            messages,
            `${fallback.userMessage} Open Docker Desktop to re-enable tools.`,
            { showThinking: false, intentContext }
          );
          return;
        }
        this._post({ type: 'systemMsg', text: 'Starting autonomous execution.' });
        const preparedTask = await appRuntime.tasks.createTaskFromPreparedMessages({
          title: buildChatTitleFromMessage(userText),
          prompt: userText,
          chatId: activeChat.id,
          background: false,
          executionRoot: getWorkspaceFolder() ? getWorkspaceFolder().uri.fsPath : appRuntime.store.workspaceRoot,
          messages
        });
        this._activeForegroundTaskId = preparedTask.id;
        await appRuntime.tasks._startTask(preparedTask.id, {
          onRoundStart: (round, maxRounds) => {
            this._post({ type: 'systemMsg', text: `Agent round ${round}/${maxRounds}` });
          },
          onModelRequestStart: (round, maxRounds) => {
            this._post({
              type: 'systemMsg',
              text: round === 1
                ? 'Waiting for the model to plan the first action. Docker will stay idle until the first tool call.'
                : `Waiting for the model to continue round ${round}/${maxRounds}.`
            });
          },
          onAssistantNote: (note) => {
            const visibleNote = summarizeAssistantNoteForUi(note);
            if (visibleNote) this._post({ type: 'systemMsg', text: visibleNote });
          },
          onToolCall: (toolCall) => {
            this._post({ type: 'systemMsg', text: `Tool: ${summarizeToolInput(toolCall.name, toolCall.input)}` });
          },
          onToolResult: (toolCall, resultValue, ok) => {
            this._post({ type: 'systemMsg', text: `Tool result: ${toolCall.name} · ${summarizeToolResultForUi(toolCall, resultValue, ok)}` });
          },
          onPatchReady: (patch) => {
            this._post({ type: 'systemMsg', text: `Patch ready: ${formatPatchSummary(patch.files, patch.summary)}. Accept it to write the files into the workspace.` });
          }
        });
        const completedTaskBeforeDelivery = appRuntime.store.loadTask(preparedTask.id);
        const agentValidation = {
          status: completedTaskBeforeDelivery && completedTaskBeforeDelivery.postValidationStatus ? completedTaskBeforeDelivery.postValidationStatus : 'passed',
          issues: completedTaskBeforeDelivery && Array.isArray(completedTaskBeforeDelivery.postValidationIssues) ? completedTaskBeforeDelivery.postValidationIssues : []
        };
        const agentMeta = buildResponseMeta(intentContext, agentValidation, {
          source: 'agent-task',
          runtimeKind: completedTaskBeforeDelivery && completedTaskBeforeDelivery.runtimeKind ? completedTaskBeforeDelivery.runtimeKind : 'local'
        });
        this._setResponseMeta(activeChat.id, agentMeta);
        this._logAuditDecision(activeChat.id, agentMeta);
        await appRuntime.tasks.deliverTaskToChat(preparedTask.id);
        const completedTask = appRuntime.store.loadTask(preparedTask.id);
        const assistantText = completedTask && completedTask.resultText ? completedTask.resultText : '';
        this._post({ type: 'done', text: assistantText });
      } else {
        await this._runDirectChatFallback(activeChat, messages, '', { showThinking: false, intentContext });
        return;
      }
      await appRuntime.maybeCompactChat(activeChat.id);
      await this.syncState();
    } catch (err) {
      this._post({ type: 'status', connected: isConnected, model: getModelId(), baseUrl: getBaseUrl(), detail: lastConnectionError });
      this._post({ type: 'error', text: err.message });
      await this.syncState();
    } finally {
      this._activeForegroundTaskId = '';
      this._abortActiveStream = null;
      this._streaming = false;
    }
  }

  async sendPromptFromCommand(text) {
    await vscode.commands.executeCommand('localai.chatView.focus');
    await this._handleSend(text, true, false);
  }

  async _applyCode(code, language) {
    const editor = vscode.window.activeTextEditor;
    if (!editor) { vscode.window.showWarningMessage('No active editor to apply code to.'); return; }
    const selection = editor.selection;
    await editor.edit(eb => {
      if (selection.isEmpty) {
        eb.insert(selection.active, code);
      } else {
        eb.replace(selection, code);
      }
    });
    vscode.window.showInformationMessage('Code applied!');
  }

  async _createFile(code, language) {
    const ext = { javascript: 'js', typescript: 'ts', python: 'py', java: 'java', csharp: 'cs', cpp: 'cpp', c: 'c', html: 'html', css: 'css', json: 'json', markdown: 'md' }[language] || 'txt';
    const uri = await vscode.window.showSaveDialog({ filters: { 'Files': [ext] }, defaultUri: vscode.Uri.file(`new_file.${ext}`) });
    if (uri) {
      fs.writeFileSync(uri.fsPath, code);
      vscode.workspace.openTextDocument(uri).then(doc => vscode.window.showTextDocument(doc));
    }
  }

  _getHtml(webview) {
    const mediaUri = vscode.Uri.joinPath(this._context.extensionUri, 'media');
    const nonce = getNonce();
    const htmlPath = vscode.Uri.joinPath(mediaUri, 'chat.html');
    try {
      let html = fs.readFileSync(htmlPath.fsPath, 'utf8');
      html = html.replace(/\$\{nonce\}/g, nonce);
      html = html.replace(/\$\{cspSource\}/g, webview.cspSource);
      // Replace brand names
      html = html.replace(/LocalAI/g, 'LocalAI');
      return html;
    } catch (error) {
      console.error(`[localai-code] Failed to load chat webview HTML: ${error.message}`);
      return getFallbackHtml(nonce, webview.cspSource);
    }
  }
}

function getNonce() {
  let text = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) text += chars.charAt(Math.floor(Math.random() * chars.length));
  return text;
}

function getFallbackHtml(nonce, cspSource) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src ${cspSource} 'unsafe-inline';"><title>LocalAI</title></head><body><p>Loading...</p></body></html>`;
}

// ── Code Action Commands ──────────────────────────────────────────────────────
async function runCodeAction(action, extraPrompt) {
  const editor = vscode.window.activeTextEditor;
  if (!editor) { vscode.window.showWarningMessage('No active editor.'); return; }

  const ctx = getEditorContext(editor, editor.selection);
  if (!ctx.selectedText && !ctx.fullContent) { vscode.window.showWarningMessage('No code found.'); return; }

  const prompts = {
    explain: 'Explain the selected code',
    fix: 'Fix bugs in the selected code',
    refactor: 'Refactor the selected code',
    optimize: 'Optimize the selected code',
    tests: 'Generate unit tests for the selected code',
    comments: 'Add comments and documentation to the selected code',
    ask: extraPrompt || 'What does this code do?'
  };

  if (chatProvider) {
    await chatProvider.sendPromptFromCommand(prompts[action] || action);
  }
}

function createTestingApi() {
  return {
    async initialize() {
      await appRuntime.initialize();
      return true;
    },
    async checkConnection() {
      return checkConnection();
    },
    async forceRebuildRag() {
      await appRuntime.initialize();
      await appRuntime.rag.rebuildAll();
      return appRuntime.rag.getStatus();
    },
    async waitForRagReady(timeoutMs = 180000) {
      const startedAt = Date.now();
      while (Date.now() - startedAt < timeoutMs) {
        const status = appRuntime.rag.getStatus();
        if (status.state === 'ready' || status.state === 'error') return status;
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      throw new Error(`Timed out waiting for RAG index to become ready after ${timeoutMs}ms.`);
    },
    getRagStatus() {
      return appRuntime.rag.getStatus();
    },
    async getSandboxStatus(force = false) {
      await appRuntime.initialize();
      return appRuntime.getSandboxStatus(force);
    },
    getUiSnapshot() {
      return appRuntime.store.getUiSnapshot();
    },
    getContextMeta(chatId) {
      const activeChatId = chatId || appRuntime.store.getActiveChatId();
      return activeChatId ? appRuntime.getContextMeta(activeChatId) : null;
    },
    async createChat(title = 'New Chat') {
      await appRuntime.initialize();
      const chat = appRuntime.store.createChat(title);
      if (chatProvider) await chatProvider.syncState();
      return chat;
    },
    async searchWorkspace(queryText, openPaths = []) {
      await appRuntime.initialize();
      return appRuntime.rag.search(queryText, openPaths);
    },
    async createBackgroundTask(prompt, options = {}) {
      await appRuntime.initialize();
      const task = await appRuntime.tasks.createTaskFromPrompt({
        title: options.title || buildChatTitleFromMessage(prompt),
        prompt,
        executionRoot: options.executionRoot || (getWorkspaceFolder() ? getWorkspaceFolder().uri.fsPath : appRuntime.store.workspaceRoot),
        chatId: options.chatId || '',
        parentTaskId: options.parentTaskId || '',
        runtimeKind: options.runtimeKind,
        background: true
      });
      return task;
    },
    async waitForTask(taskId, timeoutMs = 180000) {
      const startedAt = Date.now();
      while (Date.now() - startedAt < timeoutMs) {
        const task = appRuntime.tasks.getTask(taskId);
        if (task && ['completed', 'failed', 'stopped'].includes(task.status)) return task;
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      throw new Error(`Timed out waiting for task ${taskId}`);
    },
    getTask(taskId) {
      return appRuntime.tasks.getTask(taskId);
    },
    getTasks() {
      return appRuntime.tasks.getTasks();
    },
    getAgents() {
      return appRuntime.features.listAgents();
    },
    getTeams() {
      return appRuntime.features.listTeams();
    },
    getFeatureSnapshot() {
      return appRuntime.features.getSnapshot();
    },
    getResponseMeta(chatId) {
      const activeChatId = chatId || appRuntime.store.getActiveChatId();
      return chatProvider && typeof chatProvider._getResponseMeta === 'function'
        ? chatProvider._getResponseMeta(activeChatId)
        : null;
    },
    evaluateAntiHallucination(userText, assistantText = '', messages = [], contextMeta = null) {
      const intentContext = injectIntentFormatInstructions(messages, userText, contextMeta);
      const validation = assistantText
        ? antiHallucination.validateAssistantResponse(assistantText, intentContext)
        : { status: 'pending', issues: [] };
      return {
        intentContext,
        validation,
        responseMeta: buildResponseMeta(intentContext, validation)
      };
    },
    async spawnAgent(input) {
      await appRuntime.initialize();
      return appRuntime.features.executeTool('spawn_agent', input || {}, {
        chatId: appRuntime.store.getActiveChatId(),
        rootPath: getWorkspaceFolder() ? getWorkspaceFolder().uri.fsPath : appRuntime.store.workspaceRoot
      });
    },
    async syncCloudTasks() {
      await appRuntime.initialize();
      await appRuntime.tasks.cloud.syncActiveTasks();
      return appRuntime.tasks.getTasks();
    },
    async sendPrompt(text, options = {}) {
      await appRuntime.initialize();
      if (!chatProvider) throw new Error('Chat provider is not initialized.');
      await chatProvider._handleSend(text, options.includeFile !== false);
      const activeChat = appRuntime.store.ensureActiveChat();
      const messages = appRuntime.store.loadMessages(activeChat.id);
      const assistant = [...messages].reverse().find(message => message.role === 'assistant');
      return {
        chatId: activeChat.id,
        assistantText: assistant ? assistant.content : '',
        messages,
        contextMeta: appRuntime.getContextMeta(activeChat.id),
        ragStatus: appRuntime.rag.getStatus(),
        responseMeta: chatProvider && typeof chatProvider._getResponseMeta === 'function' ? chatProvider._getResponseMeta(activeChat.id) : null
      };
    }
  };
}

// ── activate ──────────────────────────────────────────────────────────────────
async function activate(context) {
  extensionContext = context;
  appRuntime = new LocalAIRuntime(context);
  void appRuntime.maybeAutoStartDocker({ reason: 'activate-entry', waitForReady: false });

  // Status bar
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.command = 'localai.selectModel';
  statusBarItem.text = '$(sync~spin) LocalAI: Connecting...';
  statusBarItem.color = '#888';
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  // Chat view provider
  chatProvider = new LocalAIChatViewProvider(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('localai.chatView', chatProvider, {
      webviewOptions: { retainContextWhenHidden: true }
    })
  );

  // Inline completions
  inlineCompletionProvider = new LocalAIInlineCompletionProvider();
  context.subscriptions.push(
    vscode.languages.registerInlineCompletionItemProvider(
      [{ scheme: 'file', pattern: '**' }, { scheme: 'untitled', pattern: '**' }],
      inlineCompletionProvider
    )
  );

  // Commands
  context.subscriptions.push(
    vscode.commands.registerCommand('localai.openChat', () => vscode.commands.executeCommand('localai.chatView.focus')),
    vscode.commands.registerCommand('localai.newChat', async () => {
      await appRuntime.initialize();
      appRuntime.store.createChat('New Chat');
      if (chatProvider) await chatProvider.syncState();
      await vscode.commands.executeCommand('localai.chatView.focus');
    }),
    vscode.commands.registerCommand('localai.explainCode', () => runCodeAction('explain')),
    vscode.commands.registerCommand('localai.fixCode', () => runCodeAction('fix')),
    vscode.commands.registerCommand('localai.refactorCode', () => runCodeAction('refactor')),
    vscode.commands.registerCommand('localai.optimizeCode', () => runCodeAction('optimize')),
    vscode.commands.registerCommand('localai.generateTests', () => runCodeAction('tests')),
    vscode.commands.registerCommand('localai.addComments', () => runCodeAction('comments')),
    vscode.commands.registerCommand('localai.generateCode', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      const line = editor.document.lineAt(editor.selection.active.line).text;
      const prompt = await vscode.window.showInputBox({ prompt: 'What code do you want to generate?', value: line.trim().replace(/^\/\/\s*/, '') });
      if (prompt) runCodeAction('ask', prompt);
    }),
    vscode.commands.registerCommand('localai.askAboutSelection', async () => {
      const question = await vscode.window.showInputBox({ prompt: 'Ask anything about the selected code...' });
      if (question) runCodeAction('ask', question);
    }),
    vscode.commands.registerCommand('localai.selectModel', async () => {
      if (chatProvider) await chatProvider._selectModel();
    }),
    vscode.commands.registerCommand('localai.checkConnection', async () => {
      if (chatProvider) await chatProvider._doCheckConnection();
    }),
    vscode.commands.registerCommand('localai.acceptDiff', async () => {
      await appRuntime.initialize();
      const patch = appRuntime.store.getPendingPatches()[0];
      if (!patch) {
        vscode.window.showInformationMessage('No pending LocalAI patch to apply.');
        return;
      }
      const result = await appRuntime.applyPatch(patch.id);
      vscode.window.showInformationMessage(result.summary || 'Patch applied.');
      if (chatProvider) await chatProvider.syncState();
    }),
    vscode.commands.registerCommand('localai.rejectDiff', async () => {
      await appRuntime.initialize();
      const patch = appRuntime.store.getPendingPatches()[0];
      if (!patch) {
        vscode.window.showInformationMessage('No pending LocalAI patch to reject.');
        return;
      }
      await appRuntime.rejectPatch(patch.id);
      vscode.window.showInformationMessage('Patch rejected.');
      if (chatProvider) await chatProvider.syncState();
    }),
    vscode.commands.registerCommand('localai.reviewDiff', async () => {
      await appRuntime.initialize();
      const patch = appRuntime.store.getPendingPatches()[0];
      if (!patch) {
        vscode.window.showInformationMessage('No pending LocalAI patch to review.');
        return;
      }
      await appRuntime.reviewPatch(patch.id);
    })
  );

  await vscode.commands.executeCommand('setContext', 'localai.viewingDiff', false);

  // Initial connection check
  setTimeout(async () => {
    await appRuntime.initialize();
    await checkConnection();
  }, 1000);

  // Periodic connection check every 60s
  const intervalId = setInterval(async () => {
    await checkConnection();
    if (chatProvider && chatProvider.syncState) await chatProvider.syncState();
    if (appRuntime && appRuntime.store) {
      const awaitingTasks = appRuntime.store.getTasks().filter(task => task.status === 'awaiting_user' && task.awaitingSince);
      for (const task of awaitingTasks) {
        const waitingMs = Date.now() - new Date(task.awaitingSince).getTime();
        const warningThresholdMs = 5 * 60 * 1000;
        if (waitingMs >= warningThresholdMs && !task._timeoutWarned) {
          if (task.chatId) {
            appRuntime.store.appendMessage(task.chatId, {
              role: 'system-msg',
              content: `**Timeout warning:** Task "${task.title}" has been waiting for your answer for over 5 minutes. Reply to resume the task.`
            });
          }
          appRuntime.store.updateTask(task.id, currentTask => {
            currentTask._timeoutWarned = true;
            return currentTask;
          });
          if (chatProvider && chatProvider.syncState) await chatProvider.syncState();
        }
      }
    }
  }, 60000);
  context.subscriptions.push({ dispose: () => clearInterval(intervalId) });

  let lastMemoryScope = getMemoryScope();
  const configListener = vscode.workspace.onDidChangeConfiguration(async (event) => {
    if (event.affectsConfiguration('localai.memory.scope')) {
      const newScope = getMemoryScope();
      if (newScope !== lastMemoryScope) {
        lastMemoryScope = newScope;
        const explanation = getMemoryScopeExplanation(newScope);
        vscode.window.showInformationMessage(`Memory scope changed to "${newScope}": ${explanation}`);
        if (chatProvider && chatProvider.syncState) await chatProvider.syncState();
      }
    }
  });
  context.subscriptions.push(configListener);

  return {
    testing: createTestingApi()
  };
}

function deactivate() {
  if (debounceTimer) clearTimeout(debounceTimer);
  if (appRuntime && appRuntime.rag) appRuntime.rag.dispose();
  if (appRuntime && appRuntime.tasks) appRuntime.tasks.dispose();
}

module.exports = { activate, deactivate };
