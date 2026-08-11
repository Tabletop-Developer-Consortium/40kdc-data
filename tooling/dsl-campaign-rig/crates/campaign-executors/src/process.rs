use std::{
    collections::BTreeMap,
    ffi::OsString,
    io::Read,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    thread,
    time::{Duration, Instant},
};

use campaign_domain::Hash256;

use crate::{Capability, CapabilityGrant, ExecutorError};

#[cfg(unix)]
use std::os::unix::process::CommandExt;
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CommandContract {
    pub executable: String,
    pub argv: Vec<String>,
    pub cwd: PathBuf,
    pub required_capability: Capability,
    pub timeout: Duration,
    pub output_limit: usize,
    pub binary_hash: Hash256,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProcessResult {
    pub exit_code: i32,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub binary_hash: Hash256,
    pub command_hash: Hash256,
}

pub fn run_fixed(
    grants: &CapabilityGrant,
    contract: &CommandContract,
    inherited_environment: &BTreeMap<OsString, OsString>,
) -> Result<ProcessResult, ExecutorError> {
    let result = run_observed(grants, contract, inherited_environment)?;
    if result.exit_code == 0 {
        Ok(result)
    } else {
        Err(ExecutorError::ProcessFailed(result.exit_code))
    }
}

pub fn run_observed(
    grants: &CapabilityGrant,
    contract: &CommandContract,
    inherited_environment: &BTreeMap<OsString, OsString>,
) -> Result<ProcessResult, ExecutorError> {
    grants.require(contract.required_capability)?;
    let executable = which::which(&contract.executable)
        .map_err(|_| ExecutorError::CommandNotAllowed)?
        .canonicalize()?;
    let observed_binary_hash = hash_file(&executable)?;
    if observed_binary_hash != contract.binary_hash || !contract.cwd.is_absolute() {
        return Err(ExecutorError::IdentityMismatch);
    }
    let command_hash = Hash256::digest(serde_json::to_vec(&serde_json::json!({
        "executable": executable,
        "argv": contract.argv,
        "cwd": contract.cwd,
        "binary_hash": contract.binary_hash,
    }))?);
    let temp_parent = if cfg!(target_os = "macos") {
        PathBuf::from("/private/tmp")
    } else {
        std::env::temp_dir()
    };
    let sandbox_temp = tempfile::Builder::new()
        .prefix("dsl-campaign-rig-")
        .tempdir_in(temp_parent)?;
    let mut command = sandboxed_command(
        &executable,
        contract,
        inherited_environment,
        sandbox_temp.path(),
    )?;
    command
        .current_dir(&contract.cwd)
        .env_clear()
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for key in ["PATH", "HOME", "LANG", "LC_ALL"] {
        if let Some(value) = inherited_environment.get(&OsString::from(key)) {
            command.env(key, value);
        }
    }
    command.env("TMPDIR", sandbox_temp.path());
    #[cfg(unix)]
    command.process_group(0);
    let mut child = command.spawn()?;
    let stdout = child.stdout.take().expect("captured stdout");
    let stderr = child.stderr.take().expect("captured stderr");
    let output_limit = contract.output_limit;
    let output_exceeded = Arc::new(AtomicBool::new(false));
    let stdout_exceeded = Arc::clone(&output_exceeded);
    let stdout_reader = thread::spawn(move || {
        let mut bytes = Vec::new();
        stdout
            .take(output_limit as u64 + 1)
            .read_to_end(&mut bytes)?;
        if bytes.len() > output_limit {
            stdout_exceeded.store(true, Ordering::Release);
        }
        Ok::<_, std::io::Error>(bytes)
    });
    let stderr_exceeded = Arc::clone(&output_exceeded);
    let stderr_reader = thread::spawn(move || {
        let mut bytes = Vec::new();
        stderr
            .take(output_limit as u64 + 1)
            .read_to_end(&mut bytes)?;
        if bytes.len() > output_limit {
            stderr_exceeded.store(true, Ordering::Release);
        }
        Ok::<_, std::io::Error>(bytes)
    });
    let started = Instant::now();
    let mut timed_out = false;
    loop {
        if child.try_wait()?.is_some() {
            break;
        }
        if output_exceeded.load(Ordering::Acquire) {
            terminate_process_group(child.id());
            let _ = child.kill();
            break;
        }
        if started.elapsed() >= contract.timeout {
            terminate_process_group(child.id());
            let _ = child.kill();
            timed_out = true;
            break;
        }
        thread::sleep(Duration::from_millis(20));
    }
    let status = child.wait()?;
    let stdout = stdout_reader
        .join()
        .map_err(|_| ExecutorError::ProcessFailed(128))??;
    let stderr = stderr_reader
        .join()
        .map_err(|_| ExecutorError::ProcessFailed(128))??;
    if stdout.len() > contract.output_limit || stderr.len() > contract.output_limit {
        return Err(ExecutorError::OutputLimit);
    }
    Ok(ProcessResult {
        exit_code: if timed_out {
            124
        } else {
            status.code().unwrap_or(128)
        },
        stdout,
        stderr,
        binary_hash: observed_binary_hash,
        command_hash,
    })
}

#[cfg(unix)]
fn terminate_process_group(process_group: u32) {
    let _ = Command::new("/bin/kill")
        .args(["-KILL", &format!("-{process_group}")])
        .env_clear()
        .status();
}

#[cfg(not(unix))]
fn terminate_process_group(_process_group: u32) {}

#[cfg(target_os = "macos")]
fn sandboxed_command(
    executable: &Path,
    contract: &CommandContract,
    inherited_environment: &BTreeMap<OsString, OsString>,
    sandbox_temp: &Path,
) -> Result<Command, ExecutorError> {
    if !protected_just_contract(contract) {
        let mut command = Command::new(executable);
        command.args(&contract.argv);
        return Ok(command);
    }
    let home = inherited_environment
        .get(&OsString::from("HOME"))
        .map(PathBuf::from)
        .ok_or(ExecutorError::CommandNotAllowed)?;
    let cargo_bin = home.join(".cargo/bin");
    let cargo_registry = home.join(".cargo/registry");
    let cargo_git = home.join(".cargo/git");
    let rustup_home = home.join(".rustup");
    let go_modules = home.join("go/pkg/mod");
    let go_build_cache = home.join("Library/Caches/go-build");
    let read_paths = [
        contract.cwd.as_path(),
        Path::new("/System"),
        Path::new("/Library"),
        Path::new("/usr"),
        Path::new("/bin"),
        Path::new("/sbin"),
        Path::new("/opt"),
        Path::new("/private/etc"),
        Path::new("/private/var/db"),
        Path::new("/dev"),
        cargo_bin.as_path(),
        cargo_registry.as_path(),
        cargo_git.as_path(),
        rustup_home.as_path(),
        go_modules.as_path(),
        go_build_cache.as_path(),
        sandbox_temp,
    ];
    let write_paths = [
        contract.cwd.as_path(),
        go_build_cache.as_path(),
        sandbox_temp,
    ];
    let mut denied_read_paths = vec![contract.cwd.join("_private")];
    for entry in std::fs::read_dir(&contract.cwd)? {
        let entry = entry?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        let metadata = std::fs::symlink_metadata(entry.path())?;
        if metadata.file_type().is_symlink()
            || name == ".env"
            || name.starts_with(".env.")
            || name.starts_with("omp-session-")
            || name.ends_with(".pem")
            || name.ends_with(".key")
        {
            denied_read_paths.push(entry.path());
        }
    }
    let denied_read_paths = denied_read_paths
        .iter()
        .map(PathBuf::as_path)
        .collect::<Vec<_>>();
    let profile = format!(
        "(version 1) (deny default) (allow process*) (allow sysctl-read) (allow mach-lookup) \
         (allow file-read* {}) (allow file-write* {}) \
         (deny file-read* {}) \
         (deny file-write* (subpath {private}) (subpath {jj}) (subpath {git}))",
        sandbox_path_rules(&read_paths),
        sandbox_path_rules(&write_paths),
        sandbox_path_rules(&denied_read_paths),
        private = sandbox_literal(&contract.cwd.join("_private")),
        jj = sandbox_literal(&contract.cwd.join(".jj")),
        git = sandbox_literal(&contract.cwd.join(".git")),
    );
    let mut command = Command::new("/usr/bin/sandbox-exec");
    command
        .args(["-p", &profile])
        .arg(executable)
        .args(&contract.argv);
    Ok(command)
}

#[cfg(not(target_os = "macos"))]
fn sandboxed_command(
    executable: &Path,
    contract: &CommandContract,
    _inherited_environment: &BTreeMap<OsString, OsString>,
    _sandbox_temp: &Path,
) -> Result<Command, ExecutorError> {
    if protected_just_contract(contract) {
        return Err(ExecutorError::CommandNotAllowed);
    }
    let mut command = Command::new(executable);
    command.args(&contract.argv);
    Ok(command)
}
fn protected_just_contract(contract: &CommandContract) -> bool {
    contract.executable.ends_with("/just")
        && matches!(contract.argv.as_slice(), [command] if command == "preflight" || command == "regen")
}

#[cfg(target_os = "macos")]
fn sandbox_path_rules(paths: &[&Path]) -> String {
    paths
        .iter()
        .map(|path| {
            let escaped = path
                .to_string_lossy()
                .replace('\\', "\\\\")
                .replace('"', "\\\"");
            format!("(subpath \"{escaped}\")")
        })
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(target_os = "macos")]
fn sandbox_literal(path: &Path) -> String {
    format!(
        "\"{}\"",
        path.display()
            .to_string()
            .replace('\\', "\\\\")
            .replace('"', "\\\"")
    )
}

pub fn hash_file(path: &Path) -> Result<Hash256, ExecutorError> {
    Ok(Hash256::digest(std::fs::read(path)?))
}
