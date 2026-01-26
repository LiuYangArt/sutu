use axum::{
    body::Body,
    extract::ws::{Message, WebSocket, WebSocketUpgrade},
    response::IntoResponse,
    routing::get,
    Router,
};
use std::time::{Duration, Instant};
use tokio::time::sleep;
use tokio_stream::wrappers::ReceiverStream;
use tower_http::cors::CorsLayer;

const BENCH_FREQ_HZ: u64 = 240;
const BENCH_DURATION_SECS: u64 = 2;
const BENCH_BATCH_SIZE: usize = 10;
const PACKET_SIZE: usize = 32;

pub async fn start(port: u16) {
    let app = Router::new()
        .route("/ws", get(ws_handler))
        .route("/stream", get(stream_handler))
        .layer(CorsLayer::permissive());

    let addr = format!("0.0.0.0:{}", port);
    match tokio::net::TcpListener::bind(&addr).await {
        Ok(listener) => {
            tracing::info!("Benchmark server listening on {}", addr);
            if let Err(e) = axum::serve(listener, app).await {
                tracing::error!("Benchmark server error: {}", e);
            }
        }
        Err(e) => {
            tracing::error!("Failed to bind benchmark server to {}: {}", addr, e);
        }
    }
}

// --- WebSocket Handler ---

async fn ws_handler(ws: WebSocketUpgrade) -> impl IntoResponse {
    ws.on_upgrade(handle_socket)
}

async fn handle_socket(mut socket: WebSocket) {
    if let Some(Ok(Message::Text(text))) = socket.recv().await {
        if text == "start" {
            let interval = Duration::from_micros(1_000_000 / BENCH_FREQ_HZ);
            let duration = Duration::from_secs(BENCH_DURATION_SECS);
            let start_time = Instant::now();
            let buffer = vec![0u8; PACKET_SIZE * BENCH_BATCH_SIZE];

            while start_time.elapsed() < duration {
                let loop_start = Instant::now();

                if socket.send(Message::Binary(buffer.clone())).await.is_err() {
                    break;
                }

                let work_time = loop_start.elapsed();
                if work_time < interval {
                    sleep(interval - work_time).await;
                }
            }
        }
    }
}

// --- HTTP Stream Handler ---

async fn stream_handler() -> impl IntoResponse {
    let (tx, rx) = tokio::sync::mpsc::channel(100);

    tokio::spawn(async move {
        let interval = Duration::from_micros(1_000_000 / BENCH_FREQ_HZ);
        let duration = Duration::from_secs(BENCH_DURATION_SECS);
        let start_time = Instant::now();
        let buffer = vec![0u8; PACKET_SIZE * BENCH_BATCH_SIZE];

        while start_time.elapsed() < duration {
            let loop_start = Instant::now();

            if tx
                .send(Ok::<_, std::io::Error>(buffer.clone()))
                .await
                .is_err()
            {
                break;
            }

            let work_time = loop_start.elapsed();
            if work_time < interval {
                sleep(interval - work_time).await;
            }
        }
    });

    Body::from_stream(ReceiverStream::new(rx))
}
