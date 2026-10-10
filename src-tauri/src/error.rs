use thiserror::Error;

/// 应用内部统一错误类型。
///
/// 各变体的 `Display` 直接透出内层消息（不额外加前缀），保证与历史行为一致：
/// Tauri command 以 `String` message 序列化给前端，前端 `parseAdapterError`
/// 依赖原始消息文本。
#[derive(Debug, Error)]
pub enum AppError {
    #[error("{0}")]
    Io(#[from] std::io::Error),
    #[error("{0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("{0}")]
    Keyring(String),
    #[error("{0}")]
    Crypto(String),
    #[error(transparent)]
    Adapter(#[from] crate::adapters::AdapterError),
    #[error("{0}")]
    NotFound(String),
    #[error("{0}")]
    Other(String),
}

pub type AppResult<T> = Result<T, AppError>;

impl From<AppError> for String {
    fn from(e: AppError) -> String {
        e.to_string()
    }
}
