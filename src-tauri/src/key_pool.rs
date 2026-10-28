//! 多 Key 轮换：按内存游标给出候选顺序，401 标记失效并切到下一个 Key。
//!
//! 游标只存在内存里（进程重启从头开始），失效标记才是需要跨重启保留的状态，
//! 它落在 `api_keys_enc` 的 JSON 里。

use crate::adapters::{AdapterError, ProviderConfig};
use crate::storage;
use std::collections::HashMap;
use std::sync::{LazyLock, Mutex, MutexGuard};

static CURSORS: LazyLock<Mutex<HashMap<i64, usize>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

fn cursors() -> MutexGuard<'static, HashMap<i64, usize>> {
    CURSORS.lock().unwrap_or_else(|e| e.into_inner())
}

/// 一个待尝试的 Key；`index` 是它在 Key 列表中的原始下标，用于回写失效状态。
pub struct Candidate {
    pub index: usize,
    pub config: ProviderConfig,
}

fn base_config(row: &storage::ProviderRow) -> ProviderConfig {
    let extra_params = storage::get_setting(&format!("extraParams:{}", row.id))
        .ok()
        .flatten()
        .unwrap_or_default();
    ProviderConfig {
        id: Some(row.id),
        name: row.name.clone(),
        base_url: row.base_url.clone(),
        api_key: String::new(),
        kind: row.kind.clone(),
        models_json: row.models_json.clone(),
        default_model: row.default_model.clone(),
        timeout_secs: row.timeout_secs,
        template_url: row.template_url.clone(),
        template_body: row.template_body.clone(),
        template_response_path: row.template_response_path.clone(),
        extra_params,
    }
}

/// 候选下标的排列：从游标开始环形遍历，跳过已失效；全部失效时退化为整组。
fn order_indexes(total: usize, start: usize, invalid: &[bool]) -> Vec<usize> {
    if total == 0 {
        return Vec::new();
    }
    let start = start % total;
    let ordered: Vec<usize> = (0..total).map(|i| (start + i) % total).collect();
    let usable: Vec<usize> = ordered.iter().copied().filter(|&i| !invalid[i]).collect();
    if usable.is_empty() {
        ordered
    } else {
        usable
    }
}

/// 候选序列：当前 Key → 其后 → 其余。全部失效时仍返回整组作为兜底，
/// 避免「所有 Key 都被标记」时服务商彻底不可用（用户可重置或补新 Key）。
pub fn candidates(provider_id: i64) -> Result<Vec<Candidate>, String> {
    let row = storage::get_provider(provider_id)?.ok_or_else(|| "服务商不存在".to_string())?;
    let keys = storage::load_provider_keys(provider_id)?;
    let total = keys.len();
    if total == 0 {
        return Ok(Vec::new());
    }
    let start = cursors().get(&provider_id).copied().unwrap_or(0);
    let invalid: Vec<bool> = keys.iter().map(|k| k.invalid).collect();
    let base = base_config(&row);
    Ok(order_indexes(total, start, &invalid)
        .into_iter()
        .map(|index| Candidate {
            index,
            config: ProviderConfig {
                api_key: keys[index].key.clone(),
                ..base.clone()
            },
        })
        .collect())
}

/// 成功后把游标指向成功 Key，下次优先用它。
pub fn note_success(provider_id: i64, index: usize) {
    cursors().insert(provider_id, index);
}

pub fn is_auth(err: &AdapterError) -> bool {
    matches!(err, AdapterError::AuthInvalid { .. })
}

/// 401 视为 Key 失效并持久标记；403 多是权限/配额策略，只切换不标记，
/// 否则一次临时限制就会让 Key 永久被跳过。写库失败只记日志，不影响本次切换。
pub fn note_auth_failure(provider_id: i64, index: usize, err: &AdapterError) {
    if let AdapterError::AuthInvalid { status: 401, .. } = err {
        if let Err(e) = storage::mark_key_invalid(provider_id, index, true) {
            tracing::warn!("标记 Key 失效失败（重启后回填会重试）: {e}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn order_prefers_valid_from_cursor() {
        let all_valid = [false, false, false];
        assert_eq!(order_indexes(3, 0, &all_valid), vec![0, 1, 2]);
        assert_eq!(order_indexes(3, 1, &all_valid), vec![1, 2, 0]);
        // 游标越界（Key 被删）时按取模回绕，不 panic
        assert_eq!(order_indexes(3, 5, &all_valid), vec![2, 0, 1]);
        assert!(order_indexes(0, 0, &[]).is_empty());
    }

    #[test]
    fn order_skips_invalid_but_keeps_fallback() {
        assert_eq!(order_indexes(3, 0, &[true, false, false]), vec![1, 2]);
        assert_eq!(order_indexes(3, 2, &[true, false, false]), vec![2, 1]);
        // 全失效兜底：整组仍按游标顺序尝试，不返回空列表
        assert_eq!(order_indexes(3, 0, &[true, true, true]), vec![0, 1, 2]);
        assert_eq!(order_indexes(2, 1, &[true, true]), vec![1, 0]);
    }

    #[test]
    fn auth_status_classification() {
        let unauthorized = AdapterError::AuthInvalid {
            message: String::new(),
            status: 401,
        };
        let forbidden = AdapterError::AuthInvalid {
            message: String::new(),
            status: 403,
        };
        let network = AdapterError::Network {
            message: String::new(),
        };
        assert!(is_auth(&unauthorized));
        assert!(is_auth(&forbidden));
        assert!(!is_auth(&network));
    }
}
