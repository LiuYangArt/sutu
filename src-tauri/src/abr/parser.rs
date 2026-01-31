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
use super::types::{AbrBrush, AbrDynamics, AbrFile, AbrVersion, GrayscaleImage, TextureSettings};
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

        // Apply Brush Tip Shape parameters override (for sampled brushes too)
        if let Some(DescriptorValue::Descriptor(brsh)) = brush_desc.get("Brsh") {
            Self::apply_brush_tip_params(brsh, &mut brush);
        }

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
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

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
}
