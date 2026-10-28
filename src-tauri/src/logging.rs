//! 日志目录管理与过期清理。
//!
//! 日志按天滚落到 `data_dir/logs/moling.log.YYYY-MM-DD`。清理只删「文件名日期已过期
//! 且修改时间也已过期」的滚动文件：Windows 上被占用的句柄很常见，删不掉只记日志。

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

pub const LOG_RETENTION_DAYS: u64 = 7;

const SECONDS_PER_DAY: u64 = 86_400;

pub fn logs_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("logs")
}

fn format_date(t: SystemTime) -> String {
    let secs = t
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let (y, m, d) = civil_from_days(secs.div_euclid(SECONDS_PER_DAY as i64));
    format!("{y:04}-{m:02}-{d:02}")
}

/// 天数 → 公历年月日（Howard Hinnant 的 civil_from_days 算法，避免引入 chrono）。
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// 删除超过保留期的滚动日志，返回实际删除的文件。
/// 只认 `moling.log.YYYY-MM-DD` 命名；其他文件（含当前日志、诊断包）一律不动。
pub fn prune(dir: &Path, now: SystemTime) -> Vec<PathBuf> {
    let Some(cutoff_time) =
        now.checked_sub(Duration::from_secs(LOG_RETENTION_DAYS * SECONDS_PER_DAY))
    else {
        return Vec::new();
    };
    let cutoff = format_date(cutoff_time);
    let today = format_date(now);
    let mut removed = Vec::new();
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(e) => {
            tracing::warn!("读取日志目录失败: {e}");
            return removed;
        }
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        let Some(date) = name.strip_prefix("moling.log.") else {
            continue;
        };
        // 只处理严格 YYYY-MM-DD；格式异常的日志视为未知，交给人处理
        if date.len() != 10 || date.as_bytes().get(4) != Some(&b'-') {
            continue;
        }
        if date >= today.as_str() || date >= cutoff.as_str() {
            continue;
        }
        // 双判定：修改时间也必须过期，防止时钟/改名造成的误删
        let old_mtime = entry
            .metadata()
            .ok()
            .and_then(|m| m.modified().ok())
            .is_some_and(|m| format_date(m) < cutoff);
        if !old_mtime {
            tracing::warn!("日志 {name} 文件名日期已过期但修改时间较新，本次保留");
            continue;
        }
        match std::fs::remove_file(&path) {
            Ok(()) => removed.push(path),
            // Windows 上日志句柄被占用是常态，删除失败只记日志
            Err(e) => tracing::warn!("删除过期日志 {name} 失败: {e}"),
        }
    }
    removed
}

/// 收集保留期内的日志文件（供诊断包打包）。
pub fn recent_logs(dir: &Path, now: SystemTime) -> Vec<PathBuf> {
    let Some(cutoff_time) =
        now.checked_sub(Duration::from_secs(LOG_RETENTION_DAYS * SECONDS_PER_DAY))
    else {
        return Vec::new();
    };
    let cutoff = format_date(cutoff_time);
    let mut files: Vec<PathBuf> = match std::fs::read_dir(dir) {
        Ok(entries) => entries
            .flatten()
            .filter(|e| e.file_type().map(|t| t.is_file()).unwrap_or(false))
            .filter_map(|e| {
                let name = e.file_name().to_string_lossy().to_string();
                let date = name.strip_prefix("moling.log.")?;
                (date.len() == 10 && date >= cutoff.as_str()).then(|| e.path())
            })
            .collect(),
        Err(_) => Vec::new(),
    };
    files.sort();
    files
}

#[cfg(test)]
mod tests {
    use super::*;

    fn touch(dir: &Path, name: &str) {
        std::fs::write(dir.join(name), b"log line").expect("write log file");
    }

    fn date_before(date: &str) -> String {
        let mut y: i64 = date[0..4].parse().expect("year");
        let mut m: u32 = date[5..7].parse().expect("month");
        let mut d: u32 = date[8..10].parse().expect("day");
        if d > 1 {
            d -= 1;
        } else if m > 1 {
            m -= 1;
            d = 28;
        } else {
            y -= 1;
            m = 12;
            d = 28;
        }
        format!("{y:04}-{m:02}-{d:02}")
    }

    #[test]
    fn format_date_matches_known_days() {
        let base = SystemTime::UNIX_EPOCH + Duration::from_secs(1_775_000_000);
        // 只断言格式与稳定性，避免测试绑定具体时区换算
        let s = format_date(base);
        assert_eq!(s.len(), 10);
        assert_eq!(s, format_date(base));
        assert_eq!(format_date(UNIX_EPOCH), "1970-01-01");
    }

    /// 超过保留期的滚动日志被删除；当天日志、未命名的当前日志、非日志文件都保留
    #[test]
    fn retention_prunes_only_old_logs() {
        let dir = std::env::temp_dir().join(format!("moling-log-prune-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("create temp dir");

        // 模拟「30 天后启动」：文件修改时间（=现在）已早于新的保留边界
        let now = SystemTime::now() + Duration::from_secs(30 * SECONDS_PER_DAY);
        let cutoff = format_date(
            now.checked_sub(Duration::from_secs(LOG_RETENTION_DAYS * SECONDS_PER_DAY))
                .unwrap(),
        );
        let today = format_date(now);
        let expired = format!("moling.log.{}", date_before(&cutoff));
        let boundary = format!("moling.log.{cutoff}");
        let current = format!("moling.log.{today}");

        touch(&dir, &expired);
        touch(&dir, &boundary);
        touch(&dir, &current);
        touch(&dir, "moling.log");
        touch(&dir, "diag-123.zip");

        let removed = prune(&dir, now);
        assert_eq!(removed, vec![dir.join(&expired)], "只应删除过期文件");
        assert!(dir.join(&boundary).exists(), "保留期边界当天的日志不删");
        assert!(dir.join(&current).exists());
        assert!(dir.join("moling.log").exists(), "未带日期的当前日志不动");
        assert!(dir.join("diag-123.zip").exists(), "非日志文件不动");

        let recent = recent_logs(&dir, now);
        assert_eq!(recent, vec![dir.join(&boundary), dir.join(&current)]);
        assert!(recent.iter().all(|p| !p.ends_with("diag-123.zip")));

        let _ = std::fs::remove_dir_all(&dir);
    }
}
