/**
 * Thin, typed wrappers over the AWS SDK for the workspace-task lifecycle.
 * All resource names/ids come from env (set once from the bootstrap output);
 * clients are lazily constructed so railway-mode deployments never touch AWS.
 */
import {
  DescribeTasksCommand,
  ECSClient,
  RegisterTaskDefinitionCommand,
  RunTaskCommand,
  StopTaskCommand,
} from "@aws-sdk/client-ecs";
import {
  CreateAccessPointCommand,
  DeleteAccessPointCommand,
  DescribeAccessPointsCommand,
  EFSClient,
} from "@aws-sdk/client-efs";
import { DescribeImagesCommand, ECRClient } from "@aws-sdk/client-ecr";

export interface AwsComputeConfig {
  region: string;
  cluster: string;
  subnets: string[];
  tasksSecurityGroup: string;
  efsId: string;
  workspaceImage: string;
  executionRoleArn: string;
  taskRoleArn: string;
  logGroup: string;
  controlPlaneUrl: string;
  allowedOrigins: string;
}

export function awsComputeConfig(): AwsComputeConfig {
  const env = process.env;
  const require = (name: string): string => {
    const v = env[name];
    if (!v) throw new Error(`${name} is not configured`);
    return v;
  };
  const account = require("SANAD_AWS_ACCOUNT");
  return {
    region: env.AWS_REGION ?? "eu-central-1",
    cluster: env.SANAD_AWS_CLUSTER ?? "sanad-workspaces",
    subnets: require("SANAD_TASKS_SUBNETS")
      .split(",")
      .map((s) => s.trim()),
    tasksSecurityGroup: require("SANAD_TASKS_SG"),
    efsId: require("SANAD_EFS_ID"),
    workspaceImage: require("WORKSPACE_IMAGE"),
    executionRoleArn: `arn:aws:iam::${account}:role/sanad-task-execution`,
    taskRoleArn: `arn:aws:iam::${account}:role/sanad-workspace-task`,
    logGroup: env.SANAD_LOG_GROUP ?? "/sanad/workspaces",
    controlPlaneUrl: env.APP_URL ?? "https://www.sanadcode.com",
    allowedOrigins: env.TERMINAL_ALLOWED_ORIGINS ?? "https://www.sanadcode.com",
  };
}

let ecsClient: ECSClient | null = null;
let efsClient: EFSClient | null = null;
const ecs = (region: string): ECSClient =>
  (ecsClient ??= new ECSClient({ region }));
const efs = (region: string): EFSClient =>
  (efsClient ??= new EFSClient({ region }));

/** Per-user EFS access point: uid/gid 1000 (the image's `dev`), rooted at /users/<hash>. */
export async function ensureAccessPoint(
  config: AwsComputeConfig,
  hash12: string,
): Promise<string> {
  const client = efs(config.region);
  const existing = await client.send(
    new DescribeAccessPointsCommand({
      FileSystemId: config.efsId,
      MaxResults: 100,
    }),
  );
  const hit = existing.AccessPoints?.find(
    (ap) => ap.RootDirectory?.Path === `/users/${hash12}`,
  );
  if (hit?.AccessPointId) return hit.AccessPointId;

  const created = await client.send(
    new CreateAccessPointCommand({
      FileSystemId: config.efsId,
      ClientToken: `sanad-${hash12}`,
      PosixUser: { Uid: 1000, Gid: 1000 },
      RootDirectory: {
        Path: `/users/${hash12}`,
        CreationInfo: { OwnerUid: 1000, OwnerGid: 1000, Permissions: "700" },
      },
      Tags: [{ Key: "Name", Value: `sanad-ws-${hash12}` }],
    }),
  );
  const id = created.AccessPointId;
  if (!id) throw new Error("EFS access point creation returned no id");
  return id;
}

/**
 * Delete a project's EFS access point — its files become unreachable (no
 * future machine can mount them). The directory's DATA stays on the
 * filesystem (EFS has no recursive-delete API); a storage-cleanup sweep is
 * the documented follow-up. Idempotent: an already-deleted AP is success.
 */
export async function deleteAccessPoint(
  config: AwsComputeConfig,
  accessPointId: string,
): Promise<void> {
  const client = efs(config.region);
  try {
    await client.send(
      new DeleteAccessPointCommand({ AccessPointId: accessPointId }),
    );
  } catch (e) {
    if ((e as { name?: string }).name === "AccessPointNotFound") return;
    throw e;
  }
}

/** One task definition family per user (it embeds their access point). */
export async function registerTaskDefinition(
  config: AwsComputeConfig,
  hash12: string,
  accessPointId: string,
  agentEnv: Record<string, string>,
): Promise<string> {
  const result = await ecs(config.region).send(
    new RegisterTaskDefinitionCommand({
      family: `sanad-ws-${hash12}`,
      requiresCompatibilities: ["FARGATE"],
      networkMode: "awsvpc",
      cpu: "512",
      memory: "2048",
      executionRoleArn: config.executionRoleArn,
      taskRoleArn: config.taskRoleArn,
      volumes: [
        {
          name: "data",
          efsVolumeConfiguration: {
            fileSystemId: config.efsId,
            transitEncryption: "ENABLED",
            authorizationConfig: { accessPointId, iam: "DISABLED" },
          },
        },
      ],
      containerDefinitions: [
        {
          name: "workspace",
          image: config.workspaceImage,
          essential: true,
          environment: Object.entries(agentEnv).map(([name, value]) => ({
            name,
            value,
          })),
          mountPoints: [{ sourceVolume: "data", containerPath: "/data" }],
          portMappings: [7070, 3000, 5173, 8000, 8080].map((p) => ({
            containerPort: p,
            protocol: "tcp" as const,
          })),
          logConfiguration: {
            logDriver: "awslogs",
            options: {
              "awslogs-group": config.logGroup,
              "awslogs-region": config.region,
              "awslogs-stream-prefix": hash12,
            },
          },
        },
      ],
    }),
  );
  const arn = result.taskDefinition?.taskDefinitionArn;
  if (!arn) throw new Error("task definition registration returned no ARN");
  return arn;
}

export interface RunningTask {
  taskArn: string;
  privateIp: string;
}

export async function runWorkspaceTask(
  config: AwsComputeConfig,
  taskDefinitionArn: string,
  overrideEnv: Record<string, string>,
): Promise<string> {
  const result = await ecs(config.region).send(
    new RunTaskCommand({
      cluster: config.cluster,
      taskDefinition: taskDefinitionArn,
      launchType: "FARGATE",
      count: 1,
      networkConfiguration: {
        awsvpcConfiguration: {
          subnets: config.subnets,
          securityGroups: [config.tasksSecurityGroup],
          assignPublicIp: "ENABLED", // public subnets, no NAT (dogfood posture)
        },
      },
      overrides: {
        containerOverrides: [
          {
            name: "workspace",
            environment: Object.entries(overrideEnv).map(([name, value]) => ({
              name,
              value,
            })),
          },
        ],
      },
    }),
  );
  const arn = result.tasks?.[0]?.taskArn;
  if (!arn) {
    const reason = result.failures?.[0]?.reason ?? "unknown failure";
    throw new Error(`RunTask failed: ${reason}`);
  }
  return arn;
}

export async function describeTask(
  config: AwsComputeConfig,
  taskArn: string,
): Promise<{
  status: string;
  privateIp: string | null;
  imageDigest: string | null;
}> {
  const result = await ecs(config.region).send(
    new DescribeTasksCommand({ cluster: config.cluster, tasks: [taskArn] }),
  );
  const task = result.tasks?.[0];
  if (!task) return { status: "MISSING", privateIp: null, imageDigest: null };
  const ip =
    task.attachments
      ?.flatMap((a) => a.details ?? [])
      .find((d) => d.name === "privateIPv4Address")?.value ?? null;
  return {
    status: task.lastStatus ?? "UNKNOWN",
    privateIp: ip,
    imageDigest: task.containers?.[0]?.imageDigest ?? null,
  };
}

export async function stopTask(
  config: AwsComputeConfig,
  taskArn: string,
): Promise<void> {
  await ecs(config.region).send(
    new StopTaskCommand({
      cluster: config.cluster,
      task: taskArn,
      reason: "sanad reconcile",
    }),
  );
}

let ecrClient: ECRClient | null = null;
let digestCache: { digest: string | null; at: number } = {
  digest: null,
  at: 0,
};

/**
 * The digest currently behind the workspace image tag, cached briefly. Used
 * to notice that a quiet machine is running yesterday's image and recycle it
 * on its next wake — busy machines are never touched.
 */
export async function latestWorkspaceImageDigest(
  config: AwsComputeConfig,
): Promise<string | null> {
  if (Date.now() - digestCache.at < 60_000) return digestCache.digest;
  try {
    const ref = config.workspaceImage; // <acct>.dkr.ecr.<region>.amazonaws.com/<repo>:<tag>
    const slash = ref.indexOf("/");
    const repoAndTag = slash >= 0 ? ref.slice(slash + 1) : ref;
    const colon = repoAndTag.lastIndexOf(":");
    const repositoryName = colon >= 0 ? repoAndTag.slice(0, colon) : repoAndTag;
    const tag = colon >= 0 ? repoAndTag.slice(colon + 1) : "latest";
    if (!repositoryName) return null;
    ecrClient ??= new ECRClient({ region: config.region });
    const result = await ecrClient.send(
      new DescribeImagesCommand({
        repositoryName,
        imageIds: [{ imageTag: tag }],
      }),
    );
    const digest = result.imageDetails?.[0]?.imageDigest ?? null;
    digestCache = { digest, at: Date.now() };
    return digest;
  } catch {
    // ECR read denied/unavailable — freshness checks just switch off.
    digestCache = { digest: null, at: Date.now() };
    return null;
  }
}
