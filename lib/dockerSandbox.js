'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const TOOL_TIMEOUT_MS = 120000;
const DOCKER_CONTROL_TIMEOUT_MS = 60000;
const INTERNAL_DIR_NAME = '.hfai-sandbox';
const INTERNAL_TOOL_RUNNER = `${INTERNAL_DIR_NAME}/tool-runner.cjs`;
const LEGACY_INTERNAL_TOOL_RUNNER = `${INTERNAL_DIR_NAME}/tool-runner.js`;
const INTERNAL_METADATA_FILE = `${INTERNAL_DIR_NAME}/sandbox-meta.json`;
const INTERNAL_DIR_PREFIX = `${INTERNAL_DIR_NAME}/`;
const MAX_TOOL_STDOUT_CHARS = 200000;

function truncateText(text, maxChars) {
  const value = String(text || '');
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 3))}...`;
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

function escapeShellSingleQuotes(value) {
  return String(value || '').replace(/'/g, `'\\''`);
}

function normalizeRelativePath(value) {
  return String(value || '').replace(/\\/g, '/').replace(/^\/+/, '');
}

function shouldIgnoreCopyPath(relativePath) {
  const normalized = normalizeRelativePath(relativePath);
  if (!normalized) return false;
  const first = normalized.split('/')[0];
  return first === '.git' || first === INTERNAL_DIR_NAME;
}

async function copyWorkspaceTree(sourceRoot, targetRoot, relativePath = '') {
  const sourcePath = relativePath ? path.join(sourceRoot, relativePath) : sourceRoot;
  let entries = [];
  try {
    entries = await fs.promises.readdir(sourcePath, { withFileTypes: true });
  } catch (_) {
    return;
  }

  const tasks = [];
  for (const entry of entries) {
    const childRelative = relativePath
      ? path.posix.join(relativePath.replace(/\\/g, '/'), entry.name)
      : entry.name;
    if (shouldIgnoreCopyPath(childRelative)) continue;
    
    const sourceChild = path.join(sourcePath, entry.name);
    const targetChild = path.join(targetRoot, childRelative);
    
    if (entry.isDirectory()) {
      ensureDirSync(targetChild);
      tasks.push(copyWorkspaceTree(sourceRoot, targetRoot, childRelative));
      continue;
    }
    if (!entry.isFile()) continue;
    ensureDirSync(path.dirname(targetChild));
    tasks.push(fs.promises.copyFile(sourceChild, targetChild));
  }
  
  if (tasks.length > 0) {
    await Promise.all(tasks);
  }
}

function buildContainerName(prefix, sandboxId) {
  return `${prefix}-${sandboxId}`.replace(/[^a-zA-Z0-9_.-]/g, '-').slice(0, 80);
}

function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd || process.cwd(),
      env: options.env || process.env,
      shell: false,
      windowsHide: true
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    const timeoutMs = Math.max(1000, Number(options.timeoutMs || TOOL_TIMEOUT_MS));
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill(); } catch (_) { }
      reject(new Error(`${command} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    if (options.runtimeState) options.runtimeState.activeChild = child;

    child.stdout.on('data', chunk => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', chunk => {
      stderr += chunk.toString();
    });
    child.on('error', error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (options.runtimeState) options.runtimeState.activeChild = null;
      reject(error);
    });
    child.on('close', code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (options.runtimeState) options.runtimeState.activeChild = null;
      if (code !== 0) {
        reject(new Error(truncateText(stderr || stdout || `${command} exited with code ${code}`, 6000)));
        return;
      }
      resolve({
        exitCode: code,
        stdout,
        stderr
      });
    });
  });
}

function getToolRunnerSource() {
  return `'use strict';

const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const WORKSPACE_ROOT = process.cwd();
const INTERNAL_DIR_NAME = ${JSON.stringify(INTERNAL_DIR_NAME)};
const MAX_FILE_READ_CHARS = 24000;
const MAX_LIST_RESULTS = 250;
const MAX_SEARCH_RESULTS = 120;

function truncateText(text, maxChars) {
  const value = String(text || '');
  if (value.length <= maxChars) return value;
  return value.slice(0, Math.max(0, maxChars - 3)) + '...';
}

function normalizeRelative(input) {
  return String(input || '').replace(/\\\\/g, '/').replace(/^\\/+/, '');
}

function resolveWorkspacePath(input) {
  const normalized = normalizeRelative(input || '.');
  const targetPath = path.resolve(WORKSPACE_ROOT, normalized || '.');
  const relative = path.relative(WORKSPACE_ROOT, targetPath).replace(/\\\\/g, '/');
  if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return targetPath;
}

function workspaceRelative(fsPath) {
  const relative = path.relative(WORKSPACE_ROOT, fsPath).replace(/\\\\/g, '/');
  return relative || '.';
}

function formatTextWithLineNumbers(text, startLine = 1) {
  return String(text || '')
    .split(/\\r?\\n/)
    .map((line, index) => \`\${String(startLine + index).padStart(4, ' ')} | \${line}\`)
    .join('\\n');
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

function isInternalPath(relativePath) {
  const normalized = normalizeRelative(relativePath);
  return normalized === INTERNAL_DIR_NAME || normalized.startsWith(INTERNAL_DIR_NAME + '/');
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&');
}

function wildcardToRegExp(pattern) {
  return new RegExp('^' + escapeRegExp(pattern).replace(/\\\\\\*/g, '.*').replace(/\\\\\\?/g, '.') + '$', 'i');
}

function listFiles(basePath, options = {}) {
  const depth = Math.max(0, Math.min(12, Number(options.depth || 1)));
  const pattern = options.pattern ? wildcardToRegExp(options.pattern) : null;
  const entries = [];

  const visit = (currentPath, currentDepth) => {
    if (entries.length >= MAX_LIST_RESULTS) return;
    let dirEntries = [];
    try {
      dirEntries = fs.readdirSync(currentPath, { withFileTypes: true });
    } catch (_) {
      return;
    }

    dirEntries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of dirEntries) {
      if (entries.length >= MAX_LIST_RESULTS) break;
      const absolutePath = path.join(currentPath, entry.name);
      const relativePath = workspaceRelative(absolutePath);
      if (isInternalPath(relativePath)) continue;
      if (pattern && !pattern.test(entry.name) && !pattern.test(relativePath)) continue;
      let stat = null;
      try { stat = fs.statSync(absolutePath); } catch (_) {}
      entries.push({
        path: relativePath,
        name: entry.name,
        type: entry.isDirectory() ? 'directory' : 'file',
        size: stat && stat.isFile() ? stat.size : 0
      });
      if (entry.isDirectory() && currentDepth < depth) visit(absolutePath, currentDepth + 1);
    }
  };

  visit(basePath, 0);
  return entries;
}

function searchText(options = {}) {
  const basePath = resolveWorkspacePath(options.path || '.');
  if (!basePath || !fs.existsSync(basePath)) throw new Error(\`Invalid search path: \${options.path || '.'}\`);
  const maxResults = Math.max(1, Math.min(MAX_SEARCH_RESULTS, Number(options.maxResults || 20)));
  const pattern = String(options.pattern || '');
  if (!pattern.trim()) throw new Error('search_text requires a non-empty pattern.');
  const isRegex = Boolean(options.isRegex);
  const caseSensitive = Boolean(options.caseSensitive);
  const matcher = isRegex
    ? new RegExp(pattern, caseSensitive ? 'g' : 'gi')
    : new RegExp(escapeRegExp(pattern), caseSensitive ? 'g' : 'gi');
  const results = [];

  const visit = (currentPath) => {
    if (results.length >= maxResults) return;
    let stat;
    try { stat = fs.statSync(currentPath); } catch (_) { return; }
    if (stat.isDirectory()) {
      const dirEntries = fs.readdirSync(currentPath, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of dirEntries) {
        if (results.length >= maxResults) break;
        const absolutePath = path.join(currentPath, entry.name);
        const relativePath = workspaceRelative(absolutePath);
        if (isInternalPath(relativePath)) continue;
        visit(absolutePath);
      }
      return;
    }

    const relativePath = workspaceRelative(currentPath);
    if (isInternalPath(relativePath)) return;
    const buffer = fs.readFileSync(currentPath);
    if (isLikelyBinary(buffer)) return;
    const lines = buffer.toString('utf8').split(/\\r?\\n/);
    for (let index = 0; index < lines.length; index += 1) {
      matcher.lastIndex = 0;
      if (!matcher.test(lines[index])) continue;
      results.push({
        path: relativePath,
        line: index + 1,
        preview: truncateText(lines[index].trim(), 220)
      });
      if (results.length >= maxResults) break;
    }
  };

  visit(basePath);
  return results;
}

function runGit(args) {
  return cp.execFileSync('git', args, {
    cwd: WORKSPACE_ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });
}

function main() {
  const encoded = process.argv[2];
  const payload = JSON.parse(Buffer.from(String(encoded || ''), 'base64').toString('utf8'));
  const name = String(payload.name || '').trim();
  const input = payload.input && typeof payload.input === 'object' ? payload.input : {};
  let result = null;

  switch (name) {
    case 'list_files': {
      const targetPath = resolveWorkspacePath(input.path || '.');
      if (!targetPath || !fs.existsSync(targetPath)) throw new Error(\`Path not found: \${input.path || '.'}\`);
      result = {
        path: workspaceRelative(targetPath),
        count: 0,
        entries: listFiles(targetPath, input)
      };
      result.count = result.entries.length;
      break;
    }

    case 'read_file': {
      const targetPath = resolveWorkspacePath(input.path);
      if (!targetPath || !fs.existsSync(targetPath)) throw new Error(\`File not found: \${input.path}\`);
      const buffer = fs.readFileSync(targetPath);
      if (isLikelyBinary(buffer)) throw new Error(\`Cannot read binary file: \${input.path}\`);
      const lines = buffer.toString('utf8').split(/\\r?\\n/);
      const startLine = Math.max(1, Number(input.startLine || 1));
      const endLine = Math.max(startLine, Math.min(lines.length, Number(input.endLine || lines.length)));
      const sliced = lines.slice(startLine - 1, endLine).join('\\n');
      result = {
        path: workspaceRelative(targetPath),
        startLine,
        endLine,
        totalLines: lines.length,
        content: truncateText(formatTextWithLineNumbers(sliced, startLine), MAX_FILE_READ_CHARS)
      };
      break;
    }

    case 'search_text': {
      const matches = searchText(input);
      result = {
        pattern: input.pattern,
        count: matches.length,
        matches
      };
      break;
    }

    case 'write_file': {
      if (typeof input.path !== 'string' || typeof input.content !== 'string') {
        throw new Error('write_file requires path and content.');
      }
      const targetPath = resolveWorkspacePath(input.path);
      if (!targetPath) throw new Error(\`Invalid workspace path: \${input.path}\`);
      ensureDirSync(path.dirname(targetPath));
      fs.writeFileSync(targetPath, input.content, 'utf8');
      result = {
        path: workspaceRelative(targetPath),
        bytes: Buffer.byteLength(input.content, 'utf8'),
        status: 'written'
      };
      break;
    }

    case 'delete_path': {
      if (typeof input.path !== 'string') throw new Error('delete_path requires a path.');
      const targetPath = resolveWorkspacePath(input.path);
      if (!targetPath) throw new Error(\`Invalid workspace path: \${input.path}\`);
      const relativePath = workspaceRelative(targetPath);
      if (relativePath === '.' || isInternalPath(relativePath)) throw new Error('Refusing to delete the sandbox root or internal files.');
      if (!fs.existsSync(targetPath)) {
        result = { path: relativePath, status: 'missing' };
        break;
      }
      const stat = fs.lstatSync(targetPath);
      if (stat.isDirectory()) fs.rmSync(targetPath, { recursive: true, force: true });
      else fs.unlinkSync(targetPath);
      result = {
        path: relativePath,
        type: stat.isDirectory() ? 'directory' : 'file',
        status: 'deleted'
      };
      break;
    }

    case 'git_status': {
      result = {
        cwd: workspaceRelative(resolveWorkspacePath(input.cwd || '.') || WORKSPACE_ROOT),
        output: truncateText(runGit(['status', '--short', '--branch']), 12000)
      };
      break;
    }

    case 'git_diff': {
      const args = ['diff'];
      if (input.staged) args.push('--staged');
      result = {
        cwd: workspaceRelative(resolveWorkspacePath(input.cwd || '.') || WORKSPACE_ROOT),
        staged: Boolean(input.staged),
        output: truncateText(runGit(args), 20000)
      };
      break;
    }

    default:
      throw new Error(\`Unknown sandbox tool: \${name}\`);
  }

  process.stdout.write(JSON.stringify(result));
}

function ensureDirSync(targetPath) {
  fs.mkdirSync(targetPath, { recursive: true });
}

main();
`;
}

function writeToolRunnerFile(workspaceDir) {
  const internalDir = path.join(workspaceDir, INTERNAL_DIR_NAME);
  ensureDirSync(internalDir);
  fs.writeFileSync(path.join(workspaceDir, INTERNAL_TOOL_RUNNER), getToolRunnerSource(), 'utf8');
  const legacyRunnerPath = path.join(workspaceDir, LEGACY_INTERNAL_TOOL_RUNNER);
  try {
    if (fileExists(legacyRunnerPath)) fs.unlinkSync(legacyRunnerPath);
  } catch (_) {}
}

function parseGitStatusPorcelain(raw) {
  const changes = [];
  if (!raw) return changes;
  const parts = String(raw).split('\0').filter(Boolean);
  for (let index = 0; index < parts.length; index += 1) {
    const entry = parts[index];
    const status = entry.slice(0, 2);
    const firstPath = normalizeRelativePath(entry.slice(3));
    const code = (status[0] || status[1] || 'M').trim() || 'M';
    if ((code === 'R' || code === 'C') && parts[index + 1]) {
      const nextPath = normalizeRelativePath(parts[index + 1]);
      changes.push({
        type: code === 'R' ? 'rename' : 'copy',
        oldPath: firstPath,
        path: nextPath,
        status
      });
      index += 1;
      continue;
    }

    changes.push({
      type: code === 'A'
        ? 'add'
        : code === 'D'
          ? 'delete'
          : 'modify',
      path: firstPath,
      status
    });
  }
  return changes.filter(change => change.path && !change.path.startsWith(INTERNAL_DIR_PREFIX) && change.path !== INTERNAL_DIR_NAME);
}

function parseGitDiffNameStatus(raw) {
  const changes = [];
  if (!raw) return changes;
  const parts = String(raw).split('\0').filter(Boolean);
  for (let index = 0; index < parts.length; index += 1) {
    const entry = parts[index];
    const [statusToken, maybePath] = entry.split('\t');
    const code = String(statusToken || '').trim();
    if (!code) continue;
    if (code.startsWith('R') || code.startsWith('C')) {
      const oldPath = normalizeRelativePath(parts[index + 1] || maybePath || '');
      const newPath = normalizeRelativePath(parts[index + 2] || '');
      changes.push({
        type: code.startsWith('R') ? 'rename' : 'copy',
        oldPath,
        path: newPath,
        status: code
      });
      index += 2;
      continue;
    }
    const targetPath = normalizeRelativePath(maybePath || parts[index + 1] || '');
    changes.push({
      type: code.startsWith('A')
        ? 'add'
        : code.startsWith('D')
          ? 'delete'
          : 'modify',
      path: targetPath,
      status: code
    });
    if (!maybePath) index += 1;
  }
  return changes.filter(change => change.path && !change.path.startsWith(INTERNAL_DIR_PREFIX) && change.path !== INTERNAL_DIR_NAME);
}

class DockerSandboxManager {
  constructor(options = {}) {
    this.repoRoot = path.resolve(options.repoRoot || process.cwd());
    this.storageRoot = path.resolve(options.storageRoot || path.join(this.repoRoot, '.sandbox-state'));
    this.image = String(options.image || 'hf-ai-code-sandbox:latest').trim();
    this.networkMode = String(options.networkMode || 'none').trim() || 'none';
    this.autoBuild = options.autoBuild !== false;
    this.autoStartDocker = options.autoStartDocker !== false; // true par défaut
    this.containerNamePrefix = String(options.containerNamePrefix || 'hfai-sbx').trim() || 'hfai-sbx';
    this.dockerfilePath = path.resolve(options.dockerfilePath || path.join(this.repoRoot, 'sandbox', 'Dockerfile'));
    this.keepSandboxes = options.keepSandboxes === true;
    this.maxToolTimeoutMs = Math.max(1000, Number(options.maxToolTimeoutMs || TOOL_TIMEOUT_MS));
    this.cachedHealth = null;
    this.ensureImagePromise = null;
    ensureDirSync(this.storageRoot);
  }

  getSandboxRoot(sandboxId) {
    return path.join(this.storageRoot, sandboxId);
  }

  getWorkspaceDir(sandboxId) {
    return path.join(this.getSandboxRoot(sandboxId), 'workspace');
  }

  getMetaPath(sandboxId) {
    return path.join(this.getSandboxRoot(sandboxId), 'meta.json');
  }

  getPatchDir(sandboxId) {
    return path.join(this.getSandboxRoot(sandboxId), 'patch');
  }

  getContainerName(sandboxId) {
    return buildContainerName(this.containerNamePrefix, sandboxId);
  }

  loadSandbox(sandboxId) {
    return readJsonFile(this.getMetaPath(sandboxId), null);
  }

  saveSandbox(meta) {
    meta.updatedAt = new Date().toISOString();
    writeJsonFile(this.getMetaPath(meta.id), meta);
    return meta;
  }

  async getHealth(force = false) {
    if (!force && this.cachedHealth && (Date.now() - this.cachedHealth.checkedAt) < 5000) {
      return this.cachedHealth;
    }

    let dockerReady = false;
    let imageReady = false;
    let detail = '';
    try {
      await runProcess('docker', ['info', '--format', '{{json .ServerVersion}}'], { timeoutMs: DOCKER_CONTROL_TIMEOUT_MS });
      dockerReady = true;
    } catch (error) {
      detail = error instanceof Error ? error.message : String(error);
    }

    if (dockerReady) {
      try {
        await runProcess('docker', ['image', 'inspect', this.image], { timeoutMs: DOCKER_CONTROL_TIMEOUT_MS });
        imageReady = true;
      } catch (_) {
        imageReady = false;
      }
    }

    this.cachedHealth = {
      ok: dockerReady,
      dockerReady,
      imageReady,
      image: this.image,
      networkMode: this.networkMode,
      detail,
      checkedAt: Date.now()
    };
    return this.cachedHealth;
  }

  // Tente de démarrer Docker Desktop (Windows) ou le service docker (Linux/macOS)
  // Retourne true si Docker est disponible après la tentative, false sinon
  async tryAutoStartDocker() {
    if (!this.autoStartDocker) return false;
    const platform = process.platform;

    if (platform === 'win32') {
      // Chercher Docker Desktop.exe dans les chemins standard Windows
      const candidates = [
        process.env.ProgramFiles ? require('path').join(process.env.ProgramFiles, 'Docker', 'Docker', 'Docker Desktop.exe') : '',
        process.env.ProgramW6432 ? require('path').join(process.env.ProgramW6432, 'Docker', 'Docker', 'Docker Desktop.exe') : '',
        process.env['ProgramFiles(x86)'] ? require('path').join(process.env['ProgramFiles(x86)'], 'Docker', 'Docker', 'Docker Desktop.exe') : '',
        process.env.LocalAppData ? require('path').join(process.env.LocalAppData, 'Docker', 'Docker Desktop.exe') : ''
      ].filter(Boolean).map(p => require('path').normalize(p));

      let launched = false;
      for (const candidate of candidates) {
        try {
          if (fileExists(candidate)) {
            spawn(candidate, [], { detached: true, stdio: 'ignore' }).unref();
            launched = true;
            break;
          }
        } catch (_) {}
      }
      if (!launched) return false;
    } else if (platform === 'linux') {
      // Linux: démarrer le service dockerd
      try {
        spawn('sh', ['-c', 'sudo systemctl start docker || sudo service docker start'], { detached: true, stdio: 'ignore' }).unref();
      } catch (_) { return false; }
    } else if (platform === 'darwin') {
      // macOS: ouvrir Docker.app
      try {
        spawn('open', ['-a', 'Docker'], { detached: true, stdio: 'ignore' }).unref();
      } catch (_) { return false; }
    } else {
      return false;
    }

    // Attendre que le daemon soit prêt — polls toutes les 3s pendant max 90s
    const maxWaitMs = 90000;
    const pollIntervalMs = 3000;
    const startedAt = Date.now();
    while (Date.now() - startedAt < maxWaitMs) {
      await new Promise(r => setTimeout(r, pollIntervalMs));
      try {
        await runProcess('docker', ['info', '--format', '{{json .ServerVersion}}'], { timeoutMs: 8000 });
        return true; // Docker est prêt
      } catch (_) {
        // Pas encore prêt — on continue
      }
    }
    return false; // Timeout
  }

  async ensureReady() {
    const health = await this.getHealth(true);
    if (!health.dockerReady) {
      // Tenter de démarrer Docker automatiquement
      const started = await this.tryAutoStartDocker();
      if (!started) {
        throw new Error(
          `Docker sandbox runtime unavailable: ${health.detail || 'docker daemon is not reachable.'}\n` +
          `Assurez-vous que Docker Desktop est installé et lancez-le manuellement si l'auto-start échoue.`
        );
      }
      // Invalider le cache et ré-vérifier
      this.cachedHealth = null;
    }
    const freshHealth = await this.getHealth(true);
    if (!freshHealth.dockerReady) {
      throw new Error(`Docker sandbox runtime unavailable après tentative de démarrage automatique.`);
    }
    if (freshHealth.imageReady) return freshHealth;
    if (!this.autoBuild) {
      throw new Error(`Sandbox image "${this.image}" is missing. Build it before using the agent sandbox.`);
    }

    if (!this.ensureImagePromise) {
      this.ensureImagePromise = (async () => {
        if (!fileExists(this.dockerfilePath)) {
          throw new Error(`Sandbox Dockerfile not found: ${this.dockerfilePath}`);
        }
        const buildContext = path.dirname(this.dockerfilePath);
        await runProcess('docker', ['build', '-t', this.image, '-f', this.dockerfilePath, buildContext], {
          timeoutMs: 30 * 60 * 1000
        });
        this.cachedHealth = null;
        return this.getHealth(true);
      })();
    }

    try {
      return await this.ensureImagePromise;
    } finally {
      this.ensureImagePromise = null;
    }
  }

  async createFromWorkspace(input) {
    const sandboxId = String(input.sandboxId || `sandbox_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`);
    const rootDir = this.getSandboxRoot(sandboxId);
    const workspaceDir = this.getWorkspaceDir(sandboxId);
    ensureDirSync(rootDir);
    ensureDirSync(workspaceDir);
    await copyWorkspaceTree(path.resolve(input.sourceRoot), workspaceDir);
    return this._finalizeSandbox({
      id: sandboxId,
      rootDir,
      workspaceDir,
      sourceRoot: path.resolve(input.sourceRoot),
      createdFrom: 'workspace'
    });
  }

  async createFromFiles(input) {
    const sandboxId = String(input.sandboxId || `sandbox_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`);
    const rootDir = this.getSandboxRoot(sandboxId);
    const workspaceDir = this.getWorkspaceDir(sandboxId);
    ensureDirSync(rootDir);
    ensureDirSync(workspaceDir);
    for (const file of Array.isArray(input.files) ? input.files : []) {
      if (!file || typeof file.path !== 'string') continue;
      const relativePath = normalizeRelativePath(file.path);
      if (!relativePath || shouldIgnoreCopyPath(relativePath)) continue;
      const targetPath = path.join(workspaceDir, relativePath);
      ensureDirSync(path.dirname(targetPath));
      fs.writeFileSync(targetPath, String(file.content || ''), 'utf8');
    }
    return this._finalizeSandbox({
      id: sandboxId,
      rootDir,
      workspaceDir,
      sourceRoot: '',
      createdFrom: 'snapshot'
    });
  }

  async _finalizeSandbox(meta) {
    await this.ensureReady();
    writeToolRunnerFile(meta.workspaceDir);

    const runtimeMeta = {
      id: meta.id,
      rootDir: meta.rootDir,
      workspaceDir: meta.workspaceDir,
      sourceRoot: meta.sourceRoot || '',
      createdFrom: meta.createdFrom || 'workspace',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      state: 'prepared',
      image: this.image,
      networkMode: this.networkMode,
      containerName: this.getContainerName(meta.id),
      containerId: '',
      baselineReady: false
    };
    this.saveSandbox(runtimeMeta);
    await this.attach(runtimeMeta);
    return this.loadSandbox(meta.id);
  }

  async attach(metaOrId) {
    const meta = typeof metaOrId === 'string' ? this.loadSandbox(metaOrId) : metaOrId;
    if (!meta) throw new Error('Sandbox metadata not found.');
    await this.ensureReady();
    writeToolRunnerFile(meta.workspaceDir);

    if (meta.containerName) {
      const exists = await this._containerExists(meta.containerName);
      if (exists) {
        if (!meta.baselineReady) await this._initializeBaseline(meta);
        meta.state = 'ready';
        this.saveSandbox(meta);
        return meta;
      }
    }

    const containerName = meta.containerName || this.getContainerName(meta.id);
    try {
      await runProcess('docker', ['rm', '-f', containerName], { timeoutMs: DOCKER_CONTROL_TIMEOUT_MS });
    } catch (_) { }

    await runProcess('docker', [
      'run',
      '-d',
      '--rm',
      '--init',
      '--name',
      containerName,
      '--workdir',
      '/workspace',
      '-v',
      `${meta.workspaceDir}:/workspace`,
      '--network',
      this.networkMode,
      this.image,
      'sh',
      '-lc',
      'trap : TERM INT; while sleep 3600; do :; done'
    ], {
      timeoutMs: 120000
    });

    meta.containerName = containerName;
    meta.containerId = containerName;
    meta.state = 'container-started';
    this.saveSandbox(meta);
    await this._initializeBaseline(meta);
    meta.state = 'ready';
    this.saveSandbox(meta);
    return meta;
  }

  async _containerExists(containerName) {
    try {
      const result = await runProcess('docker', ['inspect', '-f', '{{.State.Running}}', containerName], { timeoutMs: DOCKER_CONTROL_TIMEOUT_MS });
      return String(result.stdout || '').trim() === 'true';
    } catch (_) {
      return false;
    }
  }

  async _execContainer(meta, args, options = {}) {
    const result = await runProcess('docker', ['exec', meta.containerName, ...args], {
      timeoutMs: Math.max(1000, Number(options.timeoutMs || this.maxToolTimeoutMs || TOOL_TIMEOUT_MS))
    });
    return result;
  }

  async _execContainerShell(meta, command, options = {}) {
    return this._execContainer(meta, ['sh', '-lc', command], options);
  }

  async _checkGitAvailable(meta) {
    try {
      await this._execContainer(meta, ['git', '--version'], { timeoutMs: DOCKER_CONTROL_TIMEOUT_MS });
      meta.gitAvailable = true;
      return true;
    } catch (error) {
      meta.gitAvailable = false;
      console.warn(
        `[dockerSandbox] Git is not available in sandbox ${meta.id}: ${error instanceof Error ? error.message : String(error)}. ` +
        'Falling back to file-based diff tracking.'
      );
      return false;
    }
  }

  async _validateGitState(meta) {
    const errors = [];

    if (!await this._checkGitAvailable(meta)) {
      errors.push('Git is unavailable inside sandbox container');
      return errors;
    }

    try {
      await this._execContainerShell(meta, 'cd /workspace && if [ ! -d .git ]; then git init -q; fi', { timeoutMs: 30000 });
      const isRepo = String((await this._execContainer(meta, ['git', 'rev-parse', '--git-dir'], { timeoutMs: 30000 })).stdout || '');
      if (!String(isRepo).trim()) {
        errors.push('Git directory is not initialized');
      }
    } catch (error) {
      errors.push(`Failed to verify git repository state: ${error instanceof Error ? error.message : String(error)}`);
    }

    try {
      await this._execContainer(meta, ['git', 'status', '--porcelain'], { timeoutMs: 30000 });
    } catch (error) {
      errors.push(`Git status check failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    return errors;
  }

  async _createFileBasedSnapshot(meta) {
    const snapshotDir = path.join(meta.workspaceDir, INTERNAL_DIR_NAME, 'file-snapshots');
    ensureDirSync(snapshotDir);

    const snapshotMeta = {
      sandboxId: meta.id,
      createdAt: new Date().toISOString(),
      files: {}
    };

    const workspaceDir = meta.workspaceDir;
    const walkDir = (dirPath, relativeBase = '') => {
      let entries = [];
      try {
        entries = fs.readdirSync(dirPath, { withFileTypes: true });
      } catch (_) {
        return;
      }

      for (const entry of entries) {
        if (entry.name === INTERNAL_DIR_NAME) continue;
        const fullPath = path.join(dirPath, entry.name);
        const relativePath = relativeBase ? `${relativeBase}/${entry.name}` : entry.name;

        if (entry.isDirectory()) {
          walkDir(fullPath, relativePath);
        } else if (entry.isFile()) {
          try {
            const content = fs.readFileSync(fullPath, 'utf8');
            const hash = crypto.createHash('sha256').update(content).digest('hex');
            snapshotMeta.files[relativePath] = {
              hash,
              size: Buffer.byteLength(content, 'utf8'),
              capturedAt: new Date().toISOString()
            };
          } catch (_) {
            // Skip files that can't be read (e.g., binary or permission issues)
          }
        }
      }
    };

    walkDir(workspaceDir);

    const snapshotPath = path.join(snapshotDir, 'baseline.json');
    writeJsonFile(snapshotPath, snapshotMeta);
    meta.fileSnapshotPath = snapshotPath;
    meta.baselineReady = true;
    meta.baselineMethod = 'file-snapshot';
    this.saveSandbox(meta);

    console.warn(
      `[dockerSandbox] File-based baseline created for sandbox ${meta.id}: ` +
      `${Object.keys(snapshotMeta.files).length} files captured.`
    );
  }

  async _initializeBaseline(meta) {
    if (meta.baselineReady) return;

    await this._checkGitAvailable(meta);

    if (!meta.gitAvailable) {
      await this._createFileBasedSnapshot(meta);
      return;
    }

    const initCommands = [
      'if [ ! -d .git ]; then git init -q; fi',
      `git config user.email '${escapeShellSingleQuotes('sandbox@hf-ai-code.invalid')}'`,
      `git config user.name '${escapeShellSingleQuotes('HF AI Sandbox')}'`,
      'git add -A',
      'git commit --allow-empty -qm "Sandbox baseline"'
    ];

    try {
      const validationErrors = await this._validateGitState(meta);
      if (validationErrors.length > 0) {
        console.warn(
          `[dockerSandbox] Git state validation warnings for sandbox ${meta.id}:`,
          validationErrors.join('; ')
        );
      }

      await this._execContainerShell(meta, `cd /workspace && ${initCommands.join(' && ')}`, { timeoutMs: 120000 });

      fs.writeFileSync(
        path.join(meta.workspaceDir, INTERNAL_METADATA_FILE),
        JSON.stringify({
          sandboxId: meta.id,
          createdAt: meta.createdAt,
          image: meta.image
        }, null, 2),
        'utf8'
      );

      meta.baselineReady = true;
      meta.baselineMethod = 'git';
      meta.baseRef = String((await this._execContainer(meta, ['git', 'rev-parse', 'HEAD'], { timeoutMs: 30000 })).stdout || '').trim();
      meta.lastCommittedRef = meta.baseRef;
      this.saveSandbox(meta);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(
        `[dockerSandbox] Git baseline initialization failed for sandbox ${meta.id}: ${errorMessage}. ` +
        'Falling back to file-based diff tracking.'
      );

      meta.gitAvailable = false;
      await this._createFileBasedSnapshot(meta);
    }
  }

  async execTool(metaOrId, toolCall, options = {}) {
    const meta = typeof metaOrId === 'string' ? this.loadSandbox(metaOrId) : metaOrId;
    if (!meta) throw new Error('Sandbox metadata not found.');
    await this.attach(meta);

    if (String(toolCall.name || '') === 'run_shell') {
      return this.execShell(meta, String(toolCall.input?.command || ''), toolCall.input?.cwd || '.', options);
    }

    const payload = Buffer.from(JSON.stringify({
      name: toolCall.name,
      input: toolCall.input || {}
    }), 'utf8').toString('base64');
    const result = await runProcess('docker', [
      'exec',
      meta.containerName,
      'node',
      `/workspace/${INTERNAL_TOOL_RUNNER}`,
      payload
    ], {
      timeoutMs: Math.max(1000, Math.min(this.maxToolTimeoutMs, Number(options.timeoutMs || this.maxToolTimeoutMs))),
      runtimeState: options.runtimeState
    });
    const stdout = String(result.stdout || '').trim();
    return stdout ? JSON.parse(stdout) : null;
  }

  async execShell(metaOrId, command, cwd = '.', options = {}) {
    const meta = typeof metaOrId === 'string' ? this.loadSandbox(metaOrId) : metaOrId;
    if (!meta) throw new Error('Sandbox metadata not found.');
    await this.attach(meta);
    if (!String(command || '').trim()) throw new Error('run_shell requires a command.');

    const relativeCwd = normalizeRelativePath(cwd || '.') || '.';
    const shellScript = [
      `cd '${escapeShellSingleQuotes(relativeCwd === '.' ? '/workspace' : `/workspace/${relativeCwd}`)}'`,
      command
    ].join(' && ');

    const result = await runProcess('docker', [
      'exec',
      meta.containerName,
      'sh',
      '-lc',
      shellScript
    ], {
      timeoutMs: Math.max(1000, Math.min(this.maxToolTimeoutMs, Number(options.timeoutMs || this.maxToolTimeoutMs))),
      runtimeState: options.runtimeState
    });

    return {
      exitCode: 0,
      stdout: truncateText(result.stdout || '', MAX_TOOL_STDOUT_CHARS),
      stderr: truncateText(result.stderr || '', MAX_TOOL_STDOUT_CHARS)
    };
  }

  async getGitOutput(metaOrId, args, options = {}) {
    const meta = typeof metaOrId === 'string' ? this.loadSandbox(metaOrId) : metaOrId;
    if (!meta) throw new Error('Sandbox metadata not found.');
    await this.attach(meta);
    const result = await runProcess('docker', ['exec', meta.containerName, 'git', ...args], {
      timeoutMs: Math.max(1000, Math.min(this.maxToolTimeoutMs, Number(options.timeoutMs || this.maxToolTimeoutMs)))
    });
    return String(result.stdout || '');
  }

  async getHeadRef(metaOrId) {
    return String(await this.getGitOutput(metaOrId, ['rev-parse', 'HEAD'])).trim();
  }

  async commitCheckpoint(metaOrId, message = 'sandbox checkpoint') {
    const meta = typeof metaOrId === 'string' ? this.loadSandbox(metaOrId) : metaOrId;
    if (!meta) throw new Error('Sandbox metadata not found.');
    await this.attach(meta);

    if (meta.baselineMethod === 'file-snapshot' || !meta.gitAvailable) {
      await this._createFileBasedSnapshot(meta);
      meta.lastCommittedRef = `file-snapshot-${Date.now()}`;
      this.saveSandbox(meta);
      return meta.lastCommittedRef;
    }

    await this.execShell(meta, [
      'git add -A',
      `git commit --allow-empty -qm '${escapeShellSingleQuotes(message)}'`
    ].join(' && '), '.', { timeoutMs: 120000 });
    meta.lastCommittedRef = await this.getHeadRef(meta);
    this.saveSandbox(meta);
    return meta.lastCommittedRef;
  }

  async restoreToRef(metaOrId, gitRef) {
    const meta = typeof metaOrId === 'string' ? this.loadSandbox(metaOrId) : metaOrId;
    if (!meta) throw new Error('Sandbox metadata not found.');
    if (!gitRef) return meta;

    if (meta.baselineMethod === 'file-snapshot' || !meta.gitAvailable) {
      console.warn(
        `[dockerSandbox] Cannot restore git ref in file-snapshot mode for sandbox ${meta.id}. ` +
        'Git is not available in this sandbox.'
      );
      return meta;
    }

    await this.attach(meta);
    await this.execShell(meta, [
      `git reset --hard '${escapeShellSingleQuotes(gitRef)}'`,
      'git clean -fd'
    ].join(' && '), '.', { timeoutMs: 120000 });
    meta.lastCommittedRef = gitRef;
    meta.state = 'ready';
    this.saveSandbox(meta);
    return meta;
  }

  async collectPatch(metaOrId) {
    const meta = typeof metaOrId === 'string' ? this.loadSandbox(metaOrId) : metaOrId;
    if (!meta) throw new Error('Sandbox metadata not found.');
    await this.attach(meta);

    if (meta.baselineMethod === 'file-snapshot' || !meta.gitAvailable) {
      return this._collectFileBasedPatch(meta);
    }

    const currentRef = await this.commitCheckpoint(meta, `finalize-${meta.id}`);
    const baseRef = meta.baseRef || currentRef;
    const rawStatus = await this.getGitOutput(meta, ['diff', '--name-status', '--find-renames', '-z', baseRef, currentRef]);
    const parsed = parseGitDiffNameStatus(rawStatus);
    if (!parsed.length) {
      return {
        sandboxId: meta.id,
        diffText: '',
        files: [],
        summary: 'No workspace changes were produced inside the sandbox.'
      };
    }

    const diffText = await this.getGitOutput(meta, ['diff', '--binary', '--no-color', baseRef, currentRef]);
    const files = [];
    for (const change of parsed) {
      if (change.path && (change.path.startsWith(INTERNAL_DIR_PREFIX) || change.path === INTERNAL_DIR_NAME)) continue;

      const beforeText = await this._readBeforeText(meta, change, baseRef);
      const afterText = await this._readAfterText(meta, change);
      if (change.type === 'rename') {
        files.push({
          type: 'rename',
          path: change.path,
          oldPath: change.oldPath,
          beforeText,
          afterText
        });
        continue;
      }
      files.push({
        type: change.type,
        path: change.path,
        beforeText,
        afterText
      });
    }

    return {
      sandboxId: meta.id,
      diffText,
      files,
      summary: `${files.length} file change(s) ready for host review`
    };
  }

  async _collectFileBasedPatch(meta) {
    const snapshotDir = path.join(meta.workspaceDir, INTERNAL_DIR_NAME, 'file-snapshots');
    const baselinePath = path.join(snapshotDir, 'baseline.json');
    const baselineMeta = readJsonFile(baselinePath, null);

    if (!baselineMeta || !baselineMeta.files) {
      return {
        sandboxId: meta.id,
        diffText: '',
        files: [],
        summary: 'No file-based baseline was captured for this sandbox.'
      };
    }

    const files = [];
    const diffParts = [];

    for (const [relativePath, fileMeta] of Object.entries(baselineMeta.files)) {
      if (relativePath.startsWith(INTERNAL_DIR_PREFIX) || relativePath === INTERNAL_DIR_NAME) continue;

      const fullPath = path.join(meta.workspaceDir, relativePath);
      if (!fileExists(fullPath)) {
        continue;
      }

      try {
        const currentContent = fs.readFileSync(fullPath, 'utf8');
        const currentHash = crypto.createHash('sha256').update(currentContent).digest('hex');

        if (currentHash !== fileMeta.hash) {
          files.push({
            type: 'modify',
            path: relativePath,
            beforeText: null,
            afterText: currentContent
          });
          diffParts.push(`--- a/${relativePath}\n+++ b/${relativePath}\n@@ file modified @@`);
        }
      } catch (_) {
        // Skip files that can't be read
      }
    }

    const workspaceDir = meta.workspaceDir;
    const walkCurrentFiles = (dirPath, relativeBase = '') => {
      let entries = [];
      try {
        entries = fs.readdirSync(dirPath, { withFileTypes: true });
      } catch (_) {
        return;
      }

      for (const entry of entries) {
        if (entry.name === INTERNAL_DIR_NAME) continue;
        const fullPath = path.join(dirPath, entry.name);
        const relativePath = relativeBase ? `${relativeBase}/${entry.name}` : entry.name;

        if (entry.isDirectory()) {
          walkCurrentFiles(fullPath, relativePath);
        } else if (entry.isFile() && !baselineMeta.files[relativePath]) {
          try {
            const content = fs.readFileSync(fullPath, 'utf8');
            files.push({
              type: 'add',
              path: relativePath,
              beforeText: null,
              afterText: content
            });
            diffParts.push(`--- /dev/null\n+++ b/${relativePath}\n@@ new file @@`);
          } catch (_) {
            // Skip unreadable files
          }
        }
      }
    };

    walkCurrentFiles(workspaceDir);

    return {
      sandboxId: meta.id,
      diffText: diffParts.join('\n\n'),
      files,
      summary: `${files.length} file change(s) ready for host review (file-based tracking)`
    };
  }

  async _readBeforeText(meta, change, baseRef) {
    if (change.type === 'add' || change.type === 'copy') return null;
    const gitPath = normalizeRelativePath(change.oldPath || change.path);
    try {
      return await this.getGitOutput(meta, ['show', `${baseRef}:${gitPath}`]);
    } catch (_) {
      return null;
    }
  }

  async _readAfterText(meta, change) {
    if (change.type === 'delete') return null;
    const relativePath = normalizeRelativePath(change.path);
    const targetPath = path.join(meta.workspaceDir, relativePath);
    if (!fileExists(targetPath)) return null;
    return fs.readFileSync(targetPath, 'utf8');
  }

  async stop(metaOrId) {
    const meta = typeof metaOrId === 'string' ? this.loadSandbox(metaOrId) : metaOrId;
    if (!meta) return;
    try {
      await runProcess('docker', ['rm', '-f', meta.containerName], { timeoutMs: 20000 });
    } catch (_) { }
    meta.state = 'stopped';
    meta.containerId = '';
    this.saveSandbox(meta);
  }

  async destroy(metaOrId, options = {}) {
    const meta = typeof metaOrId === 'string' ? this.loadSandbox(metaOrId) : metaOrId;
    if (!meta) return;
    await this.stop(meta);
    if (options.removeDir !== false) {
      try { fs.rmSync(meta.rootDir, { recursive: true, force: true }); } catch (_) { }
    }
  }
}

module.exports = {
  DockerSandboxManager,
  INTERNAL_DIR_NAME,
  INTERNAL_TOOL_RUNNER
};
