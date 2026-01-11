# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

PaintBoard is a professional painting software with low-latency pen input, built with **Tauri 2.x + React 18 + Rust**. Target: < 12ms input latency for Wacom tablets.

## Development Commands

```bash
# Development
pnpm dev              # Start Tauri dev server (frontend + backend hot reload)
pnpm dev:frontend     # Frontend only (Vite)
pnpm build:rust       # Build Rust backend only

# Quality Checks
pnpm check:all        # Run all checks (typecheck + lint + lint:rust + test)
pnpm typecheck        # TypeScript type checking
pnpm lint             # ESLint for frontend
pnpm lint:rust        # Clippy for Rust (cargo clippy)
pnpm format           # Format all code (Prettier + cargo fmt)

# Testing
pnpm test             # Run frontend tests (Vitest)
pnpm test:watch       # Watch mode
cargo test --manifest-path src-tauri/Cargo.toml  # Rust tests
cargo bench --manifest-path src-tauri/Cargo.toml # Performance benchmarks

# Build
pnpm build            # Production build (frontend + Tauri)
```

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                    Tauri App                         │
├─────────────────────────────────────────────────────┤
│  Rust Backend (src-tauri/)                          │
│  ├── input/     → Tablet input via octotablet      │
│  │   ├── processor.rs  → Event filtering/timestamps│
│  │   └── tablet.rs     → Device integration        │
│  ├── brush/     → Stroke processing engine         │
│  │   ├── engine.rs     → BrushEngine core          │
│  │   └── interpolation.rs → Catmull-Rom splines    │
│  └── commands.rs → Tauri IPC commands              │
├─────────────────────────────────────────────────────┤
│  Frontend (src/)                     IPC ↑↓         │
│  ├── stores/    → Zustand state (document, tool)   │
│  ├── components/→ React UI (Canvas, Toolbar, etc.) │
│  └── gpu/       → WebGPU rendering (future)        │
└─────────────────────────────────────────────────────┘
```

### Data Flow: Pen Input → Rendered Stroke

1. **octotablet** (Rust) captures raw tablet events
2. **InputProcessor** filters, timestamps, applies pressure curves
3. **BrushEngine** interpolates points (Catmull-Rom), generates `StrokeSegment`
4. **Tauri Event** sends segments to frontend
5. **Canvas Renderer** draws via WebGPU/Canvas2D

### Key Data Structures

**Rust** (`src-tauri/src/`):
- `RawInputPoint` - Raw tablet input (x, y, pressure, tilt, timestamp)
- `BrushPoint` - Processed point with size/opacity after pressure curve
- `StrokeSegment` - Render-ready stroke data with color/blend mode

**TypeScript** (`src/stores/`):
- `useDocumentStore` - Document state, layers, active layer (Zustand + Immer)
- `useToolStore` - Current tool, brush settings, colors

### IPC Commands

Defined in `src-tauri/src/commands.rs`:
- `create_document(width, height, dpi)` → `DocumentInfo`
- `get_system_info()` → `SystemInfo`
- `process_stroke(points)` → `Vec<StrokeSegment>`

## Code Conventions

### Languages
- **Explanations/comments**: Chinese for discussion, English for code
- **Identifiers/commits**: English

### TypeScript
- Path alias: `@/*` → `./src/*`
- State management: Zustand with Immer middleware
- Strict mode enabled, no `any`

### Rust
- Clippy lints: `unwrap_used` and `expect_used` are warnings
- Use `tracing` for logging, not `println!`
- Error handling: Return `Result<T, String>` from Tauri commands

### File Naming
- React components: `PascalCase.tsx`
- Utilities: `camelCase.ts`
- Rust modules: `snake_case.rs`

## Performance Targets

| Metric | Target |
|--------|--------|
| Input latency | < 12ms |
| Brush render FPS | ≥ 120fps |
| Max canvas size | 16K x 16K |
| Memory (8K canvas) | < 2GB |

## Quality Assurance

### Pre-commit Hooks (Husky + lint-staged)

Every commit automatically runs:
- ESLint + Prettier on staged `.ts/.tsx` files
- `cargo fmt` on staged `.rs` files

### Testing Strategy

| Layer | Tool | Location | Command |
|-------|------|----------|---------|
| Unit (Frontend) | Vitest | `src/**/__tests__/*.test.ts` | `pnpm test` |
| Unit (Rust) | cargo test | `src-tauri/src/**` (`#[cfg(test)]`) | `cargo test` |
| E2E | Playwright | `e2e/*.spec.ts` | `pnpm test:e2e` |
| Performance | Criterion | `src-tauri/benches/` | `cargo bench` |

### Development Workflow

```
1. Write test first (TDD recommended for core logic)
2. Implement feature
3. Run `pnpm check:all` locally
4. Commit (husky auto-runs lint-staged)
5. Push → CI validates (lint → test → build)
```

### When to Write Tests

- **Required**: Core algorithms (brush engine, interpolation, input processing)
- **Required**: State management (Zustand stores)
- **Recommended**: React components with complex logic
- **Optional**: Pure UI components (use E2E for visual regression)

### CI Pipeline

GitHub Actions runs on every PR:
1. `lint` - TypeScript, ESLint, Clippy, rustfmt
2. `test` - Vitest + cargo test with coverage
3. `build` - Frontend + Tauri app
4. `benchmark` - Performance regression (main branch only)

## Current Development Phase

Project is in early stage (M1: Basic Painting). See `docs/todo/development-roadmap.md` for full roadmap.

**Immediate priorities:**
1. Canvas 2D rendering with `desynchronized: true`
2. Pressure-to-brush-size mapping via PointerEvent
3. Catmull-Rom stroke smoothing
4. Basic color picker and brush size controls
