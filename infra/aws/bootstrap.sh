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

say()  { printf '\n\033[1m== %s ==\033[0m\n' "$*"; }
note() { printf '   %s\n' "$*"; }

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

if [ "$PHASE" = "finish" ]; then
  say "FINISH: waiting for certificates, then creating the HTTPS listener"
  ALB_ARN=$(aws elbv2 describe-load-balancers --names sanad-compute --query 'LoadBalancers[0].LoadBalancerArn' --output text)
  CERT_ARNS=()
  for d in "${DOMAINS[@]}"; do
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
    --certificates CertificateArn="${CERT_ARNS[1]}" CertificateArn="${CERT_ARNS[2]}" >/dev/null 2>&1 || true
  note "SNI certificates attached"
  say "DONE — the compute ingress is fully live. Paste this output back to Claude."
  echo "LISTENER_ARN=$LISTENER"
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
