//! Tablet manager - handles connection to graphics tablets via octotablet

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
    /// Note: Full implementation requires octotablet integration.
    /// This is a placeholder that will be expanded when we integrate
    /// the actual tablet input handling.
    pub fn init(&mut self) -> Result<(), String> {
        tracing::info!("Initializing tablet manager...");

        // TODO: Integrate octotablet
        // For now, we rely on PointerEvents from the frontend
        // which already provide pressure data through Windows Ink

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
