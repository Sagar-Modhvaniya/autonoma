# Proposal: GitLab support (draft for a GitHub Discussion / Issue)

> Post this to https://github.com/Autonoma-AI/autonoma/discussions before opening
> a PR — CONTRIBUTING.md asks for features to be vetted first.

---

**Title:** feat: GitLab support behind the existing GitHubApp interface

**Problem.** Autonoma is GitHub-only today (the troubleshooting docs call this
out explicitly). Teams on GitLab — especially self-managed instances, which are
common in exactly the kind of organization that self-hosts Autonoma — cannot
connect their repos at all, and mirroring to GitHub changes the team's whole
review workflow.

**Proposed solution.** Everything Autonoma needs from a git host already flows
through two interfaces: `GitHubApp` and `GitHubInstallationClient` (that is how
`LocalDevGitHubApp` plugs in). We implemented a GitLab provider behind those
same interfaces, plus a webhook translator, in two commits:

1. `feat(api): add GitLab provider behind the GitHubApp interface`
   - `packages/github/src/gitlab/` — `GitLabApi` (REST v4 wrapper),
     `GitLabInstallationClient` (full interface: projects ↔ repositories,
     merge requests ↔ pull requests, MR notes ↔ issue comments, commit
     statuses ↔ check runs, clone via env-injected token auth), `GitLabApp`
     (token-based; one configured connection = one synthetic installation;
     webhook verification = `X-Gitlab-Token` equality).
   - Selection in `buildGitHubApp`: `GITLAB_BASE_URL` + `GITLAB_TOKEN`
     (optional `GITLAB_WEBHOOK_SECRET`, `GITLAB_SLUG`) picks GitLab; works with
     gitlab.com and self-managed instances.
2. `feat(api): accept GitLab merge-request and push webhooks`
   - `POST /v1/github/gitlab-webhook` translates `Merge Request Hook` /
     `Push Hook` payloads into the GitHub webhook shape and dispatches through
     the existing pipeline — PR cache, preview deploys, merge gate, and branch
     contributors needed zero changes.

3. `feat(api): per-organization GitLab connections with UI connect flow`
   - GitLab becomes a per-workspace choice, not a server env toggle:
     `github_installation` rows carry a provider plus the instance URL and
     encrypted token/webhook secret (negative installation ids, collision-free
     with GitHub's); a shared `MultiProviderApp` routes every installation to
     its provider with an injected connection resolver, so the API and all
     workers reuse it without new dependencies. `gitlab.connect` probes the
     instance before storing and returns the webhook secret exactly once;
     deliveries are attributed per-connection by constant-time secret match.
     UI: "Connect GitLab" beside "Install GitHub App" on onboarding and the
     settings provider page, which renders title/icon/manage-link/disconnect
     by provider. A server with NO env-level provider boots with a null
     fallback, so GitLab-only self-hosting needs zero git env vars.
4. `feat(api): analysis on PR webhooks for customer-deployed apps`
   - In existing-deploys mode, pull-request webhooks now trigger the PR
     analysis directly against the main environment the last deployment
     signal recorded, instead of waiting for a per-branch signal that a
     not-yet-wired pipeline never sends. Draft PRs skip; re-delivered events
     dedupe on the analyzed head. Provider-agnostic - GitHub PRs gain the
     same behavior.
   - PR-comment links honor `APP_URL` (previously hardcoded to autonoma.app
     via SENTRY_ENV inference - broken for every self-hosted instance).

**Known gaps / open questions for maintainers:**
- Required-status rulesets have no GitLab equivalent at the free tier; the
  client returns `no_permission` so the existing manual-instructions fallback
  engages. Is that acceptable, or should GitLab Ultimate external status checks
  be wired when available?
- GitLab's commit diff endpoint reports no per-file addition/deletion counts
  (reported as 0).
- UI still says "GitHub" in labels and the install flow assumes the GitHub App
  redirect; a token-based "Connect GitLab" settings pane would replace it.
  Happy to do this as a follow-up PR if the direction is approved.
- Route naming: the webhook lives under `/v1/github/gitlab-webhook` to reuse the
  router's service singletons; happy to move it to `/v1/gitlab/webhook` if you
  prefer a separate mount.
- Tests: unit tests cover the MR→PR mapping, comment-id round-trip, status
  mapping, permission collapse, webhook verification, and payload translation.
  We are running this against a self-managed GitLab daily and can report back.

**Alternatives considered.** Repo mirroring to GitHub (changes team workflow,
MRs don't become PRs); a standalone GitLab service beside the API (duplicates
the pipeline). Implementing behind the existing interface was by far the
smallest, least invasive shape.
