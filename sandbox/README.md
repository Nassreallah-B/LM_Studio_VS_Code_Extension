# Sandbox

Ce dossier contient l’image Docker utilisée pour isoler les outils agent.

## Fichiers

- `Dockerfile` : définition de l’image sandbox
- `README.md` : ce document

## Fonctionnement

Le sandbox reçoit une copie du workspace ou un snapshot de fichiers. Les outils agent comme lecture, recherche, shell, git et écriture y tournent sans modifier directement le projet hôte. À la fin, on récupère un patch review.

## Installation

### Construction manuelle

```powershell
docker build -t localai-code-sandbox:latest sandbox
```

### Prérequis

- Docker Desktop
- moteur Linux actif

## Dépendance principale

Le code de pilotage de cette image est dans [dockerSandbox.js](/c:/Serveurs/localai-code-1.0.0/lib/dockerSandbox.js).
