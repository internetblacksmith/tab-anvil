# TabAnvil

Firefox tab manager extension -- full-page dashboard for 100+ tabs with native grouping, search, sort, and keyboard navigation. Zero dependencies (vanilla JS).

## Build Commands

```bash
make lint       # Lint JS files
make package    # Package as .xpi for distribution
make clean      # Remove build artifacts
```

## Critical Rules

- Pin dependencies to exact versions (currently: zero deps, keep it that way)
- Keep docs updated with every code change
- Keep Makefile updated -- add new tasks as project evolves
- No external dependencies -- vanilla JS only, no npm, no build step
- Use `browser.*` APIs (Firefox), not `chrome.*` (Chrome compatibility layer)

## Detailed Guides

| Topic | Guide |
|-------|-------|
| README | [README.md](README.md) |
