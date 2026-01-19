# UI Guidelines - PaintBoard Design System

This document defines the UI standards for PaintBoard, ensuring visual consistency across all components.

## Core Principles

1. **Single Source of Truth**: All design tokens defined in `src/styles/global.css`
2. **No Hardcoding**: Never use raw color values, z-index numbers, or border-radius in component CSS
3. **Fluent/Mica Style**: Follow Windows 11 inspired glass morphism aesthetic

---

## Accent Color

**Variable**: `--accent` (alias for `--primary`)

| Token              | Value                     | Usage                                       |
| ------------------ | ------------------------- | ------------------------------------------- |
| `--accent`         | `#137fec`                 | Primary interactive elements, active states |
| `--accent-hover`   | `#1a8fff`                 | Hover state for accent elements             |
| `--primary-active` | `#0d6ecc`                 | Active/pressed state                        |
| `--primary-bg`     | `rgba(19, 127, 236, 0.2)` | Background for selected items               |
| `--primary-border` | `rgba(19, 127, 236, 0.4)` | Border for focused inputs                   |

```css
/* Correct */
.button-primary {
  background: var(--accent);
}
.item.active {
  background: var(--primary-bg);
  color: var(--accent);
}

/* Wrong - never do this */
.button-primary {
  background: #137fec;
}
```

---

## Panel Background

**Preferred**: Use `.mica-panel` utility class for consistent glass effect.

| Token             | Value                           | Usage                             |
| ----------------- | ------------------------------- | --------------------------------- |
| `--mica-bg`       | `rgba(20, 20, 25, 0.8)`         | Semi-transparent panel background |
| `--mica-bg-solid` | `#1e1e23`                       | Solid fallback for performance    |
| `--mica-blur`     | `blur(20px) saturate(120%)`     | Backdrop filter                   |
| `--mica-border`   | `rgba(255, 255, 255, 0.08)`     | Subtle panel border               |
| `--mica-shadow`   | `0 4px 30px rgba(0, 0, 0, 0.3)` | Panel shadow                      |

```css
/* Preferred - use utility class */
<div class="mica-panel">...</div>

/* Alternative - manual application */
.custom-panel {
  background: var(--mica-bg);
  backdrop-filter: var(--mica-blur);
  border: 1px solid var(--mica-border);
  box-shadow: var(--mica-shadow);
  border-radius: var(--radius-xl);
}
```

---

## Color System

### Background Colors

| Token            | Value                       | Usage                           |
| ---------------- | --------------------------- | ------------------------------- |
| `--bg-primary`   | `#0f1318`                   | App background                  |
| `--bg-secondary` | `#111a22`                   | Canvas area, secondary surfaces |
| `--bg-tertiary`  | `rgba(255, 255, 255, 0.05)` | Subtle surface elevation        |
| `--bg-elevated`  | `rgba(255, 255, 255, 0.08)` | Hover states, elevated surfaces |

### Text Colors

| Token              | Value     | Usage                  |
| ------------------ | --------- | ---------------------- |
| `--text-primary`   | `#ffffff` | Primary text, headings |
| `--text-secondary` | `#9ca3af` | Secondary text, labels |
| `--text-muted`     | `#6b7280` | Disabled text, hints   |
| `--text-disabled`  | `#4b5563` | Disabled controls      |

### Semantic Colors

| Token            | Value     | Background Variant | Usage                       |
| ---------------- | --------- | ------------------ | --------------------------- |
| `--danger`       | `#ef4444` | `--danger-bg`      | Destructive actions, errors |
| `--danger-hover` | `#f87171` | -                  | Hover state for danger      |
| `--success`      | `#22c55e` | `--success-bg`     | Success states              |
| `--warning`      | `#f59e0b` | `--warning-bg`     | Warnings                    |

### Special Purpose

| Token             | Value     | Usage                             |
| ----------------- | --------- | --------------------------------- |
| `--pattern-light` | `#ffffff` | Transparency checkerboard (light) |
| `--pattern-dark`  | `#e5e5e5` | Transparency checkerboard (dark)  |

---

## Z-Index Layers

Use CSS variables for all z-index values. Never use magic numbers.

| Token          | Value | Usage                         |
| -------------- | ----- | ----------------------------- |
| `--z-canvas`   | `0`   | Canvas layer                  |
| `--z-panels`   | `40`  | Side panels, floating panels  |
| `--z-header`   | `50`  | Top toolbar                   |
| `--z-overlay`  | `60`  | Overlays, backdrops           |
| `--z-modal`    | `70`  | Modal dialogs                 |
| `--z-dropdown` | `80`  | Dropdown menus                |
| `--z-popover`  | `90`  | Popovers, tooltips containers |
| `--z-tooltip`  | `100` | Tooltips (highest)            |

```css
/* Correct */
.dropdown {
  z-index: var(--z-dropdown);
}
.modal {
  z-index: var(--z-modal);
}

/* Wrong - never do this */
.dropdown {
  z-index: 99999;
}
```

---

## Border Radius

| Token           | Value    | Usage                    |
| --------------- | -------- | ------------------------ |
| `--radius-sm`   | `4px`    | Small elements, inputs   |
| `--radius-md`   | `6px`    | Buttons, cards           |
| `--radius-lg`   | `8px`    | Panels, larger cards     |
| `--radius-xl`   | `10px`   | Main panels, dialogs     |
| `--radius-full` | `9999px` | Pills, circular elements |

---

## Borders & Dividers

| Token             | Value                       | Usage                  |
| ----------------- | --------------------------- | ---------------------- |
| `--border`        | `rgba(255, 255, 255, 0.08)` | Default border         |
| `--border-subtle` | `rgba(255, 255, 255, 0.05)` | Very subtle separators |
| `--border-strong` | `rgba(255, 255, 255, 0.12)` | Emphasized borders     |
| `--divider`       | `rgba(255, 255, 255, 0.1)`  | Section dividers       |

---

## Prohibited Patterns

### Never Hardcode

```css
/* WRONG */
background: #1e1e23;
color: #ffffff;
z-index: 100000;
border-radius: 8px;

/* CORRECT */
background: var(--mica-bg-solid);
color: var(--text-primary);
z-index: var(--z-dropdown);
border-radius: var(--radius-lg);
```

### Exceptions

- **Transparency checkerboard patterns**: Use `--pattern-light` and `--pattern-dark`
- **Gradients**: May use raw values if not covered by tokens
- **Third-party component overrides**: Document why token cannot be used

---

## Quick Reference

```css
/* Panel with glass effect */
.my-panel {
  @extend .mica-panel; /* or apply manually */
}

/* Active/selected item */
.item.active {
  background: var(--primary-bg);
  color: var(--accent);
}

/* Danger button */
.btn-danger {
  background: var(--danger);
}
.btn-danger:hover {
  background: var(--danger-hover);
}

/* Layered UI */
.side-panel {
  z-index: var(--z-panels);
}
.dropdown-menu {
  z-index: var(--z-dropdown);
}
.modal-dialog {
  z-index: var(--z-modal);
}
```
