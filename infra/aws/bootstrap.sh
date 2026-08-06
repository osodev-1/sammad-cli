#!/usr/bin/env bash
# sanad-compute AWS bootstrap (B0) — run in AWS CloudShell (eu-central-1).
#
#   bash bootstrap.sh          # create everything + request certs, print DNS records
#   bash bootstrap.sh finish   # AFTER GoDaddy DNS: wait for certs, create the HTTPS listener
#
# Idempotent: safe to re-run; existing resources are reused. Creates ONLY
# sanad-* named resources inside the account's default VPC. Nothing here
# touches Railway or existing workloads.

set -uo pipefail
REGION="eu-central-1"
export AWS_DEFAULT_REGION="$REGION"
PHASE="${1:-all}"

DOMAINS=("compute.sanadcode.com" "*.preview.sanadcode.com" "*.apps.sanadcode.com")

# Logs go to STDERR: several helpers are called inside $(...) command
# substitutions, and anything they printed to stdout would corrupt the
# captured resource ids (the bug that emptied ALB_DNS on the first run).
say()  { printf '\n\033[1m== %s ==\033[0m\n' "$*" >&2; }
note() { printf '   %s\n' "$*" >&2; }

ACCT=$(aws sts get-caller-identity --query Account --output text)
note "Account: $ACCT   Region: $REGION"

# ---------------------------------------------------------------- helpers ---
sg_id() { aws ec2 describe-security-groups --filters "Name=group-name,Values=$1" "Name=vpc-id,Values=$VPC" --query 'SecurityGroups[0].GroupId' --output text 2>/dev/null; }

ensure_sg() { # name description
  local id; id=$(sg_id "$1")
  if [ "$id" = "None" ] || [ -z "$id" ]; then
    id=$(aws ec2 create-security-group --group-name "$1" --description "$2" --vpc-id "$VPC" --query GroupId --output text)
    note "created SG $1 = $id"
  else
    note "SG $1 exists = $id"
  fi
  echo "$id"
}

allow() { # sg-id proto port source-sg-id|cidr
  if [[ "$4" == sg-* ]]; then
    aws ec2 authorize-security-group-ingress --group-id "$1" --protocol "$2" --port "$3" --source-group "$4" >/dev/null 2>&1 || true
  else
    aws ec2 authorize-security-group-ingress --group-id "$1" --protocol "$2" --port "$3" --cidr "$4" >/dev/null 2>&1 || true
  fi
}

# ------------------------------------------------------------------ certs ---
cert_arn_for() { aws acm list-certificates --includes keyTypes=RSA_2048,EC_prime256v1 --query "CertificateSummaryList[?DomainName=='$1'].CertificateArn | [0]" --output text; }

# ----------------------------------------------------------- router phase ---
# Deploys the sanad-router ECS service behind the ALB. Run AFTER `finish` and
# after the sanad-router image exists in ECR:
#     ROUTER_SHARED_SECRET=<same value as on sanad-web> bash bootstrap.sh router
if [ "$PHASE" = "router" ]; then
  : "${ROUTER_SHARED_SECRET:?set ROUTER_SHARED_SECRET=<value> (same as sanad-web)}"
  say "ROUTER: target group + listener rules + ECS service"
  VPC=$(aws ec2 describe-vpcs --filters Name=is-default,Values=true --query 'Vpcs[0].VpcId' --output text)
  SUBNETS=$(aws ec2 describe-subnets --filters "Name=vpc-id,Values=$VPC" --query 'Subnets[].SubnetId' --output text)
  ROUTER_SG=$(aws ec2 describe-security-groups --filters "Name=group-name,Values=sanad-router-sg" "Name=vpc-id,Values=$VPC" --query 'SecurityGroups[0].GroupId' --output text)
  ALB_ARN=$(aws elbv2 describe-load-balancers --names sanad-compute --query 'LoadBalancers[0].LoadBalancerArn' --output text)
  LISTENER=$(aws elbv2 describe-listeners --load-balancer-arn "$ALB_ARN" --query "Listeners[?Port==\`443\`].ListenerArn | [0]" --output text)
  [ "$LISTENER" = "None" ] && { echo "ERROR: run 'bash bootstrap.sh finish' first"; exit 1; }

  TG_ARN=$(aws elbv2 describe-target-groups --names sanad-router --query 'TargetGroups[0].TargetGroupArn' --output text 2>/dev/null)
  if [ "$TG_ARN" = "None" ] || [ -z "$TG_ARN" ]; then
    TG_ARN=$(aws elbv2 create-target-group --name sanad-router --protocol HTTP --port 8080 \
      --vpc-id "$VPC" --target-type ip --health-check-path /healthz \
      --query 'TargetGroups[0].TargetGroupArn' --output text)
    note "created target group"
  else
    note "target group exists"
  fi

  # Host rules: compute + preview hosts → router. (apps hosts come with Phase E.)
  EXISTING_RULES=$(aws elbv2 describe-rules --listener-arn "$LISTENER" --query 'Rules[].Conditions[].HostHeaderConfig.Values[]' --output text 2>/dev/null || true)
  if ! grep -q "compute.sanadcode.com" <<<"$EXISTING_RULES"; then
    aws elbv2 create-rule --listener-arn "$LISTENER" --priority 10 \
      --conditions "Field=host-header,HostHeaderConfig={Values=[compute.sanadcode.com]}" \
      --actions "Type=forward,TargetGroupArn=$TG_ARN" >/dev/null
    note "rule: compute.sanadcode.com → router"
  fi
  if ! grep -q "preview.sanadcode.com" <<<"$EXISTING_RULES"; then
    aws elbv2 create-rule --listener-arn "$LISTENER" --priority 11 \
      --conditions "Field=host-header,HostHeaderConfig={Values=[*.preview.sanadcode.com]}" \
      --actions "Type=forward,TargetGroupArn=$TG_ARN" >/dev/null
    note "rule: *.preview.sanadcode.com → router"
  fi

  say "router task definition + service"
  cat > /tmp/sanad-router-td.json <<TDEOF
{
  "family": "sanad-router",
  "requiresCompatibilities": ["FARGATE"],
  "networkMode": "awsvpc",
  "cpu": "256",
  "memory": "512",
  "executionRoleArn": "arn:aws:iam::$ACCT:role/sanad-task-execution",
  "containerDefinitions": [{
    "name": "router",
    "image": "$ACCT.dkr.ecr.$REGION.amazonaws.com/sanad-router:latest",
    "essential": true,
    "portMappings": [{"containerPort": 8080, "protocol": "tcp"}],
    "environment": [
      {"name": "ROUTER_SHARED_SECRET", "value": "$ROUTER_SHARED_SECRET"},
      {"name": "CONTROL_PLANE_URL", "value": "https://www.sanadcode.com"}
    ],
    "logConfiguration": {"logDriver": "awslogs", "options": {
      "awslogs-group": "/sanad/workspaces", "awslogs-region": "$REGION", "awslogs-stream-prefix": "router"}}
  }]
}
TDEOF
  TD_ARN=$(aws ecs register-task-definition --cli-input-json file:///tmp/sanad-router-td.json --query 'taskDefinition.taskDefinitionArn' --output text)
  note "task definition: $TD_ARN"

  SUBNET_LIST=$(echo $SUBNETS | tr ' ' ',')
  if aws ecs describe-services --cluster sanad-workspaces --services sanad-router --query 'services[0].status' --output text 2>/dev/null | grep -q ACTIVE; then
    aws ecs update-service --cluster sanad-workspaces --service sanad-router --task-definition "$TD_ARN" --force-new-deployment >/dev/null
    note "service updated"
  else
    aws ecs create-service --cluster sanad-workspaces --service-name sanad-router \
      --task-definition "$TD_ARN" --desired-count 1 --launch-type FARGATE \
      --network-configuration "awsvpcConfiguration={subnets=[$SUBNET_LIST],securityGroups=[$ROUTER_SG],assignPublicIp=ENABLED}" \
      --load-balancers "targetGroupArn=$TG_ARN,containerName=router,containerPort=8080" >/dev/null
    note "service created"
  fi
  say "DONE — router deploying; verify:  curl https://compute.sanadcode.com/healthz"
  exit 0
fi

if [ "$PHASE" = "finish" ]; then
  # Workspaces need only the compute + preview certs; *.apps (Phase E / ships)
  # attaches later via `bash bootstrap.sh apps-cert` — never block on it here.
  say "FINISH: waiting for compute + preview certificates, then the HTTPS listener"
  ALB_ARN=$(aws elbv2 describe-load-balancers --names sanad-compute --query 'LoadBalancers[0].LoadBalancerArn' --output text)
  CERT_ARNS=()
  for d in "compute.sanadcode.com" "*.preview.sanadcode.com"; do
    arn=$(cert_arn_for "$d")
    [ "$arn" = "None" ] && { echo "ERROR: no certificate found for $d — run the main phase first"; exit 1; }
    note "waiting for $d …"
    aws acm wait certificate-validated --certificate-arn "$arn"
    note "ISSUED: $d"
    CERT_ARNS+=("$arn")
  done
  LISTENER=$(aws elbv2 describe-listeners --load-balancer-arn "$ALB_ARN" --query "Listeners[?Port==\`443\`].ListenerArn | [0]" --output text)
  if [ "$LISTENER" = "None" ] || [ -z "$LISTENER" ]; then
    LISTENER=$(aws elbv2 create-listener --load-balancer-arn "$ALB_ARN" --protocol HTTPS --port 443 \
      --certificates CertificateArn="${CERT_ARNS[0]}" \
      --default-actions 'Type=fixed-response,FixedResponseConfig={StatusCode=404,ContentType=text/plain,MessageBody=not found}' \
      --query 'Listeners[0].ListenerArn' --output text)
    note "created HTTPS listener: $LISTENER"
  else
    note "HTTPS listener exists: $LISTENER"
  fi
  aws elbv2 add-listener-certificates --listener-arn "$LISTENER" \
    --certificates CertificateArn="${CERT_ARNS[1]}" >/dev/null 2>&1 || true
  note "preview SNI certificate attached"
  say "DONE — compute ingress live. (*.apps attaches later: bash bootstrap.sh apps-cert)"
  echo "LISTENER_ARN=$LISTENER"
  exit 0
fi

if [ "$PHASE" = "apps-cert" ]; then
  say "APPS-CERT: waiting for *.apps.sanadcode.com, then attaching to the listener"
  ALB_ARN=$(aws elbv2 describe-load-balancers --names sanad-compute --query 'LoadBalancers[0].LoadBalancerArn' --output text)
  LISTENER=$(aws elbv2 describe-listeners --load-balancer-arn "$ALB_ARN" --query "Listeners[?Port==\`443\`].ListenerArn | [0]" --output text)
  arn=$(cert_arn_for "*.apps.sanadcode.com")
  [ "$arn" = "None" ] && { echo "ERROR: no certificate request for *.apps"; exit 1; }
  aws acm wait certificate-validated --certificate-arn "$arn"
  aws elbv2 add-listener-certificates --listener-arn "$LISTENER" --certificates CertificateArn="$arn" >/dev/null
  say "DONE — *.apps certificate attached"
  exit 0
fi

# ------------------------------------------------------------------- roles ---
say "IAM roles (sanad-task-execution, sanad-workspace-task)"
TRUST='{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"ecs-tasks.amazonaws.com"},"Action":"sts:AssumeRole"}]}'
aws iam create-role --role-name sanad-task-execution --assume-role-policy-document "$TRUST" >/dev/null 2>&1 || note "sanad-task-execution exists"
aws iam attach-role-policy --role-name sanad-task-execution --policy-arn arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy >/dev/null 2>&1 || true
aws iam create-role --role-name sanad-workspace-task --assume-role-policy-document "$TRUST" >/dev/null 2>&1 || note "sanad-workspace-task exists"

# -------------------------------------------------------- network (default VPC)
say "Network (default VPC + sanad security groups)"
VPC=$(aws ec2 describe-vpcs --filters Name=is-default,Values=true --query 'Vpcs[0].VpcId' --output text)
SUBNETS=$(aws ec2 describe-subnets --filters "Name=vpc-id,Values=$VPC" --query 'Subnets[].SubnetId' --output text)
note "VPC=$VPC"
note "Subnets: $SUBNETS"
ALB_SG=$(ensure_sg sanad-alb-sg "sanad ALB ingress")
ROUTER_SG=$(ensure_sg sanad-router-sg "sanad router")
TASKS_SG=$(ensure_sg sanad-tasks-sg "sanad workspace tasks")
EFS_SG=$(ensure_sg sanad-efs-sg "sanad EFS mount targets")
allow "$ALB_SG"   tcp 443  0.0.0.0/0
allow "$ROUTER_SG" tcp 8080 "$ALB_SG"
for p in 7070 3000 5173 8000 8080; do allow "$TASKS_SG" tcp "$p" "$ROUTER_SG"; done
allow "$EFS_SG"   tcp 2049 "$TASKS_SG"
allow "$EFS_SG"   tcp 2049 "$ROUTER_SG"

# -------------------------------------------------------------------- EFS ---
say "EFS filesystem (sanad-workspaces)"
EFS_ID=$(aws efs describe-file-systems --query "FileSystems[?Tags[?Key=='Name' && Value=='sanad-workspaces']].FileSystemId | [0]" --output text)
if [ "$EFS_ID" = "None" ] || [ -z "$EFS_ID" ]; then
  EFS_ID=$(aws efs create-file-system --performance-mode generalPurpose --throughput-mode elastic --encrypted \
    --tags Key=Name,Value=sanad-workspaces --query FileSystemId --output text)
  note "created EFS $EFS_ID; waiting available…"
  while [ "$(aws efs describe-file-systems --file-system-id "$EFS_ID" --query 'FileSystems[0].LifeCycleState' --output text)" != "available" ]; do sleep 3; done
else
  note "EFS exists: $EFS_ID"
fi
for sn in $SUBNETS; do
  aws efs create-mount-target --file-system-id "$EFS_ID" --subnet-id "$sn" --security-groups "$EFS_SG" >/dev/null 2>&1 || true
done
note "mount targets ensured in every default subnet"

# ------------------------------------------------------------------- ECS ----
say "ECS clusters"
aws ecs create-cluster --cluster-name sanad-workspaces >/dev/null 2>&1 || true
aws ecs create-cluster --cluster-name sanad-ships >/dev/null 2>&1 || true
note "sanad-workspaces + sanad-ships"

# ------------------------------------------------------------------- ECR ----
say "ECR repositories"
for r in sanad-workspace sanad-router sanad-apps; do
  aws ecr create-repository --repository-name "$r" >/dev/null 2>&1 || true
  note "$ACCT.dkr.ecr.$REGION.amazonaws.com/$r"
done

# -------------------------------------------------------------------- S3 ----
say "S3 ship-contexts bucket"
BUCKET="sanad-ship-contexts-$ACCT"
aws s3api create-bucket --bucket "$BUCKET" --create-bucket-configuration LocationConstraint="$REGION" >/dev/null 2>&1 || true
aws s3api put-public-access-block --bucket "$BUCKET" --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true >/dev/null 2>&1 || true
note "$BUCKET"

# ------------------------------------------------------------------- logs ---
say "CloudWatch log groups"
aws logs create-log-group --log-group-name /sanad/workspaces >/dev/null 2>&1 || true
aws logs create-log-group --log-group-name /sanad/ships >/dev/null 2>&1 || true
note "/sanad/workspaces, /sanad/ships"

# -------------------------------------------------------------------- ALB ---
say "Application Load Balancer (sanad-compute)"
ALB_DNS=$(aws elbv2 describe-load-balancers --names sanad-compute --query 'LoadBalancers[0].DNSName' --output text 2>/dev/null)
if [ "$ALB_DNS" = "None" ] || [ -z "$ALB_DNS" ]; then
  # shellcheck disable=SC2086
  ALB_DNS=$(aws elbv2 create-load-balancer --name sanad-compute --type application --scheme internet-facing \
    --security-groups "$ALB_SG" --subnets $SUBNETS --query 'LoadBalancers[0].DNSName' --output text)
  note "created ALB: $ALB_DNS"
else
  note "ALB exists: $ALB_DNS"
fi

# ------------------------------------------------------------------- ACM ----
say "ACM certificates (DNS validation)"
declare -a VAL_ROWS=()
for d in "${DOMAINS[@]}"; do
  arn=$(cert_arn_for "$d")
  if [ "$arn" = "None" ] || [ -z "$arn" ]; then
    arn=$(aws acm request-certificate --domain-name "$d" --validation-method DNS --query CertificateArn --output text)
    note "requested cert for $d"
    sleep 5
  else
    note "cert exists for $d"
  fi
  for _ in $(seq 1 12); do
    name=$(aws acm describe-certificate --certificate-arn "$arn" --query 'Certificate.DomainValidationOptions[0].ResourceRecord.Name' --output text)
    value=$(aws acm describe-certificate --certificate-arn "$arn" --query 'Certificate.DomainValidationOptions[0].ResourceRecord.Value' --output text)
    [ "$name" != "None" ] && break; sleep 5
  done
  VAL_ROWS+=("$d|$name|$value")
done

# ---------------------------------------------------------------- summary ---
say "SUMMARY — paste this whole block back to Claude"
cat <<EOF
VPC=$VPC
SUBNETS=$(echo $SUBNETS | tr ' ' ',')
ALB_SG=$ALB_SG ROUTER_SG=$ROUTER_SG TASKS_SG=$TASKS_SG EFS_SG=$EFS_SG
EFS_ID=$EFS_ID
CLUSTERS=sanad-workspaces,sanad-ships
ECR=$ACCT.dkr.ecr.$REGION.amazonaws.com/{sanad-workspace,sanad-router,sanad-apps}
BUCKET=$BUCKET
ALB_DNS=$ALB_DNS
EOF

say "GoDaddy DNS — add these 6 CNAME records now"
printf '%-34s %-6s %s\n' "HOST (Name)" "TYPE" "VALUE (Points to)"
for row in "${VAL_ROWS[@]}"; do
  IFS='|' read -r d name value <<<"$row"
  # GoDaddy wants the host RELATIVE to sanadcode.com (strip the suffix + trailing dot)
  host=${name%.sanadcode.com.}
  printf '%-34s %-6s %s\n' "$host" "CNAME" "$value"
done
printf '%-34s %-6s %s\n' "compute"   "CNAME" "$ALB_DNS"
printf '%-34s %-6s %s\n' "*.preview" "CNAME" "$ALB_DNS"
printf '%-34s %-6s %s\n' "*.apps"    "CNAME" "$ALB_DNS"

say "AFTER the DNS records are in (give it ~10 min):   bash bootstrap.sh finish"
