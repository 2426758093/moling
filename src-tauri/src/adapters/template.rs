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
            let mut current = &json;
            let re = regex_free_path(&path);
            for seg in re {
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
            let s = current.as_str().ok_or_else(|| AdapterError::Other {
                message: "提取到的图片字段不是字符串".into(),
            })?;
            let b64 = if s.starts_with("http://") || s.starts_with("https://") {
                let bytes = http_client()
                    .get(s)
                    .timeout(std::time::Duration::from_secs(config.timeout_secs))
                    .send()
                    .await
                    .map_err(|e| classify_reqwest(&e))?
                    .bytes()
                    .await
                    .map_err(|e| classify_reqwest(&e))?;
                base64::engine::general_purpose::STANDARD.encode(&bytes)
            } else {
                s.to_string()
            };
            Ok(vec![b64])
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

fn regex_free_path(path: &str) -> Vec<PathSeg> {
    let mut out = Vec::new();
    for part in path.split('.') {
        let part = part.trim();
        if part.is_empty() {
            continue;
        }
        if let Some(inner) = part.strip_prefix('[').and_then(|s| s.strip_suffix(']')) {
            if let Ok(i) = inner.parse::<usize>() {
                out.push(PathSeg::Index(i));
                continue;
            }
        }
        out.push(PathSeg::Key(part.to_string()));
    }
    out
}
