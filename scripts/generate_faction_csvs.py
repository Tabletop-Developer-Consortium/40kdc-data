#!/usr/bin/env python3
"""Generate per-faction CSVs comparing expected vs. actual points costs.

Reads the unit predictions DataFrame saved by the notebook
(scripts/model_output/unit_predictions.pkl) and writes one CSV per faction
to scripts/faction_csvs/.

Usage:
    python3 scripts/generate_faction_csvs.py
"""

import json
import sys
from pathlib import Path

import pandas as pd

SCRIPT_DIR = Path(__file__).resolve().parent
MODEL_OUTPUT = SCRIPT_DIR / "model_output"
CSV_OUTPUT = SCRIPT_DIR / "faction_csvs"

PREDICTIONS_PATH = MODEL_OUTPUT / "unit_predictions.pkl"
METADATA_PATH = MODEL_OUTPUT / "metadata.json"

CSV_COLUMNS = [
    "unit_id",
    "unit_name",
    "role",
    "models",
    "cost",
    "ppm_actual",
    "ppm_predicted",
    "residual_pct",
]

ROUND_COLS = {"ppm_actual": 1, "ppm_predicted": 1, "residual_pct": 1}


def main():
    if not PREDICTIONS_PATH.exists():
        print(
            f"Error: {PREDICTIONS_PATH} not found.\n"
            "Run the notebook (points_and_damage_analysis.ipynb) first to generate model output.",
            file=sys.stderr,
        )
        sys.exit(1)

    df = pd.read_pickle(PREDICTIONS_PATH)

    # Rename columns to match CSV output schema
    df = df.rename(
        columns={
            "n_models": "models",
            "ppm": "ppm_actual",
            "predicted_ppm": "ppm_predicted",
        }
    )

    # Load metadata for summary header
    meta = {}
    if METADATA_PATH.exists():
        with open(METADATA_PATH) as f:
            meta = json.load(f)

    CSV_OUTPUT.mkdir(exist_ok=True)

    factions = sorted(df["faction"].unique())
    total_units = 0

    print(f"Model: {meta.get('model', 'unknown')}  |  Test R²: {meta.get('test_r2', '?')}")
    print(f"{'Faction':<28s} {'Units':>5s} {'Mean Res%':>10s}  {'Most Overcosted':<30s} {'Most Undercosted':<30s}")
    print("-" * 110)

    for faction in factions:
        fdf = df[df["faction"] == faction].copy()
        fdf = fdf.sort_values("residual_pct", ascending=False)

        # Select and round columns for CSV
        out = fdf[CSV_COLUMNS].copy()
        for col, decimals in ROUND_COLS.items():
            out[col] = out[col].round(decimals)

        out.to_csv(CSV_OUTPUT / f"{faction}.csv", index=False)

        n = len(fdf)
        total_units += n
        mean_res = fdf["residual_pct"].mean()

        over = fdf.iloc[0]
        under = fdf.iloc[-1]
        over_str = f"{over['unit_name'][:25]} ({over['residual_pct']:+.0f}%)"
        under_str = f"{under['unit_name'][:25]} ({under['residual_pct']:+.0f}%)"

        print(f"{faction:<28s} {n:>5d} {mean_res:>+9.1f}%  {over_str:<30s} {under_str:<30s}")

    print("-" * 110)
    print(f"Wrote {len(factions)} CSVs ({total_units} total units) to {CSV_OUTPUT}/")


if __name__ == "__main__":
    main()
