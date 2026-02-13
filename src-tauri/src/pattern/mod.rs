//! Pattern Library module
//!
//! Provides pattern resource management for the application:
//! - Pattern storage and retrieval (Content-Addressable Storage)
//! - .pat file import
//! - ABR pattern integration

pub mod library;
pub mod pat;
pub mod types;

pub use library::PatternLibrary;
pub use pat::parse_pat_file;
pub use types::{AddPatternFromBrushResult, ImportResult, PatternMode, PatternResource};
