import { Button, Input, Label } from "@autonoma/blacklight";
import { ArrowSquareOutIcon } from "@phosphor-icons/react/ArrowSquareOut";
import { BuildingsIcon } from "@phosphor-icons/react/Buildings";
import { CheckCircleIcon } from "@phosphor-icons/react/CheckCircle";
import { CloudIcon } from "@phosphor-icons/react/Cloud";
import { GitlabLogoIcon } from "@phosphor-icons/react/GitlabLogo";
import { WarningCircleIcon } from "@phosphor-icons/react/WarningCircle";
import { getApiOrigin } from "lib/api-origin";
import { useConnectGitLab } from "lib/query/github.queries";
import { useState, type ReactNode } from "react";

const GITLAB_CLOUD_URL = "https://gitlab.com";

interface ConnectResult {
  accountLogin: string;
  webhookSecret: string;
  webhookPath: string;
}

type GitLabHost = "cloud" | "self-hosted";

/**
 * Normalize what people actually paste - `gitlab.example.com`, a URL with a
 * trailing slash, or a deep link into their instance - down to the bare origin,
 * or undefined when it cannot be one.
 */
function normalizeBaseUrl(raw: string): string | undefined {
  const candidate = raw.trim();
  if (candidate.length === 0) return undefined;
  const withScheme = /^https?:\/\//.test(candidate) ? candidate : `https://${candidate}`;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

/**
 * GitLab's token page accepts prefilled name + scopes in the query string, so
 * the link lands the user on a form where "Create" is the only decision left.
 */
function tokenCreationUrl(baseUrl: string): string {
  return `${baseUrl}/-/user_settings/personal_access_tokens?name=Autonoma&scopes=api`;
}

/**
 * Token-based GitLab connection, the counterpart of "Install GitHub App".
 *
 * The flow asks where the instance lives FIRST (GitLab.com or self-hosted),
 * because that decides whether a URL is needed at all - most people never have
 * to see the URL field. Token creation deep-links into the instance with name
 * and scope prefilled. On success the webhook URL + secret show exactly once.
 */
export function ConnectGitLabSection() {
  const [open, setOpen] = useState(false);
  const [host, setHost] = useState<GitLabHost | undefined>();
  const [baseUrlInput, setBaseUrlInput] = useState("");
  const [token, setToken] = useState("");
  const [result, setResult] = useState<ConnectResult | undefined>();
  const connect = useConnectGitLab();

  const baseUrl = host === "cloud" ? GITLAB_CLOUD_URL : normalizeBaseUrl(baseUrlInput);
  const urlInvalid = host === "self-hosted" && baseUrlInput.trim().length > 0 && baseUrl == null;
  const readyToConnect = baseUrl != null && token.trim().length > 0 && !connect.isPending;

  if (result != null) {
    const webhookUrl = `${getApiOrigin()}${result.webhookPath}`;
    return (
      <div className="max-w-2xl space-y-3 border border-stroke p-4 font-mono text-sm">
        <p className="flex items-center gap-2 font-bold text-primary-ink">
          <CheckCircleIcon size={16} weight="fill" className="text-status-success" />
          GitLab connected as {result.accountLogin}. One step left: the webhook.
        </p>
        <p className="text-text-secondary">
          In each GitLab project, open <span className="text-primary-ink">Settings → Webhooks</span> and add the URL and
          secret below, with <span className="text-primary-ink">Merge request events</span> and{" "}
          <span className="text-primary-ink">Push events</span> ticked. That webhook is what starts a review when a
          merge request opens.
        </p>
        <div className="space-y-1 text-2xs">
          <p>
            URL: <span className="select-all text-primary-ink">{webhookUrl}</span>
          </p>
          <p>
            Secret: <span className="select-all text-primary-ink">{result.webhookSecret}</span>
          </p>
        </div>
        <p className="text-2xs text-text-secondary">
          Copy the secret now - for your security it is never shown again. Disconnecting and reconnecting issues a fresh
          one.
        </p>
      </div>
    );
  }

  if (!open) {
    return (
      <Button
        variant="outline"
        className="gap-3 px-8 py-4 font-mono text-sm font-bold uppercase"
        onClick={() => setOpen(true)}
        aria-label="onboarding-gitlab-connect"
      >
        <GitlabLogoIcon size={18} weight="bold" />
        Connect GitLab
      </Button>
    );
  }

  return (
    <div className="max-w-2xl space-y-4 border border-stroke p-4">
      <div className="space-y-1.5">
        <Label>Where does your GitLab live?</Label>
        <div className="flex flex-wrap gap-3">
          <HostChoice
            icon={<CloudIcon size={16} weight="duotone" />}
            title="GitLab.com"
            subtitle="Cloud"
            selected={host === "cloud"}
            onSelect={() => setHost("cloud")}
            ariaLabel="gitlab-host-cloud"
          />
          <HostChoice
            icon={<BuildingsIcon size={16} weight="duotone" />}
            title="Self-hosted"
            subtitle="Your own instance"
            selected={host === "self-hosted"}
            onSelect={() => setHost("self-hosted")}
            ariaLabel="gitlab-host-self-hosted"
          />
        </div>
      </div>

      {host === "self-hosted" && (
        <div className="space-y-1.5">
          <Label htmlFor="gitlab-base-url">Instance URL</Label>
          <Input
            id="gitlab-base-url"
            value={baseUrlInput}
            onChange={(event) => setBaseUrlInput(event.target.value)}
            placeholder="gitlab.example.com"
            aria-label="gitlab-base-url"
          />
          {urlInvalid ? (
            <p className="font-mono text-3xs text-status-critical">
              That doesn't look like a URL. Enter your instance's address, like gitlab.example.com.
            </p>
          ) : (
            <p className="font-mono text-3xs text-text-secondary">
              The address your team opens GitLab at. https is assumed if you leave it off.
            </p>
          )}
        </div>
      )}

      {host != null && (
        <div className="space-y-1.5">
          <Label htmlFor="gitlab-token">Access token</Label>
          <Input
            id="gitlab-token"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            placeholder="glpat-..."
            type="password"
            aria-label="gitlab-token"
          />
          <p className="font-mono text-3xs text-text-secondary">
            A personal, group, or project access token with the <span className="text-primary-ink">api</span> scope and
            at least the <span className="text-primary-ink">Developer</span> role on the repositories Autonoma should
            see. Reviews are posted as the account that owns the token.
            {baseUrl != null && (
              <>
                {" "}
                <a
                  href={tokenCreationUrl(baseUrl)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-primary-ink underline underline-offset-2 transition-colors hover:text-primary-ink/80"
                >
                  Create one on GitLab
                  <ArrowSquareOutIcon size={11} />
                </a>{" "}
                - the name and scope come prefilled.
              </>
            )}
          </p>
        </div>
      )}

      {connect.error != null && (
        <div className="flex items-start gap-2 rounded border border-status-critical/30 bg-status-critical/5 px-3 py-2">
          <WarningCircleIcon size={14} weight="fill" className="mt-0.5 shrink-0 text-status-critical" />
          <p className="font-mono text-2xs text-status-critical">{connect.error.message}</p>
        </div>
      )}

      <div className="flex gap-3">
        {host != null && (
          <Button
            variant="accent"
            disabled={!readyToConnect}
            onClick={() => {
              if (baseUrl == null) return;
              connect.mutate({ baseUrl, token: token.trim() }, { onSuccess: (data) => setResult(data) });
            }}
            aria-label="gitlab-connect-submit"
          >
            {connect.isPending ? "Checking the connection…" : "Connect"}
          </Button>
        )}
        <Button
          variant="outline"
          onClick={() => {
            connect.reset();
            setOpen(false);
            setHost(undefined);
          }}
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}

function HostChoice({
  icon,
  title,
  subtitle,
  selected,
  onSelect,
  ariaLabel,
}: {
  icon: ReactNode;
  title: string;
  subtitle: string;
  selected: boolean;
  onSelect: () => void;
  ariaLabel: string;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-label={ariaLabel}
      aria-pressed={selected}
      className={`flex items-center gap-2.5 rounded border px-4 py-2.5 text-left transition-colors ${
        selected
          ? "border-primary-ink bg-primary-ink/5 text-text-primary"
          : "border-border-dim text-text-secondary hover:border-border-highlight hover:text-text-primary"
      }`}
    >
      {icon}
      <span className="flex flex-col">
        <span className="text-sm font-medium">{title}</span>
        <span className="font-mono text-3xs uppercase tracking-widest">{subtitle}</span>
      </span>
    </button>
  );
}
