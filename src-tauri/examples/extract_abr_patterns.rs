#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::manual_range_contains,
    clippy::needless_range_loop
)]
//! ABR Pattern extraction tool
//!
//! 用于测试从 @liuyang_paintbrushes.abr 文件提取笔刷对应的 pattern 资源

use byteorder::{BigEndian, ReadBytesExt};
use std::io::{Cursor, Read, Seek, SeekFrom};

/// Pattern 资源结构
#[derive(Debug, Clone)]
struct PatternResource {
    name: String,
    width: u32,
    height: u32,
    mode: u32,
}

/// 创建分隔线字符串
fn sep_line(ch: char, len: usize) -> String {
    std::iter::repeat(ch).take(len).collect()
}

/// 读取 UTF-16 BE 字符串 (4字节长度前缀为字符数)
fn read_unicode_string(cursor: &mut Cursor<&[u8]>) -> Result<String, String> {
    let len = cursor.read_u32::<BigEndian>().map_err(|e| e.to_string())? as usize;
    if len == 0 || len > 1000 {
        return Ok(String::new());
    }

    let mut utf16_data = Vec::with_capacity(len);
    for _ in 0..len {
        let ch = cursor.read_u16::<BigEndian>().map_err(|e| e.to_string())?;
        utf16_data.push(ch);
    }

    String::from_utf16(&utf16_data).map_err(|e| e.to_string())
}

/// 读取 Pascal 字符串 (1字节长度前缀 + ASCII)
fn read_pascal_string(cursor: &mut Cursor<&[u8]>) -> Result<String, String> {
    let len = cursor.read_u8().map_err(|e| e.to_string())? as usize;
    if len == 0 || len > 100 {
        return Ok(String::new());
    }
    let mut bytes = vec![0u8; len];
    cursor.read_exact(&mut bytes).map_err(|e| e.to_string())?;
    // 对齐到 2 字节边界
    if len % 2 == 0 {
        cursor.seek(SeekFrom::Current(1)).ok();
    }
    String::from_utf8(bytes).map_err(|e| e.to_string())
}

/// 解析单个 Pattern
///
/// 基于 hex dump 分析的结构:
/// - 4 bytes: pattern 总大小 (包含这个字段本身)
/// - 4 bytes: version (1)
/// - 4 bytes: mode (色彩模式)
/// - 2 bytes: width
/// - 2 bytes: height
/// - 4 bytes: 名称长度 (字符数)
/// - N*2 bytes: 名称 (UTF-16 BE)
/// - Pascal string: ID (UUID)
/// - 填充到 4 字节边界
/// - 图像数据
fn parse_pattern(data: &[u8]) -> Result<(PatternResource, usize), String> {
    if data.len() < 30 {
        return Err("数据不足".to_string());
    }

    // 读取 pattern 总大小
    let pattern_size = u32::from_be_bytes([data[0], data[1], data[2], data[3]]) as usize;

    if pattern_size < 40 || pattern_size > 5_000_000 {
        return Err(format!("无效的 pattern 大小: {}", pattern_size));
    }

    if pattern_size > data.len() {
        return Err(format!(
            "Pattern 大小 {} 超过可用数据 {}",
            pattern_size,
            data.len()
        ));
    }

    let pattern_data = &data[4..pattern_size];
    let mut cursor = Cursor::new(pattern_data);

    // Version (4 bytes)
    let version = cursor.read_u32::<BigEndian>().map_err(|e| e.to_string())?;
    if version != 1 {
        return Err(format!("不支持的版本: {}", version));
    }

    // Mode (4 bytes)
    let mode = cursor.read_u32::<BigEndian>().map_err(|e| e.to_string())?;
    if mode > 10 {
        return Err(format!("无效的模式: {}", mode));
    }

    // Width (2 bytes)
    let width = cursor.read_u16::<BigEndian>().map_err(|e| e.to_string())? as u32;

    // Height (2 bytes)
    let height = cursor.read_u16::<BigEndian>().map_err(|e| e.to_string())? as u32;

    if width == 0 || height == 0 || width > 8192 || height > 8192 {
        return Err(format!("无效尺寸: {}x{}", width, height));
    }

    // 名称 (UTF-16 BE 字符串)
    let name = read_unicode_string(&mut cursor)?;
    if name.is_empty() {
        return Err("名称为空".to_string());
    }

    // ID (Pascal 字符串)
    let _id = read_pascal_string(&mut cursor).unwrap_or_default();

    // 4字节对齐
    let pos = cursor.position();
    let padding = (4 - (pos % 4)) % 4;
    cursor.seek(SeekFrom::Current(padding as i64)).ok();

    // 后面是图像数据，我们这里只提取元数据

    let resource = PatternResource {
        name,
        width,
        height,
        mode,
    };

    // 4字节对齐的总大小
    let aligned_size = (pattern_size + 3) & !3;

    Ok((resource, aligned_size))
}

/// 解析 patt section
fn parse_patterns_from_patt_section(data: &[u8]) -> Result<Vec<PatternResource>, String> {
    let mut patterns = Vec::new();
    let mut offset: usize = 0;

    println!("Patt section 大小: {} bytes\n", data.len());

    // 打印前 128 字节
    println!("前 128 字节 hex dump:");
    for i in 0..128.min(data.len()) {
        if i % 16 == 0 {
            print!("{:04x}: ", i);
        }
        print!("{:02x} ", data[i]);
        if (i + 1) % 16 == 0 {
            print!("  ");
            for j in i - 15..=i {
                let c = data[j] as char;
                if c.is_ascii_graphic() || c == ' ' {
                    print!("{}", c);
                } else {
                    print!(".");
                }
            }
            println!();
        }
    }
    println!("\n");

    println!("开始解析 patterns...\n");

    while offset + 30 <= data.len() {
        // 快速检查：读取 size 字段
        if offset + 4 > data.len() {
            break;
        }
        let size = u32::from_be_bytes([
            data[offset],
            data[offset + 1],
            data[offset + 2],
            data[offset + 3],
        ]) as usize;

        // 验证 size 合理性
        if size < 40 || size > 2_000_000 || offset + size > data.len() {
            offset += 1;
            continue;
        }

        // 尝试解析
        match parse_pattern(&data[offset..]) {
            Ok((pattern, consumed)) => {
                patterns.push(pattern);
                offset += consumed;

                if patterns.len() <= 10 || patterns.len() % 50 == 0 {
                    let p = patterns.last().unwrap();
                    println!(
                        "  [#{:3}] '{:25}' ({}x{}, mode={})",
                        patterns.len(),
                        p.name,
                        p.width,
                        p.height,
                        p.mode
                    );
                }
            }
            Err(_) => {
                offset += 1;
            }
        }

        if patterns.len() > 500 {
            println!("  已达到最大解析数量 (500)，停止");
            break;
        }
    }

    Ok(patterns)
}

/// 查找 8BIM section
fn find_8bim_section(data: &[u8], target: &str) -> Option<Vec<u8>> {
    let mut cursor = Cursor::new(data);
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

        let section_size = cursor.read_u32::<BigEndian>().ok()? as u64;

        if tag_str == target {
            let mut section_data = vec![0u8; section_size as usize];
            cursor.read_exact(&mut section_data).ok()?;
            return Some(section_data);
        } else {
            cursor.seek(SeekFrom::Current(section_size as i64)).ok();
            if section_size % 2 != 0 {
                cursor.seek(SeekFrom::Current(1)).ok();
            }
        }
    }

    None
}

fn main() {
    println!("ABR Pattern 提取测试工具");
    println!("目标文件: @liuyang_paintbrushes.abr\n");

    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("abr/liuyang_paintbrushes.abr");

    let data = match std::fs::read(&path) {
        Ok(d) => d,
        Err(e) => {
            eprintln!("错误: 无法读取文件 '{}': {}", path.display(), e);
            std::process::exit(1);
        }
    };

    println!("成功读取文件: {:?}", path);
    println!(
        "文件大小: {} bytes ({:.2} MB)\n",
        data.len(),
        data.len() as f64 / (1024.0 * 1024.0)
    );

    let sep = sep_line('=', 80);
    let dash = sep_line('-', 80);

    println!("{}", sep);
    println!("ABR Pattern 提取");
    println!("{}", sep);

    // 提取 patt section
    match find_8bim_section(&data, "patt") {
        Some(patt_data) => {
            println!(
                "找到 patt section: {} bytes ({:.2} MB)\n",
                patt_data.len(),
                patt_data.len() as f64 / (1024.0 * 1024.0)
            );

            match parse_patterns_from_patt_section(&patt_data) {
                Ok(patterns) => {
                    println!();
                    println!("{}", sep);
                    println!("提取结果摘要");
                    println!("{}", sep);
                    println!("成功提取 {} 个 Pattern 资源", patterns.len());

                    if !patterns.is_empty() {
                        let total_pixels: u64 =
                            patterns.iter().map(|p| (p.width * p.height) as u64).sum();

                        println!(
                            "总像素数: {} ({:.2} MP)",
                            total_pixels,
                            total_pixels as f64 / 1_000_000.0
                        );
                        println!();

                        // 统计模式
                        let mut mode_stats: std::collections::HashMap<u32, usize> =
                            std::collections::HashMap::new();
                        for p in &patterns {
                            *mode_stats.entry(p.mode).or_insert(0) += 1;
                        }
                        println!("色彩模式分布:");
                        for (mode, count) in &mode_stats {
                            let name = match *mode {
                                0 => "Bitmap",
                                1 => "Grayscale",
                                2 => "Indexed",
                                3 => "RGB",
                                4 => "CMYK",
                                7 => "Multichannel",
                                8 => "Duotone",
                                9 => "Lab",
                                _ => "Unknown",
                            };
                            println!("  Mode {} ({}): {} 个", mode, name, count);
                        }

                        // 显示前 20 个
                        println!();
                        println!("Pattern 列表 (前 20 个):");
                        println!("{}", dash);
                        for (i, p) in patterns.iter().take(20).enumerate() {
                            let mode_name = match p.mode {
                                0 => "Bitmap",
                                1 => "Grayscale",
                                2 => "Indexed",
                                3 => "RGB",
                                4 => "CMYK",
                                7 => "Multichannel",
                                8 => "Duotone",
                                9 => "Lab",
                                _ => "Unknown",
                            };
                            println!(
                                "  {:3}. '{:30}' ({}x{}, {})",
                                i + 1,
                                p.name,
                                p.width,
                                p.height,
                                mode_name
                            );
                        }
                        if patterns.len() > 20 {
                            println!("  ... 还有 {} 个 ...", patterns.len() - 20);
                        }
                    }
                }
                Err(e) => {
                    eprintln!("解析失败: {}", e);
                }
            }
        }
        None => {
            println!("错误: 未找到 patt section");
        }
    }

    println!();
    println!("{}", sep);
    println!("分析完成!");
    println!("{}", sep);
}
