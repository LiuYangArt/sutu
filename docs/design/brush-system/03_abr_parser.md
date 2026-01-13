# ABR 解析器设计

> 对应原文档 Phase 3

## Phase 3: ABR 解析器

> 强化递归解析逻辑，引入开源库参考，并建立健全的容错机制

### 3.0 解析策略优化

- **开源借力**: 优先参考 `psd-tools` (Python) 和 Krita 的 C++ 实现，尽量移植成熟逻辑而非从零逆向。
- **容错设计**: 针对 ABR 格式的一致性问题（如缺少键值），建立完整的默认值回退链。
- **自动化测试**: 建立 ABR 样本库，包含各种版本的笔刷文件，进行自动化回归测试。

### 3.1 ActionDescriptor 键值映射表

| 类别     | 键代码          | 类型       | 功能                         | 默认值 |
| -------- | --------------- | ---------- | ---------------------------- | ------ |
| 基础属性 | `Dmtr`          | UnitFloat  | 直径 (Diameter)              | 30.0   |
| 基础属性 | `Hrdn`          | Float      | 硬度 (Hardness)              | 1.0    |
| 基础属性 | `Spcn`          | Float      | 间距 (Spacing)               | 0.25   |
| 基础属性 | `Angl`          | Float      | 角度 (Angle)                 | 0.0    |
| 基础属性 | `Rndn`          | Float      | 圆度 (Roundness)             | 1.0    |
| 形状动态 | `szVr`          | Descriptor | 大小变化                     | Off    |
| 形状动态 | `bVTy`          | Enum       | 控制类型 (0=Off, 2=Pressure) | 0      |
| 形状动态 | `jitter`        | Float      | 抖动量                       | 0.0    |
| 形状动态 | `Mnm`           | Float      | 最小值                       | 0.0    |
| 双重画笔 | `DuaB` / `UseD` | Boolean    | 启用双重画笔                 | false  |
| 纹理     | `Txtr`          | Descriptor | 纹理参数块（嵌套）           | None   |
| 翻转     | `flip` / `Flip` | Boolean    | 翻转 X/Y                     | false  |

### 3.2 解析器架构

```rust
// src-tauri/src/abr/mod.rs

mod parser;
mod samp;
mod desc;
mod types;
mod error;
mod defaults;  // ⭐ 新增：默认值回退

pub use parser::AbrParser;
pub use types::*;
pub use error::AbrError;
```

```rust
// src-tauri/src/abr/defaults.rs

/// ABR 参数默认值
/// 当 ActionDescriptor 缺少某个键时，使用这些默认值
pub struct AbrDefaults;

impl AbrDefaults {
    pub const DIAMETER: f32 = 30.0;
    pub const HARDNESS: f32 = 1.0;
    pub const SPACING: f32 = 0.25;
    pub const ANGLE: f32 = 0.0;
    pub const ROUNDNESS: f32 = 1.0;
    pub const SIZE_JITTER: f32 = 0.0;
    pub const SIZE_MINIMUM: f32 = 0.0;
    pub const OPACITY_JITTER: f32 = 0.0;
    pub const SCATTER: f32 = 0.0;
    pub const SCATTER_COUNT: u32 = 1;
}
```

### 3.3 递归 Descriptor 解析

```rust
// src-tauri/src/abr/desc.rs

use super::defaults::AbrDefaults;

/// ActionDescriptor 值类型
#[derive(Debug, Clone)]
pub enum DescValue {
    Integer(i32),
    Float(f64),
    UnitFloat { value: f64, unit: String },
    Boolean(bool),
    Text(String),
    Enum { type_id: String, value: String },
    Descriptor(HashMap<String, DescValue>),  // ⭐ 嵌套描述符
    List(Vec<DescValue>),
    Reference(Vec<ReferenceItem>),
}

/// 递归解析 Descriptor
pub fn parse_descriptor(cursor: &mut Cursor<&[u8]>) -> Result<HashMap<String, DescValue>, AbrError> {
    let mut map = HashMap::new();

    // 读取类名
    let _class_name = read_unicode_string(cursor)?;
    let _class_id = read_key(cursor)?;

    // 读取项目数量
    let item_count = cursor.read_u32::<BigEndian>()?;

    for _ in 0..item_count {
        let key = read_key(cursor)?;
        let value = parse_descriptor_value(cursor)?;
        map.insert(key, value);
    }

    Ok(map)
}

/// 解析单个值（递归处理嵌套 Descriptor）
fn parse_descriptor_value(cursor: &mut Cursor<&[u8]>) -> Result<DescValue, AbrError> {
    let type_code = read_4char(cursor)?;

    match type_code.as_str() {
        "long" => Ok(DescValue::Integer(cursor.read_i32::<BigEndian>()?)),
        "doub" => Ok(DescValue::Float(cursor.read_f64::<BigEndian>()?)),
        "UntF" => {
            let unit = read_4char(cursor)?;
            let value = cursor.read_f64::<BigEndian>()?;
            Ok(DescValue::UnitFloat { value, unit })
        }
        "bool" => Ok(DescValue::Boolean(cursor.read_u8()? != 0)),
        "TEXT" => Ok(DescValue::Text(read_unicode_string(cursor)?)),
        "enum" => {
            let type_id = read_key(cursor)?;
            let value = read_key(cursor)?;
            Ok(DescValue::Enum { type_id, value })
        }
        "Objc" => {
            // ⭐ 递归解析嵌套 Descriptor
            let nested = parse_descriptor(cursor)?;
            Ok(DescValue::Descriptor(nested))
        }
        "VlLs" => {
            let count = cursor.read_u32::<BigEndian>()?;
            let mut list = Vec::with_capacity(count as usize);
            for _ in 0..count {
                list.push(parse_descriptor_value(cursor)?);
            }
            Ok(DescValue::List(list))
        }
        _ => {
            // 跳过未知类型
            Err(AbrError::UnknownDescriptorType(type_code))
        }
    }
}

/// 从 Descriptor 提取笔刷预设，带默认值回退
pub fn extract_brush_preset(desc: &HashMap<String, DescValue>) -> AbrBrushPreset {
    AbrBrushPreset {
        name: desc.get_text("Nm").unwrap_or_default(),
        diameter: desc.get_unit_float("Dmtr").unwrap_or(AbrDefaults::DIAMETER),
        hardness: desc.get_float("Hrdn").unwrap_or(AbrDefaults::HARDNESS),
        spacing: desc.get_float("Spcn").unwrap_or(AbrDefaults::SPACING),
        angle: desc.get_float("Angl").unwrap_or(AbrDefaults::ANGLE),
        roundness: desc.get_float("Rndn").unwrap_or(AbrDefaults::ROUNDNESS),
        sampled_data_uuid: desc.get_text("sampledData"),
        dynamics: extract_dynamics(desc),
    }
}

/// 提取动态参数
fn extract_dynamics(desc: &HashMap<String, DescValue>) -> AbrDynamics {
    let mut dynamics = AbrDynamics::default();

    // 大小动态
    if let Some(DescValue::Descriptor(sz_var)) = desc.get("szVr") {
        dynamics.use_tip_dynamics = true;
        dynamics.size_control = sz_var.get_enum_value("bVTy").unwrap_or(0);
        dynamics.size_jitter = sz_var.get_float("jitter").unwrap_or(AbrDefaults::SIZE_JITTER);
        dynamics.size_minimum = sz_var.get_float("Mnm").unwrap_or(AbrDefaults::SIZE_MINIMUM);
    }

    // 角度动态
    if let Some(DescValue::Descriptor(ang_var)) = desc.get("angleDynamics") {
        dynamics.angle_control = ang_var.get_enum_value("bVTy").unwrap_or(0);
        dynamics.angle_jitter = ang_var.get_float("jitter").unwrap_or(0.0);
    }

    // 透明度动态
    if let Some(DescValue::Descriptor(op_var)) = desc.get("opVr") {
        dynamics.use_paint_dynamics = true;
        dynamics.opacity_control = op_var.get_enum_value("bVTy").unwrap_or(0);
        dynamics.opacity_jitter = op_var.get_float("jitter").unwrap_or(AbrDefaults::OPACITY_JITTER);
    }

    // 散布
    if desc.get_bool("useScatter").unwrap_or(false) {
        dynamics.use_scatter = true;
        dynamics.scatter = desc.get_float("Sctr").unwrap_or(AbrDefaults::SCATTER);
        dynamics.scatter_count = desc.get_int("Cnt").unwrap_or(AbrDefaults::SCATTER_COUNT as i32) as u32;
    }

    dynamics
}
```

### 3.4 纹理归一化

```rust
// src-tauri/src/abr/samp.rs

/// 归一化笔刷纹理为标准格式
/// 输出：白底透明，Alpha 通道代表不透明度
pub fn normalize_brush_texture(image: &GrayscaleImage) -> GrayscaleImage {
    let mut normalized = Vec::with_capacity(image.data.len());

    for &pixel in &image.data {
        // ABR 中通常：0=透明, 255=不透明
        // 但某些版本可能相反，需要检测
        normalized.push(pixel);
    }

    // 检测是否需要反转（如果中心比边缘更暗）
    let should_invert = detect_inverted_alpha(&image);
    if should_invert {
        for pixel in &mut normalized {
            *pixel = 255 - *pixel;
        }
    }

    GrayscaleImage {
        width: image.width,
        height: image.height,
        data: normalized,
    }
}

/// 检测 Alpha 是否反转（黑透白不透 vs 白透黑不透）
fn detect_inverted_alpha(image: &GrayscaleImage) -> bool {
    let cx = image.width / 2;
    let cy = image.height / 2;
    let center_idx = (cy * image.width + cx) as usize;
    let corner_idx = 0;

    // 如果中心比角落更暗，可能需要反转
    image.data.get(center_idx).unwrap_or(&128) < image.data.get(corner_idx).unwrap_or(&128)
}
```

### 3.5 解析器类型定义

```rust
// src-tauri/src/abr/types.rs

#[derive(Debug, Clone)]
pub struct AbrFile {
    pub version: AbrVersion,
    pub brushes: Vec<AbrBrush>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AbrVersion {
    V1,   // Very old (PS 4)
    V2,   // Old format (PS 5-6)
    V6,   // New format (PS 7+)
    V7,   // New format variant
    V10,  // Latest (CC)
}

#[derive(Debug, Clone)]
pub struct AbrBrush {
    pub name: String,
    pub uuid: Option<String>,
    pub tip_image: Option<GrayscaleImage>,
    pub diameter: f32,
    pub spacing: f32,
    pub angle: f32,
    pub roundness: f32,
    pub hardness: Option<f32>,
    pub dynamics: Option<AbrDynamics>,
}

#[derive(Debug, Clone)]
pub struct GrayscaleImage {
    pub width: u32,
    pub height: u32,
    pub data: Vec<u8>,
}

#[derive(Debug, Clone, Default)]
pub struct AbrDynamics {
    pub use_tip_dynamics: bool,
    pub size_control: u32,      // 0=Off, 2=Pressure, 6=Direction...
    pub size_jitter: f32,
    pub size_minimum: f32,
    pub angle_control: u32,
    pub angle_jitter: f32,
    pub use_scatter: bool,
    pub scatter: f32,
    pub scatter_count: u32,
    pub use_paint_dynamics: bool,
    pub opacity_control: u32,
    pub opacity_jitter: f32,
}
```

### 3.6 解析流程

```rust
// src-tauri/src/abr/parser.rs

impl AbrParser {
    pub fn parse(data: &[u8]) -> Result<AbrFile, AbrError> {
        let mut cursor = Cursor::new(data);

        // 1. 读取版本号
        let version = Self::read_version(&mut cursor)?;

        match version {
            AbrVersion::V1 | AbrVersion::V2 => {
                Self::parse_old_format(&mut cursor, version)
            }
            AbrVersion::V6 | AbrVersion::V7 | AbrVersion::V10 => {
                Self::parse_new_format(&mut cursor, version)
            }
        }
    }

    fn parse_new_format(cursor: &mut Cursor<&[u8]>, version: AbrVersion)
        -> Result<AbrFile, AbrError>
    {
        let mut brushes = Vec::new();
        let mut samples = HashMap::new();

        // 2. 扫描所有 8BIM 块
        while let Some(block) = Self::read_8bim_block(cursor)? {
            match block.key.as_str() {
                "samp" => {
                    // 3. 解析采样纹理
                    let samp_brushes = samp::parse_samp_block(&block.data)?;
                    for sb in samp_brushes {
                        samples.insert(sb.uuid.clone(), sb);
                    }
                }
                "desc" => {
                    // 4. 解析描述符
                    let presets = desc::parse_desc_block(&block.data)?;
                    for preset in presets {
                        // 5. 关联纹理和描述符
                        let tip_image = preset.sampled_data_uuid
                            .as_ref()
                            .and_then(|uuid| samples.get(uuid))
                            .map(|s| s.image.clone());

                        brushes.push(AbrBrush {
                            name: preset.name,
                            uuid: preset.sampled_data_uuid,
                            tip_image,
                            diameter: preset.diameter,
                            spacing: preset.spacing,
                            angle: preset.angle,
                            roundness: preset.roundness,
                            hardness: None,
                            dynamics: Some(preset.dynamics),
                        });
                    }
                }
                "patt" => {
                    // 图案，暂不支持
                }
                _ => {
                    // 忽略未知块
                }
            }
        }

        Ok(AbrFile { version, brushes })
    }
}
```

### 3.7 8BIMsamp 解析

```rust
// src-tauri/src/abr/samp.rs

pub struct SampledBrush {
    pub uuid: String,
    pub image: GrayscaleImage,
}

pub fn parse_samp_block(data: &[u8]) -> Result<Vec<SampledBrush>, AbrError> {
    let mut cursor = Cursor::new(data);
    let mut brushes = Vec::new();

    while cursor.position() < data.len() as u64 {
        // 读取项目长度
        let item_length = cursor.read_u32::<BigEndian>()?;
        let item_start = cursor.position();

        // 读取 UUID (Pascal string)
        let uuid = read_pascal_string(&mut cursor)?;

        // 跳过未知字节
        cursor.seek(SeekFrom::Current(8))?;

        // 读取深度
        let depth = cursor.read_u16::<BigEndian>()?;

        // 读取边界矩形
        let top = cursor.read_i32::<BigEndian>()?;
        let left = cursor.read_i32::<BigEndian>()?;
        let bottom = cursor.read_i32::<BigEndian>()?;
        let right = cursor.read_i32::<BigEndian>()?;

        let width = (right - left) as u32;
        let height = (bottom - top) as u32;

        // 再次读取深度
        let _depth2 = cursor.read_u16::<BigEndian>()?;

        // 读取压缩模式
        let compression = cursor.read_u8()?;

        // 读取图像数据
        let image_data = match compression {
            0 => read_raw_image(&mut cursor, width, height, depth)?,
            1 => read_rle_image(&mut cursor, width, height)?,
            _ => return Err(AbrError::UnsupportedCompression(compression)),
        };

        brushes.push(SampledBrush {
            uuid,
            image: GrayscaleImage { width, height, data: image_data },
        });

        // 跳到下一项（考虑 4 字节对齐）
        let consumed = cursor.position() - item_start;
        let padding = (4 - (consumed % 4)) % 4;
        cursor.seek(SeekFrom::Current(padding as i64))?;
    }

    Ok(brushes)
}
```

### 3.8 Tauri 命令

```rust
// src-tauri/src/commands.rs

#[tauri::command]
pub async fn import_abr_file(path: String) -> Result<Vec<BrushPreset>, String> {
    let data = std::fs::read(&path)
        .map_err(|e| format!("Failed to read file: {}", e))?;

    let abr_file = AbrParser::parse(&data)
        .map_err(|e| format!("Failed to parse ABR: {}", e))?;

    let presets: Vec<BrushPreset> = abr_file.brushes
        .into_iter()
        .map(|b| b.into())
        .collect();

    Ok(presets)
}

#[tauri::command]
pub fn get_brush_presets() -> Vec<BrushPreset> {
    // 从应用状态获取已加载的预设
    BRUSH_PRESETS.lock().unwrap().clone()
}

#[tauri::command]
pub fn set_active_brush(preset_id: String) -> Result<(), String> {
    // 设置当前活动笔刷
    // ...
}
```
