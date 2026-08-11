mod cli;

use std::{
    path::{Path, PathBuf},
    str::FromStr,
    sync::Arc,
};

use anyhow::{Context, Result, bail};
use campaign_domain::{
    AbilityId, AbilityKey, ActorId, ArtifactKind, Budgets, CampaignId, CampaignManifest,
    CausationId, Command as DomainCommand, CommandAction, CommandId, CommandMeta, CorrelationId,
    FactionId, Hash256, IdentitySet, WorkItem,
};
use campaign_engine::{
    CampaignEngine, CampaignNodeExecutor, decide_benchmark, import_omp_evidence, replay_campaign,
    run_until_idle,
};
use campaign_executors::{
    Capability, CapabilityGrant, JjClient, PublicationPlan, SensitiveCorpus, audit_tracked_tree,
    retrieve_source, validate_external_state_root, validate_subscription_environment,
};
use campaign_providers::{
    AppServerTransport, DirectChatGptTransport, PROTOCOL_SNAPSHOT, PROTOCOL_VERSION,
    SubscriptionTransport, TransportRoleAdapter,
};
use campaign_roles::{
    AnnotatedRoleTransport, FallbackRoleTransport, RoleExecutor, RoleTransport, TypedRoleExecutor,
    role_specs,
};
use campaign_store::{CampaignStore, EffectIntent, EffectKind};
use clap::Parser;
use cli::{
    ArtifactCommand, AuthorizeCommand, Cli, Command, PrivacyCommand, ProjectionCommand,
    TransportArg,
};
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use time::OffsetDateTime;
use walkdir::WalkDir;

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();
    let repo = cli.repo.canonicalize().context("repository path")?;
    match cli.command {
        Command::Doctor(args) => doctor(&cli.state_root, &repo, &args.model, &args.reasoning).await,
        Command::Init => {
            validate_external_state_root(&cli.state_root, &repo)?;
            CampaignStore::open(&cli.state_root, &repo)?.verify_schema_version()?;
            audit_tracked_tree(&repo)?;
            println!("initialized external campaign state");
            Ok(())
        }
        Command::Plan(args) => plan(&cli.state_root, &repo, args),
        Command::ImportOmp { campaign, source } => {
            let store = open_store(&cli.state_root, &repo)?;
            let campaign = CampaignId::new(campaign)?;
            let report = import_omp_evidence(&store, &source)?;
            let report_hash = Hash256::digest(serde_json::to_vec(&report)?);
            let state = store.load_state(&campaign)?;
            validate_runtime_identity(&repo, state.manifest.as_ref().context("manifest missing")?)?;
            let engine_hash = state
                .manifest
                .as_ref()
                .context("manifest missing")?
                .identities
                .executable_hash;
            execute_action(
                &CampaignEngine::new(store, engine_hash, false),
                &campaign,
                CommandAction::ImportLegacyEvidence { report_hash },
            )
        }
        Command::Run {
            campaign,
            transport,
            read_only,
            apply,
            apply_shapes,
            shape_plan_hash,
        } => {
            if read_only && (apply || apply_shapes) {
                bail!("--read-only conflicts with mutation flags");
            }
            if apply_shapes && !apply {
                bail!("--apply-shapes requires --apply");
            }
            run_campaign(
                &cli.state_root,
                &repo,
                &campaign,
                transport,
                read_only,
                apply,
                apply_shapes,
                parse_optional_hash(shape_plan_hash.as_deref())?,
                false,
                false,
            )
            .await
        }
        Command::Worker {
            campaign,
            once,
            until_idle,
            apply,
            apply_shapes,
            shape_plan_hash,
            publish,
        } => {
            if once == until_idle {
                bail!("choose exactly one of --once or --until-idle");
            }
            if apply_shapes && !apply {
                bail!("--apply-shapes requires --apply");
            }
            run_campaign(
                &cli.state_root,
                &repo,
                &campaign,
                TransportArg::AppServer,
                false,
                apply,
                apply_shapes,
                parse_optional_hash(shape_plan_hash.as_deref())?,
                publish,
                once,
            )
            .await
        }
        Command::Status {
            campaign,
            json: as_json,
        } => {
            let store = open_store(&cli.state_root, &repo)?;
            let state = store.load_state(&CampaignId::new(campaign)?)?;
            if as_json {
                println!("{}", serde_json::to_string_pretty(&state)?);
            } else {
                println!(
                    "campaign={} phase={:?} version={} terminal={}/{}",
                    state
                        .campaign_id
                        .as_ref()
                        .map(ToString::to_string)
                        .unwrap_or_default(),
                    state.phase,
                    state.stream_version,
                    state
                        .abilities
                        .values()
                        .filter(|ability| ability.phase.terminal())
                        .count(),
                    state.abilities.len()
                );
            }
            Ok(())
        }
        Command::Inspect { campaign, ability } => {
            let store = open_store(&cli.state_root, &repo)?;
            let state = store.load_state(&CampaignId::new(campaign)?)?;
            let key = parse_ability_key(&ability)?;
            let aggregate = state
                .abilities
                .get(&key)
                .context("ability is not in campaign")?;
            println!("{}", serde_json::to_string_pretty(aggregate)?);
            Ok(())
        }
        Command::Replay { campaign } => {
            let store = open_store(&cli.state_root, &repo)?;
            println!(
                "{}",
                serde_json::to_string_pretty(&replay_campaign(
                    &store,
                    &CampaignId::new(campaign)?
                )?)?
            );
            Ok(())
        }
        Command::Reconcile { outbox } => {
            let store = open_store(&cli.state_root, &repo)?;
            let idempotency_key = store.outbox_key_for_reference(&outbox)?;
            if let Some(receipt) = store.reconcile_effect_receipt(&idempotency_key)? {
                println!("{}", serde_json::to_string_pretty(&receipt)?);
            } else {
                bail!(
                    "effect has no durable receipt and remains unreconciled; inspect external state with its typed reconciler before any retry"
                );
            }
            Ok(())
        }
        Command::Benchmark {
            manifest,
            omp,
            app_server,
            direct,
        } => {
            let manifest = read_json(&manifest)?;
            let omp = read_json(&omp)?;
            let app_server = read_json(&app_server)?;
            let direct = read_json(&direct)?;
            println!(
                "{}",
                serde_json::to_string_pretty(&decide_benchmark(
                    &manifest,
                    &omp,
                    &app_server,
                    &direct
                )?)?
            );
            Ok(())
        }
        Command::Authorize {
            command:
                AuthorizeCommand::Publish {
                    campaign,
                    sealed_head,
                },
        } => execute_simple(
            &cli.state_root,
            &repo,
            &campaign,
            CommandAction::AuthorizePublication { sealed_head },
        ),
        Command::Publish(args) => publish(&cli.state_root, &repo, args),
        Command::Projection {
            command: ProjectionCommand::Rebuild,
        } => {
            let count = open_store(&cli.state_root, &repo)?.rebuild_projections()?;
            println!("rebuilt {count} campaign projections");
            Ok(())
        }
        Command::Privacy {
            command: PrivacyCommand::Audit { campaign },
        } => {
            let store = open_store(&cli.state_root, &repo)?;
            let _ = store.load_state(&CampaignId::new(campaign)?)?;
            validate_external_state_root(&cli.state_root, &repo)?;
            audit_tracked_tree(&repo)?;
            validate_subscription_environment()?;
            println!("privacy audit passed");
            Ok(())
        }
        Command::Artifact {
            command: ArtifactCommand::Verify { artifact },
        } => {
            let store = open_store(&cli.state_root, &repo)?;
            let hash = Hash256::from_str(&artifact)?;
            let bytes = store.read_artifact(hash)?;
            if Hash256::digest(&bytes) != hash {
                bail!("artifact hash mismatch");
            }
            println!("verified {} bytes", bytes.len());
            Ok(())
        }
    }
}

async fn doctor(state_root: &Path, repo: &Path, model: &str, reasoning: &str) -> Result<()> {
    validate_external_state_root(state_root, repo)?;
    validate_subscription_environment()?;
    audit_tracked_tree(repo)?;
    CampaignStore::open(state_root, repo)?.verify_schema_version()?;
    let specs = role_specs()?;
    if specs
        .iter()
        .any(|spec| spec.model != model || spec.reasoning != reasoning)
    {
        bail!("requested provider identity differs from the frozen role manifest");
    }
    let codex = which::which("codex")?;
    let transport = AppServerTransport::connect(&codex, state_root, model, reasoning).await?;
    let capabilities = transport.probe().await?;
    if !capabilities.subscription_authenticated || capabilities.api_key_authenticated {
        bail!("subscription-only provider probe failed");
    }
    println!(
        "doctor passed: {} role contracts, app-server subscription authenticated",
        specs.len()
    );
    Ok(())
}

fn plan(state_root: &Path, repo: &Path, args: cli::PlanArgs) -> Result<()> {
    let (manifest, baseline) = if let Some(path) = args.manifest {
        let manifest: CampaignManifest = read_json(&path)?;
        let baseline = find_baseline_report(repo, manifest.baseline_report_hash)?;
        (manifest, baseline)
    } else {
        let campaign = args
            .campaign
            .context("--campaign is required without --manifest")?;
        let baseline_path = args
            .baseline_report
            .context("--baseline-report is required without --manifest")?;
        let baseline = std::fs::read(&baseline_path)?;
        let manifest = build_manifest(
            repo,
            CampaignId::new(campaign)?,
            &args.worklist,
            &baseline,
            &args.model,
            &args.reasoning,
        )?;
        (manifest, baseline)
    };
    manifest.validate()?;
    validate_runtime_identity(repo, &manifest)?;
    let canonical_repo = repo.canonicalize()?;
    if Hash256::digest(canonical_repo.to_string_lossy().as_bytes())
        != manifest.repository_canonical_path_hash
    {
        bail!("manifest repository identity does not match --repo");
    }
    let jj = JjClient::new(
        repo,
        CapabilityGrant::from_capabilities([Capability::ReadJj]),
    )?;
    if jj.commit_id("@")? != manifest.base_commit_id {
        bail!("working-copy commit does not match manifest base commit");
    }
    let raw_store = repo
        .parent()
        .context("repository has no parent")?
        .join("40kdc-abilities");
    for item in &manifest.ordered_worklist {
        let source = retrieve_source(
            &CapabilityGrant::from_capabilities([Capability::ReadRawStore]),
            &raw_store,
            &item.key,
        )?;
        if source.source_hash != item.source_hash {
            bail!("source hash drift for {}", item.key);
        }
        let path = repo.join(format!(
            "data/enrichment/{}/abilities.json",
            item.key.faction_id
        ));
        let entries: Vec<Value> = serde_json::from_slice(&std::fs::read(&path)?)?;
        let entry = entries
            .iter()
            .find(|entry| {
                entry
                    .get("ability_id")
                    .or_else(|| entry.get("id"))
                    .and_then(Value::as_str)
                    == Some(item.key.ability_id.as_str())
            })
            .with_context(|| format!("ability DSL missing for {}", item.key))?;
        if Hash256::digest(serde_json::to_vec(entry)?) != item.baseline_dsl_hash {
            bail!("baseline DSL hash drift for {}", item.key);
        }
    }
    if Hash256::digest(&baseline) != manifest.baseline_report_hash {
        bail!("baseline report hash drift");
    }
    let baseline_value: Value = serde_json::from_slice(&baseline)?;
    let baseline_rows = baseline_value
        .get("abilities")
        .and_then(Value::as_array)
        .context("baseline report has no abilities array")?;
    if Hash256::digest(serde_json::to_vec(baseline_rows)?) != manifest.baseline_rows_hash {
        bail!("baseline row hash drift");
    }
    let campaign_id = manifest.campaign_id.clone();
    let engine_hash = manifest.identities.executable_hash;
    let store = open_store(state_root, repo)?;
    let stored = store.put_artifact(
        ArtifactKind::RescoreReport,
        campaign_domain::Sensitivity::Sensitive,
        &baseline,
        "application/json",
        "source-bytes",
        &[],
    )?;
    if stored.artifact_id != manifest.baseline_report_hash {
        bail!("baseline report CAS identity mismatch");
    }
    let engine = CampaignEngine::new(store, engine_hash, false);
    execute_action(&engine, &campaign_id, CommandAction::CreateCampaign)?;
    execute_action(
        &engine,
        &campaign_id,
        CommandAction::FreezeManifest {
            manifest: manifest.clone(),
        },
    )?;
    execute_action(&engine, &campaign_id, CommandAction::StartCampaign)?;
    let ability_count = manifest.ordered_worklist.len();
    for item in &manifest.ordered_worklist {
        execute_action(
            &engine,
            &campaign_id,
            CommandAction::QueueAbility {
                key: item.key.clone(),
            },
        )?;
    }
    println!("planned {} abilities for {}", ability_count, campaign_id);
    Ok(())
}
fn find_baseline_report(repo: &Path, expected: Hash256) -> Result<Vec<u8>> {
    let reports_root = repo
        .parent()
        .context("repository has no parent")?
        .join("40kdc-embeddings/_reports");
    WalkDir::new(reports_root)
        .max_depth(1)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_file())
        .find_map(|entry| {
            std::fs::read(entry.path())
                .ok()
                .filter(|bytes| Hash256::digest(bytes) == expected)
        })
        .context("frozen baseline report hash is not present in the embeddings reports")
}

fn build_manifest(
    repo: &Path,
    campaign_id: CampaignId,
    requested_worklist: &[String],
    baseline: &[u8],
    model: &str,
    reasoning: &str,
) -> Result<CampaignManifest> {
    if requested_worklist.is_empty() {
        bail!("--worklist must contain at least one FACTION/ABILITY");
    }
    let harness_root = repo.join("tooling/dsl-campaign-rig");
    let baseline_value: Value = serde_json::from_slice(baseline)?;
    let rows = baseline_value
        .get("abilities")
        .and_then(Value::as_array)
        .context("baseline report has no abilities array")?;
    let raw_store = repo
        .parent()
        .context("repository has no parent")?
        .join("40kdc-abilities");
    let mut ordered_worklist = Vec::with_capacity(requested_worklist.len());
    for requested in requested_worklist {
        let key = parse_ability_key(requested)?;
        let source = retrieve_source(
            &CapabilityGrant::from_capabilities([Capability::ReadRawStore]),
            &raw_store,
            &key,
        )?;
        let dsl_path = repo.join(format!("data/enrichment/{}/abilities.json", key.faction_id));
        let entries: Vec<Value> = serde_json::from_slice(&std::fs::read(dsl_path)?)?;
        let entry = entries
            .iter()
            .find(|entry| {
                entry
                    .get("ability_id")
                    .or_else(|| entry.get("id"))
                    .and_then(Value::as_str)
                    == Some(key.ability_id.as_str())
            })
            .with_context(|| format!("ability DSL missing for {key}"))?;
        let row = rows
            .iter()
            .find(|row| {
                row.get("faction")
                    .or_else(|| row.get("faction_id"))
                    .and_then(Value::as_str)
                    == Some(key.faction_id.as_str())
                    && row.get("ability_id").and_then(Value::as_str)
                        == Some(key.ability_id.as_str())
            })
            .with_context(|| format!("baseline score missing for {key}"))?;
        let cosine_start = row
            .get("score")
            .and_then(Value::as_f64)
            .with_context(|| format!("baseline score is not numeric for {key}"))?;
        ordered_worklist.push(WorkItem {
            key,
            cosine_start,
            source_hash: source.source_hash,
            baseline_dsl_hash: Hash256::digest(serde_json::to_vec(entry)?),
        });
    }

    let codex = which::which("codex")?;
    let codex_bytes = std::fs::read(&codex)?;
    let version_output = std::process::Command::new(&codex)
        .arg("--version")
        .env_remove("OPENAI_API_KEY")
        .output()?;
    if !version_output.status.success() {
        bail!("codex --version failed");
    }
    let app_server_version = String::from_utf8(version_output.stdout)?.trim().to_owned();
    let lock_bytes = std::fs::read(harness_root.join("Cargo.lock"))?;
    let lock_text = std::str::from_utf8(&lock_bytes)?;
    let rig_version =
        package_version(lock_text, "rig-core").context("rig-core is missing from Cargo.lock")?;
    let specs = role_specs()?;
    if specs
        .iter()
        .any(|spec| spec.model != model || spec.reasoning != reasoning)
    {
        bail!("model/reasoning differs from the frozen role manifest");
    }
    let role_schema_hashes = specs
        .iter()
        .map(|spec| spec.schema_hash)
        .collect::<Vec<_>>();
    let tool_contract_hash = Hash256::digest(serde_json::to_vec(&role_schema_hashes)?);
    let canonical_repo = repo.canonicalize()?;
    let executable_hash = current_executable_hash()?;

    Ok(CampaignManifest {
        campaign_id,
        repository_canonical_path_hash: Hash256::digest(
            canonical_repo.to_string_lossy().as_bytes(),
        ),
        workspace_id: Hash256::digest(canonical_repo.to_string_lossy().as_bytes()).to_string(),
        base_commit_id: JjClient::new(
            repo,
            CapabilityGrant::from_capabilities([Capability::ReadJj]),
        )?
        .commit_id("@")?,
        ordered_worklist,
        baseline_report_hash: Hash256::digest(baseline),
        baseline_rows_hash: Hash256::digest(serde_json::to_vec(rows)?),
        identities: IdentitySet {
            provider_precedence: vec!["app-server".into()],
            allowed_transports: ["app-server".to_owned()].into_iter().collect(),
            model: model.to_owned(),
            reasoning: reasoning.to_owned(),
            rig_version,
            rig_lockfile_hash: Hash256::digest(&lock_bytes),
            app_server_binary_hash: Hash256::digest(&codex_bytes),
            app_server_version,
            app_server_protocol_hash: Hash256::digest(PROTOCOL_SNAPSHOT),
            direct_provider_hash: Some(Hash256::digest(
                b"rig-openai-subscription-provider-v1",
            )),
            prompt_manifest_hash: Hash256::digest(std::fs::read(
                harness_root.join("prompts/manifest.json"),
            )?),
            role_schema_hashes,
            semantic_validator_hash: Hash256::digest(std::fs::read(
                harness_root.join("crates/campaign-roles/src/semantic.rs"),
            )?),
            tool_contract_hash,
            engine_version: env!("CARGO_PKG_VERSION").to_owned(),
            protocol_version: PROTOCOL_VERSION,
            executable_hash,
        },
        budgets: Budgets::default(),
        gate_definitions_hash: Hash256::digest(
            b"just preflight|npm run author:validate-all|roundtrip-full|whole-corpus-diff|six-port-parity",
        ),
        path_policy_hash: Hash256::digest(std::fs::read(
            harness_root.join("config/default.toml"),
        )?),
        privacy_policy_hash: Hash256::digest(std::fs::read(
            harness_root.join("config/redaction-policy.toml"),
        )?),
        parity_areas: [
            "canonical-schema",
            "typescript-describer",
            "rust-describer",
            "python-describer",
            "go-describer",
            "scoring",
        ]
        .into_iter()
        .map(str::to_owned)
        .collect(),
    })
}

fn package_version(lock: &str, package: &str) -> Option<String> {
    lock.split("[[package]]").find_map(|block| {
        let mut name = None;
        let mut version = None;
        for line in block.lines().map(str::trim) {
            if let Some(value) = line.strip_prefix("name = ") {
                name = Some(value.trim_matches('"'));
            } else if let Some(value) = line.strip_prefix("version = ") {
                version = Some(value.trim_matches('"'));
            }
        }
        (name == Some(package))
            .then(|| version.map(str::to_owned))
            .flatten()
    })
}

fn current_executable_hash() -> Result<Hash256> {
    Ok(Hash256::digest(std::fs::read(std::env::current_exe()?)?))
}

fn validate_runtime_identity(repo: &Path, manifest: &CampaignManifest) -> Result<()> {
    let harness_root = repo.join("tooling/dsl-campaign-rig");
    let identities = &manifest.identities;
    if current_executable_hash()? != identities.executable_hash {
        bail!("campaign executable hash drift");
    }
    let lock_bytes = std::fs::read(harness_root.join("Cargo.lock"))?;
    if Hash256::digest(&lock_bytes) != identities.rig_lockfile_hash
        || package_version(std::str::from_utf8(&lock_bytes)?, "rig-core").as_deref()
            != Some(identities.rig_version.as_str())
    {
        bail!("frozen Rig dependency identity drift");
    }
    let codex = which::which("codex")?;
    if Hash256::digest(std::fs::read(&codex)?) != identities.app_server_binary_hash {
        bail!("Codex App Server binary hash drift");
    }
    let version = std::process::Command::new(codex)
        .arg("--version")
        .env_remove("OPENAI_API_KEY")
        .output()?;
    if !version.status.success()
        || String::from_utf8(version.stdout)?.trim() != identities.app_server_version
    {
        bail!("Codex App Server version drift");
    }
    if Hash256::digest(PROTOCOL_SNAPSHOT) != identities.app_server_protocol_hash
        || identities.protocol_version != PROTOCOL_VERSION
    {
        bail!("App Server protocol drift");
    }
    let specs = role_specs()?;
    let schema_hashes = specs
        .iter()
        .map(|spec| spec.schema_hash)
        .collect::<Vec<_>>();
    if specs
        .iter()
        .any(|spec| spec.model != identities.model || spec.reasoning != identities.reasoning)
        || schema_hashes != identities.role_schema_hashes
        || Hash256::digest(serde_json::to_vec(&schema_hashes)?) != identities.tool_contract_hash
    {
        bail!("frozen role contract drift");
    }
    if Hash256::digest(std::fs::read(harness_root.join("prompts/manifest.json"))?)
        != identities.prompt_manifest_hash
        || Hash256::digest(std::fs::read(
            harness_root.join("crates/campaign-roles/src/semantic.rs"),
        )?) != identities.semantic_validator_hash
        || Hash256::digest(std::fs::read(harness_root.join("config/default.toml"))?)
            != manifest.path_policy_hash
        || Hash256::digest(std::fs::read(
            harness_root.join("config/redaction-policy.toml"),
        )?) != manifest.privacy_policy_hash
        || Hash256::digest(
            b"just preflight|npm run author:validate-all|roundtrip-full|whole-corpus-diff|six-port-parity",
        ) != manifest.gate_definitions_hash
        || identities.direct_provider_hash
            != Some(Hash256::digest(b"rig-openai-subscription-provider-v1"))
    {
        bail!("frozen campaign contract drift");
    }
    Ok(())
}

async fn run_campaign(
    state_root: &Path,
    repo: &Path,
    campaign: &str,
    transport: TransportArg,
    read_only: bool,
    allow_apply: bool,
    allow_shape_application: bool,
    authorized_shape_plan_hash: Option<Hash256>,
    allow_publication: bool,
    once: bool,
) -> Result<()> {
    validate_subscription_environment()?;
    let campaign_id = CampaignId::new(campaign.to_owned())?;
    let store = open_store(state_root, repo)?;
    let state = store.load_state(&campaign_id)?;
    let manifest = state
        .manifest
        .as_ref()
        .context("campaign manifest is not frozen")?;
    validate_runtime_identity(repo, manifest)?;
    if allow_publication && state.phase != campaign_domain::CampaignPhase::Publishing {
        bail!("--publish is valid only after publication has been requested");
    }
    if allow_apply && state.phase != campaign_domain::CampaignPhase::Running {
        bail!("--apply is valid only while a campaign is running");
    }
    let effective_read_only = read_only || !(allow_apply || allow_publication);
    let model = manifest.identities.model.clone();
    let reasoning = manifest.identities.reasoning.clone();
    let engine = CampaignEngine::new(
        store,
        manifest.identities.executable_hash,
        effective_read_only,
    )
    .with_shape_application(allow_shape_application);
    let requested_transport = match transport {
        TransportArg::AppServer => "app-server",
        TransportArg::Direct => "direct",
    };
    if !manifest
        .identities
        .allowed_transports
        .contains(requested_transport)
    {
        bail!("requested transport is not allowed by the frozen manifest");
    }
    let role_transport: Box<dyn RoleTransport> = match transport {
        TransportArg::AppServer => Box::new(
            app_server_adapter(
                state_root,
                &model,
                &reasoning,
                manifest.identities.tool_contract_hash,
            )
            .await?,
        ),
        TransportArg::Direct => {
            if !manifest
                .identities
                .allowed_transports
                .contains("app-server")
            {
                bail!("direct transport requires app-server as a frozen fallback");
            }
            let fallback: Box<dyn RoleTransport> = Box::new(
                app_server_adapter(
                    state_root,
                    &model,
                    &reasoning,
                    manifest.identities.tool_contract_hash,
                )
                .await?,
            );
            match DirectChatGptTransport::new(&codex_auth_file()?, state_root, &model, &reasoning) {
                Ok(direct) => Box::new(FallbackRoleTransport::new(
                    Box::new(TransportRoleAdapter::new(
                        direct,
                        manifest.identities.tool_contract_hash,
                    )?),
                    fallback,
                    "direct-transport-failed",
                )),
                Err(_) => Box::new(AnnotatedRoleTransport::new(
                    fallback,
                    "direct-transport-unavailable",
                )),
            }
        }
    };
    let roles: Arc<dyn RoleExecutor> = Arc::new(TypedRoleExecutor::new(role_transport));
    let raw_store = repo
        .parent()
        .context("repository has no parent")?
        .join("40kdc-abilities");
    let executor = CampaignNodeExecutor::new(
        campaign_id.clone(),
        engine.clone(),
        roles,
        repo,
        raw_store,
        allow_shape_application,
        authorized_shape_plan_hash,
    );
    let summary = run_until_idle(
        &engine,
        &campaign_id,
        &executor,
        "dsl-campaign-cli",
        OffsetDateTime::now_utc().unix_timestamp(),
        if once { 1 } else { 10_000 },
    )
    .await?;
    println!(
        "{}",
        serde_json::to_string_pretty(&json!({
            "executed_work": summary.executed_work,
            "remaining_work": summary.remaining_work,
            "idle": summary.idle,
        }))?
    );
    Ok(())
}

async fn app_server_adapter(
    state_root: &Path,
    model: &str,
    reasoning: &str,
    tool_contract_hash: Hash256,
) -> Result<TransportRoleAdapter<AppServerTransport>> {
    let codex = which::which("codex")?;
    let transport = AppServerTransport::connect(&codex, state_root, model, reasoning).await?;
    Ok(TransportRoleAdapter::new(transport, tool_contract_hash)?)
}

fn codex_auth_file() -> Result<PathBuf> {
    if let Some(home) = std::env::var_os("CODEX_HOME") {
        return Ok(PathBuf::from(home).join("auth.json"));
    }
    let home = std::env::var_os("HOME").context("HOME is not set")?;
    Ok(PathBuf::from(home).join(".codex/auth.json"))
}

fn publish(state_root: &Path, repo: &Path, args: cli::PublishArgs) -> Result<()> {
    let campaign_id = CampaignId::new(args.campaign)?;
    let store = open_store(state_root, repo)?;
    let state = store.load_state(&campaign_id)?;
    if state.publication_authorized_head.as_deref() != Some(args.sealed_head.as_str()) {
        bail!("publication is not authorized for this sealed head");
    }
    validate_runtime_identity(repo, state.manifest.as_ref().context("manifest missing")?)?;
    let body_value: Value = read_json(&args.body_json)?;
    let body = serde_json::to_string_pretty(&body_value)?;
    let raw_store = repo
        .parent()
        .context("repository has no parent")?
        .join("40kdc-abilities");
    let source_bytes = state
        .manifest
        .as_ref()
        .context("manifest missing")?
        .ordered_worklist
        .iter()
        .map(|item| {
            retrieve_source(
                &CapabilityGrant::from_capabilities([Capability::ReadRawStore]),
                &raw_store,
                &item.key,
            )
            .map(|source| source.source_text.into_bytes())
        })
        .collect::<Result<Vec<_>, _>>()?;
    let mut sensitive_bytes = store.sensitive_artifact_bytes()?;
    sensitive_bytes.extend(source_bytes);
    SensitiveCorpus::new(sensitive_bytes.iter().map(Vec::as_slice))
        .reject_sensitive_bytes(body.as_bytes())?;
    let plan = PublicationPlan {
        authorized: true,
        sealed_head: args.sealed_head.clone(),
        bookmark: args.bookmark,
        base_bookmark: args.base,
        title: args.title,
        body_hash: Hash256::digest(body.as_bytes()),
        body,
    };
    let plan_bytes = serde_json::to_vec(&plan)?;
    let plan_artifact = store.put_artifact(
        ArtifactKind::PublicationPlan,
        campaign_domain::Sensitivity::Sensitive,
        &plan_bytes,
        "application/json",
        "serde-json",
        &[state
            .close_verification_hash
            .context("close verification missing")?],
    )?;
    let outbox_id = campaign_domain::OutboxId::new();
    let fencing_token = 0;
    let command = DomainCommand {
        meta: CommandMeta {
            command_id: CommandId::new(),
            campaign_id: campaign_id.clone(),
            expected_stream_version: state.stream_version,
            causation_id: CausationId::new(),
            correlation_id: CorrelationId::new(),
            actor: ActorId::new("dsl-campaign-cli")?,
            expected_manifest_hash: state.manifest_hash,
            expected_engine_hash: state
                .manifest
                .as_ref()
                .context("manifest missing")?
                .identities
                .executable_hash,
            outbox_id: Some(outbox_id),
            fencing_token: Some(fencing_token),
            lease_resource: None,
            lease_owner: None,
        },
        action: CommandAction::RequestPublication {
            sealed_head: args.sealed_head.clone(),
        },
    };
    let effect = EffectIntent {
        outbox_id,
        effect_kind: EffectKind::DraftPr,
        idempotency_key: format!("publish:{}:{}", campaign_id, args.sealed_head),
        request: serde_json::json!({ "plan_artifact_hash": plan_artifact.artifact_id }),
        fencing_token,
        available_at: OffsetDateTime::now_utc().unix_timestamp(),
    };
    CampaignEngine::new(
        store,
        state
            .manifest
            .as_ref()
            .context("manifest missing")?
            .identities
            .executable_hash,
        false,
    )
    .execute_with_effect(&command, &effect)?;
    println!(
        "publication queued for {}; run worker --until-idle",
        args.sealed_head
    );
    Ok(())
}

fn execute_simple(
    state_root: &Path,
    repo: &Path,
    campaign: &str,
    action: CommandAction,
) -> Result<()> {
    let campaign_id = CampaignId::new(campaign.to_owned())?;
    let store = open_store(state_root, repo)?;
    let state = store.load_state(&campaign_id)?;
    let manifest = state.manifest.as_ref().context("manifest missing")?;
    validate_runtime_identity(repo, manifest)?;
    let engine_hash = manifest.identities.executable_hash;
    execute_action(
        &CampaignEngine::new(store, engine_hash, false),
        &campaign_id,
        action,
    )?;
    Ok(())
}

fn execute_action(
    engine: &CampaignEngine,
    campaign_id: &CampaignId,
    action: CommandAction,
) -> Result<()> {
    let state = engine.state(campaign_id)?;
    let command = DomainCommand {
        meta: CommandMeta {
            command_id: CommandId::new(),
            campaign_id: campaign_id.clone(),
            expected_stream_version: state.stream_version,
            causation_id: CausationId::new(),
            correlation_id: CorrelationId::new(),
            actor: ActorId::new("dsl-campaign-cli")?,
            expected_manifest_hash: state.manifest_hash,
            expected_engine_hash: engine.engine_hash(),
            outbox_id: None,
            fencing_token: None,
            lease_resource: None,
            lease_owner: None,
        },
        action,
    };
    engine.execute(&command)?;
    Ok(())
}

fn open_store(state_root: &Path, repo: &Path) -> Result<CampaignStore> {
    Ok(CampaignStore::open(state_root, repo)?)
}

fn parse_ability_key(value: &str) -> Result<AbilityKey> {
    let (faction, ability) = value
        .split_once('/')
        .context("ability must be FACTION/ABILITY")?;
    Ok(AbilityKey::new(
        FactionId::new(faction)?,
        AbilityId::new(ability)?,
    ))
}

fn parse_optional_hash(value: Option<&str>) -> Result<Option<Hash256>> {
    value.map(Hash256::from_str).transpose().map_err(Into::into)
}

fn read_json<T: DeserializeOwned>(path: &Path) -> Result<T> {
    Ok(serde_json::from_slice(&std::fs::read(path)?)?)
}
