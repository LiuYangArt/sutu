//! Brush engine benchmarks

use criterion::{criterion_group, criterion_main, BenchmarkId, Criterion};
use sutu_lib::brush::{BrushEngine, BrushSettings};
use sutu_lib::input::RawInputPoint;

fn generate_stroke(count: usize) -> Vec<RawInputPoint> {
    (0..count)
        .map(|i| {
            let t = i as f32 / count as f32;
            RawInputPoint {
                x: t * 1000.0,
                y: (t * std::f32::consts::PI * 4.0).sin() * 100.0 + 500.0,
                pressure: 0.3 + t * 0.4,
                tilt_x: 0.0,
                tilt_y: 0.0,
                timestamp_ms: i as u64,
            }
        })
        .collect()
}

fn benchmark_stroke_processing(c: &mut Criterion) {
    let mut group = c.benchmark_group("Stroke Processing");

    for count in [10, 50, 100, 500, 1000].iter() {
        let points = generate_stroke(*count);
        let engine = BrushEngine::new();

        group.bench_with_input(BenchmarkId::new("process", count), &points, |b, points| {
            b.iter(|| engine.process(points))
        });
    }

    group.finish();
}

fn benchmark_brush_settings(c: &mut Criterion) {
    let mut group = c.benchmark_group("Brush Settings Impact");

    let points = generate_stroke(100);

    // Default settings
    let default_engine = BrushEngine::new();
    group.bench_function("default", |b| b.iter(|| default_engine.process(&points)));

    // High spacing (fewer points generated)
    let high_spacing_engine = BrushEngine::with_settings(BrushSettings {
        spacing: 0.5,
        ..Default::default()
    });
    group.bench_function("high_spacing", |b| {
        b.iter(|| high_spacing_engine.process(&points))
    });

    // Low spacing (more points generated)
    let low_spacing_engine = BrushEngine::with_settings(BrushSettings {
        spacing: 0.1,
        ..Default::default()
    });
    group.bench_function("low_spacing", |b| {
        b.iter(|| low_spacing_engine.process(&points))
    });

    group.finish();
}

criterion_group!(
    benches,
    benchmark_stroke_processing,
    benchmark_brush_settings
);
criterion_main!(benches);
