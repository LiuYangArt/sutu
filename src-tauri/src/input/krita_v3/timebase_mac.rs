use std::collections::HashMap;

#[derive(Debug, Default)]
pub struct MonotonicTimebaseMac {
    host_last_us: HashMap<u32, u64>,
    device_last_us: HashMap<u32, u64>,
    corrected_host_samples: u64,
    corrected_device_samples: u64,
}

impl MonotonicTimebaseMac {
    pub fn new() -> Self {
        Self {
            host_last_us: HashMap::new(),
            device_last_us: HashMap::new(),
            corrected_host_samples: 0,
            corrected_device_samples: 0,
        }
    }

    pub fn reset(&mut self) {
        self.host_last_us.clear();
        self.device_last_us.clear();
        self.corrected_host_samples = 0;
        self.corrected_device_samples = 0;
    }

    pub fn normalize_host_time_us(
        &mut self,
        pointer_id: u32,
        raw_host_time_us: u64,
    ) -> (u64, bool) {
        let entry = self.host_last_us.entry(pointer_id).or_insert(0);
        if raw_host_time_us <= *entry {
            self.corrected_host_samples = self.corrected_host_samples.saturating_add(1);
            let corrected = entry.saturating_add(1);
            *entry = corrected;
            (corrected, true)
        } else {
            *entry = raw_host_time_us;
            (raw_host_time_us, false)
        }
    }

    pub fn normalize_device_time_us(
        &mut self,
        pointer_id: u32,
        raw_device_time_us: Option<u64>,
        fallback_host_time_us: u64,
    ) -> Option<u64> {
        let raw = raw_device_time_us.unwrap_or(fallback_host_time_us);
        let entry = self.device_last_us.entry(pointer_id).or_insert(0);
        if raw <= *entry {
            self.corrected_device_samples = self.corrected_device_samples.saturating_add(1);
            let corrected = entry.saturating_add(1);
            *entry = corrected;
            Some(corrected)
        } else {
            *entry = raw;
            Some(raw)
        }
    }

    pub fn corrected_host_samples(&self) -> u64 {
        self.corrected_host_samples
    }

    pub fn corrected_device_samples(&self) -> u64 {
        self.corrected_device_samples
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_host_time_monotonic_for_each_pointer() {
        let mut timebase = MonotonicTimebaseMac::new();
        assert_eq!(timebase.normalize_host_time_us(1, 100), (100, false));
        assert_eq!(timebase.normalize_host_time_us(1, 99), (101, true));
        assert_eq!(timebase.normalize_host_time_us(2, 50), (50, false));
        assert_eq!(timebase.normalize_host_time_us(2, 50), (51, true));
        assert_eq!(timebase.corrected_host_samples(), 2);
    }

    #[test]
    fn keeps_device_time_monotonic_with_fallback() {
        let mut timebase = MonotonicTimebaseMac::new();
        assert_eq!(
            timebase.normalize_device_time_us(1, Some(200), 190),
            Some(200)
        );
        assert_eq!(
            timebase.normalize_device_time_us(1, Some(180), 190),
            Some(201)
        );
        assert_eq!(timebase.normalize_device_time_us(1, None, 202), Some(202));
        assert_eq!(timebase.corrected_device_samples(), 1);
    }
}
