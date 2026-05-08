# Testing

## Suite de Tests Modulaire

La suite principale valide les 16 modules `lib/` et le plugin system :

```powershell
# Tests complets — 132 tests
node test-modules.js
```

### Structure des Tests (111 tests de base)

| # | Module | Tests | Validations |
|---|---|---|---|
| 1 | AIDefence | 14 | Injection, PII, secrets, shell, rédaction |
| 2 | Learning Engine | 5 | Trajectoires, recommandations, stats |
| 3 | Provider Router | 9 | Providers, failover, recovery, routage domaine |
| 4 | Plugin Manager | 8 | Chargement, outils, agents, hooks, enable/disable |
| 5 | VectorDB | 9 | Cosine, BM25, hybrid, filtre, persistence |
| 6 | MemoryDB | 14 | KV store, sessions, agents, shared state, events, patterns, metrics, workflows |
| 7 | SPARC Workflow | 6 | Domaines, complexité, risques, status |
| 8 | MutationGuard | 14 | Write, shell, delete, approval, audit log, dynamic block |
| 9 | Swarm Topology | 13 | Pipeline, hub-spoke, map-reduce, décomposition, exécution |
| 10 | CVE Scanner | 4 | Patterns connus, scan, erreurs, fichier manquant |
| 11 | Encryption | 7 | AES-256-GCM, tamper, passthrough, vault status |
| 12 | Hooks & Workers | 8 | Hook CRUD, workers, pool dispose |

### Tests d'Intégration SPARC + MemoryDB (21 tests)

```powershell
# Test séparé pour les câblages SPARC → Agent Loop et MemoryDB → RuntimeFeatureStore
node -e "<voir test inline dans le walkthrough>"
```

Validations :
- SPARC détecte les domaines (database, security, ui, etc.)
- SPARC identifie les risques (schema_change, security_sensitive, etc.)
- SPARC assigne les bons agents (database-expert, security-sentinel)
- MemoryDB persiste les workflows SPARC
- MemoryDB reçoit les événements dual-write
- MemoryDB stocke l'onboarding, agents, métriques

---

## Validation Statique

```powershell
# Vérification syntaxique des fichiers critiques
node -c extension.js
node -c lib/runtimeFeatures.js
node -c lib/memoryDB.js
node -c lib/sparc.js
node -c lib/mutationGuard.js
node -c lib/aiDefence.js
node -c lib/vectorDB.js
node -c lib/providerRouter.js
node -c lib/pluginManager.js
node -c lib/swarmTopology.js
node -c lib/cveScanner.js
node -c lib/encryption.js
node -c lib/hooksAndWorkers.js
node -c lib/learningEngine.js
node -c cloud-executor/server.js
```

## Test du Plugin Design System

```powershell
# Test du bridge Python UI/UX Pro Max
node -e "
const { execute } = require('./plugins/design-system/tools/designSystem');
execute({ query: 'luxury salon', projectName: 'MySalon', action: 'generate_design_system' })
  .then(r => console.log('Source:', r.source));
"
```

## Tests Live Extension

```powershell
npm run test:vscode-live
```

Exercice : activation, connexion, RAG rebuild, retrieval, envoi prompt, multi-chat, background task.

Requis : `HF_TOKEN`

## Test Smoke Cloud Executor

```powershell
npm run test:cloud-smoke
```

Valide : startup, `/health`, création tâche, complétion agent.

Requis : Docker + `HF_API_TOKEN`

## Sandbox Validation

1. Démarrer Docker Desktop
2. Confirmer que le moteur Linux est healthy
3. Lancer un agent qui modifie des fichiers
4. Confirmer qu'un patch pending apparaît (pas de mutation directe)
5. Review et accepter le patch

## Resume Validation

1. Lancer une tâche background longue
2. Fermer VS Code pendant l'exécution
3. Redémarrer
4. Confirmer le statut `resuming` ou `interrupted`
5. Confirmer la reprise depuis le dernier checkpoint

## Environnement Requis

| Composant | Obligatoire | Usage |
|---|---|---|
| Node.js 22+ | ✅ | Extension, tests |
| Python 3.x | ❌ (fallback dispo) | UI/UX Pro Max bridge |
| Docker | ❌ (sandbox optionnel) | Sandbox isolé |
| HF Token | ✅ (pour les tests live) | API LLM |
