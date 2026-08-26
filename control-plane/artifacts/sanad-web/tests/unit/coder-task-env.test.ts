import { describe, it, expect } from "vitest";
import { agentBaseEnv } from "@/lib/compute/sessions";
import type { AwsComputeConfig } from "@/lib/compute/aws";

/**
 * The workspace task's agentd reads `CODER_ENABLED == "1"` and otherwise
 * defaults `coder_enabled=False`, answering every /internal/coder/** call
 * with 404 `coder_disabled`. Nothing used to set that variable on any code
 * path — not the task definition, not the image — so the coder panel could
 * never work in production no matter how the web-side allowlist was set.
 */
const base: AwsComputeConfig = {
  region: "eu-central-1",
  cluster: "sanad-workspaces",
  subnets: ["subnet-1"],
  tasksSecurityGroup: "sg-1",
  efsId: "fs-1",
  workspaceImage: "img:latest",
  executionRoleArn: "arn:exec",
  taskRoleArn: "arn:task",
  logGroup: "/test",
  controlPlaneUrl: "https://cp.test",
  allowedOrigins: "https://cp.test",
  coderEnabled: false,
};

describe("agentBaseEnv — CODER_ENABLED", () => {
  it("arms the workspace task when the flag is on", () => {
    const env = agentBaseEnv({ ...base, coderEnabled: true }, "u_1");
    expect(env.CODER_ENABLED).toBe("1");
  });

  it("OMITS the key entirely when off — not an explicit '0'", () => {
    const env = agentBaseEnv(base, "u_1");
    // agentd treats absent and "0" alike, but omitting keeps the registered
    // task definition byte-identical to what every workspace gets today.
    expect(env).not.toHaveProperty("CODER_ENABLED");
  });

  it("changes NOTHING else about the task env in either state", () => {
    const off = agentBaseEnv(base, "u_1");
    const on = agentBaseEnv({ ...base, coderEnabled: true }, "u_1");
    const expected = {
      WORKSPACE_MODE: "task",
      SANAD_WORKSPACE_USER: "u_1",
      CONTROL_PLANE_URL: "https://cp.test",
      SANAD_API_BASE_URL: "https://cp.test",
      TERMINAL_ALLOWED_ORIGINS: "https://cp.test",
    };
    expect(off).toEqual(expected);
    expect(on).toEqual({ ...expected, CODER_ENABLED: "1" });
  });

  it("still carries the identity settings.py hard-requires in task mode", () => {
    // agentd raises SettingsError and refuses to boot without these.
    const env = agentBaseEnv({ ...base, coderEnabled: true }, "u_42");
    expect(env.WORKSPACE_MODE).toBe("task");
    expect(env.SANAD_WORKSPACE_USER).toBe("u_42");
  });
});
