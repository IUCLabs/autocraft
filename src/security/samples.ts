// Made-up input for the Prompts page examples of the security prompts.
import { SECURITY_REPO, type SecurityAreaInput, type SecurityModelInput, type SecurityVerifyInput } from "./rules.ts";

const base = { repo: SECURITY_REPO, number: 1, project: "photocraft", commit: "0123456789abcdef0123456789abcdef01234567" } as const;
const entry = { name: "Open PSD file", kind: "file-open", where: "src/open.rs:40" };

export const SAMPLE_SECURITY_MODEL: SecurityModelInput[] = [{ ...base }];
export const SAMPLE_SECURITY_AREA: SecurityAreaInput[] = [{
  ...base, summary: "A desktop image editor that opens documents and plug-ins from disk.",
  area: { name: "PSD reader", paths: ["crates/psd/src"], why: "Parses layer data from files with sizes read from the file." }, entry_points: [entry],
}];
export const SAMPLE_SECURITY_VERIFY: SecurityVerifyInput[] = [{
  ...base,
  finding: {
    title: "Layer length read from the file sizes an unchecked copy", severity: "high", urgent: false, category: "memory_safety", area: "PSD reader",
    refs: [{ path: "crates/psd/src/layer.rs", line: 118, claim: "length is read from the file and passed to copy_nonoverlapping" }],
    reach: "src/open.rs:40 passes the file to crates/psd/src/layer.rs:90, which reads len at line 112 and copies len bytes at line 118 without comparing it to the buffer.",
    impact: "Memory corruption from a crafted file.",
  },
}];
