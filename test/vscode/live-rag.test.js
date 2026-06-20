const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vscode = require('vscode');

async function sleep(ms) {
  await new Promise(resolve => setTimeout(resolve, ms));
}

async function configureExtension() {
  const config = vscode.workspace.getConfiguration('localai');
  const configuredModelId = String(process.env.LOCALAI_MODEL_ID || '').trim() || 'auto';
  await config.update('baseUrl', process.env.LOCALAI_BASE_URL || 'http://127.0.0.1:1234/v1', vscode.ConfigurationTarget.Global);
  await config.update('nativeBaseUrl', process.env.LOCALAI_NATIVE_BASE_URL || 'http://127.0.0.1:1234', vscode.ConfigurationTarget.Global);
  await config.update('modelId', configuredModelId, vscode.ConfigurationTarget.Global);
  await config.update('sendFileContext', false, vscode.ConfigurationTarget.Global);
  await config.update('agent.enabled', false, vscode.ConfigurationTarget.Global);
  await config.update('memory.enabled', true, vscode.ConfigurationTarget.Global);
  await config.update('rag.enabled', true, vscode.ConfigurationTarget.Global);
  await config.update('rag.mode', 'hybrid-local', vscode.ConfigurationTarget.Global);
  await config.update('rag.embeddingModel', process.env.LOCALAI_EMBEDDING_MODEL || 'auto', vscode.ConfigurationTarget.Global);
  await config.update('rag.topK', 6, vscode.ConfigurationTarget.Global);
}

exports.run = async function run() {
  const workspaceFolder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
  assert(workspaceFolder, 'Expected a workspace folder for live integration tests.');

  const extension = vscode.extensions.getExtension('localai.localai-code');
  assert(extension, 'Extension localai.localai-code was not found.');

  const api = await extension.activate();
  assert(api && api.testing, 'Testing API was not returned by extension activation.');

  await configureExtension();
  await api.testing.initialize();
  console.log('[localai-code:test] Extension initialized.');
  console.log(`[localai-code:test] Configured LM Studio model: ${configuredModelId}`);

  const connectionOk = await api.testing.checkConnection();
  assert.strictEqual(connectionOk, true, 'LM Studio connection failed in the extension host.');
  console.log('[localai-code:test] LM Studio connection OK.');

  const notesPath = path.join(workspaceFolder.uri.fsPath, 'src', 'notes.js');
  const notesDoc = await vscode.workspace.openTextDocument(notesPath);
  await vscode.window.showTextDocument(notesDoc);

  await api.testing.forceRebuildRag();
  const ragStatus = await api.testing.waitForRagReady(180000);
  assert.strictEqual(ragStatus.state, 'ready', `RAG index did not become ready. Last error: ${ragStatus.lastError || '(none)'}`);
  assert(ragStatus.chunkCount > 0, 'RAG index contains no chunks after rebuild.');
  console.log(`[localai-code:test] RAG ready with ${ragStatus.chunkCount} chunks across ${ragStatus.fileCount} files.`);

  const expectedTerm = process.env.LOCALAI_CODE_EXPECTED_TERM;
  const expectedFile = process.env.LOCALAI_CODE_EXPECTED_FILE;
  assert(expectedTerm && expectedFile, 'Expected live test metadata is missing.');

  const searchResult = await api.testing.searchWorkspace(expectedTerm, ['src/notes.js']);
  assert(searchResult.snippets.length > 0, 'Workspace retrieval returned no snippets for the expected term.');
  assert.strictEqual(searchResult.usedSemantic, true, 'Semantic retrieval path did not activate.');
  assert(
    searchResult.snippets.some(snippet => snippet.path === expectedFile),
    `Expected semantic target ${expectedFile} not found in retrieval results: ${JSON.stringify(searchResult.snippets, null, 2)}`
  );
  console.log(`[localai-code:test] Semantic retrieval active. Top snippet: ${searchResult.snippets[0].path}`);

  const prompt = [
    `Based only on the workspace retrieval context, answer with exactly the relative file path that contains the identifier "${expectedTerm}".`,
    'Do not explain.',
    'Do not use markdown.'
  ].join(' ');

  const result = await api.testing.sendPrompt(prompt, { includeFile: false });
  assert(result.assistantText, 'Assistant response is empty.');
  assert(
    result.assistantText.toLowerCase().includes(expectedFile.toLowerCase()),
    `Assistant did not return the expected file path.\nExpected: ${expectedFile}\nActual: ${result.assistantText}`
  );
  console.log(`[localai-code:test] Assistant replied: ${result.assistantText}`);

  const antiAudit = api.testing.evaluateAntiHallucination('fais un audit complet du projet', 'Affirmation: X\nVerdict: CONFIRMED\nEvidence: src/index.js\nCritical comment: ok', result.messages, result.contextMeta);
  assert.strictEqual(antiAudit.intentContext.intent, 'audit', `Expected audit intent, got ${JSON.stringify(antiAudit.intentContext)}`);
  assert.strictEqual(antiAudit.intentContext.strictAuditMode, true, `Expected strict audit mode, got ${JSON.stringify(antiAudit.intentContext)}`);
  assert.strictEqual(antiAudit.validation.status, 'passed', `Expected audit validation to pass, got ${JSON.stringify(antiAudit.validation)}`);

  const antiSecurity = api.testing.evaluateAntiHallucination('security review of auth and xss', 'Short summary only', result.messages, result.contextMeta);
  assert.strictEqual(antiSecurity.intentContext.intent, 'security', `Expected security intent, got ${JSON.stringify(antiSecurity.intentContext)}`);
  assert.notStrictEqual(antiSecurity.validation.status, 'passed', 'Expected incomplete security response to trigger validation warnings.');
  console.log(`[localai-code:test] Anti-hallucination checks: audit=${antiAudit.validation.status} security=${antiSecurity.validation.status}`);

  const contextMeta = result.contextMeta || {};
  assert(contextMeta.ragSnippets > 0, `Expected retrieved snippets in context meta, got ${JSON.stringify(contextMeta)}`);
  assert.strictEqual(contextMeta.ragMode, 'hybrid', `Expected hybrid rag mode, got ${JSON.stringify(contextMeta)}`);

  const firstSnapshot = api.testing.getUiSnapshot();
  assert(firstSnapshot.messages.length >= 2, 'Persistent chat history did not record the user and assistant messages.');

  const sandboxStatus = await api.testing.getSandboxStatus();
  let finishedTask = null;
  let backgroundTaskSkipped = '';
  if (sandboxStatus.ok) {
    const backgroundTask = await api.testing.createBackgroundTask('Reply with exactly BG_OK', { title: 'Background smoke task' });
    assert(backgroundTask && backgroundTask.id, 'Background task was not created.');
    finishedTask = await api.testing.waitForTask(backgroundTask.id, 180000);
    assert.strictEqual(finishedTask.status, 'completed', `Background task did not complete successfully: ${JSON.stringify(finishedTask, null, 2)}`);
    assert(
      String(finishedTask.resultText || '').includes('BG_OK'),
      `Background task result did not contain BG_OK: ${finishedTask.resultText}`
    );
    console.log(`[localai-code:test] Background task completed: ${finishedTask.id}`);
  } else {
    backgroundTaskSkipped = sandboxStatus.detail || 'Sandbox runtime unavailable for background task execution.';
    console.log(`[localai-code:test] Background task skipped: ${backgroundTaskSkipped}`);
  }

  await api.testing.createChat('Live Test Secondary Chat');
  const secondSnapshot = api.testing.getUiSnapshot();
  assert(secondSnapshot.chats.length >= 2, 'Creating a second chat did not persist in the chat index.');
  console.log(`[localai-code:test] Multi-chat persistence OK (${secondSnapshot.chats.length} chats).`);

  const resultPath = path.join(workspaceFolder.uri.fsPath, 'live-test-result.json');
  fs.writeFileSync(resultPath, JSON.stringify({
    connectionOk,
    ragStatus,
    sandboxStatus,
    retrievalTopPath: searchResult.snippets[0].path,
    retrievalUsedSemantic: searchResult.usedSemantic,
    assistantText: result.assistantText,
    backgroundTaskId: finishedTask ? finishedTask.id : '',
    backgroundTaskStatus: finishedTask ? finishedTask.status : 'skipped',
    backgroundTaskSkipped,
    contextMeta,
    chatCount: secondSnapshot.chats.length,
    messageCount: firstSnapshot.messages.length
  }, null, 2));

  await sleep(250);
};
