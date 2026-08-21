import { GitlabLogoIcon } from "@phosphor-icons/react/GitlabLogo";
import { Button, Input } from "@autonoma/blacklight";
import { getApiOrigin } from "lib/api-origin";
import { useConnectGitLab } from "lib/query/github.queries";
import { useState } from "react";

interface ConnectResult {
    accountLogin: string;
    webhookSecret: string;
    webhookPath: string;
}

/**
 * Token-based GitLab connection, the counterpart of "Install GitHub App".
 * Collects the instance URL and an `api`-scope access token, and on success
 * shows the webhook URL + secret exactly once so the user can configure their
 * GitLab project hooks.
 */
export function ConnectGitLabSection() {
    const [open, setOpen] = useState(false);
    const [baseUrl, setBaseUrl] = useState("https://gitlab.com");
    const [token, setToken] = useState("");
    const [result, setResult] = useState<ConnectResult | undefined>();
    const connect = useConnectGitLab();

    if (result != null) {
        const webhookUrl = `${getApiOrigin()}${result.webhookPath}`;
        return (
            <div className="max-w-2xl space-y-3 border border-stroke p-4 font-mono text-sm">
                <p className="font-bold text-primary-ink">
                    GitLab connected as {result.accountLogin}. One step left: the webhook.
                </p>
                <p className="text-text-secondary">
                    In each GitLab project (Settings → Webhooks), add this URL and secret token, with{" "}
                    <span className="text-primary-ink">Merge request events</span> and{" "}
                    <span className="text-primary-ink">Push events</span> enabled. The secret is shown only once.
                </p>
                <div className="space-y-1 text-2xs">
                    <p>
                        URL: <span className="select-all text-primary-ink">{webhookUrl}</span>
                    </p>
                    <p>
                        Secret: <span className="select-all text-primary-ink">{result.webhookSecret}</span>
                    </p>
                </div>
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
        <div className="max-w-2xl space-y-3 border border-stroke p-4">
            <p className="font-mono text-sm text-text-secondary">
                Works with gitlab.com and self-managed instances. Create a group or project access token with the{" "}
                <span className="text-primary-ink">api</span> scope and at least the{" "}
                <span className="text-primary-ink">Developer</span> role.
            </p>
            <Input
                value={baseUrl}
                onChange={(event) => setBaseUrl(event.target.value)}
                placeholder="https://gitlab.example.com"
                aria-label="gitlab-base-url"
            />
            <Input
                value={token}
                onChange={(event) => setToken(event.target.value)}
                placeholder="Access token (api scope)"
                type="password"
                aria-label="gitlab-token"
            />
            <div className="flex gap-3">
                <Button
                    variant="accent"
                    disabled={token.length === 0 || connect.isPending}
                    onClick={() => {
                        connect.mutate(
                            { baseUrl, token },
                            { onSuccess: (data) => setResult(data) },
                        );
                    }}
                >
                    {connect.isPending ? "Connecting…" : "Connect"}
                </Button>
                <Button variant="outline" onClick={() => setOpen(false)}>
                    Cancel
                </Button>
            </div>
        </div>
    );
}
