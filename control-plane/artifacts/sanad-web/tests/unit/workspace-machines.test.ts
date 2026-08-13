import { describe, it, expect } from "vitest";
import { machineBaseEnv, machineHash } from "@/lib/compute/machines";
import { sessionHash } from "@/lib/compute/tokens";
import type { AwsComputeConfig } from "@/lib/compute/aws";

const fakeConfig: AwsComputeConfig = {
  region: "eu-central-1",
  cluster: "sanad-workspaces",
  subnets: ["subnet-1"],
  tasksSecurityGroup: "sg-1",
  efsId: "fs-1",
  workspaceImage: "acct.dkr.ecr.eu-central-1.amazonaws.com/sanad-workspace:latest",
  executionRoleArn: "arn:aws:iam::1:role/exec",
  taskRoleArn: "arn:aws:iam::1:role/task",
  logGroup: "/sanad/workspaces",
  controlPlaneUrl: "https://www.sanadcode.com",
  allowedOrigins: "https://www.sanadcode.com",
};

describe("machineHash", () => {
  it("is 12 hex chars and stable", () => {
    const h = machineHash("ws_1", "prod");
    expect(h).toMatch(/^[0-9a-f]{12}$/);
    expect(machineHash("ws_1", "prod")).toBe(h);
  });
  it("differs per env and never collides with user-session hashing", () => {
    expect(machineHash("ws_1", "dev")).not.toBe(machineHash("ws_1", "prod"));
    expect(machineHash("u1", "s1")).not.toBe(sessionHash("u1", "s1"));
  });
});

describe("machineBaseEnv", () => {
  it("never sets WORKSPACE_MODE (image default 'task' governs boot)", () => {
    const env = machineBaseEnv(fakeConfig, "ws_1", true);
    expect(env).not.toHaveProperty("WORKSPACE_MODE");
  });

  it("puts workspaceId in the fixed-user slot settings.py requires", () => {
    const env = machineBaseEnv(fakeConfig, "ws_1", true);
    expect(env.SANAD_WORKSPACE_USER).toBe("ws_1");
  });

  it("carries WORKER_ENABLED and the correct KEEP_WARM for both keepWarm values", () => {
    const warm = machineBaseEnv(fakeConfig, "ws_1", true);
    expect(warm.WORKER_ENABLED).toBe("1");
    expect(warm.KEEP_WARM).toBe("1");

    const cold = machineBaseEnv(fakeConfig, "ws_1", false);
    expect(cold.WORKER_ENABLED).toBe("1");
    expect(cold.KEEP_WARM).toBe("0");
  });
});
