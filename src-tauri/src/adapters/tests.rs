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
        images: vec![],
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
