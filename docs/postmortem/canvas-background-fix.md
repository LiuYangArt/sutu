# Postmortem: Canvas Background Setting Issue

## Issue Description

Adding a "Canvas Background" setting in the Settings Panel did not correctly update the workspace background color. While the setting was persisted and the CSS variable was updated, the visual change was not reflected in the application workspace.

## Root Cause Analysis

1. **CSS Specificity/Layering**: The `body` element's background color was being correctly updated via the `--app-bg` (formerly `--bg-primary`) variable.
2. **Blocking Element**: The `.canvas-container` element (defined in `Canvas.css`), which sits on top of the body and holds the canvas, had a hardcoded background color: `background: var(--bg-secondary);`.
3. **Observation Failure**: Initial testing was done at 100% zoom where the canvas covers most of the viewport, making it hard to distinguish between "canvas background" vs "viewport background".

## Solution

1. **Variable Strategy**: Introduced a dedicated `--app-bg` CSS variable in `global.css` to specifically control the application workspace background, separating it from the generic UI background `--bg-primary`.
2. **CSS Update**: Updated `src/components/Canvas/Canvas.css` to use `var(--app-bg)` for the `.canvas-container` instead of the hardcoded secondary background color.
3. **Logic Update**: Updated `useSettingsStore` to target this specific `--app-bg` variable when the canvas background setting changes.

## Lessons Learned

- **Visual Hierarchy**: When implementing background color changes, always verify which DOM layer is actually visible to the user.
- **Testing Conditions**: Test viewport/background changes at different zoom levels to ensure the entire workspace is visible.
- **CSS Variable Semantics**: Use specific semantic variables (like `--app-bg`) rather than reusing generic ones (`--bg-primary`) when independent control is required.
