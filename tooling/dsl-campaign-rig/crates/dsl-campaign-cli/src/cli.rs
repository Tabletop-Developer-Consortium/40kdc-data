use std::path::PathBuf;

use clap::{Args, Parser, Subcommand, ValueEnum};

#[derive(Debug, Parser)]
#[command(
    name = "dsl-campaign",
    version,
    about = "Crash-safe contributor DSL campaign harness"
)]
pub struct Cli {
    #[arg(long, env = "DSL_CAMPAIGN_STATE_ROOT")]
    pub state_root: PathBuf,
    #[arg(long, global = true, default_value = ".")]
    pub repo: PathBuf,
    #[command(subcommand)]
    pub command: Command,
}

#[derive(Debug, Subcommand)]
pub enum Command {
    Doctor(DoctorArgs),
    Init,
    Plan(PlanArgs),
    ImportOmp {
        #[arg(long)]
        campaign: String,
        #[arg(long)]
        source: PathBuf,
    },
    Run {
        #[arg(long)]
        campaign: String,
        #[arg(long, value_enum, default_value_t = TransportArg::AppServer)]
        transport: TransportArg,
        #[arg(long)]
        read_only: bool,
        #[arg(long)]
        apply: bool,
        #[arg(long)]
        apply_shapes: bool,
        #[arg(long, requires = "apply_shapes")]
        shape_plan_hash: Option<String>,
    },
    Worker {
        #[arg(long)]
        campaign: String,
        #[arg(long)]
        once: bool,
        #[arg(long)]
        until_idle: bool,
        #[arg(long)]
        apply: bool,
        #[arg(long)]
        apply_shapes: bool,
        #[arg(long, requires = "apply_shapes")]
        shape_plan_hash: Option<String>,
        #[arg(long)]
        publish: bool,
    },
    Status {
        #[arg(long)]
        campaign: String,
        #[arg(long)]
        json: bool,
    },
    Inspect {
        #[arg(long)]
        campaign: String,
        #[arg(long)]
        ability: String,
    },
    Replay {
        #[arg(long)]
        campaign: String,
    },
    Reconcile {
        #[arg(long)]
        outbox: String,
    },
    Benchmark {
        #[arg(long)]
        manifest: PathBuf,
        #[arg(long)]
        omp: PathBuf,
        #[arg(long)]
        app_server: PathBuf,
        #[arg(long)]
        direct: PathBuf,
    },
    CompoundingBenchmark {
        #[arg(long)]
        results: PathBuf,
    },
    Authorize {
        #[command(subcommand)]
        command: AuthorizeCommand,
    },
    Publish(PublishArgs),
    Projection {
        #[command(subcommand)]
        command: ProjectionCommand,
    },
    Registry {
        #[command(subcommand)]
        command: RegistryCommand,
    },
    Privacy {
        #[command(subcommand)]
        command: PrivacyCommand,
    },
    Artifact {
        #[command(subcommand)]
        command: ArtifactCommand,
    },
}

#[derive(Debug, Subcommand)]
pub enum RegistryCommand {
    Seed {
        #[arg(long)]
        roundtrip_report: Option<PathBuf>,
        #[arg(long)]
        raw_store_index: Option<PathBuf>,
        #[arg(long)]
        verification_bundle: Option<PathBuf>,
        #[arg(long)]
        output_dir: Option<PathBuf>,
    },
    Status {
        #[arg(long)]
        revision: Option<String>,
    },
    Candidates {
        #[arg(long, default_value_t = 30)]
        limit: usize,
        #[arg(long)]
        json: bool,
    },
    Retrieve {
        #[arg(long)]
        ability: String,
    },
}

#[derive(Clone, Copy, Debug, ValueEnum)]
pub enum TransportArg {
    AppServer,
    Direct,
}

#[derive(Debug, Args)]
pub struct DoctorArgs {
    #[arg(long, default_value = "gpt-5.6-luna")]
    pub model: String,
    #[arg(long, default_value = "high")]
    pub reasoning: String,
}

#[derive(Debug, Args)]
pub struct PlanArgs {
    #[arg(long, conflicts_with_all = ["campaign", "worklist", "baseline_report"])]
    pub manifest: Option<PathBuf>,
    #[arg(long, requires_all = ["worklist", "baseline_report"])]
    pub campaign: Option<String>,
    #[arg(long, value_delimiter = ',', num_args = 1..)]
    pub worklist: Vec<String>,
    #[arg(long)]
    pub baseline_report: Option<PathBuf>,
    #[arg(long, default_value = "gpt-5.6-luna")]
    pub model: String,
    #[arg(long, default_value = "high")]
    pub reasoning: String,
}

#[derive(Debug, Subcommand)]
pub enum AuthorizeCommand {
    Publish {
        #[arg(long)]
        campaign: String,
        #[arg(long)]
        sealed_head: String,
    },
}

#[derive(Debug, Args)]
pub struct PublishArgs {
    #[arg(long)]
    pub campaign: String,
    #[arg(long)]
    pub sealed_head: String,
    #[arg(long)]
    pub bookmark: String,
    #[arg(long, default_value = "main")]
    pub base: String,
    #[arg(long)]
    pub title: String,
    #[arg(long)]
    pub body_json: PathBuf,
}

#[derive(Debug, Subcommand)]
pub enum ProjectionCommand {
    Rebuild,
}

#[derive(Debug, Subcommand)]
pub enum PrivacyCommand {
    Audit {
        #[arg(long)]
        campaign: String,
    },
}

#[derive(Debug, Subcommand)]
pub enum ArtifactCommand {
    Verify {
        #[arg(long)]
        artifact: String,
    },
}
