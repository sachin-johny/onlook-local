'use client';

import type { Branch, Project } from '@onlook/models';
import { usePostHog } from 'posthog-js/react';
import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { EditorEngine } from './engine';

const EditorEngineContext = createContext<EditorEngine | null>(null);

export const useEditorEngine = () => {
    const ctx = useContext(EditorEngineContext);
    if (!ctx) throw new Error('useEditorEngine must be inside EditorEngineProvider');
    return ctx;
};

export const EditorEngineProvider = ({
    children,
    project,
    branches
}: {
    children: React.ReactNode,
    project: Project,
    branches: Branch[],
}) => {
    const posthog = usePostHog();
    const currentProjectId = useRef(project.id);
    const engineRef = useRef<EditorEngine | null>(null);

    const [editorEngine, setEditorEngine] = useState(() => {
        const engine = new EditorEngine(project.id, posthog);
        engine.initBranches(branches);
        engine.init();
        engine.screenshot.lastScreenshotAt = project.metadata?.previewImg?.updatedAt ?? null;
        engineRef.current = engine;
        return engine;
    });

    // Initialize editor engine when project ID changes
    useEffect(() => {
        const prevEngine = engineRef.current;
        const initializeEngine = async () => {
            if (currentProjectId.current !== project.id) {
                // Create new engine for new project
                const newEngine = new EditorEngine(project.id, posthog);
                await newEngine.initBranches(branches);
                await newEngine.init();
                newEngine.screenshot.lastScreenshotAt = project.metadata?.previewImg?.updatedAt ?? null;

                engineRef.current = newEngine;
                setEditorEngine(newEngine);
                currentProjectId.current = project.id;

                // Clean up old engine AFTER updating the ref,
                // using the captured reference (not engineRef.current).
                if (prevEngine) {
                    prevEngine.clear();
                }
            }
        };

        initializeEngine();
    }, [project.id]);

    // Cleanup on unmount — capture engine at registration time
    // so we clear the correct instance, not whatever engineRef points to later.
    useEffect(() => {
        const engine = engineRef.current;
        return () => {
            engine?.clear();
        };
    }, []);

    return (
        <EditorEngineContext.Provider value={editorEngine}>
            {children}
        </EditorEngineContext.Provider>
    );
};
