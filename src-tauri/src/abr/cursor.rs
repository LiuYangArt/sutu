//! Cursor outline extraction for brush textures
//!
//! Extracts SVG path outlines from brush textures using boundary tracing.
//! The generated paths are used for cursor display in the frontend.

use super::types::GrayscaleImage;

/// Extract contour outline from grayscale texture using boundary tracing.
/// Returns SVG path data normalized to 0-1 coordinates, centered at origin.
///
/// # Arguments
/// * `img` - Grayscale image data
/// * `threshold` - Alpha threshold for edge detection (0-255, typically 128)
///
/// # Returns
/// SVG path string in format "M x y L x y ... Z" or None if extraction fails
pub fn extract_cursor_outline(img: &GrayscaleImage, threshold: u8) -> Option<String> {
    if img.width < 2 || img.height < 2 || img.data.is_empty() {
        return None;
    }

    // Step 1: Find boundary pixels
    let boundary = find_boundary_pixels(img, threshold);
    if boundary.len() < 3 {
        return None;
    }

    // Step 2: Order boundary pixels into a contour
    let contour = order_boundary_pixels(&boundary, img.width, img.height);
    if contour.len() < 3 {
        return None;
    }

    // Step 3: Simplify path using Ramer-Douglas-Peucker algorithm
    let simplified = rdp_simplify(&contour, 1.0);
    if simplified.len() < 3 {
        return None;
    }

    // Step 4: Normalize coordinates to 0-1 range, centered at origin
    let path = normalize_to_svg_path(&simplified, img.width, img.height);

    Some(path)
}

/// Find all boundary pixels (pixels above threshold with at least one neighbor below)
fn find_boundary_pixels(img: &GrayscaleImage, threshold: u8) -> Vec<(usize, usize)> {
    let w = img.width as usize;
    let h = img.height as usize;
    let mut boundary = Vec::new();

    for y in 0..h {
        for x in 0..w {
            let idx = y * w + x;
            let val = img.data[idx];

            if val >= threshold {
                // Check if this is a boundary pixel
                let is_boundary = is_boundary_pixel(img, x, y, threshold);
                if is_boundary {
                    boundary.push((x, y));
                }
            }
        }
    }

    boundary
}

/// Check if a pixel is on the boundary (has at least one neighbor below threshold or is at image edge)
fn is_boundary_pixel(img: &GrayscaleImage, x: usize, y: usize, threshold: u8) -> bool {
    let w = img.width as usize;
    let h = img.height as usize;
    let idx = y * w + x;

    // Only check pixels that are above threshold
    if img.data[idx] < threshold {
        return false;
    }

    // Check 4-connected neighbors - if any is below threshold or out of bounds, this is boundary
    let neighbors: [(i32, i32); 4] = [(-1, 0), (1, 0), (0, -1), (0, 1)];

    for (dx, dy) in neighbors {
        let nx = x as i32 + dx;
        let ny = y as i32 + dy;

        // Out of bounds = boundary
        if nx < 0 || ny < 0 || nx >= w as i32 || ny >= h as i32 {
            return true;
        }

        let nidx = ny as usize * w + nx as usize;
        if img.data[nidx] < threshold {
            return true;
        }
    }

    false
}

/// Order boundary pixels into a continuous contour using nearest-neighbor chain
fn order_boundary_pixels(
    boundary: &[(usize, usize)],
    _width: u32,
    _height: u32,
) -> Vec<(f32, f32)> {
    if boundary.is_empty() {
        return Vec::new();
    }

    let mut remaining: Vec<(usize, usize)> = boundary.to_vec();
    let mut contour = Vec::with_capacity(remaining.len());

    // Start from the topmost-leftmost point
    remaining.sort_by(|a, b| a.1.cmp(&b.1).then(a.0.cmp(&b.0)));
    let start = remaining.remove(0);
    contour.push((start.0 as f32, start.1 as f32));

    // Greedily connect nearest neighbors
    while !remaining.is_empty() {
        let last = contour.last().unwrap();
        let last_x = last.0 as i32;
        let last_y = last.1 as i32;

        // Find nearest unvisited boundary pixel
        let mut best_idx = 0;
        let mut best_dist = i32::MAX;

        for (i, &(px, py)) in remaining.iter().enumerate() {
            let dx = px as i32 - last_x;
            let dy = py as i32 - last_y;
            let dist = dx * dx + dy * dy;

            if dist < best_dist {
                best_dist = dist;
                best_idx = i;
            }
        }

        // If the nearest point is too far (gap in contour), stop
        if best_dist > 8 {
            // sqrt(8) ≈ 2.83 pixels
            break;
        }

        let next = remaining.remove(best_idx);
        contour.push((next.0 as f32, next.1 as f32));
    }

    contour
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

    // Find point with maximum distance from line
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
        // Recursively simplify
        let mut left = rdp_recursive(&points[..=max_idx], epsilon);
        let right = rdp_recursive(&points[max_idx..], epsilon);

        left.pop(); // Remove duplicate point
        left.extend(right);
        left
    } else {
        // Keep only endpoints
        vec![first, last]
    }
}

/// Calculate perpendicular distance from point to line
fn point_line_distance(p: (f32, f32), line_start: (f32, f32), line_end: (f32, f32)) -> f32 {
    let dx = line_end.0 - line_start.0;
    let dy = line_end.1 - line_start.1;
    let len_sq = dx * dx + dy * dy;

    if len_sq < 1e-10 {
        // Line is essentially a point
        let px = p.0 - line_start.0;
        let py = p.1 - line_start.1;
        return (px * px + py * py).sqrt();
    }

    // Calculate perpendicular distance using cross product
    let cross = (p.0 - line_start.0) * dy - (p.1 - line_start.1) * dx;
    cross.abs() / len_sq.sqrt()
}

/// Convert contour points to normalized SVG path string
fn normalize_to_svg_path(points: &[(f32, f32)], width: u32, height: u32) -> String {
    if points.is_empty() {
        return String::new();
    }

    let w = width as f32;
    let h = height as f32;
    let max_dim = w.max(h);

    // Calculate center of the image
    let center_x = w / 2.0;
    let center_y = h / 2.0;

    // Normalize to -0.5 to 0.5 range, centered at image center
    let mut path = String::with_capacity(points.len() * 20);

    for (i, (x, y)) in points.iter().enumerate() {
        // Offset by center, then normalize by max dimension
        let nx = (x - center_x) / max_dim;
        let ny = (y - center_y) / max_dim;

        if i == 0 {
            path.push_str(&format!("M {:.3} {:.3}", nx, ny));
        } else {
            path.push_str(&format!(" L {:.3} {:.3}", nx, ny));
        }
    }

    path.push_str(" Z");
    path
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
        // 6x6 image with a 4x4 white square in center (larger for better contour)
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
        assert!(path.ends_with('Z'), "Path should end with Z");
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
        // Full image should produce outline at edges
        assert!(result.is_some(), "Full image should have edge outline");
    }

    #[test]
    fn test_single_pixel() {
        // Single bright pixel in center
        #[rustfmt::skip]
        let data = vec![
            0, 0, 0,
            0, 255, 0,
            0, 0, 0,
        ];
        let img = GrayscaleImage::new(3, 3, data);
        let result = extract_cursor_outline(&img, 128);
        // Single pixel can't form a valid contour (need at least 3 points)
        // This may or may not succeed depending on implementation
        // Just ensure it doesn't panic
        let _ = result;
    }
}
