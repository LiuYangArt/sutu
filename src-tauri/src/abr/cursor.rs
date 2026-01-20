//! Cursor outline extraction for brush textures
//!
//! Extracts SVG path outlines from brush textures using boundary tracing.
//! Supports multiple disconnected contours (like Krita's KisOutlineGenerator).
//! The generated paths are used for cursor display in the frontend.

use super::types::GrayscaleImage;

/// Extract contour outlines from grayscale texture using boundary tracing.
/// Returns SVG path data with multiple subpaths, normalized to 0-1 coordinates, centered at origin.
///
/// # Arguments
/// * `img` - Grayscale image data
/// * `threshold` - Alpha threshold for edge detection (0-255, typically 128)
///
/// # Returns
/// SVG path string with multiple subpaths "M...Z M...Z" or None if extraction fails
pub fn extract_cursor_outline(img: &GrayscaleImage, threshold: u8) -> Option<String> {
    if img.width < 2 || img.height < 2 || img.data.is_empty() {
        return None;
    }

    let w = img.width as usize;
    let h = img.height as usize;

    // Build binary grid
    let binary: Vec<bool> = img.data.iter().map(|&v| v >= threshold).collect();

    // Find all boundary pixels
    let mut boundary_pixels: Vec<(usize, usize)> = Vec::new();
    for y in 0..h {
        for x in 0..w {
            if binary[y * w + x] && is_boundary_pixel(&binary, w, h, x, y) {
                boundary_pixels.push((x, y));
            }
        }
    }

    if boundary_pixels.len() < 3 {
        return None;
    }

    // Extract multiple contours by tracing connected boundary pixels
    let contours = extract_all_contours(&boundary_pixels, w, h);
    if contours.is_empty() {
        return None;
    }

    // Convert to SVG path with multiple subpaths
    let max_dim = (w.max(h)) as f32;
    let center_x = w as f32 / 2.0;
    let center_y = h as f32 / 2.0;

    let mut svg_path = String::new();

    for contour in contours {
        if contour.len() < 3 {
            continue;
        }

        // Simplify the contour
        let simplified = rdp_simplify(&contour, 0.8);
        if simplified.len() < 3 {
            continue;
        }

        // Append subpath
        for (i, (x, y)) in simplified.iter().enumerate() {
            let nx = (x - center_x) / max_dim;
            let ny = (y - center_y) / max_dim;

            if i == 0 {
                if !svg_path.is_empty() {
                    svg_path.push(' ');
                }
                svg_path.push_str(&format!("M {:.3} {:.3}", nx, ny));
            } else {
                svg_path.push_str(&format!(" L {:.3} {:.3}", nx, ny));
            }
        }
        svg_path.push_str(" Z");
    }

    if svg_path.is_empty() {
        None
    } else {
        Some(svg_path)
    }
}

/// Check if a pixel is on the boundary
fn is_boundary_pixel(binary: &[bool], w: usize, h: usize, x: usize, y: usize) -> bool {
    let neighbors: [(i32, i32); 4] = [(-1, 0), (1, 0), (0, -1), (0, 1)];

    for (dx, dy) in neighbors {
        let nx = x as i32 + dx;
        let ny = y as i32 + dy;

        if nx < 0 || ny < 0 || nx >= w as i32 || ny >= h as i32 {
            return true; // Edge of image
        }

        if !binary[ny as usize * w + nx as usize] {
            return true; // Adjacent to empty pixel
        }
    }

    false
}

/// Extract all contours from boundary pixels, supporting multiple disconnected regions
fn extract_all_contours(
    boundary_pixels: &[(usize, usize)],
    _w: usize,
    _h: usize,
) -> Vec<Vec<(f32, f32)>> {
    let mut remaining: Vec<(usize, usize)> = boundary_pixels.to_vec();
    let mut contours = Vec::new();

    while remaining.len() >= 3 {
        // Start from topmost-leftmost unvisited pixel
        remaining.sort_by(|a, b| a.1.cmp(&b.1).then(a.0.cmp(&b.0)));

        let start = remaining.remove(0);
        let mut contour = vec![(start.0 as f32, start.1 as f32)];

        // Trace this contour using nearest-neighbor
        loop {
            let last = contour.last().unwrap();
            let last_x = last.0 as i32;
            let last_y = last.1 as i32;

            // Find nearest unvisited boundary pixel
            let mut best_idx = None;
            let mut best_dist = i32::MAX;

            for (i, &(px, py)) in remaining.iter().enumerate() {
                let dx = px as i32 - last_x;
                let dy = py as i32 - last_y;
                let dist = dx * dx + dy * dy;

                if dist < best_dist {
                    best_dist = dist;
                    best_idx = Some(i);
                }
            }

            // If the nearest point is too far (gap), this contour is complete
            // Use distance threshold of 8 (sqrt(8) ≈ 2.83 pixels)
            if best_dist > 8 || best_idx.is_none() {
                break;
            }

            let idx = best_idx.unwrap();
            let next = remaining.remove(idx);
            contour.push((next.0 as f32, next.1 as f32));
        }

        // Only keep contours with at least 3 points
        if contour.len() >= 3 {
            contours.push(contour);
        }
    }

    contours
}

/// Ramer-Douglas-Peucker path simplification
fn rdp_simplify(points: &[(f32, f32)], epsilon: f32) -> Vec<(f32, f32)> {
    if points.len() < 3 {
        return points.to_vec();
    }

    let mut result = rdp_recursive(points, epsilon);

    // Ensure the path is closed
    if let (Some(first), Some(last)) = (result.first(), result.last()) {
        let dx = first.0 - last.0;
        let dy = first.1 - last.1;
        if dx * dx + dy * dy > epsilon * epsilon {
            result.push(*first);
        }
    }

    result
}

fn rdp_recursive(points: &[(f32, f32)], epsilon: f32) -> Vec<(f32, f32)> {
    if points.len() < 3 {
        return points.to_vec();
    }

    let first = points[0];
    let last = points[points.len() - 1];

    let mut max_dist = 0.0f32;
    let mut max_idx = 0;

    for (i, p) in points.iter().enumerate().skip(1).take(points.len() - 2) {
        let dist = point_line_distance(*p, first, last);
        if dist > max_dist {
            max_dist = dist;
            max_idx = i;
        }
    }

    if max_dist > epsilon {
        let mut left = rdp_recursive(&points[..=max_idx], epsilon);
        let right = rdp_recursive(&points[max_idx..], epsilon);
        left.pop();
        left.extend(right);
        left
    } else {
        vec![first, last]
    }
}

fn point_line_distance(p: (f32, f32), line_start: (f32, f32), line_end: (f32, f32)) -> f32 {
    let dx = line_end.0 - line_start.0;
    let dy = line_end.1 - line_start.1;
    let len_sq = dx * dx + dy * dy;

    if len_sq < 1e-10 {
        let px = p.0 - line_start.0;
        let py = p.1 - line_start.1;
        return (px * px + py * py).sqrt();
    }

    let cross = (p.0 - line_start.0) * dy - (p.1 - line_start.1) * dx;
    cross.abs() / len_sq.sqrt()
}

/// Cursor bounds for proper scaling
#[derive(Debug, Clone)]
pub struct CursorBounds {
    pub width: f32,
    pub height: f32,
}

/// Generate cursor data from grayscale image
pub fn generate_cursor_data(img: &GrayscaleImage) -> (Option<String>, Option<CursorBounds>) {
    let path = extract_cursor_outline(img, 128);
    let bounds = if path.is_some() {
        Some(CursorBounds {
            width: img.width as f32,
            height: img.height as f32,
        })
    } else {
        None
    };
    (path, bounds)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_extract_simple_square() {
        #[rustfmt::skip]
        let data = vec![
            0,   0,   0,   0,   0,   0,
            0,   255, 255, 255, 255, 0,
            0,   255, 255, 255, 255, 0,
            0,   255, 255, 255, 255, 0,
            0,   255, 255, 255, 255, 0,
            0,   0,   0,   0,   0,   0,
        ];
        let img = GrayscaleImage::new(6, 6, data);
        let result = extract_cursor_outline(&img, 128);
        assert!(result.is_some(), "Should extract outline from square");
        let path = result.unwrap();
        assert!(path.starts_with('M'), "Path should start with M");
        assert!(path.contains('Z'), "Path should contain Z");
    }

    #[test]
    fn test_empty_image() {
        let img = GrayscaleImage::new(4, 4, vec![0; 16]);
        let result = extract_cursor_outline(&img, 128);
        assert!(result.is_none(), "Empty image should return None");
    }

    #[test]
    fn test_full_image() {
        let img = GrayscaleImage::new(4, 4, vec![255; 16]);
        let result = extract_cursor_outline(&img, 128);
        assert!(result.is_some(), "Full image should have edge outline");
    }

    #[test]
    fn test_disconnected_regions() {
        #[rustfmt::skip]
        let data = vec![
            255, 255, 0, 0, 255, 255,
            255, 255, 0, 0, 255, 255,
            0,   0,   0, 0, 0,   0,
            0,   0,   0, 0, 0,   0,
            255, 255, 0, 0, 255, 255,
            255, 255, 0, 0, 255, 255,
        ];
        let img = GrayscaleImage::new(6, 6, data);
        let result = extract_cursor_outline(&img, 128);
        assert!(result.is_some(), "Should extract from disconnected regions");
        let path = result.unwrap();
        let z_count = path.matches('Z').count();
        assert!(
            z_count >= 2,
            "Should have multiple subpaths, got {}",
            z_count
        );
    }

    #[test]
    fn test_star_shape() {
        #[rustfmt::skip]
        let data = vec![
            0,   0,   255, 0,   0,
            0,   255, 255, 255, 0,
            255, 255, 255, 255, 255,
            0,   255, 255, 255, 0,
            0,   0,   255, 0,   0,
        ];
        let img = GrayscaleImage::new(5, 5, data);
        let result = extract_cursor_outline(&img, 128);
        assert!(result.is_some(), "Should extract outline from star shape");
    }
}
