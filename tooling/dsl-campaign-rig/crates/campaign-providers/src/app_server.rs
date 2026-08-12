use std::{
    collections::BTreeSet,
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    process::Stdio,
};

use async_trait::async_trait;
use campaign_domain::Hash256;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines},
    process::{Child, ChildStdin, ChildStdout, Command},
    sync::Mutex,
};

use crate::{
    ProviderError, ProviderIdentity, SubscriptionCapabilities, SubscriptionTransport,
    TransportCheckpoint, TransportExchange, TransportRequest, UsageSample,
    app_server_protocol::{
        JsonRpcMessage, JsonRpcNotification, JsonRpcRequest, PROTOCOL_SNAPSHOT, contains_tool_item,
        extract_agent_message,
    },
    auth::validate_account_response,
};

#[derive(Clone, Debug, Serialize, Deserialize)]
struct AppServerCheckpoint {
    thread_id: String,
    turn_id: Option<String>,
    request_hash: Hash256,
    #[serde(default)]
    usage: Option<UsageSample>,
}

struct RpcSession {
    child: Child,
    stdin: ChildStdin,
    stdout: Lines<BufReader<ChildStdout>>,
    next_id: u64,
}

impl RpcSession {
    async fn start(codex: &Path, codex_home: &Path) -> Result<Self, ProviderError> {
        let mut child = Command::new(codex)
            .args(["app-server", "--stdio"])
            .env("CODEX_HOME", codex_home)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .env_remove("OPENAI_API_KEY")
            .kill_on_drop(true)
            .spawn()?;
        let stdin = child.stdin.take().ok_or(ProviderError::ProcessEnded)?;
        let stdout = child.stdout.take().ok_or(ProviderError::ProcessEnded)?;
        let mut session = Self {
            child,
            stdin,
            stdout: BufReader::new(stdout).lines(),
            next_id: 1,
        };
        session
            .request(
                "initialize",
                json!({
                    "clientInfo": {"name": "dsl-campaign-rig", "version": env!("CARGO_PKG_VERSION")},
                    "capabilities": {"experimentalApi": false, "optOutNotificationMethods": []}
                }),
            )
            .await?;
        session.notify("initialized", json!({})).await?;
        Ok(session)
    }

    async fn request(&mut self, method: &str, params: Value) -> Result<Value, ProviderError> {
        let id = self.next_id;
        self.next_id += 1;
        let request = JsonRpcRequest {
            jsonrpc: "2.0",
            id,
            method,
            params,
        };
        self.write_json(&request).await?;
        tokio::time::timeout(std::time::Duration::from_secs(30), async {
            loop {
                let message = self.read_message().await?;
                if message.id.as_ref().and_then(Value::as_u64) == Some(id) {
                    if message.error.is_some() {
                        return Err(ProviderError::ProtocolMismatch);
                    }
                    return message.result.ok_or(ProviderError::ProtocolMismatch);
                }
                if message.id.is_some() && message.method.is_some() {
                    let response = json!({
                        "jsonrpc": "2.0",
                        "id": message.id,
                        "error": {"code": -32601, "message": "capability denied"}
                    });
                    self.write_json(&response).await?;
                }
            }
        })
        .await
        .map_err(|_| ProviderError::Timeout)?
    }

    async fn notify(&mut self, method: &str, params: Value) -> Result<(), ProviderError> {
        self.write_json(&JsonRpcNotification {
            jsonrpc: "2.0",
            method,
            params,
        })
        .await
    }

    async fn read_message(&mut self) -> Result<JsonRpcMessage, ProviderError> {
        let line = self.stdout.next_line().await?.ok_or_else(|| {
            let _ = self.child.start_kill();
            ProviderError::ProcessEnded
        })?;
        Ok(serde_json::from_str(&line)?)
    }

    async fn write_json(&mut self, value: &impl Serialize) -> Result<(), ProviderError> {
        let mut bytes = serde_json::to_vec(value)?;
        bytes.push(b'\n');
        self.stdin.write_all(&bytes).await?;
        self.stdin.flush().await?;
        Ok(())
    }
}

pub struct AppServerTransport {
    session: Mutex<RpcSession>,
    identity: ProviderIdentity,
    capabilities: SubscriptionCapabilities,
    safe_cwd: PathBuf,
    checkpoint_root: PathBuf,
}

impl AppServerTransport {
    pub async fn connect(
        codex_path: &Path,
        safe_cwd: &Path,
        model: &str,
        reasoning: &str,
    ) -> Result<Self, ProviderError> {
        if std::env::var_os("OPENAI_API_KEY").is_some() {
            return Err(ProviderError::ApiKeyForbidden);
        }
        let codex_path = codex_path.canonicalize()?;
        let safe_cwd = safe_cwd.canonicalize()?;
        let binary_hash = Hash256::digest(std::fs::read(&codex_path)?);
        let version_output = Command::new(&codex_path).arg("--version").output().await?;
        if !version_output.status.success() {
            return Err(ProviderError::ProcessEnded);
        }
        let version = String::from_utf8(version_output.stdout)
            .map_err(|_| ProviderError::ProtocolMismatch)?;
        let codex_home = prepare_codex_home(&safe_cwd)?;
        let mut session = RpcSession::start(&codex_path, &codex_home).await?;
        let account = session
            .request("account/read", json!({"refreshToken": false}))
            .await?;
        let account = validate_account_response(&account)?;
        let rate_limits = session
            .request("account/rateLimits/read", Value::Null)
            .await?;
        let models = session.request("model/list", json!({"limit": 100})).await?;
        let model_supported = models
            .get("data")
            .or_else(|| models.get("models"))
            .and_then(Value::as_array)
            .is_some_and(|models| {
                models.iter().any(|item| {
                    item.get("model")
                        .or_else(|| item.get("id"))
                        .and_then(Value::as_str)
                        == Some(model)
                })
            });
        let mut supported_models = BTreeSet::new();
        if model_supported {
            supported_models.insert(model.to_owned());
        }
        let capabilities = SubscriptionCapabilities {
            subscription_authenticated: true,
            api_key_authenticated: false,
            strict_structured_output: true,
            resumable_threads: true,
            usage_reporting: !rate_limits.is_null(),
            supported_models,
        };
        if !model_supported {
            return Err(ProviderError::IdentityMismatch);
        }
        let implementation_hash = Hash256::digest(include_bytes!("app_server.rs"));
        let identity = ProviderIdentity {
            transport: "app-server".into(),
            implementation_hash,
            binary_hash,
            protocol_hash: Hash256::digest(PROTOCOL_SNAPSHOT.as_bytes()),
            model: model.to_owned(),
            reasoning: reasoning.to_owned(),
            subscription_account_hash: account.stable_hash,
        };
        let _version_hash = Hash256::digest(version.trim().as_bytes());
        let checkpoint_root = safe_cwd.join("provider-checkpoints");
        fs::create_dir_all(&checkpoint_root)?;
        reject_symlink_descendants(&checkpoint_root)?;
        set_owner_only_directory(&checkpoint_root)?;
        let execution_root = std::env::temp_dir()
            .join("dsl-campaign-rig-app-server")
            .join(identity.canonical_hash().to_string());
        fs::create_dir_all(&execution_root)?;
        set_owner_only_directory(&execution_root)?;
        Ok(Self {
            session: Mutex::new(session),
            identity,
            capabilities,
            safe_cwd: execution_root.canonicalize()?,
            checkpoint_root,
        })
    }

    fn checkpoint_path(&self, request_hash: Hash256) -> PathBuf {
        self.checkpoint_root.join(format!("{request_hash}.json"))
    }

    fn read_checkpoint(
        &self,
        request_hash: Hash256,
    ) -> Result<Option<TransportCheckpoint>, ProviderError> {
        let path = self.checkpoint_path(request_hash);
        reject_symlink_path(&path)?;
        match fs::read(path) {
            Ok(bytes) => Ok(Some(serde_json::from_slice(&bytes)?)),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error.into()),
        }
    }

    fn write_checkpoint(
        &self,
        request_hash: Hash256,
        checkpoint: &TransportCheckpoint,
    ) -> Result<(), ProviderError> {
        let final_path = self.checkpoint_path(request_hash);
        let temporary = self
            .checkpoint_root
            .join(format!(".{request_hash}.{}.tmp", uuid::Uuid::new_v4(),));
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        set_owner_only_file(&file)?;
        file.write_all(&serde_json::to_vec(checkpoint)?)?;
        file.sync_all()?;
        fs::rename(&temporary, final_path)?;
        sync_directory(&self.checkpoint_root)?;
        Ok(())
    }

    fn remove_checkpoint(&self, request_hash: Hash256) -> Result<(), ProviderError> {
        match fs::remove_file(self.checkpoint_path(request_hash)) {
            Ok(()) => {
                sync_directory(&self.checkpoint_root)?;
                Ok(())
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error.into()),
        }
    }

    async fn wait_for_turn(
        &self,
        session: &mut RpcSession,
        checkpoint: &mut AppServerCheckpoint,
        request_hash: Hash256,
        turn_id: &str,
    ) -> Result<(Value, UsageSample), ProviderError> {
        loop {
            let message = session.read_message().await?;
            if message.id.is_some() && message.method.is_some() {
                let response = json!({
                    "jsonrpc": "2.0",
                    "id": message.id,
                    "error": {"code": -32601, "message": "capability denied"}
                });
                session.write_json(&response).await?;
                continue;
            }
            if message.method.as_deref() == Some("thread/tokenUsage/updated") {
                let params = message.params.ok_or(ProviderError::ProtocolMismatch)?;
                if params.get("threadId").and_then(Value::as_str)
                    == Some(checkpoint.thread_id.as_str())
                    && params.get("turnId").and_then(Value::as_str) == Some(turn_id)
                {
                    let last = params.pointer("/tokenUsage/last");
                    let usage = UsageSample {
                        available: last.is_some_and(|value| {
                            [
                                "inputTokens",
                                "cachedInputTokens",
                                "outputTokens",
                                "reasoningOutputTokens",
                            ]
                            .into_iter()
                            .all(|field| token_count(value, field).is_some())
                        }),
                        input_tokens: last
                            .and_then(|value| token_count(value, "inputTokens"))
                            .unwrap_or(0),
                        cached_tokens: last
                            .and_then(|value| token_count(value, "cachedInputTokens"))
                            .unwrap_or(0),
                        output_tokens: last
                            .and_then(|value| token_count(value, "outputTokens"))
                            .unwrap_or(0),
                        reasoning_tokens: last
                            .and_then(|value| token_count(value, "reasoningOutputTokens"))
                            .unwrap_or(0),
                        quota_snapshot_hash: None,
                    };
                    checkpoint.usage = Some(usage);
                    self.write_checkpoint(
                        request_hash,
                        &TransportCheckpoint {
                            sensitive_bytes: serde_json::to_vec(checkpoint)?,
                            identity_hash: self.identity.canonical_hash(),
                            turn_started: true,
                        },
                    )?;
                }
                continue;
            }
            if message.method.as_deref() != Some("turn/completed") {
                continue;
            }
            let params = message.params.ok_or(ProviderError::ProtocolMismatch)?;
            if params.get("threadId").and_then(Value::as_str) != Some(checkpoint.thread_id.as_str())
            {
                continue;
            }
            let turn = params.get("turn").ok_or(ProviderError::ProtocolMismatch)?;
            if turn.get("id").and_then(Value::as_str) != Some(turn_id) {
                continue;
            }
            let usage = checkpoint.usage.clone().unwrap_or_default();
            let canonical_turn = Self::completed_turn_from_checkpoint(session, checkpoint)
                .await?
                .ok_or(ProviderError::ProtocolMismatch)?;
            return Ok((canonical_turn, usage));
        }
    }

    async fn completed_turn_from_checkpoint(
        session: &mut RpcSession,
        checkpoint: &AppServerCheckpoint,
    ) -> Result<Option<Value>, ProviderError> {
        let thread = session
            .request(
                "thread/read",
                json!({"threadId": checkpoint.thread_id, "includeTurns": true}),
            )
            .await?;
        let turns = thread
            .get("thread")
            .and_then(|value| value.get("turns"))
            .and_then(Value::as_array)
            .ok_or(ProviderError::ProtocolMismatch)?;
        let turn = match checkpoint.turn_id.as_deref() {
            Some(turn_id) => turns
                .iter()
                .find(|turn| turn.get("id").and_then(Value::as_str) == Some(turn_id))
                .ok_or(ProviderError::Unreconciled(None))?,
            None if turns.is_empty() => return Ok(None),
            None if turns.len() == 1 => &turns[0],
            None => return Err(ProviderError::Unreconciled(None)),
        };
        match turn.get("status").and_then(Value::as_str) {
            Some("completed") => Ok(Some(turn.clone())),
            Some("failed" | "interrupted") => Err(ProviderError::TerminalTurnFailed),
            _ => Err(ProviderError::Unreconciled(None)),
        }
    }

    fn completed_turn_response(turn: &Value) -> Result<Value, ProviderError> {
        if contains_tool_item(turn) {
            return Err(ProviderError::CapabilityDenied);
        }
        if turn.get("status").and_then(Value::as_str) != Some("completed") {
            return Err(ProviderError::TerminalTurnFailed);
        }
        let text = extract_agent_message(turn).ok_or(ProviderError::InvalidStructuredOutput)?;
        serde_json::from_str(text).map_err(|_| ProviderError::InvalidStructuredOutput)
    }

    fn finish_turn(
        turn: &Value,
        response: Value,
        checkpoint: TransportCheckpoint,
        usage: UsageSample,
    ) -> TransportExchange {
        TransportExchange {
            response,
            sensitive_checkpoint: Some(checkpoint),
            remote_run_hash: turn
                .get("id")
                .and_then(Value::as_str)
                .map(|id| Hash256::digest(id.as_bytes())),
            usage,
            repaired: false,
        }
    }

    fn classify_terminal_turn(
        &self,
        request_hash: Hash256,
        turn: &Value,
    ) -> Result<Value, ProviderError> {
        match Self::completed_turn_response(turn) {
            Ok(response) => Ok(response),
            Err(error) => {
                self.remove_checkpoint(request_hash)?;
                Err(error)
            }
        }
    }
}

fn tool_free_config() -> Value {
    json!({
        "features": {
            "apps": false,
            "browser_use": false,
            "browser_use_external": false,
            "browser_use_full_cdp_access": false,
            "computer_use": false,
            "multi_agent": false,
            "plugins": false,
            "shell_snapshot": false,
            "shell_tool": false,
            "unified_exec": false,
            "web_search": false
        }
    })
}

#[async_trait]
impl SubscriptionTransport for AppServerTransport {
    fn identity(&self) -> &ProviderIdentity {
        &self.identity
    }

    async fn probe(&self) -> Result<SubscriptionCapabilities, ProviderError> {
        Ok(self.capabilities.clone())
    }

    async fn start_or_resume(
        &self,
        request: TransportRequest,
        checkpoint: Option<TransportCheckpoint>,
    ) -> Result<TransportExchange, ProviderError> {
        if request.model != self.identity.model || request.reasoning != self.identity.reasoning {
            return Err(ProviderError::IdentityMismatch);
        }
        let request_hash = Hash256::digest(serde_json::to_vec(&request)?);
        let checkpoint = match checkpoint {
            Some(checkpoint) => Some(checkpoint),
            None => self.read_checkpoint(request_hash)?,
        };
        let mut session = self.session.lock().await;
        let mut checkpoint_data = if let Some(checkpoint) = checkpoint {
            if checkpoint.identity_hash != self.identity.canonical_hash() {
                return Err(ProviderError::IdentityMismatch);
            }
            let parsed: AppServerCheckpoint = serde_json::from_slice(&checkpoint.sensitive_bytes)?;
            if parsed.request_hash != request_hash {
                return Err(ProviderError::IdentityMismatch);
            }
            let resumed = session
                .request(
                    "thread/resume",
                    json!({
                        "threadId": parsed.thread_id,
                        "model": request.model,
                        "cwd": self.safe_cwd,
                        "approvalPolicy": "on-request",
                        "sandbox": "read-only",
                        "baseInstructions": request.prompt,
                        "developerInstructions": "Return only one JSON value matching the supplied output schema. Tools are disabled.",
                        "config": tool_free_config()
                    }),
                )
                .await?;
            if resumed.get("model").and_then(Value::as_str) != Some(self.identity.model.as_str())
                || resumed
                    .get("thread")
                    .and_then(|thread| thread.get("id"))
                    .and_then(Value::as_str)
                    != Some(parsed.thread_id.as_str())
            {
                return Err(ProviderError::IdentityMismatch);
            }
            if checkpoint.turn_started {
                match Self::completed_turn_from_checkpoint(&mut session, &parsed).await {
                    Ok(Some(turn)) => {
                        let usage = parsed.usage.clone().unwrap_or_default();
                        let response = self.classify_terminal_turn(request_hash, &turn)?;
                        return Ok(Self::finish_turn(&turn, response, checkpoint, usage));
                    }
                    Ok(None) => {}
                    Err(ProviderError::TerminalTurnFailed) => {
                        self.remove_checkpoint(request_hash)?;
                        return Err(ProviderError::TerminalTurnFailed);
                    }
                    Err(_) => {
                        return Err(ProviderError::Unreconciled(Some(checkpoint)));
                    }
                }
            }
            parsed
        } else {
            let started = session
                .request(
                    "thread/start",
                    json!({
                        "model": request.model,
                        "cwd": self.safe_cwd,
                        "approvalPolicy": "on-request",
                        "sandbox": "read-only",
                        "ephemeral": false,
                        "baseInstructions": request.prompt,
                        "developerInstructions": "Return only one JSON value matching the supplied output schema. Tools are disabled.",
                        "config": tool_free_config()
                    }),
                )
                .await?;
            if started.get("model").and_then(Value::as_str) != Some(self.identity.model.as_str()) {
                return Err(ProviderError::IdentityMismatch);
            }
            let checkpoint_data = AppServerCheckpoint {
                thread_id: started
                    .get("thread")
                    .and_then(|thread| thread.get("id"))
                    .and_then(Value::as_str)
                    .ok_or(ProviderError::ProtocolMismatch)?
                    .to_owned(),
                turn_id: None,
                request_hash,
                usage: None,
            };
            self.write_checkpoint(
                request_hash,
                &TransportCheckpoint {
                    sensitive_bytes: serde_json::to_vec(&checkpoint_data)?,
                    identity_hash: self.identity.canonical_hash(),
                    turn_started: false,
                },
            )?;
            checkpoint_data
        };
        let input = serde_json::to_string(&request.input)?;
        let uncertain_checkpoint = TransportCheckpoint {
            sensitive_bytes: serde_json::to_vec(&checkpoint_data)?,
            identity_hash: self.identity.canonical_hash(),
            turn_started: true,
        };
        self.write_checkpoint(request_hash, &uncertain_checkpoint)?;
        let started_turn = session
            .request(
                "turn/start",
                json!({
                    "threadId": checkpoint_data.thread_id,
                    "input": [{"type": "text", "text": input}],
                    "model": request.model,
                    "effort": request.reasoning,
                    "outputSchema": request.output_schema,
                    "approvalPolicy": "never"
                }),
            )
            .await
            .map_err(|error| match error {
                ProviderError::ProcessEnded | ProviderError::Io(_) | ProviderError::Timeout => {
                    ProviderError::Unreconciled(Some(uncertain_checkpoint.clone()))
                }
                other => other,
            })?;
        let turn_id = started_turn
            .get("turn")
            .and_then(|turn| turn.get("id"))
            .and_then(Value::as_str)
            .ok_or(ProviderError::ProtocolMismatch)?
            .to_owned();
        checkpoint_data.turn_id = Some(turn_id.clone());
        let durable_checkpoint = TransportCheckpoint {
            sensitive_bytes: serde_json::to_vec(&checkpoint_data)?,
            identity_hash: self.identity.canonical_hash(),
            turn_started: true,
        };
        self.write_checkpoint(request_hash, &durable_checkpoint)?;
        let wait_result = tokio::time::timeout(
            std::time::Duration::from_secs(900),
            self.wait_for_turn(&mut session, &mut checkpoint_data, request_hash, &turn_id),
        )
        .await
        .map_err(|_| ProviderError::Unreconciled(Some(durable_checkpoint.clone())))?;
        let (turn, mut usage) = match wait_result {
            Ok(result) => result,
            Err(ProviderError::TerminalTurnFailed) => {
                self.remove_checkpoint(request_hash)?;
                return Err(ProviderError::TerminalTurnFailed);
            }
            Err(_) => return Err(ProviderError::Unreconciled(Some(durable_checkpoint))),
        };
        let response = self.classify_terminal_turn(request_hash, &turn)?;
        let rate_limits = session
            .request("account/rateLimits/read", Value::Null)
            .await?;
        usage.quota_snapshot_hash = Some(Hash256::digest(serde_json::to_vec(&rate_limits)?));
        checkpoint_data.usage = Some(usage.clone());
        let durable_checkpoint = TransportCheckpoint {
            sensitive_bytes: serde_json::to_vec(&checkpoint_data)?,
            identity_hash: self.identity.canonical_hash(),
            turn_started: true,
        };
        self.write_checkpoint(request_hash, &durable_checkpoint)?;
        Ok(Self::finish_turn(
            &turn,
            response,
            durable_checkpoint,
            usage,
        ))
    }

    async fn usage_sample(&self) -> Result<UsageSample, ProviderError> {
        let mut session = self.session.lock().await;
        let rate_limits = session
            .request("account/rateLimits/read", Value::Null)
            .await?;
        Ok(UsageSample {
            quota_snapshot_hash: Some(Hash256::digest(serde_json::to_vec(&rate_limits)?)),
            ..UsageSample::default()
        })
    }
}
fn token_count(value: &Value, field: &str) -> Option<u64> {
    value.get(field).and_then(Value::as_u64)
}

fn prepare_codex_home(state_root: &Path) -> Result<PathBuf, ProviderError> {
    let runtime_home = state_root.join("codex-home");
    reject_symlink_path(&runtime_home)?;
    fs::create_dir_all(&runtime_home)?;
    set_owner_only_directory(&runtime_home)?;
    let source_home = std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".codex")));
    if let Some(source) = source_home {
        let source = source.join("auth.json");
        if source.is_file() {
            let destination = runtime_home.join("auth.json");
            reject_symlink_path(&destination)?;
            let temporary = runtime_home.join(format!(".auth.{}.tmp", uuid::Uuid::new_v4()));
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temporary)?;
            set_owner_only_file(&file)?;
            file.write_all(&fs::read(source)?)?;
            file.sync_all()?;
            fs::rename(temporary, destination)?;
            sync_directory(&runtime_home)?;
        }
    }
    Ok(runtime_home)
}

fn reject_symlink_path(path: &Path) -> Result<(), ProviderError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => Err(ProviderError::CapabilityDenied),
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

fn reject_symlink_descendants(root: &Path) -> Result<(), ProviderError> {
    for entry in fs::read_dir(root)? {
        let entry = entry?;
        let metadata = fs::symlink_metadata(entry.path())?;
        if metadata.file_type().is_symlink() {
            return Err(ProviderError::CapabilityDenied);
        }
        if metadata.is_dir() {
            reject_symlink_descendants(&entry.path())?;
        }
    }
    Ok(())
}

fn sync_directory(path: &Path) -> Result<(), ProviderError> {
    fs::File::open(path)?.sync_all()?;
    Ok(())
}

#[cfg(unix)]
fn set_owner_only_directory(path: &Path) -> Result<(), ProviderError> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    Ok(())
}

#[cfg(not(unix))]
fn set_owner_only_directory(_path: &Path) -> Result<(), ProviderError> {
    Ok(())
}

#[cfg(unix)]
fn set_owner_only_file(file: &fs::File) -> Result<(), ProviderError> {
    use std::os::unix::fs::PermissionsExt;
    file.set_permissions(fs::Permissions::from_mode(0o600))?;
    Ok(())
}

#[cfg(not(unix))]
fn set_owner_only_file(_file: &fs::File) -> Result<(), ProviderError> {
    Ok(())
}
