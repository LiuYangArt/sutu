//! 数位板管理器：维护设备连接状态与运行开关（当前不直接采集原生事件）

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

/// Tablet connection status
#[derive(Debug, Clone, Default)]
pub struct TabletStatus {
    pub connected: bool,
    pub device_name: Option<String>,
    pub supports_pressure: bool,
    pub supports_tilt: bool,
}

/// Manages tablet device connection and input
pub struct TabletManager {
    status: TabletStatus,
    running: Arc<AtomicBool>,
}

impl TabletManager {
    /// Create a new tablet manager
    pub fn new() -> Self {
        Self {
            status: TabletStatus::default(),
            running: Arc::new(AtomicBool::new(false)),
        }
    }

    /// Initialize tablet connection
    ///
    /// 当前实现是占位逻辑，输入主链路仍由前端 PointerEvent 提供。
    /// 后续如果引入新的原生后端，可以在此处扩展初始化流程。
    pub fn init(&mut self) -> Result<(), String> {
        tracing::info!("Initializing tablet manager...");

        // TODO: 如需新增原生输入后端，在此接入设备初始化。
        // 目前依赖前端 PointerEvent（Windows 下由 Windows Ink 提供压感）

        // Placeholder - detect tablet availability
        #[cfg(target_os = "windows")]
        {
            tracing::info!("Windows platform detected, tablet input will use PointerEvents");
            self.status = TabletStatus {
                connected: true,
                device_name: Some("Windows Ink".to_string()),
                supports_pressure: true,
                supports_tilt: true,
            };
        }

        #[cfg(not(target_os = "windows"))]
        {
            tracing::warn!("Non-Windows platform, tablet support may be limited");
        }

        Ok(())
    }

    /// Get current tablet status
    pub fn status(&self) -> &TabletStatus {
        &self.status
    }

    /// Check if tablet is connected
    pub fn is_connected(&self) -> bool {
        self.status.connected
    }

    /// Start listening for tablet events
    pub fn start(&self) {
        self.running.store(true, Ordering::SeqCst);
        tracing::info!("Tablet manager started");
    }

    /// Stop listening for tablet events
    pub fn stop(&self) {
        self.running.store(false, Ordering::SeqCst);
        tracing::info!("Tablet manager stopped");
    }
}

impl Default for TabletManager {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_tablet_manager_creation() {
        let manager = TabletManager::new();
        assert!(!manager.is_connected());
    }

    #[test]
    fn test_tablet_manager_init() {
        let mut manager = TabletManager::new();
        let result = manager.init();
        assert!(result.is_ok());
    }
}
