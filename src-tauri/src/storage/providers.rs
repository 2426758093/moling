use super::*;

use crate::error::{AppError, AppResult};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderRow {
    pub id: i64,
    pub name: String,
    pub base_url: String,
    #[serde(skip_serializing)]
    pub api_key_enc: String,
    pub kind: String,
    pub models_json: String,
    pub default_model: String,
    pub timeout_secs: u64,
    pub template_url: String,
    pub template_body: String,
    pub template_response_path: String,
    /// 编辑/变换模板（JSON：{url, body, responsePath}），空串表示未配置
    pub edit_template_json: String,
    pub transform_template_json: String,
    pub api_key_masked: String,
    pub has_key: bool,
    /// 密文非空但解密失败（主密钥丢失/密文损坏），前端据此提示"密钥损坏，请重新填写"
    #[serde(default)]
    pub key_error: bool,
}

/// 服务商 Key 列表中的一项。整组以 JSON 加密存于 `providers.api_keys_enc`；
/// `api_key_enc` 始终镜像首项，兼容旧代码/旧备份/思考模型复用路径。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProviderKey {
    pub key: String,
    #[serde(default)]
    pub invalid: bool,
    #[serde(default)]
    pub invalid_at: Option<String>,
}

impl ProviderKey {
    pub fn new(key: impl Into<String>) -> Self {
        Self {
            key: key.into(),
            invalid: false,
            invalid_at: None,
        }
    }

    /// 备份恢复用：保留失效标记，时间戳记为导入时刻
    pub fn restored(key: impl Into<String>, invalid: bool) -> Self {
        Self {
            key: key.into(),
            invalid,
            invalid_at: if invalid {
                Some(timestamp_millis())
            } else {
                None
            },
        }
    }
}
/// 服务商可编辑字段（save_provider / import_config 共用）
pub struct ProviderDraft<'a> {
    pub name: &'a str,
    pub base_url: &'a str,
    /// 明文 Key；`None` 表示更新时保留旧密文
    pub api_key: Option<&'a str>,
    pub kind: &'a str,
    pub models_json: &'a str,
    pub default_model: &'a str,
    pub timeout_secs: u64,
    pub template_url: &'a str,
    pub template_body: &'a str,
    pub template_response_path: &'a str,
    pub edit_template_json: &'a str,
    pub transform_template_json: &'a str,
}
fn row_to_provider(row: &rusqlite::Row) -> rusqlite::Result<ProviderRow> {
    let id: i64 = row.get(0)?;
    let enc: String = row.get(3)?;
    // 空密文 = 未设置 Key（正常空串）；非空但解密失败 = 密文损坏/主密钥变化，
    // 标记 key_error 透出前端，禁止静默吞错（R2）
    let (key, key_error) = match decrypt_secret(&enc) {
        Ok(k) => (k, false),
        Err(e) => {
            tracing::warn!(
                "服务商 id={} 的 API Key 解密失败，标记 key_error: {}",
                id,
                e
            );
            (String::new(), true)
        }
    };
    Ok(ProviderRow {
        id,
        name: row.get(1)?,
        base_url: row.get(2)?,
        api_key_enc: enc,
        kind: row.get(4)?,
        models_json: row.get(5)?,
        default_model: row.get(6)?,
        timeout_secs: row.get::<_, i64>(7)? as u64,
        template_url: row.get(8)?,
        template_body: row.get(9)?,
        template_response_path: row.get(10)?,
        edit_template_json: row.get(11)?,
        transform_template_json: row.get(12)?,
        api_key_masked: mask_key(&key),
        has_key: !key.is_empty(),
        key_error,
    })
}
/// 服务商请求超时的合法区间（秒）：过小会截断正常出图，过大则像卡死
pub const MIN_PROVIDER_TIMEOUT_SECS: u64 = 5;
pub const MAX_PROVIDER_TIMEOUT_SECS: u64 = 1800;
/// 默认等待上限：与 OpenAI 官方 SDK 的 600s 默认一致。
/// 图片接口是同步长请求（gpt-image 类模型实测中位约 195s、p95 约 280s），
/// 旧的 60s 默认会在上游正常出图前掐断连接，而断开后上游仍会跑完并计费。
pub const DEFAULT_PROVIDER_TIMEOUT_SECS: u64 = 600;

/// 超时越界值静默夹到合法区间，避免 0s 必超时 / 10 万秒像卡死
pub fn clamp_provider_timeout(secs: u64) -> u64 {
    secs.clamp(MIN_PROVIDER_TIMEOUT_SECS, MAX_PROVIDER_TIMEOUT_SECS)
}
/// 保存服务商：读-改-写走两阶段 CAS（D1）。
///
/// 加解密是慢操作（首次读 keyring 可达数百毫秒），必须在拿 DB 锁之前算好（F-013）。
/// 先短锁读取 Key 密文 → 锁外解密重建 → `BEGIN IMMEDIATE` 内重读比对；
/// 期间被其它保存改过就重试，避免把并发写入的 Key 列表覆盖掉。
pub fn save_provider(id: Option<i64>, draft: &ProviderDraft) -> AppResult<ProviderRow> {
    const MAX_CAS_ATTEMPTS: usize = 3;
    let empty_enc = encrypt_secret("")?;
    // D10：超时只接受 5–1800 秒，越界值静默夹住，避免 0s 必超时 / 10 万秒像卡死
    let timeout_secs = clamp_provider_timeout(draft.timeout_secs);
    for attempt in 1..=MAX_CAS_ATTEMPTS {
        // 短锁只读：换 Key 时需要旧密文才能保留整组列表，解密放到锁外
        let observed = match id {
            Some(existing) => {
                let c = conn()?;
                c.query_row(
                    "SELECT api_keys_enc, api_key_enc FROM providers WHERE id = ?1",
                    params![existing],
                    |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
                )
                .optional()?
            }
            None => None,
        };
        // 主密钥变化后旧密文解不开：按用户新填的 Key 重建列表，而不是让保存失败
        let rebuilt_keys = match draft.api_key {
            Some(new_key) => {
                let mut keys = match &observed {
                    Some((keys_enc, legacy_enc)) => decode_keys(keys_enc, legacy_enc)
                        .unwrap_or_else(|e| {
                            tracing::warn!("保存服务商时旧 Key 解密失败，按新 Key 重建列表: {e}");
                            Vec::new()
                        }),
                    None => Vec::new(),
                };
                if keys.is_empty() {
                    keys.push(ProviderKey::new(new_key));
                } else {
                    keys[0] = ProviderKey::new(new_key);
                }
                Some(encode_keys(&keys)?)
            }
            None => None,
        };

        // 元数据与 Key 列表同事务写入：避免「编辑资料 + 换主 Key」中途失败留下两列不一致。
        // 事务必须放在独立作用域里：ConnGuard 未释放时再调用 get_provider 会自锁。
        let saved_id = {
            let mut c = conn()?;
            // IMMEDIATE：读后升级写不会触发 SQLITE_BUSY_SNAPSHOT
            let tx = c.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
            if draft.api_key.is_some() {
                if let Some(existing) = id {
                    let current = tx
                        .query_row(
                            "SELECT api_keys_enc, api_key_enc FROM providers WHERE id = ?1",
                            params![existing],
                            |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
                        )
                        .optional()?;
                    if current != observed {
                        drop(tx);
                        if attempt < MAX_CAS_ATTEMPTS {
                            tracing::debug!(
                                "服务商 #{existing} 保存期间 Key 被修改，重试第 {attempt} 次"
                            );
                            continue;
                        }
                        return Err(AppError::Other(
                            "服务商 Key 在保存期间被其它操作修改，请重试".into(),
                        ));
                    }
                }
            }
            let id = match id {
                Some(existing) => {
                    let n = tx.execute(
                        "UPDATE providers SET name=?1, base_url=?2, kind=?3, models_json=?4,
                     default_model=?5, timeout_secs=?6, template_url=?7, template_body=?8,
                     template_response_path=?9, edit_template_json=?10,
                     transform_template_json=?11 WHERE id=?12",
                        params![
                            draft.name,
                            draft.base_url,
                            draft.kind,
                            draft.models_json,
                            draft.default_model,
                            timeout_secs as i64,
                            draft.template_url,
                            draft.template_body,
                            draft.template_response_path,
                            draft.edit_template_json,
                            draft.transform_template_json,
                            existing
                        ],
                    )?;
                    if n == 0 {
                        return Err(AppError::NotFound(format!("服务商 #{existing} 不存在")));
                    }
                    existing
                }
                None => {
                    // Key 统一由下面的 replace_first 逻辑写两列，这里先落空密文
                    tx.execute(
                        "INSERT INTO providers (name, base_url, api_key_enc, kind, models_json,
                     default_model, timeout_secs, template_url, template_body, template_response_path,
                     edit_template_json, transform_template_json)
                     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)",
                        params![
                            draft.name,
                            draft.base_url,
                            empty_enc,
                            draft.kind,
                            draft.models_json,
                            draft.default_model,
                            timeout_secs as i64,
                            draft.template_url,
                            draft.template_body,
                            draft.template_response_path,
                            draft.edit_template_json,
                            draft.transform_template_json
                        ],
                    )?;
                    tx.last_insert_rowid()
                }
            };
            // 未填新 Key 时保持整组 Key 与密文原样，避免解密失败的旧数据在纯改资料时被清空
            if let Some((keys_enc, first_enc)) = &rebuilt_keys {
                let n = tx.execute(
                    "UPDATE providers SET api_keys_enc = ?1, api_key_enc = ?2 WHERE id = ?3",
                    params![keys_enc, first_enc, id],
                )?;
                if n == 0 {
                    return Err(AppError::NotFound(format!("服务商 #{id} 不存在")));
                }
            }
            tx.commit()?;
            id
        };
        return get_provider(saved_id)?
            .ok_or_else(|| AppError::NotFound("provider not found after save".into()));
    }
    unreachable!("CAS 循环至少返回一次")
}

pub fn get_provider(id: i64) -> AppResult<Option<ProviderRow>> {
    let c = conn()?;
    let mut stmt = c.prepare(
        "SELECT id, name, base_url, api_key_enc, kind, models_json, default_model,
         timeout_secs, template_url, template_body, template_response_path,
         edit_template_json, transform_template_json
         FROM providers WHERE id = ?1",
    )?;
    let mut rows = stmt.query_map(params![id], row_to_provider)?;
    Ok(rows.next().transpose()?)
}

pub fn list_providers() -> AppResult<Vec<ProviderRow>> {
    let c = conn()?;
    let mut stmt = c.prepare(
        "SELECT id, name, base_url, api_key_enc, kind, models_json, default_model,
         timeout_secs, template_url, template_body, template_response_path,
         edit_template_json, transform_template_json
         FROM providers ORDER BY id",
    )?;
    let rows = stmt.query_map([], row_to_provider)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(AppError::from)
}

pub fn delete_provider(id: i64) -> AppResult<()> {
    let mut c = conn()?;
    let tx = c.transaction()?;
    tx.execute("DELETE FROM model_caps WHERE provider_id = ?1", params![id])?;
    tx.execute("DELETE FROM providers WHERE id = ?1", params![id])?;
    tx.commit()?;
    Ok(())
}

/// 写入模型能力覆盖值（JSON）；同 (provider, model) 覆盖旧值。
pub fn save_model_caps(provider_id: i64, model: &str, caps_json: &str) -> AppResult<()> {
    let guard = conn()?;
    save_model_caps_in(&guard, provider_id, model, caps_json)
}

fn save_model_caps_in(
    c: &Connection,
    provider_id: i64,
    model: &str,
    caps_json: &str,
) -> AppResult<()> {
    c.execute(
        "INSERT INTO model_caps (provider_id, model, caps_json, updated_at)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(provider_id, model)
         DO UPDATE SET caps_json = excluded.caps_json, updated_at = excluded.updated_at",
        params![provider_id, model, caps_json, timestamp_millis()],
    )?;
    Ok(())
}

/// 批量写入模型能力：单事务提交，避免弹窗保存时出现「存了一半」的半成功状态。
pub fn save_model_caps_batch(provider_id: i64, entries: &[(String, String)]) -> AppResult<()> {
    let mut guard = conn()?;
    save_model_caps_batch_in(&mut guard, provider_id, entries)
}

fn save_model_caps_batch_in(
    c: &mut Connection,
    provider_id: i64,
    entries: &[(String, String)],
) -> AppResult<()> {
    let tx = c.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    for (model, caps_json) in entries {
        save_model_caps_in(&tx, provider_id, model, caps_json)?;
    }
    tx.commit()?;
    Ok(())
}

/// 读取某服务商全部模型的能力覆盖值（model, caps_json）。
pub fn list_model_caps(provider_id: i64) -> AppResult<Vec<(String, String)>> {
    let guard = conn()?;
    list_model_caps_in(&guard, provider_id)
}

fn list_model_caps_in(c: &Connection, provider_id: i64) -> AppResult<Vec<(String, String)>> {
    let mut stmt =
        c.prepare("SELECT model, caps_json FROM model_caps WHERE provider_id = ?1 ORDER BY model")?;
    let rows = stmt.query_map(params![provider_id], |r| Ok((r.get(0)?, r.get(1)?)))?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

/// 优先读 Key 列表密文；为空时回退旧单 Key 列（迁移回填完成前/旧备份导入后）。
pub(crate) fn decode_keys(keys_enc: &str, legacy_enc: &str) -> AppResult<Vec<ProviderKey>> {
    if !keys_enc.trim().is_empty() {
        let plain = decrypt_secret(keys_enc)?;
        let mut keys: Vec<ProviderKey> = serde_json::from_str(&plain)
            .map_err(|e| AppError::Crypto(format!("Key 列表解析失败: {e}")))?;
        keys.retain(|k| !k.key.trim().is_empty());
        return Ok(keys);
    }
    if legacy_enc.trim().is_empty() {
        return Ok(Vec::new());
    }
    let key = decrypt_secret(legacy_enc)?;
    Ok(if key.trim().is_empty() {
        Vec::new()
    } else {
        vec![ProviderKey::new(key)]
    })
}

/// 返回 (Key 列表密文, 首 Key 密文)；空列表两列都写空串。
pub(crate) fn encode_keys(keys: &[ProviderKey]) -> AppResult<(String, String)> {
    if keys.is_empty() {
        return Ok((String::new(), String::new()));
    }
    let json = serde_json::to_string(keys).map_err(|e| AppError::Other(e.to_string()))?;
    Ok((encrypt_secret(&json)?, encrypt_secret(&keys[0].key)?))
}

fn write_keys_tx(tx: &rusqlite::Transaction<'_>, id: i64, keys: &[ProviderKey]) -> AppResult<()> {
    let (keys_enc, first_enc) = encode_keys(keys)?;
    let n = tx.execute(
        "UPDATE providers SET api_keys_enc = ?1, api_key_enc = ?2 WHERE id = ?3",
        params![keys_enc, first_enc, id],
    )?;
    if n == 0 {
        return Err(AppError::NotFound(format!("服务商 #{id} 不存在")));
    }
    Ok(())
}

pub fn load_provider_keys(id: i64) -> AppResult<Vec<ProviderKey>> {
    let c = conn()?;
    let (keys_enc, legacy_enc): (String, String) = c
        .query_row(
            "SELECT api_keys_enc, api_key_enc FROM providers WHERE id = ?1",
            params![id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?
        .ok_or_else(|| AppError::NotFound(format!("服务商 #{id} 不存在")))?;
    decode_keys(&keys_enc, &legacy_enc)
}

/// 读 → 改 → 写在同一事务内，避免并发生成标记失效与 UI 增删 Key 互相覆盖。
fn mutate_keys<F>(id: i64, f: F) -> AppResult<Vec<ProviderKey>>
where
    F: FnOnce(&mut Vec<ProviderKey>) -> AppResult<()>,
{
    let mut c = conn()?;
    let tx = c.transaction()?;
    let (keys_enc, legacy_enc): (String, String) = tx
        .query_row(
            "SELECT api_keys_enc, api_key_enc FROM providers WHERE id = ?1",
            params![id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?
        .ok_or_else(|| AppError::NotFound(format!("服务商 #{id} 不存在")))?;
    let mut keys = decode_keys(&keys_enc, &legacy_enc)?;
    f(&mut keys)?;
    write_keys_tx(&tx, id, &keys)?;
    tx.commit()?;
    Ok(keys)
}

pub fn add_provider_key(id: i64, key: &str) -> AppResult<()> {
    let key = key.trim();
    if key.is_empty() {
        return Err(AppError::Other("Key 不能为空".into()));
    }
    mutate_keys(id, |keys| {
        if keys.iter().any(|k| k.key == key) {
            return Err(AppError::Other("该 Key 已存在".into()));
        }
        keys.push(ProviderKey::new(key));
        Ok(())
    })
    .map(|_| ())
}

pub fn delete_provider_key(id: i64, index: usize) -> AppResult<()> {
    mutate_keys(id, |keys| {
        if index >= keys.len() {
            return Err(AppError::NotFound("Key 序号不存在".into()));
        }
        keys.remove(index);
        Ok(())
    })
    .map(|_| ())
}

/// 标记/恢复单个 Key 的失效状态；序号越界时静默忽略（轮换与删除存在竞态）。
pub fn mark_key_invalid(id: i64, index: usize, invalid: bool) -> AppResult<()> {
    mutate_keys(id, |keys| {
        if let Some(key) = keys.get_mut(index) {
            key.invalid = invalid;
            key.invalid_at = if invalid {
                Some(timestamp_millis())
            } else {
                None
            };
        }
        Ok(())
    })
    .map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::test_support::*;

    #[test]
    fn provider_timeout_clamped_to_5_1800() {
        assert_eq!(clamp_provider_timeout(0), 5);
        assert_eq!(clamp_provider_timeout(4), 5);
        // 60 仍是合法取值：迁移只抬旧默认，用户显式保留的短超时不强行改
        assert_eq!(clamp_provider_timeout(60), 60);
        assert_eq!(clamp_provider_timeout(600), 600);
        assert_eq!(clamp_provider_timeout(1800), 1800);
        assert_eq!(clamp_provider_timeout(100_000), 1800);
    }

    /// C2：迁移 003 之后把存量单 Key 幂等回填成 Key 列表
    #[test]
    fn backfill_moves_legacy_key_into_list() {
        let _guard = ENV_LOCK.lock().unwrap();
        std::env::set_var(MASTER_KEY_ENV, "cc".repeat(32));
        let c = mem_conn();
        let enc = encrypt_secret("sk-legacy").expect("encrypt");
        c.execute(
            "INSERT INTO providers (name, base_url, api_key_enc) VALUES ('旧', '', ?1)",
            params![enc],
        )
        .unwrap();
        let id = c.last_insert_rowid();

        backfill_provider_keys(&c);
        let read = |c: &Connection| -> Vec<ProviderKey> {
            let (keys_enc, legacy): (String, String) = c
                .query_row(
                    "SELECT api_keys_enc, api_key_enc FROM providers WHERE id = ?1",
                    params![id],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .unwrap();
            decode_keys(&keys_enc, &legacy).expect("decode keys")
        };
        let keys = read(&c);
        assert_eq!(keys.len(), 1);
        assert_eq!(keys[0].key, "sk-legacy");
        assert!(!keys[0].invalid);

        // 幂等：再跑一次不会重复追加
        backfill_provider_keys(&c);
        assert_eq!(read(&c).len(), 1);
        std::env::remove_var(MASTER_KEY_ENV);
    }

    /// C2：写 Key 列表时 `api_key_enc` 必须镜像首 Key（旧代码/思考模型复用路径依赖它）
    #[test]
    fn key_list_write_mirrors_first_key() {
        let _guard = ENV_LOCK.lock().unwrap();
        std::env::set_var(MASTER_KEY_ENV, "dd".repeat(32));
        let mut c = mem_conn();
        let enc = encrypt_secret("").unwrap();
        c.execute(
            "INSERT INTO providers (name, base_url, api_key_enc) VALUES ('P', '', ?1)",
            params![enc],
        )
        .unwrap();
        let id = c.last_insert_rowid();
        {
            let tx = c.transaction().unwrap();
            write_keys_tx(&tx, id, &[ProviderKey::new("k1"), ProviderKey::new("k2")]).unwrap();
            tx.commit().unwrap();
        }
        let (keys_enc, first): (String, String) = c
            .query_row(
                "SELECT api_keys_enc, api_key_enc FROM providers WHERE id = ?1",
                params![id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(decrypt_secret(&first).unwrap(), "k1");
        // 密文是 base64（随机 nonce + 密文），短子串可能偶然出现，只能断言不是明文 JSON
        assert!(!keys_enc.starts_with('['), "Key 列表必须整体加密");
        let decoded = decode_keys(&keys_enc, &first).unwrap();
        assert_eq!(
            decoded.iter().map(|k| k.key.as_str()).collect::<Vec<_>>(),
            vec!["k1", "k2"]
        );
        std::env::remove_var(MASTER_KEY_ENV);
    }

    /// M3：模型能力覆盖值按 (provider, model) 往返，重复写入走更新
    #[test]
    fn model_caps_roundtrip_upsert() {
        let c = mem_conn();
        save_model_caps_in(&c, 7, "flux-pro", r#"{"negative":false}"#).unwrap();
        save_model_caps_in(&c, 7, "flux-pro", r#"{"negative":true,"edit":false}"#).unwrap();
        save_model_caps_in(&c, 7, "dall-e-3", r#"{"negative":false}"#).unwrap();
        save_model_caps_in(&c, 8, "flux-pro", r#"{"transform":false}"#).unwrap();
        assert_eq!(
            list_model_caps_in(&c, 7).unwrap(),
            vec![
                ("dall-e-3".to_string(), r#"{"negative":false}"#.to_string()),
                (
                    "flux-pro".to_string(),
                    r#"{"negative":true,"edit":false}"#.to_string()
                ),
            ]
        );
        // 不同服务商互不影响
        assert_eq!(list_model_caps_in(&c, 8).unwrap().len(), 1);
    }

    /// E11：批量能力保存一次写入全部模型，替代逐条调用
    #[test]
    fn model_caps_batch_writes_all_entries() {
        let mut c = mem_conn();
        let entries = vec![
            ("flux-pro".to_string(), r#"{"negative":false}"#.to_string()),
            ("dall-e-3".to_string(), r#"{"edit":false}"#.to_string()),
        ];
        save_model_caps_batch_in(&mut c, 9, &entries).unwrap();
        let stored = list_model_caps_in(&c, 9).unwrap();
        assert_eq!(stored.len(), 2);
        assert!(stored.iter().any(|(m, _)| m == "flux-pro"));
        assert!(stored.iter().any(|(m, _)| m == "dall-e-3"));
        // 覆盖写仍走 upsert，不产生重复行
        let again = vec![("flux-pro".to_string(), r#"{"edit":true}"#.to_string())];
        save_model_caps_batch_in(&mut c, 9, &again).unwrap();
        assert_eq!(list_model_caps_in(&c, 9).unwrap().len(), 2);
    }
}
