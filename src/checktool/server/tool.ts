// The `check` tool's definition, shared by the stdio server in the sandbox (main.ts) and the per-lease build tools of the
// user-local mode (src/remote/tools.ts). No imports: the sandbox mounts just this directory.
export const TOOL = {
  name: "check",
  description: "Runs a build command on your current patch in a build container and returns its output. input patch: your complete current unified diff against the head commit (what you would answer with). command: fmt (rustfmt on the patch's .rs files; returns the formatting changes it would make), clippy (findings on the lines your patch adds or changes, plus compile errors), check (cargo check --workspace --all-targets) or test (cargo test -p <crate> [test_name]). A command can take minutes. The number of calls and the total time are limited.",
  inputSchema: {
    type: "object", additionalProperties: false, required: ["patch", "command"],
    properties: {
      patch: { type: "string", description: "The complete diff against the head commit, in git format." },
      command: { type: "string", enum: ["fmt", "clippy", "check", "test"] },
      crate: { type: "string", description: "test only: the crate to test (-p)." },
      test_name: { type: "string", description: "test only: a test name filter." },
    },
  },
};
