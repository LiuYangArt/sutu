---
name: makepad-rust
description: Rust patterns and best practices specific to Makepad UI development. Covers widget ownership (WidgetRef, WidgetSet), lifetime management, derive macros (Live, Widget), state management, async architecture with tokio integration (why UI/async separation is needed, global runtime pattern, request channels, response mechanisms like SignalToUI and Cx::post_action), platform-specific code, Unicode/grapheme handling for CJK and emoji text, and performance optimization. Use when writing Rust code for Makepad applications.
---

# Makepad Rust Patterns

Rust patterns and best practices specific to Makepad UI development. This is NOT a general Rust tutorial - it focuses on Makepad-specific Rust usage.

---

## Widget Ownership & References

### WidgetRef - Single Widget Reference

```rust
use makepad_widgets::*;

// Get a reference to a single widget
let button = self.view.widget(id!(my_button));

// Or with type
let button = self.view.button(id!(my_button));

// WidgetRef is a lightweight reference, not ownership
// Safe to store, clone, pass around
```

### Accessing Widget by Path

```rust
// Direct child
let btn = self.view.button(id!(submit_btn));

// Nested path
let label = self.view.label(id!(header.title.text));

// From root
let widget = self.ui.widget(id!(main_view.sidebar.menu_item));
```

### WidgetSet - Multiple Widgets

```rust
// Get all buttons in a container
let buttons = self.view.widget_set(ids!(btn1, btn2, btn3));

// Iterate over widget set
for button in buttons.iter() {
    button.set_visible(true);
}

// Apply to all
buttons.set_visible(false);
```

### Widget Type Casting

```rust
// Get as specific widget type
let button: ButtonRef = self.view.button(id!(my_button));
let label: LabelRef = self.view.label(id!(my_label));
let input: TextInputRef = self.view.text_input(id!(my_input));

// Generic widget reference
let widget: WidgetRef = self.view.widget(id!(some_widget));

// Check widget type
if let Some(button) = widget.as_button() {
    // It's a button
}
```

---

## Lifetime Management

### Cx Lifetime in Event Handlers

```rust
impl MatchEvent for MyApp {
    fn handle_actions(&mut self, cx: &mut Cx, actions: &Actions) {
        // cx is borrowed mutably here
        // Cannot borrow self.something that also needs cx

        // WRONG: double mutable borrow
        // self.do_something(cx);  // borrows cx
        // self.do_other(cx);      // cx still borrowed above

        // RIGHT: separate scopes
        {
            let result = self.compute_something();
        }
        self.apply_result(cx, result);
    }
}
```

### Borrowing Widgets Safely

```rust
// WRONG: holding reference while modifying
fn bad_example(&mut self, cx: &mut Cx) {
    let label = self.view.label(id!(my_label));  // borrows self.view
    self.update_state();  // might need self.view - conflict!
    label.set_text(cx, "text");
}

// RIGHT: minimize borrow scope
fn good_example(&mut self, cx: &mut Cx) {
    self.update_state();  // do state changes first
    self.view.label(id!(my_label)).set_text(cx, "text");  // then UI
}

// RIGHT: use temporary
fn also_good(&mut self, cx: &mut Cx) {
    let text = self.compute_text();  // compute first
    self.view.label(id!(my_label)).set_text(cx, &text);  // then apply
}
```

### The "Borrow Scope" Pattern

```rust
impl MyWidget {
    fn handle_event(&mut self, cx: &mut Cx, event: &Event, scope: &mut Scope) {
        // Pattern: Read phase (immutable operations)
        let current_value = self.state.value;
        let should_update = self.check_condition();

        // Pattern: Compute phase (no borrows)
        let new_value = current_value + 1;
        let message = format!("Value: {}", new_value);

        // Pattern: Write phase (mutable operations)
        self.state.value = new_value;
        self.view.label(id!(display)).set_text(cx, &message);
    }
}
```

---

## Derive Macros

### Core Derives for Widgets

```rust
#[derive(Live, LiveHook, Widget)]
pub struct MyWidget {
    #[deref] view: View,  // Required for Widget derive

    #[live] color: Vec4,           // Live-editable property
    #[live] enabled: bool,         // With live_design! binding

    #[rust] counter: i32,          // Rust-only, not in live_design!
    #[rust] cache: Option<String>, // Runtime state
}
```

### Derive Macro Reference

| Derive | Purpose | Required For |
|--------|---------|--------------|
| `Live` | Enable live_design! properties | All Makepad widgets |
| `LiveHook` | Lifecycle callbacks (after_new_from_doc, etc.) | Custom initialization |
| `Widget` | Widget trait implementation | Widget functionality |
| `DefaultNone` | Default to None for Options | Optional live properties |
| `Debug`, `Clone` | Standard Rust derives | As needed |

### #[live] vs #[rust] Attributes

```rust
pub struct MyWidget {
    // #[live] - Defined in live_design!, hot-reloadable
    #[live] background_color: Vec4,  // Can set in DSL: background_color: #FF0000
    #[live] padding: f64,            // Can set in DSL: padding: 10.0
    #[live] label: ArcStringMut,     // String from DSL

    // #[rust] - Runtime only, not in live_design!
    #[rust] is_hovered: bool,        // Runtime state
    #[rust] click_count: u32,        // Counter
    #[rust] cached_data: Vec<Item>,  // Dynamic data
}
```

### LiveHook Callbacks

```rust
#[derive(Live, LiveHook, Widget)]
pub struct MyWidget {
    #[deref] view: View,
    #[rust] initialized: bool,
}

impl LiveHook for MyWidget {
    // Called after widget is created from live_design!
    fn after_new_from_doc(&mut self, cx: &mut Cx) {
        self.initialized = true;
        // Initialize runtime state here
    }

    // Called when live_design! changes (hot reload)
    fn after_apply(&mut self, cx: &mut Cx, apply: &mut Apply, index: usize, nodes: &[LiveNode]) {
        // React to property changes
    }
}
```

### DefaultNone for Optional Properties

```rust
#[derive(Live, LiveHook, Widget)]
pub struct MyWidget {
    #[deref] view: View,

    // Without DefaultNone - must provide in live_design!
    #[live] required_color: Vec4,

    // With DefaultNone - optional, defaults to None
    #[live(default_none)] optional_icon: Option<LiveDependency>,
}

// In live_design! - optional_icon can be omitted
live_design! {
    MyWidget = {{MyWidget}} {
        required_color: #FF0000  // Must provide
        // optional_icon: not required
    }
}
```

---

## State Management Patterns

### Simple State in Widget

```rust
#[derive(Live, LiveHook, Widget)]
pub struct Counter {
    #[deref] view: View,
    #[rust] count: i32,
}

impl Counter {
    fn increment(&mut self, cx: &mut Cx) {
        self.count += 1;
        self.update_display(cx);
    }

    fn update_display(&mut self, cx: &mut Cx) {
        let text = format!("{}", self.count);
        self.view.label(id!(count_label)).set_text(cx, &text);
    }
}
```

### Shared State with AppState

```rust
// Define app-level state
pub struct AppState {
    pub user: Option<User>,
    pub settings: Settings,
    pub data: Vec<Item>,
}

// Access in widgets via Scope
impl MatchEvent for MyWidget {
    fn handle_actions(&mut self, cx: &mut Cx, actions: &Actions, scope: &mut Scope) {
        // Get app state from scope
        let app_state = scope.data.get_mut::<AppState>().unwrap();

        if self.button(id!(login_btn)).clicked(actions) {
            app_state.user = Some(User::default());
        }
    }
}
```

### RefCell for Interior Mutability

```rust
use std::cell::RefCell;

#[derive(Live, LiveHook, Widget)]
pub struct MyWidget {
    #[deref] view: View,
    #[rust] cache: RefCell<HashMap<String, Data>>,
}

impl MyWidget {
    fn get_cached(&self, key: &str) -> Option<Data> {
        self.cache.borrow().get(key).cloned()
    }

    fn set_cached(&self, key: String, value: Data) {
        self.cache.borrow_mut().insert(key, value);
    }
}
```

### Arc<Mutex> for Thread-Safe State

```rust
use std::sync::{Arc, Mutex};

#[derive(Live, LiveHook, Widget)]
pub struct MyWidget {
    #[deref] view: View,
    #[rust] shared_data: Arc<Mutex<SharedData>>,
}

impl MyWidget {
    fn update_shared(&self) {
        let mut data = self.shared_data.lock().unwrap();
        data.value += 1;
    }

    fn read_shared(&self) -> i32 {
        let data = self.shared_data.lock().unwrap();
        data.value
    }
}
```

---

## Closures and Callbacks

### Action-Based Communication

```rust
// Define custom actions
#[derive(Clone, Debug, DefaultNone)]
pub enum MyWidgetAction {
    None,
    Clicked(i32),
    ValueChanged(String),
}

// Emit action from widget
impl Widget for MyWidget {
    fn handle_event(&mut self, cx: &mut Cx, event: &Event, scope: &mut Scope) {
        if self.button(id!(btn)).clicked(&actions) {
            cx.widget_action(
                self.widget_uid(),
                &scope.path,
                MyWidgetAction::Clicked(self.id)
            );
        }
    }
}

// Handle action in parent
impl MatchEvent for ParentWidget {
    fn handle_actions(&mut self, cx: &mut Cx, actions: &Actions, scope: &mut Scope) {
        for action in actions {
            if let MyWidgetAction::Clicked(id) = action.as_widget_action().cast() {
                println!("Child {} clicked", id);
            }
        }
    }
}
```

### Async Operations with Signals (Simple)

For simple one-off async tasks, use `std::thread::spawn` with `SignalToUI`:

```rust
use makepad_widgets::*;

#[derive(Live, LiveHook, Widget)]
pub struct AsyncWidget {
    #[deref] view: View,
    #[rust] signal: SignalToUI,
}

impl AsyncWidget {
    fn start_async_task(&mut self, cx: &mut Cx) {
        let signal = self.signal.clone();

        std::thread::spawn(move || {
            // Do async work
            let result = expensive_computation();

            // Signal UI thread
            signal.set();  // Will trigger Event::Signal
        });
    }
}

impl MatchEvent for AsyncWidget {
    fn handle_signal(&mut self, cx: &mut Cx) {
        // Called when signal.set() is triggered
        self.update_ui_with_result(cx);
    }
}
```

---

## Async Architecture with Tokio

### Why Separate UI Thread from Async Tasks?

Makepad's UI runs on a **single main thread**. Blocking this thread causes:
- Frozen/unresponsive UI
- Missed animation frames
- Poor user experience

**You MUST NOT block the UI thread with:**
- Network requests
- Database operations
- File I/O
- Heavy computations
- Any operation that might take >16ms

**Solution Architecture:**

```
┌─────────────────┐         ┌─────────────────────────┐
│   UI Thread     │         │   Tokio Runtime         │
│   (Makepad)     │         │   (Background)          │
│                 │         │                         │
│  ┌───────────┐  │ Request │  ┌───────────────────┐  │
│  │  Widget   │──┼────────►│  │  Async Worker     │  │
│  │           │  │ Channel │  │  (Matrix SDK,     │  │
│  │           │◄─┼─────────│  │   HTTP, DB...)    │  │
│  └───────────┘  │ Signal/ │  └───────────────────┘  │
│                 │ Action  │                         │
└─────────────────┘         └─────────────────────────┘
```

### When to Use std::thread vs Tokio

| Scenario | Use | Why |
|----------|-----|-----|
| One-off CPU computation | `std::thread::spawn` | Simple, no async needed |
| Single blocking HTTP | `std::thread::spawn` | `reqwest::blocking` is simpler |
| Multiple concurrent requests | Tokio | Efficient async I/O |
| Websockets/streaming | Tokio | Requires async runtime |
| SDK integration (Matrix, etc.) | Tokio | SDKs often require tokio |
| Long-running background service | Tokio | Better resource management |

### Global Tokio Runtime Pattern

Pattern from Robrix - create a single global tokio runtime:

```rust
use std::sync::Mutex;
use tokio::runtime::{Runtime, Handle};
use anyhow::Result;

/// Single global Tokio runtime for all async tasks
static TOKIO_RUNTIME: Mutex<Option<Runtime>> = Mutex::new(None);

/// Initialize and start the tokio runtime
/// Call this in handle_startup()
pub fn start_async_runtime() -> Result<Handle> {
    let rt_handle = TOKIO_RUNTIME.lock().unwrap()
        .get_or_insert_with(|| {
            Runtime::new().expect("Failed to create Tokio runtime")
        })
        .handle()
        .clone();

    // Spawn main worker task
    let rt = rt_handle.clone();
    rt_handle.spawn(async_worker_main(rt));

    Ok(rt_handle)
}

/// Shutdown the runtime (call on app exit)
pub fn shutdown_async_runtime() {
    if let Some(runtime) = TOKIO_RUNTIME.lock().unwrap().take() {
        runtime.shutdown_background();
    }
}
```

### Request Channel Pattern (UI → Async)

Define request types and use `mpsc` channel to send from UI to async:

```rust
use tokio::sync::mpsc::{UnboundedSender, UnboundedReceiver, unbounded_channel};
use std::sync::Mutex;

/// All request types the async worker can handle
pub enum AsyncRequest {
    FetchData { url: String, room_id: String },
    SendMessage { room_id: String, content: String },
    LoadMore { room_id: String, count: usize },
    Logout,
}

/// Global sender for submitting requests
static REQUEST_SENDER: Mutex<Option<UnboundedSender<AsyncRequest>>> = Mutex::new(None);

/// Submit a request from UI thread (non-blocking)
pub fn submit_async_request(request: AsyncRequest) {
    if let Some(sender) = REQUEST_SENDER.lock().unwrap().as_ref() {
        if let Err(e) = sender.send(request) {
            error!("Failed to send async request: {:?}", e);
        }
    }
}

/// Main async worker task
async fn async_worker_main(rt: Handle) -> Result<()> {
    let (sender, mut receiver) = unbounded_channel::<AsyncRequest>();

    // Store sender globally
    *REQUEST_SENDER.lock().unwrap() = Some(sender);

    // Process requests
    while let Some(request) = receiver.recv().await {
        match request {
            AsyncRequest::FetchData { url, room_id } => {
                // Spawn a new task for this request
                Handle::current().spawn(async move {
                    let result = fetch_data_impl(&url).await;
                    // Notify UI (see next section)
                    notify_ui_data_fetched(room_id, result);
                });
            }
            AsyncRequest::SendMessage { room_id, content } => {
                Handle::current().spawn(async move {
                    let result = send_message_impl(&room_id, &content).await;
                    notify_ui_message_sent(room_id, result);
                });
            }
            AsyncRequest::Logout => {
                // Handle logout...
            }
            _ => {}
        }
    }

    Ok(())
}
```

### Response Mechanisms (Async → UI)

Three ways to notify UI from async tasks:

#### 1. SignalToUI (Simple signal, no data)

```rust
use makepad_widgets::SignalToUI;

// In async task
fn notify_with_signal() {
    SignalToUI::set_ui_signal();  // Triggers Event::Signal
}

// In widget
impl MatchEvent for MyWidget {
    fn handle_signal(&mut self, cx: &mut Cx) {
        // Check shared state for the data
        let data = self.shared_data.lock().unwrap();
        self.update_ui(cx, &data);
    }
}
```

#### 2. Cx::post_action (Send typed action)

```rust
use makepad_widgets::Cx;

// Define action type
#[derive(Debug)]
pub enum DataAction {
    Fetched { room_id: String, data: Vec<Item> },
    Error { room_id: String, error: String },
}

// In async task
fn notify_with_action(room_id: String, result: Result<Vec<Item>>) {
    match result {
        Ok(data) => Cx::post_action(DataAction::Fetched { room_id, data }),
        Err(e) => Cx::post_action(DataAction::Error { room_id, error: e.to_string() }),
    }
}

// In widget - handle in handle_actions
impl MatchEvent for MyWidget {
    fn handle_actions(&mut self, cx: &mut Cx, actions: &Actions) {
        for action in actions {
            // Actions from async are NOT widget actions
            if let Some(data_action) = action.downcast_ref::<DataAction>() {
                match data_action {
                    DataAction::Fetched { room_id, data } => {
                        self.display_data(cx, room_id, data);
                    }
                    DataAction::Error { room_id, error } => {
                        self.show_error(cx, room_id, error);
                    }
                }
            }
        }
    }
}
```

#### 3. Channel per Widget (For streaming updates)

```rust
use std::sync::mpsc::{channel, Sender, Receiver};

#[derive(Live, LiveHook, Widget)]
pub struct StreamWidget {
    #[deref] view: View,
    #[rust] update_receiver: Option<Receiver<StreamUpdate>>,
}

pub enum StreamUpdate {
    NewMessage(Message),
    UserTyping(UserId),
    ConnectionStatus(bool),
}

impl StreamWidget {
    fn start_stream(&mut self, room_id: String) {
        let (sender, receiver) = channel();
        self.update_receiver = Some(receiver);

        // Pass sender to async task
        submit_async_request(AsyncRequest::StartStream {
            room_id,
            update_sender: sender,
        });
    }
}

impl MatchEvent for StreamWidget {
    fn handle_signal(&mut self, cx: &mut Cx) {
        // Check for updates
        if let Some(receiver) = &self.update_receiver {
            while let Ok(update) = receiver.try_recv() {
                match update {
                    StreamUpdate::NewMessage(msg) => self.add_message(cx, msg),
                    StreamUpdate::UserTyping(user) => self.show_typing(cx, user),
                    StreamUpdate::ConnectionStatus(ok) => self.update_status(cx, ok),
                }
            }
        }
    }
}
```

### Complete Example: App with Tokio

```rust
use makepad_widgets::*;
use std::sync::Mutex;
use tokio::sync::mpsc::{unbounded_channel, UnboundedSender};

// Global request sender
static REQUEST_SENDER: Mutex<Option<UnboundedSender<AppRequest>>> = Mutex::new(None);
static TOKIO_RUNTIME: Mutex<Option<tokio::runtime::Runtime>> = Mutex::new(None);

pub enum AppRequest {
    FetchUsers,
    SendMessage { content: String },
}

#[derive(Debug)]
pub enum AppUpdate {
    UsersFetched(Vec<User>),
    MessageSent(Result<(), String>),
}

live_design! {
    App = {{App}} {
        ui: <Root> {
            <Window> {
                body = <View> {
                    fetch_btn = <Button> { text: "Fetch Users" }
                    users_list = <View> {}
                }
            }
        }
    }
}

app_main!(App);

#[derive(Live)]
pub struct App {
    #[live] ui: WidgetRef,
    #[rust] users: Vec<User>,
}

impl LiveRegister for App {
    fn live_register(cx: &mut Cx) {
        makepad_widgets::live_design(cx);
    }
}

impl LiveHook for App {}

impl MatchEvent for App {
    fn handle_startup(&mut self, cx: &mut Cx) {
        // Initialize tokio runtime
        let rt_handle = TOKIO_RUNTIME.lock().unwrap()
            .get_or_insert_with(|| {
                tokio::runtime::Runtime::new().unwrap()
            })
            .handle()
            .clone();

        // Start async worker
        rt_handle.spawn(async {
            let (sender, mut receiver) = unbounded_channel::<AppRequest>();
            *REQUEST_SENDER.lock().unwrap() = Some(sender);

            while let Some(request) = receiver.recv().await {
                match request {
                    AppRequest::FetchUsers => {
                        let result = fetch_users_from_api().await;
                        Cx::post_action(AppUpdate::UsersFetched(result));
                    }
                    AppRequest::SendMessage { content } => {
                        let result = send_message_to_api(&content).await;
                        Cx::post_action(AppUpdate::MessageSent(result));
                    }
                }
            }
        });
    }

    fn handle_actions(&mut self, cx: &mut Cx, actions: &Actions) {
        // Handle button click
        if self.ui.button(id!(fetch_btn)).clicked(&actions) {
            // Non-blocking: just send request
            if let Some(sender) = REQUEST_SENDER.lock().unwrap().as_ref() {
                let _ = sender.send(AppRequest::FetchUsers);
            }
        }

        // Handle async responses
        for action in actions {
            if let Some(update) = action.downcast_ref::<AppUpdate>() {
                match update {
                    AppUpdate::UsersFetched(users) => {
                        self.users = users.clone();
                        self.update_users_list(cx);
                    }
                    AppUpdate::MessageSent(result) => {
                        match result {
                            Ok(()) => log!("Message sent!"),
                            Err(e) => self.show_error(cx, e),
                        }
                    }
                }
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

// Async functions (run on tokio runtime)
async fn fetch_users_from_api() -> Vec<User> {
    // This is async, doesn't block UI
    reqwest::get("https://api.example.com/users")
        .await
        .unwrap()
        .json()
        .await
        .unwrap()
}

async fn send_message_to_api(content: &str) -> Result<(), String> {
    // Async HTTP POST
    Ok(())
}
```

### Thread Safety Checklist

| Pattern | Thread Safe? | Use For |
|---------|-------------|---------|
| `#[rust] field: T` | UI thread only | Widget state |
| `Arc<Mutex<T>>` | Yes | Shared mutable data |
| `Arc<RwLock<T>>` | Yes | Read-heavy shared data |
| `mpsc::channel` | Yes | One-way communication |
| `SignalToUI` | Yes | Simple notification |
| `Cx::post_action` | Yes | Typed async→UI messages |

### Common Pitfalls

```rust
// ❌ WRONG: Blocking UI thread
impl MatchEvent for MyWidget {
    fn handle_actions(&mut self, cx: &mut Cx, actions: &Actions) {
        if self.button(id!(fetch)).clicked(&actions) {
            // This BLOCKS the UI!
            let data = reqwest::blocking::get("...").unwrap();
            self.display(cx, data);
        }
    }
}

// ✅ RIGHT: Non-blocking request
impl MatchEvent for MyWidget {
    fn handle_actions(&mut self, cx: &mut Cx, actions: &Actions) {
        if self.button(id!(fetch)).clicked(&actions) {
            // Just send request, don't wait
            submit_async_request(AsyncRequest::Fetch);
            self.show_loading(cx);  // Show loading state
        }

        // Handle response in separate action
        if let Some(FetchResult::Done(data)) = action.downcast_ref() {
            self.hide_loading(cx);
            self.display(cx, data);
        }
    }
}
```

### Cargo.toml for Tokio

```toml
[dependencies]
tokio = { version = "1", features = ["rt-multi-thread", "macros", "sync"] }
reqwest = { version = "0.11", features = ["json"] }
```

---

## Platform-Specific Code

### Conditional Compilation

```rust
#[derive(Live, LiveHook, Widget)]
pub struct PlatformWidget {
    #[deref] view: View,
}

impl PlatformWidget {
    fn get_platform_path(&self) -> String {
        #[cfg(target_os = "macos")]
        {
            "/Users/data".to_string()
        }
        #[cfg(target_os = "windows")]
        {
            "C:\\Users\\data".to_string()
        }
        #[cfg(target_os = "linux")]
        {
            "/home/data".to_string()
        }
        #[cfg(target_os = "android")]
        {
            "/data/data/app".to_string()
        }
        #[cfg(target_os = "ios")]
        {
            "/var/mobile/app".to_string()
        }
        #[cfg(target_arch = "wasm32")]
        {
            "/browser/storage".to_string()
        }
    }
}
```

### Platform Feature Flags

```rust
impl MyWidget {
    fn setup_platform_features(&mut self, cx: &mut Cx) {
        // Desktop only features
        #[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
        {
            self.setup_keyboard_shortcuts(cx);
            self.setup_window_menu(cx);
        }

        // Mobile only features
        #[cfg(any(target_os = "android", target_os = "ios"))]
        {
            self.setup_touch_gestures(cx);
            self.setup_haptic_feedback(cx);
        }

        // Web only
        #[cfg(target_arch = "wasm32")]
        {
            self.setup_browser_integration(cx);
        }
    }
}
```

### Platform-Specific Dependencies

```toml
# Cargo.toml

[target.'cfg(target_os = "android")'.dependencies]
android-activity = "0.5"

[target.'cfg(target_os = "ios")'.dependencies]
objc = "0.2"

[target.'cfg(target_arch = "wasm32")'.dependencies]
wasm-bindgen = "0.2"
web-sys = "0.3"
```

---

## Performance Optimization

### Avoid Unnecessary Clones

```rust
// WRONG: Unnecessary clone
fn bad_update(&mut self, cx: &mut Cx) {
    let items = self.items.clone();  // Clones entire Vec
    for item in items {
        self.process_item(cx, &item);
    }
}

// RIGHT: Use references
fn good_update(&mut self, cx: &mut Cx) {
    for i in 0..self.items.len() {
        let item = &self.items[i];  // Borrow
        self.display_item(cx, item);
    }
}

// RIGHT: If you need to modify, collect indices first
fn also_good(&mut self, cx: &mut Cx) {
    let to_update: Vec<usize> = self.items
        .iter()
        .enumerate()
        .filter(|(_, item)| item.needs_update)
        .map(|(i, _)| i)
        .collect();

    for i in to_update {
        self.items[i].update();
    }
}
```

### Efficient String Handling

```rust
// WRONG: Multiple string allocations
fn bad_format(&mut self, cx: &mut Cx) {
    let s1 = format!("Hello, ");
    let s2 = format!("{}", self.name);
    let s3 = format!("{}{}!", s1, s2);
    self.label.set_text(cx, &s3);
}

// RIGHT: Single format
fn good_format(&mut self, cx: &mut Cx) {
    let text = format!("Hello, {}!", self.name);
    self.label.set_text(cx, &text);
}

// RIGHT: Use ArcStringMut for repeated updates
#[derive(Live, LiveHook, Widget)]
pub struct MyWidget {
    #[live] label_text: ArcStringMut,  // Efficient string storage
}
```

### Minimize Redraws

```rust
impl Widget for MyWidget {
    fn handle_event(&mut self, cx: &mut Cx, event: &Event, scope: &mut Scope) {
        // Only redraw if animator needs it
        if self.animator_handle_event(cx, event).must_redraw() {
            self.redraw(cx);
        }

        // Or only redraw specific parts
        if self.value_changed {
            self.view.label(id!(value_label)).redraw(cx);  // Just the label
            self.value_changed = false;
        }
    }
}
```

### Lazy Initialization

```rust
#[derive(Live, LiveHook, Widget)]
pub struct MyWidget {
    #[deref] view: View,
    #[rust] expensive_data: Option<ExpensiveData>,
}

impl MyWidget {
    fn get_expensive_data(&mut self) -> &ExpensiveData {
        if self.expensive_data.is_none() {
            self.expensive_data = Some(ExpensiveData::compute());
        }
        self.expensive_data.as_ref().unwrap()
    }
}
```

### Batch Updates

```rust
// WRONG: Multiple redraws
fn bad_batch(&mut self, cx: &mut Cx) {
    for i in 0..100 {
        self.items[i].update(cx);  // Each might trigger redraw
    }
}

// RIGHT: Batch then redraw once
fn good_batch(&mut self, cx: &mut Cx) {
    for i in 0..100 {
        self.items[i].value = compute(i);  // Just update data
    }
    self.redraw(cx);  // Single redraw at end
}
```

---

## Common Patterns

### Builder Pattern for Configuration

```rust
pub struct WidgetConfig {
    pub color: Vec4,
    pub size: f64,
    pub enabled: bool,
}

impl Default for WidgetConfig {
    fn default() -> Self {
        Self {
            color: vec4(1.0, 1.0, 1.0, 1.0),
            size: 100.0,
            enabled: true,
        }
    }
}

impl WidgetConfig {
    pub fn color(mut self, color: Vec4) -> Self {
        self.color = color;
        self
    }

    pub fn size(mut self, size: f64) -> Self {
        self.size = size;
        self
    }
}

// Usage
let config = WidgetConfig::default()
    .color(vec4(1.0, 0.0, 0.0, 1.0))
    .size(200.0);
```

### Result/Option Handling

```rust
impl MyWidget {
    fn load_data(&mut self, cx: &mut Cx) -> Result<(), AppError> {
        let file_content = std::fs::read_to_string("data.json")
            .map_err(|e| AppError::FileRead(e))?;

        let data: MyData = serde_json::from_str(&file_content)
            .map_err(|e| AppError::Parse(e))?;

        self.data = Some(data);
        self.update_ui(cx);
        Ok(())
    }

    fn safe_load(&mut self, cx: &mut Cx) {
        match self.load_data(cx) {
            Ok(()) => log!("Data loaded"),
            Err(e) => {
                log!("Error: {:?}", e);
                self.show_error(cx, &e.to_string());
            }
        }
    }
}
```

### Type State Pattern

```rust
// States as zero-sized types
pub struct Disconnected;
pub struct Connecting;
pub struct Connected;

pub struct Connection<State> {
    _state: std::marker::PhantomData<State>,
    // ...
}

impl Connection<Disconnected> {
    pub fn connect(self) -> Connection<Connecting> {
        Connection { _state: std::marker::PhantomData }
    }
}

impl Connection<Connecting> {
    pub fn on_connected(self) -> Connection<Connected> {
        Connection { _state: std::marker::PhantomData }
    }
}

impl Connection<Connected> {
    pub fn send(&self, data: &[u8]) {
        // Only available when connected
    }
}
```

---

## Error Handling in Makepad

### Custom Error Types

```rust
#[derive(Debug)]
pub enum AppError {
    Network(String),
    Parse(String),
    Widget(String),
    IO(std::io::Error),
}

impl std::fmt::Display for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AppError::Network(msg) => write!(f, "Network error: {}", msg),
            AppError::Parse(msg) => write!(f, "Parse error: {}", msg),
            AppError::Widget(msg) => write!(f, "Widget error: {}", msg),
            AppError::IO(e) => write!(f, "IO error: {}", e),
        }
    }
}

impl std::error::Error for AppError {}
```

### Graceful Error Display

```rust
impl MyWidget {
    fn handle_error(&mut self, cx: &mut Cx, error: &AppError) {
        // Log for debugging
        log!("Error occurred: {:?}", error);

        // Show user-friendly message
        let message = match error {
            AppError::Network(_) => "Connection failed. Please try again.",
            AppError::Parse(_) => "Invalid data received.",
            _ => "An error occurred.",
        };

        self.view.label(id!(error_label)).set_text(cx, message);
        self.view.view(id!(error_container)).set_visible(true);
    }
}
```

---

## Testing Patterns

### Unit Testing Widget Logic

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_counter_increment() {
        let mut state = CounterState::default();
        state.increment();
        assert_eq!(state.count, 1);
    }

    #[test]
    fn test_validation() {
        assert!(validate_email("test@example.com"));
        assert!(!validate_email("invalid"));
    }
}
```

### Separating Logic from UI

```rust
// Pure logic - easy to test
pub struct Calculator {
    pub value: f64,
}

impl Calculator {
    pub fn add(&mut self, n: f64) {
        self.value += n;
    }

    pub fn multiply(&mut self, n: f64) {
        self.value *= n;
    }
}

// Widget uses the logic
#[derive(Live, LiveHook, Widget)]
pub struct CalculatorWidget {
    #[deref] view: View,
    #[rust] calc: Calculator,
}

impl CalculatorWidget {
    fn on_add_clicked(&mut self, cx: &mut Cx) {
        self.calc.add(1.0);
        self.update_display(cx);
    }
}
```

---

## Unicode and Text Handling

**CRITICAL**: When working with text in Makepad, always use **graphemes** (not chars or bytes) for:
- Text length calculation
- Substring extraction
- Cursor positioning
- Text manipulation

### Why Graphemes Matter

```rust
let text = "Hello 你好 👨‍👩‍👧‍👦";

// ❌ WRONG - bytes (breaks UTF-8)
text.len()  // Returns 34 bytes - useless for UI

// ❌ WRONG - chars (breaks emoji, combining characters)
text.chars().count()  // Returns langth - still wrong for 👨‍👩‍👧‍👦

// ✅ CORRECT - graphemes (visual units)
use unicode_segmentation::UnicodeSegmentation;
text.graphemes(true).count()  // Returns actual visible characters
```

### Add Dependency

```toml
# Cargo.toml
[dependencies]
unicode-segmentation = "1.10"
```

### Essential Grapheme Functions

Pattern from Robrix (`src/utils.rs`):

```rust
use unicode_segmentation::UnicodeSegmentation;

/// Convert byte index to grapheme index
pub fn byte_index_to_grapheme_index(text: &str, byte_idx: usize) -> usize {
    let mut current_byte_pos = 0;
    for (i, g) in text.graphemes(true).enumerate() {
        if current_byte_pos <= byte_idx && current_byte_pos + g.len() > byte_idx {
            return i;
        }
        current_byte_pos += g.len();
    }
    text.graphemes(true).count()
}

/// Safe substring by byte indices (respects grapheme boundaries)
pub fn safe_substring_by_byte_indices(text: &str, start_byte: usize, end_byte: usize) -> String {
    if start_byte >= end_byte || start_byte >= text.len() {
        return String::new();
    }
    let start_grapheme_idx = byte_index_to_grapheme_index(text, start_byte);
    let end_grapheme_idx = byte_index_to_grapheme_index(text, end_byte);
    text.graphemes(true)
        .enumerate()
        .filter(|(i, _)| *i >= start_grapheme_idx && *i < end_grapheme_idx)
        .map(|(_, g)| g)
        .collect()
}

/// Safe text replacement (respects grapheme boundaries)
pub fn safe_replace_by_byte_indices(text: &str, start_byte: usize, end_byte: usize, replacement: &str) -> String {
    let text_graphemes: Vec<&str> = text.graphemes(true).collect();
    let start_grapheme_idx = byte_index_to_grapheme_index(text, start_byte);
    let end_grapheme_idx = byte_index_to_grapheme_index(text, end_byte);
    let before = text_graphemes[..start_grapheme_idx].join("");
    let after = text_graphemes[end_grapheme_idx..].join("");
    format!("{before}{replacement}{after}")
}

/// Build grapheme-to-byte position mapping (for performance)
pub fn build_grapheme_byte_positions(text: &str) -> Vec<usize> {
    let mut positions = Vec::with_capacity(text.graphemes(true).count() + 1);
    let mut byte_pos = 0;
    positions.push(0);
    for g in text.graphemes(true) {
        byte_pos += g.len();
        positions.push(byte_pos);
    }
    positions
}
```

### Getting First Character (Avatar)

```rust
use unicode_segmentation::UnicodeSegmentation;

/// Get first letter for avatar display
pub fn user_name_first_letter(user_name: &str) -> Option<&str> {
    user_name
        .graphemes(true)
        .find(|&g| g != "@")  // Skip @ prefix
}

/// Get first letter from room name
pub fn avatar_from_room_name(room_name: &str) -> String {
    room_name
        .graphemes(true)
        .find(|&g| g != "#" && g != "!")
        .map(ToString::to_string)
        .unwrap_or_else(|| String::from("?"))
}

// Usage
let avatar_char = user_name_first_letter("张三");  // Returns "张"
let avatar_char = user_name_first_letter("👨‍👩‍👧‍👦 Family");  // Returns "👨‍👩‍👧‍👦"
```

### Caching for Performance

For frequently accessed text (like in TextInput), cache grapheme analysis:

```rust
#[derive(Live, LiveHook, Widget)]
pub struct MyTextInput {
    #[deref] view: View,
    // Cache: (text, graphemes_as_strings, byte_positions)
    #[rust] cached_text_analysis: Option<(String, Vec<String>, Vec<usize>)>,
}

impl MyTextInput {
    fn get_text_analysis(&mut self, text: &str) -> (&[String], &[usize]) {
        // Check cache validity
        let needs_rebuild = self.cached_text_analysis
            .as_ref()
            .map(|(cached, _, _)| cached != text)
            .unwrap_or(true);

        if needs_rebuild {
            let graphemes: Vec<String> = text.graphemes(true)
                .map(|s| s.to_string())
                .collect();
            let positions = build_grapheme_byte_positions(text);
            self.cached_text_analysis = Some((
                text.to_string(),
                graphemes,
                positions
            ));
        }

        let (_, graphemes, positions) = self.cached_text_analysis.as_ref().unwrap();
        (graphemes, positions)
    }
}
```

### Common Mistakes

| Wrong | Right | Why |
|-------|-------|-----|
| `text.len()` | `text.graphemes(true).count()` | `.len()` returns bytes |
| `text.chars().count()` | `text.graphemes(true).count()` | `.chars()` breaks emoji |
| `text[0..5]` | Use grapheme-aware substring | Byte slicing breaks UTF-8 |
| `text.chars().nth(0)` | `text.graphemes(true).next()` | First visible character |

### Text Operations Comparison

```rust
let text = "你好👋世界";

// Length
text.len();                          // 16 (bytes) - wrong
text.chars().count();                // 5 (chars) - might be wrong for emoji
text.graphemes(true).count();        // 5 (graphemes) - correct

// First character
&text[0..1];                         // panic! invalid UTF-8
text.chars().next();                 // Some('你') - correct for CJK
text.graphemes(true).next();         // Some("你") - always correct

// Truncate to N visible characters
text.chars().take(3).collect::<String>();      // "你好👋"
text.graphemes(true).take(3).collect::<String>(); // "你好👋" - same here, but safer
```

### When to Use Each

| Method | Use When |
|--------|----------|
| `.bytes()` | Binary data, network protocols |
| `.chars()` | Simple ASCII-only text, known no emoji |
| `.graphemes(true)` | **User-facing text (always)** |

---

## Quick Reference

### Common Type Conversions

```rust
// String conversions
let s: String = format!("{}", value);
let s: &str = &my_string;
let s: ArcStringMut = ArcStringMut::from("text");

// Color conversions
let color: Vec4 = vec4(1.0, 0.0, 0.0, 1.0);  // RGBA floats
let color: Vec4 = Vec4::from_hex(0xFF0000FF);  // From hex

// Size conversions
let size: DVec2 = dvec2(100.0, 200.0);  // Width, height
```

### Useful Macros

```rust
// Logging
log!("Debug message: {}", value);
error!("Error: {:?}", err);

// Widget IDs
id!(button_name)           // Single ID
ids!(btn1, btn2, btn3)     // Multiple IDs

// Live design reference
live_id!(MyWidget)         // Reference to live type
```

### Import Prelude

```rust
// Standard Makepad imports
use makepad_widgets::*;

// This includes:
// - Live, LiveHook, Widget derives
// - Cx, Event, Actions, Scope
// - Common widget types (View, Label, Button, etc.)
// - Math types (Vec2, Vec4, DVec2, etc.)
// - id!, ids!, live_id! macros
```
