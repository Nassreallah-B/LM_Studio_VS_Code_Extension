# Plugin System — Design System & UI/UX Pro Max

> Documentation du système de plugins et du bridge Python UI/UX Pro Max.

---

## Architecture du Plugin System

### Structure

```text
plugins/
└── design-system/
    ├── manifest.json             ← Déclaration du plugin
    └── tools/
        └── designSystem.js       ← Bridge JS → Python + fallback built-in
```

### Manifest (`manifest.json`)

```json
{
  "name": "design-system",
  "version": "1.0.0",
  "description": "UI/UX Design System generator powered by UI/UX Pro Max",
  "tools": [
    {
      "name": "generate_design_system",
      "description": "Generate a design system for a project",
      "parameters": { "query": "string", "projectName": "string", "stack": "string" }
    },
    {
      "name": "search_design_domain",
      "description": "Search a specific design domain (style, color, typography, etc.)",
      "parameters": { "query": "string", "domain": "string", "maxResults": "number" }
    },
    {
      "name": "get_design_status",
      "description": "Get the status of the design system tools"
    }
  ],
  "agents": [
    {
      "type": "design-system-expert",
      "description": "Specialist agent for UI/UX design system generation"
    }
  ],
  "hooks": [
    {
      "phase": "pre_prompt",
      "name": "design-context",
      "description": "Inject design system context into UI-related prompts"
    }
  ]
}
```

---

## UI/UX Pro Max — Python Bridge

### Vue d'Ensemble

Le bridge connecte l'extension VS Code à un moteur Python de recherche et génération de design systems. Il fonctionne en **mode local** uniquement (pas de serveur, pas d'API).

### Fichiers Déployés

```text
skills/ui-ux-pro-max/
├── scripts/
│   ├── core.py              ← Moteur de recherche BM25 (TF-IDF)
│   ├── design_system.py     ← Générateur de design system complet (47 KB)
│   └── search.py            ← Point d'entrée CLI
│
└── data/
    ├── styles.csv            ← 50+ styles UI (142 KB)
    ├── colors.csv            ← 21+ palettes couleurs (32 KB)
    ├── typography.csv        ← 50+ combinaisons typographiques (49 KB)
    ├── charts.csv            ← 20+ types de graphiques (19 KB)
    ├── landing.csv           ← Patterns de landing pages (16 KB)
    ├── products.csv          ← Patterns de pages produit (58 KB)
    ├── design.csv            ← Règles de design (106 KB)
    ├── icons.csv             ← Guidelines d'icônes (20 KB)
    ├── google-fonts.csv      ← Base complète Google Fonts (745 KB)
    ├── ui-reasoning.csv      ← Logique de décision UI (53 KB)
    ├── ux-guidelines.csv     ← Best practices UX (18 KB)
    ├── app-interface.csv     ← Patterns d'interface app (9 KB)
    ├── react-performance.csv ← Optimisation React (14 KB)
    │
    └── stacks/               ← 16 fichiers par framework
        ├── react.csv
        ├── nextjs.csv
        ├── vue.csv
        ├── svelte.csv
        ├── astro.csv
        ├── angular.csv
        ├── laravel.csv
        ├── flutter.csv
        ├── swiftui.csv
        ├── react-native.csv
        ├── jetpack-compose.csv
        ├── threejs.csv
        ├── html-tailwind.csv
        ├── shadcn.csv
        ├── nuxtjs.csv
        └── nuxt-ui.csv
```

### Fonctionnement du Bridge

```
┌─────────────────────┐     child_process.spawn     ┌──────────────────────┐
│   designSystem.js   │ ──────────────────────────→  │     search.py        │
│   (Node.js plugin)  │                              │     (Python CLI)     │
│                     │  ← stdout/stderr (JSON/MD) ─ │                      │
└─────────────────────┘                              └──────────────────────┘
```

1. Le plugin JS construit les arguments CLI
2. Il spawn `python search.py` avec les flags appropriés
3. Le script Python cherche dans les CSVs via BM25
4. Le résultat est renvoyé en JSON ou Markdown
5. Si Python est absent, le plugin utilise un **fallback intégré** (7 styles, 7 palettes, 6 fonts)

### Commandes CLI

```bash
# Génération de design system
python search.py "glassmorphism dark dashboard" --design-system -p "MyApp"

# Recherche par domaine
python search.py "luxury beauty salon" --domain style --json -n 2

# Recherche par stack
python search.py "optimization" --stack react --json

# Domaines disponibles : style, color, typography, chart, landing, product, design, icon, font, ui, ux
```

### Détection de Source

Le plugin retourne toujours une propriété `source` :

| Valeur | Signification |
|---|---|
| `ui-ux-pro-max` | Le bridge Python a fonctionné |
| `built-in-fallback` | Python absent, données built-in utilisées |

### Fallback Built-in

Si Python n'est pas disponible, le plugin utilise des données intégrées :
- **7 styles** : Glassmorphism, Neomorphism, Brutalism, Minimalist, Material, Retro-Futuristic, Organic
- **7 palettes** : Ocean, Sunset, Forest, Midnight, Coral, Arctic, Lavender
- **6 combinaisons typographiques** : Inter/JetBrains, Outfit/Fira, Space Grotesk/IBM Plex, etc.

### Prérequis

- **Python 3.x** installé et dans le PATH
- Aucune dépendance Python externe (utilise uniquement `csv`, `json`, `os`, `sys`)
- Fonctionne sur Windows, macOS, Linux

### Test du Bridge

```powershell
# Depuis la racine du projet
node -e "
const { execute } = require('./plugins/design-system/tools/designSystem');
execute({ query: 'luxury salon', projectName: 'MySalon', action: 'generate_design_system' })
  .then(r => console.log('Source:', r.source, '| Keys:', Object.keys(r)));
"
```
