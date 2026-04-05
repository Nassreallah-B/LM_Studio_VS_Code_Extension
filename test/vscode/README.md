# VS Code Tests

Ce dossier contient les tests exécutés dans un véritable extension host VS Code.

## Fichiers

- `index.js` : point d’entrée du runner
- `live-rag.test.js` : test live couvrant activation, connexion LM Studio, rebuild RAG, retrieval, réponse chat, tâche background et persistence multi-chat

## Fonctionnement

Le runner ouvre un workspace temporaire, configure l’extension, exécute les assertions via l’API de test exposée par `extension.js`, puis écrit un `live-test-result.json`.

## Installation

### Prérequis

- VS Code installé localement
- LM Studio lancé avec serveur local actif
- au moins un modèle chat chargé
- Docker pour la partie background task sandbox

### Lancement

```powershell
npm run test:vscode-live
```
