# LocalAI Code — LM Studio

> Extension VS Code d'assistance au codage alimentée par LM Studio (modèles locaux).
> Architecture agentic distribuée : agents autonomes, sandbox Docker, mémoire persistante, RAG hybride et exécuteur cloud — 100% hors ligne.

---

## ✨ Fonctionnalités Clés

### 🤖 Agent Autonome Multi-Rounds — 100% Local
- **Modèle 100% local** via LM Studio (API OpenAI-compatible)
- **Aucune donnée envoyée dans le cloud** (sauf si cloud executor activé)
- **Agent foreground** : traite les messages avec outils (fichiers, shell, git, web optionnel)
- **Agent background** : tâche persistante avec checkpoints
- **Sub-agents et équipes** : orchestration complète locale

### 🐳 Sandbox Docker Isolé
- Exécution isolée dans un container Node.js 22
- Mode réseau configurable : `none` (offline total) ou `bridge` (accès LM Studio)
- Image auto-buildée depuis `sandbox/Dockerfile`
- Le workspace hôte n'est JAMAIS modifié directement

### 🧠 Mémoire & RAG Local
- Mémoire conversationnelle persistante (global + workspace)
- RAG hybride : lexical + sémantique (embeddings locaux)
- Auto-indexation configurable du workspace

### ☁️ Cloud Executor (optionnel)
- Serveur distant sur port 7789 par défaut
- LM Studio sur `host.docker.internal:1234`
- Déployable en Docker

---

## 🚀 Configuration

### Prérequis
- VS Code 1.94+
- LM Studio (https://lmstudio.ai) — démarrer le serveur local sur le port 1234
- Docker Desktop (pour le sandbox)

### Configuration Rapide

```jsonc
// .vscode/settings.json
{
  "localai.baseUrl": "http://localhost:1234/v1",
  "localai.modelId": "auto",
  "localai.temperature": 0.1,
  "localai.maxTokens": 8192,

  // Mémoire
  "localai.memory.enabled": true,
  "localai.memory.scope": "global+workspace",
  "localai.memory.maxRecentMessages": 15,

  // RAG
  "localai.rag.enabled": true,
  "localai.rag.mode": "hybrid-local",
  "localai.rag.topK": 8,
  "localai.rag.autoRefreshIntervalMinutes": 20,

  // Agent
  "localai.agent.enabled": true,
  "localai.agent.maxRounds": 15,
  "localai.agent.allowShell": true,
  "localai.agent.shellTimeoutMs": 60000,
  "localai.agent.maxConcurrentTasks": 2,

  // Sandbox Docker
  "localai.sandbox.enabled": true,
  "localai.sandbox.autoStartDocker": true,
  "localai.sandbox.image": "localai-code-sandbox:latest",
  "localai.sandbox.autoBuildImage": true,
  // "none" = offline; "bridge" = accès LM Studio depuis le sandbox
  "localai.sandbox.networkMode": "none",
  "localai.sandbox.toolTimeoutMs": 120000,
  "localai.sandbox.retainOnFailure": true
}
```

---

## 🛠️ Commandes Disponibles

| Commande | Description |
|---|---|
| `LocalAI: Open Chat` | Ouvrir le panneau de chat |
| `LocalAI: New Conversation` | Démarrer une nouvelle conversation |
| `LocalAI: Select / Change Model` | Changer le modèle LM Studio |
| `LocalAI: Check Connection` | Vérifier la connexion LM Studio |
| `LocalAI: Explain Code` | Expliquer le code sélectionné |
| `LocalAI: Fix Code` | Corriger le code sélectionné |
| `LocalAI: Refactor Code` | Refactoriser le code sélectionné |
| `LocalAI: Generate Tests` | Générer des tests unitaires |
| `LocalAI: Optimize Code` | Optimiser le code sélectionné |
| `LocalAI: Add Comments` | Ajouter des commentaires |
| `LocalAI: Accept Pending Patch` | Appliquer le patch en attente |
| `LocalAI: Reject Pending Patch` | Rejeter le patch en attente |
| `LocalAI: Review Pending Patch` | Ouvrir la revue du patch |
| `LocalAI: Clean Sandbox Workspaces` | Nettoyer les workspaces sandbox |
| `LocalAI: Create AGENTS.md` | Créer un fichier d'instructions agents |
| `LocalAI: View Memory Notes` | Voir les notes mémorisées |

---

## 🏗️ Architecture

```
extension.js                  ← Noyau principal (6500+ lignes)
lib/
  dockerSandbox.js            ← Gestionnaire Docker
  runtimeFeatures.js          ← Sub-agents, teams, hooks, MCP-like
  antiHallucination.js        ← Validation post-génération
cloud-executor/
  server.js                   ← Serveur HTTP d'exécution distante
  Dockerfile                  ← Image cloud executor
  docker-compose.yml          ← Déploiement (port 7789)
  .env.example                ← Variables d'environnement
sandbox/
  Dockerfile                  ← Image sandbox Node.js 22 + outils
scripts/
  build-sandbox.js            ← Build image sandbox
test/
  antiHallucination.test.js   ← Tests unitaires
docs/
  ADVANCED_AGENT_RUNTIME.md
  AGENTS_AND_SANDBOXES.md
  ARCHITECTURE_MEMORY_RAG.md
  CLOUD_EXECUTOR.md
```

---

## 🐳 Build Sandbox

```powershell
# Build de l'image sandbox
node scripts/build-sandbox.js

# Rebuild forcé
node scripts/build-sandbox.js --force
```

> **Note :** Si `localai.sandbox.networkMode = "bridge"`, le sandbox peut atteindre LM Studio via `http://host.docker.internal:1234/v1`.

---

## ☁️ Déploiement Cloud Executor

```powershell
# 1. Copier .env.example
cp cloud-executor/.env.example cloud-executor/.env

# 2. Renseigner CLOUD_EXECUTOR_API_KEY
notepad cloud-executor/.env

# 3. Lancer avec Docker Compose
cd cloud-executor
docker compose up -d

# 4. Configurer dans VS Code
# localai.cloud.enabled = true
# localai.cloud.executorUrl = http://127.0.0.1:7789
# localai.cloud.apiKey = <votre clé>
```

---

## 🔧 Résolution des Problèmes Courants

### LM Studio non accessible depuis le sandbox
```json
"localai.sandbox.networkMode": "bridge"
```
Le sandbox accède alors à `http://host.docker.internal:1234/v1`.

### Agent figé à 0% CPU
- Vérifier que LM Studio est démarré et le modèle est chargé
- Recharger VS Code (`Developer: Reload Window`)
- Vérifier les logs dans l'Output Channel `LocalAI: Debug`

### Erreur `Unexpected message role`
- Certains modèles LM Studio n'acceptent pas le rôle `system` en milieu de conversation
- Le comportement correct est implémenté : les tool results utilisent le rôle `user`

---

## 🔒 Confidentialité

- **100% local** : aucune donnée n'est envoyée à Hugging Face ou à un serveur externe
- **Sandbox réseau** : mode `none` par défaut — le container est complètement offline
- **Secrets** : aucun secret n'est injecté dans le container

---

## 🗺️ Roadmap

- [ ] Mode réseau `host-model` pour accès LM Studio filtré depuis sandbox
- [ ] Tests CI GitHub Actions automatisés
- [ ] MCP tool invocation distante
- [ ] Dashboard agents tree dans le webview
- [ ] Visualisation des coûts (tokens estimés)

---

*LocalAI Code v1.2.0 — MIT License*
