import { defineConfig } from "oxlint";
import core from "ultracite/oxlint/core";

export default defineConfig({
  extends: [core],
  ignorePatterns: [...(core.ignorePatterns as string[]), "apps/serve/.venv/**", "apps/serve/.uv-cache/**"],
});
