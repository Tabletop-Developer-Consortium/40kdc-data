"""Schema validation with the closed cross-implementation error-code enum.

Loads the canonical JSON Schema tree (the packaged copy under
``wh40kdc/schemas/``, or the live repo ``schemas/`` when running in-repo) into
a ``jsonschema`` registry keyed by ``$id`` so cross-file ``$ref`` resolution
works, and maps validation errors onto the closed ``(path, code)`` enum
pinned by ``conformance/validator/cases.json``:

REQUIRED_MISSING, TYPE_MISMATCH, ENUM_VIOLATION, PATTERN_MISMATCH,
RANGE_VIOLATION, ADDITIONAL_PROPERTY, UNIQUE_VIOLATION.

Wording differs by library (AJV vs jsonschema) — only the ``(path, code)``
pairs are the contract, compared with set semantics. AJV flattens failing
``anyOf``/``oneOf`` branch errors into its error list while ``jsonschema``
nests them under ``.context``; :func:`_flatten_errors` recursively unnests so
both produce the same signature. Python mirror of the validator half of
``tools/src/runner.ts`` + ``tools/src/schema-loader.ts``.
"""

from __future__ import annotations

import json
import re
from functools import cache
from importlib import resources
from pathlib import Path
from typing import Any

import jsonschema
from referencing import Registry, Resource

#: Wire validator targets → schema ``$id`` (mirrors runner.ts VALIDATOR_TARGETS).
VALIDATOR_TARGETS = {
    "unit": "https://40kdc.dev/schemas/core/unit.schema.json",
    "weapon": "https://40kdc.dev/schemas/core/weapon.schema.json",
    "faction": "https://40kdc.dev/schemas/core/faction.schema.json",
    "ability": "https://40kdc.dev/schemas/enrichment/ability-dsl/ability.schema.json",
    "wargear": "https://40kdc.dev/schemas/core/wargear.schema.json",
    "wargear-option": "https://40kdc.dev/schemas/core/wargear-option.schema.json",
}

#: jsonschema validator name → closed-enum code (mirrors ajvKeywordToCode).
_KEYWORD_TO_CODE = {
    "required": "REQUIRED_MISSING",
    "type": "TYPE_MISMATCH",
    "enum": "ENUM_VIOLATION",
    "const": "ENUM_VIOLATION",
    "pattern": "PATTERN_MISMATCH",
    "format": "PATTERN_MISMATCH",
    "minimum": "RANGE_VIOLATION",
    "maximum": "RANGE_VIOLATION",
    "exclusiveMinimum": "RANGE_VIOLATION",
    "exclusiveMaximum": "RANGE_VIOLATION",
    "minLength": "RANGE_VIOLATION",
    "maxLength": "RANGE_VIOLATION",
    "minItems": "RANGE_VIOLATION",
    "maxItems": "RANGE_VIOLATION",
    "additionalProperties": "ADDITIONAL_PROPERTY",
    "uniqueItems": "UNIQUE_VIOLATION",
}

_REQUIRED_PROP_RE = re.compile(r"^'(.*)' is a required property$")


def _schemas_root() -> Path:
    """The live repo ``schemas/`` when present (dev runs never read a stale
    packaged copy), else the packaged copy."""
    repo = Path(__file__).resolve().parents[3] / "schemas"
    if repo.is_dir():
        return repo
    packaged = resources.files("wh40kdc").joinpath("schemas")
    return Path(str(packaged))


def find_schema_files(root: Path) -> list[Path]:
    """Recursively find all ``.schema.json`` files under a directory."""
    return sorted(root.rglob("*.schema.json"))


def list_schema_ids(root: Path | None = None) -> list[str]:
    """The ``$id`` of every schema in the tree."""
    ids = []
    for file in find_schema_files(root if root is not None else _schemas_root()):
        schema = json.loads(file.read_text(encoding="utf-8"))
        if schema.get("$id"):
            ids.append(schema["$id"])
    return ids


class SchemaValidator:
    """All project schemas, registered by ``$id`` for cross-file ``$ref``."""

    def __init__(self, root: Path | None = None) -> None:
        root = root if root is not None else _schemas_root()
        resources_by_id: list[tuple[str, Resource[Any]]] = []
        self._schemas: dict[str, dict[str, Any]] = {}
        for file in find_schema_files(root):
            schema = json.loads(file.read_text(encoding="utf-8"))
            schema_id = schema.get("$id")
            if not schema_id:
                continue
            self._schemas[schema_id] = schema
            resources_by_id.append((schema_id, Resource.from_contents(schema)))
        self._registry = Registry().with_resources(resources_by_id)
        self._validators: dict[str, Any] = {}

    def has_schema(self, schema_id: str) -> bool:
        return schema_id in self._schemas

    def _validator_for(self, schema_id: str) -> Any:
        v = self._validators.get(schema_id)
        if v is None:
            schema = self._schemas[schema_id]
            v = jsonschema.Draft202012Validator(
                schema,
                registry=self._registry,
                format_checker=jsonschema.Draft202012Validator.FORMAT_CHECKER,
            )
            self._validators[schema_id] = v
        return v

    def errors_for(self, schema_id: str, value: Any) -> list[dict[str, str]]:
        """Closed-enum ``[{path, code}]`` errors for ``value`` against the
        schema, deduplicated on ``(path, code)`` (first occurrence wins).
        Unmapped keywords are dropped — only the closed enum crosses the
        wire."""
        if schema_id not in self._schemas:
            raise KeyError(f"schema not loaded: {schema_id}")
        validator = self._validator_for(schema_id)
        seen: set[str] = set()
        out: list[dict[str, str]] = []
        for error in _flatten_errors(validator.iter_errors(value)):
            code = _KEYWORD_TO_CODE.get(error.validator)
            if code is None:
                continue
            path = _error_path(error)
            key = f"{path}|{code}"
            if key in seen:
                continue
            seen.add(key)
            out.append({"path": path, "code": code})
        return out

    def validate_target(self, target: str, value: Any) -> list[dict[str, str]]:
        """Validate against one of the wire targets (``unit``, ``weapon``,
        ...). Raises ``KeyError`` for an unknown target."""
        return self.errors_for(VALIDATOR_TARGETS[target], value)


def _flatten_errors(errors: Any) -> Any:
    """Recursively unnest ``anyOf``/``oneOf`` branch errors (``.context``) so
    the error stream matches AJV's flattened reporting. The containing
    anyOf/oneOf error itself is also yielded (it maps to no code and drops,
    mirroring AJV's unmapped ``anyOf`` keyword error)."""
    for error in errors:
        yield error
        if error.context:
            yield from _flatten_errors(error.context)


def _error_path(error: Any) -> str:
    """AJV-style ``instancePath`` JSON Pointer; ``required`` errors get
    ``/{missingProperty}`` appended (mirrors the TS runner's ``errorPath``)."""
    pointer = "".join(f"/{part}" for part in error.absolute_path)
    if error.validator == "required":
        m = _REQUIRED_PROP_RE.match(error.message)
        missing = m.group(1) if m else ""
        return f"{pointer}/{missing}"
    return pointer


@cache
def create_validator() -> SchemaValidator:
    """The shared validator over the default schema tree (cached)."""
    return SchemaValidator()
