import { GitBranchIcon } from "@phosphor-icons/react/GitBranch";
import { GithubLogoIcon } from "@phosphor-icons/react/GithubLogo";
import { GitlabLogoIcon } from "@phosphor-icons/react/GitlabLogo";
import { useQuery } from "@tanstack/react-query";
import { trpc } from "lib/trpc";

export interface GitProviderInfo {
  provider: "github" | "gitlab";
  /** Instance base URL for self-managed providers (GitLab); null on github.com. */
  baseUrl: string | null;
  accountLogin: string;
}

/**
 * The workspace's connected git provider, or undefined while loading / when
 * nothing is connected. Non-suspending on purpose: callers are chrome (icons,
 * button labels) that must not block their surface on this lookup.
 */
export function useGitProviderInfo(): GitProviderInfo | undefined {
  const { data } = useQuery({ ...trpc.github.getInstallation.queryOptions(), staleTime: 60_000 });
  if (data == null) return undefined;
  return { provider: data.provider, baseUrl: data.providerBaseUrl ?? null, accountLogin: data.accountLogin };
}

export function useGitProvider(): "github" | "gitlab" | undefined {
  return useGitProviderInfo()?.provider;
}

/** Human name for a provider, for button labels and copy. */
export function providerDisplayName(provider: "github" | "gitlab" | undefined): string {
  return provider === "gitlab" ? "GitLab" : "GitHub";
}

/**
 * The connected provider's logo - GitLab or GitHub once known, a neutral
 * branch glyph while loading or when no provider is connected yet (where a
 * provider-specific logo would presume the choice).
 */
export function ProviderLogoIcon({ size, className }: { size: number; className?: string }) {
  const provider = useGitProvider();
  if (provider === "gitlab") return <GitlabLogoIcon size={size} weight="duotone" className={className} />;
  if (provider === "github") return <GithubLogoIcon size={size} weight="duotone" className={className} />;
  return <GitBranchIcon size={size} weight="duotone" className={className} />;
}
