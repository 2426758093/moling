//! 统一秘密脱敏：URL / JSON / 错误体里的 Key、Bearer、token 在写日志或返回诊断前掩码。
//!
//! 只保留首尾各 4 个字符，足够核对「是不是同一把 Key 的尾号」，但不足以还原。
//! 外部案例：OpenCode Console 泄露事件与 OWASP 日志指南都指出凭据会藏在 URL query、
//! Header 与嵌套 JSON 里，因此所有出口统一走这里，而不是在每个调用点各写一遍。

const SECRET_NAMES: [&str; 10] = [
    "authorization",
    "access_token",
    "refresh_token",
    "api_key",
    "apikey",
    "api-key",
    "password",
    "secret",
    "token",
    "key",
];

pub fn redact_secrets(text: &str) -> String {
    let out = redact_assigned(text);
    let out = redact_bearer(&out);
    let out = redact_url_userinfo(&out);
    redact_prefixed(&out, "sk-")
}

fn mask_secret(value: &str) -> String {
    let chars: Vec<char> = value.chars().collect();
    if chars.len() <= 8 {
        return "****".into();
    }
    let head: String = chars[..4].iter().collect();
    let tail: String = chars[chars.len() - 4..].iter().collect();
    format!("{head}****{tail}")
}

fn is_ident(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_' || b == b'-'
}

fn is_value_delimiter(b: u8) -> bool {
    matches!(
        b,
        b'&' | b' ' | b'\t' | b'\n' | b'\r' | b'"' | b'\'' | b',' | b'}' | b']' | b')' | b';'
    )
}

/// 从 `start` 起取到下一个值分隔符（不包含分隔符）
fn value_end(bytes: &[u8], start: usize) -> usize {
    let mut end = start;
    while end < bytes.len() && !is_value_delimiter(bytes[end]) {
        end += 1;
    }
    end
}

/// `key=...` / `api_key: "..."` / `"accessToken" = '...'`
fn redact_assigned(text: &str) -> String {
    let bytes = text.as_bytes();
    let lower = text.to_ascii_lowercase();
    let mut out = String::with_capacity(text.len());
    let mut last = 0;
    let mut i = 0;
    while i < bytes.len() {
        if !text.is_char_boundary(i) || (i > 0 && is_ident(bytes[i - 1])) {
            i += 1;
            continue;
        }
        let Some(name) = SECRET_NAMES.iter().find(|n| lower[i..].starts_with(**n)) else {
            i += 1;
            continue;
        };
        let mut j = i + name.len();
        if j < bytes.len() && is_ident(bytes[j]) {
            i += 1;
            continue;
        }
        while j < bytes.len() && bytes[j].is_ascii_whitespace() {
            j += 1;
        }
        if j < bytes.len() && (bytes[j] == b'"' || bytes[j] == b'\'') {
            j += 1;
            while j < bytes.len() && bytes[j].is_ascii_whitespace() {
                j += 1;
            }
        }
        if j >= bytes.len() || (bytes[j] != b'=' && bytes[j] != b':') {
            i += 1;
            continue;
        }
        j += 1;
        while j < bytes.len() && bytes[j].is_ascii_whitespace() {
            j += 1;
        }
        if j < bytes.len() && (bytes[j] == b'"' || bytes[j] == b'\'') {
            j += 1;
        }
        let end = value_end(bytes, j);
        // 空值 / 已掩码值不再处理，保证幂等
        if end > j && !text[j..end].contains('*') {
            out.push_str(&text[last..j]);
            out.push_str(&mask_secret(&text[j..end]));
            last = end;
        }
        i = end.max(j);
    }
    out.push_str(&text[last..]);
    out
}

fn redact_bearer(text: &str) -> String {
    let bytes = text.as_bytes();
    let lower = text.to_ascii_lowercase();
    let mut out = String::with_capacity(text.len());
    let mut last = 0;
    let mut search = 0;
    while let Some(pos) = lower[search..].find("bearer ") {
        let start = search + pos + "bearer ".len();
        if !text.is_char_boundary(start) {
            search = start;
            continue;
        }
        let end = value_end(bytes, start);
        if end > start && !text[start..end].contains('*') {
            out.push_str(&text[last..start]);
            out.push_str(&mask_secret(&text[start..end]));
            last = end;
        }
        search = end.max(start);
    }
    out.push_str(&text[last..]);
    out
}

/// `scheme://user:pass@host` —— 保留 host，掩码 userinfo
fn redact_url_userinfo(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut last = 0;
    let mut search = 0;
    while let Some(pos) = text[search..].find("://") {
        let scheme_end = search + pos + 3;
        let rest = &text[scheme_end..];
        let stop = rest
            .find(|c: char| {
                c == '/' || c == '?' || c == '#' || c == '"' || c == '\'' || c.is_whitespace()
            })
            .unwrap_or(rest.len());
        if let Some(at) = rest[..stop].rfind('@') {
            let userinfo = &rest[..at];
            if !userinfo.is_empty() && !userinfo.contains('*') {
                out.push_str(&text[last..scheme_end]);
                out.push_str(&mask_secret(userinfo));
                last = scheme_end + userinfo.len();
            }
        }
        search = scheme_end + stop.max(1);
    }
    out.push_str(&text[last..]);
    out
}

/// 没有 `key=` 语境时兜底识别 `sk-...` 形态的 Key
fn redact_prefixed(text: &str, prefix: &str) -> String {
    let bytes = text.as_bytes();
    let lower = text.to_ascii_lowercase();
    let mut out = String::with_capacity(text.len());
    let mut last = 0;
    let mut search = 0;
    while let Some(pos) = lower[search..].find(prefix) {
        let start = search + pos;
        if start > 0 && is_ident(bytes[start - 1]) {
            search = start + prefix.len();
            continue;
        }
        let mut end = start + prefix.len();
        while end < bytes.len() && is_ident(bytes[end]) {
            end += 1;
        }
        let token = &text[start..end];
        if end > start && end - start > prefix.len() + 8 && !token.contains('*') {
            out.push_str(&text[last..start]);
            out.push_str(&mask_secret(token));
            last = end;
        }
        search = end.max(start + prefix.len());
    }
    out.push_str(&text[last..]);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn masks_keys_in_urls_and_json_without_losing_context() {
        let url = "GET https://api.example.com/draw?key=sk-live-abcdef123456&size=1024";
        let red = redact_secrets(url);
        assert!(!red.contains("sk-live-abcdef123456"), "{red}");
        assert!(red.contains("size=1024"), "{red}");
        assert!(red.contains("api.example.com"), "{red}");

        let json = r#"{"api_key":"sk-proj-abcdef123456","model":"gpt-image-1"}"#;
        let red = redact_secrets(json);
        assert!(!red.contains("sk-proj-abcdef123456"), "{red}");
        assert!(red.contains(r#""model":"gpt-image-1""#), "{red}");
    }

    #[test]
    fn masks_bearer_and_url_userinfo() {
        let header = "Authorization: Bearer sk-abcdefghijklmnop";
        let red = redact_secrets(header);
        assert!(!red.contains("sk-abcdefghijklmnop"), "{red}");
        assert!(red.contains("Authorization"), "{red}");

        let url = "https://alice:s3cret-pass@example.com/v1/images";
        let red = redact_secrets(url);
        assert!(!red.contains("s3cret-pass"), "{red}");
        assert!(red.contains("example.com"), "{red}");
    }

    #[test]
    fn redaction_is_idempotent_and_leaves_plain_text_alone() {
        let masked = redact_secrets("key=sk-abcdefghijklmnop");
        assert_eq!(redact_secrets(&masked), masked);
        assert_eq!(redact_secrets("HTTP 400: bad size"), "HTTP 400: bad size");
        // 短值不展开，直接整体掩码；不会 panic
        assert_eq!(redact_secrets("key=abc"), "key=****");
    }
}
