from __future__ import annotations

import contextlib
import ctypes
import os
import site
from pathlib import Path
from typing import Any, cast

import numpy as np
from insightface.utils import face_align
from skimage import transform as trans


def _setup_cuda_libraries() -> None:
    with contextlib.suppress(Exception):
        lib_dirs: list[str] = []
        for sp in site.getsitepackages():
            nvidia_root = Path(sp) / "nvidia"
            if nvidia_root.is_dir():
                for sub in nvidia_root.iterdir():
                    lib_dir = sub / "lib"
                    if lib_dir.is_dir():
                        lib_dirs.append(str(lib_dir))

        if lib_dirs:
            current_ld = os.environ.get("LD_LIBRARY_PATH", "")
            current_parts = current_ld.split(":") if current_ld else []
            to_add = [d for d in lib_dirs if d not in current_parts]
            if to_add:
                os.environ["LD_LIBRARY_PATH"] = ":".join(to_add) + (
                    f":{current_ld}" if current_ld else ""
                )

            core_libs = [
                "libcudart.so.12",
                "libcublasLt.so.12",
                "libcublas.so.12",
                "libcufft.so.11",
                "libcurand.so.10",
                "libnvrtc.so.12",
                "libcudnn.so.9",
            ]
            for lib in core_libs:
                for d in lib_dirs:
                    candidate = Path(d) / lib
                    if candidate.is_file():
                        with contextlib.suppress(OSError):
                            ctypes.CDLL(str(candidate), mode=ctypes.RTLD_GLOBAL)


def install_runtime_compatibility_patches() -> None:
    _setup_cuda_libraries()
    estimate_norm_value = face_align.__dict__.get("estimate_norm")
    if callable(estimate_norm_value) and getattr(
        estimate_norm_value,
        "_mira_patched",
        False,
    ):
        return

    def estimate_norm(
        lmk: np.ndarray,
        image_size: int = 112,
        mode: str = "arcface",
    ) -> np.ndarray:
        del mode
        assert lmk.shape == (5, 2)
        assert image_size % 112 == 0 or image_size % 128 == 0
        if image_size % 112 == 0:
            ratio = float(image_size) / 112.0
            diff_x = 0.0
        else:
            ratio = float(image_size) / 128.0
            diff_x = 8.0 * ratio

        dst = face_align.arcface_dst * ratio
        dst[:, 0] += diff_x
        tform = cast(Any, trans.SimilarityTransform).from_estimate(lmk, dst)
        params = np.asarray(tform.params, dtype=np.float32)
        return params[0:2, :]

    estimate_norm._mira_patched = True  # type: ignore[attr-defined]
    face_align.estimate_norm = estimate_norm
