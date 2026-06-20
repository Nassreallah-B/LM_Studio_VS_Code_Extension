# Scripts

Ce dossier contient les scripts de validation et de smoke test.

## Fichiers

- `run-cloud-executor-smoke.js` : démarre un cloud executor temporaire et valide le cycle minimal de tâche distante
- `run-vscode-live-tests.js` : ouvre un host VS Code de test et exécute les tests live de l’extension

## Fonctionnement

Ces scripts servent à valider le produit dans un environnement réel, hors simple vérification syntaxique.

## Installation

### Prérequis

- Node.js
- VS Code installé localement pour les tests live
- Docker pour les tests sandbox et cloud
- LM Studio lancé avec serveur local actif pour les scénarios live et cloud

### Commandes

```powershell
npm run test:cloud-smoke
npm run test:vscode-live
```

## Quand modifier ce dossier

- quand les flows de test ne couvrent plus les régressions critiques
- quand un nouveau prérequis doit être détecté automatiquement
- quand il faut mieux journaliser les succès, skips et erreurs
