# TabAnvil

Firefox tab manager extension for people with 100+ tabs. Full-page dashboard with search, sort, native tab grouping, multi-window support, and keyboard navigation. Zero dependencies.

## Install

### Development (temporary)

1. Open Firefox and navigate to `about:debugging#/runtime/this-firefox`
2. Click "Load Temporary Add-on..."
3. Select the `manifest.json` file from this directory

### From Firefox Add-ons (coming soon)

Will be available at [addons.mozilla.org](https://addons.mozilla.org) once published.

## Features

- **Full-page dashboard** -- opens in its own tab, not a cramped popup
- **Virtual scrolling** -- handles 500+ tabs at 60fps
- **Search** -- filter by title or URL, instantly
- **Sort** -- by position, domain, title, or last accessed
- **Native tab groups** -- uses Firefox's built-in `tabs.group()` API
- **Multi-window** -- see and move tabs across all browser windows
- **Multi-select** -- click, shift-click, ctrl-click for batch operations
- **Keyboard driven** -- `/` search, `j`/`k` navigate, `x` select, `d` close, `g` group

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `/` | Focus search |
| `j` / `k` | Navigate down / up |
| `x` | Toggle select on focused tab |
| `d` | Close selected tabs (or focused tab) |
| `g` | Group selected tabs |
| `Enter` | Switch to focused tab |
| `Esc` | Clear search or deselect |

## Architecture

```
tab-anvil/
  manifest.json      # WebExtension manifest v3
  dashboard.html     # Full-page dashboard
  dashboard.js       # Main app (~600 LOC, vanilla JS)
  dashboard.css      # Firefox dark theme styles
  background.js      # Browser action handler
  icons/             # SVG extension icons
```

Zero frameworks, zero build steps. Load the directory as a temporary add-on and go.

## Requirements

- Firefox 138+ (for `tabs.group()` and `tabGroups` API support)
- Falls back gracefully on older versions (grouping disabled, everything else works)

## License

MIT
