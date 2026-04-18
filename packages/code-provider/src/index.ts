import { CodeProvider } from './providers';
import { CodesandboxProvider, type CodesandboxProviderOptions } from './providers/codesandbox';
import { NodeFsProvider, type NodeFsProviderOptions } from './providers/nodefs';
export * from './providers';
export { CodesandboxProvider } from './providers/codesandbox';
export { NodeFsProvider } from './providers/nodefs';
export * from './types';

export interface CreateClientOptions {
    providerOptions: ProviderInstanceOptions;
}

function isLocalModeEnabled() {
    return (
        process.env.ONLOOK_LOCAL_MODE === 'true' ||
        process.env.NEXT_PUBLIC_ONLOOK_LOCAL_MODE === 'true'
    );
}

function hasUsableCodesandboxKey() {
    const key = process.env.CSB_API_KEY?.trim();
    return !!key && !key.startsWith('local-');
}

function resolveCodeProvider(codeProvider: CodeProvider): CodeProvider {
    if (isLocalModeEnabled() && codeProvider === CodeProvider.CodeSandbox && !hasUsableCodesandboxKey()) {
        return CodeProvider.NodeFs;
    }

    return codeProvider;
}

/**
 * Providers are designed to be singletons; be mindful of this when creating multiple clients
 * or when instantiating in the backend (stateless vs stateful).
 */
export async function createCodeProviderClient(
    codeProvider: CodeProvider,
    { providerOptions }: CreateClientOptions,
) {
    const provider = newProviderInstance(resolveCodeProvider(codeProvider), providerOptions);
    await provider.initialize({});
    return provider;
}

export async function getStaticCodeProvider(
    codeProvider: CodeProvider,
): Promise<typeof CodesandboxProvider | typeof NodeFsProvider> {
    const resolvedProvider = resolveCodeProvider(codeProvider);

    if (resolvedProvider === CodeProvider.CodeSandbox) {
        return CodesandboxProvider;
    }

    if (resolvedProvider === CodeProvider.NodeFs) {
        return NodeFsProvider;
    }
    throw new Error(`Unimplemented code provider: ${resolvedProvider}`);
}

export interface ProviderInstanceOptions {
    codesandbox?: CodesandboxProviderOptions;
    nodefs?: NodeFsProviderOptions;
}

function newProviderInstance(codeProvider: CodeProvider, providerOptions: ProviderInstanceOptions) {
    if (codeProvider === CodeProvider.CodeSandbox) {
        if (!providerOptions.codesandbox) {
            throw new Error('Codesandbox provider options are required.');
        }
        return new CodesandboxProvider(providerOptions.codesandbox);
    }

    if (codeProvider === CodeProvider.NodeFs) {
        return new NodeFsProvider(providerOptions.nodefs ?? {});
    }

    throw new Error(`Unimplemented code provider: ${codeProvider}`);
}
