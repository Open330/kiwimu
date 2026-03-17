"""Project configuration management."""

from __future__ import annotations

import sys
from dataclasses import dataclass, field
from pathlib import Path

if sys.version_info >= (3, 11):
    import tomllib
else:
    import tomli as tomllib

import tomli_w


CONFIG_FILE = "kiwi.toml"
DB_FILE = "kiwi.db"
SITE_DIR = "_site"


@dataclass
class KiwiConfig:
    name: str = "My Kiwi"
    created: str = ""
    output_dir: str = SITE_DIR
    expand_provider: str = ""
    expand_model: str = ""

    def save(self, path: Path) -> None:
        data = {
            "project": {"name": self.name, "created": self.created},
            "build": {"output_dir": self.output_dir},
            "expand": {"provider": self.expand_provider, "model": self.expand_model},
        }
        (path / CONFIG_FILE).write_bytes(tomli_w.dumps(data).encode())

    @classmethod
    def load(cls, path: Path) -> KiwiConfig:
        with open(path / CONFIG_FILE, "rb") as f:
            data = tomllib.load(f)
        proj = data.get("project", {})
        build = data.get("build", {})
        expand = data.get("expand", {})
        return cls(
            name=proj.get("name", "My Kiwi"),
            created=proj.get("created", ""),
            output_dir=build.get("output_dir", SITE_DIR),
            expand_provider=expand.get("provider", ""),
            expand_model=expand.get("model", ""),
        )


def find_project_root() -> Path:
    """Find the nearest directory containing kiwi.toml."""
    cwd = Path.cwd()
    for parent in [cwd, *cwd.parents]:
        if (parent / CONFIG_FILE).exists():
            return parent
    raise FileNotFoundError(
        "No kiwi.toml found. Run 'kiwimu init' first."
    )
