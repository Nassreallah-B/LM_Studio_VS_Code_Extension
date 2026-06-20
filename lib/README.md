# Lib

Ce dossier contient les helpers runtime partagés entre l’extension et le cloud executor.

## Fichiers

- `dockerSandbox.js` : gestion complète du sandbox Docker, du baseline git, des outils, des checkpoints et de la collecte de patchs
- `runtimeFeatures.js` : web tools, helpers runtime, features partagées côté agent
- `README.md` : ce document

## Fonctionnement

Le but de `lib/` est d’éviter de dupliquer les briques critiques entre le host VS Code et le serveur distant. Quand une même logique doit exister des deux côtés, elle doit vivre ici.

## Installation

Pas d’installation indépendante. Ces fichiers sont consommés par `extension.js` et `cloud-executor/server.js`.

## Points d’attention

- toute modification du sandbox impacte le mode agent local et cloud
- `dockerSandbox.js` est une frontière de sécurité, donc les changements doivent être validés avec tests smoke et live
