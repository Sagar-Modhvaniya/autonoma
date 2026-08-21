import type { PrismaClient } from "@autonoma/db";
import { logger as rootLogger } from "@autonoma/logger";
import { z } from "zod";
import type { DiffsTriggerService } from "../diffs/diffs-trigger.service";
import { autonomaHostsPreviews } from "@autonoma/scenario";

const logger = rootLogger.child({ name: "customerDeployAnalysis" });

const pullRequestWebhookSchema = z.object({
    pull_request: z.object({
        number: z.number().int().positive(),
        draft: z.boolean().optional(),
    }),
    repository: z.object({ id: z.number().int().positive() }),
});

/**
 * Starts the PR analysis directly from a pull-request webhook for applications
 * whose previews the CUSTOMER deploys (existing-deploys mode).
 *
 * Autonoma-hosted previews start analysis when their own build finishes, and
 * customer deploys report in through the deployment signal - but a signal only
 * arrives when the customer's pipeline is wired to send one. Until then, every
 * PR event used to end in "skipping the preview run" with nothing owed to the
 * thread. This fallback reuses the application's recorded main environment:
 * the URL its last deployment signal declared live, which is exactly the
 * environment the customer told Autonoma to test against. A later signal for
 * the branch supersedes the run via the workflow's conflict policy, so wiring
 * the pipeline up remains the better - but no longer the only - path.
 */
export async function triggerAnalysisForCustomerDeployedPr(
    db: PrismaClient,
    diffsTrigger: DiffsTriggerService,
    organizationId: string,
    payload: Record<string, unknown>,
): Promise<void> {
    const parsed = pullRequestWebhookSchema.safeParse(payload);
    if (!parsed.success) return;
    const { pull_request: pr, repository: repo } = parsed.data;
    if (pr.draft === true) return;

    const application = await db.application.findFirst({
        where: { organizationId, githubRepositoryId: repo.id },
        select: {
            id: true,
            onboardingState: { select: { previewEnvironmentMode: true } },
            mainBranch: {
                select: {
                    deployment: {
                        select: {
                            webhookUrl: true,
                            webhookHeaders: true,
                            webDeployment: { select: { url: true } },
                        },
                    },
                },
            },
        },
    });
    if (application == null) return;
    if (autonomaHostsPreviews(application.onboardingState?.previewEnvironmentMode ?? null)) return;

    const deployment = application.mainBranch?.deployment;
    const url = deployment?.webDeployment?.url;
    if (deployment == null || url == null) {
        logger.info("Customer-deployed app has no recorded environment yet; waiting for a deployment signal", {
            organizationId,
            applicationId: application.id,
            extra: { prNumber: pr.number },
        });
        return;
    }

    logger.info("Triggering PR analysis against the customer's recorded environment", {
        organizationId,
        applicationId: application.id,
        extra: { prNumber: pr.number, url },
    });

    const params: Parameters<DiffsTriggerService["triggerPrDiffs"]>[0] = {
        organizationId,
        repoId: repo.id,
        prNumber: pr.number,
        url,
    };
    if (deployment.webhookUrl != null) params.webhookUrl = deployment.webhookUrl;
    if (deployment.webhookHeaders != null) {
        params.webhookHeaders = deployment.webhookHeaders as Record<string, string>;
    }
    await diffsTrigger.triggerPrDiffs(params);
}
