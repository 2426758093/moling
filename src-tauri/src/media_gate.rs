//! 媒体根写入门闩（AI-Slop F-004）。
//!
//! 媒体根迁移是「复制 → 改写数据库 → 切换引导文件 → 清理旧目录」的多步过程，
//! 期间任何一次图片落盘都可能写进即将被清理的旧目录，迁移完成后这张图就丢了。
//! 原来的保护只有 `has_running_jobs()`（队列任务），而聊天生成、提示词资产、
//! 画布等落盘都不经 jobs 表，因此漏掉了主要写入方。
//!
//! 这里用一个「迁移标志 + 在途写者计数」的写入门闩：
//!
//! - 写盘入口（`image_store::save_b64_image` / `save_ref_image`）先登记在途，
//!   迁移标志已置位时直接返回可读错误（不阻塞 UI 线程）；
//! - 迁移开始先置标志，再等待在途写者归零，之后才复制/切换；
//! - 迁移结束（含失败）由 `Drop` 清标志。
//!
//! 为什么不用 `RwLock`：读守卫会跨整个文件写入持有，而迁移的写守卫要跨
//! 「复制整棵目录」持有。一旦迁移在跑，后续写者会阻塞在读锁上，占住 tokio
//! worker 线程直到复制结束；用计数 + 快速失败既保住同一不变量，又不把异步
//! 运行时拖死。

use crate::error::{AppError, AppResult};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::time::{Duration, Instant};

/// 迁移进行中：新写者一律快速失败
static MIGRATING: AtomicBool = AtomicBool::new(false);
/// 已登记、尚未完成的写者数量
static ACTIVE_WRITERS: AtomicUsize = AtomicUsize::new(0);

/// 迁移期间写盘被拒绝时给用户看的文案（前端直接 toast）
pub const MIGRATING_MESSAGE: &str = "媒体目录正在迁移，图片暂存已暂停，请稍后重试";

/// 写盘登记：成功返回的守卫在 drop 时把在途计数减一。
///
/// 两次检查标志：登记之后迁移可能刚好开始，此时必须立即退出，否则迁移的
/// 等待循环会一直等不到归零。
pub struct WriterGuard;

pub fn enter_writer() -> AppResult<WriterGuard> {
    if MIGRATING.load(Ordering::SeqCst) {
        return Err(AppError::Other(MIGRATING_MESSAGE.into()));
    }
    ACTIVE_WRITERS.fetch_add(1, Ordering::SeqCst);
    if MIGRATING.load(Ordering::SeqCst) {
        ACTIVE_WRITERS.fetch_sub(1, Ordering::SeqCst);
        return Err(AppError::Other(MIGRATING_MESSAGE.into()));
    }
    Ok(WriterGuard)
}

impl Drop for WriterGuard {
    fn drop(&mut self) {
        ACTIVE_WRITERS.fetch_sub(1, Ordering::SeqCst);
    }
}

/// 迁移守卫：置标志并等待在途写者归零；drop 时清标志。
pub struct MigrationGate;

impl MigrationGate {
    /// `timeout` 只用于等待在途写者，超时说明有写入卡死，宁可放弃迁移。
    pub fn acquire(timeout: Duration) -> AppResult<Self> {
        MIGRATING.store(true, Ordering::SeqCst);
        let deadline = Instant::now() + timeout;
        while ACTIVE_WRITERS.load(Ordering::SeqCst) > 0 {
            if Instant::now() >= deadline {
                MIGRATING.store(false, Ordering::SeqCst);
                return Err(AppError::Other(
                    "等待进行中的图片写入超时，已取消迁移，请稍后重试".into(),
                ));
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        Ok(MigrationGate)
    }
}

impl Drop for MigrationGate {
    fn drop(&mut self) {
        MIGRATING.store(false, Ordering::SeqCst);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Mutex, MutexGuard};

    /// 全局状态，测试之间必须串行
    static TEST_LOCK: Mutex<()> = Mutex::new(());

    fn serial() -> MutexGuard<'static, ()> {
        TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner())
    }

    #[test]
    fn writer_enters_when_idle_and_drops_count() {
        let _s = serial();
        let guard = enter_writer().expect("空闲时允许写盘");
        assert!(!MIGRATING.load(Ordering::SeqCst));
        drop(guard);
        assert_eq!(ACTIVE_WRITERS.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn writer_fails_fast_while_migrating() {
        let _s = serial();
        let gate = MigrationGate::acquire(Duration::from_millis(50)).expect("无在途写者");
        assert!(MIGRATING.load(Ordering::SeqCst));
        let err = enter_writer().err().expect("迁移中写盘应被拒绝");
        assert!(err.to_string().contains("迁移"));
        drop(gate);
        assert!(!MIGRATING.load(Ordering::SeqCst), "迁移结束后必须清标志");
        assert!(enter_writer().is_ok(), "迁移结束后恢复写盘");
    }

    #[test]
    fn migration_waits_for_inflight_writer() {
        let _s = serial();
        let (ready_tx, ready_rx) = std::sync::mpsc::channel();
        // 写者必须在另一个线程释放：迁移会阻塞等它归零
        let writer = std::thread::spawn(move || {
            let guard = enter_writer().expect("登记在途写者");
            ready_tx.send(()).expect("通知主线程");
            std::thread::sleep(Duration::from_millis(80));
            drop(guard);
        });
        ready_rx.recv().expect("写者已登记");

        let started = Instant::now();
        let gate = MigrationGate::acquire(Duration::from_secs(2)).expect("写者释放后应拿到迁移");
        assert!(
            started.elapsed() >= Duration::from_millis(40),
            "确实等过写者"
        );
        assert_eq!(
            ACTIVE_WRITERS.load(Ordering::SeqCst),
            0,
            "拿到迁移时在途写者已归零"
        );

        drop(gate);
        writer.join().expect("写者线程结束");
        assert!(!MIGRATING.load(Ordering::SeqCst), "迁移结束后清标志");
    }

    #[test]
    fn migration_times_out_when_writer_stuck() {
        let _s = serial();
        let _writer = enter_writer().expect("登记在途写者");
        let err = MigrationGate::acquire(Duration::from_millis(20))
            .err()
            .expect("写者不释放时迁移应超时");
        assert!(err.to_string().contains("超时"));
        assert!(!MIGRATING.load(Ordering::SeqCst), "超时后必须清标志");
    }
}
