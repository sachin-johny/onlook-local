export const LOCAL_DEV_USER_ID = '00000000-0000-0000-0000-000000000001';
export const LOCAL_DEV_USER_EMAIL = 'dev@local.dev';
export const LOCAL_DEV_USER_NAME = 'Local Dev User';

export function isLocalModeEnabled() {
    return (
        process.env.NEXT_PUBLIC_ONLOOK_LOCAL_MODE === 'true' ||
        typeof window !== 'undefined' && window.localStorage?.getItem('onlook_local_mode') === 'true'
    );
}
