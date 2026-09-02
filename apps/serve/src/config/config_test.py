from __future__ import annotations

import os
from unittest.mock import patch

from config import config
from config.config import load_settings


def test_config_default_values() -> None:
    # Neutralize the .env file loader: defaults must come from code only,
    # regardless of what apps/serve/.env contains on this machine.
    with (
        patch.dict(os.environ, {}, clear=True),
        patch.object(config, "_load_dotenv", lambda: None),
    ):
        settings = load_settings()
        assert settings.serpapi_key is None
        assert settings.search_timeout_seconds == 12.0
        assert settings.search_max_results == 5
        assert settings.pipeline_enabled is True
        assert settings.face_crop_padding_x == 1.0
        assert settings.face_crop_padding_y == 1.0
        assert settings.google_vision_enabled is True
        assert settings.google_vision_max_results == 5


def test_config_env_overrides() -> None:
    env = {
        "SERPAPI_KEY": "my-key-123",
        "SEARCH_TIMEOUT_SECONDS": "20",
        "SEARCH_MAX_RESULTS": "10",
        "PIPELINE_ENABLED": "false",
        "FACE_CROP_PADDING_X": "0.25",
        "FACE_CROP_PADDING_Y": "0.30",
        "MIRA_ENROLLMENT_SYNC_ENABLED": "true",
        "GOOGLE_VISION_ENABLED": "false",
        "GOOGLE_VISION_MAX_RESULTS": "3",
    }
    with (
        patch.dict(os.environ, env, clear=False),
        patch.object(config, "_load_dotenv", lambda: None),
    ):
        settings = load_settings()
        assert settings.serpapi_key == "my-key-123"
        assert settings.search_timeout_seconds == 20.0
        assert settings.search_max_results == 10
        assert settings.pipeline_enabled is False
        assert settings.face_crop_padding_x == 0.25
        assert settings.face_crop_padding_y == 0.30
        assert settings.google_vision_enabled is False
        assert settings.google_vision_max_results == 3


def test_config_empty_serpapi_key_is_none() -> None:
    with (
        patch.dict(os.environ, {"SERPAPI_KEY": ""}, clear=False),
        patch.object(config, "_load_dotenv", lambda: None),
    ):
        settings = load_settings()
        assert settings.serpapi_key is None


def test_config_dotenv_loader_sets_missing_keys_only() -> None:
    # _load_dotenv must not override variables already present in the env.
    import tempfile
    from pathlib import Path

    with tempfile.TemporaryDirectory() as tmp:
        env_file = Path(tmp) / ".env"
        env_file.write_text(
            "SERPAPI_KEY=from-file\n"
            "SEARCH_MAX_RESULTS=9\n"
            "# comment line\n"
            "MALFORMED LINE WITHOUT EQUALS\n",
            encoding="utf-8",
        )
        env = {"SEARCH_MAX_RESULTS": "7"}
        with (
            patch.dict(os.environ, env, clear=False),
            patch.object(config, "_dotenv_candidates", lambda: [env_file]),
        ):
            config._load_dotenv()
            assert os.environ["SERPAPI_KEY"] == "from-file"
            # Pre-existing env var wins over the file
            assert os.environ["SEARCH_MAX_RESULTS"] == "7"
