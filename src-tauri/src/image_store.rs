use crate::error::{AppError, AppResult};
use crate::paths::ensure_data_dir;
use base64::Engine;
use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};

/// 附件文件名（用户传入部分）的最大保留字符数
pub const SAFE_NAME_MAX_CHARS: usize = 40;

/// 同名文件写入的重试次数（`create_new` 撞名时换随机尾重试）
const WRITE_NEW_MAX_ATTEMPTS: usize = 3;

/// 统一的图片文件名生成器。
///
/// 格式 `{prefix}{ts}_{nanos:09}_{index}_{rand:04x}`。只有毫秒时间戳时（旧版
/// `edit_{ts}` / `att_{ts}`）同一毫秒内的两次写入会得到同一个文件名，而落盘是
/// 覆盖写 —— 多张编辑同批返回或同批附件会静默丢图。纳秒 + 4 位随机尾把碰撞
/// 概率压到可忽略。
///
/// `prefix` 为空时输出与既有生成图命名完全一致（`ts_nanos_index_rand`），
/// 保证旧文件、旧测试与画廊扩展名推断不受影响。
pub fn unique_name(prefix: &str, stamp: &str, index: usize) -> String {
    let ts: String = stamp.replace(|c: char| !c.is_ascii_alphanumeric(), "");
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0);
    // u16 的十六进制恰好 4 位
    format!(
        "{prefix}{ts}_{nanos:09}_{index}_{:04x}",
        rand::random::<u16>()
    )
}

/// 独占写入：`create_new` 保证绝不覆盖既有文件，撞名时换随机尾重试。
///
/// 返回实际落盘路径（可能带重试后缀），调用方必须用它而不是自己拼的路径。
fn write_new(images: &Path, stem: &str, ext: &str, bytes: &[u8]) -> AppResult<PathBuf> {
    for attempt in 0..WRITE_NEW_MAX_ATTEMPTS {
        let suffix = if attempt == 0 {
            String::new()
        } else {
            format!("_{:04x}", rand::random::<u16>())
        };
        let path = images.join(format!("{stem}{suffix}.{ext}"));
        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(mut file) => {
                file.write_all(bytes)?;
                return Ok(path);
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e.into()),
        }
    }
    Err(AppError::Other(format!(
        "图片文件名冲突，重试 {WRITE_NEW_MAX_ATTEMPTS} 次仍失败: {stem}"
    )))
}

/// 扩展名 → MIME（读历史图片 / 消息附件时复用）
pub fn mime_for_ext(ext: &str) -> &'static str {
    match ext {
        "svg" => "image/svg+xml",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        _ => "image/png",
    }
}

/// 磁盘图片文件 → data URL（读失败返回 None，调用方兜底空串）
pub fn path_to_data_url(path: &str) -> Option<String> {
    std::fs::read(path).ok().map(|bytes| {
        let ext = std::path::Path::new(path)
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("png");
        format!(
            "data:{};base64,{}",
            mime_for_ext(ext),
            base64::engine::general_purpose::STANDARD.encode(bytes)
        )
    })
}

/// 去掉 data URL 前缀，只保留 base64 部分
pub fn strip_data_url(s: &str) -> String {
    if let Some(idx) = s.find(',') {
        if s[..idx].starts_with("data:") {
            return s[idx + 1..].to_string();
        }
    }
    s.to_string()
}

/// 缩略图目录（位于 images/ 下；GC 主扫描按子目录跳过）
const THUMB_DIR: &str = ".thumb";
/// 缩略图最长边（像素）：512 在 3 列网格里足够清晰，体积约为原图的几十分之一
const THUMB_MAX_EDGE: u32 = 512;
const THUMB_JPEG_QUALITY: u8 = 80;

pub fn thumb_path_for(source: &Path) -> PathBuf {
    let parent = source.parent().unwrap_or_else(|| Path::new("."));
    let stem = source
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("image");
    parent.join(THUMB_DIR).join(format!("{stem}.jpg"))
}

/// 生成画廊缩略图（最长边 512，JPEG q80）。
///
/// 只处理光栅图：SVG 无法用 image 解码，返回 None，调用方回退原图。
/// 失败只记日志并返回 None，绝不影响原图保存与列表读取。
pub fn ensure_thumb(source: &Path) -> Option<PathBuf> {
    let ext = source
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if !matches!(ext.as_str(), "png" | "jpg" | "jpeg" | "gif" | "webp") {
        return None;
    }
    let thumb = thumb_path_for(source);
    if thumb.metadata().map(|m| m.len() > 0).unwrap_or(false) {
        return Some(thumb);
    }
    if let Err(e) = write_thumb(source, &thumb) {
        tracing::warn!("缩略图生成失败 {}: {e}", source.display());
        return None;
    }
    Some(thumb)
}

fn write_thumb(source: &Path, thumb: &Path) -> Result<(), String> {
    let img = image::open(source).map_err(|e| e.to_string())?;
    let resized = img.thumbnail(THUMB_MAX_EDGE, THUMB_MAX_EDGE);
    // JPEG 无透明通道：先把透明像素合成到白底，避免黑边/黑块
    let rgb = if resized.color().has_alpha() {
        let rgba = resized.to_rgba8();
        let (w, h) = rgba.dimensions();
        let mut canvas = image::RgbImage::new(w, h);
        for (x, y, px) in rgba.enumerate_pixels() {
            let alpha = px[3] as f32 / 255.0;
            let blend = |c: u8| (c as f32 * alpha + 255.0 * (1.0 - alpha)).round() as u8;
            canvas.put_pixel(x, y, image::Rgb([blend(px[0]), blend(px[1]), blend(px[2])]));
        }
        image::DynamicImage::ImageRgb8(canvas)
    } else {
        resized
    };
    let dir = thumb.parent().ok_or("缩略图路径缺少父目录")?;
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    // 先写临时文件再改名：避免进程中断留下半张损坏的缩略图被当作有效缓存
    let tmp = thumb.with_extension("jpg.tmp");
    let write = || -> Result<(), String> {
        let mut file = std::fs::File::create(&tmp).map_err(|e| e.to_string())?;
        let mut encoder =
            image::codecs::jpeg::JpegEncoder::new_with_quality(&mut file, THUMB_JPEG_QUALITY);
        encoder.encode_image(&rgb).map_err(|e| e.to_string())?;
        file.flush().map_err(|e| e.to_string())?;
        drop(file);
        std::fs::rename(&tmp, thumb).map_err(|e| e.to_string())
    };
    let result = write();
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}

/// 删除原图对应的缩略图（不存在时静默）
pub fn remove_thumb(source: &str) {
    let thumb = thumb_path_for(Path::new(source));
    match std::fs::remove_file(&thumb) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => tracing::warn!("删除缩略图失败 {}: {e}", thumb.display()),
    }
}

/// 解析 SVG data URL 头，返回 (payload, 是否 base64)。
///
/// RC-19：SVG 是文本、没有魔数，必须在 strip_data_url 之前按原始输入的
/// `data:image/svg+xml` 头识别，否则会被魔数嗅探默认成 png。
/// 支持 `data:image/svg+xml;base64,` 及带参数变体（如
/// `data:image/svg+xml;charset=utf-8;base64,`）；非 SVG 返回 None 走原嗅探路径。
fn parse_svg_data_url(input: &str) -> Option<(&str, bool)> {
    let rest = input.strip_prefix("data:")?;
    let comma = rest.find(',')?;
    let meta = &rest[..comma];
    let payload = &rest[comma + 1..];
    let mut parts = meta.split(';');
    let mime = parts.next().unwrap_or("").trim();
    if !mime.eq_ignore_ascii_case("image/svg+xml") {
        return None;
    }
    let is_base64 = meta
        .split(';')
        .any(|p| p.trim().eq_ignore_ascii_case("base64"));
    Some((payload, is_base64))
}

/// base64（可带 data-url 前缀）落盘到 images/ 目录，返回 (文件路径, data_url)
pub fn save_b64_image(
    app: &tauri::AppHandle,
    b64: &str,
    name: &str,
) -> AppResult<(String, String)> {
    let data_dir = ensure_data_dir(app)?;
    let images = data_dir.join("images");
    std::fs::create_dir_all(&images)?;
    // RC-19：先按原始输入判定 SVG data URL，再谈解码/嗅探
    if let Some((payload, is_base64)) = parse_svg_data_url(b64) {
        let bytes = if is_base64 {
            base64::engine::general_purpose::STANDARD
                .decode(payload)
                .map_err(|e| AppError::Other(format!("SVG base64 解码失败: {}", e)))?
        } else {
            // 非 base64 的 data URL（如百分号编码）直接按文本落盘
            payload.as_bytes().to_vec()
        };
        let path = write_new(&images, name, "svg", &bytes)?;
        // 字节本就在内存中，直接编码回 base64 data URL，避免写盘后再次读盘
        let url = format!(
            "data:image/svg+xml;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(&bytes)
        );
        return Ok((path.to_string_lossy().to_string(), url));
    }
    // 兼容调用方直接传入带 data-url 前缀的普通图片（png/jpg/...）
    let payload = strip_data_url(b64);
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&payload)
        .map_err(|e| AppError::Other(format!("图片 base64 解码失败: {}", e)))?;
    // 探测真实格式
    let ext = if bytes.starts_with(b"\x89PNG") {
        "png"
    } else if bytes.starts_with(b"\xff\xd8") {
        "jpg"
    } else if bytes.starts_with(b"GIF") {
        "gif"
    } else if bytes.starts_with(b"RIFF") {
        "webp"
    } else {
        "png"
    };
    let path = write_new(&images, name, ext, &bytes)?;
    let url = format!(
        "data:{};base64,{}",
        mime_for_ext(ext),
        base64::engine::general_purpose::STANDARD.encode(&bytes)
    );
    Ok((path.to_string_lossy().to_string(), url))
}

/// 把 images_json 中含 dataUrl 的条目写盘，替换为 { path } 形式（入库前调用）
pub fn persist_image_entries(app: &tauri::AppHandle, images_json: &str) -> AppResult<String> {
    let entries: Vec<serde_json::Value> = serde_json::from_str(images_json).unwrap_or_default();
    let mut out = Vec::new();
    for (i, entry) in entries.into_iter().enumerate() {
        let mut entry = entry;
        let has_path = entry.get("path").and_then(|p| p.as_str()).is_some();
        let data_url = entry
            .get("dataUrl")
            .and_then(|d| d.as_str())
            .map(|s| s.to_string());
        if !has_path {
            if let Some(d) = data_url {
                let name = unique_name("att_", &crate::storage::timestamp_millis(), i);
                // 传原始 dataUrl（不做 strip），让 save_b64_image 能识别 svg 头（RC-19）
                match save_b64_image(app, &d, &name) {
                    Ok((path, _)) => {
                        if let Some(obj) = entry.as_object_mut() {
                            obj.remove("dataUrl");
                            obj.insert("path".into(), path.into());
                        }
                    }
                    Err(_) => {
                        // 写盘失败保留原条目（含 dataUrl），下次再迁
                    }
                }
            }
        }
        out.push(entry);
    }
    Ok(serde_json::to_string(&out).unwrap_or_else(|_| "[]".into()))
}

/// 读取时富化：补 dataUrl；旧 dataUrl 条目惰性迁移为 path 形式。
///
/// 结论（2026-10-28 评估）：**本轮不改为启动期一次性迁移**。理由有三：
/// ① 这是数据形态迁移而非 schema 变更，需要独立的幂等与失败重试语义，而现有
/// 惰性分支天然满足「失败就保留 dataUrl 原位展示」；② 启动期批量写盘会在冷启动
/// IO 高峰插入大量小文件写，与「启动不阻塞」目标冲突；③ 当前没有用户可见缺陷，
/// 收益小于回归风险。
///
/// 触发条件（满足任一再作为 migration 003 独立推进）：出现读路径写放大的实测
/// 问题，或需要在 list_messages 之前支持离线/无盘展示。届时遍历 messages 表把含
/// dataUrl 的 images_json 全部写盘转 path，并删除本函数中的迁移分支。
///
/// 返回 (展示用 json 含 dataUrl, 需回写库的 json——仅发生迁移时 Some)
pub fn enrich_image_entries(
    app: &tauri::AppHandle,
    images_json: &str,
) -> AppResult<(String, Option<String>)> {
    let entries: Vec<serde_json::Value> = serde_json::from_str(images_json).unwrap_or_default();
    let mut migrated = false;
    let mut out = Vec::new();
    for (i, entry) in entries.into_iter().enumerate() {
        let mut entry = entry;
        let has_path = entry.get("path").and_then(|p| p.as_str()).is_some();
        if !has_path {
            if let Some(d) = entry
                .get("dataUrl")
                .and_then(|d| d.as_str())
                .map(|s| s.to_string())
            {
                if d.starts_with("data:") {
                    let name = unique_name("mig_", &crate::storage::timestamp_millis(), i);
                    // 传原始 dataUrl（不做 strip），让 save_b64_image 能识别 svg 头（RC-19）
                    match save_b64_image(app, &d, &name) {
                        Ok((path, _)) => {
                            if let Some(obj) = entry.as_object_mut() {
                                obj.remove("dataUrl");
                                obj.insert("path".into(), path.into());
                            }
                            migrated = true;
                        }
                        Err(_) => {
                            // 迁移失败：保留 dataUrl 原位展示
                        }
                    }
                }
            }
        }
        if let Some(path) = entry.get("path").and_then(|p| p.as_str()) {
            let data_url = path_to_data_url(path);
            if let Some(obj) = entry.as_object_mut() {
                obj.insert("dataUrl".into(), data_url.unwrap_or_default().into());
            }
        }
        out.push(entry);
    }
    // 发生迁移时，库内形态需要去掉 dataUrl 后回写
    let db_json = if migrated {
        let db_form: Vec<serde_json::Value> = out
            .iter()
            .map(|e| {
                let mut e = e.clone();
                if let Some(obj) = e.as_object_mut() {
                    obj.remove("dataUrl");
                }
                e
            })
            .collect();
        Some(serde_json::to_string(&db_form).unwrap_or_else(|_| "[]".into()))
    } else {
        None
    };
    let display_json = serde_json::to_string(&out).unwrap_or_else(|_| "[]".into());
    Ok((display_json, db_json))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// RC-19：SVG data URL（含 base64 变体）必须能被识别，才会落盘为 .svg
    #[test]
    fn svg_data_url_detected_for_base64_variants() {
        assert_eq!(
            parse_svg_data_url("data:image/svg+xml;base64,PHN2Zy8+"),
            Some(("PHN2Zy8+", true))
        );
        assert_eq!(
            parse_svg_data_url("data:image/svg+xml;charset=utf-8;base64,PHN2Zy8+"),
            Some(("PHN2Zy8+", true))
        );
        assert_eq!(
            parse_svg_data_url("data:image/svg+xml,<svg></svg>"),
            Some(("<svg></svg>", false))
        );
    }

    /// 非 SVG 保持原魔数嗅探路径（返回 None）与 strip_data_url 旧行为
    #[test]
    fn non_svg_data_url_not_detected() {
        assert!(parse_svg_data_url("data:image/png;base64,iVBORw0KGgo=").is_none());
        assert!(parse_svg_data_url("iVBORw0KGgo=").is_none());
        assert!(parse_svg_data_url("").is_none());
        assert!(parse_svg_data_url("data:image/svg+xml;base64").is_none());
        // 去掉前缀后仍能还原纯 base64（save_b64_image 非 svg 分支依赖该行为）
        assert_eq!(
            strip_data_url("data:image/png;base64,iVBORw0KGgo="),
            "iVBORw0KGgo="
        );
    }

    /// 生成路径（prefix 为空）必须保持既有四段格式：ts_nanos_index_rand
    #[test]
    fn unique_name_keeps_generated_format() {
        let name = unique_name("", "1700.000", 2);
        let parts: Vec<&str> = name.split('_').collect();
        assert_eq!(parts.len(), 4, "格式应为 ts_nanos_index_rand: {name}");
        assert_eq!(parts[0], "1700000", "时间戳中的 . 必须清洗掉");
        assert_eq!(parts[1].len(), 9, "纳秒固定 9 位");
        assert_eq!(parts[2], "2");
        assert_eq!(parts[3].len(), 4, "随机后缀固定 4 位十六进制");
        assert!(parts[3].chars().all(|c| c.is_ascii_hexdigit()));
    }

    /// 业务前缀同样带纳秒与随机尾：同一毫秒内两次命名不得相同（否则覆盖丢图）
    #[test]
    fn unique_name_with_prefix_never_collides_in_same_millisecond() {
        let a = unique_name("edit_", "1700.000", 0);
        let b = unique_name("edit_", "1700.000", 0);
        assert!(a.starts_with("edit_1700000_"), "前缀与时间戳应保留: {a}");
        assert_ne!(a, b, "同毫秒内两次命名相同会导致后写覆盖前写");
    }

    /// 缩略图：最长边 512、复用缓存、SVG 跳过、remove 可回收
    #[test]
    fn thumb_generation_and_cleanup() {
        let dir = std::env::temp_dir().join(unique_name(
            "moling_thumb_",
            &crate::storage::timestamp_millis(),
            0,
        ));
        std::fs::create_dir_all(&dir).expect("创建临时目录");
        let source = dir.join("big.png");
        let img = image::RgbImage::from_pixel(1024, 512, image::Rgb([10, 120, 200]));
        img.save(&source).expect("保存测试图片");

        let thumb = ensure_thumb(&source).expect("应生成缩略图");
        assert!(thumb.exists());
        let decoded = image::open(&thumb).expect("读取缩略图");
        assert_eq!((decoded.width(), decoded.height()), (512, 256));
        // 已存在时直接复用同一路径
        assert_eq!(ensure_thumb(&source).expect("复用缩略图"), thumb);

        // SVG 不支持解码，调用方回退原图
        let svg = dir.join("vector.svg");
        std::fs::write(&svg, "<svg xmlns=\"http://www.w3.org/2000/svg\"/>").unwrap();
        assert!(ensure_thumb(&svg).is_none());

        // 不存在的文件只返回 None，不 panic
        assert!(ensure_thumb(&dir.join("missing.png")).is_none());

        remove_thumb(source.to_str().unwrap());
        assert!(!thumb.exists(), "remove_thumb 应删除缩略图");
        // 重复删除保持静默
        remove_thumb(source.to_str().unwrap());
        std::fs::remove_dir_all(&dir).ok();
    }

    /// write_new 独占创建：同 stem 连续两次必须得到两个路径、两份内容
    #[test]
    fn write_new_never_overwrites_existing_file() {
        let dir = std::env::temp_dir().join(unique_name(
            "moling_write_new_",
            &crate::storage::timestamp_millis(),
            0,
        ));
        std::fs::create_dir_all(&dir).expect("创建临时目录");
        let first = write_new(&dir, "same", "png", b"AAA").expect("首次写入");
        let second = write_new(&dir, "same", "png", b"BBB").expect("第二次写入应换名");
        assert_ne!(first, second, "同名写入必须换名而不是覆盖");
        assert_eq!(std::fs::read(&first).expect("读首个文件"), b"AAA");
        assert_eq!(std::fs::read(&second).expect("读第二个文件"), b"BBB");
        std::fs::remove_dir_all(&dir).ok();
    }
}
