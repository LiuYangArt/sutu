#[derive(Debug, Clone, Copy)]
pub struct MappedCoordinateMac {
    pub x_px: f32,
    pub y_px: f32,
    pub out_of_view: bool,
}

#[derive(Debug, Clone, Copy)]
pub struct CoordinateMapperMac {
    viewport_width_px: f32,
    viewport_height_px: f32,
    y_origin_bottom_left: bool,
}

impl CoordinateMapperMac {
    pub fn new(viewport_width_px: f32, viewport_height_px: f32) -> Self {
        Self {
            viewport_width_px: viewport_width_px.max(1.0),
            viewport_height_px: viewport_height_px.max(1.0),
            y_origin_bottom_left: true,
        }
    }

    pub fn update_viewport_size(&mut self, viewport_width_px: f32, viewport_height_px: f32) {
        self.viewport_width_px = viewport_width_px.max(1.0);
        self.viewport_height_px = viewport_height_px.max(1.0);
    }

    pub fn map_window_point_to_client(
        &self,
        x_window_px: f32,
        y_window_px: f32,
    ) -> MappedCoordinateMac {
        let mut y_client = y_window_px;
        if self.y_origin_bottom_left {
            y_client = self.viewport_height_px - y_window_px;
        }
        let out_of_view = x_window_px < 0.0
            || x_window_px > self.viewport_width_px
            || y_client < 0.0
            || y_client > self.viewport_height_px;

        MappedCoordinateMac {
            x_px: x_window_px.clamp(0.0, self.viewport_width_px),
            y_px: y_client.clamp(0.0, self.viewport_height_px),
            out_of_view,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn converts_bottom_left_origin_to_top_left_client_domain() {
        let mapper = CoordinateMapperMac::new(800.0, 600.0);
        let top_left = mapper.map_window_point_to_client(0.0, 600.0);
        let bottom_left = mapper.map_window_point_to_client(0.0, 0.0);
        assert_eq!(top_left.x_px, 0.0);
        assert_eq!(top_left.y_px, 0.0);
        assert_eq!(bottom_left.x_px, 0.0);
        assert_eq!(bottom_left.y_px, 600.0);
    }

    #[test]
    fn marks_and_clamps_out_of_view_points() {
        let mapper = CoordinateMapperMac::new(400.0, 300.0);
        let mapped = mapper.map_window_point_to_client(-10.0, 999.0);
        assert!(mapped.out_of_view);
        assert_eq!(mapped.x_px, 0.0);
        assert_eq!(mapped.y_px, 0.0);
    }
}
