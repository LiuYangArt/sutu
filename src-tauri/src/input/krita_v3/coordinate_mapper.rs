#[derive(Debug, Clone, Copy)]
pub struct CoordinateMapper {
    width_px: f32,
    height_px: f32,
    raw_x_min: f32,
    raw_x_max: f32,
    raw_y_min: f32,
    raw_y_max: f32,
    invert_y: bool,
}

impl CoordinateMapper {
    pub fn new(width_px: f32, height_px: f32) -> Self {
        let safe_width = width_px.max(1.0);
        let safe_height = height_px.max(1.0);
        Self {
            width_px: safe_width,
            height_px: safe_height,
            raw_x_min: 0.0,
            raw_x_max: safe_width,
            raw_y_min: 0.0,
            raw_y_max: safe_height,
            invert_y: false,
        }
    }

    pub fn with_axis_range(
        width_px: f32,
        height_px: f32,
        raw_x_min: i32,
        raw_x_max: i32,
        raw_y_min: i32,
        raw_y_max: i32,
        invert_y: bool,
    ) -> Self {
        Self {
            width_px: width_px.max(1.0),
            height_px: height_px.max(1.0),
            raw_x_min: raw_x_min as f32,
            raw_x_max: raw_x_max as f32,
            raw_y_min: raw_y_min as f32,
            raw_y_max: raw_y_max as f32,
            invert_y,
        }
    }

    fn normalize_axis(value: f32, axis_min: f32, axis_max: f32) -> f32 {
        let denom = axis_max - axis_min;
        if !denom.is_finite() || denom.abs() < f32::EPSILON {
            return 0.0;
        }
        ((value - axis_min) / denom).clamp(0.0, 1.0)
    }

    pub fn map_output_xy(&self, raw_x: i32, raw_y: i32) -> (f32, f32) {
        let normalized_x = Self::normalize_axis(raw_x as f32, self.raw_x_min, self.raw_x_max);
        let mut normalized_y = Self::normalize_axis(raw_y as f32, self.raw_y_min, self.raw_y_max);
        if self.invert_y {
            normalized_y = 1.0 - normalized_y;
        }
        let x = (normalized_x * self.width_px).clamp(0.0, self.width_px);
        let y = (normalized_y * self.height_px).clamp(0.0, self.height_px);
        (x, y)
    }

    pub fn size(&self) -> (f32, f32) {
        (self.width_px, self.height_px)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clamps_output_coordinates_into_window_domain() {
        let mapper = CoordinateMapper::new(1920.0, 1080.0);
        assert_eq!(mapper.map_output_xy(-10, -20), (0.0, 0.0));
        assert_eq!(mapper.map_output_xy(3000, 2000), (1920.0, 1080.0));
        assert_eq!(mapper.map_output_xy(256, 512), (256.0, 512.0));
    }

    #[test]
    fn maps_axis_range_into_window_domain() {
        let mapper = CoordinateMapper::with_axis_range(2100.0, 1350.0, 0, 44799, 0, 29599, false);
        let (x0, y0) = mapper.map_output_xy(0, 0);
        let (x1, y1) = mapper.map_output_xy(44799, 29599);
        let (xm, ym) = mapper.map_output_xy(22399, 14799);
        assert_eq!((x0, y0), (0.0, 0.0));
        assert_eq!((x1, y1), (2100.0, 1350.0));
        assert!((xm - 1050.0).abs() < 1.0);
        assert!((ym - 675.0).abs() < 1.0);
    }

    #[test]
    fn inverts_y_when_requested() {
        let mapper = CoordinateMapper::with_axis_range(100.0, 80.0, 0, 1000, 0, 1000, true);
        let (_x_top, y_top) = mapper.map_output_xy(500, 0);
        let (_x_bottom, y_bottom) = mapper.map_output_xy(500, 1000);
        assert_eq!(y_top, 80.0);
        assert_eq!(y_bottom, 0.0);
    }
}
