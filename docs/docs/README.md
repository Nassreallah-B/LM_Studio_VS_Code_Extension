# Docs

Ce dossier regroupe la documentation fonctionnelle et technique de HF AI Code.

## À quoi sert ce dossier

- expliquer l'architecture modulaire, mémoire, RAG, agents et sandbox
- documenter les 16 modules `lib/`, le système de plugins et le bridge Python
- décrire les protocoles internes, la persistance et la sécurité
- servir de base pour maintenance, audit et onboarding

## Fichiers clés

### Architecture & Modules
- `MODULAR_ARCHITECTURE.md` : **documentation complète des 16 modules `lib/`** — APIs, stockage, configuration
- `PLUGIN_SYSTEM.md` : système de plugins hot-loadable + bridge Python UI/UX Pro Max
- `ARCHITECTURE_MEMORY_RAG.md` : mémoire persistante, RAG hybride, MemoryDB, VectorDB, carte de stockage complète

### Agents & Orchestration
- `ARIA_ECOSYSTEM.md` : écosystème d'agents ARIA, intégration SPARC, MutationGuard, topologies de swarm
- `ADVANCED_AGENT_RUNTIME.md` : orchestration avancée, sous-agents, teams, hooks, MCP-like
- `AGENTS_AND_SANDBOXES.md` : sandbox Docker et cycle de vie des agents

### Opérations
- `USER_GUIDE.md` : guide utilisateur (paramètres, commandes, fonctionnalités)
- `TESTING.md` : procédures de validation (132 tests documentés)
- `SCHEMAS_AND_PROTOCOLS.md` : structures persistées et messages internes
- `CLOUD_EXECUTOR.md` : installation et exploitation du serveur distant
- `IMPLEMENTATION_HISTORY.md` : historique des 17 phases d'évolution
- `PUBLISH_CHECKLIST.md` : checklist de publication

### Historique
- `WORKLOG_2026-04-04.md` : notes détaillées du 4 avril 2026

## Comment l'utiliser

### Pour un nouveau développeur
1. Commencer par `USER_GUIDE.md` pour comprendre l'usage
2. Lire `MODULAR_ARCHITECTURE.md` pour comprendre les 16 modules
3. Lire `ARIA_ECOSYSTEM.md` pour l'orchestration des agents

### Avant de modifier le code
- `ARCHITECTURE_MEMORY_RAG.md` avant de toucher à la mémoire ou au RAG
- `MODULAR_ARCHITECTURE.md` avant de modifier un module `lib/`
- `ARIA_ECOSYSTEM.md` avant de modifier l'orchestration ou les rôles agents
- `SCHEMAS_AND_PROTOCOLS.md` avant de toucher au stockage ou aux messages UI
- `CLOUD_EXECUTOR.md` avant toute modification du serveur distant
- `PLUGIN_SYSTEM.md` avant de créer ou modifier un plugin

### Pour valider des changements
- Suivre les procédures dans `TESTING.md`
- Exécuter `node test-modules.js` (132 tests)

## Principe fondamental

> **⚠️ TOUT LE STOCKAGE EST LOCAL**
>
> Aucune base de données externe. Aucun stockage cloud.
> Le nom "MemoryDB" désigne un fichier JSON local organisé en tables — pas une base de données réseau.
> Les seuls appels réseau sont les requêtes aux API LLM (HuggingFace, Ollama, etc.).

## Installation

Ce dossier n'a pas d'installation spécifique. Il est embarqué avec le repo et sert de référence de maintenance.
