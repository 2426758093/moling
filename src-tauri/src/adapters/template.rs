use super::{
    classify_http, classify_reqwest, download_image_bytes, http_client, AdapterError, EditRequest,
    GenerateRequest, ImageAdapter, ProviderConfig, TransformRequest,
};
use base64::Engine;

pub struct TemplateAdapter;

/// 编辑 / 变换模板配置（`providers.edit_template_json` 等的反序列化目标）。
/// 三项都为空视为未配置——与空串列语义一致。
#[derive(Debug, Clone, Default, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TemplateSpec {
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub body: String,
    #[serde(default)]
    pub response_path: String,
}

impl TemplateSpec {
    pub fn is_configured(&self) -> bool {
        !self.url.trim().is_empty() || !self.body.trim().is_empty()
    }

    /// 空串 → None（未配置）；损坏 JSON 也按未配置处理并留日志，
    /// 写入路径由本应用控制，坏数据只可能是历史脏数据。
    pub fn from_json(raw: &str) -> Option<Self> {
        let raw = raw.trim();
        if raw.is_empty() {
            return None;
        }
        match serde_json::from_str::<Self>(raw) {
            Ok(spec) if spec.is_configured() => Some(spec),
            Ok(_) => None,
            Err(e) => {
                tracing::warn!("模板配置解析失败，按未配置处理: {e}");
                None
            }
        }
    }
}

/// 模板变量类型：`Text` 按目标上下文转义，`Json` 是已编码的 JSON 片段（数组等），原样注入。
#[derive(Debug, Clone, Copy)]
pub(crate) enum Var<'a> {
    Text(&'a str),
    Json(&'a str),
}

impl<'a> Var<'a> {
    fn as_str(self) -> &'a str {
        match self {
            Var::Text(value) | Var::Json(value) => value,
        }
    }
}

/// 渲染模式：决定变量值如何转义
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RenderMode {
    /// 原样替换（仅测试 / 兼容旧 API 使用）
    #[cfg(test)]
    Raw,
    /// JSON 字符串字面量内容：Text 做 JSON 转义，Json 片段原样
    Body,
    /// URL 组件：所有变量值做百分号编码
    Url,
}

/// 单遍替换 `{{name}}`：只扫描模板本身，插入的值绝不再参与替换。
/// 这修掉了旧实现「逐变量 replace」的两个问题：
/// 1. prompt 里出现 `{{key}}` 会被后续轮次替换成 API Key（模板注入）；
/// 2. 变量顺序决定结果，换个顺序输出就变。
fn render_with(tpl: &str, vars: &[(&str, Var<'_>)], mode: RenderMode) -> String {
    let mut out = String::with_capacity(tpl.len());
    let mut rest = tpl;
    while let Some(open) = rest.find("{{") {
        out.push_str(&rest[..open]);
        let after_open = &rest[open + 2..];
        let Some(close) = after_open.find("}}") else {
            out.push_str(&rest[open..]);
            return out;
        };
        let name = &after_open[..close];
        let end = open + 2 + close + 2;
        match vars.iter().find(|(key, _)| *key == name) {
            Some((_, value)) => out.push_str(&escape_value(*value, mode)),
            // 未知占位符原样保留，便于模板作者发现拼写错误
            None => out.push_str(&rest[open..end]),
        }
        rest = &rest[end..];
    }
    out.push_str(rest);
    out
}

fn escape_value(value: Var<'_>, mode: RenderMode) -> String {
    match mode {
        #[cfg(test)]
        RenderMode::Raw => value.as_str().to_string(),
        RenderMode::Body => match value {
            Var::Text(text) => json_escape_text(text),
            Var::Json(json) => json.to_string(),
        },
        RenderMode::Url => percent_encode(value.as_str()),
    }
}

/// JSON 字符串字面量内容转义（去掉 serde 生成的首尾引号）
fn json_escape_text(value: &str) -> String {
    match serde_json::to_string(value) {
        Ok(quoted) if quoted.len() >= 2 => quoted[1..quoted.len() - 1].to_string(),
        _ => value.to_string(),
    }
}

/// RFC 3986 non-unreserved 百分号编码（不引入新依赖）
fn percent_encode(value: &str) -> String {
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    let mut out = String::with_capacity(value.len());
    for &byte in value.as_bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~') {
            out.push(byte as char);
        } else {
            out.push('%');
            out.push(HEX[(byte >> 4) as usize] as char);
            out.push(HEX[(byte & 0x0f) as usize] as char);
        }
    }
    out
}

/// 模板请求体渲染：Text 变量按 JSON 字符串内容转义，`{{images}}`/`{{ref_roles}}` 原样作为 JSON 片段
pub(crate) fn render_body(tpl: &str, vars: &[(&str, Var<'_>)]) -> String {
    render_with(tpl, vars, RenderMode::Body)
}

/// 模板 URL 渲染：变量值做百分号编码，模板自身的 `?`/`&`/`=` 不受影响
pub(crate) fn render_url(tpl: &str, vars: &[(&str, Var<'_>)]) -> String {
    render_with(tpl, vars, RenderMode::Url)
}

/// 生成请求变量表 → 渲染变量；JSON 片段必须原样注入
fn render_vars<'a>(pairs: &'a [(&'static str, String)]) -> Vec<(&'static str, Var<'a>)> {
    pairs
        .iter()
        .map(|(name, value)| {
            let var = if matches!(*name, "images" | "ref_roles") {
                Var::Json(value.as_str())
            } else {
                Var::Text(value.as_str())
            };
            (*name, var)
        })
        .collect()
}

/// 旧的变量表形态（仅测试使用，保留既有用例与 adapters/tests.rs 的调用）
#[cfg(test)]
fn vars_as_strs<'a>(pairs: &'a [(&'static str, String)]) -> Vec<(&'a str, &'a str)> {
    pairs.iter().map(|(k, v)| (*k, v.as_str())).collect()
}

/// 旧的单遍原始替换（仅测试使用；生产渲染走 `render_body`/`render_url`）
#[cfg(test)]
pub(crate) fn render_template(tpl: &str, vars: &[(&str, &str)]) -> String {
    let vars: Vec<(&str, Var<'_>)> = vars.iter().map(|(k, v)| (*k, Var::Text(v))).collect();
    render_with(tpl, &vars, RenderMode::Raw)
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
            // 角色 / 强度：提示词级近似，模板可按需自行降权或忽略
            ("ref_roles", crate::reference::roles_json(&req.references)),
        ]
    }

    /// 编辑模板变量：{{image}} 是原图，{{mask}} 是蒙版（无蒙版为空串），
    /// {{mask_count}} 供模板判断走不走局部重绘分支
    fn edit_vars<'a>(
        config: &'a ProviderConfig,
        req: &'a EditRequest,
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
            ("key", config.api_key.clone()),
            ("image", req.image_b64.clone()),
            ("mask", req.mask_b64.clone().unwrap_or_default()),
            (
                "mask_count",
                if req.mask_b64.is_some() { "1" } else { "0" }.to_string(),
            ),
        ]
    }

    /// 变换模板变量：{{scale}} 为放大倍数，{{mode}} 为 detail / faithful
    fn transform_vars<'a>(
        config: &'a ProviderConfig,
        req: &'a TransformRequest,
    ) -> Vec<(&'static str, String)> {
        vec![
            ("prompt", req.prompt.clone()),
            ("model", req.model.clone()),
            ("key", config.api_key.clone()),
            ("image", req.image_b64.clone()),
            ("scale", req.scale.to_string()),
            ("mode", req.mode.clone()),
        ]
    }

    /// 未配置模板时给可操作的错误（明确「未配置」而不是笼统「不支持」）
    fn require_spec<'a>(
        spec: &'a Option<TemplateSpec>,
        label: &str,
    ) -> Result<&'a TemplateSpec, AdapterError> {
        spec.as_ref()
            .filter(|s| s.is_configured())
            .ok_or_else(|| AdapterError::Other {
                message: format!("该服务商未配置{label}模板，请在 设置 → 服务商 → 高级设置 中填写"),
            })
    }

    /// 发送模板请求并按响应路径提取图片（URL 结果会先下载成 base64）。
    /// generate / edit / transform 共用，避免三份重复的错误分类与解析逻辑。
    async fn request_and_extract(
        config: &ProviderConfig,
        url: &str,
        body: &str,
        response_path: &str,
    ) -> Result<Vec<String>, AdapterError> {
        let mut request = http_client()
            .post(url)
            .timeout(std::time::Duration::from_secs(config.timeout_secs));
        if !config.api_key.is_empty() {
            request = request.bearer_auth(&config.api_key);
        }
        let resp = request
            .header("Content-Type", "application/json")
            .body(body.to_string())
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
        let path = if response_path.is_empty() {
            "data[0].b64_json".to_string()
        } else {
            response_path.to_string()
        };
        let values = resolve_path_values(&json, &path)?;
        let mut out = Vec::with_capacity(values.len());
        for s in values {
            let b64 = if s.starts_with("http://") || s.starts_with("https://") {
                // F-011：URL 结果统一走带状态码 / 体积上限 / 魔数校验的下载函数
                let bytes =
                    download_image_bytes(&s, std::time::Duration::from_secs(config.timeout_secs))
                        .await?;
                base64::engine::general_purpose::STANDARD.encode(&bytes)
            } else {
                s
            };
            out.push(b64);
        }
        Ok(out)
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
            let vars = render_vars(&pairs);
            let url = render_url(&config.template_url, &vars);
            let body = render_body(&config.template_body, &vars);
            Self::request_and_extract(config, &url, &body, &config.template_response_path).await
        })
    }

    fn edit<'a>(
        &'a self,
        config: &'a ProviderConfig,
        req: &'a EditRequest,
    ) -> super::BoxFuture<'a, Result<String, AdapterError>> {
        Box::pin(async move {
            let spec = Self::require_spec(&config.edit_template, "编辑")?.clone();
            let pairs = Self::edit_vars(config, req);
            let vars = render_vars(&pairs);
            let url = render_url(&spec.url, &vars);
            let body = render_body(&spec.body, &vars);
            Self::request_and_extract(config, &url, &body, &spec.response_path)
                .await?
                .into_iter()
                .next()
                .ok_or_else(|| AdapterError::Other {
                    message: "编辑模板响应未返回图片".into(),
                })
        })
    }

    fn transform<'a>(
        &'a self,
        config: &'a ProviderConfig,
        req: &'a TransformRequest,
    ) -> super::BoxFuture<'a, Result<String, AdapterError>> {
        Box::pin(async move {
            let spec = Self::require_spec(&config.transform_template, "变换")?.clone();
            let pairs = Self::transform_vars(config, req);
            let vars = render_vars(&pairs);
            let url = render_url(&spec.url, &vars);
            let body = render_body(&spec.body, &vars);
            Self::request_and_extract(config, &url, &body, &spec.response_path)
                .await?
                .into_iter()
                .next()
                .ok_or_else(|| AdapterError::Other {
                    message: "变换模板响应未返回图片".into(),
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
            edit_template: None,
            transform_template: None,
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
            references: vec![
                crate::reference::ReferenceSpec {
                    role: crate::reference::ReferenceRole::Composition,
                    strength: Some(30),
                },
                crate::reference::ReferenceSpec {
                    role: crate::reference::ReferenceRole::Style,
                    strength: None,
                },
            ],
        };
        let pairs = TemplateAdapter::vars(&config, &req);
        let pairs = vars_as_strs(&pairs);
        assert_eq!(render_template("{{image}}", &pairs), "AAA");
        assert_eq!(render_template("{{images}}", &pairs), r#"["AAA","BBB"]"#);
        assert_eq!(render_template("{{image_count}}", &pairs), "2");
        let roles = render_template("{{ref_roles}}", &pairs);
        assert!(roles.contains(r#""role":"composition""#));
        assert!(roles.contains(r#""index":2"#));
        assert!(roles.contains(r#""strength":60"#));

        let empty = GenerateRequest {
            images: vec![],
            ..req
        };
        let pairs = TemplateAdapter::vars(&config, &empty);
        let pairs = vars_as_strs(&pairs);
        assert_eq!(render_template("x{{image}}y", &pairs), "xy");
        assert_eq!(render_template("{{image_count}}", &pairs), "0");
    }

    fn template_config(
        edit: Option<TemplateSpec>,
        transform: Option<TemplateSpec>,
    ) -> ProviderConfig {
        ProviderConfig {
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
            edit_template: edit,
            transform_template: transform,
            extra_params: String::new(),
        }
    }

    /// 编辑模板变量：原图走 {{image}}，有蒙版时 {{mask_count}} = 1，没有则为 0
    #[test]
    fn edit_vars_inject_image_and_mask() {
        let config = template_config(None, None);
        let req = EditRequest {
            prompt: "换成落日".into(),
            negative_prompt: Some("模糊".into()),
            model: "m".into(),
            image_b64: "IMG".into(),
            mask_b64: Some("MASK".into()),
            width: 800,
            height: 600,
        };
        let pairs = TemplateAdapter::edit_vars(&config, &req);
        let pairs = vars_as_strs(&pairs);
        assert_eq!(render_template("{{image}}", &pairs), "IMG");
        assert_eq!(render_template("{{mask}}", &pairs), "MASK");
        assert_eq!(render_template("{{mask_count}}", &pairs), "1");
        assert_eq!(render_template("{{negative_prompt}}", &pairs), "模糊");
        assert_eq!(render_template("{{size}}", &pairs), "800x600");

        let no_mask = EditRequest {
            mask_b64: None,
            ..req
        };
        let pairs = TemplateAdapter::edit_vars(&config, &no_mask);
        let pairs = vars_as_strs(&pairs);
        assert_eq!(render_template("{{mask}}", &pairs), "");
        assert_eq!(render_template("{{mask_count}}", &pairs), "0");
    }

    /// 变换模板变量：{{scale}} / {{mode}} 必须注入
    #[test]
    fn transform_vars_inject_scale_and_mode() {
        let config = template_config(None, None);
        let req = TransformRequest {
            prompt: "水彩".into(),
            model: "m".into(),
            image_b64: "IMG".into(),
            scale: 4,
            mode: "faithful".into(),
        };
        let pairs = TemplateAdapter::transform_vars(&config, &req);
        let pairs = vars_as_strs(&pairs);
        assert_eq!(render_template("{{image}}", &pairs), "IMG");
        assert_eq!(render_template("{{scale}}", &pairs), "4");
        assert_eq!(render_template("{{mode}}", &pairs), "faithful");
        assert_eq!(render_template("{{prompt}}", &pairs), "水彩");
    }

    /// 未配置模板时给出「未配置」而不是「不支持」，且不发起网络请求
    #[test]
    fn missing_template_reports_not_configured() {
        let config = template_config(None, None);
        let err = TemplateAdapter::require_spec(&config.edit_template, "编辑").unwrap_err();
        assert!(
            err.message().contains("未配置编辑模板"),
            "{}",
            err.message()
        );
        // 三项全空的 spec 视同未配置（与空串列语义一致）
        let blank = TemplateSpec::default();
        let err = TemplateAdapter::require_spec(&Some(blank), "变换").unwrap_err();
        assert!(
            err.message().contains("未配置变换模板"),
            "{}",
            err.message()
        );
    }

    /// 模板配置 JSON 往返：空串 → None，合法 JSON → Some，坏 JSON 不 panic
    #[test]
    fn template_spec_json_roundtrip() {
        assert!(TemplateSpec::from_json("").is_none());
        assert!(TemplateSpec::from_json("{}").is_none());
        let raw = crate::storage::template_spec_json("https://x/y", "{}", "data[0].url");
        let spec = TemplateSpec::from_json(&raw).expect("合法 JSON 应解析成功");
        assert_eq!(spec.url, "https://x/y");
        assert_eq!(spec.response_path, "data[0].url");
        assert!(TemplateSpec::from_json("not json").is_none());
    }

    /// F-002：prompt 里的 `{{key}}` 不会被二次替换成 API Key（模板注入）
    #[test]
    fn body_render_does_not_rescan_prompt_injection() {
        let vars = [
            ("prompt", Var::Text("{{key}}")),
            ("key", Var::Text("sk-secret")),
        ];
        let body = render_body(r#"{"prompt":"{{prompt}}","key":"{{key}}"}"#, &vars);
        let parsed: serde_json::Value = serde_json::from_str(&body).expect("body 必须是合法 JSON");
        assert_eq!(parsed["prompt"], "{{key}}");
        assert_eq!(parsed["key"], "sk-secret");
    }

    /// F-002：变量表顺序不影响渲染结果（旧实现后替换的变量会覆盖先插入的值）
    #[test]
    fn body_render_is_order_independent() {
        let forward = [("prompt", Var::Text("p")), ("key", Var::Text("k"))];
        let mut reversed = forward;
        reversed.reverse();
        assert_eq!(
            render_body("{{prompt}}/{{key}}", &forward),
            render_body("{{prompt}}/{{key}}", &reversed)
        );
    }

    /// F-002：引号 / 换行 / 反斜杠都转义成合法 JSON 字符串
    #[test]
    fn body_render_escapes_json_specials() {
        let prompt = "a\"b\nc\\d";
        let vars = [("prompt", Var::Text(prompt))];
        let body = render_body(r#"{"prompt":"{{prompt}}"}"#, &vars);
        let parsed: serde_json::Value = serde_json::from_str(&body).expect("转义后必须是合法 JSON");
        assert_eq!(parsed["prompt"], prompt);
    }

    /// F-002：{{images}} / {{ref_roles}} 是 JSON 片段，不能被当成字符串转义
    #[test]
    fn body_render_keeps_json_fragments_raw() {
        let vars = [
            ("images", Var::Json(r#"["A","B"]"#)),
            ("prompt", Var::Text("p")),
        ];
        let body = render_body(r#"{"images":{{images}},"prompt":"{{prompt}}"}"#, &vars);
        let parsed: serde_json::Value = serde_json::from_str(&body).expect("body 必须是合法 JSON");
        assert_eq!(parsed["images"], serde_json::json!(["A", "B"]));
    }

    /// F-002：URL 变量做百分号编码；模板自身的 ? / & / = 保持不变
    #[test]
    fn url_render_percent_encodes_values() {
        let vars = [
            ("prompt", Var::Text("猫 a b#c")),
            ("key", Var::Text("sk-123")),
        ];
        let url = render_url("https://x.com/draw?p={{prompt}}&k={{key}}", &vars);
        assert!(url.starts_with("https://x.com/draw?p="), "{url}");
        assert!(url.contains("%E7%8C%AB"), "{url}");
        assert!(url.contains("a%20b%23c"), "{url}");
        assert!(url.ends_with("&k=sk-123"), "{url}");
    }

    /// 旧的 raw 渲染也必须是单遍：保留兼容测试覆盖，但不再有注入风险
    #[test]
    fn legacy_render_template_is_single_pass() {
        assert_eq!(
            render_template("{{prompt}}", &[("prompt", "{{key}}"), ("key", "sk")]),
            "{{key}}"
        );
    }
}
