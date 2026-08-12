#![cfg(unix)]

use std::{
    fs,
    os::unix::fs::{PermissionsExt, symlink},
};

use campaign_domain::Hash256;
use campaign_providers::{
    AppServerTransport, ProviderError, SubscriptionTransport, TransportRequest,
};
use serde_json::json;

fn fake_codex(root: &std::path::Path) -> std::path::PathBuf {
    let mode_path = root.join("mode");
    fs::write(&mode_path, "normal").unwrap();
    let script = root.join("codex");
    let mode_literal = serde_json::to_string(&mode_path).unwrap();
    let source = format!(
        r#"#!/usr/bin/env python3
import json, pathlib, sys
MODE = pathlib.Path({mode_literal})
RATE_READS = 0
if '--version' in sys.argv:
    print('codex-cli 1.0.0')
    raise SystemExit(0)

def send(i, result):
    print(json.dumps({{'jsonrpc': '2.0', 'id': i, 'result': result}}), flush=True)

for line in sys.stdin:
    msg = json.loads(line)
    if 'id' not in msg:
        continue
    i, method = msg['id'], msg.get('method')
    if method == 'initialize':
        send(i, {{}})
    elif method == 'account/read':
        send(i, {{'account': {{'type': 'chatgpt', 'planType': 'subscription'}}}})
    elif method == 'account/rateLimits/read':
        RATE_READS += 1
        if MODE.read_text().strip() == 'invalid-output-rate-crash' and RATE_READS > 1:
            raise SystemExit(0)
        send(i, {{'primary': {{'usedPercent': 1}}}})
    elif method == 'model/list':
        send(i, {{'data': [{{'model': 'gpt-5.6-luna'}}]}})
    elif method == 'thread/start':
        send(i, {{'model': 'gpt-5.6-luna', 'thread': {{'id': 'thread-1'}}}})
    elif method == 'thread/resume':
        send(i, {{'model': 'gpt-5.6-luna', 'thread': {{'id': 'thread-1'}}}})
    elif method == 'thread/read':
        if MODE.read_text().strip() == 'resume-read-crash':
            raise SystemExit(0)
        send(i, {{'thread': {{'turns': [{{
            'id': 'turn-1', 'status': 'completed',
            'items': [] if MODE.read_text().strip().startswith('invalid-output') else [{{'type': 'agentMessage', 'text': '{{\"ok\":true}}'}}]
        }}]}}}})
    elif method == 'turn/start':
        if MODE.read_text().strip() == 'crash-before-response':
            raise SystemExit(0)
        send(i, {{'turn': {{'id': 'turn-1'}}}})
        if MODE.read_text().strip() == 'crash':
            raise SystemExit(0)
        print(json.dumps({{
            'jsonrpc': '2.0', 'method': 'thread/tokenUsage/updated',
            'params': {{'threadId': 'thread-1', 'turnId': 'turn-1', 'tokenUsage': {{'last': {{
                'inputTokens': 11, 'cachedInputTokens': 2,
                'outputTokens': 7, 'reasoningOutputTokens': 3
            }}}}}}
        }}), flush=True)
        print(json.dumps({{
            'jsonrpc': '2.0', 'method': 'turn/completed',
            'params': {{'threadId': 'thread-1', 'turn': {{
                'id': 'turn-1', 'status': 'completed',
                'items': [] if MODE.read_text().strip().startswith('invalid-output') else [{{'type': 'agentMessage', 'text': '{{\"ok\":true}}'}}]
            }}}}
        }}), flush=True)
"#
    );
    fs::write(&script, source).unwrap();
    fs::set_permissions(&script, fs::Permissions::from_mode(0o700)).unwrap();
    script
}

fn request() -> TransportRequest {
    TransportRequest {
        prompt: "Return JSON.".into(),
        input: json!({"value": 1}),
        output_schema: json!({
            "type": "object",
            "required": ["ok"],
            "properties": {"ok": {"type": "boolean"}},
            "additionalProperties": false
        }),
        model: "gpt-5.6-luna".into(),
        reasoning: "high".into(),
        prompt_hash: Hash256::digest("prompt"),
        tool_contract_hash: Hash256::digest("tool-contract"),
    }
}

#[tokio::test]
async fn subscription_probe_turn_and_crash_resume_are_bounded() {
    let root = tempfile::tempdir().unwrap();
    let codex = fake_codex(root.path());

    unsafe { std::env::set_var("OPENAI_API_KEY", "forbidden-test-value") };
    let denied = AppServerTransport::connect(&codex, root.path(), "gpt-5.6-luna", "high").await;
    assert!(matches!(denied, Err(ProviderError::ApiKeyForbidden)));
    unsafe { std::env::remove_var("OPENAI_API_KEY") };

    let transport = AppServerTransport::connect(&codex, root.path(), "gpt-5.6-luna", "high")
        .await
        .unwrap();
    let capabilities = transport.probe().await.unwrap();
    assert!(capabilities.subscription_authenticated);
    assert!(!capabilities.api_key_authenticated);
    let exchange = transport.start_or_resume(request(), None).await.unwrap();
    assert_eq!(exchange.response, json!({"ok": true}));
    assert!(exchange.usage.available);
    assert_eq!(exchange.usage.input_tokens, 11);

    let runtime_tmp = root.path().join("codex-home/tmp");
    fs::create_dir_all(&runtime_tmp).unwrap();
    symlink("/usr/bin/true", runtime_tmp.join("codex-runtime-wrapper")).unwrap();
    fs::write(root.path().join("mode"), "crash").unwrap();
    let crashing = AppServerTransport::connect(&codex, root.path(), "gpt-5.6-luna", "high")
        .await
        .unwrap();
    let error = crashing
        .start_or_resume(
            TransportRequest {
                input: json!({"value": 2}),
                ..request()
            },
            None,
        )
        .await
        .unwrap_err();
    assert!(matches!(error, ProviderError::Unreconciled(Some(_))));

    fs::write(root.path().join("mode"), "resume").unwrap();
    let resumed = AppServerTransport::connect(&codex, root.path(), "gpt-5.6-luna", "high")
        .await
        .unwrap()
        .start_or_resume(
            TransportRequest {
                input: json!({"value": 2}),
                ..request()
            },
            None,
        )
        .await
        .unwrap();
    assert_eq!(resumed.response, json!({"ok": true}));
    assert!(!resumed.usage.available);

    fs::write(root.path().join("mode"), "crash-before-response").unwrap();
    let uncertain = AppServerTransport::connect(&codex, root.path(), "gpt-5.6-luna", "high")
        .await
        .unwrap()
        .start_or_resume(
            TransportRequest {
                input: json!({"value": 3}),
                ..request()
            },
            None,
        )
        .await
        .unwrap_err();
    assert!(matches!(uncertain, ProviderError::Unreconciled(Some(_))));

    fs::write(root.path().join("mode"), "resume").unwrap();
    let recovered_unknown_turn =
        AppServerTransport::connect(&codex, root.path(), "gpt-5.6-luna", "high")
            .await
            .unwrap()
            .start_or_resume(
                TransportRequest {
                    input: json!({"value": 3}),
                    ..request()
                },
                None,
            )
            .await
            .unwrap();
    assert_eq!(recovered_unknown_turn.response, json!({"ok": true}));
}

#[tokio::test]
async fn terminal_invalid_output_is_not_replayed_on_retry() {
    let root = tempfile::tempdir().unwrap();
    let codex = fake_codex(root.path());
    fs::write(root.path().join("mode"), "invalid-output-rate-crash").unwrap();
    let transport = AppServerTransport::connect(&codex, root.path(), "gpt-5.6-luna", "high")
        .await
        .unwrap();

    let error = transport
        .start_or_resume(request(), None)
        .await
        .unwrap_err();

    assert!(matches!(error, ProviderError::InvalidStructuredOutput));
    assert_eq!(
        fs::read_dir(root.path().join("provider-checkpoints"))
            .unwrap()
            .count(),
        0
    );

    fs::write(root.path().join("mode"), "normal").unwrap();
    let retried = transport.start_or_resume(request(), None).await.unwrap();
    assert_eq!(retried.response, json!({"ok": true}));
}

#[tokio::test]
async fn reconciliation_read_failure_keeps_checkpoint_until_observed() {
    let root = tempfile::tempdir().unwrap();
    let codex = fake_codex(root.path());
    let retried_request = TransportRequest {
        input: json!({"value": 4}),
        ..request()
    };
    fs::write(root.path().join("mode"), "crash").unwrap();
    let first = AppServerTransport::connect(&codex, root.path(), "gpt-5.6-luna", "high")
        .await
        .unwrap()
        .start_or_resume(retried_request.clone(), None)
        .await
        .unwrap_err();
    assert!(matches!(first, ProviderError::Unreconciled(Some(_))));

    fs::write(root.path().join("mode"), "resume-read-crash").unwrap();
    let uncertain = AppServerTransport::connect(&codex, root.path(), "gpt-5.6-luna", "high")
        .await
        .unwrap()
        .start_or_resume(retried_request.clone(), None)
        .await
        .unwrap_err();
    assert!(matches!(uncertain, ProviderError::Unreconciled(Some(_))));
    assert_eq!(
        fs::read_dir(root.path().join("provider-checkpoints"))
            .unwrap()
            .count(),
        1
    );

    fs::write(root.path().join("mode"), "resume").unwrap();
    let recovered = AppServerTransport::connect(&codex, root.path(), "gpt-5.6-luna", "high")
        .await
        .unwrap()
        .start_or_resume(retried_request, None)
        .await
        .unwrap();
    assert_eq!(recovered.response, json!({"ok": true}));
}
