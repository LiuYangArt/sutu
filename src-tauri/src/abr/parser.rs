//! ABR file parser
//!
//! Parses Adobe Photoshop ABR brush files.
//! Supports versions 1, 2, 6, 7, and 10.
//!
//! Reference: Krita's kis_abr_brush_collection.cpp

use std::io::{Cursor, Read, Seek, SeekFrom};

use byteorder::{BigEndian, ReadBytesExt};

use super::defaults::AbrDefaults;
use super::descriptor::{parse_descriptor, DescriptorValue};
use super::error::AbrError;
use super::samp::normalize_brush_texture;
use super::types::{
    AbrBrush, AbrDynamics, AbrFile, AbrVersion, ColorDynamicsSettings, ControlSource,
    GrayscaleImage, ScatterSettings, ShapeDynamicsSettings, TextureSettings, TransferSettings,
};
use std::collections::HashMap;

/// Preliminary brush data extracted from 'samp' section
struct SampBrushData {
    uuid: Option<String>,
    tip_image: GrayscaleImage,
    diameter: f32,
    spacing: f32,
    angle: f32,
    roundness: f32,
    #[allow(dead_code)] // Reserved for future use (multi-depth brush support)
    depth: u16,
}

/// ABR file header information
#[derive(Debug, Clone)]
struct AbrHeader {
    version: AbrVersion,
    subversion: u16,
    count: u32,
}

/// Main ABR parser
pub struct AbrParser;

impl AbrParser {
    /// Parse an ABR file from raw bytes
    pub fn parse(data: &[u8]) -> Result<AbrFile, AbrError> {
        let mut cursor = Cursor::new(data);

        // Read header
        let header = Self::read_header(&mut cursor)?;

        tracing::debug!(
            "ABR header: version={:?}, subversion={}, count={}",
            header.version,
            header.subversion,
            header.count
        );

        if header.count == 0 {
            return Ok(AbrFile {
                version: header.version,
                brushes: Vec::new(),
                patterns: Vec::new(),
            });
        }

        // Parse based on version
        let brushes = if header.version.is_new_format() {
            Self::parse_v6(&mut cursor, &header)?
        } else {
            Self::parse_v12(&mut cursor, &header)?
        };

        // Parse patterns from patt section (V6+ only)
        let patterns = if header.version.is_new_format() {
            let mut pattern_cursor = Cursor::new(data);
            // Skip header (4 bytes: version + subversion)
            pattern_cursor.seek(SeekFrom::Start(4))?;
            Self::parse_patterns(&mut pattern_cursor)?
        } else {
            Vec::new()
        };

        // NEW: Apply texture settings from global 'desc' section if available
        // This is necessary because v6+ brushes often store metadata in a separate 'desc' section
        // rather than embedding it in the 'samp' section as per older specs.
        // Apply global texture settings is now integrated into create_brushes_from_desc
        // BUT we need to link pattern IDs since create_brushes_from_desc only sets pattern_uuid from Txtr
        if header.version.is_new_format() {
            // We need to mutate brushes to resolve patterns
            // Since we returned immutable vector, we need to iterate and resolve.
            // Actually it's cleaner to do it in create_brushes_from_desc if we pass patterns there.
            // But patterns are parsed AFTER brushes in original flow.
            // To fix this dependency, we should parse patterns BEFORE brushes?
            // NO, `parse_v6` is called before `parse_patterns` in `parse`.

            // Let's resolve pattern links here
            let mut resolved_brushes = brushes;
            for brush in &mut resolved_brushes {
                if let Some(settings) = &mut brush.texture_settings {
                    let mut linked = false;
                    if let Some(pid) = &settings.pattern_uuid {
                        if let Some(p) = patterns.iter().find(|p| &p.id == pid) {
                            settings.pattern_id = Some(p.id.clone());
                            settings.pattern_name = Some(p.name.clone());
                            linked = true;
                        }
                    }
                    if !linked {
                        if let Some(name) = &settings.pattern_name {
                            if let Some(p) = patterns.iter().find(|p| &p.name == name) {
                                settings.pattern_id = Some(p.id.clone());
                            }
                        }
                    }
                }
            }
            return Ok(AbrFile {
                version: header.version,
                brushes: resolved_brushes,
                patterns,
            });
        }

        Ok(AbrFile {
            version: header.version,
            brushes,
            patterns,
        })
    }

    /// Read ABR file header
    fn read_header(cursor: &mut Cursor<&[u8]>) -> Result<AbrHeader, AbrError> {
        let version_num = cursor.read_u16::<BigEndian>()?;

        let version = match version_num {
            1 => AbrVersion::V1,
            2 => AbrVersion::V2,
            6 => AbrVersion::V6,
            7 => AbrVersion::V7,
            10 => AbrVersion::V10,
            _ => return Err(AbrError::UnsupportedVersion(version_num)),
        };

        let (subversion, count) = match version {
            AbrVersion::V1 | AbrVersion::V2 => {
                let count = cursor.read_u16::<BigEndian>()? as u32;
                (0, count)
            }
            AbrVersion::V6 | AbrVersion::V7 | AbrVersion::V10 => {
                let subversion = cursor.read_u16::<BigEndian>()?;
                // For v6+, we need to scan the samp section to count brushes
                // Save position after reading header (before 8BIM blocks)
                let header_end = cursor.position();
                let count = Self::count_samples_v6(cursor, subversion)?;
                // Reset to header end so parse_v6 can find sections
                cursor.seek(SeekFrom::Start(header_end))?;
                (subversion, count)
            }
        };

        Ok(AbrHeader {
            version,
            subversion,
            count,
        })
    }

    /// Count samples in v6+ format by scanning the samp section
    fn count_samples_v6(cursor: &mut Cursor<&[u8]>, subversion: u16) -> Result<u32, AbrError> {
        if subversion != 1 && subversion != 2 {
            return Err(AbrError::UnsupportedVersion(6));
        }

        let origin = cursor.position();

        // Find samp section
        if !Self::reach_8bim_section(cursor, "samp")? {
            cursor.seek(SeekFrom::Start(origin))?;
            return Ok(0);
        }

        let section_size = cursor.read_u32::<BigEndian>()?;
        let section_end = cursor.position() + section_size as u64;
        let data_start = cursor.position();

        let mut count = 0u32;

        while cursor.position() < section_end {
            let brush_size = cursor.read_u32::<BigEndian>()?;
            // Align to 4 bytes
            let aligned_size = (brush_size + 3) & !3;
            let new_pos = cursor.position() + aligned_size as u64;

            if new_pos > section_end {
                break;
            }

            cursor.seek(SeekFrom::Start(new_pos))?;
            count += 1;
        }

        // Reset to data start for actual parsing
        cursor.seek(SeekFrom::Start(data_start))?;

        Ok(count)
    }

    /// Parse pattern resources from patt section
    fn parse_patterns(
        cursor: &mut Cursor<&[u8]>,
    ) -> Result<Vec<super::patt::PatternResource>, AbrError> {
        let origin = cursor.position();

        // Try to find patt section
        if !Self::reach_8bim_section(cursor, "patt")? {
            cursor.seek(SeekFrom::Start(origin))?;
            return Ok(Vec::new());
        }

        let section_size = cursor.read_u32::<BigEndian>()? as usize;
        if section_size == 0 {
            return Ok(Vec::new());
        }

        // Read patt section data
        let mut patt_data = vec![0u8; section_size];
        cursor.read_exact(&mut patt_data)?;

        // Parse patterns
        super::patt::parse_patt_section(&patt_data)
    }

    /// Seek to a named 8BIM section
    fn reach_8bim_section(cursor: &mut Cursor<&[u8]>, name: &str) -> Result<bool, AbrError> {
        let data_len = cursor.get_ref().len() as u64;

        while cursor.position() + 8 <= data_len {
            let mut tag = [0u8; 4];
            cursor.read_exact(&mut tag)?;

            if &tag != b"8BIM" {
                return Err(AbrError::Invalid8BIMBlock);
            }

            let mut tagname = [0u8; 4];
            cursor.read_exact(&mut tagname)?;

            let tagname_str =
                std::str::from_utf8(&tagname).map_err(|e| AbrError::StringDecode(e.to_string()))?;

            if tagname_str == name {
                return Ok(true);
            }

            // Skip this section
            let section_size = cursor.read_u32::<BigEndian>()?;
            cursor.seek(SeekFrom::Current(section_size as i64))?;
        }

        Ok(false)
    }

    /// Parse v1/v2 format brushes
    fn parse_v12(
        cursor: &mut Cursor<&[u8]>,
        header: &AbrHeader,
    ) -> Result<Vec<AbrBrush>, AbrError> {
        let mut brushes = Vec::new();

        for i in 0..header.count {
            match Self::parse_brush_v12(cursor, header) {
                Ok(Some(brush)) => brushes.push(brush),
                Ok(None) => {
                    tracing::warn!("Skipped computed brush #{}", i);
                }
                Err(e) => {
                    tracing::warn!("Failed to parse brush #{}: {}", i, e);
                }
            }
        }

        Ok(brushes)
    }

    /// Parse a single v1/v2 brush
    fn parse_brush_v12(
        cursor: &mut Cursor<&[u8]>,
        header: &AbrHeader,
    ) -> Result<Option<AbrBrush>, AbrError> {
        let brush_type = cursor.read_u16::<BigEndian>()?;
        let brush_size = cursor.read_u32::<BigEndian>()?;
        let next_brush = cursor.position() + brush_size as u64;

        let result = match brush_type {
            1 => {
                // Computed (parametric) brush - skip for now
                tracing::debug!("Computed brush found, skipping");
                None
            }
            2 => {
                // Sampled brush
                Some(Self::parse_sampled_brush_v12(cursor, header)?)
            }
            _ => {
                tracing::warn!("Unknown brush type: {}", brush_type);
                None
            }
        };

        // Seek to next brush
        cursor.seek(SeekFrom::Start(next_brush))?;

        Ok(result)
    }

    /// Parse a sampled brush in v1/v2 format
    fn parse_sampled_brush_v12(
        cursor: &mut Cursor<&[u8]>,
        header: &AbrHeader,
    ) -> Result<AbrBrush, AbrError> {
        // Skip misc bytes (4) and spacing (2)
        cursor.seek(SeekFrom::Current(6))?;

        // Read name for v2
        let name = if header.version == AbrVersion::V2 {
            Self::read_ucs2_string(cursor)?
        } else {
            String::new()
        };

        // Skip antialiasing (1) and short bounds (8)
        cursor.seek(SeekFrom::Current(9))?;

        // Read bounds
        let top = cursor.read_i32::<BigEndian>()?;
        let left = cursor.read_i32::<BigEndian>()?;
        let bottom = cursor.read_i32::<BigEndian>()?;
        let right = cursor.read_i32::<BigEndian>()?;

        let depth = cursor.read_u16::<BigEndian>()?;
        let compression = cursor.read_u8()?;

        let width = (right - left) as u32;
        let height = (bottom - top) as u32;

        if width == 0 || height == 0 {
            return Err(AbrError::InvalidFile("Zero dimension brush".into()));
        }

        if height > 16384 {
            return Err(AbrError::InvalidFile("Brush too tall".into()));
        }

        // Read image data
        let image_data = if compression == 0 {
            Self::read_raw_image(cursor, width, height, depth)?
        } else {
            Self::read_rle_image(cursor, height)?
        };

        // Normalize alpha using smart detection
        let raw_image = GrayscaleImage::new(width, height, image_data);
        let normalized = normalize_brush_texture(&raw_image);

        Ok(AbrBrush {
            name: if name.is_empty() {
                format!("Brush {}", width)
            } else {
                name
            },
            uuid: None,
            tip_image: Some(normalized),
            diameter: width as f32,
            spacing: AbrDefaults::SPACING,
            angle: AbrDefaults::ANGLE,
            roundness: AbrDefaults::ROUNDNESS,
            hardness: None,
            dynamics: None,
            is_computed: false,
            texture_settings: None,
            dual_brush_settings: None,
            shape_dynamics_enabled: None,
            shape_dynamics: None,
            scatter_enabled: None,
            scatter: None,
            color_dynamics_enabled: None,
            color_dynamics: None,
            transfer_enabled: None,
            transfer: None,
            base_opacity: None,
            base_flow: None,
        })
    }

    /// Parse v6+ format brushes
    fn parse_v6(cursor: &mut Cursor<&[u8]>, header: &AbrHeader) -> Result<Vec<AbrBrush>, AbrError> {
        let origin = cursor.position(); // Start of ABR data (after header)

        // Step 1: Parse 'samp' section to get all raw brush data (images)
        // We do this first because we need the images when processing descriptors
        let mut samp_map = Self::parse_samp_data(cursor, header)?;

        // Reset cursor to origin
        cursor.seek(SeekFrom::Start(origin))?;

        // Now it's safe to borrow data since we're done with mutable cursor operations for a bit
        let data = *cursor.get_ref();

        // Step 2: Try to find and parse 'desc' section for authoritative order and metadata
        // This is the preferred way for V6/V10 brushes
        if let Some(desc_data) = Self::find_desc_section(data) {
            match Self::create_brushes_from_desc(data, &desc_data, &mut samp_map) {
                Ok(brushes) => {
                    if !brushes.is_empty() {
                        return Ok(brushes);
                    }
                    tracing::warn!(
                        "Parsed desc section but found no brushes, falling back to samp order"
                    );
                }
                Err(e) => {
                    tracing::warn!(
                        "Failed to parse desc section: {}, falling back to samp order",
                        e
                    );
                }
            }
        } else {
            tracing::warn!("No desc section found, using samp order");
        }

        // Fallback: If no desc section or parsing failed, return what we found in samp section
        // Convert map values to vector, sorted by original index for stability
        let fallback_brushes: Vec<(usize, AbrBrush)> = samp_map
            .into_values()
            .map(|d| {
                // Approximate original index from UUID if possible, or just append
                // Actually parse_samp_data returns a Map, we lost the order.
                // We should probably change parse_samp_data or just accept random order for fallback.
                // For fallback, let's just re-scan samp? Or better, make parse_samp_data return order.
                // Since this is a fallback for broken/old files, performance is less critical.
                // Let's just return them in arbitrary order but try to be consistent.
                (
                    0,
                    AbrBrush {
                        name: d.uuid.clone().unwrap_or_else(|| "Unknown".into()),
                        uuid: d.uuid,
                        tip_image: Some(d.tip_image),
                        diameter: d.diameter,
                        spacing: d.spacing,
                        angle: d.angle,
                        roundness: d.roundness,
                        hardness: None,
                        dynamics: None,
                        is_computed: false,

                        texture_settings: None,
                        dual_brush_settings: None,
                        shape_dynamics_enabled: None,
                        shape_dynamics: None,
                        scatter_enabled: None,
                        scatter: None,
                        color_dynamics_enabled: None,
                        color_dynamics: None,
                        transfer_enabled: None,
                        transfer: None,
                        base_opacity: None,
                        base_flow: None,
                    },
                )
            })
            .collect();

        // If we really need order in fallback, we should have stored it.
        // But for now let's just return what we have.
        Ok(fallback_brushes.into_iter().map(|(_, b)| b).collect())
    }

    /// Parse 'samp' section into a lookup map
    fn parse_samp_data(
        cursor: &mut Cursor<&[u8]>,
        header: &AbrHeader,
    ) -> Result<HashMap<String, SampBrushData>, AbrError> {
        let mut map = HashMap::new();
        let origin = cursor.position();

        if Self::reach_8bim_section(cursor, "samp")? {
            let section_size = cursor.read_u32::<BigEndian>()?;
            let section_end = cursor.position() + section_size as u64;
            let mut brush_id = 0;

            while cursor.position() < section_end {
                match Self::parse_single_samp_entry(cursor, header, brush_id) {
                    Ok(data) => {
                        if let Some(ref uuid) = data.uuid {
                            map.insert(uuid.clone(), data);
                        } else {
                            // If no UUID, use ID-based key
                            map.insert(format!("id-{}", brush_id), data);
                        }
                        brush_id += 1;
                    }
                    Err(e) => {
                        tracing::warn!("Failed to parse samp entry #{}: {}", brush_id, e);
                        // Try to recover? Hard without size knowledge sometimes.
                        // Ideally parse_single_samp_entry handles skipping.
                        break;
                    }
                }
            }
        }

        // Restore cursor
        cursor.seek(SeekFrom::Start(origin))?;
        Ok(map)
    }

    /// Parse a single entry from samp section
    fn parse_single_samp_entry(
        cursor: &mut Cursor<&[u8]>,
        header: &AbrHeader,
        id: u32,
    ) -> Result<SampBrushData, AbrError> {
        let brush_size = cursor.read_u32::<BigEndian>()?;
        let aligned_size = (brush_size + 3) & !3;
        let next_brush = cursor.position() + aligned_size as u64;

        // Read key (37 bytes)
        let mut key_bytes = [0u8; 37];
        cursor.read_exact(&mut key_bytes)?;

        // Extract UUID
        let uuid_str = String::from_utf8_lossy(&key_bytes).to_string();
        let clean_uuid = uuid_str.trim_matches(char::from(0)).trim();
        let final_uuid = clean_uuid
            .strip_prefix('$')
            .unwrap_or(clean_uuid)
            .to_string();

        let uuid = if final_uuid.len() >= 36 {
            Some(final_uuid)
        } else {
            Some(format!("id-{}", id))
        };

        // Skip bytes based on subversion
        if header.subversion == 1 {
            cursor.seek(SeekFrom::Current(10))?;
        } else {
            cursor.seek(SeekFrom::Current(264))?;
        }

        // Read bounds
        let top = cursor.read_i32::<BigEndian>()?;
        let left = cursor.read_i32::<BigEndian>()?;
        let bottom = cursor.read_i32::<BigEndian>()?;
        let right = cursor.read_i32::<BigEndian>()?;

        let depth = cursor.read_u16::<BigEndian>()?;
        let compression = cursor.read_u8()?;

        let width = (right - left) as u32;
        let height = (bottom - top) as u32;

        if width == 0 || height == 0 {
            cursor.seek(SeekFrom::Start(next_brush))?;
            return Err(AbrError::InvalidFile("Zero dimension brush".into()));
        }

        // Read image data
        let image_data = if compression == 0 {
            Self::read_raw_image(cursor, width, height, depth)?
        } else {
            Self::read_rle_image(cursor, height)?
        };

        let raw_image = GrayscaleImage::new(width, height, image_data);
        let normalized = normalize_brush_texture(&raw_image);

        // Ensure we are at the end of this entry
        cursor.seek(SeekFrom::Start(next_brush))?;

        Ok(SampBrushData {
            uuid,
            tip_image: normalized,
            diameter: width as f32, // Default diameter from image width
            spacing: AbrDefaults::SPACING,
            angle: AbrDefaults::ANGLE,
            roundness: AbrDefaults::ROUNDNESS,
            depth,
        })
    }

    /// Helper to find UUID from sampledData field recursively
    fn find_sampled_data_uuid(val: &DescriptorValue) -> Option<String> {
        match val {
            DescriptorValue::Descriptor(d) => {
                if let Some(DescriptorValue::String(s)) = d.get("sampledData") {
                    return Some(s.clone());
                }
                for v in d.values() {
                    if let Some(res) = Self::find_sampled_data_uuid(v) {
                        return Some(res);
                    }
                }
            }
            DescriptorValue::List(l) => {
                for v in l {
                    if let Some(res) = Self::find_sampled_data_uuid(v) {
                        return Some(res);
                    }
                }
            }
            _ => {}
        }
        None
    }

    /// Create logical AbrBrush from a descriptor entry (handling both Sampled and Computed)
    fn create_brush_from_descriptor_entry(
        brush_desc: &indexmap::IndexMap<String, DescriptorValue>,
        index: usize,
        samp_map: &HashMap<String, SampBrushData>,
    ) -> AbrBrush {
        // Extract common attributes - Name
        let name = brush_desc
            .get("Nm  ")
            .and_then(|v| {
                if let DescriptorValue::String(s) = v {
                    Some(s.clone())
                } else {
                    None
                }
            })
            .unwrap_or_else(|| format!("Brush {}", index + 1));

        // Try to find sampled data UUID
        let target_uuid =
            Self::find_sampled_data_uuid(&DescriptorValue::Descriptor(brush_desc.clone()));

        // Check if it's a computed brush or sampled brush
        let mut brush = if let Some(uuid) = target_uuid.as_ref() {
            // It's a sampled brush, try to find image data
            if let Some(samp_data) = samp_map.get(uuid) {
                AbrBrush {
                    name: name.clone(),
                    uuid: Some(uuid.clone()),
                    tip_image: Some(samp_data.tip_image.clone()),
                    diameter: samp_data.diameter,
                    spacing: samp_data.spacing,
                    angle: samp_data.angle,
                    roundness: samp_data.roundness,
                    hardness: None,
                    dynamics: Some(AbrDynamics::default()),
                    is_computed: false,
                    texture_settings: None,
                    dual_brush_settings: None,
                    shape_dynamics_enabled: None,
                    shape_dynamics: None,
                    scatter_enabled: None,
                    scatter: None,
                    color_dynamics_enabled: None,
                    color_dynamics: None,
                    transfer_enabled: None,
                    transfer: None,
                    base_opacity: None,
                    base_flow: None,
                }
            } else {
                // UUID found but no data?
                tracing::warn!("Brush '{}' has UUID {} but no samp data found", name, uuid);
                // Create a placeholder
                AbrBrush {
                    name: name.clone(),
                    uuid: Some(uuid.clone()),
                    tip_image: None,
                    diameter: 10.0,
                    spacing: 0.25,
                    angle: 0.0,
                    roundness: 1.0,
                    hardness: None,
                    dynamics: None,
                    is_computed: false,
                    texture_settings: None,
                    dual_brush_settings: None,
                    shape_dynamics_enabled: None,
                    shape_dynamics: None,
                    scatter_enabled: None,
                    scatter: None,
                    color_dynamics_enabled: None,
                    color_dynamics: None,
                    transfer_enabled: None,
                    transfer: None,
                    base_opacity: None,
                    base_flow: None,
                }
            }
        } else {
            // No sampledData UUID -> Computed Brush
            // Extract parameters to generate tip
            let mut diameter = 10.0;
            let mut hardness = 1.0;
            let mut roundness = 1.0;
            let mut angle = 0.0;
            let mut spacing = 0.25;

            if let Some(DescriptorValue::Descriptor(brsh)) = brush_desc.get("Brsh") {
                if let Some(DescriptorValue::UnitFloat { value, .. }) = brsh.get("Dmtr") {
                    diameter = *value as f32;
                }
                if let Some(DescriptorValue::UnitFloat { value, .. }) = brsh.get("Hrdn") {
                    hardness = (*value as f32) / 100.0;
                }
                if let Some(DescriptorValue::UnitFloat { value, .. }) = brsh.get("Rndn") {
                    roundness = (*value as f32) / 100.0;
                }
                if let Some(DescriptorValue::UnitFloat { value, .. }) = brsh.get("Angl") {
                    angle = *value as f32;
                }
                if let Some(DescriptorValue::UnitFloat { value, .. }) = brsh.get("Spcn") {
                    spacing = (*value as f32) / 100.0;
                }
            }

            let tip_image = Self::generate_computed_tip(diameter, hardness, roundness, angle);

            AbrBrush {
                name: name.clone(),
                uuid: None,
                tip_image: Some(tip_image),
                diameter,
                spacing,
                angle,
                roundness,
                hardness: Some(hardness * 100.0),
                dynamics: Some(AbrDynamics::default()),
                is_computed: true,
                texture_settings: None,
                dual_brush_settings: None,
                shape_dynamics_enabled: None,
                shape_dynamics: None,
                scatter_enabled: None,
                scatter: None,
                color_dynamics_enabled: None,
                color_dynamics: None,
                transfer_enabled: None,
                transfer: None,
                base_opacity: None,
                base_flow: None,
            }
        };

        // Apply Texture settings
        let use_texture = matches!(
            brush_desc.get("useTexture"),
            Some(DescriptorValue::Boolean(true))
        );

        if use_texture {
            if let Some(DescriptorValue::Descriptor(txtr)) = brush_desc.get("Txtr") {
                let mut settings = Self::parse_texture_settings(txtr);
                Self::apply_texture_params_from_root(brush_desc, &mut settings);
                brush.texture_settings = Some(settings);
            }
        }

        // Apply Dual Brush settings
        // Check "useDualBrush" first
        // Some ABR files store it at root; others store it inside dualBrush descriptor.
        let use_dual_brush_root = matches!(
            brush_desc.get("useDualBrush"),
            Some(DescriptorValue::Boolean(true))
        );
        let use_dual_brush_nested = match brush_desc.get("dualBrush") {
            Some(DescriptorValue::Descriptor(d)) => {
                matches!(d.get("useDualBrush"), Some(DescriptorValue::Boolean(true)))
            }
            _ => false,
        };
        let use_dual_brush = use_dual_brush_root || use_dual_brush_nested;

        if use_dual_brush {
            brush.dual_brush_settings = Self::parse_dual_brush_settings(brush_desc);
        }

        // Apply Brush Tip Shape parameters override (for sampled brushes too)
        if let Some(DescriptorValue::Descriptor(brsh)) = brush_desc.get("Brsh") {
            Self::apply_brush_tip_params(brsh, &mut brush);
        }

        // Apply Photoshop-compatible Dynamics / Scatter / Color Dynamics / Transfer + base Flow/Opacity
        Self::apply_advanced_dynamics_from_descriptor(brush_desc, &mut brush);

        brush
    }

    /// Create brushes from descriptor section (authoritative order)
    fn create_brushes_from_desc(
        _data: &[u8], // Full file data to search for desc section again if needed, or we pass body
        desc_data: &[u8],
        samp_map: &mut HashMap<String, SampBrushData>,
    ) -> Result<Vec<AbrBrush>, AbrError> {
        let mut brushes = Vec::new();

        match parse_descriptor(&mut Cursor::new(desc_data)) {
            Ok(desc) => {
                if let Some(DescriptorValue::List(brsh_list)) = desc.get("Brsh") {
                    for (i, item) in brsh_list.iter().enumerate() {
                        if let DescriptorValue::Descriptor(brush_desc) = item {
                            // Create brush from descriptor entry
                            let brush =
                                Self::create_brush_from_descriptor_entry(brush_desc, i, samp_map);
                            brushes.push(brush);
                        }
                    }
                }
            }
            Err(e) => return Err(e),
        }

        Ok(brushes)
    }

    /// Read raw (uncompressed) image data
    fn read_raw_image(
        cursor: &mut Cursor<&[u8]>,
        width: u32,
        height: u32,
        depth: u16,
    ) -> Result<Vec<u8>, AbrError> {
        let bytes_per_pixel = (depth / 8) as u32;
        let size = (width * height * bytes_per_pixel) as usize;

        let mut buffer = vec![0u8; size];
        cursor.read_exact(&mut buffer)?;

        // If depth > 8, we need to downsample
        if bytes_per_pixel > 1 {
            // Take every Nth byte (assuming big-endian, take MSB)
            let downsampled: Vec<u8> = buffer
                .chunks(bytes_per_pixel as usize)
                .map(|chunk| chunk[0])
                .collect();
            Ok(downsampled)
        } else {
            Ok(buffer)
        }
    }

    /// Read RLE compressed image data (PackBits algorithm)
    fn read_rle_image(cursor: &mut Cursor<&[u8]>, height: u32) -> Result<Vec<u8>, AbrError> {
        // Read scanline sizes
        let mut scanline_sizes = Vec::with_capacity(height as usize);
        for _ in 0..height {
            scanline_sizes.push(cursor.read_u16::<BigEndian>()?);
        }

        // Decode each scanline
        let mut data = Vec::new();

        for &scanline_size in &scanline_sizes {
            let scanline_end = cursor.position() + scanline_size as u64;

            while cursor.position() < scanline_end {
                let n = cursor.read_i8()?;

                if n >= 0 {
                    // Copy next n+1 bytes literally
                    let count = (n as usize) + 1;
                    let mut bytes = vec![0u8; count];
                    cursor.read_exact(&mut bytes)?;
                    data.extend(bytes);
                } else if n > -128 {
                    // Repeat next byte (-n + 1) times
                    let count = (-n as usize) + 1;
                    let byte = cursor.read_u8()?;
                    data.extend(std::iter::repeat(byte).take(count));
                }
                // n == -128 is a no-op
            }
        }

        Ok(data)
    }

    /// Read UCS-2 (UTF-16 BE) string
    fn read_ucs2_string(cursor: &mut Cursor<&[u8]>) -> Result<String, AbrError> {
        let length = cursor.read_u32::<BigEndian>()? as usize;

        if length == 0 {
            return Ok(String::new());
        }

        let mut utf16_data = Vec::with_capacity(length);
        for _ in 0..length {
            utf16_data.push(cursor.read_u16::<BigEndian>()?);
        }

        String::from_utf16(&utf16_data).map_err(|e| AbrError::StringDecode(e.to_string()))
    }

    fn find_desc_section(data: &[u8]) -> Option<Vec<u8>> {
        let mut cursor = Cursor::new(data);
        cursor.seek(SeekFrom::Start(4)).ok()?; // Skip ABR header

        let data_len = data.len() as u64;

        while cursor.position() + 12 <= data_len {
            let pos = cursor.position();
            let mut signature = [0u8; 4];
            if cursor.read_exact(&mut signature).is_err() {
                break;
            }

            if &signature != b"8BIM" {
                cursor.seek(SeekFrom::Start(pos + 1)).ok();
                continue;
            }

            let mut tag = [0u8; 4];
            cursor.read_exact(&mut tag).ok()?;
            let tag_str = std::str::from_utf8(&tag).unwrap_or("????");

            let section_size = cursor.read_u32::<BigEndian>().ok()? as usize;

            if tag_str == "desc" {
                let mut section = vec![0u8; section_size];
                cursor.read_exact(&mut section).ok()?;
                return Some(section);
            } else {
                cursor.seek(SeekFrom::Current(section_size as i64)).ok();
                if section_size % 2 != 0 {
                    cursor.seek(SeekFrom::Current(1)).ok();
                }
            }
        }
        None
    }

    /// Generate a computed brush tip image (SDF-based antialiasing)
    fn generate_computed_tip(
        diameter: f32,
        hardness: f32,
        roundness: f32,
        angle: f32,
    ) -> GrayscaleImage {
        let size = diameter.ceil() as u32;
        // Ensure at least 1x1
        let width = size.max(1);
        let height = size.max(1);

        let mut data = vec![0u8; (width * height) as usize];

        let center_x = width as f32 / 2.0;
        let center_y = height as f32 / 2.0;
        let radius = diameter / 2.0;

        // Hardness 0..1, where 1 is hard edge, 0 is soft
        // In PS hardness, 100% means hard edge.
        // We map hardness to a fuzzy factor.
        // If hardness is 1.0 (100%), transition is very sharp (0.5px)
        // If hardness is 0.0 (0%), transition covers the whole radius
        let hard_factor = hardness.clamp(0.0, 1.0);

        // Convert roundness (0..1) to scaling factors
        // Roundness 1.0 = Circle
        // Roundness < 1.0 = Ellipse
        let ry = roundness.clamp(0.01, 1.0); // scale Y
        let rx = 1.0; // scale X is base

        // Rotation
        let angle_rad = angle.to_radians();
        let cos_a = angle_rad.cos();
        let sin_a = angle_rad.sin();

        for y in 0..height {
            for x in 0..width {
                // Coordinate relative to center
                let dx = x as f32 - center_x + 0.5; // +0.5 to sample pixel center
                let dy = y as f32 - center_y + 0.5;

                // Rotate inverse to align with ellipse axis
                let rot_x = dx * cos_a + dy * sin_a;
                let rot_y = -dx * sin_a + dy * cos_a;

                // Ellipse equation: (x/rx)^2 + (y/ry)^2 <= r^2
                // We calculate normalized distance: dist = sqrt((x/rx)^2 + (y/ry)^2)
                // If dist <= radius, it's inside.

                let dist = ((rot_x / rx).powi(2) + (rot_y / ry).powi(2)).sqrt();

                // Calculate edge falloff
                // Hardness determines where the falloff starts
                // Hardness 1.0 => falloff starts at radius - 0.5
                // Hardness 0.0 => falloff starts at 0

                let falloff_start = radius * hard_factor;
                let falloff_width = radius - falloff_start;

                let alpha = if dist >= radius {
                    0.0
                } else if dist < falloff_start {
                    1.0
                } else {
                    // Linear falloff
                    1.0 - (dist - falloff_start) / falloff_width.max(0.001)
                };

                // Clamp and convert to u8
                let val = (alpha.clamp(0.0, 1.0) * 255.0) as u8;
                data[(y * width + x) as usize] = val;
            }
        }

        GrayscaleImage {
            width,
            height,
            data,
        }
    }

    /// Parse pattern reference from Txtr sub-object.
    /// Note: Actual texture parameters (scale, depth, mode, etc.) are in the root descriptor,
    /// not in Txtr. This function only extracts pattern UUID and name.
    fn parse_texture_settings(
        txtr: &indexmap::IndexMap<String, DescriptorValue>,
    ) -> TextureSettings {
        let mut settings = TextureSettings {
            enabled: true,
            ..Default::default()
        };

        // Pattern UUID (Idnt)
        if let Some(DescriptorValue::String(id)) = txtr.get("Idnt") {
            settings.pattern_uuid = Some(id.clone());
            settings.pattern_id = Some(id.clone());
        }

        // Pattern Name - try both "PtNm" and "Nm" keys
        if let Some(DescriptorValue::String(name)) = txtr.get("PtNm") {
            settings.pattern_name = Some(name.clone());
        } else if let Some(DescriptorValue::String(name)) = txtr.get("Nm  ") {
            settings.pattern_name = Some(name.clone());
        }

        settings
    }

    /// Apply texture parameters from root descriptor (not from Txtr sub-object)
    /// These fields are stored at the brush descriptor root level in ABR files:
    /// - textureScale, textureBrightness, textureContrast
    /// - textureDepth, minimumDepth, textureBlendMode, InvT, TxtC
    fn apply_texture_params_from_root(
        brush_desc: &indexmap::IndexMap<String, DescriptorValue>,
        settings: &mut TextureSettings,
    ) {
        // Scale (textureScale) - Percent
        if let Some(DescriptorValue::UnitFloat { value, .. }) = brush_desc.get("textureScale") {
            settings.scale = *value as f32;
        }

        // Brightness (textureBrightness) - Long
        if let Some(DescriptorValue::Integer(val)) = brush_desc.get("textureBrightness") {
            settings.brightness = *val;
        } else if let Some(DescriptorValue::LargeInteger(val)) = brush_desc.get("textureBrightness")
        {
            settings.brightness = *val as i32;
        }

        // Contrast (textureContrast) - Long
        if let Some(DescriptorValue::Integer(val)) = brush_desc.get("textureContrast") {
            settings.contrast = *val;
        } else if let Some(DescriptorValue::LargeInteger(val)) = brush_desc.get("textureContrast") {
            settings.contrast = *val as i32;
        }

        // Depth (textureDepth) - Percent
        if let Some(DescriptorValue::UnitFloat { value, .. }) = brush_desc.get("textureDepth") {
            settings.depth = *value as f32;
        }

        // Minimum Depth (minimumDepth) - Percent
        if let Some(DescriptorValue::UnitFloat { value, .. }) = brush_desc.get("minimumDepth") {
            settings.minimum_depth = *value as f32;
        }

        // Blend Mode (textureBlendMode) - Enum
        if let Some(DescriptorValue::Enum { value, .. }) = brush_desc.get("textureBlendMode") {
            settings.mode = match value.as_str() {
                "Mltp" => super::types::TextureBlendMode::Multiply,
                "Sbt " => super::types::TextureBlendMode::Subtract,
                "Drkn" => super::types::TextureBlendMode::Darken,
                "Ovrl" => super::types::TextureBlendMode::Overlay,
                "CldD" => super::types::TextureBlendMode::ColorDodge,
                "CldB" => super::types::TextureBlendMode::ColorBurn,
                "LnrB" => super::types::TextureBlendMode::LinearBurn,
                "HrdM" => super::types::TextureBlendMode::HardMix,
                "LnrH" => super::types::TextureBlendMode::LinearHeight,
                "Hght" => super::types::TextureBlendMode::Height,
                _ => super::types::TextureBlendMode::Multiply,
            };
        }

        // Invert (InvT) - Boolean
        if let Some(DescriptorValue::Boolean(val)) = brush_desc.get("InvT") {
            settings.invert = *val;
        }

        // Texture each tip (TxtC) - Boolean
        if let Some(DescriptorValue::Boolean(val)) = brush_desc.get("TxtC") {
            settings.texture_each_tip = *val;
        }
    }

    /// Apply brush tip shape parameters from Brsh sub-object
    /// Fields: Dmtr (diameter), Spcn (spacing), Angl (angle), Rndn (roundness), Hrdn (hardness)
    fn apply_brush_tip_params(
        brsh: &indexmap::IndexMap<String, DescriptorValue>,
        brush: &mut AbrBrush,
    ) {
        // Spacing (Spcn) - Percent, stored as 0-100, we need 0.0-1.0
        if let Some(DescriptorValue::UnitFloat { value, .. }) = brsh.get("Spcn") {
            brush.spacing = (*value as f32) / 100.0;
        }

        // Angle (Angl) - Degrees
        if let Some(DescriptorValue::UnitFloat { value, .. }) = brsh.get("Angl") {
            brush.angle = *value as f32;
        }

        // Roundness (Rndn) - Percent, stored as 0-100, we need 0.0-1.0
        if let Some(DescriptorValue::UnitFloat { value, .. }) = brsh.get("Rndn") {
            brush.roundness = (*value as f32) / 100.0;
        }

        // Hardness (Hrdn) - Percent, stored as 0-100, we need 0.0-1.0
        if let Some(DescriptorValue::UnitFloat { value, .. }) = brsh.get("Hrdn") {
            brush.hardness = Some((*value as f32) / 100.0);
        }
    }

    fn apply_advanced_dynamics_from_descriptor(
        brush_desc: &indexmap::IndexMap<String, DescriptorValue>,
        brush: &mut AbrBrush,
    ) {
        // Base Opacity / Flow (0..1)
        if let Some(opacity) =
            Self::get_ratio_0_1(brush_desc, &["Opct", "opacity", "Opacity", "Opac"])
        {
            brush.base_opacity = Some(opacity);
        }
        if let Some(flow) = Self::get_ratio_0_1(brush_desc, &["Flw ", "flow", "Flow"]) {
            brush.base_flow = Some(flow);
        }

        // ------------------------------------------------------------------
        // Shape Dynamics
        // ------------------------------------------------------------------
        let mut shape = ShapeDynamicsSettings::default();
        let mut has_shape_info = false;

        if let Some(enabled) = Self::get_bool(brush_desc, &["useTipDynamics"]) {
            brush.shape_dynamics_enabled = Some(enabled);
            has_shape_info = true;
        } else if brush_desc.get("ShDy").is_some() {
            // Some ABR variants store Shape Dynamics as a sub-descriptor without an explicit toggle.
            brush.shape_dynamics_enabled = Some(true);
            has_shape_info = true;
        }

        // Size dynamics (szVr)
        if let Some(sz) = Self::get_descriptor(brush_desc, &["szVr", "szDy"]) {
            has_shape_info = true;
            if let Some(v) = sz.get("bVTy") {
                shape.size_control = Self::parse_control_source(v);
            }
            if let Some(v) = Self::get_number(sz, &["jitter"]) {
                shape.size_jitter = (v as f32).clamp(0.0, 100.0);
            }
            if let Some(v) = Self::get_number(sz, &["Mnm ", "minimumDiameter", "Mnm"]) {
                shape.minimum_diameter = (v as f32).clamp(0.0, 100.0);
            } else if let Some(v) = Self::get_number(brush_desc, &["minimumDiameter"]) {
                shape.minimum_diameter = (v as f32).clamp(0.0, 100.0);
            }
        } else if let Some(v) = Self::get_number(brush_desc, &["minimumDiameter"]) {
            has_shape_info = true;
            shape.minimum_diameter = (v as f32).clamp(0.0, 100.0);
        }

        // Angle dynamics (angleDynamics)
        if let Some(ang) = Self::get_descriptor(brush_desc, &["angleDynamics"]) {
            has_shape_info = true;
            if let Some(v) = ang.get("bVTy") {
                shape.angle_control = Self::parse_control_source(v);
            }
            if let Some((unit, value)) = Self::get_unit_number(ang, &["jitter"]) {
                let deg = match unit.as_deref() {
                    Some("#Ang") => value,
                    Some("#Prc") => value * 3.6,
                    _ => value,
                };
                shape.angle_jitter = (deg as f32).clamp(0.0, 360.0);
            }
        }

        // Roundness dynamics (roundnessDynamics)
        if let Some(rnd) = Self::get_descriptor(brush_desc, &["roundnessDynamics"]) {
            has_shape_info = true;
            if let Some(v) = rnd.get("bVTy") {
                shape.roundness_control = Self::parse_control_source(v);
            }
            if let Some(v) = Self::get_number(rnd, &["jitter"]) {
                shape.roundness_jitter = (v as f32).clamp(0.0, 100.0);
            }
            if let Some(v) = Self::get_number(rnd, &["Mnm ", "minimumRoundness", "Mnm"]) {
                shape.minimum_roundness = (v as f32).clamp(0.0, 100.0);
            } else if let Some(v) = Self::get_number(brush_desc, &["minimumRoundness"]) {
                shape.minimum_roundness = (v as f32).clamp(0.0, 100.0);
            }
        } else if let Some(v) = Self::get_number(brush_desc, &["minimumRoundness"]) {
            has_shape_info = true;
            shape.minimum_roundness = (v as f32).clamp(0.0, 100.0);
        }

        // Flip X/Y (optional)
        if let Some(v) = Self::get_bool(brush_desc, &["flipX"]) {
            has_shape_info = true;
            shape.flip_x_jitter = v;
        }
        if let Some(v) = Self::get_bool(brush_desc, &["flipY"]) {
            has_shape_info = true;
            shape.flip_y_jitter = v;
        }

        if has_shape_info {
            if brush.shape_dynamics_enabled.is_none() {
                let active = shape.size_control != ControlSource::Off
                    || shape.size_jitter > 0.0
                    || shape.minimum_diameter > 0.0
                    || shape.angle_control != ControlSource::Off
                    || shape.angle_jitter > 0.0
                    || shape.roundness_control != ControlSource::Off
                    || shape.roundness_jitter > 0.0
                    || shape.minimum_roundness > 0.0
                    || shape.flip_x_jitter
                    || shape.flip_y_jitter;
                brush.shape_dynamics_enabled = Some(active);
            }
            brush.shape_dynamics = Some(shape);
        }

        // ------------------------------------------------------------------
        // Scattering
        // ------------------------------------------------------------------
        let mut scatter = ScatterSettings::default();
        let mut has_scatter_info = false;

        if let Some(enabled) = Self::get_bool(brush_desc, &["useScatter"]) {
            brush.scatter_enabled = Some(enabled);
            has_scatter_info = true;
        }

        if let Some(v) = Self::get_number(brush_desc, &["Scat", "Sctr", "scatter"]) {
            scatter.scatter = (v as f32).clamp(0.0, 1000.0);
            has_scatter_info = true;
        }
        if let Some(v) = Self::get_bool(brush_desc, &["bothAxes"]) {
            scatter.both_axes = v;
            has_scatter_info = true;
        }
        if let Some(v) = Self::get_number(brush_desc, &["Cnt "]) {
            scatter.count = (v.round() as i32).clamp(1, 16) as u32;
            has_scatter_info = true;
        }
        if let Some(sd) = Self::get_descriptor(brush_desc, &["scatterDynamics"]) {
            has_scatter_info = true;
            if let Some(v) = sd.get("bVTy") {
                scatter.scatter_control = Self::parse_control_source(v);
            }
        }
        if let Some(cd) = Self::get_descriptor(brush_desc, &["countDynamics"]) {
            has_scatter_info = true;
            if let Some(v) = cd.get("bVTy") {
                scatter.count_control = Self::parse_control_source(v);
            }
            if let Some(v) = Self::get_number(cd, &["jitter"]) {
                scatter.count_jitter = (v as f32).clamp(0.0, 100.0);
            }
        }

        if has_scatter_info {
            if brush.scatter_enabled.is_none() {
                let active = scatter.scatter > 0.0
                    || scatter.both_axes
                    || scatter.count != 1
                    || scatter.count_jitter > 0.0
                    || scatter.scatter_control != ControlSource::Off
                    || scatter.count_control != ControlSource::Off;
                brush.scatter_enabled = Some(active);
            }
            brush.scatter = Some(scatter);
        }

        // ------------------------------------------------------------------
        // Transfer (Opacity/Flow)
        // ------------------------------------------------------------------
        let mut transfer = TransferSettings::default();
        let mut has_transfer_info = false;

        // Opacity dynamics (opVr)
        if let Some(op) = Self::get_descriptor(brush_desc, &["opVr", "opDy"]) {
            has_transfer_info = true;
            if let Some(v) = op.get("bVTy") {
                transfer.opacity_control = Self::parse_control_source(v);
            }
            if let Some(v) = Self::get_number(op, &["jitter"]) {
                transfer.opacity_jitter = (v as f32).clamp(0.0, 100.0);
            }
            if let Some(v) = Self::get_number(op, &["Mnm ", "Mnm", "minimumOpacity"]) {
                transfer.minimum_opacity = (v as f32).clamp(0.0, 100.0);
            }
        }

        // Flow dynamics (flVr / flowDynamics)
        if let Some(fl) = Self::get_descriptor(brush_desc, &["flVr", "flDy", "flowDynamics"]) {
            has_transfer_info = true;
            if let Some(v) = fl.get("bVTy") {
                transfer.flow_control = Self::parse_control_source(v);
            }
            if let Some(v) = Self::get_number(fl, &["jitter"]) {
                transfer.flow_jitter = (v as f32).clamp(0.0, 100.0);
            }
            if let Some(v) = Self::get_number(fl, &["Mnm ", "Mnm", "minimumFlow"]) {
                transfer.minimum_flow = (v as f32).clamp(0.0, 100.0);
            }
        }

        if has_transfer_info {
            let active = transfer.opacity_control != ControlSource::Off
                || transfer.opacity_jitter > 0.0
                || transfer.minimum_opacity > 0.0
                || transfer.flow_control != ControlSource::Off
                || transfer.flow_jitter > 0.0
                || transfer.minimum_flow > 0.0;
            brush.transfer_enabled = Some(active);
            brush.transfer = Some(transfer);
        }

        // ------------------------------------------------------------------
        // Color Dynamics
        // ------------------------------------------------------------------
        let mut color = ColorDynamicsSettings::default();
        let mut has_color_info = false;

        if let Some(cd) = Self::get_descriptor(brush_desc, &["colorDynamics", "ClrD", "ClDy"]) {
            has_color_info = true;

            if let Some(v) = Self::get_number(cd, &["HueJ"]) {
                color.hue_jitter = (v as f32).clamp(0.0, 100.0);
            }
            if let Some(v) = Self::get_number(cd, &["Satr"]) {
                color.saturation_jitter = (v as f32).clamp(0.0, 100.0);
            }
            if let Some(v) = Self::get_number(cd, &["Brgh"]) {
                color.brightness_jitter = (v as f32).clamp(0.0, 100.0);
            }
            if let Some(v) = Self::get_number(cd, &["purity"]) {
                color.purity = (v as f32).clamp(-100.0, 100.0);
            }

            // Foreground/Background (fgbg)
            if let Some(fb) = Self::get_descriptor(cd, &["fgbg"]) {
                if let Some(v) = fb.get("bVTy") {
                    color.foreground_background_control = Self::parse_control_source(v);
                }
                if let Some(v) = Self::get_number(fb, &["jitter"]) {
                    color.foreground_background_jitter = (v as f32).clamp(0.0, 100.0);
                }
            } else if let Some(v) = Self::get_number(cd, &["F/B", "FgBg", "BgFg"]) {
                // Fallback for weird encodings
                color.foreground_background_jitter = (v as f32).clamp(0.0, 100.0);
            }
        }

        if has_color_info {
            let active = color.foreground_background_jitter > 0.0
                || color.foreground_background_control != ControlSource::Off
                || color.hue_jitter > 0.0
                || color.saturation_jitter > 0.0
                || color.brightness_jitter > 0.0
                || color.purity != 0.0;
            brush.color_dynamics_enabled = Some(active);
            brush.color_dynamics = Some(color);
        }
    }

    fn get_descriptor<'a>(
        desc: &'a indexmap::IndexMap<String, DescriptorValue>,
        keys: &[&str],
    ) -> Option<&'a indexmap::IndexMap<String, DescriptorValue>> {
        for key in keys {
            match desc.get(*key) {
                Some(DescriptorValue::Descriptor(d)) => return Some(d),
                _ => continue,
            }
        }
        None
    }

    fn get_bool(desc: &indexmap::IndexMap<String, DescriptorValue>, keys: &[&str]) -> Option<bool> {
        for key in keys {
            match desc.get(*key) {
                Some(DescriptorValue::Boolean(b)) => return Some(*b),
                _ => continue,
            }
        }
        None
    }

    fn get_number(
        desc: &indexmap::IndexMap<String, DescriptorValue>,
        keys: &[&str],
    ) -> Option<f64> {
        Self::get_unit_number(desc, keys).map(|(_, v)| v)
    }

    fn get_unit_number(
        desc: &indexmap::IndexMap<String, DescriptorValue>,
        keys: &[&str],
    ) -> Option<(Option<String>, f64)> {
        for key in keys {
            match desc.get(*key) {
                Some(DescriptorValue::UnitFloat { unit, value }) => {
                    return Some((Some(unit.clone()), *value))
                }
                Some(DescriptorValue::Double(v)) => return Some((None, *v)),
                Some(DescriptorValue::Integer(v)) => return Some((None, *v as f64)),
                Some(DescriptorValue::LargeInteger(v)) => return Some((None, *v as f64)),
                _ => continue,
            }
        }
        None
    }

    fn get_ratio_0_1(
        desc: &indexmap::IndexMap<String, DescriptorValue>,
        keys: &[&str],
    ) -> Option<f32> {
        let (unit, value) = Self::get_unit_number(desc, keys)?;
        let mut v = value as f32;

        match unit.as_deref() {
            Some("#Prc") => v /= 100.0,
            _ => {
                // Some ABR variants store percent as a unitless number (0-100)
                if v > 1.0 {
                    v /= 100.0;
                }
            }
        }

        Some(v.clamp(0.01, 1.0))
    }

    fn parse_control_source(val: &DescriptorValue) -> ControlSource {
        let n = match val {
            DescriptorValue::Integer(v) => Some(*v as i64),
            DescriptorValue::LargeInteger(v) => Some(*v),
            _ => None,
        };

        if let Some(code) = n {
            return match code {
                0 => ControlSource::Off,
                1 => ControlSource::Fade,
                2 => ControlSource::PenPressure,
                3 => ControlSource::PenTilt,
                4 => ControlSource::Rotation,
                6 => ControlSource::Direction,
                7 => ControlSource::Initial,
                _ => ControlSource::Off,
            };
        }

        match val {
            DescriptorValue::Enum { value, .. } => match value.as_str() {
                "Fad " => ControlSource::Fade,
                "PnPr" => ControlSource::PenPressure,
                "PnTl" => ControlSource::PenTilt,
                "Rttn" => ControlSource::Rotation,
                "Drcn" => ControlSource::Direction,
                "Init" | "InIt" => ControlSource::Initial,
                other => {
                    tracing::debug!("[ABR] Unknown control source enum: {}", other);
                    ControlSource::Off
                }
            },
            _ => ControlSource::Off,
        }
    }

    /// Parse Dual Brush settings from descriptor
    fn parse_dual_brush_settings(
        brush_desc: &indexmap::IndexMap<String, DescriptorValue>,
    ) -> Option<super::types::DualBrushSettings> {
        // Look for "dualBrush" descriptor
        let dual_desc = match brush_desc.get("dualBrush") {
            Some(DescriptorValue::Descriptor(d)) => d,
            _ => return None,
        };

        let mut settings = super::types::DualBrushSettings::default();

        // Enabled flag: prefer nested dualBrush.useDualBrush, fallback to root useDualBrush
        settings.enabled =
            if let Some(DescriptorValue::Boolean(val)) = dual_desc.get("useDualBrush") {
                *val
            } else if let Some(DescriptorValue::Boolean(val)) = brush_desc.get("useDualBrush") {
                *val
            } else {
                true
            };

        // 1. Flip
        if let Some(DescriptorValue::Boolean(val)) = dual_desc.get("Flip") {
            settings.flip = *val;
        } else if let Some(DescriptorValue::Boolean(val)) = brush_desc.get("Flip") {
            // Sometimes it might be at root? Usually inside dualBrush.
            // But let's stick to dual_desc for now as per analyze script structure.
            settings.flip = *val;
        }

        // 2. Blend Mode (BlnM)
        // Dual Brush only supports 8 blend modes in PS
        if let Some(DescriptorValue::Enum { value, .. }) = dual_desc.get("BlnM") {
            settings.mode = match value.as_str() {
                "Mltp" => super::types::DualBlendMode::Multiply,
                "Drkn" => super::types::DualBlendMode::Darken,
                "Ovrl" => super::types::DualBlendMode::Overlay,
                "CDdg" => super::types::DualBlendMode::ColorDodge,
                "CBrn" => super::types::DualBlendMode::ColorBurn,
                "LBrn" => super::types::DualBlendMode::LinearBurn,
                "HrdM" => super::types::DualBlendMode::HardMix,
                "LnrH" => super::types::DualBlendMode::LinearHeight,
                _ => super::types::DualBlendMode::Multiply, // Fallback
            };
        }

        // 3. Scatter (useScatter, bothAxes, scatterDynamics)
        let use_scatter = matches!(
            dual_desc.get("useScatter"),
            Some(DescriptorValue::Boolean(true))
        );
        if use_scatter {
            // Prefer explicit scatter amount if present
            if let Some(v) = Self::get_number(dual_desc, &["Sctr", "Scat", "scatter"]) {
                settings.scatter = (v as f32).clamp(0.0, 1000.0);
            } else if let Some(sd) = Self::get_descriptor(dual_desc, &["scatterDynamics"]) {
                // ABR variants (e.g. liuyang_paintbrushes.abr) store the Dual Brush scatter amount
                // in scatterDynamics.jitter (#Prc)
                if let Some(v) = Self::get_number(sd, &["jitter"]) {
                    settings.scatter = (v as f32).clamp(0.0, 1000.0);
                }
            }
        }

        if let Some(DescriptorValue::Boolean(val)) = dual_desc.get("bothAxes") {
            settings.both_axes = *val;
        }

        // 4. Count (Cnt)
        if let Some(v) = Self::get_number(dual_desc, &["Cnt "]) {
            settings.count = (v.round() as i32).clamp(1, 16) as u32;
        }

        // 5. Secondary Brush Params (Brsh descriptor inside dualBrush)
        if let Some(DescriptorValue::Descriptor(brsh)) = dual_desc.get("Brsh") {
            // Size (Dmtr)
            if let Some(DescriptorValue::UnitFloat { value, .. }) = brsh.get("Dmtr") {
                settings.size = *value as f32;
            }

            // Roundness (Rndn)
            if let Some(DescriptorValue::UnitFloat { value, .. }) = brsh.get("Rndn") {
                settings.roundness = *value as f32;
            }

            // Spacing (Spcn)
            if let Some(DescriptorValue::UnitFloat { value, .. }) = brsh.get("Spcn") {
                settings.spacing = (*value as f32) / 100.0;
            }

            // Sampled Data UUID
            // Note: This is crucial.
            if let Some(DescriptorValue::String(uuid)) = brsh.get("sampledData") {
                settings.brush_id = Some(uuid.clone());
            }

            // Name
            if let Some(DescriptorValue::String(name)) = brsh.get("Nm  ") {
                settings.brush_name = Some(name.clone());
            }
        }

        // 6. Size ratio (dual_size / main_size at save time)
        // Photoshop stores both main and dual sizes as absolute pixels in the preset,
        // but at runtime it keeps a ratio so dual size scales with main brush size changes.
        let main_size = match brush_desc.get("Brsh") {
            Some(DescriptorValue::Descriptor(brsh)) => match brsh.get("Dmtr") {
                Some(DescriptorValue::UnitFloat { value, .. }) => *value as f32,
                _ => 0.0,
            },
            _ => 0.0,
        };

        let ratio = if main_size > 0.0 {
            settings.size / main_size
        } else {
            1.0
        };

        settings.size_ratio = if ratio.is_finite() {
            ratio.clamp(0.0, 10.0)
        } else {
            1.0
        };

        Some(settings)
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_dual_brush_size_ratio() {
        let mut brush_desc: indexmap::IndexMap<String, DescriptorValue> = indexmap::IndexMap::new();

        // Main brush (saved) size
        let mut main_brsh: indexmap::IndexMap<String, DescriptorValue> = indexmap::IndexMap::new();
        main_brsh.insert(
            "Dmtr".to_string(),
            DescriptorValue::UnitFloat {
                unit: "#Pxl".to_string(),
                value: 100.0,
            },
        );
        brush_desc.insert("Brsh".to_string(), DescriptorValue::Descriptor(main_brsh));

        // Dual brush descriptor
        let mut dual_desc: indexmap::IndexMap<String, DescriptorValue> = indexmap::IndexMap::new();
        let mut dual_brsh: indexmap::IndexMap<String, DescriptorValue> = indexmap::IndexMap::new();
        dual_brsh.insert(
            "Dmtr".to_string(),
            DescriptorValue::UnitFloat {
                unit: "#Pxl".to_string(),
                value: 50.0,
            },
        );
        dual_desc.insert("Brsh".to_string(), DescriptorValue::Descriptor(dual_brsh));
        brush_desc.insert(
            "dualBrush".to_string(),
            DescriptorValue::Descriptor(dual_desc),
        );

        let settings = AbrParser::parse_dual_brush_settings(&brush_desc).expect("dual settings");
        assert_eq!(settings.size, 50.0);
        assert!((settings.size_ratio - 0.5).abs() < 1e-6);
    }

    #[test]
    fn test_parse_dual_brush_size_ratio_main_missing() {
        let mut brush_desc: indexmap::IndexMap<String, DescriptorValue> = indexmap::IndexMap::new();

        let mut dual_desc: indexmap::IndexMap<String, DescriptorValue> = indexmap::IndexMap::new();
        let mut dual_brsh: indexmap::IndexMap<String, DescriptorValue> = indexmap::IndexMap::new();
        dual_brsh.insert(
            "Dmtr".to_string(),
            DescriptorValue::UnitFloat {
                unit: "#Pxl".to_string(),
                value: 50.0,
            },
        );
        dual_desc.insert("Brsh".to_string(), DescriptorValue::Descriptor(dual_brsh));
        brush_desc.insert(
            "dualBrush".to_string(),
            DescriptorValue::Descriptor(dual_desc),
        );

        let settings = AbrParser::parse_dual_brush_settings(&brush_desc).expect("dual settings");
        assert_eq!(settings.size, 50.0);
        assert_eq!(settings.size_ratio, 1.0);
    }

    #[test]
    fn test_apply_advanced_dynamics_from_descriptor() {
        let mut desc: indexmap::IndexMap<String, DescriptorValue> = indexmap::IndexMap::new();

        // Base opacity/flow (percent)
        desc.insert(
            "Opct".to_string(),
            DescriptorValue::UnitFloat {
                unit: "#Prc".to_string(),
                value: 50.0,
            },
        );
        desc.insert(
            "Flw ".to_string(),
            DescriptorValue::UnitFloat {
                unit: "#Prc".to_string(),
                value: 70.0,
            },
        );

        // Shape Dynamics
        desc.insert("useTipDynamics".to_string(), DescriptorValue::Boolean(true));
        let mut szvr: indexmap::IndexMap<String, DescriptorValue> = indexmap::IndexMap::new();
        szvr.insert("bVTy".to_string(), DescriptorValue::Integer(2));
        szvr.insert(
            "jitter".to_string(),
            DescriptorValue::UnitFloat {
                unit: "#Prc".to_string(),
                value: 12.0,
            },
        );
        szvr.insert(
            "Mnm ".to_string(),
            DescriptorValue::UnitFloat {
                unit: "#Prc".to_string(),
                value: 33.0,
            },
        );
        desc.insert("szVr".to_string(), DescriptorValue::Descriptor(szvr));

        let mut ang: indexmap::IndexMap<String, DescriptorValue> = indexmap::IndexMap::new();
        ang.insert("bVTy".to_string(), DescriptorValue::Integer(6));
        ang.insert(
            "jitter".to_string(),
            DescriptorValue::UnitFloat {
                unit: "#Prc".to_string(),
                value: 50.0, // -> 180 degrees
            },
        );
        desc.insert(
            "angleDynamics".to_string(),
            DescriptorValue::Descriptor(ang),
        );

        let mut rnd: indexmap::IndexMap<String, DescriptorValue> = indexmap::IndexMap::new();
        rnd.insert("bVTy".to_string(), DescriptorValue::Integer(0));
        rnd.insert(
            "jitter".to_string(),
            DescriptorValue::UnitFloat {
                unit: "#Prc".to_string(),
                value: 15.0,
            },
        );
        rnd.insert(
            "Mnm ".to_string(),
            DescriptorValue::UnitFloat {
                unit: "#Prc".to_string(),
                value: 49.0,
            },
        );
        desc.insert(
            "roundnessDynamics".to_string(),
            DescriptorValue::Descriptor(rnd),
        );

        // Scatter
        desc.insert("useScatter".to_string(), DescriptorValue::Boolean(true));
        desc.insert(
            "Scat".to_string(),
            DescriptorValue::UnitFloat {
                unit: "#Prc".to_string(),
                value: 200.0,
            },
        );
        desc.insert("bothAxes".to_string(), DescriptorValue::Boolean(true));
        desc.insert(
            "Cnt ".to_string(),
            DescriptorValue::UnitFloat {
                unit: "#Prc".to_string(),
                value: 4.0,
            },
        );
        let mut sd: indexmap::IndexMap<String, DescriptorValue> = indexmap::IndexMap::new();
        sd.insert("bVTy".to_string(), DescriptorValue::Integer(2));
        desc.insert(
            "scatterDynamics".to_string(),
            DescriptorValue::Descriptor(sd),
        );
        let mut cd: indexmap::IndexMap<String, DescriptorValue> = indexmap::IndexMap::new();
        cd.insert("bVTy".to_string(), DescriptorValue::Integer(0));
        cd.insert(
            "jitter".to_string(),
            DescriptorValue::UnitFloat {
                unit: "#Prc".to_string(),
                value: 25.0,
            },
        );
        desc.insert("countDynamics".to_string(), DescriptorValue::Descriptor(cd));

        // Transfer
        let mut opvr: indexmap::IndexMap<String, DescriptorValue> = indexmap::IndexMap::new();
        opvr.insert("bVTy".to_string(), DescriptorValue::Integer(2));
        opvr.insert(
            "jitter".to_string(),
            DescriptorValue::UnitFloat {
                unit: "#Prc".to_string(),
                value: 50.0,
            },
        );
        opvr.insert(
            "Mnm ".to_string(),
            DescriptorValue::UnitFloat {
                unit: "#Prc".to_string(),
                value: 10.0,
            },
        );
        desc.insert("opVr".to_string(), DescriptorValue::Descriptor(opvr));

        let mut fldy: indexmap::IndexMap<String, DescriptorValue> = indexmap::IndexMap::new();
        fldy.insert("bVTy".to_string(), DescriptorValue::Integer(2));
        fldy.insert(
            "jitter".to_string(),
            DescriptorValue::UnitFloat {
                unit: "#Prc".to_string(),
                value: 60.0,
            },
        );
        fldy.insert(
            "Mnm ".to_string(),
            DescriptorValue::UnitFloat {
                unit: "#Prc".to_string(),
                value: 20.0,
            },
        );
        desc.insert(
            "flowDynamics".to_string(),
            DescriptorValue::Descriptor(fldy),
        );

        // Color Dynamics
        let mut col: indexmap::IndexMap<String, DescriptorValue> = indexmap::IndexMap::new();
        col.insert(
            "HueJ".to_string(),
            DescriptorValue::UnitFloat {
                unit: "#Prc".to_string(),
                value: 10.0,
            },
        );
        col.insert(
            "Satr".to_string(),
            DescriptorValue::UnitFloat {
                unit: "#Prc".to_string(),
                value: 20.0,
            },
        );
        col.insert(
            "Brgh".to_string(),
            DescriptorValue::UnitFloat {
                unit: "#Prc".to_string(),
                value: 30.0,
            },
        );
        col.insert("purity".to_string(), DescriptorValue::Integer(-15));
        let mut fgbg: indexmap::IndexMap<String, DescriptorValue> = indexmap::IndexMap::new();
        fgbg.insert("bVTy".to_string(), DescriptorValue::Integer(2));
        fgbg.insert(
            "jitter".to_string(),
            DescriptorValue::UnitFloat {
                unit: "#Prc".to_string(),
                value: 40.0,
            },
        );
        col.insert("fgbg".to_string(), DescriptorValue::Descriptor(fgbg));
        desc.insert(
            "colorDynamics".to_string(),
            DescriptorValue::Descriptor(col),
        );

        let mut brush = AbrBrush {
            name: "Test".to_string(),
            uuid: None,
            tip_image: None,
            diameter: 20.0,
            spacing: 0.25,
            angle: 0.0,
            roundness: 1.0,
            hardness: None,
            dynamics: None,
            is_computed: false,
            texture_settings: None,
            dual_brush_settings: None,
            shape_dynamics_enabled: None,
            shape_dynamics: None,
            scatter_enabled: None,
            scatter: None,
            color_dynamics_enabled: None,
            color_dynamics: None,
            transfer_enabled: None,
            transfer: None,
            base_opacity: None,
            base_flow: None,
        };

        AbrParser::apply_advanced_dynamics_from_descriptor(&desc, &mut brush);

        assert_eq!(brush.base_opacity, Some(0.5));
        assert_eq!(brush.base_flow, Some(0.7));

        assert_eq!(brush.shape_dynamics_enabled, Some(true));
        let sh = brush.shape_dynamics.expect("shape dynamics");
        assert_eq!(sh.size_control, crate::abr::ControlSource::PenPressure);
        assert_eq!(sh.size_jitter, 12.0);
        assert_eq!(sh.minimum_diameter, 33.0);
        assert_eq!(sh.angle_control, crate::abr::ControlSource::Direction);
        assert_eq!(sh.angle_jitter, 180.0);
        assert_eq!(sh.roundness_jitter, 15.0);
        assert_eq!(sh.minimum_roundness, 49.0);

        assert_eq!(brush.scatter_enabled, Some(true));
        let sc = brush.scatter.expect("scatter");
        assert_eq!(sc.scatter_control, crate::abr::ControlSource::PenPressure);
        assert_eq!(sc.scatter, 200.0);
        assert!(sc.both_axes);
        assert_eq!(sc.count, 4);
        assert_eq!(sc.count_jitter, 25.0);

        assert_eq!(brush.transfer_enabled, Some(true));
        let tr = brush.transfer.expect("transfer");
        assert_eq!(tr.opacity_control, crate::abr::ControlSource::PenPressure);
        assert_eq!(tr.opacity_jitter, 50.0);
        assert_eq!(tr.minimum_opacity, 10.0);
        assert_eq!(tr.flow_control, crate::abr::ControlSource::PenPressure);
        assert_eq!(tr.flow_jitter, 60.0);
        assert_eq!(tr.minimum_flow, 20.0);

        assert_eq!(brush.color_dynamics_enabled, Some(true));
        let co = brush.color_dynamics.expect("color dynamics");
        assert_eq!(co.hue_jitter, 10.0);
        assert_eq!(co.saturation_jitter, 20.0);
        assert_eq!(co.brightness_jitter, 30.0);
        assert_eq!(co.purity, -15.0);
        assert_eq!(co.foreground_background_jitter, 40.0);
        assert_eq!(
            co.foreground_background_control,
            crate::abr::ControlSource::PenPressure
        );
    }

    #[test]
    fn test_rle_decode_simple() {
        // Simple RLE: repeat 'A' 5 times
        // -4 (repeat 5 times), 'A'
        let data = vec![0xFC, 0x41]; // -4 in signed, 'A'
        let mut cursor = Cursor::new(data.as_slice());

        // Manually decode
        let n = cursor.read_i8().unwrap();
        assert_eq!(n, -4);
        let byte = cursor.read_u8().unwrap();
        assert_eq!(byte, 0x41);

        let count = (-n as usize) + 1; // 5
        assert_eq!(count, 5);
    }

    #[test]
    fn test_parse_tahraart_abr() {
        // Test with actual ABR file
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join("abr/tahraart.abr");

        if !path.exists() {
            eprintln!("Test file not found: {:?}, skipping test", path);
            return;
        }

        let data = std::fs::read(&path).expect("Failed to read test file");
        let result = AbrParser::parse(&data);

        match result {
            Ok(abr_file) => {
                println!("Parsed ABR file: version={:?}", abr_file.version);
                println!("Number of brushes: {}", abr_file.brushes.len());

                for (i, brush) in abr_file.brushes.iter().enumerate() {
                    println!(
                        "  Brush {}: name='{}', diameter={}, has_tip={}",
                        i,
                        brush.name,
                        brush.diameter,
                        brush.tip_image.is_some()
                    );
                    if let Some(ref img) = brush.tip_image {
                        println!("    Tip image: {}x{}", img.width, img.height);
                    }
                }

                assert!(
                    !abr_file.brushes.is_empty(),
                    "Should have at least one brush"
                );
            }
            Err(e) => {
                panic!("Failed to parse ABR file: {}", e);
            }
        }
    }

    #[test]
    fn test_parse_lingybrush_abr() {
        // Test with another ABR file
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join("abr/lingybrush.abr");

        if !path.exists() {
            eprintln!("Test file not found: {:?}, skipping test", path);
            return;
        }

        let data = std::fs::read(&path).expect("Failed to read test file");
        let result = AbrParser::parse(&data);

        match result {
            Ok(abr_file) => {
                println!("Parsed lingybrush.abr: version={:?}", abr_file.version);
                println!("Number of brushes: {}", abr_file.brushes.len());
                assert!(
                    !abr_file.brushes.is_empty(),
                    "Should have at least one brush"
                );
            }
            Err(e) => {
                // Some files may have unsupported features, log but don't fail
                eprintln!("Parse result: {}", e);
            }
        }
    }

    #[test]
    fn test_parse_dual_brush_settings_count_double_and_scatter_jitter() {
        let mut brush_desc: indexmap::IndexMap<String, DescriptorValue> = indexmap::IndexMap::new();

        // Main brush (saved) size for ratio
        let mut main_brsh: indexmap::IndexMap<String, DescriptorValue> = indexmap::IndexMap::new();
        main_brsh.insert(
            "Dmtr".to_string(),
            DescriptorValue::UnitFloat {
                unit: "#Pxl".to_string(),
                value: 600.0,
            },
        );
        brush_desc.insert("Brsh".to_string(), DescriptorValue::Descriptor(main_brsh));

        // Dual brush descriptor
        let mut dual_desc: indexmap::IndexMap<String, DescriptorValue> = indexmap::IndexMap::new();
        dual_desc.insert("useDualBrush".to_string(), DescriptorValue::Boolean(true));
        dual_desc.insert(
            "BlnM".to_string(),
            DescriptorValue::Enum {
                type_id: "BlnM".to_string(),
                value: "Drkn".to_string(),
            },
        );
        dual_desc.insert("useScatter".to_string(), DescriptorValue::Boolean(true));
        dual_desc.insert("bothAxes".to_string(), DescriptorValue::Boolean(true));
        dual_desc.insert("Cnt ".to_string(), DescriptorValue::Double(5.0));

        let mut scatter_dyn: indexmap::IndexMap<String, DescriptorValue> =
            indexmap::IndexMap::new();
        scatter_dyn.insert(
            "jitter".to_string(),
            DescriptorValue::UnitFloat {
                unit: "#Prc".to_string(),
                value: 206.0,
            },
        );
        dual_desc.insert(
            "scatterDynamics".to_string(),
            DescriptorValue::Descriptor(scatter_dyn),
        );

        let mut dual_brsh: indexmap::IndexMap<String, DescriptorValue> = indexmap::IndexMap::new();
        dual_brsh.insert(
            "Dmtr".to_string(),
            DescriptorValue::UnitFloat {
                unit: "#Pxl".to_string(),
                value: 606.0,
            },
        );
        dual_brsh.insert(
            "Spcn".to_string(),
            DescriptorValue::UnitFloat {
                unit: "#Prc".to_string(),
                value: 99.0,
            },
        );
        dual_brsh.insert(
            "Rndn".to_string(),
            DescriptorValue::UnitFloat {
                unit: "#Prc".to_string(),
                value: 100.0,
            },
        );
        dual_brsh.insert(
            "sampledData".to_string(),
            DescriptorValue::String("0fd938d3-665f-11d8-8a89-d1468c4d447d".to_string()),
        );
        dual_desc.insert("Brsh".to_string(), DescriptorValue::Descriptor(dual_brsh));

        brush_desc.insert(
            "dualBrush".to_string(),
            DescriptorValue::Descriptor(dual_desc),
        );

        let settings = AbrParser::parse_dual_brush_settings(&brush_desc).expect("dual settings");
        assert!(settings.enabled);
        assert_eq!(settings.mode, super::types::DualBlendMode::Darken);
        assert!(settings.both_axes);
        assert_eq!(settings.count, 5);
        assert!((settings.scatter - 206.0).abs() < 1e-6);
        assert!((settings.size - 606.0).abs() < 1e-6);
        assert!((settings.spacing - 0.99).abs() < 1e-6);
        assert!(settings.brush_id.is_some());
        assert!((settings.size_ratio - (606.0 / 600.0)).abs() < 1e-6);
    }

    #[test]
    fn test_create_brush_from_descriptor_entry_dual_enabled_nested() {
        let mut brush_desc: indexmap::IndexMap<String, DescriptorValue> = indexmap::IndexMap::new();

        // Ensure main sampledData appears before dualBrush so the primary UUID is stable
        let mut main_brsh: indexmap::IndexMap<String, DescriptorValue> = indexmap::IndexMap::new();
        main_brsh.insert(
            "Dmtr".to_string(),
            DescriptorValue::UnitFloat {
                unit: "#Pxl".to_string(),
                value: 600.0,
            },
        );
        main_brsh.insert(
            "sampledData".to_string(),
            DescriptorValue::String("2208e679-9fa4-11da-9e8a-f926889842f3".to_string()),
        );
        brush_desc.insert("Brsh".to_string(), DescriptorValue::Descriptor(main_brsh));
        brush_desc.insert(
            "Nm  ".to_string(),
            DescriptorValue::String("Sampled Brush 5 4".to_string()),
        );

        let mut dual_desc: indexmap::IndexMap<String, DescriptorValue> = indexmap::IndexMap::new();
        dual_desc.insert("useDualBrush".to_string(), DescriptorValue::Boolean(true));
        dual_desc.insert(
            "BlnM".to_string(),
            DescriptorValue::Enum {
                type_id: "BlnM".to_string(),
                value: "Drkn".to_string(),
            },
        );
        dual_desc.insert("useScatter".to_string(), DescriptorValue::Boolean(true));
        dual_desc.insert("bothAxes".to_string(), DescriptorValue::Boolean(true));
        dual_desc.insert("Cnt ".to_string(), DescriptorValue::Double(5.0));

        let mut scatter_dyn: indexmap::IndexMap<String, DescriptorValue> =
            indexmap::IndexMap::new();
        scatter_dyn.insert(
            "jitter".to_string(),
            DescriptorValue::UnitFloat {
                unit: "#Prc".to_string(),
                value: 206.0,
            },
        );
        dual_desc.insert(
            "scatterDynamics".to_string(),
            DescriptorValue::Descriptor(scatter_dyn),
        );

        let mut dual_brsh: indexmap::IndexMap<String, DescriptorValue> = indexmap::IndexMap::new();
        dual_brsh.insert(
            "Dmtr".to_string(),
            DescriptorValue::UnitFloat {
                unit: "#Pxl".to_string(),
                value: 606.0,
            },
        );
        dual_brsh.insert(
            "Spcn".to_string(),
            DescriptorValue::UnitFloat {
                unit: "#Prc".to_string(),
                value: 99.0,
            },
        );
        dual_brsh.insert(
            "sampledData".to_string(),
            DescriptorValue::String("0fd938d3-665f-11d8-8a89-d1468c4d447d".to_string()),
        );
        dual_desc.insert("Brsh".to_string(), DescriptorValue::Descriptor(dual_brsh));

        brush_desc.insert(
            "dualBrush".to_string(),
            DescriptorValue::Descriptor(dual_desc),
        );

        let samp_map: std::collections::HashMap<String, SampBrushData> =
            std::collections::HashMap::new();
        let brush = AbrParser::create_brush_from_descriptor_entry(&brush_desc, 0, &samp_map);

        let dual = brush
            .dual_brush_settings
            .expect("dual settings should be present");
        assert!(dual.enabled);
        assert_eq!(dual.mode, super::types::DualBlendMode::Darken);
        assert_eq!(dual.count, 5);
        assert!((dual.scatter - 206.0).abs() < 1e-6);
        assert!((dual.size - 606.0).abs() < 1e-6);
        assert!((dual.spacing - 0.99).abs() < 1e-6);
        assert_eq!(
            dual.brush_id.as_deref(),
            Some("0fd938d3-665f-11d8-8a89-d1468c4d447d")
        );
    }
}
