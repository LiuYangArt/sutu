---
name: makepad-shaders
description: Write custom GPU shaders and animations in Makepad using SDF drawing, uniforms, and the animator system. Use when creating visual effects, custom drawing, gradients, shadows, or animations in Makepad widgets.
---

# Makepad Shaders

This skill enables Claude Code to write custom GPU shaders and animations in Makepad, including SDF drawing, visual effects, and the animator system.

## Overview

Makepad shaders are defined inline within `live_design!` blocks using a custom shader DSL that compiles to GLSL. Key features:
- SDF (Signed Distance Field) based drawing
- Instance/uniform variables for customization
- Animator integration for smooth transitions
- GPU-accelerated rendering

## Shader Structure

```rust
live_design! {
    MyWidget = {{MyWidget}} {
        draw_bg: {
            // Instance variables (per-widget)
            instance hover: 0.0
            instance pressed: 0.0

            // Uniforms (global parameters)
            uniform color: #4A90D9
            uniform border_radius: 4.0

            fn pixel(self) -> vec4 {
                let sdf = Sdf2d::viewport(self.pos * self.rect_size);
                sdf.box(0., 0., self.rect_size.x, self.rect_size.y, self.border_radius);
                sdf.fill(self.color);
                return sdf.result;
            }
        }
    }
}
```

## Variable Types

| Type | Scope | Usage |
|------|-------|-------|
| `instance` | Per-widget | `instance hover: 0.0` |
| `uniform` | Global | `uniform color: #4A90D9` |
| `varying` | Vertex→Fragment | `varying uv: vec2` |
| `texture` | Texture sampler | `texture my_tex: texture2d` |

## Built-in Variables

| Variable | Type | Description |
|----------|------|-------------|
| `self.pos` | vec2 | Normalized position (0-1) |
| `self.rect_size` | vec2 | Widget size in pixels |
| `self.rect_pos` | vec2 | Widget position |
| `self.geom_pos` | vec2 | Geometry position |

## SDF Drawing

### Basic Shapes

```rust
fn pixel(self) -> vec4 {
    let sdf = Sdf2d::viewport(self.pos * self.rect_size);

    // Circle
    sdf.circle(center_x, center_y, radius);

    // Rounded rectangle
    sdf.box(x, y, width, height, corner_radius);

    // Hexagon
    sdf.hexagon(center_x, center_y, radius);

    return sdf.result;
}
```

### SDF Operations

| Function | Description |
|----------|-------------|
| `sdf.circle(x, y, r)` | Circle at (x,y) with radius r |
| `sdf.box(x, y, w, h, r)` | Rounded rect with corner radius r |
| `sdf.hexagon(x, y, r)` | Hexagon |
| `sdf.fill(color)` | Fill current shape |
| `sdf.stroke(color, width)` | Stroke outline |
| `sdf.fill_keep(color)` | Fill and preserve shape |
| `sdf.stroke_keep(color, width)` | Stroke and preserve shape |

### Combining Shapes

```rust
fn pixel(self) -> vec4 {
    let sdf = Sdf2d::viewport(self.pos * self.rect_size);

    // First shape
    sdf.circle(50., 50., 30.);
    sdf.fill_keep(#FF0000);

    // Second shape (additive)
    sdf.circle(80., 50., 30.);
    sdf.fill(#00FF00);

    return sdf.result;
}
```

## Common Effects

### Hover Effect

```rust
draw_bg: {
    instance hover: 0.0
    uniform base_color: #4A90D9

    fn pixel(self) -> vec4 {
        let sdf = Sdf2d::viewport(self.pos * self.rect_size);
        sdf.box(0., 0., self.rect_size.x, self.rect_size.y, 4.0);

        let hover_color = mix(self.base_color, #FFFFFF, 0.2);
        let final_color = mix(self.base_color, hover_color, self.hover);

        sdf.fill(final_color);
        return sdf.result;
    }
}
```

### Gradient Background

```rust
draw_bg: {
    uniform color1: #4A90D9
    uniform color2: #2E5A8A

    fn pixel(self) -> vec4 {
        let sdf = Sdf2d::viewport(self.pos * self.rect_size);
        sdf.box(0., 0., self.rect_size.x, self.rect_size.y, 0.0);

        // Vertical gradient
        let gradient = mix(self.color1, self.color2, self.pos.y);
        sdf.fill(gradient);

        return sdf.result;
    }
}
```

### Inner Shadow

```rust
draw_bg: {
    uniform shadow_color: #0007
    uniform shadow_radius: 10.0

    fn pixel(self) -> vec4 {
        let sdf = Sdf2d::viewport(self.pos * self.rect_size);

        sdf.box(0., 0., self.rect_size.x, self.rect_size.y, 4.0);
        let outer_dist = sdf.shape;

        let dist_from_edge = -outer_dist;
        let intensity = 1.0 - smoothstep(0.0, self.shadow_radius, dist_from_edge);
        let shadow_factor = clamp(intensity, 0.0, 1.0) * step(outer_dist, 0.0);

        let base_color = #FFFFFF;
        let final_rgb = mix(base_color.rgb, self.shadow_color.rgb,
                           shadow_factor * self.shadow_color.a);

        sdf.fill(vec4(final_rgb, 1.0));
        return sdf.result;
    }
}
```

### Circular Avatar Mask

```rust
draw_bg: {
    fn pixel(self) -> vec4 {
        let sdf = Sdf2d::viewport(self.pos * self.rect_size);
        let c = self.rect_size * 0.5;

        sdf.circle(c.x, c.y, c.x);
        let img_color = sample2d(self.image, self.pos);
        sdf.fill(img_color);

        return sdf.result;
    }
}
```

## Animation System

### Animator Definition

```rust
live_design! {
    MyButton = {{MyButton}} {
        draw_bg: {
            instance hover: 0.0
            instance pressed: 0.0
        }

        animator: {
            hover = {
                default: off,
                off = {
                    from: {all: Forward {duration: 0.15}}
                    apply: { draw_bg: {hover: 0.0} }
                }
                on = {
                    from: {all: Forward {duration: 0.1}}
                    apply: { draw_bg: {hover: 1.0} }
                }
            }
            pressed = {
                default: off,
                off = {
                    from: {all: Forward {duration: 0.2}}
                    apply: { draw_bg: {pressed: 0.0} }
                }
                on = {
                    from: {all: Snap}
                    apply: { draw_bg: {pressed: 1.0} }
                }
            }
        }
    }
}
```

### Animation Timing

| Timing | Description |
|--------|-------------|
| `Forward {duration: 0.15}` | Linear transition |
| `Snap` | Instant change |
| `Loop {duration: 1.0, end: 1.0}` | Looping animation |

### Triggering Animations

```rust
impl Widget for MyButton {
    fn handle_event(&mut self, cx: &mut Cx, event: &Event, scope: &mut Scope) {
        if self.animator_handle_event(cx, event).must_redraw() {
            self.draw_bg.redraw(cx);
        }

        match event.hits(cx, self.draw_bg.area()) {
            Hit::FingerHoverIn(_) => {
                self.animator_play(cx, ids!(hover.on));
            }
            Hit::FingerHoverOut(_) => {
                self.animator_play(cx, ids!(hover.off));
            }
            Hit::FingerDown(_) => {
                self.animator_play(cx, ids!(pressed.on));
            }
            Hit::FingerUp(_) => {
                self.animator_play(cx, ids!(pressed.off));
            }
            _ => {}
        }
    }
}
```

### Animated Effect (Bouncing Dots)

```rust
draw_bg: {
    uniform anim_time: 0.0
    uniform freq: 0.9
    uniform dot_radius: 3.0

    fn pixel(self) -> vec4 {
        let sdf = Sdf2d::viewport(self.pos * self.rect_size);

        let amplitude = self.rect_size.y * 0.2;
        let center_y = self.rect_size.y * 0.5;

        // Three dots with phase offset
        let phase1 = self.anim_time * 2.0 * PI * self.freq;
        let phase2 = phase1 + 2.0;
        let phase3 = phase1 + 4.0;

        sdf.circle(self.rect_size.x * 0.25,
                   amplitude * sin(phase1) + center_y, self.dot_radius);
        sdf.fill_keep(#4A90D9);

        sdf.circle(self.rect_size.x * 0.5,
                   amplitude * sin(phase2) + center_y, self.dot_radius);
        sdf.fill_keep(#4A90D9);

        sdf.circle(self.rect_size.x * 0.75,
                   amplitude * sin(phase3) + center_y, self.dot_radius);
        sdf.fill(#4A90D9);

        return sdf.result;
    }
}

animator: {
    dots = {
        default: off,
        on = {
            from: {all: Loop {duration: 1.0, end: 1.0}}
            apply: {draw_bg: {anim_time: [{time: 0.0, value: 0.0}, {time: 1.0, value: 1.0}]}}
        }
    }
}
```

## Math Functions

| Function | Description |
|----------|-------------|
| `mix(a, b, t)` | Linear interpolation |
| `smoothstep(a, b, x)` | Smooth Hermite interpolation |
| `clamp(x, min, max)` | Clamp value to range |
| `step(edge, x)` | 0 if x < edge, else 1 |
| `sin(x)`, `cos(x)` | Trigonometric |
| `length(v)` | Vector length |
| `normalize(v)` | Unit vector |
| `dot(a, b)` | Dot product |
| `pow(x, y)` | Power |
| `abs(x)` | Absolute value |

## Texture Sampling

```rust
draw_bg: {
    texture my_image: texture2d

    fn pixel(self) -> vec4 {
        // Sample at current position
        let color = sample2d(self.my_image, self.pos);

        // Sample with custom UV (tiling)
        let custom_uv = vec2(self.pos.x * 2.0, self.pos.y);
        let tiled = sample2d(self.my_image, fract(custom_uv));

        return color;
    }
}
```

## Advanced Effects

### Scanline Background (CRT Effect)

```rust
draw_bg: {
    color: #0a0a12

    fn pixel(self) -> vec4 {
        // Vertical gradient
        let bg = mix(self.color, self.color * 1.1, self.pos.y);

        // Scanline effect
        let scanline = sin(self.pos.y * 500.0) * 0.012;

        return bg + vec4(scanline, scanline, scanline * 1.2, 0.0);
    }
}
```

### Glowing Divider

```rust
divider = <View> {
    width: Fill
    height: 1
    show_bg: true
    draw_bg: {
        color: #00ff88

        fn pixel(self) -> vec4 {
            // Horizontal sine wave glow
            let glow = sin(self.pos.x * 8.0) * 0.3 + 0.5;
            return self.color * glow;
        }
    }
}
```

### Card with Border

```rust
CurrencyCard = <View> {
    show_bg: true
    draw_bg: {
        color: #1a1a26

        fn pixel(self) -> vec4 {
            let sdf = Sdf2d::viewport(self.pos * self.rect_size);

            // Inset box for border effect
            sdf.box(1.0, 1.0, self.rect_size.x - 2.0, self.rect_size.y - 2.0, 6.0);
            sdf.fill(self.color);

            // Border stroke
            sdf.stroke(#333348, 1.0);

            return sdf.result;
        }
    }
}
```

### Radial Gradient

```rust
draw_bg: {
    color: #4A90D9
    color2: #1a1a26

    fn pixel(self) -> vec4 {
        let center = vec2(0.5, 0.5);
        let dist = length(self.pos - center);

        // Radial gradient from center
        return mix(self.color, self.color2, dist * 2.0);
    }
}
```

### Pulsing Glow

```rust
draw_bg: {
    uniform time: 0.0
    color: #00ff88

    fn pixel(self) -> vec4 {
        // Pulsing intensity
        let pulse = sin(self.time * 3.0) * 0.3 + 0.7;
        return self.color * pulse;
    }
}

animator: {
    pulse = {
        default: on,
        on = {
            from: {all: Loop {duration: 2.0, end: 1.0}}
            apply: {draw_bg: {time: [{time: 0.0, value: 0.0}, {time: 1.0, value: 6.28}]}}
        }
    }
}
```

### Noise/Static Effect

```rust
draw_bg: {
    uniform time: 0.0

    fn random(st: vec2) -> f32 {
        return fract(sin(dot(st, vec2(12.9898, 78.233))) * 43758.5453);
    }

    fn pixel(self) -> vec4 {
        let noise = random(self.pos * self.rect_size + vec2(self.time, 0.0));
        let base = #1a1a26;
        return base + vec4(noise * 0.05, noise * 0.05, noise * 0.05, 0.0);
    }
}
```

### Rounded Rectangle with Soft Shadow

```rust
draw_bg: {
    color: #ffffff
    shadow_color: #00000044
    shadow_offset: vec2(4.0, 4.0)
    shadow_blur: 8.0

    fn pixel(self) -> vec4 {
        let sdf = Sdf2d::viewport(self.pos * self.rect_size);
        let radius = 8.0;

        // Shadow (offset and blurred)
        let shadow_pos = self.pos * self.rect_size - self.shadow_offset;
        let shadow_sdf = Sdf2d::viewport(shadow_pos);
        shadow_sdf.box(0., 0., self.rect_size.x, self.rect_size.y, radius);

        // Main shape
        sdf.box(0., 0., self.rect_size.x, self.rect_size.y, radius);
        sdf.fill(self.color);

        return sdf.result;
    }
}
```

### Capsule/Stadium Shape (Switch Track)

<!-- Evolution: 2026-01-10 | source: makepad-component | author: @anthropic -->

**Important**: `sdf.box()` with large radius may not produce correct capsule shapes. Use shape composition instead:

```rust
draw_bg: {
    instance on: 0.0
    instance hover: 0.0

    fn pixel(self) -> vec4 {
        let sdf = Sdf2d::viewport(self.pos * self.rect_size);
        let sz = self.rect_size;
        let r = sz.y * 0.5;

        // Draw capsule: left circle + rectangle + right circle
        sdf.circle(r, r, r);
        sdf.rect(r, 0.0, sz.x - sz.y, sz.y);
        sdf.circle(sz.x - r, r, r);

        let bg_off = #cbd5e1;
        let bg_on = #3b82f6;
        let color = mix(bg_off, bg_on, self.on);

        sdf.fill(color);
        return sdf.result;
    }
}
```

This creates a perfect capsule/stadium shape by combining:
- Left semicircle at `(r, r)` with radius `r`
- Rectangle in the middle from `r` to `sz.x - r`
- Right semicircle at `(sz.x - r, r)` with radius `r`

### Progress Bar with Partial Fill

<!-- Evolution: 2026-01-10 | source: makepad-component | author: @anthropic -->

**Important**: Use `step()` instead of `if` for conditional fill. Use `apply_over()` to update instance variables at runtime.

```rust
draw_bg: {
    instance progress: 0.0  // 0.0 to 1.0

    fn pixel(self) -> vec4 {
        let sdf = Sdf2d::viewport(self.pos * self.rect_size);
        let sz = self.rect_size;
        let r = sz.y * 0.5;

        // Draw track (background capsule)
        sdf.circle(r, r, r);
        sdf.rect(r, 0.0, sz.x - sz.y, sz.y);
        sdf.circle(sz.x - r, r, r);

        let track_color = #e2e8f0;
        let fill_color = #3b82f6;

        sdf.fill(track_color);

        // Calculate fill region using step() - avoids if-branch
        let fill_end = sz.x * self.progress;
        let px = self.pos.x * sz.x;
        let in_fill = step(px, fill_end);  // 1.0 if px <= fill_end, else 0.0

        // Draw fill shape
        let sdf2 = Sdf2d::viewport(self.pos * self.rect_size);
        sdf2.circle(r, r, r);
        sdf2.rect(r, 0.0, sz.x - sz.y, sz.y);
        sdf2.circle(sz.x - r, r, r);
        sdf2.fill(fill_color);

        // Blend: show fill_color where in_fill=1, track_color where in_fill=0
        return mix(sdf.result, sdf2.result, in_fill * sdf2.result.w);
    }
}
```

To update at runtime:
```rust
fn draw_walk(&mut self, cx: &mut Cx2d, _scope: &mut Scope, walk: Walk) -> DrawStep {
    let progress = (self.value / 100.0).clamp(0.0, 1.0);
    self.draw_bg.apply_over(cx, live! {
        progress: (progress)
    });
    self.draw_bg.draw_walk(cx, walk);
    DrawStep::done()
}
```

### Range Slider with Dual Values

<!-- Evolution: 2026-01-10 | source: makepad-component | author: @anthropic -->

For a slider that can have both a start and end value (range selection):

```rust
draw_track: {
    instance progress_start: 0.0  // Start of range (0.0-1.0)
    instance progress_end: 0.0    // End of range (0.0-1.0)
    instance track_color: #e2e8f0
    instance fill_color: #3b82f6

    fn pixel(self) -> vec4 {
        let sdf = Sdf2d::viewport(self.pos * self.rect_size);
        let sz = self.rect_size;
        let r = sz.y * 0.5;

        // Draw track capsule
        sdf.circle(r, r, r);
        sdf.rect(r, 0.0, sz.x - sz.y, sz.y);
        sdf.circle(sz.x - r, r, r);
        sdf.fill(self.track_color);

        // Calculate fill region between start and end
        let fill_start = sz.x * self.progress_start;
        let fill_end = sz.x * self.progress_end;
        let px = self.pos.x * sz.x;

        // Pixel is in fill if: progress_start <= px <= progress_end
        let in_fill = step(fill_start, px) * step(px, fill_end);

        // Draw fill shape
        let sdf2 = Sdf2d::viewport(self.pos * self.rect_size);
        sdf2.circle(r, r, r);
        sdf2.rect(r, 0.0, sz.x - sz.y, sz.y);
        sdf2.circle(sz.x - r, r, r);
        sdf2.fill(self.fill_color);

        return mix(sdf.result, sdf2.result, in_fill * sdf2.result.w);
    }
}
```

### Orientation-Switchable Shape (Vertical/Horizontal)

<!-- Evolution: 2026-01-10 | source: makepad-component | author: @anthropic -->

Use an instance variable to switch between horizontal and vertical orientation:

```rust
draw_track: {
    instance vertical: 0.0  // 0.0 = horizontal, 1.0 = vertical
    instance progress: 0.0

    fn pixel(self) -> vec4 {
        let sdf = Sdf2d::viewport(self.pos * self.rect_size);
        let sz = self.rect_size;

        // Use mix() to select dimension based on orientation
        let is_vert = self.vertical;
        let length = mix(sz.x, sz.y, is_vert);
        let thickness = mix(sz.y, sz.x, is_vert);
        let r = thickness * 0.5;

        // Position along main axis (inverted for vertical)
        let pos_main = mix(self.pos.x, 1.0 - self.pos.y, is_vert);

        // Draw capsule based on orientation
        if is_vert > 0.5 {
            sdf.circle(r, r, r);
            sdf.rect(0.0, r, sz.x, sz.y - sz.x);
            sdf.circle(r, sz.y - r, r);
        } else {
            sdf.circle(r, r, r);
            sdf.rect(r, 0.0, sz.x - sz.y, sz.y);
            sdf.circle(sz.x - r, r, r);
        }

        // ... fill logic using pos_main * length
    }
}
```

Note: For orientation switching, using `if` in the shape construction is acceptable since it's a static branch. Avoid `if` in the fill/color logic - use `step()` and `mix()` there.

### Disabled State Shader Pattern

<!-- Evolution: 2026-01-10 | source: makepad-component | author: @anthropic -->

Pattern for widgets that support disabled state with visual feedback:

```rust
draw_thumb: {
    instance hover: 0.0
    instance pressed: 0.0
    instance disabled: 0.0
    instance border_color: #3b82f6
    instance disabled_border_color: #94a3b8

    fn pixel(self) -> vec4 {
        let sdf = Sdf2d::viewport(self.pos * self.rect_size);
        let c = self.rect_size * 0.5;

        // Choose color based on disabled state
        let border_col = mix(self.border_color, self.disabled_border_color, self.disabled);

        // Shadow (only when not disabled)
        let shadow_alpha = mix(0.2, 0.0, self.disabled);
        sdf.circle(c.x + 2.0, c.y + 2.0, c.x - 2.0);
        sdf.fill(vec4(0.0, 0.0, 0.0, shadow_alpha));

        // Main circle
        sdf.circle(c.x, c.y, c.x - 2.0);

        // Base colors with disabled variation
        let base_color = mix(#ffffff, #f8fafc, self.disabled);
        let hover_color = #f0f9ff;
        let pressed_color = #e0f2fe;

        // Disable hover/pressed effects when disabled
        let active_hover = self.hover * (1.0 - self.disabled);
        let active_pressed = self.pressed * (1.0 - self.disabled);

        let color = mix(base_color, hover_color, active_hover);
        let color = mix(color, pressed_color, active_pressed);

        sdf.fill(color);
        sdf.stroke(border_col, 2.5);

        return sdf.result;
    }
}
```

Key techniques:
- Use `mix(normal, disabled, self.disabled)` to interpolate colors
- Multiply hover/pressed by `(1.0 - self.disabled)` to disable interactions
- Remove shadows/effects when disabled: `mix(normal_alpha, 0.0, self.disabled)`

## Best Practices

1. **Use SDF for shapes** - More efficient than pixel-by-pixel drawing
2. **Minimize texture samples** - Each sample is expensive
3. **Use uniforms for constants** - Allows live tweaking
4. **Use instance variables for per-widget state** - hover, pressed, etc.
5. **Leverage smoothstep** - For antialiased edges and smooth transitions
6. **Check must_redraw()** - Only redraw when animator needs it
7. **Avoid branching** - GPU prefers math over if/else

## References

- [Makepad draw2 source](https://github.com/makepad/makepad/tree/main/draw2)
- [Shader examples in ui_zoo](https://github.com/makepad/makepad/tree/main/examples/ui_zoo)
