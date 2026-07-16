#!/usr/bin/env python3
"""Build one self-contained branch-explanation HTML file from reusable assets."""

from __future__ import annotations

import argparse
import base64
import html
import json
from collections.abc import Sequence
from html.parser import HTMLParser
from pathlib import Path
from typing import Any


SKILL_DIR = Path(__file__).resolve().parent.parent
TEMPLATE_PATH = SKILL_DIR / "assets" / "explanation-template.html"
WASM_PATH = SKILL_DIR / "assets" / "grok-mermaid.wasm"
MARKERS = {
    "title": "@@PAGE_TITLE@@",
    "description": "@@PAGE_DESCRIPTION@@",
    "content": "@@CONTENT_HTML@@",
    "data": "@@PAGE_DATA_JSON@@",
    "wasm": "@@MERMAID_WASM_BASE64@@",
}


class ContentInspector(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.diagram_ids: list[str] = []
        self.external_assets: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attributes = dict(attrs)
        diagram_id = attributes.get("data-diagram-id")
        if diagram_id:
            self.diagram_ids.append(diagram_id)

        if tag == "script" and attributes.get("src"):
            self.external_assets.append(attributes["src"] or "")
        if tag == "img" and attributes.get("src"):
            self.external_assets.append(attributes["src"] or "")
        if tag == "link" and attributes.get("href"):
            self.external_assets.append(attributes["href"] or "")


def require_string(value: Any, path: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{path} must be a non-empty string")
    return value


def require_list(value: Any, path: str) -> list[Any]:
    if not isinstance(value, list):
        raise ValueError(f"{path} must be a list")
    return value


def validate_page_data(data: Any, inspector: ContentInspector) -> dict[str, Any]:
    if not isinstance(data, dict):
        raise ValueError("page data must be a JSON object")

    require_string(data.get("title"), "title")
    require_string(data.get("description"), "description")

    modes = require_list(data.get("languageModes", []), "languageModes")
    mode_ids: set[str] = set()
    for index, mode in enumerate(modes):
        if not isinstance(mode, dict):
            raise ValueError(f"languageModes[{index}] must be an object")
        mode_id = require_string(mode.get("id"), f"languageModes[{index}].id")
        require_string(mode.get("label"), f"languageModes[{index}].label")
        shown = require_list(mode.get("show"), f"languageModes[{index}].show")
        if not shown or any(not isinstance(item, str) or not item for item in shown):
            raise ValueError(f"languageModes[{index}].show must contain language IDs")
        if mode_id in mode_ids:
            raise ValueError(f"duplicate language mode: {mode_id}")
        mode_ids.add(mode_id)

    diagrams = require_list(data.get("diagrams", []), "diagrams")
    diagram_ids: set[str] = set()
    for index, diagram in enumerate(diagrams):
        if not isinstance(diagram, dict):
            raise ValueError(f"diagrams[{index}] must be an object")
        diagram_id = require_string(diagram.get("id"), f"diagrams[{index}].id")
        require_string(diagram.get("source"), f"diagrams[{index}].source")
        if diagram_id in diagram_ids:
            raise ValueError(f"duplicate diagram ID: {diagram_id}")
        diagram_ids.add(diagram_id)

    placeholder_ids = set(inspector.diagram_ids)
    if len(placeholder_ids) != len(inspector.diagram_ids):
        raise ValueError("content contains duplicate data-diagram-id placeholders")
    if diagram_ids != placeholder_ids:
        missing = sorted(diagram_ids - placeholder_ids)
        unknown = sorted(placeholder_ids - diagram_ids)
        raise ValueError(f"diagram IDs do not match placeholders; missing={missing}, unknown={unknown}")

    quiz = require_list(data.get("quiz"), "quiz")
    if len(quiz) != 5:
        raise ValueError(f"quiz must contain exactly five questions, found {len(quiz)}")
    for index, question in enumerate(quiz):
        if not isinstance(question, dict):
            raise ValueError(f"quiz[{index}] must be an object")
        require_string(question.get("question"), f"quiz[{index}].question")
        correct = require_string(question.get("correct"), f"quiz[{index}].correct")
        require_string(question.get("explanation"), f"quiz[{index}].explanation")
        options = question.get("options")
        if not isinstance(options, dict) or len(options) < 3:
            raise ValueError(f"quiz[{index}].options must contain at least three choices")
        if any(not isinstance(key, str) or not isinstance(value, str) for key, value in options.items()):
            raise ValueError(f"quiz[{index}].options must map string IDs to string labels")
        order = require_list(question.get("order"), f"quiz[{index}].order")
        if set(order) != set(options) or len(order) != len(options):
            raise ValueError(f"quiz[{index}].order must be a permutation of option IDs")
        if correct not in options:
            raise ValueError(f"quiz[{index}].correct must name an option")

    if inspector.external_assets:
        raise ValueError(f"content fragment contains external assets: {inspector.external_assets}")

    return data


def script_safe_json(data: dict[str, Any]) -> str:
    serialized = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
    return (
        serialized.replace("&", "\\u0026")
        .replace("<", "\\u003c")
        .replace(">", "\\u003e")
        .replace("\u2028", "\\u2028")
        .replace("\u2029", "\\u2029")
    )


def replace_once(source: str, marker: str, value: str) -> str:
    count = source.count(marker)
    if count != 1:
        raise ValueError(f"template marker {marker!r} must appear once, found {count}")
    return source.replace(marker, value)


def build(content_path: Path, data_path: Path, output_path: Path) -> None:
    content = content_path.read_text(encoding="utf-8")
    inspector = ContentInspector()
    inspector.feed(content)

    raw_data = json.loads(data_path.read_text(encoding="utf-8"))
    data = validate_page_data(raw_data, inspector)
    template = TEMPLATE_PATH.read_text(encoding="utf-8")

    replacements = {
        MARKERS["title"]: html.escape(data["title"], quote=False),
        MARKERS["description"]: html.escape(data["description"], quote=True),
        MARKERS["content"]: content,
        MARKERS["data"]: script_safe_json(data),
        MARKERS["wasm"]: base64.b64encode(WASM_PATH.read_bytes()).decode("ascii"),
    }
    result = template
    for marker, value in replacements.items():
        result = replace_once(result, marker, value)

    leftovers = [marker for marker in MARKERS.values() if marker in result]
    if leftovers:
        raise ValueError(f"unresolved template markers: {leftovers}")

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(result, encoding="utf-8")
    print(f"Built {output_path} ({output_path.stat().st_size:,} bytes)")


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--content", type=Path, required=True, help="HTML body fragment")
    parser.add_argument("--data", type=Path, required=True, help="page data JSON")
    parser.add_argument("--output", type=Path, required=True, help="self-contained HTML output")
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> None:
    args = parse_args(argv)
    build(args.content, args.data, args.output)


if __name__ == "__main__":
    main()
