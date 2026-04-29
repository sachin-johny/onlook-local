export async function register() {
    if (
        process.env.NEXT_RUNTIME === 'nodejs' &&
        process.env.ONLOOK_LOCAL_MODE === 'true'
    ) {
        const { startPtyServer, shutdown } = await import('./src/server/pty/server');
        startPtyServer();
        process.on('SIGTERM', shutdown);
        process.on('SIGINT', shutdown);
    }
}
