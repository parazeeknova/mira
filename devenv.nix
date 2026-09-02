{
  pkgs,
  lib,
  config,
  inputs,
  ...
}:

let
  bun_1_4_0 = pkgs.bun.overrideAttrs (old: {
    version = "1.4.0";
    src = pkgs.fetchurl {
      url = "https://github.com/oven-sh/bun/releases/download/bun-v1.4.0/bun-linux-x64.zip";
      sha256 = "0lp45zljagwcv1l2jv7mi3a1j6hsrsr838m0mikvbj1sp1gzn0rd";
    };
  });
in
{
  name = "mira";
  cachix.enable = true;
  dotenv.enable = true;
  dotenv.disableHint = true;
  env = {
    GREET = "mira";
    TURBO_TELEMETRY_DISABLED = "1";
    UV_CACHE_DIR = "${config.env.DEVENV_ROOT}/apps/serve/.uv-cache";
    MPLCONFIGDIR = "${config.env.DEVENV_ROOT}/apps/serve/.mplconfig";
    LD_LIBRARY_PATH = lib.makeLibraryPath [
      pkgs.zlib
      pkgs.openssl
      pkgs.stdenv.cc.cc.lib
      pkgs.libGL
      pkgs.glib
      pkgs.libxcb
      pkgs.libxcb
      pkgs.libx11
      pkgs.libxext
      pkgs.libxrender
      pkgs.libSM
    ];
  };

  packages = with pkgs; [
    git
    curl
    jq
    gnumake
    cacert
    zlib
    openssl
    stdenv.cc.cc.lib
    libGL
    glib
    ruff
    solc
  ];

  languages.javascript = {
    enable = true;
    directory = "${config.env.DEVENV_ROOT}";
    package = pkgs.nodejs_24;
    bun = {
      enable = true;
      package = bun_1_4_0;
      install.enable = false;
    };
    corepack.enable = false;
  };

  languages.typescript = {
    enable = true;
  };

  languages.python = {
    enable = true;
    version = "3.14";
    directory = "${config.env.DEVENV_ROOT}/apps/serve";
    venv = {
      enable = true;
    };
    uv = {
      enable = true;
      package = pkgs.uv;
      sync = {
        enable = false;
        allGroups = true;
      };
    };

    manylinux.enable = true;
    libraries = with pkgs; [
      zlib
      openssl
      stdenv.cc.cc.lib
    ];
    lsp = {
      enable = true;
      package = pkgs.pyright;
    };
  };

  languages.solidity = {
    enable = true;
    package = pkgs.solc;
    foundry.enable = false;
  };

  git-hooks.hooks = {
    nixfmt-rfc-style.enable = true;
    shellcheck.enable = true;
    mira-check = {
      enable = true;
      name = "mira: check (format + lint)";
      entry = "bun run check";
      pass_filenames = false;
    };
    mira-check-types = {
      enable = true;
      name = "mira: check-types (tsc + pyright)";
      entry = "bun run check-types";
      pass_filenames = false;
    };
  };

  tasks = {
    # Manual — run `devenv tasks run mira:install` after cloning
    "mira:install" = {
      exec = ''
        echo "[mira] bun install (root)..."
        bun install --frozen-lockfile || bun install
        echo "[mira] uv sync (apps/serve)..."
        uv sync --project apps/serve --all-groups
      '';
    };

    "mira:check" = {
      exec = "bun run check";
      execIfModified = [
        "apps/web/**/*.{ts,tsx,js,json}"
        "apps/contracts/**/*.{ts,sol,js,json}"
        "apps/serve/**/*.py"
        "package.json"
        "apps/serve/pyproject.toml"
      ];
    };
    "mira:check-types" = {
      exec = "bun run check-types";
    };
    "mira:test" = {
      exec = "bun run test";
    };
  };

  processes = {
    web.exec = "bun run --filter=@mira/web dev";
    serve.exec = "bun run --filter=@mira/serve dev";
    chain.exec = "bun run chain:node";
  };

  enterShell = ''
    echo "◆ mira devenv — NixOS"
    echo "  bun $(bun --version) | node $(node --version) | python $(python --version) | uv $(uv --version 2>&1 | head -1) | solc $(solc --version 2>&1 | head -1)"
    echo "  tip: devenv tasks run mira:test  |  devenv up  |  bun run check && bun run check-types"
  '';

  enterTest = ''
    echo "Running mira test suite (devenv test)..."
    bun run check-types
    bun run test
  '';
}
