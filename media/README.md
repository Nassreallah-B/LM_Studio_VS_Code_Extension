# Media

Ce dossier contient la webview du chat embarquée dans l’extension.

## Fichiers

- `chat.html` : HTML, CSS et JavaScript du chat sidebar

## Fonctionnement

La webview reçoit un snapshot UI depuis `extension.js`, rend les messages, les chats, les tâches, les patches et l’état mémoire/RAG/sandbox, puis renvoie les actions utilisateur avec `postMessage`.

## Ce qu’on modifie ici

- layout du composer
- rendu des messages
- rendu des patches et tâches
- contrôles de chat
- styles et comportements UI

## Installation

Pas d’installation indépendante. Le fichier est servi par l’extension au chargement de la vue VS Code.

## Attention

- conserver une logique compatible CSP
- éviter les handlers inline
- toute modification UI doit rester alignée avec le bridge de messages côté `extension.js`
