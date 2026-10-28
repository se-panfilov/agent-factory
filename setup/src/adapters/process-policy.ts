import path from "node:path";
import { setupError } from "../core/errors";
import { ExitCode } from "../core/types";
import type { CommandOptions } from "./process";

function refuse(code: string): never {
  throw setupError({ exitCode: ExitCode.SecurityBoundaryViolation, code,
    publicMessage: "Command execution inputs are outside the reviewed internal policy.",
    nextAction: "Use an explicit supported internal execution policy and bounded, allowlisted inputs." });
}
export function commandEnvironment(options: CommandOptions): Record<string, string> {
  if (typeof options.binary !== "string" || !path.isAbsolute(options.binary) || path.normalize(options.binary) !== options.binary || options.binary.includes("\0")) refuse("process_untrusted_binary");
  if (!["observe", "interruptible", "critical"].includes(options.policy)) refuse("process_policy_missing");
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0 || options.timeoutMs > 2_147_000_000
    || !Number.isSafeInteger(options.maxOutputBytes) || options.maxOutputBytes <= 0 || options.maxOutputBytes > 16 * 1024 * 1024
    || !Array.isArray(options.args) || options.args.length > 4096
    || options.args.some(arg => typeof arg !== "string" || arg.includes("\0") || Buffer.byteLength(arg) > 1024 * 1024)
    || (options.cwd !== undefined && (typeof options.cwd !== "string" || !path.isAbsolute(options.cwd) || path.normalize(options.cwd) !== options.cwd || options.cwd.includes("\0")))) refuse("process_bounds_invalid");
  // No privileged broker or unsafe-to-interrupt real mutation is qualified in Q1B.
  if (options.policy === "critical" || /^(sudo|apt|apt-get|dpkg|ssh|sshd|ufw|systemctl|service)$/.test(path.basename(options.binary))
    && !["--version", "is-active", "show", "status"].includes(options.args[0] ?? "")) {
    throw setupError({ exitCode: ExitCode.BlockedByMissingCapabilityOrEvidence, code: "process_critical_supervisor_unavailable",
      publicMessage: "This real critical operation has no qualified safe supervisor.",
      nextAction: "Keep the reviewed plan/evidence. A separately qualified privileged adapter is required; do not retry or remove resource locks." });
  }
  const env: Record<string, string> = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LC_ALL: "C" };
  for (const [key, value] of Object.entries(options.env ?? {})) {
    if (key === "PATH") continue; // Historical fixed-PATH compatibility: an override has no authority.
    if (typeof value !== "string" || Buffer.byteLength(value) > 4096 || /[\0\r\n]/.test(value)) refuse("process_env_invalid");
    if (["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"].includes(key)) {
      let url: URL; try { url = new URL(value); } catch { refuse("process_env_invalid"); }
      if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.username || url.password || url.hash || url.search || url.pathname !== "/") refuse("process_env_invalid");
    } else if (["SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS"].includes(key)) {
      if (!path.isAbsolute(value) || path.normalize(value) !== value || value.length > 1024) refuse("process_env_invalid");
    } else if (key === "NO_PROXY" || key === "no_proxy") {
      if (!/^[A-Za-z0-9.,:_\[\]-]{1,1024}$/.test(value)) refuse("process_env_invalid");
    } else if (["GIT_AUTHOR_DATE", "GIT_COMMITTER_DATE"].includes(key) && value === "2020-01-01T00:00:00Z") {
      // Fixed deterministic local fixture dates; no config/executable hooks.
    } else if (!(key === "LC_ALL" && value === "C") && !(key === "GIT_TERMINAL_PROMPT" && value === "0")) refuse("process_env_forbidden");
    const counterpart = key === key.toUpperCase() ? key.toLowerCase() : key.toUpperCase();
    if (options.env?.[counterpart] !== undefined && options.env[counterpart] !== value) refuse("process_env_conflict");
    env[key] = value;
  }
  return env;
}
