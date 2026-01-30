//! PSD format type definitions
//!
//! Core data structures for reading and writing Adobe Photoshop files.
//! All values use Big-Endian byte order as per PSD specification.

use byteorder::{BigEndian, WriteBytesExt};
use std::io::{self, Write};

/// PSD file signature
pub const PSD_SIGNATURE: &[u8; 4] = b"8BPS";

/// PSD color modes
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u16)]
#[allow(dead_code)] // Reserved for extended color mode support
pub enum ColorMode {
    Bitmap = 0,
    Grayscale = 1,
    Indexed = 2,
    Rgb = 3,
    Cmyk = 4,
    Multichannel = 7,
    Duotone = 8,
    Lab = 9,
}

/// PSD file header (26 bytes, Big-Endian)
///
/// Structure:
/// - Signature: 4 bytes ("8BPS")
/// - Version: 2 bytes (1 = PSD, 2 = PSB)
/// - Reserved: 6 bytes (must be zero)
/// - Channels: 2 bytes (1-56)
/// - Height: 4 bytes (1-30000 for PSD, 1-300000 for PSB)
/// - Width: 4 bytes (1-30000 for PSD, 1-300000 for PSB)
/// - Depth: 2 bytes (1, 8, 16, or 32)
/// - Color mode: 2 bytes
#[derive(Debug, Clone)]
pub struct PsdHeader {
    pub version: u16,
    pub channels: u16,
    pub height: u32,
    pub width: u32,
    pub depth: u16,
    pub color_mode: u16,
}

impl PsdHeader {
    /// Header size in bytes
    #[allow(dead_code)] // Used in tests and future PSD reading
    pub const SIZE: usize = 26;

    /// Create a new PSD header for RGBA image
    pub fn new_rgba(width: u32, height: u32) -> Self {
        Self {
            version: 1, // PSD format
            channels: 4,
            height,
            width,
            depth: 8,
            color_mode: ColorMode::Rgb as u16,
        }
    }

    /// Write header to output
    pub fn write<W: Write>(&self, w: &mut W) -> io::Result<()> {
        w.write_all(PSD_SIGNATURE)?;
        w.write_u16::<BigEndian>(self.version)?;
        w.write_all(&[0u8; 6])?; // Reserved
        w.write_u16::<BigEndian>(self.channels)?;
        w.write_u32::<BigEndian>(self.height)?;
        w.write_u32::<BigEndian>(self.width)?;
        w.write_u16::<BigEndian>(self.depth)?;
        w.write_u16::<BigEndian>(self.color_mode)?;
        Ok(())
    }
}

/// Channel information in layer record
#[derive(Debug, Clone)]
pub struct ChannelInfo {
    /// Channel ID: -1=transparency, 0=red, 1=green, 2=blue
    pub id: i16,
    /// Length of channel data (including compression marker)
    pub data_length: u32,
}

impl ChannelInfo {
    /// Size of channel info record (2 + 4 = 6 bytes)
    #[allow(dead_code)] // Reserved for PSD reading
    pub const SIZE: usize = 6;

    pub fn write<W: Write>(&self, w: &mut W) -> io::Result<()> {
        w.write_i16::<BigEndian>(self.id)?;
        w.write_u32::<BigEndian>(self.data_length)?;
        Ok(())
    }
}

/// Layer record flags
#[derive(Debug, Clone, Copy, Default)]
pub struct LayerFlags {
    pub transparency_protected: bool,
    pub visible: bool,
    pub obsolete: bool,
    pub has_useful_info: bool,
    pub pixel_data_irrelevant: bool,
}

impl LayerFlags {
    pub fn to_byte(self) -> u8 {
        let mut flags = 0u8;
        if self.transparency_protected {
            flags |= 0x01;
        }
        if !self.visible {
            flags |= 0x02; // Note: bit set = hidden
        }
        if self.obsolete {
            flags |= 0x04;
        }
        if self.has_useful_info {
            flags |= 0x08;
        }
        if self.pixel_data_irrelevant {
            flags |= 0x10;
        }
        flags
    }

    #[allow(dead_code)] // Reserved for PSD reading
    pub fn from_byte(b: u8) -> Self {
        Self {
            transparency_protected: (b & 0x01) != 0,
            visible: (b & 0x02) == 0, // Note: bit clear = visible
            obsolete: (b & 0x04) != 0,
            has_useful_info: (b & 0x08) != 0,
            pixel_data_irrelevant: (b & 0x10) != 0,
        }
    }
}

/// Prepared layer data for writing
#[derive(Debug)]
pub struct PreparedLayer {
    pub name: String,
    pub top: i32,
    pub left: i32,
    pub bottom: i32,
    pub right: i32,
    pub opacity: u8,
    pub blend_mode: [u8; 4],
    pub flags: LayerFlags,
    pub channels: Vec<PreparedChannel>,
}

/// Prepared channel data (pre-compressed)
#[derive(Debug)]
pub struct PreparedChannel {
    pub id: i16,
    /// RLE row byte counts (one per row)
    pub row_counts: Vec<u16>,
    /// Compressed channel data (all rows concatenated)
    pub compressed_data: Vec<u8>,
}

impl PreparedChannel {
    /// Calculate total data length including compression marker and row counts
    pub fn data_length(&self) -> u32 {
        // 2 bytes compression + (2 bytes per row count) + compressed data
        2 + (self.row_counts.len() as u32 * 2) + self.compressed_data.len() as u32
    }
}

/// Image resource IDs
#[derive(Debug, Clone, Copy)]
#[repr(u16)]
#[allow(dead_code)]
pub enum ImageResourceId {
    ResolutionInfo = 0x03ED,
    AlphaChannelNames = 0x03EE,
    PrintFlags = 0x03F3,
    ColorHalftoningInfo = 0x03F5,
    ColorTransferFunctions = 0x03F6,
    LayerStateInfo = 0x0400,
    LayersGroupInfo = 0x0402,
    IccProfile = 0x040F,
    IccUntaggedProfile = 0x0410,
    IdSeedNumber = 0x0414,
    ThumbnailResource = 0x0409,
    VersionInfo = 0x0421,
    ExifData1 = 0x0422,
    XmpMetadata = 0x0424,
}

/// Resolution info resource (0x03ED)
#[derive(Debug, Clone)]
pub struct ResolutionInfo {
    /// Horizontal resolution in pixels per inch (fixed point 16.16)
    pub h_res: u32,
    /// Display unit for h_res (1 = pixels/inch, 2 = pixels/cm)
    pub h_res_unit: u16,
    /// Width unit (1 = inches, 2 = cm, 3 = points, 4 = picas, 5 = columns)
    pub width_unit: u16,
    /// Vertical resolution in pixels per inch (fixed point 16.16)
    pub v_res: u32,
    /// Display unit for v_res
    pub v_res_unit: u16,
    /// Height unit
    pub height_unit: u16,
}

impl ResolutionInfo {
    /// Size in bytes
    #[allow(dead_code)] // Used in tests and future PSD reading
    pub const SIZE: usize = 16;

    /// Create resolution info with DPI
    pub fn new(dpi: u32) -> Self {
        Self {
            h_res: dpi << 16, // Fixed point 16.16
            h_res_unit: 1,    // pixels/inch
            width_unit: 1,    // inches
            v_res: dpi << 16,
            v_res_unit: 1,
            height_unit: 1,
        }
    }

    pub fn write<W: Write>(&self, w: &mut W) -> io::Result<()> {
        w.write_u32::<BigEndian>(self.h_res)?;
        w.write_u16::<BigEndian>(self.h_res_unit)?;
        w.write_u16::<BigEndian>(self.width_unit)?;
        w.write_u32::<BigEndian>(self.v_res)?;
        w.write_u16::<BigEndian>(self.v_res_unit)?;
        w.write_u16::<BigEndian>(self.height_unit)?;
        Ok(())
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn test_header_size() {
        let header = PsdHeader::new_rgba(100, 100);
        let mut buf = Vec::new();
        header.write(&mut buf).unwrap();
        assert_eq!(buf.len(), PsdHeader::SIZE);
    }

    #[test]
    fn test_header_signature() {
        let header = PsdHeader::new_rgba(1920, 1080);
        let mut buf = Vec::new();
        header.write(&mut buf).unwrap();
        assert_eq!(&buf[0..4], b"8BPS");
    }

    #[test]
    fn test_layer_flags() {
        let flags = LayerFlags {
            visible: true,
            ..Default::default()
        };
        assert_eq!(flags.to_byte(), 0x00); // visible = bit 1 clear

        let flags = LayerFlags {
            visible: false,
            ..Default::default()
        };
        assert_eq!(flags.to_byte(), 0x02); // hidden = bit 1 set
    }

    #[test]
    fn test_resolution_info() {
        let res = ResolutionInfo::new(72);
        let mut buf = Vec::new();
        res.write(&mut buf).unwrap();
        assert_eq!(buf.len(), ResolutionInfo::SIZE);
    }
}
