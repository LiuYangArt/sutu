use std::collections::HashMap;

#[derive(Debug, Default)]
pub struct MonotonicTimebase {
    per_pointer_last_host_us: HashMap<u32, u64>,
    corrected_samples: u64,
}

impl MonotonicTimebase {
    pub fn new() -> Self {
        Self {
            per_pointer_last_host_us: HashMap::new(),
            corrected_samples: 0,
        }
    }

    pub fn reset(&mut self) {
        self.per_pointer_last_host_us.clear();
        self.corrected_samples = 0;
    }

    pub fn normalize_host_time_us(&mut self, pointer_id: u32, raw_host_time_us: u64) -> u64 {
        let entry = self.per_pointer_last_host_us.entry(pointer_id).or_insert(0);
        let normalized = if raw_host_time_us <= *entry {
            self.corrected_samples = self.corrected_samples.saturating_add(1);
            entry.saturating_add(1)
        } else {
            raw_host_time_us
        };
        *entry = normalized;
        normalized
    }

    pub fn corrected_samples(&self) -> u64 {
        self.corrected_samples
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn enforces_monotonic_time_per_pointer() {
        let mut timebase = MonotonicTimebase::new();
        assert_eq!(timebase.normalize_host_time_us(1, 100), 100);
        assert_eq!(timebase.normalize_host_time_us(1, 100), 101);
        assert_eq!(timebase.normalize_host_time_us(1, 99), 102);
        assert_eq!(timebase.corrected_samples(), 2);
    }

    #[test]
    fn keeps_independent_monotonic_domain_for_each_pointer() {
        let mut timebase = MonotonicTimebase::new();
        assert_eq!(timebase.normalize_host_time_us(1, 500), 500);
        assert_eq!(timebase.normalize_host_time_us(2, 120), 120);
        assert_eq!(timebase.normalize_host_time_us(1, 400), 501);
        assert_eq!(timebase.normalize_host_time_us(2, 120), 121);
    }
}
