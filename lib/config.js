'use strict';

const vscode = require('vscode');
const path = require('path');

// ── Constants ────────────────────────────────────────────────────────────────
const HF_ROUTER_HOST = 'router.huggingface.co';
const HF_CHAT_COMPLETIONS_PATH = '/v1/chat/completions';
const HF_MODELS_PATH = '/v1/models';
const HF_INFERENCE_PROVIDER = 'hf-inference';
const DEFAULT_MODEL_ID = 'Qwen/Qwen3.5-397B-A17B:fastest';
const FALLBACK_MODEL_ID = 'Qwen/Qwen2.5-Coder-32B-Instruct:fastest';
const DEFAULT_EMBEDDING_MODEL = 'intfloat/multilingual-e5-large';
const WORKSPACE_FILE_LIMIT = 400;
const WORKSPACE_CONTEXT_EXCLUDES = '**/{node_modules,.git,dist,build,coverage,.next,out,target,.venv,venv,__pycache__}/**';

// Chat/Persistence constants
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

// Size/Limit constants
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

// File type constants
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
  'AGENTS.md', 'Dockerfile', 'Makefile', 'package.json', 'package-lock.json',
  'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', 'requirements.txt',
  'requirements-dev.txt', 'pyproject.toml', 'Pipfile', 'Pipfile.lock',
  'Cargo.toml', 'Cargo.lock', 'go.mod', 'go.sum', 'pom.xml',
  'build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts',
  '.gitignore', '.npmrc', '.env.example'
]);

// ── Config reader ────────────────────────────────────────────────────────────
function cfg(key) {
  return vscode.workspace.getConfiguration('localai').get(key);
}

function getModelId() {
  return cfg('modelId') || DEFAULT_MODEL_ID;
}

function normalizeModelId(modelId) {
  let value = String(modelId || '').trim();
  if (!value) return DEFAULT_MODEL_ID;
  if (value.includes(':')) return value;
  if (value.startsWith('/') || value.startsWith('./') || /^\d+\.\d+\.\d+\.\d+/.test(value)) return value;
  return `${value}:fastest`;
}

function getBaseModelId(modelId) {
  return normalizeModelId(modelId).split(':')[0];
}

function getEmbeddingModel() {
  return cfg('rag.embeddingModel') || DEFAULT_EMBEDDING_MODEL;
}

function memoryEnabled() { return cfg('memory.enabled') !== false; }
function ragEnabled() { return cfg('rag.enabled') !== false; }
function getMaxRecentMessages() { return Math.max(4, Number(cfg('memory.maxRecentMessages') || DEFAULT_MAX_RECENT_MESSAGES)); }
function getCompactionThreshold() { return Math.max(4, Number(cfg('memory.compactionThresholdMessages') || DEFAULT_COMPACTION_THRESHOLD)); }
function getRagTopK() { return Math.max(1, Number(cfg('rag.topK') || DEFAULT_RAG_TOP_K)); }
function getChunkSizeChars() { return Math.max(300, Number(cfg('rag.chunkSizeChars') || DEFAULT_CHUNK_SIZE)); }
function getChunkOverlapChars() { return Math.max(0, Math.min(getChunkSizeChars() - 50, Number(cfg('rag.chunkOverlapChars') || DEFAULT_CHUNK_OVERLAP))); }
function getEmbedMaxRetries() { return Math.max(0, Math.min(10, Number(cfg('rag.embeddingMaxRetries') || 3))); }
function getAutoRefreshIntervalMinutes() { return Math.max(0, Math.min(120, Number(cfg('rag.autoRefreshIntervalMinutes') || 30))); }

function agentEnabled() { return cfg('agent.enabled') !== false; }

function getAgentMaxRounds(agentType) {
  const custom = cfg('agent.maxRounds');
  if (custom) return Math.max(1, Math.min(100, Number(custom)));
  switch (agentType || '') {
    case 'refactoring-expert': return 80;
    case 'aria-orchestrator': return 50;
    case 'database-expert': return 35;
    case 'rtl-ui-auditor': return 30;
    case 'security-sentinel': return 30;
    case 'performance-monitor': return 30;
    case 'onboarding-expert': return 20;
    default: return DEFAULT_AGENT_MAX_ROUNDS;
  }
}

function agentAllowShell() { return cfg('agent.allowShell') !== false; }
function getAgentShellTimeoutMs() { return Math.max(1000, Math.min(600000, Number(cfg('agent.shellTimeoutMs') || DEFAULT_AGENT_SHELL_TIMEOUT_MS))); }
function agentPreferWebForFreshInfo() { return cfg('agent.preferWebForFreshInfo') !== false; }
function getAgentMaxConcurrentTasks() { return Math.max(1, Math.min(8, Number(cfg('agent.maxConcurrentTasks') || DEFAULT_AGENT_MAX_CONCURRENT_TASKS))); }

function cloudEnabled() { return cfg('cloud.enabled') === true; }
function getCloudExecutorUrl() { return String(cfg('cloud.executorUrl') || '').trim().replace(/\/+$/, ''); }
function getCloudApiKey() { return String(cfg('cloud.apiKey') || '').trim(); }
function getCloudPollIntervalMs() { return Math.max(1000, Math.min(60000, Number(cfg('cloud.pollIntervalMs') || DEFAULT_CLOUD_POLL_INTERVAL_MS))); }
function cloudForwardApiToken() { return cfg('cloud.forwardApiToken') === true; }

function getCloudMaxSnapshotFiles() { return Math.max(10, Math.min(1000, Number(cfg('cloud.maxSnapshotFiles') || MAX_CLOUD_SNAPSHOT_FILES))); }
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

function getMemoryScope() { return cfg('memory.scope') || 'global+workspace'; }
function getMemoryScopeExplanation(scope) {
  const s = scope || getMemoryScope();
  switch (s) {
    case 'workspace': return 'Project-only memory: notes are stored per workspace and shared across chats in this project.';
    case 'global': return 'Global-only memory: notes are shared across all workspaces for personal preferences.';
    case 'global+workspace':
    default: return 'Combined memory: global notes (cross-project preferences) + workspace notes (project conventions).';
  }
}

function getGlobalUserInstructions() { return normalizeInstructionText(cfg('instructions.global')); }
function getWorkspaceUserInstructions() { return normalizeInstructionText(cfg('instructions.workspace')); }

function sandboxEnabled() { return cfg('sandbox.enabled') !== false; }
function sandboxRuntimeRequired() { return cfg('sandbox.runtimeRequired') !== false; }
function getSandboxImage() { return String(cfg('sandbox.image') || DEFAULT_SANDBOX_IMAGE).trim() || DEFAULT_SANDBOX_IMAGE; }
function sandboxAutoBuildImage() { return cfg('sandbox.autoBuildImage') !== false; }
function sandboxAutoStartDocker() { return cfg('sandbox.autoStartDocker') !== false; }
function getSandboxNetworkMode() { return String(cfg('sandbox.networkMode') || DEFAULT_SANDBOX_NETWORK).trim() || DEFAULT_SANDBOX_NETWORK; }
function getSandboxMaxConcurrent() { return Math.max(1, Math.min(8, Number(cfg('sandbox.maxConcurrentSandboxes') || DEFAULT_SANDBOX_MAX_CONCURRENT))); }
function getSandboxToolTimeoutMs() { return Math.max(1000, Math.min(30 * 60 * 1000, Number(cfg('sandbox.toolTimeoutMs') || DEFAULT_SANDBOX_TOOL_TIMEOUT_MS))); }
function sandboxRetainOnFailure() { return cfg('sandbox.retainOnFailure') !== false; }

function getDockerDesktopExecutableCandidates() {
  const candidates = [
    process.env.ProgramFiles ? path.join(process.env.ProgramFiles, 'Docker', 'Docker', 'Docker Desktop.exe') : '',
    process.env.ProgramW6432 ? path.join(process.env.ProgramW6432, 'Docker', 'Docker', 'Docker Desktop.exe') : '',
    process.env['ProgramFiles(x86)'] ? path.join(process.env['ProgramFiles(x86)'], 'Docker', 'Docker', 'Docker Desktop.exe') : '',
    process.env.LocalAppData ? path.join(process.env.LocalAppData, 'Docker', 'Docker Desktop.exe') : ''
  ];
  return [...new Set(candidates.filter(Boolean).map(c => path.normalize(c)))];
}

// ── Internal helpers used by config functions ────────────────────────────────
function normalizeInstructionText(text, maxChars = 12000) {
  const value = String(text || '').replace(/\r\n/g, '\n').trim();
  if (!value) return '';
  return truncateText(value, maxChars);
}

function truncateText(text, maxChars) {
  const value = String(text || '');
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 3))}...`;
}

// ── Exports ──────────────────────────────────────────────────────────────────
module.exports = {
  // Constants
  HF_ROUTER_HOST, HF_CHAT_COMPLETIONS_PATH, HF_MODELS_PATH, HF_INFERENCE_PROVIDER,
  DEFAULT_MODEL_ID, FALLBACK_MODEL_ID, DEFAULT_EMBEDDING_MODEL,
  WORKSPACE_FILE_LIMIT, WORKSPACE_CONTEXT_EXCLUDES,
  CHATS_DIR, CHAT_INDEX_FILE, CHAT_MESSAGES_DIR, CHAT_SUMMARIES_DIR,
  TASKS_DIR, TASK_INDEX_FILE, PATCHES_DIR, PATCH_INDEX_FILE,
  MEMORY_DIR, GLOBAL_MEMORY_FILE, WORKSPACE_MEMORY_FILE,
  RAG_DIR, RAG_INDEX_FILE, SANDBOXES_DIR,
  MAX_FILE_CONTEXT_CHARS, MAX_RAG_SNIPPET_CHARS,
  DEFAULT_MAX_RECENT_MESSAGES, DEFAULT_COMPACTION_THRESHOLD,
  DEFAULT_RAG_TOP_K, DEFAULT_RAG_CANDIDATES, DEFAULT_CHUNK_SIZE, DEFAULT_CHUNK_OVERLAP,
  DEFAULT_AGENT_MAX_ROUNDS, DEFAULT_AGENT_SHELL_TIMEOUT_MS, DEFAULT_AGENT_MAX_CONCURRENT_TASKS,
  DEFAULT_CLOUD_POLL_INTERVAL_MS, DEFAULT_SANDBOX_IMAGE, DEFAULT_SANDBOX_NETWORK,
  DEFAULT_SANDBOX_MAX_CONCURRENT, DEFAULT_SANDBOX_TOOL_TIMEOUT_MS,
  DOCKER_AUTO_START_READY_TIMEOUT_MS, DOCKER_AUTO_START_COOLDOWN_MS, DOCKER_AUTO_START_POLL_MS,
  MAX_INDEX_FILE_BYTES, MAX_EMBED_CANDIDATES,
  MAX_AGENT_TOOL_OUTPUT_CHARS, MAX_AGENT_TOOL_MODEL_RESULT_CHARS,
  MAX_AGENT_TOOL_MODEL_STDIO_CHARS, MAX_AGENT_TOOL_MODEL_LIST_ITEMS,
  MAX_AGENT_TOOL_MODEL_MATCHES, MAX_AGENT_FILE_READ_CHARS,
  MAX_AGENT_LIST_RESULTS, MAX_AGENT_SEARCH_RESULTS, MAX_TASK_LOG_ENTRIES,
  MAX_CLOUD_SNAPSHOT_FILES, MAX_CLOUD_SNAPSHOT_TOTAL_BYTES, MAX_CLOUD_SNAPSHOT_FILE_BYTES,
  INDEXABLE_EXTENSIONS, EXCLUDED_PATH_PARTS, CLOUD_SNAPSHOT_BASENAMES,
  // Functions
  cfg,
  getModelId, normalizeModelId, getBaseModelId, getEmbeddingModel,
  memoryEnabled, ragEnabled, getMaxRecentMessages, getCompactionThreshold,
  getRagTopK, getChunkSizeChars, getChunkOverlapChars, getEmbedMaxRetries,
  getAutoRefreshIntervalMinutes,
  agentEnabled, getAgentMaxRounds, agentAllowShell, getAgentShellTimeoutMs,
  agentPreferWebForFreshInfo, getAgentMaxConcurrentTasks,
  cloudEnabled, getCloudExecutorUrl, getCloudApiKey, getCloudPollIntervalMs,
  cloudForwardApiToken, getCloudMaxSnapshotFiles, getCloudMaxSnapshotTotalBytes,
  getCloudMaxSnapshotFileBytes,
  getMemoryScope, getMemoryScopeExplanation,
  getGlobalUserInstructions, getWorkspaceUserInstructions,
  sandboxEnabled, sandboxRuntimeRequired, getSandboxImage, sandboxAutoBuildImage,
  sandboxAutoStartDocker, getSandboxNetworkMode, getSandboxMaxConcurrent,
  getSandboxToolTimeoutMs, sandboxRetainOnFailure,
  getDockerDesktopExecutableCandidates,
  normalizeInstructionText, truncateText
};

