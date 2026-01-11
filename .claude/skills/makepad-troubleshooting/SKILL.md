---
name: makepad-troubleshooting
description: Debug and fix common Makepad compilation errors and runtime issues. Use when encountering build errors, apply errors, borrow checker issues, or unexpected behavior in Makepad applications.
---

# Makepad Troubleshooting

This skill helps diagnose and fix common errors in Makepad development.

## Compilation Errors

### Color Format Error

```
error: expected at least one digit in exponent
   --> src/app.rs:280:33
    |
280 |     color: #14141e
    |            ^^^^^^
```

**Cause**: Hex colors ending with `e` are parsed as scientific notation.

**Fix**: Avoid colors ending with `e`:
```rust
// Bad
color: #14141e

// Good
color: #141420
color: #14141f
```

---

### set_text Missing cx Parameter

```
error[E0061]: this method takes 2 arguments but 1 argument was supplied
   --> src/app.rs:477:16
    |
477 |         label.set_text("Hello");
    |               ^^^^^^^^ argument #1 of type `&mut Cx` is missing
```

**Fix**: Always pass `cx` as first argument:
```rust
// Bad
label.set_text("Hello");

// Good
label.set_text(cx, "Hello");
```

---

### Module Path Error

```
error[E0433]: failed to resolve: could not find `makepad_widgets` in the crate root
   --> src/app.rs:467:16
    |
467 |         crate::makepad_widgets::live_design(cx);
    |                ^^^^^^^^^^^^^^^ could not find
```

**Fix**: `makepad_widgets` is an external crate:
```rust
// Bad
crate::makepad_widgets::live_design(cx);

// Good
makepad_widgets::live_design(cx);
```

---

### TextInput Invalid Properties

```
Apply error: no matching field: empty_message
Apply error: no matching field: draw_select
```

**Fix**: Use correct TextInput properties:
```rust
// Bad
amount_input = <TextInput> {
    empty_message: "Enter value"  // doesn't exist
    draw_select: { color: #00ff8844 }  // doesn't exist
}

// Good
amount_input = <TextInput> {
    text: "1000"  // use text for default value

    draw_bg: { color: #1a1a26 }
    draw_text: { color: #00ff88 }
    draw_cursor: { color: #00ff88 }
}
```

---

### Font Field Not Found

```
Apply error: no matching field: font
WARNING: encountered empty font family
```

**Cause**: The `font:` property doesn't exist. Makepad uses `text_style:` with theme fonts.

**Fix**: Use `text_style` with inline properties or theme font inheritance:
```rust
// WRONG - font property doesn't exist
<Label> {
    draw_text: {
        font: "path/to/font.ttf"  // ❌ Error: no matching field
        font_size: 12.0           // ❌ Error: no matching field
    }
}

// CORRECT - Option 1: inline text_style
<Label> {
    draw_text: {
        text_style: { font_size: 12.0 }
        color: #000
    }
}

// CORRECT - Option 2: inherit from theme font
<Label> {
    draw_text: {
        text_style: <THEME_FONT_REGULAR>{ font_size: 12.0 }
        color: #000
    }
}
```

**Available Theme Fonts**:
```rust
// Import in live_design!
use link::theme::*;

// Theme font options:
THEME_FONT_LABEL     // Default label font
THEME_FONT_REGULAR   // Regular weight
THEME_FONT_BOLD      // Bold weight
THEME_FONT_ITALIC    // Italic style
THEME_FONT_BOLD_ITALIC
THEME_FONT_CODE      // Monospace for code
```

**Custom Font Styles** (recommended pattern from Robrix/Moly):
```rust
live_design! {
    use link::theme::*;

    // Define reusable text styles
    pub TITLE_TEXT = <THEME_FONT_BOLD>{
        font_size: 16.0
    }

    pub BODY_TEXT = <THEME_FONT_REGULAR>{
        font_size: 12.0
        line_spacing: 1.3
    }

    // Use in widgets
    MyLabel = <Label> {
        draw_text: {
            text_style: <BODY_TEXT>{}
            color: #333
        }
    }
}
```

---

### Button Invalid Properties

```
Apply error: no matching field: color_pressed
```

**Fix**: Button's draw_bg doesn't have `color_pressed`:
```rust
// Bad
draw_bg: {
    color: #2a2a38
    color_hover: #3a3a4a
    color_pressed: #00ff8855  // doesn't exist
}

// Good
draw_bg: {
    color: #2a2a38
    color_hover: #3a3a4a
    // Use animator for pressed state instead
}
```

---

### WidgetRef Method Not Found

```
error[E0599]: no method named `rounded_view` found for struct `WidgetRef`
```

**Fix**: Use `view()` for all View-based widgets:
```rust
// Bad
self.ui.rounded_view(id!(my_panel))

// Good
self.ui.view(id!(my_panel))
```

---

### Timer Method Not Found

```
error[E0599]: no method named `timer_id` found for struct `Timer`
```

**Fix**: Don't check timer_id, handle directly:
```rust
// Bad
fn handle_timer(&mut self, cx: &mut Cx, event: &TimerEvent) {
    if event.timer_id == self.my_timer.timer_id() {
        // ...
    }
}

// Good
fn handle_timer(&mut self, cx: &mut Cx, _event: &TimerEvent) {
    // Handle directly - timer events come to the app that started them
    self.on_timer_tick(cx);
}
```

---

## Borrow Checker Issues

### Immutable/Mutable Borrow Conflict

```
error[E0502]: cannot borrow `*self` as mutable because it is also borrowed as immutable
    |
    |     let items = self.get_items();  // immutable borrow
    |                 ---- immutable borrow occurs here
    |     self.modify_item(&code);       // mutable borrow - conflict!
    |     ^^^^^^^^^^^^^^^^^^^ mutable borrow occurs here
```

**Fix**: Separate borrow scopes:
```rust
// Bad
let sorted = self.get_sorted_items();
for item in sorted.iter() {
    self.toggle_item(item);  // Conflict!
}

// Good - collect first, then modify
let item_to_toggle: Option<String> = {
    let sorted = self.get_sorted_items();
    sorted.first().cloned()
};  // Immutable borrow ends here

if let Some(item) = item_to_toggle {
    self.toggle_item(&item);  // Now safe
}
```

### Pattern for Action Handling

```rust
// Bad - borrow conflict in action handling
for (i, card_id) in card_ids.iter().enumerate() {
    let card = self.ui.view(*card_id);
    if card.button(id!(fav_btn)).clicked(&actions) {
        self.toggle_favorite(&currencies[i].code);  // Conflict!
    }
}

// Good - collect action first, then handle
let mut toggle_code: Option<String> = None;
{
    let sorted_currencies = self.get_sorted_currencies();
    for (i, card_id) in card_ids.iter().enumerate() {
        if i < sorted_currencies.len() {
            let card = self.ui.view(*card_id);
            if card.button(id!(fav_btn)).clicked(&actions) {
                toggle_code = Some(sorted_currencies[i].code.to_string());
                break;
            }
        }
    }
}  // Borrow ends

if let Some(code) = toggle_code {
    self.toggle_favorite(&code);
    self.update_cards(cx);
}
```

---

## Apply Errors

### Property Not Found

```
Apply error: no matching field: some_property
```

**Causes & Fixes**:

1. **Typo in property name** - Check spelling
2. **Wrong widget type** - Verify the widget supports that property
3. **Property in wrong section** - Move to correct section

```rust
// Bad - color in wrong place
<Button> {
    color: #ff0000  // Button doesn't have top-level color
}

// Good
<Button> {
    draw_bg: {
        color: #ff0000
    }
}
```

---

### Wrong Value Type

```
Apply error: expected number, found string
```

**Fix**: Use correct value types:
```rust
// Bad
width: "100"
padding: "16"

// Good
width: 100
padding: 16
```

---

## Shader Issues

### Instance Variable Not Updating

<!-- Evolution: 2026-01-10 | source: makepad-component | author: @anthropic -->

**Symptom**: Set instance variable with `set_uniform()` but shader doesn't change.

**Cause**: `set_uniform()` is for uniform variables, not instance variables.

**Fix**: Use `apply_over()` for instance variables:
```rust
// Bad - doesn't work for instance variables
self.draw_bg.set_uniform(cx, id!(progress), &[0.5]);

// Good - use apply_over for instance variables
self.draw_bg.apply_over(cx, live! {
    progress: (0.5)
});
```

---

### Shader If-Branch Not Working

<!-- Evolution: 2026-01-10 | source: makepad-component | author: @anthropic -->

**Symptom**: `if` statement in shader produces unexpected results or no effect.

**Cause**: GPU shaders handle branching differently; if-branches can cause issues.

**Fix**: Use `step()` and `mix()` instead of if-branches:
```rust
// Bad - if branch in shader may not work correctly
fn pixel(self) -> vec4 {
    if self.progress > 0.5 {
        return #ff0000;
    } else {
        return #0000ff;
    }
}

// Good - use step() for conditional logic
fn pixel(self) -> vec4 {
    let red = #ff0000;
    let blue = #0000ff;
    let condition = step(0.5, self.progress);  // 1.0 if progress >= 0.5, else 0.0
    return mix(blue, red, condition);
}
```

For progress bars, use `step()` to determine fill region:
```rust
fn pixel(self) -> vec4 {
    let fill_end = self.rect_size.x * self.progress;
    let px = self.pos.x * self.rect_size.x;
    let in_fill = step(px, fill_end);  // 1.0 if px <= fill_end
    return mix(track_color, fill_color, in_fill);
}
```

---

## Runtime Issues

### UI Not Updating

**Symptom**: Called `set_text()` but nothing changes.

**Fix**: Call `redraw()` after updates:
```rust
// Bad
label.set_text(cx, "New text");

// Good
label.set_text(cx, "New text");
label.redraw(cx);

// Or redraw entire UI
self.ui.redraw(cx);
```

---

### Widget Not Found

**Symptom**: `self.ui.label(id!(my_label))` returns empty widget.

**Causes**:

1. **ID mismatch** - Check spelling in live_design
2. **Wrong parent** - Widget might be nested
3. **Not in view hierarchy** - Widget not visible

**Fix**:
```rust
// If widget is nested
let parent = self.ui.view(id!(parent_view));
let label = parent.label(id!(my_label));

// Or use path
self.ui.label(ids!(parent_view.my_label))
```

---

### Network Request Not Firing

**Symptom**: `handle_network_responses` never called.

**Fix**: Check request ID and ensure proper setup:
```rust
// Request
fn fetch_data(&mut self, cx: &mut Cx) {
    let url = "https://api.example.com/data".to_string();
    let request = HttpRequest::new(url, HttpMethod::GET);
    cx.http_request(live_id!(my_request), request);  // Use live_id!
}

// Response - check same ID
fn handle_network_responses(&mut self, cx: &mut Cx, responses: &NetworkResponsesEvent) {
    for event in responses {
        if event.request_id == live_id!(my_request) {  // Same ID
            match &event.response {
                NetworkResponse::HttpResponse(response) => {
                    if let Some(body) = response.get_string_body() {
                        // Handle response
                    }
                }
                NetworkResponse::HttpRequestError(err) => {
                    log!("Error: {:?}", err);
                }
                _ => {}
            }
        }
    }
}
```

---

### Timer Not Working

**Symptom**: `handle_timer` never called.

**Fix**: Store timer reference and start correctly:
```rust
#[derive(Live, LiveHook)]
pub struct App {
    #[live] ui: WidgetRef,
    #[rust] my_timer: Timer,  // Must store the timer
}

impl MatchEvent for App {
    fn handle_startup(&mut self, cx: &mut Cx) {
        self.my_timer = cx.start_interval(1.0);  // Store result
    }

    fn handle_timer(&mut self, cx: &mut Cx, _event: &TimerEvent) {
        // Timer callback
    }
}
```

---

## Performance Issues

### Excessive Redraws

**Symptom**: UI stutters or high CPU usage.

**Fix**: Only redraw what's needed:
```rust
// Bad - redraw everything
self.ui.redraw(cx);

// Good - redraw specific widget
self.ui.label(id!(my_label)).redraw(cx);

// Good - batch updates then redraw once
self.update_multiple_labels(cx);
self.ui.view(id!(labels_container)).redraw(cx);
```

---

### apply_over Performance

**Symptom**: Slow updates when using apply_over.

**Fix**: Batch apply_over calls:
```rust
// Bad - multiple apply_over calls
for item in items {
    self.ui.label(id!(label)).apply_over(cx, live!{
        draw_text: { color: (color) }
    });
}

// Good - update once, redraw once
self.update_all_items(cx);
self.ui.redraw(cx);
```

---

## Debugging Tips

### Enable Debug Output

```bash
# Run with line info for better error messages
MAKEPAD=lines cargo +nightly run
```

### Use log! Macro

```rust
log!("Value: {:?}", my_value);
log!("State: {} / {}", self.counter, self.is_loading);
```

### Check Event Flow

```rust
impl MatchEvent for App {
    fn handle_actions(&mut self, cx: &mut Cx, actions: &Actions) {
        log!("Actions received: {}", actions.len());

        if self.ui.button(id!(my_btn)).clicked(&actions) {
            log!("Button clicked!");
        }
    }
}
```

---

## Quick Reference

| Error Type | Common Cause | Quick Fix |
|------------|--------------|-----------|
| Color parse error | Color ends in `e` | Change last digit |
| Missing argument | `set_text` needs `cx` | Add `cx` parameter |
| Module not found | Wrong crate path | Use `makepad_widgets::` |
| No matching field: font | Using `font:` property | Use `text_style: <THEME_FONT_*>{}` |
| Empty font family | Missing text_style | Add `text_style: <THEME_FONT_REGULAR>{}` |
| No matching field | Property doesn't exist | Check widget docs |
| Borrow conflict | Mixed mutable/immutable | Separate borrow scopes |
| UI not updating | Missing redraw | Call `redraw(cx)` |
| Widget not found | Wrong ID or path | Check live_design IDs |
| Timer not firing | Timer not stored | Store in `#[rust]` field |
| Instance var not updating | Using set_uniform | Use apply_over instead |
| Shader if-branch fails | GPU branching issue | Use step()/mix() instead |
