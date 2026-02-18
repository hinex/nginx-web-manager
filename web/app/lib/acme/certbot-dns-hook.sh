#!/usr/bin/env bash
# certbot-dns-hook.sh
#
# This script is called by certbot as --manual-auth-hook and --manual-cleanup-hook.
# It communicates with the nginx-manager API to create/remove DNS TXT records
# for ACME DNS-01 challenge validation.
#
# Usage:
#   certbot-dns-hook.sh auth <credentialId>
#   certbot-dns-hook.sh cleanup <credentialId>
#
# Environment variables set by certbot:
#   CERTBOT_DOMAIN      - The domain being validated
#   CERTBOT_VALIDATION  - The validation token value
#   CERTBOT_AUTH_OUTPUT  - (cleanup only) Output from the auth hook
#
# The auth hook outputs "recordId:zoneId" on stdout, which certbot passes
# to the cleanup hook via CERTBOT_AUTH_OUTPUT.

set -euo pipefail

ACTION="$1"
CREDENTIAL_ID="$2"
API_BASE="${NGINX_MANAGER_API_URL:-http://127.0.0.1:3000}"
API_KEY="${NGINX_MANAGER_HOOK_KEY:-}"

case "$ACTION" in
  auth)
    # Create the DNS challenge record
    RESPONSE=$(curl -sf -X POST "${API_BASE}/api/acme-dns" \
      -H "Content-Type: application/json" \
      -H "X-Hook-Key: ${API_KEY}" \
      -d "{
        \"action\": \"create-challenge\",
        \"domain\": \"${CERTBOT_DOMAIN}\",
        \"validationToken\": \"${CERTBOT_VALIDATION}\",
        \"credentialId\": ${CREDENTIAL_ID}
      }")

    RECORD_ID=$(echo "$RESPONSE" | grep -o '"recordId":"[^"]*"' | cut -d'"' -f4)
    ZONE_ID=$(echo "$RESPONSE" | grep -o '"zoneId":"[^"]*"' | cut -d'"' -f4)

    if [ -z "$RECORD_ID" ] || [ -z "$ZONE_ID" ]; then
      echo "ERROR: Failed to create DNS challenge record" >&2
      echo "Response: $RESPONSE" >&2
      exit 1
    fi

    # Wait for propagation
    sleep 30

    # Output record info for cleanup hook
    echo "${RECORD_ID}:${ZONE_ID}"
    ;;

  cleanup)
    # Parse the auth output to get record info
    if [ -z "${CERTBOT_AUTH_OUTPUT:-}" ]; then
      echo "WARNING: No auth output available for cleanup" >&2
      exit 0
    fi

    RECORD_ID=$(echo "$CERTBOT_AUTH_OUTPUT" | cut -d':' -f1)
    ZONE_ID=$(echo "$CERTBOT_AUTH_OUTPUT" | cut -d':' -f2)

    if [ -z "$RECORD_ID" ] || [ -z "$ZONE_ID" ]; then
      echo "WARNING: Could not parse record/zone IDs from auth output" >&2
      exit 0
    fi

    # Delete the DNS challenge record
    curl -sf -X POST "${API_BASE}/api/acme-dns" \
      -H "Content-Type: application/json" \
      -H "X-Hook-Key: ${API_KEY}" \
      -d "{
        \"action\": \"cleanup-challenge\",
        \"zoneId\": \"${ZONE_ID}\",
        \"recordId\": \"${RECORD_ID}\",
        \"credentialId\": ${CREDENTIAL_ID}
      }" > /dev/null 2>&1 || true
    ;;

  *)
    echo "Usage: $0 {auth|cleanup} <credentialId>" >&2
    exit 1
    ;;
esac
