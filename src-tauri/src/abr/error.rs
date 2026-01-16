//! ABR parsing error types

use std::io;
use thiserror::Error;

/// Errors that can occur during ABR file parsing
#[derive(Error, Debug)]
pub enum AbrError {
    #[error("IO error: {0}")]
    Io(#[from] io::Error),

    #[error("Invalid ABR file: {0}")]
    InvalidFile(String),

    #[error("Unsupported ABR version: {0}")]
    UnsupportedVersion(u16),

    #[error("Invalid 8BIM block")]
    Invalid8BIMBlock,

    #[error("Unexpected end of data")]
    UnexpectedEof,

    #[error("String decoding error: {0}")]
    StringDecode(String),

    #[error("Parse error: {0}")]
    Parse(String),
}

impl From<AbrError> for String {
    fn from(err: AbrError) -> Self {
        err.to_string()
    }
}
