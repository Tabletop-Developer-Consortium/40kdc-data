use std::{
    collections::{BTreeMap, BTreeSet},
    ffi::OsString,
    fs,
    path::{Path, PathBuf},
    process::Command,
    sync::atomic::{AtomicUsize, Ordering},
    time::Duration,
};

use campaign_domain::{ArtifactKind, Hash256, Sensitivity};
use campaign_executors::{
    ApplyPlan, Capability, CapabilityGrant, CommandContract, ExecutorError, JjClient,
    PathOperation, SensitiveCorpus, apply_exact_plan, hash_file, run_fixed,
};
use campaign_store::CampaignStore;

static NEXT_TEMP_ID: AtomicUsize = AtomicUsize::new(0);

struct TemporaryRoot(PathBuf);

impl TemporaryRoot {
    fn new(label: &str) -> Self {
        let path = std::env::temp_dir().join(format!(
            "dsl-campaign-rig-security-{label}-{}-{}",
            std::process::id(),
            NEXT_TEMP_ID.fetch_add(1, Ordering::Relaxed),
        ));
        fs::create_dir(&path).expect("create isolated test root");
        Self(path)
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TemporaryRoot {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn error_is(error: ExecutorError, expected: fn(&ExecutorError) -> bool) {
    assert!(expected(&error), "unexpected error: {error}");
}

fn is_capability_denied(error: &ExecutorError) -> bool {
    matches!(error, ExecutorError::CapabilityDenied(_))
}

fn is_command_not_allowed(error: &ExecutorError) -> bool {
    matches!(error, ExecutorError::CommandNotAllowed)
}

fn is_identity_mismatch(error: &ExecutorError) -> bool {
    matches!(error, ExecutorError::IdentityMismatch)
}

fn is_unexpected_path(error: &ExecutorError) -> bool {
    matches!(error, ExecutorError::UnexpectedPath)
}

fn is_jj_mismatch(error: &ExecutorError) -> bool {
    matches!(error, ExecutorError::JjMismatch)
}

#[test]
fn capability_grants_deny_mutation_and_ungranted_processes() {
    let grants = CapabilityGrant::read_only();

    error_is(
        grants
            .require(Capability::ApplyExactPlan)
            .expect_err("mutation must need an explicit grant"),
        is_capability_denied,
    );
    error_is(
        CapabilityGrant::default()
            .require(Capability::RunValidator)
            .expect_err("process capability must be explicit"),
        is_capability_denied,
    );
}

#[test]
fn command_contract_scrubs_unlisted_environment_and_rejects_unknown_executable() {
    let root = TemporaryRoot::new("process");
    let executable = which::which("env").expect("env executable available for integration tests");
    let mut environment = BTreeMap::new();
    environment.insert(OsString::from("PATH"), OsString::from("/usr/bin:/bin"));
    environment.insert(OsString::from("LANG"), OsString::from("rig-test-locale"));
    environment.insert(
        OsString::from("RIG_PRIVATE_TOKEN"),
        OsString::from("must-not-reach-child"),
    );
    let contract = CommandContract {
        executable: "env".into(),
        argv: Vec::new(),
        cwd: root
            .path()
            .canonicalize()
            .expect("canonical temporary root"),
        required_capability: Capability::RunValidator,
        timeout: Duration::from_secs(2),
        output_limit: 16 * 1024,
        binary_hash: hash_file(&executable).expect("hash env executable"),
        allow_jj_write: false,
    };

    let result = run_fixed(
        &CapabilityGrant::from_capabilities([Capability::RunValidator]),
        &contract,
        &environment,
    )
    .expect("fixed command succeeds");
    let output = String::from_utf8(result.stdout).expect("env output is UTF-8");
    assert!(output.lines().any(|line| line == "LANG=rig-test-locale"));
    assert!(!output.contains("RIG_PRIVATE_TOKEN"));
    assert!(!output.contains("must-not-reach-child"));

    let argv_bound = CommandContract {
        argv: vec!["-i".into()],
        ..contract.clone()
    };
    let argv_result = run_fixed(
        &CapabilityGrant::from_capabilities([Capability::RunValidator]),
        &argv_bound,
        &environment,
    )
    .expect("explicit contract argv succeeds");
    assert_ne!(
        result.command_hash, argv_result.command_hash,
        "command identity must bind argv"
    );
    assert!(
        !String::from_utf8(argv_result.stdout)
            .expect("env output is UTF-8")
            .contains("LANG=")
    );

    let mut alternate_environment = environment.clone();
    alternate_environment.insert(OsString::from("LANG"), OsString::from("alternate-locale"));
    let environment_result = run_fixed(
        &CapabilityGrant::from_capabilities([Capability::RunValidator]),
        &contract,
        &alternate_environment,
    )
    .expect("alternate bound environment succeeds");
    assert_ne!(
        result.command_hash, environment_result.command_hash,
        "command identity must bind inherited tool-resolution environment"
    );

    let unknown = CommandContract {
        executable: "rig-not-an-allowlisted-command".into(),
        ..contract
    };
    error_is(
        run_fixed(
            &CapabilityGrant::from_capabilities([Capability::RunValidator]),
            &unknown,
            &environment,
        )
        .expect_err("unrecognized executable must not run"),
        is_command_not_allowed,
    );
}

#[cfg(target_os = "macos")]
#[test]
fn preflight_contract_cannot_read_operator_credentials() {
    use std::os::unix::fs::PermissionsExt;

    let repository = TemporaryRoot::new("sandbox-repository");
    let operator_home = TemporaryRoot::new("sandbox-home");
    let executable = repository.path().join("just");
    fs::write(
        &executable,
        "#!/bin/sh\ncat \"$HOME/.codex/auth.json\" 2>/dev/null || true\ncat \"$HOME/.local/share/app/token\" 2>/dev/null || true\nprintf sandbox-ran\n",
    )
    .expect("write fake just");
    let mut permissions = fs::metadata(&executable)
        .expect("fake just metadata")
        .permissions();
    permissions.set_mode(0o700);
    fs::set_permissions(&executable, permissions).expect("make fake just executable");
    fs::create_dir_all(operator_home.path().join(".codex")).expect("create credential directory");
    fs::write(
        operator_home.path().join(".codex/auth.json"),
        "fabricated-secret",
    )
    .expect("write fabricated credential");
    fs::create_dir_all(operator_home.path().join(".local/share/app"))
        .expect("create local application state");
    fs::write(
        operator_home.path().join(".local/share/app/token"),
        "fabricated-local-secret",
    )
    .expect("write local application secret");
    let contract = CommandContract {
        executable: executable.to_string_lossy().into_owned(),
        argv: vec!["preflight".into()],
        cwd: repository
            .path()
            .canonicalize()
            .expect("canonical repository"),
        required_capability: Capability::RunValidator,
        timeout: Duration::from_secs(2),
        output_limit: 16 * 1024,
        binary_hash: hash_file(&executable).expect("hash fake just"),
        allow_jj_write: false,
    };
    let environment = BTreeMap::from([
        (OsString::from("PATH"), OsString::from("/usr/bin:/bin")),
        (
            OsString::from("HOME"),
            operator_home.path().as_os_str().to_owned(),
        ),
    ]);

    let result = campaign_executors::run_observed(
        &CapabilityGrant::from_capabilities([Capability::RunValidator]),
        &contract,
        &environment,
    )
    .expect("sandboxed command runs");
    assert_eq!(
        result.exit_code,
        0,
        "sandbox stderr: {}",
        String::from_utf8_lossy(&result.stderr)
    );
    assert_eq!(result.stdout, b"sandbox-ran");
}

#[cfg(target_os = "macos")]
#[test]
fn preflight_contract_reads_cloned_dependencies_without_mutating_them() {
    use std::os::unix::fs::PermissionsExt;

    let repository = TemporaryRoot::new("sandbox-snapshot");
    let operator_home = TemporaryRoot::new("sandbox-snapshot-home");
    let dependency_root = repository.path().join("node_modules");
    fs::create_dir(&dependency_root).expect("create cloned dependency root");
    fs::write(dependency_root.join("marker"), b"dependency-visible")
        .expect("write dependency marker");
    fs::create_dir(repository.path().join(".jj")).expect("create snapshot Jj metadata");
    let executable = repository.path().join("just");
    fs::write(
        &executable,
        "#!/bin/sh\ncat node_modules/marker\nif printf tampered >node_modules/marker 2>/dev/null; then exit 9; fi\ntouch .jj/observed-write\n",
    )
    .expect("write fake just");
    fs::set_permissions(&executable, fs::Permissions::from_mode(0o700))
        .expect("make fake just executable");
    let contract = CommandContract {
        executable: executable.to_string_lossy().into_owned(),
        argv: vec!["preflight".into()],
        cwd: repository
            .path()
            .canonicalize()
            .expect("canonical repository"),
        required_capability: Capability::RunValidator,
        timeout: Duration::from_secs(2),
        output_limit: 16 * 1024,
        binary_hash: hash_file(&executable).expect("hash fake just"),
        allow_jj_write: true,
    };
    let environment = BTreeMap::from([
        (OsString::from("PATH"), OsString::from("/usr/bin:/bin")),
        (
            OsString::from("HOME"),
            operator_home.path().as_os_str().to_owned(),
        ),
    ]);

    let result = campaign_executors::run_observed(
        &CapabilityGrant::from_capabilities([Capability::RunValidator]),
        &contract,
        &environment,
    )
    .expect("sandboxed preflight runs");

    assert_eq!(
        result.exit_code,
        0,
        "sandbox stderr: {}",
        String::from_utf8_lossy(&result.stderr)
    );
    assert_eq!(result.stdout, b"dependency-visible");
    assert_eq!(
        fs::read(dependency_root.join("marker")).expect("read cloned dependency marker"),
        b"dependency-visible"
    );
    assert!(repository.path().join(".jj/observed-write").is_file());
}

#[test]
fn command_contract_rejects_binary_identity_or_relative_working_directory() {
    let root = TemporaryRoot::new("command-identity");
    let executable = which::which("env").expect("env executable available for integration tests");
    let contract = CommandContract {
        executable: "env".into(),
        argv: vec!["--ignore-environment".into()],
        cwd: root
            .path()
            .canonicalize()
            .expect("canonical temporary root"),
        required_capability: Capability::RunValidator,
        timeout: Duration::from_secs(2),
        output_limit: 16 * 1024,
        binary_hash: Hash256::ZERO,
        allow_jj_write: false,
    };
    let environment = BTreeMap::new();

    error_is(
        run_fixed(
            &CapabilityGrant::from_capabilities([Capability::RunValidator]),
            &contract,
            &environment,
        )
        .expect_err("wrong binary hash must not execute supplied argv"),
        is_identity_mismatch,
    );
    let relative_cwd = CommandContract {
        cwd: PathBuf::from("."),
        binary_hash: hash_file(&executable).expect("hash env executable"),
        ..contract
    };
    error_is(
        run_fixed(
            &CapabilityGrant::from_capabilities([Capability::RunValidator]),
            &relative_cwd,
            &environment,
        )
        .expect_err("relative working directory must be rejected"),
        is_identity_mismatch,
    );
}

#[test]
fn sensitive_corpus_rejects_exact_and_embedded_source_bytes() {
    let source = b"fabricated-source-fragment-with-at-least-thirty-two-bytes";
    let corpus = SensitiveCorpus::new([source.as_slice()]);

    error_is(
        corpus
            .reject_sensitive_bytes(source)
            .expect_err("exact source bytes must be rejected"),
        |error| matches!(error, ExecutorError::SensitiveContent),
    );
    error_is(
        corpus
            .reject_sensitive_bytes(
                b"generated output fabricated-source-fragment-with-at-least-thirty-two-bytes only",
            )
            .expect_err("embedded source fragment must be rejected"),
        |error| matches!(error, ExecutorError::SensitiveContent),
    );
    corpus
        .reject_sensitive_bytes(b"independent synthetic artifact")
        .expect("independent synthetic bytes remain usable");
}

fn temporary_jj_repo(label: &str) -> (TemporaryRoot, TemporaryRoot, JjClient, CampaignStore) {
    let repository = TemporaryRoot::new(label);
    fs::write(repository.path().join("allowed.txt"), b"before\n").expect("seed tracked file");
    let status = Command::new("jj")
        .arg("git")
        .arg("init")
        .current_dir(repository.path())
        .status()
        .expect("launch jj");
    assert!(status.success(), "initialize isolated jj repository");
    let state = TemporaryRoot::new(&format!("{label}-state"));
    let grants =
        CapabilityGrant::from_capabilities([Capability::ReadJj, Capability::ApplyExactPlan]);
    let client = JjClient::new(repository.path(), grants)
        .expect("construct jj client for isolated repository");
    let store =
        CampaignStore::open(state.path(), repository.path()).expect("open external state store");
    (repository, state, client, store)
}

fn store_artifact(store: &CampaignStore, bytes: &[u8]) -> Hash256 {
    store
        .put_artifact(
            ArtifactKind::ApplyPlan,
            Sensitivity::Deidentified,
            bytes,
            "application/octet-stream",
            "identity",
            &[],
        )
        .expect("store deidentified replacement")
        .artifact_id
}

fn exact_plan(client: &JjClient, replacement: Hash256) -> ApplyPlan {
    ApplyPlan {
        expected_head: client.commit_id("@").expect("observe expected head"),
        allowed_paths: BTreeSet::from(["allowed.txt".into()]),
        operations: vec![PathOperation {
            path: "allowed.txt".into(),
            expected_old_hash: Some(Hash256::digest(b"before\n")),
            new_bytes_artifact: replacement,
        }],
    }
}

#[test]
fn current_archive_copies_only_tracked_regular_files() {
    let (repository, state, client, _store) = temporary_jj_repo("tracked-archive");
    fs::write(repository.path().join(".gitignore"), "ignored.txt\n").expect("write ignore rule");
    fs::write(
        repository.path().join("ignored.txt"),
        b"private runtime bytes\n",
    )
    .expect("write ignored file");
    let spaced_name = " leading and trailing ";
    fs::write(repository.path().join(spaced_name), b"exact path bytes\n")
        .expect("write whitespace-bearing tracked file");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(
            repository.path().join(spaced_name),
            fs::Permissions::from_mode(0o755),
        )
        .expect("make tracked file executable");
    }
    let destination = state.path().join("snapshot");

    client
        .archive_current(&destination)
        .expect("archive current tracked files");

    assert_eq!(
        fs::read(destination.join("allowed.txt")).expect("read archived tracked file"),
        b"before\n"
    );
    assert_eq!(
        fs::read(destination.join(spaced_name)).expect("read exact archived path"),
        b"exact path bytes\n"
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_ne!(
            fs::metadata(destination.join(spaced_name))
                .expect("read archived permissions")
                .permissions()
                .mode()
                & 0o111,
            0
        );
    }
    assert!(destination.join(".gitignore").is_file());
    assert!(!destination.join("ignored.txt").exists());
    assert!(!destination.join(".jj").exists());
}

#[test]
fn archived_tree_initializes_as_a_clean_snapshot_workspace() {
    let (_repository, state, client, _store) = temporary_jj_repo("snapshot-workspace");
    let destination = state.path().join("snapshot");
    client
        .archive_current(&destination)
        .expect("archive current tree");

    let snapshot = JjClient::initialize_snapshot(&destination)
        .expect("initialize isolated snapshot workspace");

    assert!(destination.join(".jj").is_dir());
    assert!(
        snapshot
            .changed_paths("@-", "@")
            .expect("compare snapshot baseline")
            .is_empty()
    );
}

#[cfg(unix)]
#[test]
fn current_archive_rejects_tracked_symlinks_and_removes_partial_output() {
    use std::os::unix::fs::symlink;

    let (repository, state, client, _store) = temporary_jj_repo("archive-symlink");
    let outside = state.path().join("outside.txt");
    fs::write(&outside, b"outside bytes\n").expect("write outside file");
    symlink(&outside, repository.path().join("z-linked.txt")).expect("create tracked symlink");
    let destination = state.path().join("snapshot");

    error_is(
        client
            .archive_current(&destination)
            .expect_err("tracked symlink must not be archived"),
        is_unexpected_path,
    );
    assert!(!destination.exists(), "partial snapshot must be removed");
}

#[cfg(unix)]
#[test]
fn current_archive_never_removes_a_preexisting_dangling_destination() {
    use std::os::unix::fs::symlink;

    let (_repository, state, client, _store) = temporary_jj_repo("archive-destination");
    let destination = state.path().join("snapshot");
    symlink(state.path().join("missing-target"), &destination)
        .expect("create dangling destination");

    error_is(
        client
            .archive_current(&destination)
            .expect_err("preexisting destination must be rejected"),
        is_unexpected_path,
    );
    assert!(
        fs::symlink_metadata(&destination)
            .expect("destination symlink remains")
            .file_type()
            .is_symlink()
    );
}

#[test]
fn exact_apply_rejects_wrong_old_hash_missing_artifact_and_non_allowlisted_paths() {
    let (repository, _state, client, store) = temporary_jj_repo("exact-guards");
    let replacement = store_artifact(&store, b"after\n");
    let corpus = SensitiveCorpus::new(std::iter::empty::<&[u8]>());

    let mut wrong_old_hash = exact_plan(&client, replacement);
    wrong_old_hash.operations[0].expected_old_hash = Some(Hash256::ZERO);
    error_is(
        apply_exact_plan(&client, &store, &wrong_old_hash, &corpus)
            .expect_err("stale old hash must not apply"),
        is_identity_mismatch,
    );

    let mut missing_artifact = exact_plan(&client, Hash256::digest(b"absent synthetic artifact"));
    missing_artifact.operations[0].expected_old_hash = Some(Hash256::digest(b"before\n"));
    error_is(
        apply_exact_plan(&client, &store, &missing_artifact, &corpus)
            .expect_err("unknown artifact must not apply"),
        is_identity_mismatch,
    );

    let mut traversal = exact_plan(&client, replacement);
    traversal.allowed_paths = BTreeSet::from(["../outside.txt".into()]);
    traversal.operations[0].path = "../outside.txt".into();
    error_is(
        apply_exact_plan(&client, &store, &traversal, &corpus)
            .expect_err("path traversal must not apply"),
        is_unexpected_path,
    );

    let mut unlisted = exact_plan(&client, replacement);
    unlisted.operations[0].path = "unlisted.txt".into();
    error_is(
        apply_exact_plan(&client, &store, &unlisted, &corpus)
            .expect_err("path outside allowlist must not apply"),
        is_unexpected_path,
    );
    assert_eq!(
        fs::read(repository.path().join("allowed.txt")).expect("read original file"),
        b"before\n"
    );
}

#[cfg(unix)]
#[test]
fn exact_apply_rejects_symlinked_targets() {
    use std::os::unix::fs::symlink;

    let (repository, _state, client, store) = temporary_jj_repo("symlink-guard");
    let outside = TemporaryRoot::new("symlink-outside");
    let target = outside.path().join("outside.txt");
    fs::write(&target, b"outside-before\n").expect("seed outside file");
    fs::remove_file(repository.path().join("allowed.txt"))
        .expect("replace tracked file with symlink");
    symlink(&target, repository.path().join("allowed.txt")).expect("create symlinked target");
    let replacement = store_artifact(&store, b"after\n");
    let mut plan = exact_plan(&client, replacement);
    plan.operations[0].expected_old_hash = Some(Hash256::digest(b"outside-before\n"));

    error_is(
        apply_exact_plan(
            &client,
            &store,
            &plan,
            &SensitiveCorpus::new(std::iter::empty::<&[u8]>()),
        )
        .expect_err("apply must not follow a repository symlink"),
        is_unexpected_path,
    );
    assert_eq!(
        fs::read(target).expect("read outside target"),
        b"outside-before\n"
    );
}

#[test]
fn apply_requires_a_fresh_observation_before_reapplying_a_plan() {
    let (_repository, _state, client, store) = temporary_jj_repo("reapply-observation");
    let replacement = store_artifact(&store, b"after\n");
    let plan = exact_plan(&client, replacement);
    let corpus = SensitiveCorpus::new(std::iter::empty::<&[u8]>());

    let first =
        apply_exact_plan(&client, &store, &plan, &corpus).expect("apply observed plan once");
    assert_ne!(
        first.before_head, first.after_head,
        "jj must record the applied working-copy observation"
    );
    error_is(
        apply_exact_plan(&client, &store, &plan, &corpus)
            .expect_err("stale plan must require re-observation"),
        is_jj_mismatch,
    );
}
