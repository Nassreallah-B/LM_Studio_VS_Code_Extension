# Docs

Ce dossier regroupe la documentation fonctionnelle et technique de LocalAI Code.

## À quoi sert ce dossier

- expliquer l’architecture mémoire, RAG, agent et sandbox
- documenter les protocoles internes et la persistance
- décrire le cloud executor, les tests et l’historique d’implémentation
- servir de base pour maintenance, audit et onboarding

## Fichiers clés

- `USER_GUIDE.md` : fonctionnement utilisateur
- `ARCHITECTURE_MEMORY_RAG.md` : mémoire, résumé, retrieval, prompt assembly
- `AGENTS_AND_SANDBOXES.md` : boucle agent, checkpoints, patch review, sandbox
- `ADVANCED_AGENT_RUNTIME.md` : orchestration avancée, sous-agents, hooks
- `SCHEMAS_AND_PROTOCOLS.md` : structures persistées et messages internes
- `CLOUD_EXECUTOR.md` : installation et exploitation du serveur distant
- `TESTING.md` : procédures de validation
- `IMPLEMENTATION_HISTORY.md` : historique des évolutions

## Comment l’utiliser

- commencer par `USER_GUIDE.md` pour comprendre l’usage
- lire `ARCHITECTURE_MEMORY_RAG.md` et `AGENTS_AND_SANDBOXES.md` avant de modifier le cœur
- lire `SCHEMAS_AND_PROTOCOLS.md` avant de toucher au stockage ou aux messages UI
- lire `CLOUD_EXECUTOR.md` avant toute modification du serveur distant

## Installation

Ce dossier n’a pas d’installation spécifique. Il est embarqué avec le repo et sert de référence de maintenance.
