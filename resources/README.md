# Resources

Ce dossier contient les assets statiques livrés avec l’extension.

## Fichiers

- `icon.png` : icône principale de l’extension
- `icon-activity.svg` : icône de container ou d’activité dans VS Code

## Fonctionnement

Ces fichiers sont référencés dans `package.json` pour l’extension, la sidebar et les vues.

## Installation

Pas d’installation indépendante. Ils sont embarqués pendant le packaging VSIX.

## Bonnes pratiques

- garder des fichiers légers
- éviter de casser les chemins déclarés dans `package.json`
- conserver la cohérence visuelle entre HF et LocalAI
