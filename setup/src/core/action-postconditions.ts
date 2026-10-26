import { type AdapterAction } from "./types";
/** Public descriptions correspond to existing real operation/stage verifiers, not receipt identity alone. */
export function actionPostconditions(action: AdapterAction): string[] {
  switch (action) {
    case "apt.refresh": return ["apt_update_completed", "metadata_fresh", "dpkg_audit_clean"];
    case "apt.simulate": return ["apt_simulation_completed", "dpkg_audit_clean"];
    case "apt.install": return ["apt_install_completed", "pins_installed", "dpkg_audit_clean"];
    case "access.install": case "access.stage": case "access.arm": case "access.cutover": case "access.tailnet": case "access.disarm":
      return ["s03_exact_current_postcondition_hash", "reviewed_access_transition"];
    case "docker.install": return ["docker_pins_installed"];
    case "docker.group": return ["account_membership_confirmed", "effective_session_or_durable_manual_pause"];
    case "docker.configure": return ["confirmed_daemon_config_hash"];
    case "docker.restart": return ["owner_daemon_reachable", "api_compatible"];
    case "docker.probe": return ["resource_probe_verified", "active_group_session"];
    case "docker.mark": return ["installation_ownership_verified"];
    case "release.extract": return ["reviewed_content_hashes", "staging_path_proof"];
    case "release.materialize": return ["reviewed_content_hashes", "deployment_binding"];
    case "release.probe": return ["current_deployment_integrity", "both_offline_help_probes"];
    case "fixture.counter": return ["owned_fixture_postcondition"];
    default: return ["stage_verify_and_current_observe"];
  }
}

/** Review disclosures, not permission to replay an ambiguous outcome or add an action. */
export function actionUnknownEffects(action: AdapterAction): string[] {
  if (["apt.install", "access.install", "docker.install"].includes(action)) return ["package-maintainer-script-effects-not-privileged-qualified"];
  if (action === "configuration.prepare") return ["image-build-effects-not-live-qualified"];
  if (["access.arm", "access.cutover", "access.disarm"].includes(action)) return ["privileged-access-implementation-remains-Q2-blocked"];
  return [];
}
