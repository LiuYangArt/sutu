use thiserror::Error;

#[derive(Debug, Error)]
pub enum CoreError {
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    #[error("File format error: {0}")]
    FileFormat(String),

    #[error("Asset parse error: {0}")]
    AssetParse(String),

    #[error("Invalid input: {0}")]
    InvalidInput(String),
}

impl From<crate::file::FileError> for CoreError {
    fn from(value: crate::file::FileError) -> Self {
        Self::FileFormat(value.to_string())
    }
}
