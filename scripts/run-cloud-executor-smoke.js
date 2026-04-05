'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const https = require('https');
const { spawn } = require('child_process');

const port = Number(process.env.CLOUD_EXECUTOR_TEST_PORT || 7791);
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localai-cloud-executor-'));

function requestJson(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : '';
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: urlPath,
      method,
      headers: payload
        ? {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload)
          }
        : {}
    }, (res) => {
      let raw = '';
      res.on('data', chunk => raw += chunk.toString());
      res.on('end', () => {
        try {
          resolve({
            statusCode: res.statusCode || 0,
            data: raw ? JSON.parse(raw) : {}
          });
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function waitForHealth(timeoutMs = 20000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await requestJson('GET', '/health');
      if (response.statusCode === 200 && response.data && response.data.ok) return response.data;
    } catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error('Timed out waiting for cloud executor health check.');
}

async function waitForTask(taskId, timeoutMs = 180000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const response = await requestJson('GET', `/tasks/${encodeURIComponent(taskId)}`);
    if (response.statusCode === 200 && response.data && response.data.task) {
      const task = response.data.task;
      if (['completed', 'failed', 'stopped'].includes(task.status)) return task;
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error(`Timed out waiting for remote task ${taskId}`);
}

function getJsonClient(urlObject) {
  return urlObject.protocol === 'https:' ? https : http;
}

function getModelsUrl(baseUrl) {
  const normalized = String(baseUrl || 'http://127.0.0.1:1234/v1').replace(/\/+$/, '');
  return normalized.endsWith('/v1') ? `${normalized}/models` : `${normalized}/v1/models`;
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

function pickChatModel(models) {
  const candidates = Array.isArray(models) ? models : [];
  return candidates.find(id => !/\b(embed|embedding|bge|e5|gte|nomic|snowflake)\b/i.test(String(id || ''))) || '';
}

function buildSystemPrompt() {
  return [
    'You are an autonomous coding agent in an isolated remote workspace snapshot.',
    'Use tool tags when you need to inspect files or run commands.',
    'Tool format:',
    '<localai-tool name="read_file">{"path":"src/answer.txt"}</localai-tool>',
    'Available tools:',
    '- list_files',
    '- read_file',
    '- search_text',
    '- write_file',
    '- delete_path',
    '- run_shell',
    'When the task is complete, answer normally without tool tags.'
  ].join('\n');
}

async function main() {
  const child = spawn(process.execPath, ['cloud-executor/server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(port),
      CLOUD_EXECUTOR_DATA_DIR: dataDir
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let serverOutput = '';
  child.stdout.on('data', chunk => serverOutput += chunk.toString());
  child.stderr.on('data', chunk => serverOutput += chunk.toString());

  try {
    const health = await waitForHealth();
    console.log(`health ok: ${health.mode}`);

    if (!health.sandbox || !health.sandbox.dockerReady) {
      console.log(`Skipping cloud executor task smoke test: Docker sandbox is unavailable${health.sandbox && health.sandbox.detail ? ` (${health.sandbox.detail})` : '.'}`);
      return;
    }

    const modelBaseUrl = process.env.LOCALAI_BASE_URL || 'http://127.0.0.1:1234/v1';
    if (!await checkLocalAIReachable(modelBaseUrl)) {
      console.log(`Skipping cloud executor task smoke test: LM Studio is not reachable at ${getModelsUrl(modelBaseUrl)}.`);
      return;
    }

    let resolvedModelId = String(process.env.LOCALAI_MODEL_ID || '').trim();
    if (!resolvedModelId || resolvedModelId === 'auto') {
      try {
        resolvedModelId = pickChatModel(await fetchLocalAIModels(modelBaseUrl));
      } catch (error) {
        console.warn(`Warning: failed to resolve a chat-capable LM Studio model automatically: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (!resolvedModelId) {
      console.log('Skipping cloud executor task smoke test: no chat-capable LM Studio model appears to be loaded.');
      return;
    }

    const createResponse = await requestJson('POST', '/tasks', {
      title: 'Smoke Task',
      prompt: 'Read src/answer.txt and reply with its exact contents.',
      workspaceName: 'smoke-workspace',
      modelId: resolvedModelId,
      temperature: 0,
      maxTokens: 256,
      maxRounds: 2,
      shellTimeoutMs: 15000,
      toolTimeoutMs: 60000,
      files: [
        { path: 'src/answer.txt', content: 'remote ok' },
        { path: 'package.json', content: '{\"name\":\"remote-smoke\",\"version\":\"1.0.0\"}' }
      ],
      messages: [
        { role: 'system', content: buildSystemPrompt() },
        { role: 'user', content: 'Read src/answer.txt and reply with its exact contents.' }
      ],
      lmStudio: {
        baseUrl: modelBaseUrl,
        nativeBaseUrl: process.env.LOCALAI_NATIVE_BASE_URL || 'http://127.0.0.1:1234'
      }
    });
    if (createResponse.statusCode !== 201 || !createResponse.data || !createResponse.data.task) {
      throw new Error(`Unexpected task creation response: ${JSON.stringify(createResponse.data)}`);
    }

    console.log(`task created: ${createResponse.data.task.id} using model ${resolvedModelId}`);
    const task = await waitForTask(createResponse.data.task.id);
    console.log(`task status: ${task.status}`);
    if (task.status !== 'completed') {
      throw new Error(`Cloud task failed: ${task.error || task.status}`);
    }
    if (!String(task.resultText || '').toLowerCase().includes('remote ok')) {
      throw new Error(`Unexpected cloud task result: ${task.resultText || ''}`);
    }
    console.log('cloud executor smoke test passed');
  } finally {
    try { child.kill(); } catch (_) {}
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (_) {}
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
