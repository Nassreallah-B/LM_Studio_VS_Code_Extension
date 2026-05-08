# Publish Checklist

Checklist de publication GitHub pour `hf-ai-code`.

## Secrets

- aucun token HF hardcodé dans le repo
- aucun secret trouvé dans les fichiers cachés usuels du projet
- `HF_TOKEN` utilisateur Windows a été retiré du profil persistant
- redémarrer le terminal ou VS Code avant le push pour vider la session courante

## Fichiers à ne pas publier

- `node_modules/`
- `*.vsix`
- `.vsixmanifest`
- `.env*`
- logs et artefacts de tests
- snapshots sandbox temporaires

## Vérifications recommandées avant push

1. Ouvrir un nouveau terminal.
2. Vérifier que `HF_TOKEN` n’est plus présent dans l’environnement courant.
3. Vérifier `git status`.
4. Vérifier qu’aucun fichier local parasite n’apparaît.
5. Relire `README.md`.
6. Relire `docs/PUBLISH_CHECKLIST.md`.

## Commandes utiles

```powershell
Get-ChildItem Env:HF_TOKEN
git status
git add .
git commit -m "Initial import"
git remote add origin <URL_GITHUB>
git push -u origin main
```

## Points d’attention

- le cloud executor HF peut accepter un token transmis à l’exécution, mais aucun token n’est embarqué dans le code
- si tu ne veux pas garder `.qwen/`, retire-le avant le premier commit
