//! Cursor outline extraction for brush textures
//!
//! Uses Marching Squares algorithm to extract clean, ordered contours.
//! Supports multiple disconnected contours (like Krita's KisOutlineGenerator).
//! The generated paths are used for cursor display in the frontend.

use std::collections::HashMap;

use super::types::GrayscaleImage;

/// Quantization scale for point hashing (1/32 pixel precision)
const QUANT_SCALE: f32 = 32.0;

/// Extract contour outlines from grayscale texture using Marching Squares.
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

    let orig_w = img.width as usize;
    let orig_h = img.height as usize;

    // Add 2px padding around the image to ensure edge-touching textures
    // can be properly detected by Marching Squares algorithm
    let w = orig_w + 4;
    let h = orig_h + 4;

    // Build padded binary grid (padding is false/transparent)
    let mut binary: Vec<bool> = vec![false; w * h];
    for y in 0..orig_h {
        for x in 0..orig_w {
            let src_idx = y * orig_w + x;
            let dst_idx = (y + 2) * w + (x + 2);
            binary[dst_idx] = img.data[src_idx] >= threshold;
        }
    }

    // Extract contours using Marching Squares with HashMap-based assembly
    let contours = marching_squares_with_assembly(&binary, w, h);
    if contours.is_empty() {
        return None;
    }

    // Convert to SVG path with multiple subpaths
    // Use original dimensions for normalization, offset by padding
    let max_dim = (orig_w.max(orig_h)) as f32;
    let center_x = orig_w as f32 / 2.0 + 2.0; // +2 for padding offset
    let center_y = orig_h as f32 / 2.0 + 2.0;

    let mut svg_path = String::new();

    for contour in contours {
        if contour.len() < 3 {
            continue;
        }

        // Simplify then smooth
        let simplified = rdp_simplify(&contour, 0.5);
        if simplified.len() < 3 {
            continue;
        }

        let smoothed = chaikin_smooth(&simplified, 2);
        if smoothed.len() < 3 {
            continue;
        }

        // Append subpath
        for (i, (x, y)) in smoothed.iter().enumerate() {
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

// ============================================================================
// Marching Squares Algorithm with HashMap-based Assembly
// ============================================================================

/// A segment is a line between two points on cell edges
#[derive(Clone, Copy, Debug)]
struct Segment {
    p0: (f32, f32),
    p1: (f32, f32),
}

/// Quantize a point for HashMap lookup
#[inline]
fn quantize_point(p: (f32, f32)) -> (i32, i32) {
    (
        (p.0 * QUANT_SCALE).round() as i32,
        (p.1 * QUANT_SCALE).round() as i32,
    )
}

/// Marching Squares lookup table for edge configurations
/// Each cell has 4 corners: TL(8), TR(4), BR(2), BL(1)
/// Edge indices: Top=0, Right=1, Bottom=2, Left=3
const MS_EDGES: [[i8; 4]; 16] = [
    [-1, -1, -1, -1], // 0: empty
    [2, 3, -1, -1],   // 1: BL
    [1, 2, -1, -1],   // 2: BR
    [1, 3, -1, -1],   // 3: BL+BR
    [0, 1, -1, -1],   // 4: TR
    [0, 3, 1, 2],     // 5: TR+BL (saddle) - connect 0-3, 1-2
    [0, 2, -1, -1],   // 6: TR+BR
    [0, 3, -1, -1],   // 7: TR+BR+BL
    [0, 3, -1, -1],   // 8: TL
    [0, 2, -1, -1],   // 9: TL+BL
    [0, 1, 2, 3],     // 10: TL+BR (saddle) - connect 0-1, 2-3
    [0, 1, -1, -1],   // 11: TL+BL+BR
    [1, 3, -1, -1],   // 12: TL+TR
    [1, 2, -1, -1],   // 13: TL+TR+BL
    [2, 3, -1, -1],   // 14: TL+TR+BR
    [-1, -1, -1, -1], // 15: full
];

/// Get edge midpoint for a cell
#[inline]
fn edge_point(cell_x: usize, cell_y: usize, edge: i8) -> (f32, f32) {
    let x = cell_x as f32;
    let y = cell_y as f32;
    match edge {
        0 => (x + 0.5, y),       // Top edge midpoint
        1 => (x + 1.0, y + 0.5), // Right edge midpoint
        2 => (x + 0.5, y + 1.0), // Bottom edge midpoint
        3 => (x, y + 0.5),       // Left edge midpoint
        _ => (x + 0.5, y + 0.5), // Center (shouldn't happen)
    }
}

/// Extract all segments from the grid, then assemble into contours
fn marching_squares_with_assembly(binary: &[bool], w: usize, h: usize) -> Vec<Vec<(f32, f32)>> {
    let grid_w = w - 1;
    let grid_h = h - 1;

    // Step 1: Generate all segments
    let mut segments: Vec<Segment> = Vec::new();

    for cy in 0..grid_h {
        for cx in 0..grid_w {
            let tl = binary[cy * w + cx] as u8;
            let tr = binary[cy * w + cx + 1] as u8;
            let bl = binary[(cy + 1) * w + cx] as u8;
            let br = binary[(cy + 1) * w + cx + 1] as u8;
            let case = (tl << 3) | (tr << 2) | (br << 1) | bl;

            if case == 0 || case == 15 {
                continue;
            }

            let edges = MS_EDGES[case as usize];

            // First segment
            if edges[0] >= 0 && edges[1] >= 0 {
                let p0 = edge_point(cx, cy, edges[0]);
                let p1 = edge_point(cx, cy, edges[1]);
                segments.push(Segment { p0, p1 });
            }

            // Second segment (saddle cases only)
            if edges[2] >= 0 && edges[3] >= 0 {
                let p0 = edge_point(cx, cy, edges[2]);
                let p1 = edge_point(cx, cy, edges[3]);
                segments.push(Segment { p0, p1 });
            }
        }
    }

    if segments.is_empty() {
        return Vec::new();
    }

    // Step 2: Build adjacency map using quantized points
    // Map from quantized point -> list of (segment_index, is_p0)
    let mut adjacency: HashMap<(i32, i32), Vec<(usize, bool)>> = HashMap::new();

    for (seg_idx, seg) in segments.iter().enumerate() {
        let q0 = quantize_point(seg.p0);
        let q1 = quantize_point(seg.p1);

        adjacency.entry(q0).or_default().push((seg_idx, true));
        adjacency.entry(q1).or_default().push((seg_idx, false));
    }

    // Step 3: Assemble contours by following connected segments
    let mut used = vec![false; segments.len()];
    let mut contours = Vec::new();

    for start_idx in 0..segments.len() {
        if used[start_idx] {
            continue;
        }

        let mut contour = Vec::new();
        let mut current_idx = start_idx;
        let mut at_p1 = true; // Start by adding p0, then move towards p1

        // Add first segment's p0
        contour.push(segments[current_idx].p0);

        loop {
            if used[current_idx] {
                break;
            }
            used[current_idx] = true;

            let seg = &segments[current_idx];
            let current_point = if at_p1 { seg.p1 } else { seg.p0 };
            contour.push(current_point);

            // Find next segment connected at current_point
            let q = quantize_point(current_point);
            let neighbors = match adjacency.get(&q) {
                Some(n) => n,
                None => break,
            };

            // Find an unused neighbor
            let mut found_next = false;
            for &(neighbor_idx, is_p0) in neighbors {
                if neighbor_idx != current_idx && !used[neighbor_idx] {
                    current_idx = neighbor_idx;
                    // If we entered at p0, we exit at p1; if entered at p1, we exit at p0
                    at_p1 = is_p0;
                    found_next = true;
                    break;
                }
            }

            if !found_next {
                break;
            }
        }

        if contour.len() >= 3 {
            contours.push(contour);
        }
    }

    contours
}

// ============================================================================
// Chaikin Smoothing Algorithm with Corner Preservation
// ============================================================================

/// Calculate angle at point p1 formed by p0-p1-p2 (in degrees)
fn calculate_angle(p0: (f32, f32), p1: (f32, f32), p2: (f32, f32)) -> f32 {
    let v1 = (p0.0 - p1.0, p0.1 - p1.1);
    let v2 = (p2.0 - p1.0, p2.1 - p1.1);

    let dot = v1.0 * v2.0 + v1.1 * v2.1;
    let len1 = (v1.0 * v1.0 + v1.1 * v1.1).sqrt();
    let len2 = (v2.0 * v2.0 + v2.1 * v2.1).sqrt();

    if len1 < 1e-6 || len2 < 1e-6 {
        return 180.0; // Degenerate case, treat as straight
    }

    let cos_angle = (dot / (len1 * len2)).clamp(-1.0, 1.0);
    cos_angle.acos().to_degrees()
}

/// Apply Chaikin's corner cutting algorithm with sharp corner preservation
fn chaikin_smooth(points: &[(f32, f32)], iterations: usize) -> Vec<(f32, f32)> {
    if points.len() < 3 || iterations == 0 {
        return points.to_vec();
    }

    let mut result = points.to_vec();

    for _ in 0..iterations {
        let n = result.len();
        let mut smoothed = Vec::with_capacity(n * 2);

        for i in 0..n {
            let p_prev = result[(i + n - 1) % n];
            let p_curr = result[i];
            let p_next = result[(i + 1) % n];

            // Calculate angle at current point
            let angle = calculate_angle(p_prev, p_curr, p_next);

            // If angle is sharp (< 100 degrees), preserve the corner
            // This protects diamond tips and other sharp geometric features
            if angle < 100.0 {
                smoothed.push(p_curr);
            } else {
                // Normal Chaikin corner cutting
                // Q = 0.75 * P_curr + 0.25 * P_next
                smoothed.push((
                    0.75 * p_curr.0 + 0.25 * p_next.0,
                    0.75 * p_curr.1 + 0.25 * p_next.1,
                ));
                // R = 0.25 * P_curr + 0.75 * P_next
                smoothed.push((
                    0.25 * p_curr.0 + 0.75 * p_next.0,
                    0.25 * p_curr.1 + 0.75 * p_next.1,
                ));
            }
        }

        result = smoothed;
    }

    result
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
    let bounds = path.as_ref().map(|_| CursorBounds {
        width: img.width as f32,
        height: img.height as f32,
    });
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
        // With 1px padding, a fully filled image now has detectable boundaries
        // because the padding creates the filled-to-empty transition
        let img = GrayscaleImage::new(4, 4, vec![255; 16]);
        let result = extract_cursor_outline(&img, 128);
        assert!(
            result.is_some(),
            "Full image should have outline with padding"
        );
        let path = result.unwrap();
        assert!(path.starts_with('M'), "Path should start with M");
        assert!(path.contains('Z'), "Path should be closed");
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
