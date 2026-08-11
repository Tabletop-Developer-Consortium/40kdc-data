#[cfg(feature = "direct-chatgpt")]
mod enabled {
    use std::{
        fs::{self, OpenOptions},
        io::Write,
        path::{Path, PathBuf},
        sync::Mutex,
    };

    use async_trait::async_trait;
    use campaign_domain::Hash256;
    use rig_core::{
        client::CompletionClient,
        providers::chatgpt::{self, ChatGPTAuth},
    };

    use crate::{
        ProviderError, ProviderIdentity, SubscriptionCapabilities, SubscriptionTransport,
        TransportCheckpoint, TransportExchange, TransportRequest, UsageSample,
        app_server_protocol::PROTOCOL_SNAPSHOT, rig_driver,
    };

    pub struct DirectChatGptTransport {
        auth_file: PathBuf,
        identity: ProviderIdentity,
        cumulative_usage: Mutex<UsageSample>,
        checkpoint_root: PathBuf,
    }

    impl DirectChatGptTransport {
        pub fn new(
            auth_file: &Path,
            state_root: &Path,
            model: &str,
            reasoning: &str,
        ) -> Result<Self, ProviderError> {
            if std::env::var_os("OPENAI_API_KEY").is_some() {
                return Err(ProviderError::ApiKeyForbidden);
            }
            let auth_file = auth_file.canonicalize()?;
            let (access_token, account_id) = subscription_credentials(&auth_file)?;
            let account_hash = Hash256::digest(
                account_id
                    .as_deref()
                    .map(str::as_bytes)
                    .unwrap_or(access_token.as_bytes()),
            );
            let identity = ProviderIdentity {
                transport: "direct-rig-chatgpt".into(),
                implementation_hash: Hash256::digest(include_bytes!("direct_chatgpt.rs")),
                binary_hash: Hash256::digest(b"rig-core-0.41.0:rig-agent-0.41.0"),
                protocol_hash: Hash256::digest(PROTOCOL_SNAPSHOT.as_bytes()),
                model: model.to_owned(),
                reasoning: reasoning.to_owned(),
                subscription_account_hash: account_hash,
            };
            let checkpoint_root = state_root.canonicalize()?.join("provider-checkpoints");
            fs::create_dir_all(&checkpoint_root)?;
            set_owner_only_directory(&checkpoint_root)?;
            Ok(Self {
                auth_file,
                identity,
                cumulative_usage: Mutex::new(UsageSample::default()),
                checkpoint_root,
            })
        }

        fn client(&self) -> Result<chatgpt::Client, ProviderError> {
            let (access_token, account_id) = subscription_credentials(&self.auth_file)?;
            chatgpt::Client::builder()
                .api_key(ChatGPTAuth::AccessToken {
                    access_token,
                    account_id,
                })
                .default_instructions("")
                .originator("dsl-campaign-rig")
                .build()
                .map_err(|_| ProviderError::SubscriptionRequired)
        }

        fn checkpoint_path(&self, request_hash: Hash256) -> PathBuf {
            self.checkpoint_root
                .join(format!("direct-{request_hash}.json"))
        }

        fn read_checkpoint(
            &self,
            request_hash: Hash256,
        ) -> Result<Option<TransportCheckpoint>, ProviderError> {
            match fs::read(self.checkpoint_path(request_hash)) {
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
            let temporary = self.checkpoint_root.join(format!(
                ".direct-{request_hash}.{}.tmp",
                uuid::Uuid::new_v4(),
            ));
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temporary)?;
            set_owner_only_file(&file)?;
            file.write_all(&serde_json::to_vec(checkpoint)?)?;
            file.sync_all()?;
            fs::rename(temporary, final_path)?;
            Ok(())
        }

        fn remove_checkpoint(&self, request_hash: Hash256) -> Result<(), ProviderError> {
            match fs::remove_file(self.checkpoint_path(request_hash)) {
                Ok(()) => Ok(()),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
                Err(error) => Err(error.into()),
            }
        }
    }

    #[async_trait]
    impl SubscriptionTransport for DirectChatGptTransport {
        fn identity(&self) -> &ProviderIdentity {
            &self.identity
        }

        async fn probe(&self) -> Result<SubscriptionCapabilities, ProviderError> {
            let _ = self.client()?;
            Ok(SubscriptionCapabilities {
                subscription_authenticated: true,
                api_key_authenticated: false,
                strict_structured_output: true,
                resumable_threads: true,
                usage_reporting: true,
                supported_models: [self.identity.model.clone()].into_iter().collect(),
            })
        }

        async fn start_or_resume(
            &self,
            request: TransportRequest,
            checkpoint: Option<TransportCheckpoint>,
        ) -> Result<TransportExchange, ProviderError> {
            if request.model != self.identity.model || request.reasoning != self.identity.reasoning
            {
                return Err(ProviderError::IdentityMismatch);
            }
            let request_hash = Hash256::digest(serde_json::to_vec(&request)?);
            let checkpoint = match checkpoint {
                Some(checkpoint) => Some(checkpoint),
                None => self.read_checkpoint(request_hash)?,
            };
            let resumed_run = if let Some(checkpoint) = checkpoint {
                if checkpoint.identity_hash != self.identity.canonical_hash() {
                    return Err(ProviderError::IdentityMismatch);
                }
                if checkpoint.turn_started {
                    return Err(ProviderError::Unreconciled(Some(checkpoint)));
                }
                Some(
                    serde_json::from_slice(&checkpoint.sensitive_bytes)
                        .map_err(|_| ProviderError::IdentityMismatch)?,
                )
            } else {
                None
            };
            let schema: schemars::Schema = serde_json::from_value(request.output_schema.clone())?;
            let model = self.client()?.completion_model(&request.model);
            let input = serde_json::to_string(&request.input)?;
            let result = rig_driver::drive(
                &model,
                input,
                &request.prompt,
                schema,
                &request.reasoning,
                resumed_run,
                |run, turn_started| {
                    self.write_checkpoint(
                        request_hash,
                        &TransportCheckpoint {
                            sensitive_bytes: serde_json::to_vec(run)?,
                            identity_hash: self.identity.canonical_hash(),
                            turn_started,
                        },
                    )
                },
            )
            .await
            .map_err(|error| match error {
                ProviderError::Unreconciled(Some(mut checkpoint)) => {
                    checkpoint.identity_hash = self.identity.canonical_hash();
                    ProviderError::Unreconciled(Some(checkpoint))
                }
                other => other,
            })?;
            self.remove_checkpoint(request_hash)?;
            let response = serde_json::from_str(&result.output)
                .map_err(|_| ProviderError::InvalidStructuredOutput)?;
            {
                let mut cumulative = self
                    .cumulative_usage
                    .lock()
                    .map_err(|_| ProviderError::UsageUnavailable)?;
                cumulative.available = cumulative.available || result.usage.available;
                cumulative.input_tokens = cumulative
                    .input_tokens
                    .saturating_add(result.usage.input_tokens);
                cumulative.cached_tokens = cumulative
                    .cached_tokens
                    .saturating_add(result.usage.cached_tokens);
                cumulative.output_tokens = cumulative
                    .output_tokens
                    .saturating_add(result.usage.output_tokens);
                cumulative.reasoning_tokens = cumulative
                    .reasoning_tokens
                    .saturating_add(result.usage.reasoning_tokens);
            }
            Ok(TransportExchange {
                response,
                sensitive_checkpoint: Some(TransportCheckpoint {
                    sensitive_bytes: result.serialized_run,
                    identity_hash: self.identity.canonical_hash(),
                    turn_started: false,
                }),
                remote_run_hash: None,
                usage: result.usage,
                repaired: false,
            })
        }

        async fn usage_sample(&self) -> Result<UsageSample, ProviderError> {
            self.cumulative_usage
                .lock()
                .map(|usage| usage.clone())
                .map_err(|_| ProviderError::UsageUnavailable)
        }
    }

    fn subscription_credentials(
        auth_file: &Path,
    ) -> Result<(String, Option<String>), ProviderError> {
        let auth: serde_json::Value = serde_json::from_slice(&fs::read(auth_file)?)?;
        let record = auth.get("tokens").unwrap_or(&auth);
        let access_token = record
            .get("access_token")
            .and_then(|value| value.as_str())
            .filter(|value| !value.is_empty())
            .ok_or(ProviderError::SubscriptionRequired)?
            .to_owned();
        let account_id = record
            .get("account_id")
            .and_then(|value| value.as_str())
            .filter(|value| !value.is_empty())
            .map(str::to_owned);
        Ok((access_token, account_id))
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

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn reads_codex_nested_subscription_tokens_without_persisting_a_copy() {
            let root = tempfile::tempdir().unwrap();
            let auth_file = root.path().join("auth.json");
            fs::write(
                &auth_file,
                br#"{"auth_mode":"chatgpt","tokens":{"access_token":"test-access","account_id":"test-account"}}"#,
            )
            .unwrap();
            let credentials = subscription_credentials(&auth_file).unwrap();
            assert_eq!(credentials.0, "test-access");
            assert_eq!(credentials.1.as_deref(), Some("test-account"));
            assert_eq!(fs::read_dir(root.path()).unwrap().count(), 1);
        }

        #[test]
        fn rejects_auth_without_a_subscription_access_token() {
            let root = tempfile::tempdir().unwrap();
            let auth_file = root.path().join("auth.json");
            fs::write(&auth_file, br#"{"auth_mode":"api-key","tokens":{}}"#).unwrap();
            assert!(matches!(
                subscription_credentials(&auth_file),
                Err(ProviderError::SubscriptionRequired)
            ));
        }
    }
}

#[cfg(feature = "direct-chatgpt")]
pub use enabled::DirectChatGptTransport;

#[cfg(not(feature = "direct-chatgpt"))]
pub struct DirectChatGptTransport;

#[cfg(not(feature = "direct-chatgpt"))]
impl DirectChatGptTransport {
    pub fn new(
        _auth_file: &std::path::Path,
        _state_root: &std::path::Path,
        _model: &str,
        _reasoning: &str,
    ) -> Result<Self, crate::ProviderError> {
        Err(crate::ProviderError::DirectUnavailable)
    }
}
