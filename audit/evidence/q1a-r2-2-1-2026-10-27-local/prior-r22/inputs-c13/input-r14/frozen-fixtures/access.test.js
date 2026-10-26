"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = __importDefault(require("node:test"));
const strict_1 = __importDefault(require("node:assert/strict"));
const access_1 = require("../../src/stages/access");
const types_1 = require("../../src/core/types");
function ctx() {
    return {
        installationId: "0f71966d-ef6f-4976-97cb-eb34cb139204",
        contractVersion: "1.0.0",
        profile: "supervised",
        desiredHash: "d".repeat(64),
        planHash: "p".repeat(64),
        config: {}
    };
}
function baseObservation() {
    return {
        securityInputs: { contentHash: "synthetic-config-content", ownershipHash: "synthetic-root-owner-modes" },
        tailscale: {
            installedVersion: null,
            candidateVersion: "1.84.0",
            loginState: "connected",
            privateSshReachable: true
        },
        ssh: {
            port: 22,
            hasMatchBlocks: false,
            users: ["factory"],
            configHash: "ssh-config-hash"
        },
        firewall: {
            manager: "ufw",
            enabled: true,
            defaultIncomingPolicy: "deny",
            ipv6Enabled: true,
            rulesHash: "ufw-rules-hash"
        },
        publicExposure: {
            ipv4SshReachable: false,
            ipv6SshReachable: false
        },
        manual: {
            providerConsoleConfirmed: true,
            secondSessionValidated: true,
            secondSessionHasSudo: true,
            tailscaleLoginConfirmed: true,
            cutoverAckConfirmed: true
        },
        rollback: {
            timerTemplatePresent: true,
            serviceTemplatePresent: true,
            armed: false
        },
        diff: {
            sshd: "Port 22 -> 22 (drop-in only)",
            firewall: "allow tailscale0, deny public 22 ipv4/ipv6"
        }
    };
}
class FakeAccessAdapter {
    observation;
    constructor(observation) {
        this.observation = observation;
    }
    installCalls = 0;
    stageCalls = 0;
    armCalls = 0;
    cutoverCalls = 0;
    disarmCalls = 0;
    rollbackCalls = 0;
    verifyPrivateResult = true;
    async observe() {
        return JSON.parse(JSON.stringify(this.observation));
    }
    async installPinnedTailscale(version) {
        this.installCalls += 1;
        this.observation.tailscale.installedVersion = version;
    }
    async validateSshdCandidate() {
        return;
    }
    async stageManagedCutover() {
        this.stageCalls += 1;
    }
    async armRollbackTimer() {
        this.armCalls += 1;
        this.observation.rollback.armed = true;
    }
    async applyCutover() {
        this.cutoverCalls += 1;
        this.observation.publicExposure.ipv4SshReachable = false;
        this.observation.publicExposure.ipv6SshReachable = false;
    }
    async verifyPrivateTailnetAccess() {
        return this.verifyPrivateResult;
    }
    async disarmRollbackTimer() {
        this.disarmCalls += 1;
        this.observation.rollback.armed = false;
    }
    async rollbackManagedCutover() {
        this.rollbackCalls += 1;
        this.observation.rollback.armed = false;
        return { ok: true, details: "rolled back" };
    }
}
(0, node_test_1.default)("S03 plan includes console/second-login/tailscale/cutover gates and staged operations", async () => {
    const adapter = new FakeAccessAdapter(baseObservation());
    adapter.observation.manual.providerConsoleConfirmed = false;
    adapter.observation.manual.secondSessionValidated = false;
    const stage = (0, access_1.createAccessStage)(adapter);
    const observation = await stage.observe(ctx());
    strict_1.default.equal(observation.stageId, "S03");
    strict_1.default.equal(observation.status, "awaiting_manual");
    const plan = stage.plan({}, observation);
    strict_1.default.equal(plan.operations.length >= 5, true);
    strict_1.default.equal(plan.requiredGates.includes("s03-provider-console-confirmed"), true);
    strict_1.default.equal(plan.requiredGates.includes("s03-second-session-validated"), true);
    strict_1.default.equal(plan.requiredGates.includes("s03-firewall-cutover-approved"), true);
    strict_1.default.equal(plan.requiredGates.includes("s03-cutover-acknowledged"), true);
});
(0, node_test_1.default)("S03 apply performs staged cutover and disarms rollback after ack", async () => {
    const adapter = new FakeAccessAdapter(baseObservation());
    const stage = (0, access_1.createAccessStage)(adapter);
    const observation = await stage.observe(ctx());
    const plan = stage.plan({}, observation);
    const receipts = await stage.apply(ctx(), plan);
    strict_1.default.equal(receipts.length, plan.operations.length);
    strict_1.default.equal(adapter.installCalls, 1);
    strict_1.default.equal(adapter.stageCalls, 1);
    strict_1.default.equal(adapter.armCalls, 1);
    strict_1.default.equal(adapter.cutoverCalls, 1);
    strict_1.default.equal(adapter.disarmCalls, 1);
    strict_1.default.equal(adapter.rollbackCalls, 0);
    strict_1.default.equal(adapter.observation.rollback.armed, false);
});
(0, node_test_1.default)("S03 rolls back when private tailnet verification fails after cutover", async () => {
    const adapter = new FakeAccessAdapter(baseObservation());
    adapter.verifyPrivateResult = false;
    const stage = (0, access_1.createAccessStage)(adapter);
    const observation = await stage.observe(ctx());
    const plan = stage.plan({}, observation);
    await strict_1.default.rejects(async () => stage.apply(ctx(), plan), (error) => {
        return (error instanceof Error
            && "code" in error
            && error.code === "s03_tailnet_private_login_failed"
            && error.exitCode === types_1.ExitCode.ManualActionRequired);
    });
    strict_1.default.equal(adapter.rollbackCalls, 1);
    strict_1.default.equal(adapter.observation.rollback.armed, false);
});
(0, node_test_1.default)("S03 verify fails when IPv6 public SSH remains reachable", async () => {
    const adapter = new FakeAccessAdapter(baseObservation());
    adapter.observation.publicExposure.ipv6SshReachable = true;
    const stage = (0, access_1.createAccessStage)(adapter);
    await strict_1.default.rejects(async () => stage.verify(ctx()), (error) => {
        return (error instanceof Error
            && "code" in error
            && error.code === "s03_public_ssh_exposed"
            && error.exitCode === types_1.ExitCode.DriftOrRecoveryRequired);
    });
});
