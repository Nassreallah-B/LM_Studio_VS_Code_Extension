# Cloud Executor

Ce dossier contient le runtime distant utilisé quand une tâche agent est envoyée hors du process principal de l’extension.

## Rôle

- exposer une API HTTP pour créer, suivre, reprendre et stopper des tâches
- reconstruire un snapshot isolé du workspace
- démarrer un sandbox Docker par tâche
- exécuter les rounds agent et stocker checkpoints, logs et patchs
- survivre à un redémarrage du serveur en rechargeant les tâches persistées

## Fichier principal

- `server.js` : serveur HTTP, store de tâches, orchestration agent distante, intégration sandbox et appels LM Studio

## Fonctionnement

1. L’extension envoie une requête `POST /tasks`.
2. Le serveur valide l’entrée.
3. Un sandbox est créé depuis les fichiers fournis.
4. La boucle agent s’exécute round par round.
5. Les outils tournent dans le sandbox.
6. Le résultat final, les logs et le patch restent persistés côté serveur.

## Installation

### Prérequis

- Node.js
- Docker actif
- image `localai-code-sandbox:latest` disponible ou autobuild activé
- LM Studio accessible depuis le serveur

### Lancement

```powershell
node cloud-executor/server.js
```

Variables utiles :

- `PORT`
- `CLOUD_EXECUTOR_DATA_DIR`
- `LOCALAI_BASE_URL`
- `LOCALAI_NATIVE_BASE_URL`
- `LOCALAI_MODEL_ID`
- variables sandbox associées

## À modifier ici si besoin

- validation et schémas d’entrée
- stratégie de persistance des tâches
- logique d’appel modèle
- reprise des checkpoints
- politique de sandbox distante
