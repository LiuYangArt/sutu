---
name: makepad-patterns
description: Production-ready widget patterns for Makepad applications. Use when implementing modals, overlays, lists, navigation, async data loading, or complex widget compositions in Makepad projects.
---

# Makepad Patterns

This skill provides production-ready widget patterns extracted from Robrix and Moly applications for building complex Makepad UIs.

## Overview

These patterns demonstrate real-world solutions for common UI challenges:
- Widget composition and extension
- Modal and overlay rendering
- Dynamic lists with templates
- Navigation systems
- Async data handling
- State management

## Pattern 1: Widget Reference Extension

Add helper methods to widget references without modifying the widget.

```rust
pub trait AvatarWidgetRefExt {
    fn set_user(&self, cx: &mut Cx, user: &UserInfo);
    fn show_placeholder(&self, cx: &mut Cx);
}

impl AvatarWidgetRefExt for AvatarRef {
    fn set_user(&self, cx: &mut Cx, user: &UserInfo) {
        if let Some(mut inner) = self.borrow_mut() {
            inner.user_info = Some(user.clone());
            inner.view.label(ids!(name)).set_text(cx, &user.name);
            inner.redraw(cx);
        }
    }

    fn show_placeholder(&self, cx: &mut Cx) {
        if let Some(mut inner) = self.borrow_mut() {
            inner.user_info = None;
            inner.view.label(ids!(name)).set_text(cx, "?");
            inner.redraw(cx);
        }
    }
}
```

## Pattern 2: Modal/Overlay Widget

Renders above all other content using DrawList2d.

```rust
#[derive(Live, Widget)]
pub struct Modal {
    #[live] content: View,
    #[live] draw_bg: DrawQuad,
    #[rust(DrawList2d::new(cx))] draw_list: DrawList2d,
    #[rust] opened: bool,
}

impl Widget for Modal {
    fn draw_walk(&mut self, cx: &mut Cx2d, scope: &mut Scope, walk: Walk) -> DrawStep {
        if !self.opened {
            return DrawStep::done();
        }

        // Begin overlay rendering
        self.draw_list.begin_overlay_reuse(cx);

        cx.begin_pass_sized_turtle(Layout::flow_down());
        self.draw_bg.draw_walk(cx, Walk::fill());
        self.content.draw_all(cx, scope);
        cx.end_pass_sized_turtle();

        self.draw_list.end(cx);
        DrawStep::done()
    }

    fn handle_event(&mut self, cx: &mut Cx, event: &Event, scope: &mut Scope) {
        if !self.opened { return; }

        cx.sweep_unlock(self.draw_bg.area());
        self.content.handle_event(cx, event, scope);
        cx.sweep_lock(self.draw_bg.area());

        // Click outside to dismiss
        match event.hits(cx, self.draw_bg.area()) {
            Hit::FingerDown(fe) => {
                let content_rect = self.content.area().rect(cx);
                if !content_rect.contains(fe.abs) {
                    self.close(cx);
                    cx.widget_action(self.widget_uid(), &scope.path,
                        ModalAction::Dismissed);
                }
            }
            _ => {}
        }
    }
}

impl ModalRef {
    pub fn open(&self, cx: &mut Cx) {
        if let Some(mut inner) = self.borrow_mut() {
            inner.opened = true;
            inner.redraw(cx);
        }
    }

    pub fn close(&self, cx: &mut Cx) {
        if let Some(mut inner) = self.borrow_mut() {
            inner.opened = false;
            inner.redraw(cx);
        }
    }
}
```

## Pattern 3: Collapsible Widget

Toggle visibility with animation.

```rust
#[derive(Clone, Debug, DefaultNone)]
pub enum CollapsibleAction {
    Toggled { now_expanded: bool },
    None,
}

#[derive(Live, LiveHook, Widget)]
pub struct CollapsibleHeader {
    #[deref] view: View,
    #[animator] animator: Animator,
    #[rust] is_expanded: bool,
}

impl Widget for CollapsibleHeader {
    fn handle_event(&mut self, cx: &mut Cx, event: &Event, scope: &mut Scope) {
        if self.animator_handle_event(cx, event).must_redraw() {
            self.redraw(cx);
        }

        self.view.handle_event(cx, event, scope);

        match event.hits(cx, self.view.area()) {
            Hit::FingerDown(_) => {
                self.is_expanded = !self.is_expanded;

                if self.is_expanded {
                    self.animator_play(cx, ids!(expand.on));
                } else {
                    self.animator_play(cx, ids!(expand.off));
                }

                cx.widget_action(self.widget_uid(), &scope.path,
                    CollapsibleAction::Toggled { now_expanded: self.is_expanded });
            }
            _ => {}
        }
    }

    fn draw_walk(&mut self, cx: &mut Cx2d, scope: &mut Scope, walk: Walk) -> DrawStep {
        let rotation = if self.is_expanded { 180.0 } else { 0.0 };
        self.view.icon(ids!(arrow)).apply_over(cx, live! {
            draw_icon: { rotation_angle: (rotation) }
        });

        self.view.draw_walk(cx, scope, walk)
    }
}
```

## Pattern 4: List with Template

Dynamic list from data using a template widget.

```rust
#[derive(Live, Widget)]
pub struct ItemList {
    #[deref] view: View,
    #[live] item_template: Option<LivePtr>,
    #[rust] items: Vec<ItemData>,
    #[rust] item_widgets: Vec<WidgetRef>,
}

impl Widget for ItemList {
    fn draw_walk(&mut self, cx: &mut Cx2d, scope: &mut Scope, walk: Walk) -> DrawStep {
        // Ensure we have enough widgets
        while self.item_widgets.len() < self.items.len() {
            let widget = WidgetRef::new_from_ptr(cx, self.item_template);
            self.item_widgets.push(widget);
        }

        cx.begin_turtle(walk, self.layout);

        for (i, item) in self.items.iter().enumerate() {
            let widget = &self.item_widgets[i];
            widget.label(ids!(title)).set_text(cx, &item.title);
            widget.label(ids!(subtitle)).set_text(cx, &item.subtitle);
            widget.draw_all(cx, scope);
        }

        cx.end_turtle();
        DrawStep::done()
    }
}

impl ItemListRef {
    pub fn set_items(&self, cx: &mut Cx, items: Vec<ItemData>) {
        if let Some(mut inner) = self.borrow_mut() {
            inner.items = items;
            inner.redraw(cx);
        }
    }
}
```

## Pattern 5: LRU Cache for Views

Keep only N views in memory (from Moly's ChatsDeck).

```rust
use std::collections::{HashMap, VecDeque};

const MAX_CACHED_VIEWS: usize = 10;

#[derive(Live, Widget)]
pub struct ViewDeck {
    #[deref] view: View,
    #[live] view_template: Option<LivePtr>,
    #[rust] view_refs: HashMap<ViewId, WidgetRef>,
    #[rust] access_order: VecDeque<ViewId>,
    #[rust] current_view: Option<ViewId>,
}

impl ViewDeck {
    fn get_or_create_view(&mut self, cx: &mut Cx, id: ViewId) -> &WidgetRef {
        if !self.view_refs.contains_key(&id) {
            let widget = WidgetRef::new_from_ptr(cx, self.view_template);
            self.view_refs.insert(id.clone(), widget);

            // Evict oldest if over limit
            if self.view_refs.len() > MAX_CACHED_VIEWS {
                if let Some(oldest) = self.access_order.pop_front() {
                    self.view_refs.remove(&oldest);
                }
            }
        }

        // Update access order
        self.access_order.retain(|x| x != &id);
        self.access_order.push_back(id.clone());

        self.view_refs.get(&id).unwrap()
    }
}
```

## Pattern 6: Global Widget Registry

Access widgets from anywhere in the app.

```rust
// In shared/popup.rs
pub fn set_global_popup(cx: &mut Cx, popup: PopupRef) {
    Cx::set_global(cx, popup);
}

pub fn get_global_popup(cx: &mut Cx) -> &mut PopupRef {
    cx.get_global::<PopupRef>()
}

pub fn show_notification(cx: &mut Cx, message: &str) {
    get_global_popup(cx).show(cx, message);
}

// In app.rs startup
fn handle_startup(&mut self, cx: &mut Cx) {
    set_global_popup(cx, self.ui.popup(ids!(global_popup)));
}

// Usage from anywhere
show_notification(cx, "Operation completed!");
```

## Pattern 7: Radio Button Navigation

Tab-style navigation using radio button sets.

```rust
impl MatchEvent for App {
    fn handle_actions(&mut self, cx: &mut Cx, actions: &Actions) {
        let tabs = self.ui.radio_button_set(ids!(
            sidebar.home_tab,
            sidebar.settings_tab,
            sidebar.profile_tab
        ));

        if let Some(selected) = tabs.selected(cx, actions) {
            // Hide all pages
            self.ui.view(ids!(pages.home)).set_visible(cx, false);
            self.ui.view(ids!(pages.settings)).set_visible(cx, false);
            self.ui.view(ids!(pages.profile)).set_visible(cx, false);

            // Show selected
            match selected {
                0 => self.ui.view(ids!(pages.home)).set_visible(cx, true),
                1 => self.ui.view(ids!(pages.settings)).set_visible(cx, true),
                2 => self.ui.view(ids!(pages.profile)).set_visible(cx, true),
                _ => {}
            }
        }
    }
}
```

## Pattern 8: Async Data Loading

Don't show UI until data loads.

```rust
#[derive(Live)]
pub struct App {
    #[live] ui: WidgetRef,
    #[rust] store: Option<Store>,
    #[rust] loading: bool,
}

impl MatchEvent for App {
    fn handle_startup(&mut self, cx: &mut Cx) {
        self.ui.view(ids!(main_content)).set_visible(cx, false);
        self.ui.view(ids!(loading_spinner)).set_visible(cx, true);
        self.loading = true;

        spawn(async move {
            let store = Store::load().await;

            app_runner().defer(|app, cx, _| {
                app.store = Some(store);
                app.loading = false;

                app.ui.view(ids!(main_content)).set_visible(cx, true);
                app.ui.view(ids!(loading_spinner)).set_visible(cx, false);

                cx.redraw_all();
            });
        });
    }
}
```

## Pattern 9: Streaming Results

Process results as they arrive from background thread.

```rust
use std::sync::mpsc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

pub fn spawn_search(
    query: String,
    items: Vec<Item>,
    cancel: Arc<AtomicBool>,
) -> mpsc::Receiver<Item> {
    let (tx, rx) = mpsc::channel();

    std::thread::spawn(move || {
        for (i, item) in items.iter().enumerate() {
            if cancel.load(Ordering::Relaxed) {
                return;
            }

            if item.matches(&query) {
                let _ = tx.send(item.clone());

                if i % 10 == 0 {
                    SignalToUI::set_ui_signal();
                }
            }
        }
        SignalToUI::set_ui_signal();
    });

    rx
}

// In widget handle_event
fn handle_event(&mut self, cx: &mut Cx, event: &Event, scope: &mut Scope) {
    if let Some(rx) = &self.search_receiver {
        while let Ok(item) = rx.try_recv() {
            self.results.push(item);
        }
        if !self.results.is_empty() {
            self.redraw(cx);
        }
    }
}
```

## Pattern 10: State Machine Widget

For widgets with complex lifecycle states.

```rust
enum SearchState {
    Idle,
    Searching {
        query: String,
        receiver: mpsc::Receiver<SearchResult>,
        cancel_token: Arc<AtomicBool>,
    },
    ShowingResults(Vec<SearchResult>),
}

#[derive(Live, Widget)]
pub struct SearchWidget {
    #[deref] view: View,
    #[rust] state: SearchState,
}

impl Widget for SearchWidget {
    fn handle_event(&mut self, cx: &mut Cx, event: &Event, scope: &mut Scope) {
        self.view.handle_event(cx, event, scope);

        match &mut self.state {
            SearchState::Searching { receiver, cancel_token, .. } => {
                while let Ok(result) = receiver.try_recv() {
                    self.add_result(result);
                    cx.redraw_all();
                }
            }
            _ => {}
        }
    }

    fn start_search(&mut self, cx: &mut Cx, query: String) {
        // Cancel previous search
        if let SearchState::Searching { cancel_token, .. } = &self.state {
            cancel_token.store(true, Ordering::Relaxed);
        }

        let cancel = Arc::new(AtomicBool::new(false));
        let rx = spawn_search(query.clone(), self.items.clone(), cancel.clone());

        self.state = SearchState::Searching {
            query,
            receiver: rx,
            cancel_token: cancel,
        };
    }
}
```

## Pattern 11: Theme Switching

Multi-theme support with dynamic color application.

```rust
#[derive(Clone, Copy, Debug, PartialEq, Default)]
pub enum Theme {
    #[default]
    Dark,
    Light,
    Cyberpunk,
}

struct ThemeColors {
    bg_primary: Vec4,
    bg_card: Vec4,
    accent: Vec4,
    text_primary: Vec4,
    text_secondary: Vec4,
}

impl Theme {
    fn next(&self) -> Theme {
        match self {
            Theme::Dark => Theme::Light,
            Theme::Light => Theme::Cyberpunk,
            Theme::Cyberpunk => Theme::Dark,
        }
    }

    fn colors(&self) -> ThemeColors {
        match self {
            Theme::Dark => ThemeColors {
                bg_primary: vec4(0.04, 0.04, 0.07, 1.0),
                bg_card: vec4(0.10, 0.10, 0.15, 1.0),
                accent: vec4(0.0, 1.0, 0.53, 1.0),
                text_primary: vec4(0.9, 0.9, 0.9, 1.0),
                text_secondary: vec4(0.5, 0.5, 0.5, 1.0),
            },
            Theme::Light => ThemeColors {
                bg_primary: vec4(0.96, 0.96, 0.98, 1.0),
                bg_card: vec4(1.0, 1.0, 1.0, 1.0),
                accent: vec4(0.2, 0.6, 0.86, 1.0),
                text_primary: vec4(0.1, 0.1, 0.1, 1.0),
                text_secondary: vec4(0.5, 0.5, 0.5, 1.0),
            },
            Theme::Cyberpunk => ThemeColors {
                bg_primary: vec4(0.08, 0.02, 0.12, 1.0),
                bg_card: vec4(0.15, 0.05, 0.2, 1.0),
                accent: vec4(1.0, 0.0, 0.6, 1.0),
                text_primary: vec4(0.95, 0.9, 1.0, 1.0),
                text_secondary: vec4(0.6, 0.5, 0.7, 1.0),
            },
        }
    }
}

#[derive(Live, LiveHook)]
pub struct App {
    #[live] ui: WidgetRef,
    #[rust] current_theme: Theme,
}

impl App {
    fn apply_theme(&mut self, cx: &mut Cx) {
        let colors = self.current_theme.colors();

        // Window/body background
        self.ui.apply_over(cx, live!{
            draw_bg: { color: (colors.bg_primary) }
        });

        // Cards
        self.ui.view(id!(card)).apply_over(cx, live!{
            draw_bg: { color: (colors.bg_card) }
        });

        // Labels
        self.ui.label(id!(title)).apply_over(cx, live!{
            draw_text: { color: (colors.accent) }
        });

        self.ui.label(id!(subtitle)).apply_over(cx, live!{
            draw_text: { color: (colors.text_secondary) }
        });

        // Buttons
        self.ui.button(id!(theme_btn)).apply_over(cx, live!{
            draw_text: { color: (colors.accent) }
            draw_bg: { color: (colors.bg_card) }
        });

        self.ui.redraw(cx);
    }
}

impl MatchEvent for App {
    fn handle_actions(&mut self, cx: &mut Cx, actions: &Actions) {
        if self.ui.button(id!(theme_btn)).clicked(&actions) {
            self.current_theme = self.current_theme.next();
            self.apply_theme(cx);
        }
    }
}
```

## Pattern 12: Local Data Persistence

Save and load user preferences.

```rust
use std::fs;
use std::path::PathBuf;

fn get_config_path() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
    PathBuf::from(home).join(".myapp_config.txt")
}

impl App {
    fn save_favorites(&self) {
        let path = get_config_path();
        let content = self.favorites.join("\n");
        let _ = fs::write(&path, content);
    }

    fn load_favorites(&mut self) {
        let path = get_config_path();
        if let Ok(content) = fs::read_to_string(&path) {
            self.favorites = content.lines()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect();
        }
    }

    fn toggle_favorite(&mut self, item: &str) {
        if self.favorites.contains(&item.to_string()) {
            self.favorites.retain(|f| f != item);
        } else {
            self.favorites.push(item.to_string());
        }
        self.save_favorites();
    }
}
```

## Pattern 13: Full-Featured Slider Widget

<!-- Evolution: 2026-01-10 | source: makepad-component | author: @anthropic -->

A comprehensive slider with single/range mode, vertical/horizontal orientation, logarithmic scale, and disabled state.

### SliderValue Type

```rust
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum SliderValue {
    Single(f64),
    Range(f64, f64),
}

impl Default for SliderValue {
    fn default() -> Self {
        SliderValue::Single(0.0)
    }
}

impl SliderValue {
    pub fn start(&self) -> f64 {
        match self {
            SliderValue::Single(v) => *v,
            SliderValue::Range(start, _) => *start,
        }
    }

    pub fn end(&self) -> f64 {
        match self {
            SliderValue::Single(v) => *v,
            SliderValue::Range(_, end) => *end,
        }
    }
}
```

### Widget Structure

```rust
#[derive(Live, LiveHook, Widget)]
pub struct MpSlider {
    #[redraw] #[live] draw_track: DrawQuad,
    #[live] draw_thumb: DrawQuad,
    #[live] draw_thumb_start: DrawQuad,  // For range mode
    #[animator] animator: Animator,
    #[walk] walk: Walk,

    #[live(0.0)] value: f64,
    #[live(0.0)] value_start: f64,  // Range mode start
    #[live(false)] range_mode: bool,
    #[live(0.0)] min: f64,
    #[live(100.0)] max: f64,
    #[live(1.0)] step: f64,
    #[live(false)] logarithmic: bool,  // Linear vs log scale
    #[live(false)] vertical: bool,
    #[live(false)] disabled: bool,

    #[rust] dragging: bool,
    #[rust] dragging_start_thumb: bool,
    #[rust] track_area: Area,
}
```

### Value Conversion (Linear/Logarithmic)

```rust
impl MpSlider {
    fn value_to_progress(&self, value: f64) -> f64 {
        if self.max <= self.min { return 0.0; }

        if self.logarithmic && self.min > 0.0 {
            let base = self.max / self.min;
            ((value / self.min).ln() / base.ln()).clamp(0.0, 1.0)
        } else {
            ((value - self.min) / (self.max - self.min)).clamp(0.0, 1.0)
        }
    }

    fn progress_to_value(&self, progress: f64) -> f64 {
        if self.logarithmic && self.min > 0.0 {
            let base = self.max / self.min;
            base.powf(progress) * self.min
        } else {
            self.min + (self.max - self.min) * progress
        }
    }
}
```

### Drawing with Multiple Thumbs

```rust
fn draw_walk(&mut self, cx: &mut Cx2d, _scope: &mut Scope, walk: Walk) -> DrawStep {
    let progress_start = if self.range_mode {
        self.value_to_progress(self.value_start)
    } else { 0.0 };
    let progress_end = self.value_to_progress(self.value);

    // Update track shader
    self.draw_track.apply_over(cx, live! {
        progress_start: (progress_start),
        progress_end: (progress_end),
        disabled: (if self.disabled { 1.0 } else { 0.0 }),
        vertical: (if self.vertical { 1.0 } else { 0.0 })
    });

    let rect = cx.walk_turtle(walk);

    // Draw track
    self.draw_track.draw_abs(cx, track_rect);
    self.track_area = self.draw_track.area();

    // Draw main thumb at progress_end
    self.draw_thumb.draw_abs(cx, thumb_rect);

    // Draw start thumb if range mode
    if self.range_mode {
        self.draw_thumb_start.draw_abs(cx, start_thumb_rect);
    }

    DrawStep::done()
}
```

### Range Mode Drag Logic

```rust
Hit::FingerDown(fe) => {
    self.dragging = true;
    if self.range_mode {
        // Determine which thumb is closer
        let progress = self.position_to_progress(cx, fe.abs);
        let start_progress = self.value_to_progress(self.value_start);
        let end_progress = self.value_to_progress(self.value);
        let mid = (start_progress + end_progress) / 2.0;
        self.dragging_start_thumb = progress < mid;
    }
}

// In update_value_from_position:
if self.range_mode {
    if self.dragging_start_thumb {
        // Constrain start <= end
        self.value_start = new_value.min(self.value);
    } else {
        // Constrain end >= start
        self.value = new_value.max(self.value_start);
    }
}
```

### Usage Examples

```rust
// Basic slider
<MpSlider> { value: 50.0 }

// Range slider (price filter)
<MpSlider> {
    value_start: 100.0,
    value: 500.0,
    range_mode: true,
    min: 0.0,
    max: 1000.0
}

// Volume control (logarithmic)
<MpSlider> {
    min: 1.0,
    max: 100.0,
    value: 50.0,
    logarithmic: true,
    step: 0.0
}

// Vertical slider
<MpSlider> {
    width: 24, height: Fill,
    vertical: true,
    value: 75.0
}

// Disabled
<MpSlider> { value: 30.0, disabled: true }
```

## Best Practices Summary

| Pattern | When to Use |
|---------|-------------|
| Widget Ref Extension | Add helpers without modifying widget |
| Modal/Overlay | Popups, dialogs, dropdowns |
| Collapsible | Expandable sections, accordions |
| List with Template | Dynamic data-driven lists |
| LRU Cache | Memory-constrained view switching |
| Global Registry | App-wide components (toast, tooltip) |
| Radio Navigation | Tab-based navigation |
| Async Loading | Data fetching with loading states |
| Streaming Results | Long-running background operations |
| State Machine | Complex widget lifecycles |
| Theme Switching | Multi-theme support with dynamic colors |
| Local Persistence | Save user preferences to file |
| Full-Featured Slider | Slider with range, scale, orientation options |

## References

- [Robrix](https://github.com/project-robius/robrix) - Matrix chat client
- [Moly](https://github.com/moxin-org/moly) - AI model manager
