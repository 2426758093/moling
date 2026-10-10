use crate::error::{AppError, AppResult};
use crate::paths::ensure_data_dir;
use base64::Engine;

/// 附件文件名（用户传入部分）的最大保留字符数
pub const SAFE_NAME_MAX_CHARS: usize = 40;

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

/// base64（可带 data-url 前缀）落盘到 images/ 目录，返回 (文件路径, data_url)
pub fn save_b64_image(
    app: &tauri::AppHandle,
    b64: &str,
    name: &str,
) -> AppResult<(String, String)> {
    let data_dir = ensure_data_dir(app)?;
    let images = data_dir.join("images");
    std::fs::create_dir_all(&images)?;
    if let Some(rest) = b64.strip_prefix("data:image/svg+xml;base64,") {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(rest)
            .map_err(|e| AppError::Other(e.to_string()))?;
        let path = images.join(format!("{}.svg", name));
        std::fs::write(&path, &bytes)?;
        // 字节本就在内存中，直接编码回 data URL，避免写盘后再次读盘
        let url = format!(
            "data:image/svg+xml;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(&bytes)
        );
        return Ok((path.to_string_lossy().to_string(), url));
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(b64)
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
    let path = images.join(format!("{}.{}", name, ext));
    std::fs::write(&path, &bytes)?;
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
                let name = format!("att_{}_{}", crate::storage::timestamp_millis(), i);
                match save_b64_image(app, &strip_data_url(&d), &name) {
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
/// TODO(一次性迁移)：当前在读取路径上惰性迁移旧数据并回写库（见
/// `storage::update_message_images`）。长期应改为启动时的一次性 schema 迁移：
/// 遍历 messages 表把含 dataUrl 的 images_json 全部写盘转为 path 形态，之后删除
/// 本函数中的迁移分支。迁移分支保留期间，读路径存在"读 + 条件写"副作用。
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
                    let name = format!("mig_{}_{}", crate::storage::timestamp_millis(), i);
                    match save_b64_image(app, &strip_data_url(&d), &name) {
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
