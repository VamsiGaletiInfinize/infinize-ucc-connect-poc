"""
Loads the versioned assistant prompt.

ONE ARTIFACT, TWO DELIVERY MECHANISMS
-------------------------------------
The cascaded pipeline takes the system prompt as a message inside the LLM context. Nova
Sonic takes it as a constructor argument (`system_instruction=`). That asymmetry is in the
frameworks, not in our design — but if each mode were handed its own copy of the text, the
two would drift and the latency comparison would silently become a prompt comparison.

So the text lives in `prompts/assistant.md`, is loaded once, and is exposed in both shapes
from the same string (research §R4, FR-023).

The prompt is a versioned artifact rather than a literal in Python so it can be reviewed,
diffed and rolled back like any other governed text.
"""
from __future__ import annotations

from functools import lru_cache
from pathlib import Path
from typing import Any

PROMPT_PATH = Path(__file__).parent / "prompts" / "assistant.md"


def _strip_front_matter(text: str) -> str:
    """Drop the YAML header if present; it is metadata for humans, not instruction."""
    if not text.startswith("---"):
        return text.strip()
    end = text.find("\n---", 3)
    if end == -1:
        return text.strip()
    return text[end + 4 :].strip()


@lru_cache(maxsize=1)
def system_prompt() -> str:
    """The assistant prompt as plain text. Cached — the file does not change at runtime."""
    if not PROMPT_PATH.exists():
        raise FileNotFoundError(
            f"Assistant prompt missing at {PROMPT_PATH}. The pipeline will not run without "
            "it: an assistant with no instructions is not a safer assistant, it is an "
            "unpredictable one."
        )
    body = _strip_front_matter(PROMPT_PATH.read_text(encoding="utf-8"))
    if not body:
        raise ValueError(f"Assistant prompt at {PROMPT_PATH} is empty.")
    return body


def as_context_message() -> dict[str, Any]:
    """Shape the cascaded pipeline wants: a system message in the LLM context."""
    return {"role": "system", "content": system_prompt()}


def as_system_instruction() -> str:
    """Shape Nova Sonic wants: a constructor argument."""
    return system_prompt()
