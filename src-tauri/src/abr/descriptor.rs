//! Photoshop Action Descriptor Parser
//!
//! Parses the binary descriptor format used in ABR files for brush settings.
//! Based on reverse-engineering of ABR format and Photoshop scripting specifications.

use super::error::AbrError;
use byteorder::{BigEndian, ReadBytesExt};
use std::collections::HashMap;
use std::io::{Cursor, Read};

/// Descriptor value types
#[derive(Debug, Clone)]
pub enum DescriptorValue {
    Descriptor(HashMap<String, DescriptorValue>),
    List(Vec<DescriptorValue>),
    Double(f64),
    UnitFloat {
        unit: String,
        value: f64,
    },
    String(String),
    Boolean(bool),
    Integer(i32),
    LargeInteger(i64),
    Enum {
        type_id: String,
        value: String,
    }, // TypeID, EnumValue
    Class {
        name: String,
        class_id: String,
    },
    Alias(String),
    Object {
        type_id: String,
        value: Box<DescriptorValue>,
    },
    RawData(Vec<u8>),
    Reference, // Placeholder for object references
}

/// Helper to read a 4-byte key (often OSType or Key ID)
fn read_key(cursor: &mut Cursor<&[u8]>) -> Result<String, AbrError> {
    let len = cursor.read_u32::<BigEndian>()?;
    if len == 0 {
        // 4-byte key
        let mut key = [0u8; 4];
        cursor.read_exact(&mut key)?;
        Ok(String::from_utf8_lossy(&key).to_string())
    } else {
        // Variable length key
        let mut key = vec![0u8; len as usize];
        cursor.read_exact(&mut key)?;
        Ok(String::from_utf8_lossy(&key).to_string())
    }
}

/// Helper to read a 4-byte type identifier
fn read_type(cursor: &mut Cursor<&[u8]>) -> Result<String, AbrError> {
    let mut type_id = [0u8; 4];
    cursor.read_exact(&mut type_id)?;
    Ok(String::from_utf8_lossy(&type_id).to_string())
}

/// Helper to read a unicode string (UCS-2)
fn read_unicode_string(cursor: &mut Cursor<&[u8]>) -> Result<String, AbrError> {
    let len = cursor.read_u32::<BigEndian>()?;
    let mut utf16 = Vec::with_capacity(len as usize);
    for _ in 0..len {
        utf16.push(cursor.read_u16::<BigEndian>()?);
    }
    // Remove null terminator if present
    if let Some(&0) = utf16.last() {
        utf16.pop();
    }
    String::from_utf16(&utf16).map_err(|e| AbrError::StringDecode(e.to_string()))
}

/// Parse a descriptor from the cursor
pub fn parse_descriptor(
    cursor: &mut Cursor<&[u8]>,
) -> Result<HashMap<String, DescriptorValue>, AbrError> {
    // Version check (usually 16)
    let version = cursor.read_u32::<BigEndian>()?;
    if version != 16 {
        // Some descriptors might be embedded without version if inside another structure,
        // but ABR top-level descriptors usually have it.
        // Let's assume valid for now or return error.
        return Err(AbrError::InvalidFormat(format!(
            "Unknown descriptor version: {}",
            version
        )));
    }

    // Name/Class ID
    let _name = read_unicode_string(cursor)?;
    let _class_id = read_key(cursor)?;

    let count = cursor.read_u32::<BigEndian>()?;
    let mut items = HashMap::new();

    for _ in 0..count {
        let key = read_key(cursor)?;
        let value_type = read_type(cursor)?;
        let value = parse_value(cursor, &value_type)?;
        items.insert(key, value);
    }

    Ok(items)
}

/// Parse a value based on its type code
fn parse_value(cursor: &mut Cursor<&[u8]>, value_type: &str) -> Result<DescriptorValue, AbrError> {
    match value_type {
        "Objc" => {
            // Descriptor (Object)
            // Descriptor nested structure is basically the same but without version sometimes?
            // Actually spec says:
            // 4 bytes: Descriptor Version (16)
            // Unicode string: Name
            // Variable: Class ID
            // 4 bytes: Number of items
            // ... items
            // So it calls recursively.
            let desc = parse_descriptor(cursor)?;
            Ok(DescriptorValue::Descriptor(desc))
        }
        "GlbO" | "GlbC" => {
            // Global Object / Class
            let desc = parse_descriptor(cursor)?;
            Ok(DescriptorValue::Descriptor(desc))
        }
        "VlLs" => {
            // List
            let count = cursor.read_u32::<BigEndian>()?;
            let mut list = Vec::new();
            for _ in 0..count {
                let item_type = read_type(cursor)?;
                list.push(parse_value(cursor, &item_type)?);
            }
            Ok(DescriptorValue::List(list))
        }
        "Doub" => {
            // Double
            Ok(DescriptorValue::Double(cursor.read_f64::<BigEndian>()?))
        }
        "UntF" => {
            // Unit Float
            let unit = read_type(cursor)?; // e.g. '#Prc' (percent), '#Pxl' (pixels)
            let value = cursor.read_f64::<BigEndian>()?;
            Ok(DescriptorValue::UnitFloat { unit, value })
        }
        "TEXT" => {
            // String
            Ok(DescriptorValue::String(read_unicode_string(cursor)?))
        }
        "bool" => {
            // Boolean
            Ok(DescriptorValue::Boolean(cursor.read_u8()? != 0))
        }
        "long" => {
            // Integer
            Ok(DescriptorValue::Integer(cursor.read_i32::<BigEndian>()?))
        }
        "Comp" => {
            // Large Integer
            Ok(DescriptorValue::LargeInteger(
                cursor.read_i64::<BigEndian>()?,
            ))
        }
        "enum" => {
            // Enumeration
            let type_id = read_key(cursor)?;
            let value = read_key(cursor)?;
            Ok(DescriptorValue::Enum { type_id, value })
        }
        "type" => {
            // Class
            let name = read_unicode_string(cursor)?;
            let class_id = read_key(cursor)?;
            Ok(DescriptorValue::Class { name, class_id })
        }
        "obj " => {
            // Reference
            // References are complex, usually just parse class/prop/enum/offset
            // For now, scan reference structure (usually consists of 4 bytes count + items)
            // This is a simplified skip/placeholder
            let count = cursor.read_u32::<BigEndian>()?;
            for _ in 0..count {
                let _ref_type = read_type(cursor)?;
                // This is too complex to implement fully without needing it.
                // ABR brushes usually don't rely heavily on complex references for basic settings.
                // We might crash here if we don't consume bytes correctly.
                // Let's implement minimal consumption for common types
                match _ref_type.as_str() {
                    "prop" => {
                        let _class = read_unicode_string(cursor)?;
                        let _key = read_key(cursor)?;
                        let _id = read_key(cursor)?;
                    }
                    "Clss" => {
                        let _name = read_unicode_string(cursor)?;
                        let _key = read_key(cursor)?;
                    }
                    "Enmr" => {
                        let _class = read_unicode_string(cursor)?;
                        let _key = read_key(cursor)?;
                        let _id = read_key(cursor)?;
                        let _enum_val = read_key(cursor)?;
                    }
                    _ => {
                        // Fallback: try to guess or fail?
                        // References are rare in brush presets.
                        tracing::warn!("Skipping unknown reference type: {}", _ref_type);
                    }
                }
            }
            Ok(DescriptorValue::Reference)
        }
        "tdta" => {
            // Raw Data
            let len = cursor.read_u32::<BigEndian>()?;
            let mut data = vec![0u8; len as usize];
            cursor.read_exact(&mut data)?;
            Ok(DescriptorValue::RawData(data))
        }
        _ => Err(AbrError::InvalidFormat(format!(
            "Unknown descriptor value type: {}",
            value_type
        ))),
    }
}
