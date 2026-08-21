/**
 * The customer-facing contract for the deployment signal: the one signed call an
 * app's own pipeline makes to tell Autonoma a preview is live.
 *
 * Shared because it is handed out from two places that must not drift - the
 * onboarding UI's "connect your deploys" step and the onboarding MCP's
 * `get_signal_setup`. A customer who reads one and an agent that reads the other
 * have to be looking at the same thing.
 *
 * The workflow is a STARTING POINT, not the integration. Autonoma requires only
 * the signed POST; hanging it off GitHub's `deployment_status` (or, on GitLab, a
 * job after the deploy in the same pipeline) is one way to make that call, and
 * plenty of pipelines never emit that event.
 */

/** The repository secret the signal body is signed with. */
export const DEPLOYMENT_SIGNAL_SECRET_NAME = "AUTONOMA_SHARED_SECRET";

/** Conventional path for the starter workflow, when a project uses GitHub Actions. */
export const DEPLOYMENT_SIGNAL_WORKFLOW_PATH = ".github/workflows/autonoma-preview.yml";

/**
 * Every field the signal body accepts, and what it is for. `branch` and
 * `prNumber` travel together on purpose: a signal carrying neither is recorded
 * as a main-branch deploy, and one carrying `branch` without `prNumber` is
 * dropped entirely.
 */
export const DEPLOYMENT_SIGNAL_BODY_FIELDS: Readonly<Record<string, string>> = {
    applicationId: "required - the app this preview belongs to",
    previewUrl: "required - the URL Autonoma should open in a browser",
    branch: "send WITH prNumber on a pull-request deploy; a branch without a prNumber is dropped",
    prNumber: "send WITH branch - this is what turns a signal into a per-PR review",
    sdkUrl: "optional - only when the Autonoma SDK endpoint is on a different origin than previewUrl",
    sha: "optional - the deployed commit",
    provider: "optional - a free-text label for where the deploy came from",
};

export interface DeploymentSignalWorkflowParams {
    /** The app the signal is for. Callers pass a placeholder when it is not loaded yet. */
    applicationId: string;
    /** Full URL of the deployment-signal endpoint, including scheme and host. */
    endpoint: string;
}

/**
 * A GitHub Actions workflow that makes the signed call after a successful
 * deployment. Suits hosts that report deployments back to GitHub; anything else
 * should make the same call from whatever step knows a preview is live.
 */
export function buildDeploymentSignalWorkflow({ applicationId, endpoint }: DeploymentSignalWorkflowParams): string {
    return `# ${DEPLOYMENT_SIGNAL_WORKFLOW_PATH}
name: Autonoma preview signal

on:
  deployment_status:

jobs:
  notify:
    if: github.event.deployment_status.state == 'success'
    runs-on: ubuntu-latest
    steps:
      - name: Notify Autonoma
        env:
          AUTONOMA_SHARED_SECRET: \${{ secrets.${DEPLOYMENT_SIGNAL_SECRET_NAME} }}
          AUTONOMA_ENDPOINT: ${endpoint}
          AUTONOMA_APPLICATION_ID: ${applicationId}
          PREVIEW_URL: \${{ github.event.deployment_status.target_url }}
          PREVIEW_SHA: \${{ github.event.deployment.sha || github.sha }}
        run: |
          BODY=$(jq -nc \\
            --arg applicationId "$AUTONOMA_APPLICATION_ID" \\
            --arg previewUrl "$PREVIEW_URL" \\
            --arg sha "$PREVIEW_SHA" \\
            --arg provider "custom" \\
            '{applicationId:$applicationId,previewUrl:$previewUrl,provider:$provider}
              + (if $sha == "" then {} else {sha:$sha} end)')
          SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$AUTONOMA_SHARED_SECRET" -hex | sed 's/^.* //')
          curl -sS -X POST "$AUTONOMA_ENDPOINT" \\
            -H "content-type: application/json" \\
            -H "x-signature: $SIG" \\
            --data "$BODY"`;
}

/** Conventional home for the starter job, when a project uses GitLab CI. */
export const DEPLOYMENT_SIGNAL_GITLAB_CI_PATH = ".gitlab-ci.yml";

/**
 * A GitLab CI job that makes the signed call after the deploy job in the same
 * pipeline. GitLab has no cross-host `deployment_status` event, so the job runs
 * in the pipeline itself: merge-request pipelines carry `CI_MERGE_REQUEST_IID`,
 * which is what turns the signal into a per-MR review; a default-branch pipeline
 * sends neither branch nor number and records a main-branch deploy.
 */
export function buildDeploymentSignalGitLabJob({ applicationId, endpoint }: DeploymentSignalWorkflowParams): string {
    return `# Add to ${DEPLOYMENT_SIGNAL_GITLAB_CI_PATH} - runs after your deploy job in the same pipeline.
# Set PREVIEW_URL to wherever that pipeline's deploy actually went live.
autonoma_preview_signal:
  stage: .post
  image: alpine:3.20
  rules:
    - if: '$CI_PIPELINE_SOURCE == "merge_request_event"'
    - if: '$CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH'
  variables:
    AUTONOMA_ENDPOINT: "${endpoint}"
    AUTONOMA_APPLICATION_ID: "${applicationId}"
    PREVIEW_URL: "$CI_ENVIRONMENT_URL" # or the URL your deploy job knows
  script:
    - apk add --no-cache curl jq openssl
    - |
      if [ -n "$CI_MERGE_REQUEST_IID" ]; then
        BODY=$(jq -nc \\
          --arg applicationId "$AUTONOMA_APPLICATION_ID" \\
          --arg previewUrl "$PREVIEW_URL" \\
          --arg branch "$CI_COMMIT_REF_NAME" \\
          --argjson prNumber "$CI_MERGE_REQUEST_IID" \\
          --arg sha "$CI_COMMIT_SHA" \\
          '{applicationId:$applicationId,previewUrl:$previewUrl,branch:$branch,prNumber:$prNumber,sha:$sha,provider:"gitlab-ci"}')
      else
        BODY=$(jq -nc \\
          --arg applicationId "$AUTONOMA_APPLICATION_ID" \\
          --arg previewUrl "$PREVIEW_URL" \\
          --arg sha "$CI_COMMIT_SHA" \\
          '{applicationId:$applicationId,previewUrl:$previewUrl,sha:$sha,provider:"gitlab-ci"}')
      fi
      SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$${DEPLOYMENT_SIGNAL_SECRET_NAME}" -hex | sed 's/^.* //')
      curl -sS -X POST "$AUTONOMA_ENDPOINT" \\
        -H "content-type: application/json" \\
        -H "x-signature: $SIG" \\
        --data "$BODY"`;
}
