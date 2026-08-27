#!/usr/bin/env bash
# Enable dev-server previews: *.preview.sanadcode.com — run in AWS CloudShell
# (eu-central-1).
#
#   bash preview-enable.sh          # widen the SG + request the cert, print the DNS record
#   bash preview-enable.sh finish   # AFTER GoDaddy DNS: wait for ISSUED, attach, verify
#
# Idempotent: safe to re-run at any point. Touches ONLY three things —
# an ingress rule on sanad-tasks-sg, one ACM certificate, and an SNI
# certificate on the existing 443 listener. It does NOT create or modify the
# ALB, ECS services, EFS, or IAM; use bootstrap.sh for those.
#
# Why this exists: the router already routes
# <hash12>-<port>.preview.sanadcode.com -> task:<port>, and the wildcard DNS
# already resolves, but (a) the listener's certificate covers only
# compute.sanadcode.com, so TLS fails before the router is ever consulted,
# and (b) sanad-tasks-sg admits the router on just five fixed ports, so a dev
# server on anything else is refused at the network layer.

set -uo pipefail
REGION="eu-central-1"
export AWS_DEFAULT_REGION="$REGION"
PHASE="${1:-cert}"

DOMAIN="*.preview.sanadcode.com"
ALB_NAME="sanad-compute"

# Logs to STDERR — helpers are called inside $(...) and stray stdout would
# corrupt captured ids (the bug that emptied ALB_DNS on bootstrap's first run).
say()  { printf '\n\033[1m== %s ==\033[0m\n' "$*" >&2; }
note() { printf '   %s\n' "$*" >&2; }
die()  { printf '\n\033[1mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

ACCT=$(aws sts get-caller-identity --query Account --output text) || die "no AWS credentials"
note "Account: $ACCT   Region: $REGION"

cert_arn_for() {
  aws acm list-certificates --includes keyTypes=RSA_2048,EC_prime256v1 \
    --query "CertificateSummaryList[?DomainName=='$1'].CertificateArn | [0]" --output text
}

# ---------------------------------------------------------------- finish ---
if [ "$PHASE" = "finish" ]; then
  say "FINISH: wait for the certificate, attach it, verify"
  ARN=$(cert_arn_for "$DOMAIN")
  if [ "$ARN" = "None" ] || [ -z "$ARN" ]; then
    die "no certificate for $DOMAIN — run 'bash preview-enable.sh' first"
  fi

  STATUS=$(aws acm describe-certificate --certificate-arn "$ARN" --query 'Certificate.Status' --output text)
  note "certificate status: $STATUS"
  if [ "$STATUS" != "ISSUED" ]; then
    note "waiting for DNS validation (Ctrl-C is safe — re-run this phase later) …"
    aws acm wait certificate-validated --certificate-arn "$ARN" \
      || die "still not validated. Check the CNAME in GoDaddy — the Name field must NOT include '.sanadcode.com' (GoDaddy appends it)."
  fi
  note "ISSUED"

  if [ -n "${LISTENER_ARN:-}" ]; then
    ALB_ARN="(supplied listener)"
  else
    ALB_ARN=$(aws elbv2 describe-load-balancers --names "$ALB_NAME" --query 'LoadBalancerArn' --output text 2>/dev/null)
    if [ -z "$ALB_ARN" ] || [ "$ALB_ARN" = "None" ]; then
      ALB_ARN=$(aws elbv2 describe-load-balancers --names "$ALB_NAME" --query 'LoadBalancers[0].LoadBalancerArn' --output text) \
        || die "load balancer $ALB_NAME not readable — pass LISTENER_ARN=… instead"
    fi
  fi
  LISTENER="${LISTENER_ARN:-$(aws elbv2 describe-listeners --load-balancer-arn "$ALB_ARN" \
    --query "Listeners[?Port==\`443\`].ListenerArn | [0]" --output text)}"
  if [ "$LISTENER" = "None" ] || [ -z "$LISTENER" ]; then
    die "no HTTPS listener on $ALB_NAME — run 'bash bootstrap.sh finish' first"
  fi

  # ADDITIVE: an SNI certificate alongside the listener's default. The
  # compute.sanadcode.com certificate is untouched, so live PTY traffic
  # cannot be disrupted by this step.
  if aws elbv2 add-listener-certificates --listener-arn "$LISTENER" \
       --certificates CertificateArn="$ARN" >/dev/null 2>&1; then
    note "attached as SNI certificate"
  else
    note "already attached (or attach failed — verify below)"
  fi

  say "VERIFY"
  note "TLS handshake against a preview hostname (404/503 from the router is SUCCESS —"
  note "it means TLS passed and the router answered; only a TLS error is a failure):"
  echo
  echo "  curl -sv https://000000000000-3000.preview.sanadcode.com/ 2>&1 | grep -E 'subjectAltName|SSL certificate|HTTP/'"
  echo
  say "DONE — previews are live once sanad-web ships the redirect route (PR #18)."
  exit 0
fi

# ---------------------------------------------------------------- diagnose ---
if [ "$PHASE" = "diagnose" ]; then
  say "DIAGNOSE — what actually exists in this account"
  echo "--- load balancers ---" >&2
  aws elbv2 describe-load-balancers \
    --query 'LoadBalancers[].{Name:LoadBalancerName,VpcId:VpcId,DNS:DNSName}' --output table 2>&1 | head -20
  echo "--- security groups named sanad-* (all VPCs) ---" >&2
  aws ec2 describe-security-groups --filters "Name=group-name,Values=sanad-*" \
    --query 'SecurityGroups[].{Name:GroupName,Id:GroupId,VpcId:VpcId}' --output table 2>&1 | head -30
  echo "--- ECS clusters/services ---" >&2
  for c in $(aws ecs list-clusters --query 'clusterArns[]' --output text 2>/dev/null); do
    echo "cluster: $c" >&2
    aws ecs list-services --cluster "$c" --query 'serviceArns[]' --output text 2>&1 | head -10
  done
  echo "--- ACM certificates ---" >&2
  aws acm list-certificates \
    --query 'CertificateSummaryList[].{Domain:DomainName,Status:Status,Arn:CertificateArn}' --output table 2>&1 | head -20
  say "Send this output back."
  exit 0
fi

# ------------------------------------------------------ security group ---
say "Security group: let the router reach ANY dev-server port"

# The stack's VPC is wherever the ALB actually lives. bootstrap.sh assumed the
# DEFAULT VPC, which is not necessarily where this account's stack was built —
# and guessing wrong makes the security groups look absent when they are fine.
ALB_ERR=$(mktemp)
VPC=$(aws elbv2 describe-load-balancers --names "$ALB_NAME" \
        --query 'LoadBalancers[0].VpcId' --output text 2>"$ALB_ERR")
if [ "$VPC" = "None" ] || [ -z "$VPC" ]; then
  # Surface the REAL reason. An IAM AccessDenied here is indistinguishable
  # from "no such load balancer" once stderr is discarded, and that sent the
  # first two runs chasing a non-existent naming problem.
  if [ -s "$ALB_ERR" ]; then
    note "describe-load-balancers failed:"
    sed 's/^/      /' "$ALB_ERR" >&2
  fi
  note "could not read the VPC from $ALB_NAME — falling back to the default VPC"
  VPC=$(aws ec2 describe-vpcs --filters Name=is-default,Values=true --query 'Vpcs[0].VpcId' --output text)
fi
note "VPC=$VPC (from $ALB_NAME)"

# Look up by name inside that VPC; if the name was never used there, fall back
# to a name lookup across ALL VPCs before giving up. Explicit overrides win:
#   TASKS_SG=sg-… ROUTER_SG=sg-… bash preview-enable.sh
sg_lookup() { # name
  local id err
  err=$(mktemp)
  id=$(aws ec2 describe-security-groups \
        --filters "Name=group-name,Values=$1" "Name=vpc-id,Values=$VPC" \
        --query 'SecurityGroups[0].GroupId' --output text 2>"$err")
  if [ "$id" = "None" ] || [ -z "$id" ]; then
    id=$(aws ec2 describe-security-groups \
          --filters "Name=group-name,Values=$1" \
          --query 'SecurityGroups[0].GroupId' --output text 2>"$err")
  fi
  if { [ "$id" = "None" ] || [ -z "$id" ]; } && [ -s "$err" ]; then
    note "describe-security-groups($1) failed:"
    sed 's/^/      /' "$err" >&2
  fi
  rm -f "$err"
  echo "$id"
}

TASKS_SG="${TASKS_SG:-$(sg_lookup sanad-tasks-sg)}"
ROUTER_SG="${ROUTER_SG:-$(sg_lookup sanad-router-sg)}"

if [ "$TASKS_SG" = "None" ] || [ -z "$TASKS_SG" ] || [ "$ROUTER_SG" = "None" ] || [ -z "$ROUTER_SG" ]; then
  note "tasks=$TASKS_SG  router=$ROUTER_SG"
  say "Could not find the security groups by name. Run this and send the output:"
  cat >&2 <<'DIAG'

  bash preview-enable.sh diagnose

  …or pass the ids directly, if you know them (sanad-web's env has them as
  SANAD_TASKS_SG):

  TASKS_SG=sg-xxxx ROUTER_SG=sg-yyyy bash preview-enable.sh

DIAG
  exit 1
fi
note "tasks=$TASKS_SG  router=$ROUTER_SG"

# 1024-65535 from the ROUTER security group only — never the internet. Below
# 1024 is deliberately excluded: the container's unprivileged `dev` user
# cannot bind there, so opening it would add reachability with no use case.
# The old five single-port rules are left in place; they are subsumed and
# harmless, and removing them would be a needless disruption.
if aws ec2 authorize-security-group-ingress --group-id "$TASKS_SG" \
     --protocol tcp --port 1024-65535 --source-group "$ROUTER_SG" >/dev/null 2>&1; then
  note "opened tcp 1024-65535 from the router"
else
  note "rule already present (or unchanged)"
fi

# ------------------------------------------------------------------ ACM ---
say "ACM certificate for $DOMAIN"
ARN=$(cert_arn_for "$DOMAIN")
if [ "$ARN" = "None" ] || [ -z "$ARN" ]; then
  ARN=$(aws acm request-certificate --domain-name "$DOMAIN" \
    --validation-method DNS --query CertificateArn --output text) || die "request-certificate failed"
  note "requested: $ARN"
  sleep 5
else
  note "already requested: $ARN"
fi

STATUS=$(aws acm describe-certificate --certificate-arn "$ARN" --query 'Certificate.Status' --output text)
if [ "$STATUS" = "ISSUED" ]; then
  say "ALREADY ISSUED — skip the DNS step and run:  bash preview-enable.sh finish"
  exit 0
fi

NAME=""; VALUE=""
for _ in $(seq 1 12); do
  NAME=$(aws acm describe-certificate --certificate-arn "$ARN" \
    --query 'Certificate.DomainValidationOptions[0].ResourceRecord.Name' --output text)
  VALUE=$(aws acm describe-certificate --certificate-arn "$ARN" \
    --query 'Certificate.DomainValidationOptions[0].ResourceRecord.Value' --output text)
  [ "$NAME" != "None" ] && [ -n "$NAME" ] && break
  sleep 5
done
if [ "$NAME" = "None" ] || [ -z "$NAME" ]; then
  die "ACM has not published a validation record yet — re-run in a minute"
fi

# GoDaddy appends the domain to whatever goes in the Name field, so the
# record must be entered WITHOUT the .sanadcode.com suffix. Pasting the full
# name silently creates <name>.sanadcode.com.sanadcode.com and the
# certificate sits in PENDING_VALIDATION forever, looking like AWS is slow.
GD_HOST="${NAME%.sanadcode.com.}"
GD_HOST="${GD_HOST%.sanadcode.com}"

cat >&2 <<EOF

$(printf '\033[1m== ADD THIS RECORD IN GODADDY ==\033[0m')

   Type:  CNAME
   Name:  $GD_HOST
   Value: $VALUE
   TTL:   default (1 hour)

   The Name above is ALREADY stripped of ".sanadcode.com" — GoDaddy appends
   your domain automatically. Paste it exactly as shown. Do not add a trailing
   dot to the Name. The Value is used verbatim.

   (ACM's fully-qualified name, for reference: $NAME)

   Then run:   bash preview-enable.sh finish

EOF
