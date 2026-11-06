use crate::adapters::{get_adapter, AdapterError, GenerateRequest, ProviderConfig};
use base64::Engine;

fn mock_config() -> ProviderConfig {
    ProviderConfig {
        id: None,
        name: "mock".into(),
        base_url: String::new(),
        api_key: String::new(),
        kind: "mock".into(),
        models_json: String::new(),
        default_model: "mock-draw-v1".into(),
        timeout_secs: 60,
        template_url: String::new(),
        template_body: String::new(),
        template_response_path: String::new(),
        edit_template: None,
        transform_template: None,
        extra_params: String::new(),
    }
}

fn mock_req(prompt: &str) -> GenerateRequest {
    GenerateRequest {
        prompt: prompt.into(),
        negative_prompt: None,
        model: "mock-draw-v1".into(),
        width: 512,
        height: 512,
        guidance: None,
        steps: None,
        seed: Some(42),
        count: 3,
        quality: None,
        images: vec![],
        references: vec![],
    }
}

/// 测试内联执行异步适配器调用（生产路径由 Tauri 异步运行时驱动）
fn block_on<F: std::future::Future>(f: F) -> F::Output {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime")
        .block_on(f)
}

#[test]
fn mock_generate_returns_count_images() {
    let adapter = get_adapter("mock").unwrap();
    let imgs = block_on(adapter.generate(&mock_config(), &mock_req("a cat"))).unwrap();
    assert_eq!(imgs.len(), 3);
    assert!(imgs[0].starts_with("data:image/svg+xml;base64,"));
}

#[test]
fn mock_error_injection() {
    let adapter = get_adapter("mock").unwrap();
    let err = block_on(adapter.generate(&mock_config(), &mock_req("mock:error:auth"))).unwrap_err();
    assert!(matches!(
        err,
        crate::adapters::AdapterError::AuthInvalid { .. }
    ));
    let err =
        block_on(adapter.generate(&mock_config(), &mock_req("mock:error:blocked"))).unwrap_err();
    assert!(matches!(
        err,
        crate::adapters::AdapterError::ContentBlocked { .. }
    ));
}

#[test]
fn mock_list_models() {
    let adapter = get_adapter("mock").unwrap();
    let models = block_on(adapter.list_models(&mock_config())).unwrap();
    assert_eq!(models.len(), 2);
}

#[test]
fn unknown_kind_errors_instead_of_fallback() {
    let err = match get_adapter("openia") {
        Err(e) => e,
        Ok(_) => panic!("未知 kind 必须报错而不是回退"),
    };
    assert!(matches!(err, AdapterError::Other { .. }));
    assert!(err.message().contains("未知适配器类型"));
    assert!(get_adapter("openai").is_ok());
    assert!(get_adapter("template").is_ok());
}

#[test]
fn classify_http_content_policy_tightened() {
    use crate::adapters::classify_http;
    // 普通 400（参数错误）不再因含 "content" 被误判为 ContentBlocked
    let err = classify_http(
        reqwest::StatusCode::BAD_REQUEST,
        r#"{"error":{"message":"invalid content type","type":"invalid_request_error"}}"#,
    );
    assert!(matches!(err, AdapterError::Other { .. }));
    // 明确的内容审核关键词仍归类为 ContentBlocked
    let err = classify_http(
        reqwest::StatusCode::BAD_REQUEST,
        "content_policy_violation: request blocked by safety system",
    );
    assert!(matches!(err, AdapterError::ContentBlocked { .. }));
    let err = classify_http(reqwest::StatusCode::BAD_REQUEST, "内容审核未通过");
    assert!(matches!(err, AdapterError::ContentBlocked { .. }));
    // 401/429 分类不变
    assert!(matches!(
        classify_http(reqwest::StatusCode::UNAUTHORIZED, "bad key"),
        AdapterError::AuthInvalid { .. }
    ));
    assert!(matches!(
        classify_http(reqwest::StatusCode::TOO_MANY_REQUESTS, "rate limit"),
        AdapterError::QuotaExceeded { .. }
    ));
}

#[test]
fn template_render() {
    let rendered = crate::adapters::template::render_template(
        "https://x.com/draw?p={{prompt}}&s={{size}}&k={{key}}",
        &[("prompt", "猫"), ("size", "1024x1024"), ("key", "sk")],
    );
    assert_eq!(rendered, "https://x.com/draw?p=猫&s=1024x1024&k=sk");
}

#[test]
fn openai_size_snaps_to_supported_presets() {
    use crate::adapters::openai::snap_size;
    assert_eq!(snap_size(680, 1024), "1024x1536");
    assert_eq!(snap_size(1024, 1024), "1024x1024");
    assert_eq!(snap_size(1360, 1024), "1536x1024");
    assert_eq!(snap_size(1024, 768), "1536x1024");
}

#[test]
fn openai_auto_size_and_quality_mapping() {
    use crate::adapters::openai::{is_auto_size, map_quality};
    assert!(is_auto_size(0, 0));
    assert!(!is_auto_size(0, 1024));
    assert!(!is_auto_size(1024, 0));
    assert_eq!(
        map_quality("gpt-image-1", Some("high")),
        Some("high".into())
    );
    assert_eq!(map_quality("gpt-image-1", Some("auto")), None);
    assert_eq!(map_quality("gpt-image-1", None), None);
    // DALL·E 3 只认 standard / hd
    assert_eq!(map_quality("dall-e-3", Some("high")), Some("hd".into()));
    assert_eq!(
        map_quality("dall-e-3", Some("low")),
        Some("standard".into())
    );
    // DALL·E 2 没有 quality 字段
    assert_eq!(map_quality("dall-e-2", Some("high")), None);
}

#[test]
fn openai_edit_form_drops_response_format() {
    use crate::adapters::openai::edit_form_fields;
    let body = serde_json::json!({
        "model": "openai/gpt-image-2.5-sunburst",
        "prompt": "画一只猫",
        "n": 1,
        "size": "1024x1024",
        "response_format": "b64_json",
        "nested": {"a": 1}
    });
    let fields = edit_form_fields(&body);
    let keys: Vec<&str> = fields.iter().map(|(k, _)| k.as_str()).collect();
    // 严格网关会因 response_format 返回 400；嵌套对象无法作为表单文本
    assert!(keys.contains(&"model"));
    assert!(keys.contains(&"prompt"));
    assert_eq!(
        fields
            .iter()
            .find(|(k, _)| k == "n")
            .map(|(_, v)| v.as_str()),
        Some("1")
    );
    assert!(!keys.contains(&"response_format"));
    assert!(!keys.contains(&"nested"));
}

#[test]
fn openai_extra_params_merge() {
    use crate::adapters::openai::merge_extra_params;
    let mut config = mock_config();
    config.extra_params = r#"{"steps":30,"quality":"high"}"#.into();
    let mut body = serde_json::json!({"model": "m", "size": "1024x1024"});
    merge_extra_params(&mut body, &config);
    assert_eq!(body["steps"], 30);
    assert_eq!(body["quality"], "high");
    assert_eq!(body["model"], "m");
    // 非法 JSON 不破坏请求体
    config.extra_params = "{oops".into();
    let mut body2 = serde_json::json!({"a": 1});
    merge_extra_params(&mut body2, &config);
    assert_eq!(body2["a"], 1);
    assert!(body2.get("steps").is_none());
}

#[test]
fn refine_user_input_with_context() {
    use crate::adapters::chat::build_refine_user_input;
    let plain = build_refine_user_input("画一只猫", None);
    assert_eq!(plain, "画一只猫");
    let with_ctx = build_refine_user_input("换成夜景", Some("a sunny beach"));
    assert!(with_ctx.contains("a sunny beach"));
    assert!(with_ctx.contains("换成夜景"));
    // 空白上下文等同无上下文
    let blank = build_refine_user_input("画一只猫", Some("   "));
    assert_eq!(blank, "画一只猫");
}

#[test]
fn mock_generate_with_reference_images() {
    let adapter = get_adapter("mock").unwrap();
    let mut req = mock_req("带参考图");
    // 任意合法 base64（几个字节即可参与色相计算）
    req.images = vec!["aGVsbG8gd29ybGQ=".to_string()];
    let imgs = block_on(adapter.generate(&mock_config(), &req)).unwrap();
    assert_eq!(imgs.len(), 3);
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(imgs[0].trim_start_matches("data:image/svg+xml;base64,"))
        .unwrap();
    let svg = String::from_utf8(decoded).unwrap();
    assert!(svg.contains("参考图x1"));
}

/// 负向提示词按「提示词尾句」表达：OpenAI 兼容接口不新增非标准字段（ADR #3）
#[test]
fn prompt_with_negative_appends_avoid_clause() {
    use crate::adapters::prompt_with_negative;
    assert_eq!(prompt_with_negative("a cat", None), "a cat");
    assert_eq!(prompt_with_negative("a cat", Some("   ")), "a cat");
    assert_eq!(
        prompt_with_negative("a cat", Some(" blurry ")),
        "a cat\n\nAvoid: blurry"
    );
}

#[test]
fn mock_echoes_negative_prompt() {
    let adapter = get_adapter("mock").unwrap();
    let mut req = mock_req("a cat");
    req.negative_prompt = Some("blurry, low quality".into());
    let imgs = block_on(adapter.generate(&mock_config(), &req)).unwrap();
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(imgs[0].trim_start_matches("data:image/svg+xml;base64,"))
        .unwrap();
    let svg = String::from_utf8(decoded).unwrap();
    // 占位图标签截断到 24 字符，只断言负向标记与首词
    assert!(svg.contains("[负向] blurry"));
}

/// 换背景 AI 路径：蒙版 + 指令前缀必须原样到达适配器（mock 回显 [inpainted] 标记）
#[test]
fn mock_edit_receives_background_prompt() {
    use crate::background::background_ai_prompt;
    let adapter = get_adapter("mock").unwrap();
    let req = crate::adapters::EditRequest {
        prompt: background_ai_prompt("starry night city"),
        negative_prompt: None,
        model: "mock-draw-v1".into(),
        image_b64: "AAAA".into(),
        mask_b64: Some("BBBB".into()),
        width: 64,
        height: 64,
    };
    let out = block_on(adapter.edit(&mock_config(), &req)).unwrap();
    assert!(out.starts_with("data:image/svg+xml;base64,"));
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(out.trim_start_matches("data:image/svg+xml;base64,"))
        .unwrap();
    let svg = String::from_utf8(decoded).unwrap();
    // 占位图标签截断到 24 字符，指令前缀必须出现在最前面
    assert!(svg.contains("Replace the masked"), "{svg}");
}

fn gzip(data: &[u8]) -> Vec<u8> {
    use flate2::write::GzEncoder;
    use flate2::Compression;
    use std::io::Write;
    let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
    encoder.write_all(data).unwrap();
    encoder.finish().unwrap()
}

/// 起一个只服务一次的本地 HTTP/1.1 端点，返回监听端口
fn serve_once(headers: Vec<(&'static str, &'static str)>, body: Vec<u8>) -> u16 {
    use std::io::{Read, Write};
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let mut request = Vec::new();
        let mut buf = [0u8; 1024];
        while !request.windows(4).any(|w| w == b"\r\n\r\n") {
            match stream.read(&mut buf).unwrap_or(0) {
                0 => break,
                n => request.extend_from_slice(&buf[..n]),
            }
        }
        let mut resp = String::from("HTTP/1.1 200 OK\r\n");
        for (name, value) in headers {
            resp.push_str(&format!("{name}: {value}\r\n"));
        }
        resp.push_str(&format!(
            "Content-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        ));
        stream.write_all(resp.as_bytes()).unwrap();
        stream.write_all(&body).unwrap();
        stream.flush().unwrap();
    });
    port
}

/// 端到端：真实 HTTP 链路下，链路压缩与响应头不一致时仍要解析成功。
/// 旧实现依赖 reqwest 自动解压，遇到「头写 gzip、body 已明文」只会报 decoding 错误。
#[test]
fn parse_json_body_tolerates_content_encoding_mismatch() {
    use crate::adapters::http::{build_client, ProxyConfig, MODE_DIRECT};
    use crate::adapters::parse_json_body;

    struct Case {
        name: &'static str,
        headers: Vec<(&'static str, &'static str)>,
        body: Vec<u8>,
    }

    let payload = br#"{"data":["ok"]}"#.to_vec();
    let cases = vec![
        Case {
            name: "gzip body + 正确头",
            headers: vec![
                ("Content-Type", "application/json"),
                ("Content-Encoding", "gzip"),
            ],
            body: gzip(&payload),
        },
        Case {
            name: "gzip body + 无头",
            headers: vec![("Content-Type", "application/json")],
            body: gzip(&payload),
        },
        Case {
            name: "明文 body + 谎报 gzip 头",
            headers: vec![
                ("Content-Type", "application/json"),
                ("Content-Encoding", "gzip"),
            ],
            body: payload,
        },
    ];

    let client = build_client(
        &ProxyConfig {
            mode: MODE_DIRECT.into(),
            ..Default::default()
        },
        "",
    )
    .unwrap();

    for Case {
        name,
        headers,
        body,
    } in cases
    {
        let port = serve_once(headers, body);
        // 请求与读 body 必须在同一个运行时里：连接驱动任务随运行时销毁
        let parsed: serde_json::Value = block_on(async {
            let resp = client
                .get(format!("http://127.0.0.1:{port}/x"))
                .timeout(std::time::Duration::from_secs(5))
                .send()
                .await
                .unwrap();
            parse_json_body(resp, "/x")
                .await
                .unwrap_or_else(|e| panic!("{name}: {e:?}"))
        });
        assert_eq!(parsed["data"][0], "ok", "{name}");
    }
}
