'use client';

import type { IframeHTMLAttributes } from 'react';
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { observer } from 'mobx-react-lite';
import { connect, WindowMessenger } from 'penpal';

import type { Frame } from '@onlook/models';
import type {
    PenpalChildMethods,
    PenpalParentMethods,
    PromisifiedPendpalChildMethods,
} from '@onlook/penpal';
import { PENPAL_PARENT_CHANNEL } from '@onlook/penpal';
import { WebPreview, WebPreviewBody } from '@onlook/ui/ai-elements';
import { cn } from '@onlook/ui/utils';

import { useEditorEngine } from '@/components/store/editor';

export type IFrameView = HTMLIFrameElement & {
    setZoomLevel: (level: number) => void;
    supportsOpenDevTools: () => boolean;
    reload: () => void;
    isLoading: () => boolean;
} & PromisifiedPendpalChildMethods;

const getSafeFallbackForMethod = async (method: string) => {
    if (method.startsWith('get') || method.includes('capture') || method.includes('build')) {
        return null;
    }
    if (method.includes('Count')) {
        return 0;
    }
    if (method.includes('Editable') || method.includes('supports')) {
        return false;
    }
    return undefined;
};

const createSafeFrameView = <T extends object>(base: T): T & PromisifiedPendpalChildMethods => {
    return new Proxy(base as T & PromisifiedPendpalChildMethods, {
        get(target, prop: string | symbol) {
            if (typeof prop === 'symbol') return undefined;

            const existing = Reflect.get(target, prop);
            if (existing !== undefined) {
                return existing;
            }

            return async () => getSafeFallbackForMethod(String(prop));
        },
    });
};

interface FrameViewProps extends IframeHTMLAttributes<HTMLIFrameElement> {
    frame: Frame;
    reloadIframe: () => void;
    onConnectionFailed: () => void;
    onConnectionSuccess: () => void;
    penpalTimeoutMs?: number;
    isInDragSelection?: boolean;
}

export const FrameComponent = observer(
    forwardRef<IFrameView, FrameViewProps>(
        (
            {
                frame,
                reloadIframe,
                onConnectionFailed,
                onConnectionSuccess,
                penpalTimeoutMs = 10000,
                isInDragSelection = false,
                ...restProps
            },
            ref,
        ) => {
            const { popover, ...props } = restProps;
            const editorEngine = useEditorEngine();
            const iframeRef = useRef<HTMLIFrameElement>(null);
            const zoomLevel = useRef(1);
            const isConnecting = useRef(false);
            const connectionRef = useRef<ReturnType<typeof connect> | null>(null);
            const [penpalChild, setPenpalChild] = useState<PenpalChildMethods | null>(null);
            const isSelected = editorEngine.frames.isSelected(frame.id);
            const isActiveBranch = editorEngine.branches.activeBranch.id === frame.branchId;

            const setupPenpalConnection = () => {
                try {
                    if (!iframeRef.current?.contentWindow) {
                        console.error(`${PENPAL_PARENT_CHANNEL} (${frame.id}) - No iframe found`);
                        onConnectionFailed();
                        return;
                    }

                    if (isConnecting.current) {
                        console.log(
                            `${PENPAL_PARENT_CHANNEL} (${frame.id}) - Connection already in progress`,
                        );
                        return;
                    }
                    isConnecting.current = true;

                    // Destroy any existing connection
                    if (connectionRef.current) {
                        connectionRef.current.destroy();
                        connectionRef.current = null;
                    }

                    const messenger = new WindowMessenger({
                        remoteWindow: iframeRef.current.contentWindow,
                        allowedOrigins: ['*'],
                    });

                    const connection = connect({
                        messenger,
                        methods: {
                            getFrameId: () => frame.id,
                            getBranchId: () => frame.branchId,
                            onWindowMutated: () => {
                                editorEngine.frameEvent.handleWindowMutated();
                            },
                            onWindowResized: () => {
                                editorEngine.frameEvent.handleWindowResized();
                            },
                            onDomProcessed: (data: {
                                layerMap: Record<string, any>;
                                rootNode: any;
                            }) => {
                                editorEngine.frameEvent.handleDomProcessed(frame.id, data);
                            },
                        } satisfies PenpalParentMethods,
                    });

                    connectionRef.current = connection;

                    // Create a timeout promise that rejects after specified timeout
                    const timeoutPromise = new Promise<never>((_, reject) => {
                        setTimeout(() => {
                            reject(
                                new Error(`Penpal connection timeout after ${penpalTimeoutMs}ms`),
                            );
                        }, penpalTimeoutMs);
                    });

                    // Race the connection promise against the timeout
                    Promise.race([connection.promise, timeoutPromise])
                        .then((child) => {
                            isConnecting.current = false;
                            if (!child) {
                                console.error(
                                    `${PENPAL_PARENT_CHANNEL} (${frame.id}) - Connection failed: child is null`,
                                );
                                onConnectionFailed();
                                return;
                            }

                            console.log(
                                `${PENPAL_PARENT_CHANNEL} (${frame.id}) - Penpal connection set`,
                            );

                            const remote = child as unknown as PenpalChildMethods;
                            setPenpalChild(remote);
                            remote.setFrameId(frame.id);
                            remote.setBranchId(frame.branchId);
                            remote.handleBodyReady();
                            remote.processDom();

                            // Notify parent of successful connection
                            onConnectionSuccess();
                        })
                        .catch((error) => {
                            isConnecting.current = false;
                            const message = error instanceof Error ? error.message : String(error);
                            if (message.includes('timeout')) {
                                console.warn(
                                    `${PENPAL_PARENT_CHANNEL} (${frame.id}) - Failed to setup penpal connection:`,
                                    error,
                                );
                            } else {
                                console.error(
                                    `${PENPAL_PARENT_CHANNEL} (${frame.id}) - Failed to setup penpal connection:`,
                                    error,
                                );
                            }
                            onConnectionFailed();
                        });
                } catch (error) {
                    isConnecting.current = false;
                    console.error(`${PENPAL_PARENT_CHANNEL} (${frame.id}) - Setup failed:`, error);
                    onConnectionFailed();
                }
            };

            const promisifyMethod = <T extends (...args: any[]) => any>(
                method: T | undefined,
            ): ((...args: Parameters<T>) => Promise<ReturnType<T>>) => {
                return async (...args: Parameters<T>) => {
                    try {
                        if (!method) throw new Error('Method not initialized');
                        return method(...args);
                    } catch (error) {
                        console.error(
                            `${PENPAL_PARENT_CHANNEL} (${frame.id}) - Method failed:`,
                            error,
                        );
                    }
                };
            };

            const remoteMethods = useMemo((): PromisifiedPendpalChildMethods => {
                if (!penpalChild) {
                    return {} as PromisifiedPendpalChildMethods;
                }

                return {
                    processDom: promisifyMethod(penpalChild?.processDom),
                    getElementAtLoc: promisifyMethod(penpalChild?.getElementAtLoc),
                    getElementByDomId: promisifyMethod(penpalChild?.getElementByDomId),
                    setFrameId: promisifyMethod(penpalChild?.setFrameId),
                    setBranchId: promisifyMethod(penpalChild?.setBranchId),
                    getElementIndex: promisifyMethod(penpalChild?.getElementIndex),
                    getComputedStyleByDomId: promisifyMethod(penpalChild?.getComputedStyleByDomId),
                    updateElementInstance: promisifyMethod(penpalChild?.updateElementInstance),
                    getFirstOnlookElement: promisifyMethod(penpalChild?.getFirstOnlookElement),
                    setElementType: promisifyMethod(penpalChild?.setElementType),
                    getElementType: promisifyMethod(penpalChild?.getElementType),
                    getParentElement: promisifyMethod(penpalChild?.getParentElement),
                    getChildrenCount: promisifyMethod(penpalChild?.getChildrenCount),
                    getOffsetParent: promisifyMethod(penpalChild?.getOffsetParent),
                    getActionLocation: promisifyMethod(penpalChild?.getActionLocation),
                    getActionElement: promisifyMethod(penpalChild?.getActionElement),
                    getInsertLocation: promisifyMethod(penpalChild?.getInsertLocation),
                    getRemoveAction: promisifyMethod(penpalChild?.getRemoveAction),
                    getTheme: promisifyMethod(penpalChild?.getTheme),
                    setTheme: promisifyMethod(penpalChild?.setTheme),
                    startDrag: promisifyMethod(penpalChild?.startDrag),
                    drag: promisifyMethod(penpalChild?.drag),
                    dragAbsolute: promisifyMethod(penpalChild?.dragAbsolute),
                    endDragAbsolute: promisifyMethod(penpalChild?.endDragAbsolute),
                    endDrag: promisifyMethod(penpalChild?.endDrag),
                    endAllDrag: promisifyMethod(penpalChild?.endAllDrag),
                    startEditingText: promisifyMethod(penpalChild?.startEditingText),
                    editText: promisifyMethod(penpalChild?.editText),
                    stopEditingText: promisifyMethod(penpalChild?.stopEditingText),
                    updateStyle: promisifyMethod(penpalChild?.updateStyle),
                    insertElement: promisifyMethod(penpalChild?.insertElement),
                    removeElement: promisifyMethod(penpalChild?.removeElement),
                    moveElement: promisifyMethod(penpalChild?.moveElement),
                    groupElements: promisifyMethod(penpalChild?.groupElements),
                    ungroupElements: promisifyMethod(penpalChild?.ungroupElements),
                    insertImage: promisifyMethod(penpalChild?.insertImage),
                    removeImage: promisifyMethod(penpalChild?.removeImage),
                    isChildTextEditable: promisifyMethod(penpalChild?.isChildTextEditable),
                    handleBodyReady: promisifyMethod(penpalChild?.handleBodyReady),
                    captureScreenshot: promisifyMethod(penpalChild?.captureScreenshot),
                    buildLayerTree: promisifyMethod(penpalChild?.buildLayerTree),
                };
            }, [penpalChild]);

            useImperativeHandle(ref, (): IFrameView => {
                const iframe = iframeRef.current;
                if (!iframe) {
                    console.error(`${PENPAL_PARENT_CHANNEL} (${frame.id}) - Iframe - Not found`);
                    // Return safe fallback with no-op methods and safe defaults
                    const fallbackElement = document.createElement('iframe');
                    const safeFallback = Object.assign(fallbackElement, {
                        // Custom sync methods with safe no-op implementations
                        supportsOpenDevTools: () => false,
                        setZoomLevel: () => { },
                        reload: () => { },
                        isLoading: () => false,
                    });
                    return createSafeFrameView(safeFallback) as IFrameView;
                }

                // Register the iframe with the editor engine
                editorEngine.frames.registerView(frame, iframe as IFrameView);

                const syncMethods = {
                    supportsOpenDevTools: () =>
                        !!iframe.contentWindow && 'openDevTools' in iframe.contentWindow,
                    setZoomLevel: (level: number) => {
                        zoomLevel.current = level;
                        iframe.style.transform = `scale(${level})`;
                        iframe.style.transformOrigin = 'top left';
                    },
                    reload: () => reloadIframe(),
                    isLoading: () => iframe.contentDocument?.readyState !== 'complete',
                };

                if (!penpalChild) {
                    console.warn(
                        `${PENPAL_PARENT_CHANNEL} (${frame.id}) - Failed to setup penpal connection: iframeRemote is null`,
                    );
                    return createSafeFrameView(Object.assign(iframe, syncMethods)) as IFrameView;
                }

                return Object.assign(iframe, {
                    ...syncMethods,
                    ...remoteMethods,
                });
            }, [penpalChild, frame, iframeRef]);

            useEffect(() => {
                return () => {
                    if (connectionRef.current) {
                        connectionRef.current.destroy();
                        connectionRef.current = null;
                    }
                    setPenpalChild(null);
                    isConnecting.current = false;
                };
            }, []);

            return (
                <WebPreview>
                    <WebPreviewBody
                        ref={iframeRef}
                        id={frame.id}
                        className={cn(
                            'outline outline-4 backdrop-blur-sm transition',
                            isActiveBranch && 'outline-teal-400',
                            isActiveBranch && !isSelected && 'outline-dashed',
                            !isActiveBranch && isInDragSelection && 'outline-teal-500',
                        )}
                        src={frame.url}
                        sandbox="allow-modals allow-forms allow-same-origin allow-scripts allow-popups allow-downloads"
                        allow="geolocation; microphone; camera; midi; encrypted-media"
                        style={{ width: frame.dimension.width, height: frame.dimension.height }}
                        onLoad={setupPenpalConnection}
                        {...props}
                    />
                </WebPreview>
            );
        },
    ),
);
