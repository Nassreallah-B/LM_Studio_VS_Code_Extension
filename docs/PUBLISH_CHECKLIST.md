# Publish Checklist

Checklist de publication GitHub pour `localai-code-1.0.0`.

## Secrets

- aucun token HF hardcodé dans le repo
- aucune clé LM Studio secrète trouvée dans les fichiers cachés usuels du projet
- aucune variable sensible persistante spécifique à LocalAI trouvée dans le projet

## Fichiers à ne pas publier

- `node_modules/`
- `*.vsix`
- `.vsixmanifest`
- `.env*`
- logs et artefacts de tests
- snapshots sandbox temporaires

## Vérifications recommandées avant push

1. Vérifier `git status`.
2. Vérifier qu’aucun fichier local parasite n’apparaît.
3. Vérifier qu’aucune URL ou config locale LM Studio non souhaitée n’a été ajoutée par erreur.
4. Relire `README.md`.
5. Relire `docs/PUBLISH_CHECKLIST.md`.

## Commandes utiles

```powershell
git status
git add .
git commit -m "Initial import"
git remote add origin <URL_GITHUB>
git push -u origin main
```

## Points d’attention

- les tests live LocalAI dépendent d’un LM Studio réellement accessible
- le repo ne contient pas de token HF, mais il contient des options `localai.web.searchApiKey` qui doivent rester vides par défaut
