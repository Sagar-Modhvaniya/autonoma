# Proposal: GitLab support (draft for a GitHub Discussion / Issue)

> Post this to https://github.com/Autonoma-AI/autonoma/discussions before opening
> a PR — CONTRIBUTING.md asks for features to be vetted first.

---

**Title:** feat: GitLab as a first-class git provider behind the existing GitHubApp interface

**Problem.** Autonoma is GitHub-only today — the troubleshooting docs state it
explicitly ("Connect GitLab, Bitbucket, or Azure DevOps — No"). Teams on GitLab,
especially self-managed instances, which are common in exactly the kind of
organization that self-hosts Autonoma, cannot connect their repos at all, and
mirroring to GitHub changes the team's whole review workflow.

**Proposed solution.** Everything Autonoma needs from a git host already flows
through two interfaces: `GitHubApp` and `GitHubInstallationClient` (that is how
`LocalDevGitHubApp` plugs in, and `packages/github` is documented as the "GitHub
App and API client" seam). We implemented a GitLab provider behind those same
interfaces. The working series is seven conventional commits:

1. `feat(api): add GitLab provider behind the GitHubApp interface`
   - `packages/github/src/gitlab/` — `GitLabApi` (REST v4 wrapper),
     `GitLabInstallationClient` (full interface: projects ↔ repositories,
     merge requests ↔ pull requests, MR notes ↔ issue comments, commit
     statuses ↔ check runs, clone via env-injected token auth), `GitLabApp`
     (token-based; webhook verification = `X-Gitlab-Token` equality).
   - Works with gitlab.com and self-managed instances via a base URL.
2. `feat(api): accept GitLab merge-request and push webhooks`
   - `POST /v1/github/gitlab-webhook` translates `Merge Request Hook` /
     `Push Hook` payloads into the GitHub webhook shape and dispatches through
     the existing pipeline — PR cache, preview deploys, merge gate, and branch
     contributors needed zero changes.
3. `fix(api): carry clone_url in translated GitLab webhooks; widen GitLab clone budgets`
   - Findings from running the pipeline live against a self-managed instance.
4. `feat(api): per-organization GitLab connections with UI connect flow`
   - GitLab is a per-workspace choice made in the UI, not a server env toggle:
     `github_installation` rows carry a provider plus the instance URL and
     encrypted token/webhook secret (negative installation ids, collision-free
     with GitHub's); a shared `MultiProviderApp` routes every installation to
     its provider with an injected connection resolver, so the API and all
     workers reuse it without new dependencies. `gitlab.connect` probes the
     instance before storing and returns the webhook secret exactly once;
     deliveries are attributed per-connection by constant-time secret match.
     A server with NO env-level provider boots with a null fallback, so
     GitLab-only self-hosting needs zero git env vars.
5. `feat(api): provider-aware workers so GitLab runs execute end-to-end`
   - The diffs/general workers resolve the provider per installation; paths
     that are inherently GitHub-App-bound (previewkit finalization, eval
     token minting) fail with a clear configuration error instead of a crash
     when no GitHub App is configured.
6. `feat(api): analysis on PR webhooks for customer-deployed apps; instance-aware comment links`
   - In existing-deploys mode, pull-request webhooks trigger the PR analysis
     directly against the main environment the last deployment signal
     recorded, instead of waiting for a per-branch signal that a not-yet-wired
     pipeline never sends. Draft PRs skip. Provider-agnostic — GitHub PRs gain
     the same behavior.
   - PR-comment links honor `APP_URL` (previously hardcoded to autonoma.app
     via SENTRY_ENV inference — broken for every self-hosted instance).
7. `feat(ui): render every provider surface from the connected provider`
   - Onboarding, add-app, PR header ("Open in GitLab"), settings, linked
     repository, and completion screens all render logo/labels/links from the
     connected provider; the deployment-signal setup offers a GitLab CI job
     template (merge-request pipelines carry the MR number) beside the GitHub
     Actions workflow, and the onboarding MCP hands out both.

**Tested.** Unit tests cover the MR→PR mapping, comment-id round-trip, status
mapping, permission collapse, webhook verification, and payload translation
(`packages/github` 96 tests, `apps/api` 307 tests green on top of current
main). We are also running the full pipeline daily against a self-managed
GitLab instance: MR webhook → per-connection auth → analysis → browser run →
review comment on the MR, including a real product bug it caught.

**Known gaps / open questions for maintainers:**
- Required-status rulesets have no GitLab equivalent at the free tier; the
  client returns `no_permission` so the existing manual-instructions fallback
  engages. Is that acceptable, or should GitLab Ultimate external status checks
  be wired when available?
- GitLab's commit diff endpoint reports no per-file addition/deletion counts
  (reported as 0).
- Route naming: the webhook lives under `/v1/github/gitlab-webhook` to reuse the
  router's service singletons; happy to move it to `/v1/gitlab/webhook` if you
  prefer a separate mount.
- GitHub Enterprise Server is NOT covered: GitHub connections still assume
  github.com. The same base-URL treatment would extend there; we scoped it out
  to keep this series reviewable.
- PreviewKit (Autonoma-hosted preview builds) still requires a GitHub App;
  GitLab currently pairs with existing-deploys mode. Extending previewkit
  finalization to GitLab commit statuses is natural follow-up work.

**Alternatives considered.** Repo mirroring to GitHub (changes team workflow,
MRs don't become PRs); a standalone GitLab service beside the API (duplicates
the pipeline). Implementing behind the existing interface was by far the
smallest, least invasive shape.

The series is ready on a fork branch and rebases cleanly onto current `main`;
happy to open the PR (or split it further) once the direction is agreed.
