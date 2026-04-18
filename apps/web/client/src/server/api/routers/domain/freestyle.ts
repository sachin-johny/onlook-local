import { env } from '@/env';
import { TRPCError } from '@trpc/server';
import { FreestyleSandboxes } from 'freestyle-sandboxes';

export const initializeFreestyleSdk = () => {
    const localMode =
        process.env.ONLOOK_LOCAL_MODE === 'true' ||
        process.env.NEXT_PUBLIC_ONLOOK_LOCAL_MODE === 'true';

    if (localMode) {
        return {
            deployWeb: async () => ({
                data: {
                    deploymentId: 'local-disabled',
                },
            }),
            createDomainVerificationRequest: async () => ({
                id: 'local-verification-id',
                verificationCode: 'local-verification-code',
            }),
            verifyDomainVerificationRequest: async () => ({
                domain: null,
            }),
            verifyDomain: async () => ({
                domain: null,
                message: 'Domain verification is disabled in local mode',
            }),
        } as unknown as FreestyleSandboxes;
    }

    if (!env.FREESTYLE_API_KEY) {
        throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message: 'FREESTYLE_API_KEY is not configured. Please set the environment variable to use domain publishing features.',
        });
    }
    return new FreestyleSandboxes({
        apiKey: env.FREESTYLE_API_KEY
    });
};
