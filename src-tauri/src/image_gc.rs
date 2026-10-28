//! 启动时的孤儿图片回收。
//!
//! 磁盘上的图片是「无主」的：`history.file_path` 与 `messages.images_json[].path`
//! 各自引用同一文件，两处删除互不知情，删会话/删消息都不回收磁盘文件。长期使用后
//! `images/` 会持续膨胀。
//!
//! 这里在启动后**后台**扫一次，把「磁盘有、数据库全无引用、且已存在超过 1 小时」
//! 的图片**移动**到 `images/.trash/` 保留 30 天，而不是直接删除——误删用户作品
//! 无法挽回，而移动是同盘原子操作、可人工恢复。

use crate::image_store;
use crate::storage;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

/// 孤儿的最小年龄。
///
/// 唯一需要防的竞态是「save_b64_image 写盘 → add_history/add_message 入库」
/// 之间的毫秒级窗口，以及生成被停止/崩溃打断后的短暂残留。1 小时比该窗口宽
/// 六个数量级，代价只是孤儿多留到下一次启动。
const ORPHAN_MIN_AGE: Duration = Duration::from_secs(60 * 60);

/// 回收站保留期：误判可人工恢复的时间窗
const TRASH_RETENTION: Duration = Duration::from_secs(30 * 24 * 60 * 60);

/// 启动后延迟多久开始扫描：让首屏 `list_history`（全量读盘 + base64）先占 IO
const STARTUP_DELAY: Duration = Duration::from_secs(2);

/// 允许被当作图片回收的扩展名（与 image_store 落盘嗅探结果一致）
const ALLOWED_EXT: &[&str] = &["png", "jpg", "jpeg", "webp", "gif", "svg"];

/// 无任何引用、但目录里已有这么多超龄文件时，判定「库与目录不匹配」并整体跳过
const EMPTY_REFS_FILE_THRESHOLD: usize = 3;

/// 每次启动最多回填多少张缩略图：存量数据可能很多，分批补齐避免拖慢启动
const THUMB_BACKFILL_BUDGET: usize = 60;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Mode {
    /// 正常：移动到 .trash
    Move,
    /// 只统计不移动
    DryRun,
    /// 完全关闭
    Off,
    /// 越过两道安全哨兵强制清理（人为确认后使用）
    Force,
}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct Stats {
    pub scanned: usize,
    pub kept: usize,
    pub skipped_recent: usize,
    pub candidates: usize,
    /// 实际移动成功的数量（dry-run 恒为 0，用 candidates 观察）
    pub moved: usize,
    pub pruned: usize,
    /// 本次回填生成的缩略图数量
    pub thumbs_created: usize,
    pub errors: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Decision {
    /// 回收候选
    Reclaim,
    /// 仍被引用
    Keep,
    /// 够新，可能是刚落盘还没入库
    SkipRecent,
    /// 不是受管图片（子目录、点文件、未知扩展名）
    Ignore,
}

/// 启动入口：后台线程调用，**绝不 panic**（release 是 `panic = "abort"`，
/// 扫描线程 panic 会直接杀掉整个应用）。
pub fn run(data_dir: &Path) {
    let mode = mode_from_env();
    if mode == Mode::Off {
        tracing::info!("孤儿图片扫描已关闭（MOLING_IMAGE_GC=off）");
        return;
    }
    std::thread::sleep(STARTUP_DELAY);
    match scan(data_dir, mode, SystemTime::now()) {
        Ok(stats) => {
            // 日志默认只落 WARN 以上：有动作才留痕，无动作保持安静
            if stats.moved > 0 || stats.pruned > 0 || stats.thumbs_created > 0 || stats.errors > 0 {
                tracing::warn!("孤儿图片扫描完成: {stats:?}");
            } else {
                tracing::info!("孤儿图片扫描完成（无动作）: {stats:?}");
            }
        }
        Err(e) => tracing::warn!("孤儿图片扫描失败（不影响启动）: {e}"),
    }
}

fn mode_from_env() -> Mode {
    match std::env::var("MOLING_IMAGE_GC")
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase()
        .as_str()
    {
        "off" => Mode::Off,
        "dry-run" => Mode::DryRun,
        "force" => Mode::Force,
        _ => Mode::Move,
    }
}

fn scan(data_dir: &Path, mode: Mode, now: SystemTime) -> Result<Stats, String> {
    let images = data_dir.join("images");
    if !images.is_dir() {
        return Ok(Stats::default());
    }
    let refs = storage::referenced_image_paths_snapshot().map_err(|e| e.to_string())?;

    let mut stats = Stats::default();
    let mut candidates: Vec<(PathBuf, String, Duration)> = Vec::new();
    let mut stale = 0usize;
    // 原图 stem 集合：用于清理源文件已消失的缩略图
    let mut stems: HashSet<String> = HashSet::new();

    let entries = std::fs::read_dir(&images).map_err(|e| format!("读取图片目录失败: {e}"))?;
    for entry in entries {
        let Ok(entry) = entry else {
            stats.errors += 1;
            continue;
        };
        let Ok(file_type) = entry.file_type() else {
            stats.errors += 1;
            continue;
        };
        let name = entry.file_name().to_string_lossy().to_string();
        let age = entry
            .metadata()
            .ok()
            .and_then(|m| m.modified().ok())
            .and_then(|t| now.duration_since(t).ok())
            .unwrap_or_default();
        let path_key = storage::normalize_path_key(&entry.path().to_string_lossy());
        let referenced = refs.contains(&path_key);
        if file_type.is_file() {
            stats.scanned += 1;
            if let Some(stem) = Path::new(&name).file_stem().and_then(|s| s.to_str()) {
                stems.insert(stem.to_string());
            }
        }
        match decide(&name, file_type.is_file(), age, referenced) {
            Decision::Reclaim => {
                stale += 1;
                candidates.push((entry.path(), name, age));
            }
            Decision::Keep => {
                stale += 1;
                stats.kept += 1;
            }
            Decision::SkipRecent => stats.skipped_recent += 1,
            Decision::Ignore => {}
        }
    }
    stats.candidates = candidates.len();

    // 安全哨兵：引用集合与当前目录完全不匹配时，一律不动文件
    if let Some(reason) = sanity_skip(&refs, &images, stale, mode == Mode::Force) {
        tracing::error!("孤儿图片扫描已整体跳过：{reason}；如确认无误可设 MOLING_IMAGE_GC=force");
        return Ok(stats);
    }

    // dry-run 只观察不写入：跳过缩略图回填
    if mode != Mode::DryRun {
        backfill_thumbs(&images, &refs, now, &mut stats);
    }

    let trash = images.join(".trash");
    for (path, name, age) in candidates {
        if mode == Mode::DryRun {
            tracing::warn!("[dry-run] 将回收 {}（已存在 {:?}）", path.display(), age);
            continue;
        }
        if let Err(e) = std::fs::create_dir_all(&trash) {
            stats.errors += 1;
            tracing::warn!("创建回收站目录失败，终止本轮回收: {e}");
            break;
        }
        let stamp = crate::storage::timestamp_millis().replace('.', "-");
        let target = trash.join(format!("{}_{:04x}_{}", stamp, rand::random::<u16>(), name));
        match std::fs::rename(&path, &target) {
            Ok(()) => {
                stats.moved += 1;
                image_store::remove_thumb(&path.to_string_lossy());
                tracing::warn!(
                    "孤儿图片已移入回收站: {} → {}",
                    path.display(),
                    target.display()
                );
            }
            Err(e) => {
                stats.errors += 1;
                tracing::warn!("移动孤儿图片失败 {}: {e}", path.display());
            }
        }
    }

    prune_thumbs(&images, &stems, now, &mut stats);
    prune_trash(&trash, now, &mut stats);
    Ok(stats)
}

/// 为存量作品回填缩略图：只处理仍在库中引用、且已存在超过 1 小时的原图，
/// 每次启动限量，失败静默跳过（画廊回退原图，下次启动再试）。
fn backfill_thumbs(images: &Path, refs: &HashSet<String>, now: SystemTime, stats: &mut Stats) {
    let Ok(entries) = std::fs::read_dir(images) else {
        return;
    };
    for entry in entries.flatten() {
        if stats.thumbs_created >= THUMB_BACKFILL_BUDGET {
            break;
        }
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if !file_type.is_file() {
            continue;
        }
        let path = entry.path();
        let age = entry
            .metadata()
            .ok()
            .and_then(|m| m.modified().ok())
            .and_then(|t| now.duration_since(t).ok())
            .unwrap_or_default();
        if age < ORPHAN_MIN_AGE {
            continue;
        }
        if !refs.contains(&storage::normalize_path_key(&path.to_string_lossy())) {
            continue;
        }
        if image_store::thumb_path_for(&path).exists() {
            continue;
        }
        if image_store::ensure_thumb(&path).is_some() {
            stats.thumbs_created += 1;
        }
    }
}

/// 清理源文件已消失的缩略图（源文件还在的保留；回收站保留期内的缩略图也随之失效）
fn prune_thumbs(images: &Path, stems: &HashSet<String>, now: SystemTime, stats: &mut Stats) {
    let thumb_dir = images.join(".thumb");
    let Ok(entries) = std::fs::read_dir(&thumb_dir) else {
        return;
    };
    for entry in entries.flatten() {
        let Ok(meta) = entry.metadata() else {
            continue;
        };
        if !meta.is_file() {
            continue;
        }
        let Ok(modified) = meta.modified() else {
            continue;
        };
        if now.duration_since(modified).unwrap_or_default() < ORPHAN_MIN_AGE {
            continue;
        }
        let Some(stem) = entry
            .path()
            .file_stem()
            .and_then(|s| s.to_str())
            .map(str::to_string)
        else {
            continue;
        };
        if stems.contains(&stem) {
            continue;
        }
        match std::fs::remove_file(entry.path()) {
            Ok(()) => stats.pruned += 1,
            Err(e) => {
                stats.errors += 1;
                tracing::warn!("清理缩略图失败 {:?}: {e}", entry.path());
            }
        }
    }
    // 目录空了顺手删掉；非空时失败忽略
    let _ = std::fs::remove_dir(&thumb_dir);
}

/// 单文件判定（纯函数，便于单测覆盖边界）
fn decide(name: &str, is_file: bool, age: Duration, referenced: bool) -> Decision {
    if !is_file {
        return Decision::Ignore; // 含 .trash 等子目录
    }
    if name.starts_with('.') {
        return Decision::Ignore;
    }
    let ext = Path::new(name)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if !ALLOWED_EXT.contains(&ext.as_str()) {
        return Decision::Ignore;
    }
    if age < ORPHAN_MIN_AGE {
        return Decision::SkipRecent;
    }
    if referenced {
        Decision::Keep
    } else {
        Decision::Reclaim
    }
}

/// 两道哨兵，返回 Some(理由) 表示整体跳过。
///
/// S1 数据目录搬家/换机：引用集合非空，但没有一项落在当前 images 下。
/// S2 库损坏或被重建：引用集合为空，但目录里已有成批超龄文件。
fn sanity_skip(
    refs: &HashSet<String>,
    images_dir: &Path,
    stale_files: usize,
    force: bool,
) -> Option<&'static str> {
    if force {
        return None;
    }
    if refs.is_empty() {
        return if stale_files >= EMPTY_REFS_FILE_THRESHOLD {
            Some("数据库没有任何图片引用，但图片目录已有存量文件（疑似库损坏或数据目录搬家）")
        } else {
            None
        };
    }
    let prefix = format!(
        "{}\\",
        storage::normalize_path_key(&images_dir.to_string_lossy())
    );
    if refs.iter().any(|p| p.starts_with(&prefix)) {
        None
    } else {
        Some("数据库中的图片路径均不在当前数据目录下（疑似数据目录搬家或换机）")
    }
}

fn prune_trash(trash: &Path, now: SystemTime, stats: &mut Stats) {
    let Ok(entries) = std::fs::read_dir(trash) else {
        return;
    };
    for entry in entries.flatten() {
        let Ok(meta) = entry.metadata() else {
            continue;
        };
        if !meta.is_file() {
            continue;
        }
        let Ok(modified) = meta.modified() else {
            continue;
        };
        if now.duration_since(modified).unwrap_or_default() < TRASH_RETENTION {
            continue;
        }
        match std::fs::remove_file(entry.path()) {
            Ok(()) => stats.pruned += 1,
            Err(e) => {
                stats.errors += 1;
                tracing::warn!("清理回收站文件失败 {:?}: {e}", entry.path());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn refs_with(paths: &[&str]) -> HashSet<String> {
        paths
            .iter()
            .map(|p| storage::normalize_path_key(p))
            .collect()
    }

    /// 缩略图回填只处理仍被引用的超龄原图；源文件消失的缩略图会被清理
    #[test]
    fn thumbs_are_backfilled_and_pruned() {
        let dir = std::env::temp_dir().join(format!(
            "moling_gc_thumb_{}_{:04x}",
            std::process::id(),
            rand::random::<u16>()
        ));
        let images = dir.join("images");
        let thumbs = images.join(".thumb");
        std::fs::create_dir_all(&thumbs).expect("创建目录");
        let source = images.join("keep.png");
        image::RgbImage::from_pixel(64, 64, image::Rgb([1, 2, 3]))
            .save(&source)
            .expect("保存测试图片");
        // 未被引用的原图不生成缩略图
        std::fs::write(images.join("orphan.png"), b"orphan").unwrap();

        let refs = refs_with(&[source.to_str().unwrap()]);
        let now = SystemTime::now() + Duration::from_secs(2 * 60 * 60);
        let mut stats = Stats::default();
        backfill_thumbs(&images, &refs, now, &mut stats);
        assert_eq!(stats.thumbs_created, 1);
        let keep_thumb = image_store::thumb_path_for(&source);
        assert!(keep_thumb.exists());
        assert!(!image_store::thumb_path_for(&images.join("orphan.png")).exists());

        // 源文件消失的缩略图被清理，仍有原图的保留
        std::fs::write(thumbs.join("gone.jpg"), b"x").unwrap();
        let stems: HashSet<String> = ["keep".to_string()].into_iter().collect();
        prune_thumbs(&images, &stems, now, &mut stats);
        assert!(!thumbs.join("gone.jpg").exists());
        assert!(keep_thumb.exists());
        std::fs::remove_dir_all(&dir).ok();
    }

    /// 只有「一级文件 + 已知扩展名 + 非点文件 + 超龄 + 未被引用」才回收
    #[test]
    fn decide_covers_all_boundaries() {
        let old = ORPHAN_MIN_AGE + Duration::from_secs(1);
        let young = ORPHAN_MIN_AGE - Duration::from_secs(1);
        assert_eq!(decide("a.png", true, old, false), Decision::Reclaim);
        assert_eq!(decide("a.png", true, old, true), Decision::Keep);
        assert_eq!(decide("a.png", true, young, false), Decision::SkipRecent);
        // 子目录（.trash）与点文件一律不动
        assert_eq!(decide(".trash", false, old, false), Decision::Ignore);
        assert_eq!(decide(".trash", true, old, false), Decision::Ignore);
        // 非图片扩展名不动，避免误删用户放进来的其它文件
        assert_eq!(decide("notes.txt", true, old, false), Decision::Ignore);
        assert_eq!(decide("noext", true, old, false), Decision::Ignore);
        // 大小写扩展名按图片处理
        assert_eq!(decide("A.PNG", true, old, false), Decision::Reclaim);
    }

    /// mtime 边界：3599s 跳过、3601s 回收
    #[test]
    fn decide_respects_age_threshold() {
        assert_eq!(
            decide("a.png", true, Duration::from_secs(3599), false),
            Decision::SkipRecent
        );
        assert_eq!(
            decide("a.png", true, Duration::from_secs(3601), false),
            Decision::Reclaim
        );
    }

    /// S1：引用都不在当前目录下（搬家/换机）→ 整体跳过
    #[test]
    fn sanity_skip_when_refs_point_elsewhere() {
        let images = Path::new(r"D:\app\images");
        let refs = refs_with(&[r"C:\old\images\a.png"]);
        assert!(sanity_skip(&refs, images, 10, false).is_some());
        // force 可越过
        assert!(sanity_skip(&refs, images, 10, true).is_none());
    }

    /// S1 反例：引用落在当前目录下 → 正常继续；带分隔符前缀防止 images2 误命中
    #[test]
    fn sanity_skip_allows_matching_directory() {
        let images = Path::new(r"D:\app\images");
        let refs = refs_with(&[r"D:\app\images\a.png"]);
        assert!(sanity_skip(&refs, images, 10, false).is_none());

        let sibling = refs_with(&[r"D:\app\images2\a.png"]);
        assert!(
            sanity_skip(&sibling, images, 10, false).is_some(),
            "images2 不能被 images 前缀误判为同一目录"
        );
    }

    /// S2：引用为空但目录已有成批超龄文件 → 疑似库损坏，整体跳过
    #[test]
    fn sanity_skip_when_refs_empty_but_files_exist() {
        let images = Path::new(r"D:\app\images");
        let empty = HashSet::new();
        assert!(sanity_skip(&empty, images, EMPTY_REFS_FILE_THRESHOLD, false).is_some());
        // 少量文件（首次使用）允许清理
        assert!(sanity_skip(&empty, images, EMPTY_REFS_FILE_THRESHOLD - 1, false).is_none());
        assert!(sanity_skip(&empty, images, 10, true).is_none());
    }
}
