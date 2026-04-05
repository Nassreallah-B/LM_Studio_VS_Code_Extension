# Test

Ce dossier contient les scénarios de test intégration de l’extension.

## Structure

- `vscode/` : tests exécutés dans un vrai host d’extension VS Code

## Fonctionnement

Le but ici n’est pas de faire du test unitaire isolé, mais de valider les chemins critiques du produit réel: activation, connexion provider, RAG, chat, persistence, tâches agent et sandbox.

## Installation

Pas d’installation séparée. Les tests sont pilotés par les scripts dans `scripts/`.
