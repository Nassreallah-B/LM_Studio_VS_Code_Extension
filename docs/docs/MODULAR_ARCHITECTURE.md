# Architecture Modulaire — Lib Modules

> Documentation complète des 16 modules `lib/` ajoutés à l'extension HF AI Code.
> Tous les modules sont 100% locaux — **aucune base de données externe**, **aucun stockage cloud**.
> Tout est persisté en fichiers JSON sur le disque local de l'utilisateur.

---

## Vue d'Ensemble

```text
lib/
├── aiDefence.js          ← Sécurité : injection, PII, secrets, shell
├── learningEngine.js     ← Auto-apprentissage SONA
├── providerRouter.js     ← Routage multi-LLM avec failover
├── pluginManager.js      ← Système de plugins hot-loadable
├── vectorDB.js           ← Recherche vectorielle hybride (BM25 + cosine)
├── memoryDB.js           ← Stockage structuré local (10 tables JSON)
├── sparc.js              ← Méthodologie SPARC (Sense-Plan-Act-Reflect-Correct)
├── mutationGuard.js      ← Garde-fou écriture/shell/suppression
├── swarmTopology.js      ← Topologies d'orchestration multi-agents
├── cveScanner.js         ← Scanner de vulnérabilités npm
├── encryption.js         ← Coffre-fort AES-256-GCM
├── hooksAndWorkers.js    ← Hooks lifecycle + workers background
├── dockerSandbox.js      ← Exécution isolée Docker
├── antiHallucination.js  ← Vérification post-génération
├── config.js             ← Constantes et lecteurs de config
└── runtimeFeatures.js    ← Store agents/teams/hooks/events (existant, augmenté)
```

---

## 1. AIDefence (`lib/aiDefence.js`)

### Rôle
Couche de sécurité qui analyse les entrées utilisateur et les sorties LLM pour bloquer les attaques.

### Fonctionnalités
- **Détection d'injection de prompt** : 15+ patterns (ignore previous, system override, etc.)
- **Détection de PII** : emails, numéros de téléphone, cartes de crédit, SSN
- **Détection de secrets** : tokens GitHub/GitLab/AWS, clés API, mots de passe en dur
- **Validation shell** : bloque `rm -rf`, `curl | bash`, hijacking de loader
- **Rédaction automatique** : masque les PII détectés dans les sorties

### API
```javascript
const aiDefence = require('./lib/aiDefence');

aiDefence.detectInjection(text);      // → { detected: bool, findings: [...] }
aiDefence.detectPII(text);            // → { detected: bool, findings: [...] }
aiDefence.detectSecrets(code);        // → { detected: bool, findings: [...] }
aiDefence.validateShellCommand(cmd);  // → { blocked: bool, findings: [...] }
aiDefence.redactPII(text);            // → texte nettoyé
aiDefence.fullDefence(text);          // → analyse complète combinée
```

### Stockage
Aucun — traitement en mémoire uniquement.

---

## 2. Learning Engine (`lib/learningEngine.js`)

### Rôle
Système d'auto-apprentissage inspiré de SONA. Enregistre les trajectoires d'actions (succès/échec) et recommande des outils basé sur les patterns passés.

### Fonctionnalités
- Enregistrement de trajectoires (tâche → outils → résultat)
- Recherche de tâches similaires par mots-clés
- Recommandation d'outils basée sur l'historique
- Statistiques de succès/échec

### API
```javascript
const { LearningEngine } = require('./lib/learningEngine');
const engine = new LearningEngine();

engine.recordTrajectory({ task, tools, success, output });
engine.findSimilarTasks(prompt);     // → trajectoires similaires
engine.recommendTools(prompt);       // → outils recommandés
engine.buildContext(prompt);         // → contexte d'apprentissage complet
engine.getStats();                   // → { trajectoryCount, successRate }
```

### Stockage
**RAM uniquement** — les trajectoires sont perdues au redémarrage de VS Code.

---

## 3. Provider Router (`lib/providerRouter.js`)

### Rôle
Routeur intelligent pour 6 providers LLM avec failover automatique, round-robin, et routage par domaine.

### Providers Supportés
1. HuggingFace (défaut)
2. Ollama (local)
3. OpenAI
4. Anthropic
5. LMStudio
6. Groq

### Fonctionnalités
- **Failover** : après N échecs consécutifs, bascule automatiquement au provider suivant
- **Recovery** : un provider redevient actif après un succès
- **Round-robin** : cycle les providers actifs pour équilibrer la charge
- **Routage par domaine** : SQL → `database-expert`, CSS → `rtl-ui-auditor`, security → `sentinel`

### API
```javascript
const { ProviderRouter } = require('./lib/providerRouter');
const router = new ProviderRouter();

router.registerProvider({ name, endpoint, apiKey, priority });
router.routeRequest(prompt);         // → provider optimal
router.recordFailure(providerName);  // → met à jour le health status
router.recordSuccess(providerName);  // → réinitialise le compteur d'échecs
router.getHealthStatus();            // → état de tous les providers
```

### Stockage
**RAM uniquement** — le routing state est réinitialisé au redémarrage.

---

## 4. Plugin Manager (`lib/pluginManager.js`)

### Rôle
Système de plugins hot-loadable qui permet d'étendre l'extension avec des outils, agents et hooks personnalisés.

### Structure d'un Plugin
```text
plugins/
└── design-system/
    ├── manifest.json       ← Déclaration du plugin
    └── tools/
        └── designSystem.js ← Implémentation des outils
```

### Fonctionnalités
- Chargement automatique depuis le dossier `plugins/`
- Enregistrement de tools, agents, et hooks
- Activation/désactivation à chaud
- Validation des specs d'outils

### API
```javascript
const { PluginManager } = require('./lib/pluginManager');
const pm = new PluginManager(pluginsDir);

pm.loadAll();                  // → charge tous les plugins
pm.getPlugin(name);            // → info du plugin
pm.setEnabled(name, bool);     // → active/désactive
pm.getAllTools();               // → liste de tous les outils
pm.getAllToolSpecs();           // → specs pour le LLM
pm.executePluginTool(name, args); // → exécute un outil
```

### Stockage
**Fichiers plugin** dans `plugins/` — la configuration est en RAM.

---

## 5. VectorDB (`lib/vectorDB.js`)

### Rôle
Base de données vectorielle locale pour la recherche sémantique hybride (cosine + BM25).

### Fonctionnalités
- **Recherche cosine** : similarité vectorielle
- **Recherche BM25** : ranking lexical (TF-IDF like)
- **Recherche hybride** : fusion RRF (Reciprocal Rank Fusion) des deux scores
- **Filtrage** : par métadonnées (type, tags, etc.)
- **Persistence** : sauvegarde/chargement depuis un fichier JSON

### API
```javascript
const { VectorDB } = require('./lib/vectorDB');
const db = new VectorDB();

db.add(id, vector, metadata);         // → ajoute un vecteur
db.search(queryVector, topK, filter); // → résultats cosine
db.hybridSearch(queryVector, queryText, topK, filter); // → fusion RRF
db.delete(id);                        // → supprime une entrée
db.save(filePath);                    // → persiste sur disque
VectorDB.load(filePath);             // → charge depuis disque
db.getStats();                        // → { count, dimensions }
```

### Stockage
**Fichier JSON local** — `vectordb.json` dans le dossier de stockage VS Code.

---

## 6. MemoryDB (`lib/memoryDB.js`)

### Rôle
Stockage structuré local organisé en 10 tables JSON. Remplace les fichiers JSON éparpillés par un store unifié.

### ⚠️ Important : PAS une base de données externe
`MemoryDB` est un **fichier JSON unique** sur le disque local (`memory.json`). Le nom "DB" désigne l'organisation en tables structurées, pas une connexion réseau.

### Tables

| Table | Contenu |
|---|---|
| `memory_store` | KV store avec namespaces et TTL |
| `sessions` | Sessions utilisateur/agent |
| `agents` | Registre d'agents |
| `tasks` | Suivi des tâches |
| `agent_memory` | Mémoire privée par agent |
| `shared_state` | État partagé inter-agents |
| `events` | Journal d'événements (cap: 5000) |
| `patterns` | Patterns appris (error-handling, etc.) |
| `performance_metrics` | Métriques système (cap: 10000) |
| `workflow_state` | État des workflows SPARC |

### API
```javascript
const { MemoryDB } = require('./lib/memoryDB');
const db = new MemoryDB('/chemin/local/memory.json');
db.load();

// KV Store
db.store('namespace', 'key', value, { ttlMs, tags });
db.retrieve('namespace', 'key');
db.query('namespace', { keyPrefix, tags, since, limit });

// Agent Memory
db.storeAgentMemory(agentType, key, value);
db.getAgentMemory(agentType, key);

// Shared State
db.setSharedState(key, value, writerId);
db.getSharedState(key);

// Events
db.appendEvent(type, data, source);
db.queryEvents({ type, source, since, limit });

// Patterns
db.storePattern({ name, category, trigger, action, confidence });
db.findPatterns(category, trigger);
db.reinforcePattern(patternId, positive);

// Metrics
db.recordMetric(name, value, tags);
db.getMetrics(name, since, limit);

// Workflow
db.saveWorkflowState(workflowId, state);
db.loadWorkflowState(workflowId);

// Maintenance
db.cleanup({ maxEventAgeMs });
db.save();
db.dispose();
```

### Stockage
**Un seul fichier JSON local** : `<globalStorageUri>/memory.json`
- Écriture différée (debounce 2s)
- Auto-save avant fermeture

---

## 7. SPARC Workflow (`lib/sparc.js`)

### Rôle
Implémente la méthodologie SPARC (Sense → Plan → Act → Reflect → Correct) pour l'orchestration structurée d'agents.

### Phases

1. **Sense** : Analyse le prompt → détecte les domaines, estime la complexité, identifie les risques
2. **Plan** : Décompose en sous-tâches → assigne des agents, calcule les budgets de steps
3. **Act** : Exécute le plan via un executor fourni → collecte les résultats
4. **Reflect** : Évalue la qualité → score de succès, identification des problèmes
5. **Correct** : Ré-planifie et ré-exécute les tâches échouées (max 3 corrections)

### Domaines Détectés

| Domaine | Mots-clés | Agent Suggéré |
|---|---|---|
| database | sql, migration, rls, schema, supabase | `database-expert` |
| security | vulnerability, xss, injection, auth, owasp | `security-sentinel` |
| ui | css, layout, rtl, tailwind, animation | `rtl-ui-auditor` |
| api | endpoint, webhook, middleware | `general-purpose` |
| testing | test, coverage, vitest, playwright | `verification` |
| performance | optimize, slow, cache, bundle | `performance-monitor` |
| refactoring | refactor, cleanup, technical debt | `refactoring-expert` |

### Intégration avec l'Agent Loop

Dans `extension.js`, quand un agent `aria-orchestrator` démarre son **round 1** :

1. SPARC `sense()` + `plan()` sont exécutés automatiquement
2. L'analyse est injectée dans la conversation comme message de contexte
3. L'état SPARC est persisté dans MemoryDB (`workflow_state` + événement `sparc.analysis`)
4. L'orchestrateur reçoit les domaines, risques, sous-tâches et topologie recommandée
5. Si SPARC échoue, la tâche continue normalement (non-bloquant)

### API
```javascript
const { SPARCWorkflow } = require('./lib/sparc');
const sparc = new SPARCWorkflow({ maxCorrections: 3, reflectionThreshold: 0.7 });

// Cycle complet
const result = await sparc.run(context, executor);

// Ou phase par phase
const sense = await sparc.sense(context);
const plan = await sparc.plan(sense);
const act = await sparc.act(plan, executor);
const reflect = await sparc.reflect(act);
if (reflect.needsCorrection) await sparc.correct(reflect, plan, executor);
```

### Stockage
**RAM** pendant l'exécution, **MemoryDB** pour l'audit post-exécution.

---

## 8. MutationGuard (`lib/mutationGuard.js`)

### Rôle
Garde-fou fail-closed pour les opérations d'écriture, shell, et suppression. Chaque opération est validée selon le rôle de l'agent.

### Principe Fail-Closed
Si un rôle n'est pas explicitement autorisé → **BLOQUÉ par défaut**.

### 15 Rôles Configurés

| Rôle | Écriture | Shell | Suppression |
|---|---|---|---|
| `aria-orchestrator` | ❌ | ❌ | ❌ |
| `general-purpose` | ✅ | ✅ | ❌ |
| `rtl-ui-auditor` | ❌ | ❌ | ❌ |
| `database-expert` | ❌ | ✅ (approval) | ❌ |
| `security-sentinel` | ❌ | ✅ | ❌ |
| `refactoring-expert` | ✅ | ✅ | ❌ |
| `worker` | ✅ | ✅ | ❌ |
| `fork` | ✅ | ✅ | ❌ |
| `Explore` | ❌ | ❌ | ❌ |
| `Plan` | ❌ | ❌ | ❌ |

### Chemins Bloqués (tout rôle)
- `.env`, `.env.*` — fichiers de configuration sensibles
- `package-lock.json`, `yarn.lock` — lockfiles
- `node_modules/` — dépendances
- `.git/` — répertoire git

### Commandes Shell avec Approval
- `npm publish`, `npm unpublish`
- `git push --force`, `git reset --hard`
- Requêtes SQL (`DROP`, `DELETE`, `ALTER`)

### API
```javascript
const { MutationGuard } = require('./lib/mutationGuard');
const guard = new MutationGuard();

guard.checkWrite(filePath, agentRole);   // → { allowed, reason, requiresApproval }
guard.checkShell(command, agentRole);    // → { allowed, reason, requiresApproval }
guard.checkDelete(filePath, agentRole);  // → { allowed, reason }
guard.addDynamicBlock(pathPattern);      // → ajoute un pattern bloqué à chaud
guard.getAuditLog();                     // → journal d'audit complet
guard.getStats();                        // → { configuredRoles, blockedPaths, auditLogSize }
```

### Intégration dans extension.js
- Intercepte `write_file` avant AIDefence
- Intercepte `run_shell` via `enforceAgentShellPolicy`
- Les mutations bloquées sont loguées dans MemoryDB comme événements

### Stockage
**RAM** — le journal d'audit est en mémoire et purgé au redémarrage.

---

## 9. Swarm Topology (`lib/swarmTopology.js`)

### Rôle
Définit les topologies d'orchestration pour les swarms d'agents multi-domaines.

### Topologies Supportées

| Topologie | Description | Cas d'usage |
|---|---|---|
| **Pipeline** | Exécution séquentielle A → B → C | Tâches avec dépendances strictes |
| **Hub-Spoke** | Coordinateur central + agents parallèles | Tâches multi-domaines indépendantes |
| **Map-Reduce** | Mappers parallèles → Reducer final | Analyse distribuée + synthèse |

### Décomposition Automatique
```javascript
const { decomposeTask } = require('./lib/swarmTopology');
const result = decomposeTask('Migrate auth module and audit security');
// → { shouldDecompose: true, domains: ['database', 'security'], suggestedTopology: 'pipeline' }
```

### Stockage
**RAM uniquement** — l'exécution est éphémère.

---

## 10. CVE Scanner (`lib/cveScanner.js`)

### Rôle
Scanner de vulnérabilités pour les dépendances npm. Vérifie `package.json` contre 12+ patterns de CVE connus.

### API
```javascript
const { scanPackageJson } = require('./lib/cveScanner');
const result = scanPackageJson('/path/to/package.json');
// → { criticalCount, findings: [...], error }
```

### Intégration
Worker background qui scanne toutes les 30 minutes (configurable).

---

## 11. Encryption (`lib/encryption.js`)

### Rôle
Coffre-fort de chiffrement AES-256-GCM pour les données sensibles.

### Fonctionnalités
- Chiffrement/déchiffrement AES-256-GCM
- Magic bytes pour identifier les données chiffrées
- Détection de falsification (tamper detection)
- Mode passthrough quand désactivé

### Configuration
Opt-in via `hfaicode.encryption.enabled` dans les settings VS Code.

### Stockage
Clé de chiffrement stockée dans VS Code **SecretStorage** (jamais en clair).

---

## 12. Hooks & Workers (`lib/hooksAndWorkers.js`)

### Rôle
Système de hooks lifecycle (11 phases) et pool de workers background.

### Phases de Hooks
`pre_prompt`, `pre_tool`, `post_tool`, `pre_model`, `post_model`, `on_error`, `on_success`, `pre_task`, `post_task`, `pre_spawn`, `post_spawn`

### Workers Background
- Workers périodiques (ex: CVE scanner toutes les 30 min)
- Workers on-demand déclenchés par des événements
- Gestion du pool avec start/stop/dispose

---

## Pont MemoryDB → RuntimeFeatureStore

### Principe
Le `RuntimeFeatureStore` (`lib/runtimeFeatures.js`) utilise des fichiers JSON séparés comme source de vérité. Un pont dual-write synchronise automatiquement certaines données vers MemoryDB pour une interrogation structurée.

### Données Synchronisées

| Méthode RuntimeFeatureStore | → Table MemoryDB | Données |
|---|---|---|
| `appendEvent()` | `events` | Tous les événements runtime |
| `saveOnboarding()` | `memory_store` (ns: onboarding) | Summary, conventions, riskyZones |
| `saveAgent()` | `agent_memory` | Nom, status, taskId par type d'agent |
| `recordUsage()` | `performance_metrics` | Tokens, modèle, provider par appel |

### Sécurité
- Les écritures MemoryDB sont **best-effort** (try/catch)
- Les fichiers JSON restent la **source de vérité**
- Aucun impact sur les performances (MemoryDB est en mémoire avec flush différé)

---

## Résumé du Stockage — TOUT EST LOCAL

| Module | Type de Stockage | Fichier |
|---|---|---|
| AIDefence | RAM | — |
| Learning Engine | RAM | — |
| Provider Router | RAM | — |
| Plugin Manager | Fichiers locaux | `plugins/*/` |
| VectorDB | JSON local | `vectordb.json` |
| MemoryDB | JSON local | `memory.json` |
| SPARC | RAM + MemoryDB | `memory.json` (table workflow_state) |
| MutationGuard | RAM | — |
| Swarm Topology | RAM | — |
| CVE Scanner | RAM | — |
| Encryption | SecretStorage | Clé dans VS Code SecretStorage |
| Hooks & Workers | RAM | — |
| RuntimeFeatureStore | JSON local | `agent-runtime/*.json` |
| PersistentState | JSON local | `chats/`, `tasks/`, `memory/` |
| RAG Index | JSON local | `rag/index.json` |

**Aucune connexion réseau** pour le stockage. Les seuls appels réseau sont les requêtes aux API LLM (HuggingFace, Ollama, etc.).
