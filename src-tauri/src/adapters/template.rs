use super::{
    classify_http, classify_reqwest, http_client, AdapterError, EditRequest, GenerateRequest,
    ImageAdapter, ProviderConfig,
};
use base64::Engine;

pub struct TemplateAdapter;

pub(crate) fn render_template(tpl: &str, vars: &[(&str, &str)]) -> String {
    let mut out = tpl.to_string();
    for (k, v) in vars {
        out = out.replace(&format!("{{{{{}}}}}", k), v);
    }
    out
}

fn vars_as_strs<'a>(pairs: &'a [(&'static str, String)]) -> Vec<(&'a str, &'a str)> {
    pairs.iter().map(|(k, v)| (*k, v.as_str())).collect()
}

impl TemplateAdapter {
    fn vars<'a>(
        config: &'a ProviderConfig,
        req: &'a GenerateRequest,
    ) -> Vec<(&'static str, String)> {
        vec![
            ("prompt", req.prompt.clone()),
            (
                "negative_prompt",
                req.negative_prompt.clone().unwrap_or_default(),
            ),
            ("size", format!("{}x{}", req.width, req.height)),
            ("width", req.width.to_string()),
            ("height", req.height.to_string()),
            ("model", req.model.clone()),
            ("seed", req.seed.map(|s| s.to_string()).unwrap_or_default()),
            ("count", req.count.to_string()),
            ("key", config.api_key.clone()),
            // 参考图：{{image}} 取第一张，{{images}} 为 JSON 数组，便于模板按需渲染
            ("image", req.images.first().cloned().unwrap_or_default()),
            (
                "images",
                serde_json::to_string(&req.images).unwrap_or_else(|_| "[]".to_string()),
            ),
            ("image_count", req.images.len().to_string()),
        ]
    }
}

impl ImageAdapter for TemplateAdapter {
    fn list_models<'a>(
        &'a self,
        config: &'a ProviderConfig,
    ) -> super::BoxFuture<'a, Result<Vec<String>, AdapterError>> {
        Box::pin(async move {
            if config.models_json.is_empty() {
                return Ok(vec![]);
            }
            serde_json::from_str(&config.models_json).map_err(|_| AdapterError::Other {
                message: "手动填写的模型列表不是合法 JSON 数组".into(),
            })
        })
    }

    fn generate<'a>(
        &'a self,
        config: &'a ProviderConfig,
        req: &'a GenerateRequest,
    ) -> super::BoxFuture<'a, Result<Vec<String>, AdapterError>> {
        Box::pin(async move {
            let pairs = Self::vars(config, req);
            let pairs = vars_as_strs(&pairs);
            let url = render_template(&config.template_url, &pairs);
            let body = render_template(&config.template_body, &pairs);
            let mut request = http_client()
                .post(&url)
                .timeout(std::time::Duration::from_secs(config.timeout_secs));
            if !config.api_key.is_empty() {
                request = request.bearer_auth(&config.api_key);
            }
            let resp = request
                .header("Content-Type", "application/json")
                .body(body)
                .send()
                .await
                .map_err(|e| classify_reqwest(&e))?;
            if !resp.status().is_success() {
                let status = resp.status();
                let text = resp.text().await.unwrap_or_default();
                return Err(classify_http(status, &text));
            }
            let text = resp.text().await.map_err(|e| classify_reqwest(&e))?;
            let json: serde_json::Value =
                serde_json::from_str(&text).map_err(|_| AdapterError::Other {
                    message: "响应不是合法 JSON".into(),
                })?;
            // 从响应中提取图片：优先按 response_path 提取，其次寻找常见字段
            let path = if config.template_response_path.is_empty() {
                "data[0].b64_json".to_string()
            } else {
                config.template_response_path.clone()
            };
            let values = resolve_path_values(&json, &path)?;
            let mut out = Vec::with_capacity(values.len());
            for s in values {
                let b64 = if s.starts_with("http://") || s.starts_with("https://") {
                    let bytes = http_client()
                        .get(&s)
                        .timeout(std::time::Duration::from_secs(config.timeout_secs))
                        .send()
                        .await
                        .map_err(|e| classify_reqwest(&e))?
                        .bytes()
                        .await
                        .map_err(|e| classify_reqwest(&e))?;
                    base64::engine::general_purpose::STANDARD.encode(&bytes)
                } else {
                    s
                };
                out.push(b64);
            }
            Ok(out)
        })
    }

    fn edit<'a>(
        &'a self,
        _config: &'a ProviderConfig,
        _req: &'a EditRequest,
    ) -> super::BoxFuture<'a, Result<String, AdapterError>> {
        Box::pin(async move {
            Err(AdapterError::Other {
                message: "自定义模板接口暂不支持图像编辑".into(),
            })
        })
    }
}

enum PathSeg {
    Key(String),
    Index(usize),
}

/// 单次模板响应最多接受的图片数量，防止异常响应把内存打满
const MAX_RESPONSE_IMAGES: usize = 16;

/// 按路径解析到 JSON 值（RA-07：路径 token 解析，不再把 `data[0]` 当键名）
fn resolve_path_value<'a>(
    json: &'a serde_json::Value,
    path: &str,
) -> Result<&'a serde_json::Value, AdapterError> {
    let mut current = json;
    for seg in regex_free_path(path) {
        match seg {
            PathSeg::Key(k) => {
                current = current.get(&k).ok_or_else(|| AdapterError::Other {
                    message: format!("响应中找不到字段 {}", k),
                })?
            }
            PathSeg::Index(i) => {
                current = current.get(i).ok_or_else(|| AdapterError::Other {
                    message: format!("响应中找不到第 {} 项", i),
                })?
            }
        }
    }
    Ok(current)
}

/// 按路径取出单个字符串（仅单测使用，生产路径走 `resolve_path_values`）
#[cfg(test)]
fn resolve_path_str<'a>(json: &'a serde_json::Value, path: &str) -> Result<&'a str, AdapterError> {
    match resolve_path_value(json, path)? {
        serde_json::Value::String(s) => Ok(s),
        _ => Err(AdapterError::Other {
            message: "提取到的图片字段不是字符串".into(),
        }),
    }
}

/// 从路径命中的值中提取图片字符串：
/// - 字符串：base64 或 URL；
/// - 数组：逐项提取（字符串，或含 b64_json / url / image 字段的对象）；
/// - 对象：取 b64_json / url / image 字段。
fn resolve_path_values(json: &serde_json::Value, path: &str) -> Result<Vec<String>, AdapterError> {
    let value = resolve_path_value(json, path)?;
    let mut out = Vec::new();
    match value {
        serde_json::Value::String(s) => out.push(s.clone()),
        serde_json::Value::Array(items) => {
            out.extend(items.iter().filter_map(image_string).map(str::to_string));
        }
        other => {
            if let Some(s) = image_string(other) {
                out.push(s.to_string());
            }
        }
    }
    if out.is_empty() {
        return Err(AdapterError::Other {
            message: format!("响应路径 {} 未找到图片", path),
        });
    }
    out.truncate(MAX_RESPONSE_IMAGES);
    Ok(out)
}

fn image_string(value: &serde_json::Value) -> Option<&str> {
    match value {
        serde_json::Value::String(s) => Some(s),
        serde_json::Value::Object(obj) => ["b64_json", "url", "image"]
            .iter()
            .find_map(|key| obj.get(*key).and_then(|v| v.as_str())),
        _ => None,
    }
}

/// 把响应路径解析为 token 序列，支持三类写法：
/// - 纯键路径：`choices.message.content`（保持旧行为）
/// - 段内下标：`data[0].b64_json`（OpenAI 默认路径）、`choices[0].message.content`
/// - 数字段：`images.0.url`（点号后直接跟数组下标）
fn regex_free_path(path: &str) -> Vec<PathSeg> {
    let mut out = Vec::new();
    for part in path.split('.') {
        let part = part.trim();
        if part.is_empty() {
            continue;
        }
        out.extend(parse_segment(part));
    }
    out
}

/// 解析单个路径段：`name`、`[idx]`、`name[idx]`、`name[idx][idx2]`；
/// 含非法下标时整段退化为键名（保持「纯键路径」的旧行为，避免误吞合法键）。
fn parse_segment(part: &str) -> Vec<PathSeg> {
    // 纯数字段视为数组下标（如 `images.0.url` 中的 `0`）
    if !part.is_empty() && part.chars().all(|c| c.is_ascii_digit()) {
        return match part.parse::<usize>() {
            Ok(idx) => vec![PathSeg::Index(idx)],
            Err(_) => vec![PathSeg::Key(part.to_string())],
        };
    }
    let key_end = part.find('[').unwrap_or(part.len());
    let mut segs = Vec::new();
    if key_end > 0 {
        segs.push(PathSeg::Key(part[..key_end].to_string()));
    }
    let mut rest = &part[key_end..];
    while let Some(after_open) = rest.strip_prefix('[') {
        let Some(close) = after_open.find(']') else {
            // 缺右括号：整段当键名
            return vec![PathSeg::Key(part.to_string())];
        };
        let Ok(idx) = after_open[..close].parse::<usize>() else {
            // 下标不是数字：整段当键名
            return vec![PathSeg::Key(part.to_string())];
        };
        segs.push(PathSeg::Index(idx));
        rest = &after_open[close + 1..];
    }
    if !rest.is_empty() {
        // 下标后还有残余字符（如 `a[0]x`）：无法解析，整段当键名
        return vec![PathSeg::Key(part.to_string())];
    }
    if segs.is_empty() {
        segs.push(PathSeg::Key(part.to_string()));
    }
    segs
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_response() -> serde_json::Value {
        serde_json::json!({
            "data": [{"b64_json": "QUJD", "url": "https://example.com/a.png"}],
            "images": [{"url": "https://example.com/b.png"}],
            "choices": [{"message": {"content": "hello"}}],
            "plain": {"nested": "value"}
        })
    }

    /// 默认路径 data[0].b64_json 必须命中（旧实现把 "data[0]" 当键名，永不命中）
    #[test]
    fn response_path_bracket_index_hits_openai_default() {
        let v = sample_response();
        assert_eq!(resolve_path_str(&v, "data[0].b64_json").unwrap(), "QUJD");
    }

    /// 点号数字段 images.0.url 按数组下标解析
    #[test]
    fn response_path_dotted_index() {
        let v = sample_response();
        assert_eq!(
            resolve_path_str(&v, "images.0.url").unwrap(),
            "https://example.com/b.png"
        );
    }

    /// 嵌套括号 + 多层键 choices[0].message.content
    #[test]
    fn response_path_nested_choice_content() {
        let v = sample_response();
        assert_eq!(
            resolve_path_str(&v, "choices[0].message.content").unwrap(),
            "hello"
        );
    }

    /// 纯键路径保持原行为
    #[test]
    fn response_path_plain_keys_unchanged() {
        let v = sample_response();
        assert_eq!(resolve_path_str(&v, "plain.nested").unwrap(), "value");
    }

    /// 下标越界 / 字段缺失仍返回可读错误
    #[test]
    fn response_path_missing_reports_error() {
        let v = sample_response();
        let err = resolve_path_str(&v, "data[5].b64_json").unwrap_err();
        assert!(err.message().contains("找不到"));
        let err = resolve_path_str(&v, "plain.absent").unwrap_err();
        assert!(err.message().contains("absent"));
    }

    /// 模板响应可能是对象数组：路径指向数组时逐项提取 b64_json / url / image
    #[test]
    fn response_path_values_extracts_object_array() {
        let v = sample_response();
        assert_eq!(
            resolve_path_values(&v, "data").unwrap(),
            vec!["QUJD".to_string()]
        );
        let v = serde_json::json!({
            "data": [
                {"b64_json": "A"},
                {"url": "https://example.com/b.png"},
                {"image": "C"},
                {"other": "ignored"}
            ]
        });
        assert_eq!(
            resolve_path_values(&v, "data").unwrap(),
            vec!["A", "https://example.com/b.png", "C"]
        );
    }

    /// 字符串数组同样支持，且顺序保持
    #[test]
    fn response_path_values_extracts_string_array() {
        let v = serde_json::json!({ "urls": ["A", "B", "C"] });
        assert_eq!(
            resolve_path_values(&v, "urls").unwrap(),
            vec!["A", "B", "C"]
        );
    }

    /// 空数组 / 全是无法识别的对象时给出可读错误，不返回空列表
    #[test]
    fn response_path_values_empty_is_error() {
        let v = serde_json::json!({ "data": [] });
        let err = resolve_path_values(&v, "data").unwrap_err();
        assert!(err.message().contains("未找到图片"), "{}", err.message());
    }

    /// 异常超长数组必须截断到上限，避免一次性占满内存
    #[test]
    fn response_path_values_caps_count() {
        let items: Vec<serde_json::Value> = (0..20)
            .map(|i| serde_json::json!({ "b64_json": i.to_string() }))
            .collect();
        let v = serde_json::json!({ "data": items });
        assert_eq!(
            resolve_path_values(&v, "data").unwrap().len(),
            MAX_RESPONSE_IMAGES
        );
    }

    /// 模板变量必须注入参考图：{{image}} 第一张、{{images}} JSON 数组、{{image_count}} 数量
    #[test]
    fn template_vars_include_reference_images() {
        let config = ProviderConfig {
            id: None,
            name: "template".into(),
            base_url: String::new(),
            api_key: "secret".into(),
            kind: "template".into(),
            models_json: "[]".into(),
            default_model: "m".into(),
            timeout_secs: 60,
            template_url: String::new(),
            template_body: String::new(),
            template_response_path: String::new(),
            extra_params: String::new(),
        };
        let req = GenerateRequest {
            prompt: "p".into(),
            negative_prompt: None,
            model: "m".into(),
            width: 1024,
            height: 1024,
            guidance: None,
            steps: None,
            seed: None,
            count: 2,
            images: vec!["AAA".into(), "BBB".into()],
        };
        let pairs = TemplateAdapter::vars(&config, &req);
        let pairs = vars_as_strs(&pairs);
        assert_eq!(render_template("{{image}}", &pairs), "AAA");
        assert_eq!(render_template("{{images}}", &pairs), r#"["AAA","BBB"]"#);
        assert_eq!(render_template("{{image_count}}", &pairs), "2");

        let empty = GenerateRequest {
            images: vec![],
            ..req
        };
        let pairs = TemplateAdapter::vars(&config, &empty);
        let pairs = vars_as_strs(&pairs);
        assert_eq!(render_template("x{{image}}y", &pairs), "xy");
        assert_eq!(render_template("{{image_count}}", &pairs), "0");
    }
}
