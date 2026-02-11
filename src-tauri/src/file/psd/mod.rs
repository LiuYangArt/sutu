//! Adobe Photoshop (.psd) format support
//!
//! Provides save/load functionality for PSD files with layer support.
//! Uses the `psd` crate for reading and custom implementation for writing.

pub mod compression;
mod reader;
mod types;
mod writer;

pub use reader::load_psd;
pub use writer::save_psd;

/// Map Sutu blend mode to PSD 4-byte key
pub fn blend_mode_to_psd(mode: &str) -> [u8; 4] {
    match mode {
        "normal" => *b"norm",
        "dissolve" => *b"diss",
        "darken" => *b"dark",
        "multiply" => *b"mul ",
        "color-burn" => *b"idiv",
        "linear-burn" => *b"lbrn",
        "darker-color" => *b"dkCl",
        "lighten" => *b"lite",
        "screen" => *b"scrn",
        "color-dodge" => *b"div ",
        "linear-dodge" => *b"lddg",
        "lighter-color" => *b"lgCl",
        "overlay" => *b"over",
        "soft-light" => *b"sLit",
        "hard-light" => *b"hLit",
        "vivid-light" => *b"vLit",
        "linear-light" => *b"lLit",
        "pin-light" => *b"pLit",
        "hard-mix" => *b"hMix",
        "difference" => *b"diff",
        "exclusion" => *b"smud",
        "subtract" => *b"fsub",
        "divide" => *b"fdiv",
        "hue" => *b"hue ",
        "saturation" => *b"sat ",
        "color" => *b"colr",
        "luminosity" => *b"lum ",
        _ => *b"norm",
    }
}

/// Map PSD 4-byte key to Sutu blend mode
pub fn psd_to_blend_mode(key: &[u8]) -> String {
    if key.len() < 4 {
        return "normal".to_string();
    }

    let key_arr: [u8; 4] = [key[0], key[1], key[2], key[3]];

    match &key_arr {
        b"norm" | b"pass" => "normal",
        b"diss" => "dissolve",
        b"dark" => "darken",
        b"mul " => "multiply",
        b"idiv" => "color-burn",
        b"lbrn" => "linear-burn",
        b"dkCl" => "darker-color",
        b"lite" => "lighten",
        b"scrn" => "screen",
        b"div " => "color-dodge",
        b"lddg" => "linear-dodge",
        b"lgCl" => "lighter-color",
        b"over" => "overlay",
        b"sLit" => "soft-light",
        b"hLit" => "hard-light",
        b"vLit" => "vivid-light",
        b"lLit" => "linear-light",
        b"pLit" => "pin-light",
        b"hMix" => "hard-mix",
        b"diff" => "difference",
        b"smud" => "exclusion",
        b"fsub" => "subtract",
        b"fdiv" => "divide",
        b"hue " => "hue",
        b"sat " => "saturation",
        b"colr" => "color",
        b"lum " => "luminosity",
        _ => "normal",
    }
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_blend_mode_roundtrip() {
        let modes = [
            "normal",
            "multiply",
            "screen",
            "overlay",
            "darken",
            "lighten",
            "color-dodge",
            "color-burn",
            "hard-light",
            "soft-light",
            "difference",
            "exclusion",
            "hue",
            "saturation",
            "color",
            "luminosity",
        ];

        for mode in modes {
            let psd_key = blend_mode_to_psd(mode);
            let back = psd_to_blend_mode(&psd_key);
            assert_eq!(mode, back, "Roundtrip failed for mode: {}", mode);
        }
    }

    #[test]
    fn test_unknown_blend_mode() {
        let key = blend_mode_to_psd("unknown-mode");
        assert_eq!(&key, b"norm");
    }

    #[test]
    fn test_psd_to_blend_mode_short_key() {
        let result = psd_to_blend_mode(&[0, 1]);
        assert_eq!(result, "normal");
    }
}
