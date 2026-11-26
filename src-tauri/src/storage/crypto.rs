use crate::error::{AppError, AppResult};
use aes_gcm::{
    aead::{Aead, KeyInit, OsRng},
    Aes256Gcm, Nonce,
};
use base64::Engine;
use rand::RngCore;
use std::sync::OnceLock;

/// keyring 服务名/账号（跨版本冻结，勿改）
const MASTER_KEY_SERVICE: &str = "moling";
const MASTER_KEY_USER: &str = "master-key";
pub(crate) const MASTER_KEY_ENV: &str = "MOLING_MASTER_KEY_HEX";

const KEYRING_READ_REFUSE: &str = "无法读取系统凭据管理器，拒绝轮换主密钥以避免数据丢失";

/// 主密钥进程内缓存（R6：避免每行解密都走一次 DPAPI 系统调用）。
/// 注意：环境变量注入路径不走进程缓存，便于测试与便携模式外部轮换。
static MASTER_KEY: OnceLock<[u8; 32]> = OnceLock::new();
fn master_key() -> AppResult<[u8; 32]> {
    // 允许通过环境变量注入主密钥（测试 / 便携模式）
    if let Ok(hex_env) = std::env::var(MASTER_KEY_ENV) {
        return parse_hex_key(&hex_env)
            .map_err(|_| AppError::Crypto(format!("{MASTER_KEY_ENV} 必须是 64 位十六进制")));
    }
    if let Some(key) = MASTER_KEY.get() {
        return Ok(*key);
    }
    let key = load_or_create_master_key()?;
    // 并发首次加载时多个线程可能各自读到相同 keyring 值；创建路径总是先写
    // keyring 再返回，因此竞争双方的值必然一致，缓存任一即可。
    Ok(*MASTER_KEY.get_or_init(|| key))
}

/// 从 keyring 读取主密钥；仅当凭据明确不存在（首次运行）时才生成并写入新密钥。
/// 读取失败一律报错，绝不静默轮换主密钥（否则所有已存 API Key 永久不可解）。
fn load_or_create_master_key() -> AppResult<[u8; 32]> {
    let entry = keyring::Entry::new(MASTER_KEY_SERVICE, MASTER_KEY_USER)
        .map_err(|e| AppError::Keyring(format!("创建凭据管理器条目失败: {e}")))?;
    match entry.get_password() {
        Ok(hex) => parse_hex_key(&hex).map_err(|msg| {
            tracing::error!("keyring 中存储的主密钥无法解析（{msg}），拒绝轮换以避免数据丢失");
            AppError::Keyring(format!(
                "{KEYRING_READ_REFUSE}: 已存储的主密钥格式异常（{msg}）"
            ))
        }),
        Err(keyring::Error::NoEntry) => {
            let mut key = [0u8; 32];
            rand::rngs::OsRng.fill_bytes(&mut key);
            let hex_str: String = key.iter().map(|b| format!("{:02x}", b)).collect();
            entry.set_password(&hex_str).map_err(|e| {
                tracing::error!("无法写入系统凭据管理器: {e}");
                AppError::Keyring(format!("无法写入系统凭据管理器: {e}"))
            })?;
            // 无 info 级别日志配置（默认仅落盘 WARN/ERROR），主密钥创建属安全关键事件，用 warn 留痕
            tracing::warn!("首次运行：已生成新的主加密密钥并写入系统凭据管理器");
            Ok(key)
        }
        Err(e) => {
            tracing::error!("{KEYRING_READ_REFUSE}: {e}");
            Err(AppError::Keyring(format!("{KEYRING_READ_REFUSE}: {e}")))
        }
    }
}

/// 启动预热主密钥（F-013）：把 keyring 读取提前到启动期，避免首个「保存服务商」
/// 或首次解密 Key 时才在持锁路径上做 keyring IO；失败只记日志，不阻断启动。
pub fn warm_master_key() {
    if let Err(e) = master_key() {
        tracing::warn!("主密钥预热失败（将在首次使用 Key 时重试）: {e}");
    }
}

fn parse_hex_key(hex_str: &str) -> Result<[u8; 32], &'static str> {
    let bytes = hex::decode_inner(hex_str).map_err(|_| "hex 解码失败")?;
    if bytes.len() != 32 {
        return Err("长度不是 32 字节");
    }
    let mut key = [0u8; 32];
    key.copy_from_slice(&bytes);
    Ok(key)
}

pub fn encrypt_secret(plain: &str) -> AppResult<String> {
    let key = master_key()?;
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|e| AppError::Crypto(e.to_string()))?;
    let mut nonce_bytes = [0u8; 12];
    OsRng.fill_bytes(&mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);
    let ciphertext = cipher
        .encrypt(nonce, plain.as_bytes())
        .map_err(|e| AppError::Crypto(e.to_string()))?;
    let mut packed = nonce_bytes.to_vec();
    packed.extend_from_slice(&ciphertext);
    Ok(base64::engine::general_purpose::STANDARD.encode(packed))
}

pub fn decrypt_secret(enc: &str) -> AppResult<String> {
    if enc.is_empty() {
        return Ok(String::new());
    }
    let packed = base64::engine::general_purpose::STANDARD
        .decode(enc)
        .map_err(|e| AppError::Crypto(e.to_string()))?;
    if packed.len() < 13 {
        return Err(AppError::Crypto("密文长度异常".into()));
    }
    let key = master_key()?;
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|e| AppError::Crypto(e.to_string()))?;
    let nonce = Nonce::from_slice(&packed[..12]);
    let plain = cipher
        .decrypt(nonce, &packed[12..])
        .map_err(|_| AppError::Crypto("Key 解密失败（主密钥可能已变化）".into()))?;
    String::from_utf8(plain).map_err(|e| AppError::Crypto(e.to_string()))
}

/// API Key 脱敏：按字符（而非字节）截取头尾各 4 位，短 Key 整体遮蔽。
/// 用户 Key 可能含多字节字符，字节切片会在 UTF-8 边界 panic（B1）。
pub fn mask_key(key: &str) -> String {
    if key.chars().count() <= 8 {
        return "****".to_string();
    }
    let head: String = key.chars().take(4).collect();
    let tail: String = key
        .chars()
        .rev()
        .take(4)
        .collect::<String>()
        .chars()
        .rev()
        .collect();
    format!("{}...{}", head, tail)
}
// 避免引入 hex crate 的小工具
mod hex {
    /// 按字节两两解析，并显式拒绝非 ASCII 输入。
    /// 旧实现先按字节长度判断偶数、再用 `&s[i..i + 2]` 切片，遇到多字节字符
    /// （例如把 MOLING_MASTER_KEY_HEX 误设成中文）会在 UTF-8 边界 panic。
    pub fn decode_inner(s: &str) -> Result<Vec<u8>, String> {
        let bytes = s.as_bytes();
        if !bytes.len().is_multiple_of(2) {
            return Err("hex 长度异常".into());
        }
        bytes
            .chunks(2)
            .map(|pair| {
                let text =
                    std::str::from_utf8(pair).map_err(|_| "hex 含非 ASCII 字符".to_string())?;
                u8::from_str_radix(text, 16).map_err(|e| e.to_string())
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::test_support::*;

    #[test]
    fn mask_key_is_utf8_safe() {
        assert_eq!(mask_key("sk-test-1234567890"), "sk-t...7890");
        // 中文/多字节字符不按字节切片
        assert_eq!(mask_key("密钥甲乙丙丁戊己庚辛壬癸"), "密钥甲乙...庚辛壬癸");
        assert_eq!(mask_key("日本語のキーですよ"), "日本語の...ーですよ");
        // 短 Key 整体遮蔽
        assert_eq!(mask_key("short"), "****");
        assert_eq!(mask_key(""), "****");
        assert_eq!(mask_key("12345678"), "****");
        assert_eq!(mask_key("123456789"), "1234...6789");
    }

    #[test]
    fn master_key_env_var_path_and_errors() {
        let _guard = ENV_LOCK.lock().unwrap();
        std::env::set_var(MASTER_KEY_ENV, "aa".repeat(32));
        let enc = encrypt_secret("hello").expect("encrypt with env master key");
        assert_eq!(decrypt_secret(&enc).unwrap(), "hello");
        // 非法长度必须报错而不是生成新密钥
        std::env::set_var(MASTER_KEY_ENV, "abcd".repeat(10));
        assert!(encrypt_secret("x").is_err());
        std::env::remove_var(MASTER_KEY_ENV);
    }

    #[test]
    fn hex_key_parsing() {
        assert!(parse_hex_key(&"aa".repeat(32)).is_ok());
        assert!(parse_hex_key("zzzz").is_err());
        assert!(parse_hex_key("aabb").is_err()); // 长度不足 32 字节
    }

    /// B1 同类：非 ASCII 主密钥必须报错而不是在 UTF-8 边界 panic
    #[test]
    fn hex_key_parsing_rejects_non_ascii() {
        assert!(parse_hex_key("密钥密钥").is_err());
        assert!(parse_hex_key("aa密").is_err());
    }
}
