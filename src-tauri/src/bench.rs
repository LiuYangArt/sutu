use std::thread;
use std::time::{Duration, Instant};
use tauri::ipc::Channel;

#[tauri::command]
pub async fn start_benchmark(on_event: Channel<Vec<u8>>, freq_hz: u64, duration_ms: u64) {
    let _ = tauri::async_runtime::spawn_blocking(move || {
        let interval = Duration::from_micros(1_000_000 / freq_hz);
        let start = Instant::now();

        // 预分配 Buffer (模拟 Batch)
        let batch_size = 10;

        while start.elapsed().as_millis() < duration_ms as u128 {
            let loop_start = Instant::now();

            // 构造 Batch 数据
            // 32 bytes * 10 = 320 bytes
            let mut buffer = Vec::with_capacity(32 * batch_size);
            for _ in 0..batch_size {
                // Mock 32 bytes data (all zeros for now)
                buffer.extend_from_slice(&[0u8; 32]);
            }

            // 发送
            if on_event.send(buffer).is_err() {
                break;
            }

            // Smart Sleep
            let work_time = loop_start.elapsed();
            if work_time < interval {
                thread::sleep(interval - work_time);
            }
        }
    })
    .await;
}
