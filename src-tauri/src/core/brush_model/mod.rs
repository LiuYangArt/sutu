//! Brush model contracts that can be shared across platform adapters.

use crate::core::contracts::DabParamsCore;
use crate::core::errors::CoreError;

pub fn validate_dab_params(params: &DabParamsCore) -> Result<(), CoreError> {
    if !params.x.is_finite() || !params.y.is_finite() {
        return Err(CoreError::InvalidInput(
            "Dab coordinates must be finite numbers".to_string(),
        ));
    }
    if !params.size.is_finite() || params.size <= 0.0 {
        return Err(CoreError::InvalidInput(
            "Dab size must be a positive finite number".to_string(),
        ));
    }
    if !params.flow.is_finite() || !(0.0..=1.0).contains(&params.flow) {
        return Err(CoreError::InvalidInput(
            "Dab flow must be in [0, 1]".to_string(),
        ));
    }
    if !params.hardness.is_finite() || !(0.0..=1.0).contains(&params.hardness) {
        return Err(CoreError::InvalidInput(
            "Dab hardness must be in [0, 1]".to_string(),
        ));
    }
    if params.color.trim().is_empty() {
        return Err(CoreError::InvalidInput(
            "Dab color must not be empty".to_string(),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_basic_dab_params() {
        let params = DabParamsCore {
            x: 10.0,
            y: 20.0,
            size: 15.0,
            flow: 0.5,
            hardness: 0.8,
            color: "#000000".to_string(),
            dab_opacity: Some(0.7),
            roundness: Some(1.0),
            angle: Some(0.0),
        };
        assert!(validate_dab_params(&params).is_ok());
    }
}
