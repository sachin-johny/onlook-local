import { env } from '@/env';
import { LocalForageKeys, Routes } from '@/utils/constants';
import { redirect } from 'next/navigation';
import { LoginPageClient } from './login-page-client';

type LoginPageProps = {
    searchParams?:
    | Record<string, string | string[] | undefined>
    | Promise<Record<string, string | string[] | undefined>>;
};

export default async function LoginPage({ searchParams }: LoginPageProps) {
    const resolvedSearchParams = await Promise.resolve(searchParams ?? {});
    const returnUrlParam = resolvedSearchParams[LocalForageKeys.RETURN_URL];
    const returnUrl = Array.isArray(returnUrlParam) ? returnUrlParam[0] : returnUrlParam;

    if (env.ONLOOK_LOCAL_MODE) {
        redirect(returnUrl || Routes.PROJECTS);
    }

    return <LoginPageClient returnUrl={returnUrl ?? null} />;
}
