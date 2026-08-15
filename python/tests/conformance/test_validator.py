"""Schema validator against the validator conformance corpus.

The contract is the closed-enum ``(path, code)`` signature, compared with set
semantics (the TS conformance test sorts both sides before comparing).
"""

from __future__ import annotations

from typing import Any

import pytest

from wh40kdc.validator import SchemaValidator, create_validator

from ..conftest import load_corpus_json


def _cases() -> list[dict[str, Any]]:
    return load_corpus_json("validator", "cases.json")


def _sort_key(e: dict[str, str]) -> str:
    return f"{e['path']}|{e['code']}"


@pytest.mark.parametrize("case", _cases(), ids=lambda c: c["name"])
def test_validator_case(case: dict[str, Any]) -> None:
    validator = create_validator()
    errors = validator.validate_target(case["target"], case["input"])
    assert sorted(errors, key=_sort_key) == sorted(case["expected_errors"], key=_sort_key)


def test_packaged_schema_tree_loads() -> None:
    # The packaged copy must load standalone (what installed wheels use).
    from importlib import resources
    from pathlib import Path

    packaged = Path(str(resources.files("wh40kdc").joinpath("schemas")))
    validator = SchemaValidator(packaged)
    assert validator.has_schema("https://40kdc.dev/schemas/core/unit.schema.json")
    assert (
        validator.errors_for(
            "https://40kdc.dev/schemas/core/wargear.schema.json",
            {
                "id": "icon-of-khorne",
                "name": "Icon of Khorne",
                "category": "icon",
                "game_version": {"edition": "10th", "dataslate": "2025-q3"},
            },
        )
        == []
    )
