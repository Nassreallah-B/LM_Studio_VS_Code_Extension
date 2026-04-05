const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const http = require('http');
const https = require('https');

function quoteArg(value) {
  const text = String(value);
  if (!/[ \t"]/u.test(text)) return text;
  return `"${text.replace(/"/g, '\\"')}"`;
}

function quotePowerShell(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

async function waitForPath(targetPath, timeoutMs = 5000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (fs.existsSync(targetPath)) return true;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  return fs.existsSync(targetPath);
}

async function waitForLogMarkers(targetPath, marker, timeoutMs = 10000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (fs.existsSync(targetPath)) {
      const content = fs.readFileSync(targetPath, 'utf8');
      const lines = content.split(/\r?\n/).filter(line => line.includes(marker));
      if (lines.length) return lines;
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }

  if (!fs.existsSync(targetPath)) return [];
  return fs.readFileSync(targetPath, 'utf8')
    .split(/\r?\n/)
    .filter(line => line.includes(marker));
}

async function runVsCodeTests(executablePath, args) {
  await new Promise((resolve, reject) => {
    const child = process.platform === 'win32'
      ? cp.spawn('powershell.exe', [
        '-NoProfile',
        '-Command',
        `& ${quotePowerShell(executablePath)} ${args.map(quotePowerShell).join(' ')}`
      ], {
        stdio: 'inherit',
        shell: false,
        env: process.env
      })
      : cp.spawn(executablePath, args, {
        stdio: 'inherit',
        shell: false,
        env: process.env
      });

    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(signal ? `VS Code test run terminated with signal ${signal}` : `VS Code test run failed with code ${code}`));
    });
  });
}

function getJsonClient(urlObject) {
  return urlObject.protocol === 'https:' ? https : http;
}

function getModelsUrl(baseUrl) {
  const normalized = String(baseUrl || 'http://127.0.0.1:1234/v1').replace(/\/+$/, '');
  return normalized.endsWith('/v1') ? `${normalized}/models` : `${normalized}/v1/models`;
}

async function fetchLocalAIModels(baseUrl, timeoutMs = 8000) {
  const target = new URL(getModelsUrl(baseUrl));
  return new Promise((resolve, reject) => {
    const req = getJsonClient(target).request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method: 'GET',
      timeout: timeoutMs
    }, (res) => {
      let raw = '';
      res.on('data', chunk => raw += chunk.toString());
      res.on('end', () => {
        if ((res.statusCode || 0) < 200 || (res.statusCode || 0) >= 300) {
          reject(new Error(`LM Studio models endpoint returned ${res.statusCode || 0}`));
          return;
        }
        try {
          const parsed = JSON.parse(raw);
          const models = Array.isArray(parsed?.data) ? parsed.data.map(entry => entry?.id).filter(Boolean) : [];
          resolve(models);
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('LM Studio models request timeout'));
    });
    req.on('error', reject);
    req.end();
  });
}

async function checkLocalAIReachable(baseUrl, timeoutMs = 4000) {
  const target = new URL(getModelsUrl(baseUrl));
  return new Promise((resolve) => {
    const req = getJsonClient(target).request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method: 'GET',
      timeout: timeoutMs
    }, (res) => {
      res.resume();
      resolve((res.statusCode || 0) >= 200 && (res.statusCode || 0) < 500);
    });
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.on('error', () => resolve(false));
    req.end();
  });
}

function pickChatModel(models) {
  const candidates = Array.isArray(models) ? models : [];
  return candidates.find(id => !/\b(embed|embedding|bge|e5|gte|nomic|snowflake)\b/i.test(String(id || ''))) || '';
}

async function main() {
  const repoRoot = path.resolve(__dirname, '..');
  const installedCodePath = process.platform === 'win32'
    ? path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Microsoft VS Code', 'bin', 'code.cmd')
    : '';
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localai-code-live-'));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localai-code-user-'));
  const extensionsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localai-code-exts-'));
  const logsPath = fs.mkdtempSync(path.join(os.tmpdir(), 'localai-code-logs-'));
  const srcDir = path.join(workspaceDir, 'src');
  const modelBaseUrl = process.env.LOCALAI_BASE_URL || 'http://127.0.0.1:1234/v1';

  if (!fs.existsSync(installedCodePath)) {
    console.log(`[localai-code] Skipping live VS Code tests: VS Code executable was not found at ${installedCodePath}.`);
    return;
  }

  if (!await checkLocalAIReachable(modelBaseUrl)) {
    console.log(`[localai-code] Skipping live VS Code tests: LM Studio is not reachable at ${getModelsUrl(modelBaseUrl)}.`);
    return;
  }

  let resolvedModelId = String(process.env.LOCALAI_MODEL_ID || '').trim();
  if (!resolvedModelId || resolvedModelId === 'auto') {
    try {
      const availableModels = await fetchLocalAIModels(modelBaseUrl);
      resolvedModelId = pickChatModel(availableModels);
    } catch (error) {
      console.warn(`[localai-code] Warning: failed to resolve a chat model automatically: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (!resolvedModelId) {
    console.log('[localai-code] Skipping live VS Code tests: no chat-capable LM Studio model appears to be loaded.');
    return;
  }

  fs.mkdirSync(srcDir, { recursive: true });

  const expectedTerm = 'hyperfluxSemaphore';
  const expectedFile = 'src/semantic-target.js';

  fs.writeFileSync(
    path.join(srcDir, 'semantic-target.js'),
    [
      'export function loadSemanticTarget() {',
      '  const hyperfluxSemaphore = "Photon orchard retrieval pipeline";',
      '  return hyperfluxSemaphore;',
      '}',
      ''
    ].join('\n'),
    'utf8'
  );

  fs.writeFileSync(
    path.join(srcDir, 'notes.js'),
    [
      'export const miscNote = "This file is intentionally unrelated to the semantic target.";',
      ''
    ].join('\n'),
    'utf8'
  );

  fs.writeFileSync(
    path.join(workspaceDir, 'README.md'),
    [
      '# Live Test Workspace',
      '',
      'This workspace is generated automatically for LocalAI Code live integration tests.',
      ''
    ].join('\n'),
    'utf8'
  );

  process.env.LOCALAI_CODE_EXPECTED_TERM = expectedTerm;
  process.env.LOCALAI_CODE_EXPECTED_FILE = expectedFile;
  process.env.LOCALAI_CODE_TEST_WORKSPACE = workspaceDir;
  process.env.LOCALAI_MODEL_ID = resolvedModelId;

  console.log(`[localai-code] Live test workspace: ${workspaceDir}`);
  console.log(`[localai-code] Expected semantic target: ${expectedFile} (${expectedTerm})`);
  console.log(`[localai-code] VS Code logs: ${logsPath}`);
  console.log(`[localai-code] Using LM Studio model: ${resolvedModelId}`);

  await runVsCodeTests(installedCodePath, [
    '--no-sandbox',
    '--disable-gpu-sandbox',
    '--disable-updates',
    '--skip-welcome',
    '--skip-release-notes',
    '--disable-workspace-trust',
    `--extensionTestsPath=${path.join(repoRoot, 'test', 'vscode')}`,
    `--extensionDevelopmentPath=${repoRoot}`,
    '--user-data-dir',
    userDataDir,
    '--extensions-dir',
    extensionsDir,
    '--logsPath',
    logsPath,
    '--new-window',
    workspaceDir
  ]);

  const resultPath = path.join(workspaceDir, 'live-test-result.json');
  await waitForPath(resultPath, 1500);
  if (fs.existsSync(resultPath)) {
    const result = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
    console.log(`[localai-code] Live test result: ${JSON.stringify(result)}`);
  } else {
    const rendererLogPath = path.join(logsPath, 'window1', 'renderer.log');
    await waitForPath(rendererLogPath, 3000);
    if (fs.existsSync(rendererLogPath)) {
      const extracted = (await waitForLogMarkers(rendererLogPath, '[localai-code:test]', 10000))
        .map(line => line.replace(/^.*\[info\]\s*/, ''));
      if (extracted.length) {
        console.log('[localai-code] Live test confirmations:');
        for (const line of extracted) console.log(`- ${line}`);
      } else {
        console.warn(`[localai-code] Warning: no structured test confirmations were found in ${rendererLogPath}`);
      }
    } else {
      console.warn(`[localai-code] Warning: live test did not produce ${resultPath} or ${rendererLogPath}`);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
