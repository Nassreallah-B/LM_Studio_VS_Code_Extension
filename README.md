# LocalAI Code

LocalAI Code est une extension VS Code orientee agent de code, branchée sur LM Studio. Elle combine chat persistant, mémoire durable, RAG workspace, tâches agent, sandbox Docker, patch review et exécution cloud optionnelle.

## Ce que fait l'extension

- ouvre un chat persistant par workspace, avec historique sauvegardé sur disque
- construit le contexte à partir des instructions, de la mémoire, du résumé, du fichier actif et du retrieval
- peut répondre en chat direct ou en mode agent multi-étapes
- exécute les outils agent dans un sandbox Docker au lieu du workspace hôte
- produit un patch à relire avant toute écriture réelle dans le projet
- peut déléguer des tâches longues au cloud executor

## Architecture rapide

- `extension.js` : point d’entrée principal, orchestration, stockage, chat, agent runtime, RAG, UI bridge
- `media/` : webview du chat
- `lib/` : sandbox Docker et helpers runtime partagés
- `cloud-executor/` : serveur optionnel pour les tâches distantes
- `sandbox/` : image Docker utilisée par les outils agent
- `docs/` : documentation d’architecture, protocoles, tests et usage
- `scripts/` : smoke tests et live tests
- `test/` : scénarios de test côté extension host

## Installation

### Installation utilisateur

1. Installer l’extension dans VS Code.
2. Lancer LM Studio.
3. Activer le serveur local OpenAI-compatible.
4. Vérifier `localai.baseUrl` et `localai.nativeBaseUrl`.
5. Choisir un `localai.modelId` ou laisser `auto`.
6. Charger au moins un modèle chat dans LM Studio.

### Installation développeur

1. Cloner le repo.
2. Ouvrir le dossier dans VS Code.
3. Installer les dépendances si nécessaire.
4. Lancer LM Studio localement.
5. Démarrer l’extension en mode développement via l’host VS Code.
6. Vérifier Docker si le mode agent avec outils doit être utilisé.

## Prérequis

### Obligatoires

- VS Code `^1.94.0`
- LM Studio en cours d’exécution
- serveur local activé
- au moins un modèle chat chargé

### Pour le retrieval sémantique

- un modèle d’embedding chargé dans LM Studio, ou `localai.rag.embeddingModel` configuré explicitement

### Pour le mode agent avec outils

- Docker Desktop avec moteur Linux actif
- WSL2 sur Windows
- image construite depuis `sandbox/Dockerfile`

### Pour le cloud executor

- un serveur Node capable de lancer `cloud-executor/server.js`
- un LM Studio accessible depuis la machine du serveur

## Réglages importants

### Cœur

- `localai.baseUrl`
- `localai.nativeBaseUrl`
- `localai.modelId`
- `localai.temperature`
- `localai.maxTokens`
- `localai.sendFileContext`

### Mémoire et retrieval

- `localai.memory.enabled`
- `localai.memory.scope`
- `localai.rag.enabled`
- `localai.rag.mode`
- `localai.rag.embeddingModel`
- `localai.rag.embeddingMaxRetries`
- `localai.rag.autoRefreshIntervalMinutes`

### Agent et sandbox

- `localai.agent.enabled`
- `localai.agent.maxRounds`
- `localai.agent.allowShell`
- `localai.sandbox.enabled`
- `localai.sandbox.runtimeRequired`
- `localai.sandbox.image`
- `localai.sandbox.toolTimeoutMs`
- `localai.sandbox.containerModelBaseUrl`
- `localai.sandbox.containerNativeBaseUrl`

### Cloud

- `localai.cloud.enabled`
- `localai.cloud.executorUrl`
- `localai.cloud.apiKey`
- `localai.cloud.pollIntervalMs`

## Fonctionnement

### Chat

Le message utilisateur arrive dans `extension.js`, le contexte est reconstruit, puis la requête part soit en chat direct, soit dans la boucle agent. L’état du chat est persisté sur disque.

### RAG

Le workspace est découpé en chunks. Le retrieval lexical et sémantique injecte les snippets les plus utiles dans le prompt final. Les embeddings sont demandés à LM Studio.

### Agent

L’agent peut demander des outils comme lecture fichier, recherche texte, shell, web ou LSP. Les outils sont exécutés dans le sandbox Docker. Les modifications sont transformées en patch review au lieu d’être appliquées directement au workspace.

### Patch review

Quand l’agent modifie des fichiers, l’extension crée un patch en attente. L’utilisateur peut le relire, l’accepter ou le rejeter.

### Cloud executor

Les tâches longues peuvent être envoyées à `cloud-executor/server.js`. Le serveur recrée le snapshot du workspace, lance le sandbox, exécute les rounds agent et interroge LM Studio via les URLs configurées.

## Commandes utiles

- `localai.openChat`
- `localai.newChat`
- `localai.selectModel`
- `localai.checkConnection`
- `localai.reviewDiff`
- `localai.acceptDiff`
- `localai.rejectDiff`

## Tests

- `npm run test:cloud-smoke`
- `npm run test:vscode-live`
- `npm run cloud:executor`

## Documentation par dossier

- [cloud-executor/README.md](/c:/Serveurs/localai-code-1.0.0/cloud-executor/README.md)
- [docs/README.md](/c:/Serveurs/localai-code-1.0.0/docs/README.md)
- [lib/README.md](/c:/Serveurs/localai-code-1.0.0/lib/README.md)
- [media/README.md](/c:/Serveurs/localai-code-1.0.0/media/README.md)
- [resources/README.md](/c:/Serveurs/localai-code-1.0.0/resources/README.md)
- [sandbox/README.md](/c:/Serveurs/localai-code-1.0.0/sandbox/README.md)
- [scripts/README.md](/c:/Serveurs/localai-code-1.0.0/scripts/README.md)
- [test/README.md](/c:/Serveurs/localai-code-1.0.0/test/README.md)
- [test/vscode/README.md](/c:/Serveurs/localai-code-1.0.0/test/vscode/README.md)
