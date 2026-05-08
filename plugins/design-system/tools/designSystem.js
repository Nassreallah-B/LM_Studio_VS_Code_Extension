'use strict';

// ── UI/UX Pro Max Design System Tool Handler ─────────────────────────────────
// Executes the UI/UX Pro Max search.py script to generate design systems.
// Falls back to built-in design intelligence when Python is not available.

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

// ── Built-in Design Intelligence (Fallback) ──────────────────────────────────
// Subset of UI/UX Pro Max data for when search.py is not available.
const BUILT_IN_STYLES = {
  'glassmorphism': { name: 'Glassmorphism', css: 'backdrop-filter: blur(16px); background: rgba(255,255,255,0.1); border: 1px solid rgba(255,255,255,0.18);', bestFor: 'SaaS, Dashboard, Portfolio', avoid: 'E-commerce product pages' },
  'neomorphism': { name: 'Neomorphism', css: 'box-shadow: 8px 8px 16px #d1d1d1, -8px -8px 16px #ffffff;', bestFor: 'Calculator, Settings, Music', avoid: 'Text-heavy content' },
  'minimalism': { name: 'Clean Minimalism', css: 'max-width: 1200px; padding: 2rem; color: #1a1a1a;', bestFor: 'Portfolio, Blog, Agency', avoid: 'Gaming, Kids apps' },
  'brutalism': { name: 'Neo-Brutalism', css: 'border: 3px solid #000; box-shadow: 4px 4px 0 #000; font-weight: 900;', bestFor: 'Creative Agency, Art, Fashion', avoid: 'Healthcare, Finance' },
  'dark-luxury': { name: 'Dark Luxury', css: 'background: #0a0a0a; color: #f5f5f5; font-family: "Playfair Display";', bestFor: 'Luxury, Jewelry, Premium SaaS', avoid: 'Kids, Education' },
  'aurora': { name: 'Aurora Gradient', css: 'background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);', bestFor: 'SaaS, Fintech, AI products', avoid: 'Medical, Legal' },
  'editorial': { name: 'Editorial', css: 'font-family: "Cormorant Garamond"; letter-spacing: 0.02em; line-height: 1.8;', bestFor: 'Magazine, Blog, Publishing', avoid: 'Dashboard, Admin' }
};

const BUILT_IN_PALETTES = {
  'beauty': { primary: '#E8A0BF', secondary: '#BA90C6', accent: '#C0DBEA', bg: '#FDF4F5', text: '#2D2D2D' },
  'fintech': { primary: '#2563EB', secondary: '#1E40AF', accent: '#10B981', bg: '#0F172A', text: '#F8FAFC' },
  'healthcare': { primary: '#059669', secondary: '#047857', accent: '#34D399', bg: '#ECFDF5', text: '#064E3B' },
  'saas': { primary: '#7C3AED', secondary: '#6D28D9', accent: '#A78BFA', bg: '#FAF5FF', text: '#1E1B4B' },
  'ecommerce': { primary: '#F59E0B', secondary: '#D97706', accent: '#FCD34D', bg: '#FFFBEB', text: '#451A03' },
  'creative': { primary: '#EC4899', secondary: '#DB2777', accent: '#F472B6', bg: '#FDF2F8', text: '#831843' },
  'corporate': { primary: '#1E3A5F', secondary: '#2C5282', accent: '#63B3ED', bg: '#F7FAFC', text: '#1A202C' }
};

const BUILT_IN_FONTS = {
  'elegant': { heading: 'Playfair Display', body: 'Source Sans Pro', monospace: 'JetBrains Mono' },
  'modern': { heading: 'Inter', body: 'Inter', monospace: 'Fira Code' },
  'playful': { heading: 'Outfit', body: 'DM Sans', monospace: 'Space Mono' },
  'professional': { heading: 'Montserrat', body: 'Open Sans', monospace: 'Source Code Pro' },
  'luxury': { heading: 'Cormorant Garamond', body: 'Lato', monospace: 'IBM Plex Mono' },
  'tech': { heading: 'Space Grotesk', body: 'IBM Plex Sans', monospace: 'JetBrains Mono' }
};

const ANTI_PATTERNS = [
  'No emoji icons in UI — use SVG icons (Heroicons, Lucide, Simple Icons)',
  'All clickable elements must have cursor-pointer',
  'Hover transitions: 150-300ms, never instant or > 500ms',
  'Light mode text contrast: minimum 4.5:1 ratio (WCAG AA)',
  'Glass/transparent elements must be visible in light mode (bg-white/80 minimum)',
  'No layout shift on hover — avoid scale transforms on cards',
  'Floating navbar: add top-4 left-4 right-4 spacing, not flush top-0',
  'Consistent max-width across sections (max-w-6xl or max-w-7xl)',
  'prefers-reduced-motion must be respected for all animations'
];

// ── Tool Execution ───────────────────────────────────────────────────────────
async function execute(input, context = {}) {
  const { query, projectName, domain, stack, maxResults, action } = input || {};
  const toolName = context.toolName || 'generate_design_system';

  switch (toolName) {
    case 'generate_design_system':
      return generateDesignSystem(query, projectName, stack);
    case 'search_design_domain':
      return searchDomain(query, domain, maxResults);
    case 'get_stack_guidelines':
      return getStackGuidelines(query, stack);
    default:
      return generateDesignSystem(query, projectName, stack);
  }
}

async function generateDesignSystem(query, projectName, stack) {
  // Try Python search.py first (full UI/UX Pro Max)
  const scriptResult = await tryPythonSearch(query, projectName);
  if (scriptResult) return scriptResult;

  // Fallback to built-in intelligence
  const keywords = String(query || '').toLowerCase().split(/\s+/);

  // Match best style
  let bestStyle = BUILT_IN_STYLES['minimalism'];
  for (const [key, style] of Object.entries(BUILT_IN_STYLES)) {
    if (keywords.some(k => key.includes(k) || k.includes(key))) {
      bestStyle = style;
      break;
    }
  }

  // Match best palette
  let bestPalette = BUILT_IN_PALETTES['saas'];
  for (const [key, palette] of Object.entries(BUILT_IN_PALETTES)) {
    if (keywords.some(k => key.includes(k) || k.includes(key))) {
      bestPalette = palette;
      break;
    }
  }

  // Match best fonts
  let bestFonts = BUILT_IN_FONTS['modern'];
  for (const [key, fonts] of Object.entries(BUILT_IN_FONTS)) {
    if (keywords.some(k => key.includes(k) || k.includes(key))) {
      bestFonts = fonts;
      break;
    }
  }

  return {
    source: 'built-in-fallback',
    projectName: projectName || 'Untitled',
    query,
    designSystem: {
      style: bestStyle,
      colors: bestPalette,
      typography: bestFonts,
      effects: { borderRadius: '12px', shadow: '0 4px 6px -1px rgba(0,0,0,0.1)', transition: 'all 200ms ease' },
      antiPatterns: ANTI_PATTERNS
    },
    note: 'Using built-in design intelligence. For full 161 rules + 67 styles, install UI/UX Pro Max: npm install -g uipro-cli && uipro init'
  };
}

async function searchDomain(query, domain, maxResults) {
  const result = await tryPythonSearch(query, null, domain, maxResults);
  if (result) return result;
  return { source: 'built-in-fallback', domain, query, message: 'Full domain search requires UI/UX Pro Max Python scripts. Install with: npm install -g uipro-cli' };
}

async function getStackGuidelines(query, stack) {
  const result = await tryPythonSearch(query, null, null, null, stack);
  if (result) return result;

  const guidelines = {
    'react': ['Use React.memo() for expensive renders', 'Lazy load routes with React.lazy()', 'Use useMemo/useCallback for referential equality', 'Extract custom hooks for reusable logic'],
    'nextjs': ['Use Image component for automatic optimization', 'Prefer server components by default', 'Use route groups for layout organization'],
    'html-tailwind': ['Use @apply for repeated utility combinations', 'Use responsive prefixes (sm:, md:, lg:)', 'Use dark: prefix for dark mode support'],
    'vue': ['Use Composition API with <script setup>', 'Use Pinia for state management', 'Use v-memo for expensive list rendering'],
    'svelte': ['Use $state and $derived runes', 'Use {#snippet} for reusable template blocks', 'Use enhance:form for progressive forms']
  };

  return {
    source: 'built-in-fallback',
    stack: stack || 'html-tailwind',
    guidelines: guidelines[stack] || guidelines['html-tailwind'],
    note: 'For comprehensive guidelines, install UI/UX Pro Max.'
  };
}

// ── Python search.py integration ─────────────────────────────────────────────
function tryPythonSearch(query, projectName, domain, maxResults, stack) {
  return new Promise((resolve) => {
    // Look for search.py in known locations
    const searchPaths = [
      path.join(__dirname, '..', '..', '..', 'skills', 'ui-ux-pro-max', 'scripts', 'search.py'),
      path.join(__dirname, '..', '..', 'skills', 'ui-ux-pro-max', 'scripts', 'search.py'),
      path.join(process.cwd(), 'skills', 'ui-ux-pro-max', 'scripts', 'search.py')
    ];

    let scriptPath = null;
    for (const sp of searchPaths) {
      if (fs.existsSync(sp)) { scriptPath = sp; break; }
    }

    if (!scriptPath) { resolve(null); return; }

    const args = [scriptPath, String(query || '')];
    if (domain) { args.push('--domain', domain); }
    else { args.push('--design-system'); }
    if (projectName) { args.push('-p', projectName); }
    if (maxResults) { args.push('-n', String(maxResults)); }
    if (stack) { args.push('--stack', stack); }
    args.push('--json');

    const pythonCmd = process.platform === 'win32' ? 'python' : 'python3';
    const proc = spawn(pythonCmd, args, { timeout: 30000, stdio: ['pipe', 'pipe', 'pipe'] });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d; });
    proc.stderr.on('data', (d) => { stderr += d; });
    proc.on('close', (code) => {
      // search.py may use stderr for output (design-system mode), combine both
      const output = (stdout.trim() || stderr.trim());
      if (output) {
        try {
          resolve({ source: 'ui-ux-pro-max', ...JSON.parse(output) });
        } catch (_) {
          // Non-JSON output (markdown mode) — return as raw
          resolve({ source: 'ui-ux-pro-max', raw: output });
        }
      } else {
        resolve(null);
      }
    });
    proc.on('error', () => resolve(null));
  });
}

module.exports = { execute };
