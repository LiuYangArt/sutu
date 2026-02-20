use std::collections::HashMap;

use super::types::{CursorComplexityData, GrayscaleImage};

/// Quantization scale for point hashing (1/32 pixel precision)
const QUANT_SCALE: f32 = 32.0;
const QUALITY_AREA_DEVIATION_LIMIT: f32 = 0.08;
const QUALITY_CENTER_DRIFT_LIMIT_PX: f32 = 1.0;
const QUALITY_ASPECT_RATIO_DEVIATION_LIMIT: f32 = 0.20;

pub const DEFAULT_LOD0_PATH_LEN_SOFT_LIMIT: usize = 160_000;
pub const DEFAULT_LOD1_PATH_LEN_LIMIT: usize = 60_000;
pub const DEFAULT_LOD2_PATH_LEN_LIMIT: usize = 8_000;

const LOD1_SEGMENT_LIMIT: usize = 3_200;
const LOD1_CONTOUR_LIMIT: usize = 128;
const LOD2_SEGMENT_LIMIT: usize = 256;
const LOD2_CONTOUR_LIMIT: usize = 6;
const LOD0_CONTOUR_LIMIT: usize = 192;

#[derive(Debug, Clone, Copy)]
pub struct CursorLodPathLenLimits {
    pub lod0_path_len_soft_limit: usize,
    pub lod1_path_len_limit: usize,
    pub lod2_path_len_limit: usize,
}

impl Default for CursorLodPathLenLimits {
    fn default() -> Self {
        Self {
            lod0_path_len_soft_limit: DEFAULT_LOD0_PATH_LEN_SOFT_LIMIT,
            lod1_path_len_limit: DEFAULT_LOD1_PATH_LEN_LIMIT,
            lod2_path_len_limit: DEFAULT_LOD2_PATH_LEN_LIMIT,
        }
    }
}

#[derive(Debug, Clone)]
pub struct CursorLodData {
    pub path_lod0: Option<String>,
    pub path_lod1: Option<String>,
    pub path_lod2: Option<String>,
    pub complexity_lod0: Option<CursorComplexityData>,
    pub complexity_lod1: Option<CursorComplexityData>,
    pub complexity_lod2: Option<CursorComplexityData>,
    pub bounds: Option<CursorBounds>,
}

impl CursorLodData {
    fn empty() -> Self {
        Self {
            path_lod0: None,
            path_lod1: None,
            path_lod2: None,
            complexity_lod0: None,
            complexity_lod1: None,
            complexity_lod2: None,
            bounds: None,
        }
    }
}

#[derive(Debug, Clone, Copy)]
struct NormalizationContext {
    center_x: f32,
    center_y: f32,
    max_dim: f32,
}

#[derive(Debug, Clone, Copy)]
struct QualitySignature {
    area: f32,
    center_x: f32,
    center_y: f32,
    aspect_ratio: f32,
}

#[derive(Debug, Clone)]
struct LodCandidate {
    path: String,
    complexity: CursorComplexityData,
    signature: QualitySignature,
}

pub fn extract_cursor_outline(img: &GrayscaleImage, threshold: u8) -> Option<String> {
    if img.width < 2 || img.height < 2 || img.data.is_empty() {
        return None;
    }

    let orig_w = img.width as usize;
    let orig_h = img.height as usize;

    let w = orig_w + 4;
    let h = orig_h + 4;

    let mut binary: Vec<bool> = vec![false; w * h];
    for y in 0..orig_h {
        for x in 0..orig_w {
            let src_idx = y * orig_w + x;
            let dst_idx = (y + 2) * w + (x + 2);
            binary[dst_idx] = img.data[src_idx] >= threshold;
        }
    }

    let contours = marching_squares_with_assembly(&binary, w, h);
    if contours.is_empty() {
        return None;
    }

    let max_dim = (orig_w.max(orig_h)) as f32;
    let center_x = orig_w as f32 / 2.0 + 2.0; // +2 for padding offset
    let center_y = orig_h as f32 / 2.0 + 2.0;

    let mut svg_path = String::new();

    for contour in contours {
        if contour.len() < 3 {
            continue;
        }

        let simplified = rdp_simplify(&contour, 0.5);
        if simplified.len() < 3 {
            continue;
        }

        let smoothed = chaikin_smooth(&simplified, 2);
        if smoothed.len() < 3 {
            continue;
        }

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

#[derive(Debug, Clone, Copy)]
enum SimplifyAlgorithm {
    Rdp,
}

fn simplify_contour(
    points: &[(f32, f32)],
    epsilon: f32,
    _algorithm: SimplifyAlgorithm,
) -> Vec<(f32, f32)> {
    rdp_simplify(points, epsilon)
}

#[inline]
fn to_u32_saturating(value: usize) -> u32 {
    value.min(u32::MAX as usize) as u32
}

fn normalization_context_for_image(img: &GrayscaleImage) -> NormalizationContext {
    let max_dim = (img.width.max(img.height) as f32).max(1.0);
    NormalizationContext {
        center_x: img.width as f32 / 2.0 + 2.0,
        center_y: img.height as f32 / 2.0 + 2.0,
        max_dim,
    }
}

fn extract_raw_contours(img: &GrayscaleImage, threshold: u8) -> Vec<Vec<(f32, f32)>> {
    if img.width < 2 || img.height < 2 || img.data.is_empty() {
        return Vec::new();
    }

    let orig_w = img.width as usize;
    let orig_h = img.height as usize;
    let w = orig_w + 4;
    let h = orig_h + 4;

    let mut binary: Vec<bool> = vec![false; w * h];
    for y in 0..orig_h {
        for x in 0..orig_w {
            let src_idx = y * orig_w + x;
            let dst_idx = (y + 2) * w + (x + 2);
            binary[dst_idx] = img.data[src_idx] >= threshold;
        }
    }

    let contours = marching_squares_with_assembly(&binary, w, h);
    let mut sanitized = Vec::new();
    for contour in contours {
        let normalized = sanitize_contour_points(&contour, 0.05);
        if normalized.len() >= 3 {
            sanitized.push(normalized);
        }
    }

    sort_contours_by_area_desc(&mut sanitized);
    sanitized
}

fn build_lod_base_contours(contours: &[Vec<(f32, f32)>]) -> Vec<Vec<(f32, f32)>> {
    let mut prepared = Vec::new();
    for contour in contours {
        let simplified = sanitize_contour_points(&rdp_simplify(contour, 0.5), 0.05);
        if simplified.len() < 3 {
            continue;
        }
        let smoothed = sanitize_contour_points(&chaikin_smooth(&simplified, 2), 0.05);
        if smoothed.len() < 3 {
            continue;
        }
        prepared.push(smoothed);
    }
    sort_contours_by_area_desc(&mut prepared);
    prepared
}

fn sanitize_contour_points(points: &[(f32, f32)], merge_epsilon: f32) -> Vec<(f32, f32)> {
    if points.len() < 3 {
        return points.to_vec();
    }

    let eps_sq = merge_epsilon * merge_epsilon;
    let mut cleaned: Vec<(f32, f32)> = Vec::with_capacity(points.len());

    for &point in points {
        if let Some(prev) = cleaned.last() {
            let dx = point.0 - prev.0;
            let dy = point.1 - prev.1;
            if dx * dx + dy * dy <= eps_sq {
                continue;
            }
        }
        cleaned.push(point);
    }

    if cleaned.len() >= 2 {
        let first = cleaned[0];
        let last = cleaned[cleaned.len() - 1];
        let dx = first.0 - last.0;
        let dy = first.1 - last.1;
        if dx * dx + dy * dy <= eps_sq {
            cleaned.pop();
        }
    }

    if cleaned.len() < 3 {
        return Vec::new();
    }

    cleaned
}

fn contour_area_abs(points: &[(f32, f32)]) -> f32 {
    if points.len() < 3 {
        return 0.0;
    }

    let mut twice_area = 0.0f32;
    for i in 0..points.len() {
        let (x0, y0) = points[i];
        let (x1, y1) = points[(i + 1) % points.len()];
        twice_area += x0 * y1 - x1 * y0;
    }

    (twice_area * 0.5).abs()
}

fn contour_segment_count(points: &[(f32, f32)]) -> usize {
    if points.len() < 2 {
        return 0;
    }
    points.len()
}

fn sort_contours_by_area_desc(contours: &mut [Vec<(f32, f32)>]) {
    contours.sort_by(|left, right| {
        contour_area_abs(right)
            .partial_cmp(&contour_area_abs(left))
            .unwrap_or(std::cmp::Ordering::Equal)
    });
}

fn quality_signature_for_contours(contours: &[Vec<(f32, f32)>]) -> Option<QualitySignature> {
    if contours.is_empty() {
        return None;
    }

    let mut min_x = f32::INFINITY;
    let mut min_y = f32::INFINITY;
    let mut max_x = f32::NEG_INFINITY;
    let mut max_y = f32::NEG_INFINITY;
    let mut area_sum = 0.0f32;
    let mut has_point = false;

    for contour in contours {
        if contour.len() < 3 {
            continue;
        }
        area_sum += contour_area_abs(contour);
        for &(x, y) in contour {
            has_point = true;
            min_x = min_x.min(x);
            min_y = min_y.min(y);
            max_x = max_x.max(x);
            max_y = max_y.max(y);
        }
    }

    if !has_point {
        return None;
    }

    let width = (max_x - min_x).max(1e-3);
    let height = (max_y - min_y).max(1e-3);

    Some(QualitySignature {
        area: area_sum.max(1e-3),
        center_x: (min_x + max_x) * 0.5,
        center_y: (min_y + max_y) * 0.5,
        aspect_ratio: width / height,
    })
}

fn quality_gate_passed(reference: &QualitySignature, candidate: &QualitySignature) -> bool {
    let area_deviation = ((candidate.area - reference.area).abs() / reference.area).max(0.0);
    if area_deviation > QUALITY_AREA_DEVIATION_LIMIT {
        return false;
    }

    let center_dx = candidate.center_x - reference.center_x;
    let center_dy = candidate.center_y - reference.center_y;
    let center_drift = (center_dx * center_dx + center_dy * center_dy).sqrt();
    if center_drift > QUALITY_CENTER_DRIFT_LIMIT_PX {
        return false;
    }

    let aspect_ratio_deviation = (candidate.aspect_ratio - reference.aspect_ratio).abs();
    if aspect_ratio_deviation > QUALITY_ASPECT_RATIO_DEVIATION_LIMIT {
        return false;
    }

    true
}

fn quality_distance(reference: &QualitySignature, candidate: &QualitySignature) -> f32 {
    let area_deviation = ((candidate.area - reference.area).abs() / reference.area).max(0.0);
    let center_dx = candidate.center_x - reference.center_x;
    let center_dy = candidate.center_y - reference.center_y;
    let center_drift = (center_dx * center_dx + center_dy * center_dy).sqrt();
    let aspect_ratio_deviation = (candidate.aspect_ratio - reference.aspect_ratio).abs();

    (area_deviation / QUALITY_AREA_DEVIATION_LIMIT)
        + (center_drift / QUALITY_CENTER_DRIFT_LIMIT_PX)
        + (aspect_ratio_deviation / QUALITY_ASPECT_RATIO_DEVIATION_LIMIT)
}

fn should_replace_with_more_similar(
    current: Option<&LodCandidate>,
    candidate: &LodCandidate,
    reference: &QualitySignature,
    prefer_detail_on_tie: bool,
) -> bool {
    let Some(existing) = current else {
        return true;
    };

    let existing_score = quality_distance(reference, &existing.signature);
    let candidate_score = quality_distance(reference, &candidate.signature);

    if candidate_score + 1e-4 < existing_score {
        return true;
    }
    if existing_score + 1e-4 < candidate_score {
        return false;
    }

    if prefer_detail_on_tie {
        candidate.complexity.path_len > existing.complexity.path_len
    } else {
        candidate.complexity.path_len < existing.complexity.path_len
    }
}

fn contour_perimeter(points: &[(f32, f32)]) -> f32 {
    if points.len() < 2 {
        return 0.0;
    }

    let mut perimeter = 0.0f32;
    for i in 0..points.len() {
        let p0 = points[i];
        let p1 = points[(i + 1) % points.len()];
        let dx = p1.0 - p0.0;
        let dy = p1.1 - p0.1;
        perimeter += (dx * dx + dy * dy).sqrt();
    }
    perimeter
}

fn contour_importance_score(points: &[(f32, f32)]) -> f32 {
    let perimeter = contour_perimeter(points);
    let area_term = contour_area_abs(points).sqrt();
    perimeter + area_term * 0.5
}

fn select_contours_by_importance(
    contours: &[Vec<(f32, f32)>],
    max_contours: usize,
    min_relative_score: f32,
    min_coverage_ratio: f32,
) -> Vec<Vec<(f32, f32)>> {
    if contours.is_empty() {
        return Vec::new();
    }

    let mut scored: Vec<(usize, f32)> = contours
        .iter()
        .enumerate()
        .map(|(idx, contour)| (idx, contour_importance_score(contour)))
        .collect();
    scored.sort_by(|left, right| {
        right
            .1
            .partial_cmp(&left.1)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    let total_score: f32 = scored
        .iter()
        .map(|(_, score)| *score)
        .sum::<f32>()
        .max(1e-6);
    let max_score = scored.first().map(|(_, score)| *score).unwrap_or(0.0);
    let relative_threshold = max_score * min_relative_score.max(0.0);
    let mut cumulative_score = 0.0f32;
    let mut selected_indices = Vec::new();
    let max_keep = max_contours.max(1);
    let target_coverage = min_coverage_ratio.clamp(0.0, 1.0);

    for (rank, (idx, score)) in scored.iter().enumerate() {
        if rank >= max_keep {
            break;
        }

        let keep_by_score = *score >= relative_threshold;
        let coverage_ratio = cumulative_score / total_score;
        let keep_for_coverage = coverage_ratio < target_coverage;
        if rank == 0 || keep_by_score || keep_for_coverage {
            selected_indices.push(*idx);
            cumulative_score += *score;
        }
    }

    if selected_indices.is_empty() {
        selected_indices.push(scored[0].0);
    }

    let mut selected = selected_indices
        .into_iter()
        .map(|idx| contours[idx].clone())
        .collect::<Vec<_>>();
    sort_contours_by_area_desc(&mut selected);
    selected
}

fn filter_tiny_contours_for_lod(
    contours: &[Vec<(f32, f32)>],
    min_area_ratio: f32,
    min_score_ratio: f32,
) -> Vec<Vec<(f32, f32)>> {
    if contours.is_empty() {
        return Vec::new();
    }

    let mut metrics: Vec<(usize, f32, f32)> = contours
        .iter()
        .enumerate()
        .map(|(idx, contour)| {
            (
                idx,
                contour_area_abs(contour),
                contour_importance_score(contour),
            )
        })
        .collect();
    metrics.sort_by(|left, right| {
        right
            .1
            .partial_cmp(&left.1)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    let max_area = metrics.first().map(|(_, area, _)| *area).unwrap_or(0.0);
    let max_score = metrics.first().map(|(_, _, score)| *score).unwrap_or(0.0);
    let area_floor = (max_area * min_area_ratio.max(0.0)).max(0.35);
    let score_floor = (max_score * min_score_ratio.max(0.0)).max(0.35);

    let mut kept_indices = Vec::new();
    for (rank, (idx, area, score)) in metrics.iter().enumerate() {
        if rank == 0 || *area >= area_floor || *score >= score_floor {
            kept_indices.push(*idx);
        }
    }

    if kept_indices.is_empty() {
        kept_indices.push(metrics[0].0);
    }

    let mut kept = kept_indices
        .into_iter()
        .map(|idx| contours[idx].clone())
        .collect::<Vec<_>>();
    sort_contours_by_area_desc(&mut kept);
    kept
}

fn build_keep_levels(max_keep: usize, min_keep: usize) -> Vec<usize> {
    let max_keep = max_keep.max(1);
    let min_keep = min_keep.max(1).min(max_keep);
    let mut levels = vec![max_keep];

    let candidates = [
        ((max_keep as f32) * 0.75).round() as usize,
        max_keep / 2,
        max_keep / 3,
        min_keep,
    ];

    for keep in candidates {
        let value = keep.clamp(min_keep, max_keep).max(1);
        if !levels.contains(&value) {
            levels.push(value);
        }
    }

    levels.sort_by(|a, b| b.cmp(a));
    levels
}

fn build_svg_path_from_contours(
    contours: &[Vec<(f32, f32)>],
    normalization: &NormalizationContext,
) -> Option<(String, CursorComplexityData)> {
    let mut svg_path = String::new();
    let mut segment_count = 0usize;
    let mut contour_count = 0usize;

    for contour in contours {
        if contour.len() < 3 {
            continue;
        }

        for (idx, (x, y)) in contour.iter().enumerate() {
            let nx = (x - normalization.center_x) / normalization.max_dim;
            let ny = (y - normalization.center_y) / normalization.max_dim;

            if idx == 0 {
                if !svg_path.is_empty() {
                    svg_path.push(' ');
                }
                svg_path.push_str(&format!("M {:.3} {:.3}", nx, ny));
            } else {
                svg_path.push_str(&format!(" L {:.3} {:.3}", nx, ny));
            }
        }
        svg_path.push_str(" Z");
        segment_count += contour_segment_count(contour);
        contour_count += 1;
    }

    if svg_path.is_empty() {
        return None;
    }

    Some((
        svg_path.clone(),
        CursorComplexityData {
            path_len: to_u32_saturating(svg_path.len()),
            segment_count: to_u32_saturating(segment_count),
            contour_count: to_u32_saturating(contour_count),
        },
    ))
}

fn build_lod_candidate(
    contours: Vec<Vec<(f32, f32)>>,
    normalization: &NormalizationContext,
) -> Option<LodCandidate> {
    let signature = quality_signature_for_contours(&contours)?;
    let (path, complexity) = build_svg_path_from_contours(&contours, normalization)?;
    Some(LodCandidate {
        path,
        complexity,
        signature,
    })
}

fn process_contours_for_lod(
    source: &[Vec<(f32, f32)>],
    epsilon: f32,
    smooth_iterations: usize,
    post_simplify_multiplier: Option<f32>,
    max_contours: usize,
    simplify_algorithm: SimplifyAlgorithm,
) -> Vec<Vec<(f32, f32)>> {
    let mut processed: Vec<Vec<(f32, f32)>> = Vec::new();
    let keep_contours = max_contours.max(1);

    for contour in source.iter().take(keep_contours) {
        let mut current = sanitize_contour_points(
            &simplify_contour(contour, epsilon, simplify_algorithm),
            0.05,
        );
        if current.len() < 3 {
            continue;
        }

        if smooth_iterations > 0 {
            current = sanitize_contour_points(&chaikin_smooth(&current, smooth_iterations), 0.05);
            if current.len() < 3 {
                continue;
            }
        }

        if let Some(multiplier) = post_simplify_multiplier {
            current = sanitize_contour_points(
                &simplify_contour(&current, epsilon * multiplier, simplify_algorithm),
                0.05,
            );
            if current.len() < 3 {
                continue;
            }
        }

        processed.push(current);
    }

    sort_contours_by_area_desc(&mut processed);
    processed
}

fn fits_lod_budget(
    complexity: &CursorComplexityData,
    path_len_limit: usize,
    segment_limit: Option<usize>,
    contour_limit: Option<usize>,
) -> bool {
    if complexity.path_len as usize > path_len_limit {
        return false;
    }
    if let Some(limit) = segment_limit {
        if complexity.segment_count as usize > limit {
            return false;
        }
    }
    if let Some(limit) = contour_limit {
        if complexity.contour_count as usize > limit {
            return false;
        }
    }
    true
}

fn build_bbox_ellipse_contour(
    contours: &[Vec<(f32, f32)>],
    segments: usize,
) -> Option<Vec<Vec<(f32, f32)>>> {
    if contours.is_empty() {
        return None;
    }

    let mut min_x = f32::INFINITY;
    let mut min_y = f32::INFINITY;
    let mut max_x = f32::NEG_INFINITY;
    let mut max_y = f32::NEG_INFINITY;
    let mut has_point = false;

    for contour in contours {
        for &(x, y) in contour {
            has_point = true;
            min_x = min_x.min(x);
            min_y = min_y.min(y);
            max_x = max_x.max(x);
            max_y = max_y.max(y);
        }
    }

    if !has_point {
        return None;
    }

    let width = (max_x - min_x).max(1.0);
    let height = (max_y - min_y).max(1.0);
    let center_x = (min_x + max_x) * 0.5;
    let center_y = (min_y + max_y) * 0.5;
    let radius_x = width * 0.5;
    let radius_y = height * 0.5;
    let segment_count = segments.max(8);

    let mut ellipse = Vec::with_capacity(segment_count);
    for idx in 0..segment_count {
        let t = (idx as f32 / segment_count as f32) * std::f32::consts::TAU;
        ellipse.push((center_x + radius_x * t.cos(), center_y + radius_y * t.sin()));
    }

    Some(vec![ellipse])
}

fn downsample_contour_uniform(points: &[(f32, f32)], target_points: usize) -> Vec<(f32, f32)> {
    if points.len() <= target_points {
        return points.to_vec();
    }
    let keep = target_points.max(3);
    let n = points.len();
    let mut sampled = Vec::with_capacity(keep);

    for i in 0..keep {
        let idx = ((i as f32) * (n as f32) / (keep as f32)).floor() as usize;
        sampled.push(points[idx.min(n - 1)]);
    }

    sanitize_contour_points(&sampled, 0.05)
}

fn force_fit_contours_by_sampling(
    source: &[Vec<(f32, f32)>],
    normalization: &NormalizationContext,
    path_len_limit: usize,
    segment_limit: usize,
    contour_limit: usize,
) -> Option<LodCandidate> {
    if source.is_empty() {
        return None;
    }

    let mut selected: Vec<Vec<(f32, f32)>> = source
        .iter()
        .take(contour_limit.max(1))
        .filter(|contour| contour.len() >= 3)
        .cloned()
        .collect();
    if selected.is_empty() {
        return None;
    }

    sort_contours_by_area_desc(&mut selected);
    let keep_count = selected.len();
    let min_segments_per_contour = 6usize;
    let min_total_segments = (keep_count * min_segments_per_contour).max(24);
    let importance: Vec<f32> = selected
        .iter()
        .map(|contour| contour_importance_score(contour).max(1e-3))
        .collect();
    let total_importance: f32 = importance.iter().sum::<f32>().max(1e-3);

    for ratio in [1.0f32, 0.8, 0.65, 0.5, 0.4, 0.3, 0.22] {
        let target_total_segments = ((segment_limit as f32) * ratio).round() as usize;
        let target_total_segments = target_total_segments.max(min_total_segments);

        let mut quotas = vec![min_segments_per_contour; keep_count];
        let remaining = target_total_segments.saturating_sub(min_total_segments);
        if remaining > 0 {
            for (idx, score) in importance.iter().enumerate() {
                let extra = ((remaining as f32) * (*score / total_importance)).round() as usize;
                quotas[idx] = quotas[idx].saturating_add(extra);
            }
        }

        let mut sampled_contours = Vec::with_capacity(keep_count);
        for (contour, quota) in selected.iter().zip(quotas.iter()) {
            let sampled = downsample_contour_uniform(contour, (*quota).max(3));
            if sampled.len() >= 3 {
                sampled_contours.push(sampled);
            }
        }
        if sampled_contours.is_empty() {
            continue;
        }

        if let Some(candidate) = build_lod_candidate(sampled_contours, normalization) {
            if fits_lod_budget(
                &candidate.complexity,
                path_len_limit,
                Some(segment_limit),
                Some(contour_limit),
            ) {
                return Some(candidate);
            }
        }
    }

    None
}

fn try_generate_lod0(
    contours: &[Vec<(f32, f32)>],
    normalization: &NormalizationContext,
    reference: &QualitySignature,
    path_len_soft_limit: usize,
) -> Option<LodCandidate> {
    let source = select_contours_by_importance(contours, LOD0_CONTOUR_LIMIT, 0.001, 0.995);
    let mut best_quality_any: Option<LodCandidate> = None;
    let mut best_fallback: Option<LodCandidate> = None;

    for step in 0..8 {
        let epsilon = 0.25 + step as f32 * 0.20;
        let processed = process_contours_for_lod(
            &source,
            epsilon,
            0,
            None,
            source.len(),
            SimplifyAlgorithm::Rdp,
        );
        let Some(candidate) = build_lod_candidate(processed, normalization) else {
            continue;
        };

        if should_replace_with_more_similar(best_fallback.as_ref(), &candidate, reference, true) {
            best_fallback = Some(candidate.clone());
        }

        if !quality_gate_passed(reference, &candidate.signature) {
            continue;
        }

        if should_replace_with_more_similar(best_quality_any.as_ref(), &candidate, reference, true)
        {
            best_quality_any = Some(candidate.clone());
        }

        if fits_lod_budget(&candidate.complexity, path_len_soft_limit, None, None) {
            return Some(candidate);
        }
    }

    best_quality_any.or(best_fallback)
}

fn try_generate_lod1(
    contours: &[Vec<(f32, f32)>],
    normalization: &NormalizationContext,
    reference: &QualitySignature,
    path_len_limit: usize,
) -> Option<LodCandidate> {
    let denoised = filter_tiny_contours_for_lod(contours, 0.00005, 0.002);
    let source = select_contours_by_importance(&denoised, LOD1_CONTOUR_LIMIT, 0.0001, 0.9995);
    let max_contours = source.len().max(1);
    let min_keep = if max_contours >= 48 {
        12
    } else if max_contours >= 24 {
        8
    } else if max_contours >= 10 {
        4
    } else {
        1
    };
    let keep_levels = build_keep_levels(max_contours, min_keep);
    let epsilons = [0.18f32, 0.28, 0.40, 0.60, 0.90, 1.30, 1.90];
    let mut best_quality_budget_candidate: Option<LodCandidate> = None;
    let mut budget_only_candidate: Option<LodCandidate> = None;
    let target_path_utilization = ((path_len_limit as f32) * 0.70) as usize;
    let target_segment_utilization = ((LOD1_SEGMENT_LIMIT as f32) * 0.85) as usize;

    for &keep in &keep_levels {
        for &epsilon in &epsilons {
            let processed =
                process_contours_for_lod(&source, epsilon, 0, None, keep, SimplifyAlgorithm::Rdp);
            let Some(candidate) = build_lod_candidate(processed, normalization) else {
                continue;
            };
            if (candidate.complexity.contour_count as usize) < min_keep {
                continue;
            }

            if !fits_lod_budget(
                &candidate.complexity,
                path_len_limit,
                Some(LOD1_SEGMENT_LIMIT),
                Some(LOD1_CONTOUR_LIMIT),
            ) {
                continue;
            }

            if quality_gate_passed(reference, &candidate.signature) {
                let path_len = candidate.complexity.path_len as usize;
                let segment_count = candidate.complexity.segment_count as usize;
                if path_len >= target_path_utilization
                    || segment_count >= target_segment_utilization
                {
                    return Some(candidate);
                }
                if should_replace_with_more_similar(
                    best_quality_budget_candidate.as_ref(),
                    &candidate,
                    reference,
                    true,
                ) {
                    best_quality_budget_candidate = Some(candidate.clone());
                }
            }

            if should_replace_with_more_similar(
                budget_only_candidate.as_ref(),
                &candidate,
                reference,
                true,
            ) {
                budget_only_candidate = Some(candidate);
            }
        }
    }

    if let Some(candidate) = best_quality_budget_candidate {
        return Some(candidate);
    }

    if let Some(candidate) = budget_only_candidate {
        return Some(candidate);
    }

    for segments in [96usize, 72, 56, 40, 32, 24, 16] {
        let Some(fallback_contours) = build_bbox_ellipse_contour(&source, segments) else {
            continue;
        };
        let Some(candidate) = build_lod_candidate(fallback_contours, normalization) else {
            continue;
        };
        if fits_lod_budget(
            &candidate.complexity,
            path_len_limit,
            Some(LOD1_SEGMENT_LIMIT),
            Some(LOD1_CONTOUR_LIMIT),
        ) {
            return Some(candidate);
        }
    }

    None
}

fn try_generate_lod2(
    contours: &[Vec<(f32, f32)>],
    normalization: &NormalizationContext,
    reference: &QualitySignature,
    path_len_limit: usize,
) -> Option<LodCandidate> {
    let denoised = filter_tiny_contours_for_lod(contours, 0.0015, 0.02);
    let source = select_contours_by_importance(&denoised, LOD2_CONTOUR_LIMIT, 0.06, 0.90);
    if source.is_empty() {
        return None;
    }

    let mut best_budget_candidate: Option<LodCandidate> = None;
    let max_contours = source.len().clamp(1, LOD2_CONTOUR_LIMIT);
    let keep_levels = [max_contours, max_contours.div_ceil(2), 1];
    let candidates: &[(f32, Option<f32>, SimplifyAlgorithm)] = &[
        (2.10, Some(1.20), SimplifyAlgorithm::Rdp),
        (3.20, Some(1.30), SimplifyAlgorithm::Rdp),
        (4.60, Some(1.35), SimplifyAlgorithm::Rdp),
    ];

    for &keep in &keep_levels {
        for &(epsilon, post_mul, algorithm) in candidates {
            let processed =
                process_contours_for_lod(&source, epsilon, 0, post_mul, keep, algorithm);
            let Some(candidate) = build_lod_candidate(processed, normalization) else {
                continue;
            };
            if !fits_lod_budget(
                &candidate.complexity,
                path_len_limit,
                Some(LOD2_SEGMENT_LIMIT),
                Some(LOD2_CONTOUR_LIMIT),
            ) {
                continue;
            }

            if quality_gate_passed(reference, &candidate.signature) {
                return Some(candidate);
            }

            if should_replace_with_more_similar(
                best_budget_candidate.as_ref(),
                &candidate,
                reference,
                true,
            ) {
                best_budget_candidate = Some(candidate);
            }
        }
    }

    if let Some(candidate) = best_budget_candidate {
        return Some(candidate);
    }

    if let Some(candidate) = force_fit_contours_by_sampling(
        &source,
        normalization,
        path_len_limit,
        LOD2_SEGMENT_LIMIT,
        LOD2_CONTOUR_LIMIT,
    ) {
        return Some(candidate);
    }

    for segments in [64usize, 48, 32, 24, 16, 12, 8] {
        let Some(fallback_contours) = build_bbox_ellipse_contour(&source, segments) else {
            continue;
        };
        let Some(candidate) = build_lod_candidate(fallback_contours, normalization) else {
            continue;
        };
        if fits_lod_budget(
            &candidate.complexity,
            path_len_limit,
            Some(LOD2_SEGMENT_LIMIT),
            Some(LOD2_CONTOUR_LIMIT),
        ) {
            return Some(candidate);
        }
    }

    None
}

pub fn generate_cursor_lods(img: &GrayscaleImage, limits: CursorLodPathLenLimits) -> CursorLodData {
    if img.width < 2 || img.height < 2 || img.data.is_empty() {
        return CursorLodData::empty();
    }

    let raw_contours = extract_raw_contours(img, 128);
    if raw_contours.is_empty() {
        return CursorLodData::empty();
    }
    let lod_base_contours = build_lod_base_contours(&raw_contours);
    if lod_base_contours.is_empty() {
        return CursorLodData::empty();
    }

    let normalization = normalization_context_for_image(img);
    let Some(reference_signature) = quality_signature_for_contours(&lod_base_contours) else {
        return CursorLodData::empty();
    };

    let lod0 = try_generate_lod0(
        &lod_base_contours,
        &normalization,
        &reference_signature,
        limits.lod0_path_len_soft_limit,
    );
    let lod1 = lod0
        .as_ref()
        .and_then(|candidate| {
            fits_lod_budget(
                &candidate.complexity,
                limits.lod1_path_len_limit,
                Some(LOD1_SEGMENT_LIMIT),
                Some(LOD1_CONTOUR_LIMIT),
            )
            .then(|| candidate.clone())
        })
        .or_else(|| {
            try_generate_lod1(
                &lod_base_contours,
                &normalization,
                &reference_signature,
                limits.lod1_path_len_limit,
            )
        });

    let lod2_from_existing = lod1.as_ref().or(lod0.as_ref()).and_then(|candidate| {
        fits_lod_budget(
            &candidate.complexity,
            limits.lod2_path_len_limit,
            Some(LOD2_SEGMENT_LIMIT),
            Some(LOD2_CONTOUR_LIMIT),
        )
        .then(|| candidate.clone())
    });

    let lod2 = lod2_from_existing.or_else(|| {
        try_generate_lod2(
            &lod_base_contours,
            &normalization,
            &reference_signature,
            limits.lod2_path_len_limit,
        )
    });

    CursorLodData {
        path_lod0: lod0.as_ref().map(|item| item.path.clone()),
        path_lod1: lod1.as_ref().map(|item| item.path.clone()),
        path_lod2: lod2.as_ref().map(|item| item.path.clone()),
        complexity_lod0: lod0.map(|item| item.complexity),
        complexity_lod1: lod1.map(|item| item.complexity),
        complexity_lod2: lod2.map(|item| item.complexity),
        bounds: Some(CursorBounds {
            width: img.width as f32,
            height: img.height as f32,
        }),
    }
}

/// Cursor bounds for proper scaling
#[derive(Debug, Clone)]
pub struct CursorBounds {
    pub width: f32,
    pub height: f32,
}

/// Generate cursor data from grayscale image
pub fn generate_cursor_data(img: &GrayscaleImage) -> (Option<String>, Option<CursorBounds>) {
    let lods = generate_cursor_lods(img, CursorLodPathLenLimits::default());
    let path = lods
        .path_lod2
        .or(lods.path_lod1)
        .or(lods.path_lod0)
        .or_else(|| extract_cursor_outline(img, 128));
    let bounds = if path.is_some() { lods.bounds } else { None };
    (path, bounds)
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    fn build_complex_test_image() -> GrayscaleImage {
        let width = 96u32;
        let height = 96u32;
        let mut data = vec![0u8; (width * height) as usize];

        for y in 0..height {
            for x in 0..width {
                let dx = x as i32 - 48;
                let dy = y as i32 - 48;
                let dist_sq = dx * dx + dy * dy;
                let in_ring = (16 * 16..=38 * 38).contains(&dist_sq);
                let checker = ((x / 6) + (y / 5)) % 2 == 0;
                let in_checker_zone = x > 16 && x < 80 && y > 16 && y < 80;
                let in_cross = (x > 44 && x < 52) || (y > 44 && y < 52);

                if in_ring || (checker && in_checker_zone) || in_cross {
                    data[(y * width + x) as usize] = 255;
                }
            }
        }

        GrayscaleImage::new(width, height, data)
    }

    #[test]
    fn test_lod1_hard_budget_with_complex_sample() {
        let img = build_complex_test_image();
        let lods = generate_cursor_lods(&img, CursorLodPathLenLimits::default());

        let complexity = lods
            .complexity_lod1
            .expect("LOD1 should produce complexity metadata");
        assert!(lods.path_lod1.is_some(), "LOD1 should produce path");
        assert!(
            complexity.path_len as usize <= DEFAULT_LOD1_PATH_LEN_LIMIT,
            "LOD1 pathLen should respect hard limit"
        );
        assert!(
            complexity.segment_count as usize <= LOD1_SEGMENT_LIMIT,
            "LOD1 segment count should respect hard limit"
        );
        assert!(
            complexity.contour_count as usize <= LOD1_CONTOUR_LIMIT,
            "LOD1 contour count should respect hard limit"
        );
    }

    #[test]
    fn test_lod2_hard_budget_and_contour_cap() {
        let img = build_complex_test_image();
        let lods = generate_cursor_lods(&img, CursorLodPathLenLimits::default());

        let complexity = lods
            .complexity_lod2
            .expect("LOD2 should produce complexity metadata");
        assert!(lods.path_lod2.is_some(), "LOD2 should produce path");
        assert!(
            complexity.contour_count as usize <= LOD2_CONTOUR_LIMIT,
            "LOD2 contour count should respect hard limit"
        );
        assert!(
            complexity.path_len as usize <= DEFAULT_LOD2_PATH_LEN_LIMIT,
            "LOD2 pathLen should respect hard limit"
        );
        assert!(
            complexity.segment_count as usize <= LOD2_SEGMENT_LIMIT,
            "LOD2 segment count should respect hard limit"
        );
    }

    #[test]
    fn test_quality_gate_rejects_obvious_distortion() {
        let reference = QualitySignature {
            area: 100.0,
            center_x: 50.0,
            center_y: 50.0,
            aspect_ratio: 1.0,
        };
        let acceptable = QualitySignature {
            area: 94.0,
            center_x: 50.4,
            center_y: 49.7,
            aspect_ratio: 1.12,
        };
        let distorted = QualitySignature {
            area: 70.0,
            center_x: 52.2,
            center_y: 50.0,
            aspect_ratio: 1.35,
        };

        assert!(
            quality_gate_passed(&reference, &acceptable),
            "nearby candidate should pass quality gate"
        );
        assert!(
            !quality_gate_passed(&reference, &distorted),
            "obviously distorted candidate should be rejected"
        );
    }
}
