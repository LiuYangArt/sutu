---
name: makepad-fundamentals
description: Create and edit Makepad UI applications with live_design! macro, widgets, events, and app architecture. Use when working with Makepad projects, creating widgets, handling events, or setting up app structure in Rust.
---

# Makepad Fundamentals

This skill enables Claude Code to create and edit Makepad UI applications, including live design DSL, widgets, events, and app architecture.

## Overview

Makepad is a Rust-based cross-platform UI framework using:
- `live_design!` macro for declarative UI layout
- Widget composition with `#[derive(Live, Widget)]`
- Event-driven architecture with typed Actions
- GPU-accelerated rendering

## Project Structure

```
my_app/
├── src/
│   ├── app.rs              # Main app entry, event routing
│   ├── lib.rs              # Module declarations, live_register
│   ├── home/               # Feature modules
│   │   ├── mod.rs
│   │   └── home_screen.rs
│   └── shared/             # Reusable widgets
│       ├── mod.rs
│       ├── styles.rs       # Theme, colors
│       └── widgets.rs
└── resources/              # Images, fonts
```

## live_design! Macro

The core of Makepad UI definition:

```rust
live_design! {
    use link::theme::*;
    use link::shaders::*;
    use link::widgets::*;

    App = {{App}} {
        ui: <Root> {
            main_window = <Window> {
                body = <View> {
                    flow: Down,
                    spacing: 10,
                    padding: 20,

                    my_button = <Button> {
                        text: "Click me"
                        draw_bg: { color: #4A90D9 }
                    }

                    <Label> { text: "Hello Makepad" }
                }
            }
        }
    }
}
```

### DSL Syntax Reference

| Syntax | Purpose | Example |
|--------|---------|---------|
| `<Widget>` | Instantiate widget | `<Button> { text: "OK" }` |
| `name = <Widget>` | Named reference | `my_btn = <Button> {}` |
| `{{StructName}}` | Link to Rust struct | `App = {{App}} {}` |
| `flow: Down/Right` | Layout direction | `flow: Down` |
| `width/height` | Sizing | `width: Fill, height: Fit` |
| `padding/margin` | Spacing | `padding: {left: 10, top: 5}` |
| `dep("crate://...")` | Resource path | `dep("crate://self/logo.png")` |

### Size Values

| Value | Meaning |
|-------|---------|
| `Fill` | Fill available space |
| `Fit` | Fit to content |
| `Fixed(100.0)` | Fixed size in pixels |
| `All` | Fill in all directions |

### Layout Properties

```rust
// Flow direction
flow: Down       // Vertical (default)
flow: Right      // Horizontal
flow: Overlay    // Stack on top of each other

// Spacing and padding
spacing: 12                              // Between children
padding: 16                              // All sides
padding: {left: 10, right: 10}           // Specific sides
padding: {top: 8, bottom: 8, left: 16, right: 16}

margin: {bottom: 10}

// Alignment (0.0 to 1.0)
align: {x: 0.5, y: 0.5}    // Center
align: {x: 0.0, y: 0.0}    // Top-left
align: {x: 1.0, y: 1.0}    // Bottom-right
```

## Fonts and Text Styles

**IMPORTANT**: Makepad does NOT use a `font:` property. Use `text_style:` with either inline properties or theme font inheritance.

### Font Syntax Options

```rust
live_design! {
    use link::theme::*;

    // Option 1: Inline text_style (simplest)
    <Label> {
        draw_text: {
            text_style: { font_size: 14.0 }
            color: #000
        }
    }

    // Option 2: Inherit from theme font (recommended)
    <Label> {
        draw_text: {
            text_style: <THEME_FONT_REGULAR>{ font_size: 14.0 }
            color: #000
        }
    }

    // Option 3: Theme font without size override
    <Label> {
        draw_text: {
            text_style: <THEME_FONT_BOLD>{}
            color: #000
        }
    }
}
```

### Theme Fonts (Built-in)

```rust
live_design! {
    use link::theme::*;  // Required import

    // Available theme fonts:
    // THEME_FONT_LABEL       - Default for labels
    // THEME_FONT_REGULAR     - Regular weight text
    // THEME_FONT_BOLD        - Bold weight
    // THEME_FONT_ITALIC      - Italic style
    // THEME_FONT_BOLD_ITALIC - Bold + Italic
    // THEME_FONT_CODE        - Monospace for code
}
```

### Correct vs Wrong Syntax

```rust
// ✅ CORRECT - inline text_style
draw_text: {
    text_style: { font_size: 14.0 }
    color: #000
}

// ✅ CORRECT - theme font inheritance
draw_text: {
    text_style: <THEME_FONT_BOLD>{ font_size: 14.0 }
    color: #000
}

// ❌ WRONG - font property doesn't exist
draw_text: {
    font: "path/to/font.ttf"  // Error: no matching field
    font_size: 14.0
}

// ❌ WRONG - font_size outside text_style
draw_text: {
    font_size: 14.0  // Error: no matching field
    color: #000
}
```

### Creating Reusable Text Styles

Define custom text styles for consistency (pattern from Robrix/Moly):

```rust
live_design! {
    use link::theme::*;

    // Define your app's text styles
    pub TITLE_TEXT = <THEME_FONT_BOLD>{
        font_size: 18.0
    }

    pub SUBTITLE_TEXT = <THEME_FONT_REGULAR>{
        font_size: 14.0
        line_spacing: 1.3
    }

    pub BODY_TEXT = <THEME_FONT_REGULAR>{
        font_size: 12.0
        line_spacing: 1.4
    }

    pub CAPTION_TEXT = <THEME_FONT_REGULAR>{
        font_size: 10.0
    }

    pub CODE_TEXT = <THEME_FONT_CODE>{
        font_size: 11.0
    }

    pub BUTTON_TEXT = <THEME_FONT_BOLD>{
        font_size: 13.0
    }
}
```

### Using Custom Text Styles

```rust
live_design! {
    use link::theme::*;
    use crate::shared::styles::*;  // Import your styles

    PageHeader = <View> {
        <Label> {
            draw_text: {
                text_style: <TITLE_TEXT>{}
                color: #000
            }
            text: "Page Title"
        }

        <Label> {
            draw_text: {
                text_style: <SUBTITLE_TEXT>{}
                color: #666
            }
            text: "Page subtitle"
        }
    }
}
```

### Font Size Override

Override font size while keeping the font family:

```rust
<Label> {
    draw_text: {
        // Base style with custom size
        text_style: <THEME_FONT_REGULAR>{ font_size: 20.0 }
        color: #333
    }
}

// Or with your custom style
<Label> {
    draw_text: {
        text_style: <BODY_TEXT>{ font_size: 16.0 }  // Override size
        color: #333
    }
}
```

### HTML Widget Font Configuration

For HTML content widgets, configure each style variant:

```rust
html_content = <Html> {
    font_size: 12.0  // Base size

    draw_normal:      { text_style: <THEME_FONT_REGULAR>{ font_size: 12.0 } }
    draw_italic:      { text_style: <THEME_FONT_ITALIC>{ font_size: 12.0 } }
    draw_bold:        { text_style: <THEME_FONT_BOLD>{ font_size: 12.0 } }
    draw_bold_italic: { text_style: <THEME_FONT_BOLD_ITALIC>{ font_size: 12.0 } }
    draw_fixed:       { text_style: <THEME_FONT_CODE>{ font_size: 11.0 } }
}
```

### Multi-Script Support

Theme fonts automatically support multiple scripts (Latin, Chinese, Emoji):

```rust
// No extra configuration needed - theme fonts handle:
// - Latin characters (IBMPlexSans)
// - Chinese characters (LXGWWenKai)
// - Emoji (NotoColorEmoji)

<Label> {
    draw_text: {
        text_style: <THEME_FONT_REGULAR>{ font_size: 14.0 }
        color: #000
    }
    text: "Hello 你好 👋"  // All rendered correctly
}
```

### Text Properties Reference

| Property | Location | Example |
|----------|----------|---------|
| `text_style` | `draw_text: {}` | `text_style: <THEME_FONT_REGULAR>{}` |
| `font_size` | Inside text_style | `{ font_size: 14.0 }` |
| `line_spacing` | Inside text_style | `{ line_spacing: 1.3 }` |
| `color` | `draw_text: {}` | `color: #333` |
| `wrap` | `draw_text: {}` | `wrap: Word`, `wrap: Ellipsis` |

### Complete Example

```rust
live_design! {
    use link::theme::*;
    use link::widgets::*;

    // Custom styles
    pub HEADER_TEXT = <THEME_FONT_BOLD>{ font_size: 24.0 }
    pub BODY_TEXT = <THEME_FONT_REGULAR>{ font_size: 14.0, line_spacing: 1.4 }

    // Widget using custom styles
    ArticleCard = <RoundedView> {
        padding: 16
        draw_bg: { color: #fff, border_radius: 8.0 }

        flow: Down
        spacing: 8

        title = <Label> {
            width: Fill
            draw_text: {
                text_style: <HEADER_TEXT>{}
                color: #111
                wrap: Word
            }
        }

        body = <Label> {
            width: Fill
            draw_text: {
                text_style: <BODY_TEXT>{}
                color: #444
                wrap: Word
            }
        }
    }
}
```

## Common Widgets

### Label

```rust
my_label = <Label> {
    width: Fit
    draw_text: {
        text_style: <THEME_FONT_REGULAR>{ font_size: 16.0 }
        color: #ffffff
    }
    text: "Hello World"
}
```

### Button

```rust
my_btn = <Button> {
    width: Fit
    height: 40
    padding: {left: 16, right: 16}
    text: "Submit"

    draw_bg: {
        color: #2196F3
        color_hover: #1976D2
        border_radius: 4.0
    }

    draw_text: {
        text_style: <THEME_FONT_BOLD>{ font_size: 14.0 }
        color: #ffffff
    }
}
```

### TextInput

```rust
my_input = <TextInput> {
    width: Fill
    height: Fit
    padding: {top: 12, bottom: 12, left: 10, right: 10}

    text: "Default value"

    draw_bg: {
        color: #1a1a1a
        border_radius: 4.0
    }

    draw_text: {
        text_style: <THEME_FONT_REGULAR>{ font_size: 18.0 }
        color: #00ff88
    }

    draw_cursor: {
        color: #00ff88
    }
}

// Handle input changes
if let Some(text) = self.ui.text_input(id!(my_input)).changed(&actions) {
    if let Ok(value) = text.parse::<f64>() {
        self.amount = value;
    }
}
```

### ScrollYView

```rust
<ScrollYView> {
    width: Fill
    height: Fill
    flow: Down
    spacing: 10

    // Scrollable content
    <View> { height: 100, show_bg: true, draw_bg: { color: #333 } }
    <View> { height: 100, show_bg: true, draw_bg: { color: #444 } }
    <View> { height: 100, show_bg: true, draw_bg: { color: #555 } }
}
```

### RoundedView

```rust
<RoundedView> {
    width: Fill
    height: Fit
    padding: 16

    draw_bg: {
        color: #1a1a26
        border_radius: 8.0
    }

    <Label> { text: "Card content" }
}
```

### Window

```rust
ui: <Window> {
    window: {
        title: "My App"
        inner_size: vec2(400, 600)
    }

    show_bg: true
    draw_bg: { color: #1a1a1a }

    body = <View> {
        // Window content
    }
}
```

## Widget Creation

### Basic Widget Pattern

```rust
#[derive(Live, LiveHook, Widget)]
pub struct MyWidget {
    #[deref] view: View,          // Delegate to parent
    #[live] some_prop: f64,       // DSL-configurable
    #[rust] internal_state: i32,  // Rust-only state
}

impl Widget for MyWidget {
    fn handle_event(&mut self, cx: &mut Cx, event: &Event, scope: &mut Scope) {
        self.view.handle_event(cx, event, scope);
    }

    fn draw_walk(&mut self, cx: &mut Cx2d, scope: &mut Scope, walk: Walk) -> DrawStep {
        self.view.draw_walk(cx, scope, walk)
    }
}
```

### Field Attributes

| Attribute | Purpose |
|-----------|---------|
| `#[live]` | DSL-configurable property |
| `#[rust]` | Rust-only state (not in DSL) |
| `#[deref]` | Delegate to inner widget |
| `#[animator]` | Animation state machine |
| `#[redraw]` | Triggers redraw on change |
| `#[walk]` | Layout positioning |
| `#[layout]` | Layout rules |

### Widget with Custom Actions

```rust
#[derive(Clone, Debug, DefaultNone)]
pub enum MyWidgetAction {
    Clicked,
    ValueChanged(f64),
    None,
}

impl Widget for MyWidget {
    fn handle_event(&mut self, cx: &mut Cx, event: &Event, scope: &mut Scope) {
        self.view.handle_event(cx, event, scope);

        match event.hits(cx, self.view.area()) {
            Hit::FingerDown(_) => {
                cx.widget_action(self.widget_uid(), &scope.path,
                    MyWidgetAction::Clicked);
            }
            Hit::FingerUp(fe) => {
                if fe.is_over {
                    cx.widget_action(self.widget_uid(), &scope.path,
                        MyWidgetAction::ValueChanged(1.0));
                }
            }
            _ => {}
        }
    }
}
```

## Event Handling

### App-Level Event Routing

```rust
impl MatchEvent for App {
    fn handle_startup(&mut self, cx: &mut Cx) {
        // Initialize on app start
    }

    fn handle_actions(&mut self, cx: &mut Cx, actions: &Actions) {
        // Handle button click
        if self.ui.button(ids!(my_button)).clicked(&actions) {
            self.counter += 1;
            self.ui.label(ids!(counter_label))
                .set_text(cx, &format!("{}", self.counter));
        }

        // Handle custom action
        for action in actions {
            if let MyWidgetAction::ValueChanged(val) = action.cast() {
                self.handle_value_change(cx, val);
            }
        }
    }

    fn handle_network_responses(&mut self, cx: &mut Cx, responses: &NetworkResponsesEvent) {
        for event in responses {
            match &event.response {
                NetworkResponse::HttpResponse(res) if res.status_code == 200 => {
                    let data: MyData = res.get_json_body().unwrap();
                    self.process_data(cx, data);
                }
                _ => {}
            }
        }
    }
}

impl AppMain for App {
    fn handle_event(&mut self, cx: &mut Cx, event: &Event) {
        self.match_event(cx, event);
        self.ui.handle_event(cx, event, &mut Scope::empty());
    }
}

app_main!(App);
```

### ids! Macro Patterns

```rust
// Single widget
self.ui.button(ids!(my_button))

// Nested path
self.ui.label(ids!(container.header.title))

// Multiple widgets (radio button set)
self.ui.radio_button_set(ids!(tab1, tab2, tab3))
```

### Hit Testing

```rust
match event.hits(cx, self.draw_bg.area()) {
    Hit::FingerDown(fe) => { /* mouse/touch down */ }
    Hit::FingerUp(fe) => { /* mouse/touch up */ }
    Hit::FingerMove(fe) => { /* drag */ }
    Hit::FingerHoverIn(_) => { /* hover enter */ }
    Hit::FingerHoverOut(_) => { /* hover leave */ }
    Hit::KeyDown(ke) => { /* key press */ }
    Hit::KeyUp(ke) => { /* key release */ }
    Hit::KeyFocus(_) => { /* gained keyboard focus */ }
    Hit::KeyFocusLost(_) => { /* lost keyboard focus */ }
    _ => {}
}
```

## Module Registration

```rust
// In lib.rs
impl LiveRegister for App {
    fn live_register(cx: &mut Cx) {
        makepad_widgets::live_design(cx);

        // Register your modules
        crate::shared::live_design(cx);
        crate::home::live_design(cx);

        // Link theme
        cx.link(live_id!(theme), live_id!(theme_desktop_dark));
    }
}

// In each module's mod.rs
pub fn live_design(cx: &mut Cx) {
    self::home_screen::live_design(cx);
    self::sidebar::live_design(cx);
}
```

## State Management

### Thread-Local State (UI Thread Only)

```rust
thread_local! {
    static APP_DATA: Rc<RefCell<AppData>> = Rc::new(RefCell::new(AppData::default()));
}

pub fn get_app_data(_cx: &mut Cx) -> Rc<RefCell<AppData>> {
    APP_DATA.with(Rc::clone)
}
```

### Scope-Based Data Passing

```rust
// Parent passes data
let mut scope = Scope::with_data(&mut self.store);
self.view.handle_event(cx, event, &mut scope);

// Child accesses data
fn handle_event(&mut self, cx: &mut Cx, event: &Event, scope: &mut Scope) {
    if let Some(store) = scope.data.get_mut::<Store>() {
        store.update_something();
    }
}
```

## Network Operations

### HTTP Requests

```rust
fn send_request(&self, cx: &mut Cx) {
    let request_id = live_id!(FetchData);
    let mut request = HttpRequest::new(url, HttpMethod::POST);
    request.set_header("Content-Type".to_string(), "application/json".to_string());
    request.set_json_body(&data);
    cx.http_request(request_id, request);
}
```

### Background Thread Communication

```rust
use makepad_widgets::SignalToUI;

// In background thread
std::thread::spawn(move || {
    let result = expensive_computation();
    cx.action(MyAction::ComputationDone(result));
    SignalToUI::set_ui_signal();  // Wake UI thread
});

// In UI thread (handle_actions)
for action in actions {
    if let Some(MyAction::ComputationDone(result)) = action.downcast_ref() {
        self.update_ui_with_result(cx, result);
    }
}
```

## Timer

### Setup Timer

```rust
#[derive(Live, LiveHook)]
pub struct App {
    #[live] ui: WidgetRef,
    #[rust] refresh_timer: Timer,
    #[rust] countdown: i32,
}

impl MatchEvent for App {
    fn handle_startup(&mut self, cx: &mut Cx) {
        self.countdown = 30;
        self.refresh_timer = cx.start_interval(1.0);  // 1 second interval
    }

    fn handle_timer(&mut self, cx: &mut Cx, _event: &TimerEvent) {
        self.countdown -= 1;
        self.update_countdown_display(cx);

        if self.countdown <= 0 {
            self.countdown = 30;
            self.refresh_data(cx);
        }
    }
}
```

## Dynamic UI Updates

### Using apply_over

Update widget properties at runtime:

```rust
// Update text color
self.ui.label(id!(my_label)).apply_over(cx, live!{
    draw_text: { color: #ff0000 }
});

// Update background
self.ui.view(id!(my_view)).apply_over(cx, live!{
    show_bg: true
    draw_bg: { color: #ffffff }
});

// Update multiple properties
self.ui.button(id!(theme_btn)).apply_over(cx, live!{
    draw_text: { color: (accent_color) }
    draw_bg: { color: (bg_color) }
});

// Always redraw after updates
self.ui.redraw(cx);
```

### Using Variables in live!

```rust
let colors = self.current_theme.colors();

self.ui.label(id!(title)).apply_over(cx, live!{
    draw_text: { color: (colors.accent) }  // Use parentheses for variables
});

self.ui.view(id!(card)).apply_over(cx, live!{
    draw_bg: { color: (colors.bg_card) }
});
```

### Updating Text

```rust
// Always pass cx as first argument
label.set_text(cx, "New text");
label.redraw(cx);

// Update input text
input.set_text(cx, "1000");
```

## Common Mistakes

| Mistake | Fix |
|---------|-----|
| Forgetting `live_design(cx)` call | Register in `LiveRegister::live_register` |
| Missing `#[deref]` on View | Add `#[deref] view: View` for delegation |
| Not calling `redraw(cx)` after state change | Always call `self.redraw(cx)` or `widget.redraw(cx)` |
| Using `action.cast()` for non-widget actions | Use `action.downcast_ref()` for background thread actions |
| Blocking UI thread with async | Use `SignalToUI::set_ui_signal()` from background threads |

## References

- [Makepad Repository](https://github.com/makepad/makepad)
- [Makepad Examples](https://github.com/makepad/makepad/tree/main/examples)
- [ui_zoo example](https://github.com/makepad/makepad/tree/main/examples/ui_zoo) - Widget showcase
