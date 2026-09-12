import {
    ProcessedFileType,
    type NextJsProjectValidation,
    type ProcessedFile,
} from '@/app/projects/types';
import type { RouterOutputs } from '@/trpc/client';
import { api } from '@/trpc/react';
import { IGNORED_UPLOAD_DIRECTORIES, IGNORED_UPLOAD_FILES } from '@onlook/constants';
import { Button } from '@onlook/ui/button';
import { CardDescription, CardTitle } from '@onlook/ui/card';
import { Icons } from '@onlook/ui/icons';
import { isBinaryFile } from '@onlook/utility';
import { motion } from 'motion/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { StepContent, StepFooter, StepHeader } from '../../steps';
import { useProjectCreation } from '../_context';

declare module 'react' {
    interface InputHTMLAttributes<T> extends HTMLAttributes<T> {
        webkitdirectory?: string;
        directory?: string;
    }
}

type LocalPathValidation = RouterOutputs['localFs']['validatePath'];

const LAST_LOCAL_PATH_STORAGE_KEY = 'onlook_last_local_path';

const getExpectedPreviewPort = () => {
    try {
        const previewUrl = process.env.NEXT_PUBLIC_LOCAL_PREVIEW_URL?.trim() || 'http://localhost:8084';
        return Number(new URL(previewUrl).port) || 80;
    } catch {
        return 8084;
    }
};

export const NewSelectFolder = () => {
    const {
        projectData,
        setProjectData,
        prevStep,
        nextStep,
        resetProjectData,
        validateNextJsProject,
    } = useProjectCreation();
    const isLocalMode = process.env.NEXT_PUBLIC_ONLOOK_LOCAL_MODE === 'true';
    const [isDragging, setIsDragging] = useState(false);
    const [isUploading, setIsUploading] = useState(false);
    const [error, setError] = useState('');
    const [validation, setValidation] = useState<NextJsProjectValidation | null>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);

    // ── Local mode: absolute path input validated against the real disk folder ──
    const [localPathInput, setLocalPathInput] = useState('');
    const [debouncedPath, setDebouncedPath] = useState('');
    const appliedLocalPathRef = useRef<string | null>(null);

    useEffect(() => {
        if (!isLocalMode) {
            return;
        }
        try {
            const lastPath = window.localStorage.getItem(LAST_LOCAL_PATH_STORAGE_KEY);
            if (lastPath) {
                setLocalPathInput((current) => current || lastPath);
            }
        } catch {
            // localStorage unavailable — start with an empty input.
        }
    }, [isLocalMode]);

    useEffect(() => {
        if (!isLocalMode) {
            return;
        }
        const timer = setTimeout(() => {
            setDebouncedPath(localPathInput.trim());
            appliedLocalPathRef.current = null;
        }, 400);
        return () => clearTimeout(timer);
    }, [isLocalMode, localPathInput]);

    const {
        data: pathValidation,
        isFetching: isValidatingPath,
        error: validateError,
    } = api.localFs.validatePath.useQuery(
        { path: debouncedPath },
        { enabled: isLocalMode && debouncedPath.length > 0 },
    );

    useEffect(() => {
        if (!isLocalMode || !pathValidation?.valid || !pathValidation.resolvedPath) {
            return;
        }
        if (appliedLocalPathRef.current === pathValidation.resolvedPath) {
            return;
        }
        appliedLocalPathRef.current = pathValidation.resolvedPath;

        try {
            window.localStorage.setItem(LAST_LOCAL_PATH_STORAGE_KEY, pathValidation.resolvedPath);
        } catch {
            // Ignore storage quota and availability errors.
        }

        setProjectData({
            name: pathValidation.name || 'Imported project',
            folderPath: pathValidation.resolvedPath,
            localPath: pathValidation.resolvedPath,
            files: [],
        });
    }, [isLocalMode, pathValidation, setProjectData]);

    const extractProjectName = (files: ProcessedFile[]): string | null => {
        const packageJsonFile = files.find(
            (f) => f.path.endsWith('package.json') && f.type === ProcessedFileType.TEXT,
        );

        if (packageJsonFile) {
            try {
                const packageJson = JSON.parse(packageJsonFile.content as string);
                return packageJson.name || null;
            } catch (error) {
                console.warn('Error parsing package.json for name:', error);
            }
        }

        return null;
    };

    const handleClickUpload = () => {
        fileInputRef.current?.click();
    };

    const filterAndProcessFiles = async (files: File[]): Promise<ProcessedFile[]> => {
        const processedFiles: ProcessedFile[] = [];
        const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

        // Find the common root path from all files
        const allPaths = files.map((file) => (file).webkitRelativePath || file.name);

        if (!allPaths[0]) {
            return processedFiles;
        }

        const rootPath =
            allPaths.length > 0 && allPaths[0].includes('/') ? allPaths[0].split('/')[0] : '';

        for (const file of files) {
            // Get relative path from webkitRelativePath or name
            // Remove the root path from the relative path
            let relativePath = (file).webkitRelativePath || file.name;
            if (!rootPath) {
                continue;
            }
            relativePath = relativePath.replace(rootPath, '').replace(/^\//, '');

            // Skip ignored directories
            if (
                IGNORED_UPLOAD_DIRECTORIES.some(
                    (dir) => relativePath.includes(`${dir}/`) || relativePath.startsWith(`${dir}/`),
                )
            ) {
                continue;
            }

            // Skip ignored files
            if (IGNORED_UPLOAD_FILES.includes(file.name)) {
                continue;
            }

            let processedFile: ProcessedFile;

            // Skip if file is too large
            if (file.size > MAX_FILE_SIZE) {
                console.warn(`Skipping large file: ${file.name} (${file.size} bytes)`);
                continue;
            }

            // Determine if file is binary
            const type = isBinaryFile(file.name)
                ? ProcessedFileType.BINARY
                : ProcessedFileType.TEXT;
            try {
                if (type === ProcessedFileType.BINARY) {
                    processedFile = {
                        path: relativePath,
                        content: await file.arrayBuffer(),
                        type: ProcessedFileType.BINARY,
                    };
                } else {
                    processedFile = {
                        path: relativePath,
                        content: await file.text(),
                        type: ProcessedFileType.TEXT,
                    };
                }

                processedFiles.push(processedFile);
            } catch (error) {
                console.warn(`Error reading file ${file.name}:`, error);
            }
        }
        return processedFiles;
    };

    const processProjectFiles = async (fileList: FileList | File[]) => {
        setError('');
        setIsUploading(true);

        try {
            const files = Array.from(fileList);
            const fullPath = files[0]?.webkitRelativePath;

            // Normalize path by removing leading slash if present
            const normalizedPath = fullPath?.startsWith('/') ? fullPath.substring(1) : fullPath;
            const folderPath = normalizedPath?.substring(0, normalizedPath.indexOf('/'));

            const processedFiles = await filterAndProcessFiles(files);

            if (processedFiles.length === 0) {
                throw new Error('No valid files found in the selected folder');
            }

            const projectName = extractProjectName(processedFiles);

            if (!projectName) {
                setError('No project name found in the selected folder');
                return;
            }

            // Validate the project
            const validationResult = await validateNextJsProject(processedFiles);
            setValidation(validationResult);

            setProjectData({
                name: projectName,
                folderPath: folderPath,
                files: processedFiles,
            });
        } catch (error) {
            console.error('Error processing project:', error);
            setError(error instanceof Error ? error.message : 'Failed to process project');
        } finally {
            setIsUploading(false);
        }
    };

    const handleFileInputChange = useCallback(
        async (event: React.ChangeEvent<HTMLInputElement>) => {
            const files = event.target.files;
            if (files && files.length > 0) {
                await processProjectFiles(files);
            }
        },
        [],
    );

    // Helper function to recursively read directory entries
    const readDirectory = async (dirEntry: any): Promise<File[]> => {
        const files: File[] = [];

        return new Promise((resolve) => {
            const reader = dirEntry.createReader();

            const readEntries = () => {
                reader.readEntries(async (entries: any[]) => {
                    if (entries.length === 0) {
                        resolve(files);
                        return;
                    }

                    for (const entry of entries) {
                        if (entry.isFile) {
                            const fileEntry = entry;
                            try {
                                let file = await new Promise<File>((resolve, reject) => {
                                    fileEntry.file(resolve, reject);
                                });

                                // Create a new File object with webkitRelativePath
                                const fileWithPath = new File([file], file.name, {
                                    type: file.type,
                                    lastModified: file.lastModified,
                                });
                                Object.defineProperty(fileWithPath, 'webkitRelativePath', {
                                    value: fileEntry.fullPath,
                                    writable: false,
                                    enumerable: true,
                                    configurable: false,
                                });

                                files.push(fileWithPath);
                            } catch (error) {
                                console.warn(`Error reading file ${entry.name}:`, error);
                            }
                        } else if (entry.isDirectory) {
                            const subFiles = await readDirectory(entry);
                            files.push(...subFiles);
                        }
                    }

                    // Continue reading entries (directories can have many entries)
                    readEntries();
                });
            };

            readEntries();
        });
    };

    const handleDrop = useCallback(async (e: React.DragEvent<HTMLDivElement>) => {
        e.preventDefault();
        setIsDragging(false);

        const items = e.dataTransfer.items;
        const files: File[] = [];

        for (let i = 0; i < items.length; i++) {
            const item = items[i];

            if (item && item.kind === 'file') {
                const entry = item.webkitGetAsEntry();

                if (entry) {
                    if (entry.isFile) {
                        // Handle individual file
                        const fileEntry = entry as FileSystemFileEntry;
                        try {
                            const file = await new Promise<File>((resolve, reject) => {
                                fileEntry.file(resolve, reject);
                            });
                            files.push(file);
                        } catch (error) {
                            console.warn(`Error reading file ${entry.name}:`, error);
                        }
                    } else if (entry.isDirectory) {
                        // Handle directory
                        const dirFiles = await readDirectory(entry);
                        files.push(...dirFiles);
                    }
                } else {
                    // Fallback for browsers that don't support webkitGetAsEntry
                    const file = item.getAsFile();
                    if (file) {
                        files.push(file);
                    }
                }
            }
        }

        if (files.length > 0) {
            await processProjectFiles(files);
        } else {
            setError('No files found in the dropped folder');
        }
    }, []);

    const handleDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
        e.preventDefault();
        setIsDragging(true);
    }, []);

    const handleDragLeave = useCallback((e: React.DragEvent<HTMLDivElement>) => {
        e.preventDefault();
        if (!e.currentTarget.contains(e.relatedTarget as Node)) {
            setIsDragging(false);
        }
    }, []);

    const reset = () => {
        resetProjectData();
        // Reset all related states
        setError('');
        setIsUploading(false);
        setIsDragging(false);
        appliedLocalPathRef.current = null;
    };

    const renderHeader = () => {
        const headerConfig = {
            initial: {
                title: 'Select your project folder',
                description: "This is where we'll reference your App",
            },
            validating: {
                title: 'Verifying compatibility with Onlook',
                description: "We're checking to make sure this project can work with Onlook",
            },
            valid: {
                title: 'Project verified',
                description: 'Your project is ready to import to Onlook',
            },
            invalid: {
                title: "This project won't work with Onlook",
                description: 'Onlook only works with NextJS + React + Tailwind projects',
            },
        };

        let config = headerConfig.initial;
        if (projectData.folderPath) {
            if (!validation) {
                config = headerConfig.validating;
            } else if (validation.isValid) {
                config = headerConfig.valid;
            } else {
                config = headerConfig.invalid;
            }
        }

        return (
            <>
                <CardTitle>{config.title}</CardTitle>
                <CardDescription>{config.description}</CardDescription>
            </>
        );
    };

    const renderProjectInfo = () => {
        if (!projectData.folderPath) {
            return (
                <motion.div
                    key="selectFolder"
                    initial={{ opacity: 0, scale: 0.9 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.9 }}
                    className="w-full space-y-4"
                >
                    <div
                        className={`
                            w-full h-20 rounded-lg bg-gray-900 border border-gray rounded-lg m-0
                            flex flex-col items-center justify-center gap-4
                            duration-200 cursor-pointer
                            ${isDragging
                                ? 'border-blue-400 bg-blue-50'
                                : 'border-gray-300 bg-gray-50 hover:bg-gray-700'
                            }
                            ${isUploading ? 'pointer-events-none opacity-50' : ''}
                        `}
                        onDrop={handleDrop}
                        onDragOver={handleDragOver}
                        onDragLeave={handleDragLeave}
                        onClick={handleClickUpload}
                    >
                        {isUploading ? (
                            <div className="text-center">
                                <div className="flex items-center justify-center gap-2">
                                    <Icons.LoadingSpinner className="w-4 h-4 text-gray-200 animate-spin" />
                                    <p className="text-sm font-medium text-gray-200">
                                        Uploading...
                                    </p>
                                </div>
                            </div>
                        ) : (
                            <div className="flex gap-3">
                                <Icons.DirectoryOpen className="w-5 h-5 text-gray-200" />
                                <p className="text-sm font-medium text-gray-200">
                                    Click to select your folder
                                </p>
                            </div>
                        )}
                    </div>

                    <input
                        ref={fileInputRef}
                        type="file"
                        style={{ display: 'none' }}
                        onChange={handleFileInputChange}
                        {...({
                            directory: '',
                            webkitdirectory: '',
                        } as React.InputHTMLAttributes<HTMLInputElement>)}
                    />
                </motion.div>
            );
        }

        const statusConfig = {
            valid: {
                bgColor: 'bg-teal-900',
                borderColor: 'border-teal-600',
                iconBgColor: 'bg-teal-500',
                textColor: 'text-teal-100',
                subTextColor: 'text-teal-200',
                icon: (
                    <Icons.CheckCircled className="w-5 h-5 text-teal-200 group-hover:opacity-0 transition-opacity duration-200" />
                ),
                showError: false,
            },
            invalid: {
                bgColor: 'bg-amber-900',
                borderColor: 'border-amber-600',
                iconBgColor: 'bg-amber-500',
                textColor: 'text-amber-100',
                subTextColor: 'text-amber-200',
                icon: <Icons.ExclamationTriangle className="w-5 h-5 text-amber-200" />,
                showError: true,
            },
        };

        const config = validation?.isValid ? statusConfig.valid : statusConfig.invalid;

        return (
            <motion.div
                key="folderPath"
                initial={{ opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.9 }}
                className={`w-full flex flex-row items-center border p-4 rounded-lg ${config.bgColor} ${config.borderColor} gap-2 group relative`}
            >
                <div
                    className={`flex flex-col gap-2 w-full ${config.showError ? '' : 'flex-row items-center justify-between'}`}
                >
                    <div className="flex flex-row items-center justify-between w-full gap-3">
                        <div className={`p-3 ${config.iconBgColor} rounded-lg`}>
                            <Icons.Directory className="w-5 h-5" />
                        </div>
                        <div className="flex flex-col gap-1 break-all w-full">
                            <p className={`text-regular ${config.textColor}`}>{projectData.name}</p>
                            <p className={`text-mini ${config.subTextColor}`}>
                                {projectData.folderPath}
                            </p>
                        </div>
                        {config.icon}
                    </div>
                    {config.showError && (
                        <p className={`${config.textColor} text-sm`}>
                            This is not a NextJS Project
                        </p>
                    )}
                </div>
                {validation?.isValid && (
                    <Button
                        className={`absolute right-4 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 hover:bg-transparent p-0 size-10 transition-opacity duration-200 ${config.bgColor}`}
                        variant="ghost"
                        size="icon"
                        onClick={reset}
                    >
                        <Icons.MinusCircled className="w-5 h-5 text-teal-200" />
                    </Button>
                )}
            </motion.div>
        );
    };

    const renderLocalHeader = () => {
        if (!debouncedPath) {
            return (
                <>
                    <CardTitle>{'Select your project folder'}</CardTitle>
                    <CardDescription>
                        {'Type the absolute path of your Next.js project folder on disk'}
                    </CardDescription>
                </>
            );
        }
        if (isValidatingPath) {
            return (
                <>
                    <CardTitle>{'Verifying compatibility with Onlook'}</CardTitle>
                    <CardDescription>
                        {"We're checking to make sure this project can work with Onlook"}
                    </CardDescription>
                </>
            );
        }
        if (validateError || !pathValidation?.valid) {
            return (
                <>
                    <CardTitle>{"This project won't work with Onlook"}</CardTitle>
                    <CardDescription>
                        {'Onlook only works with NextJS + React + Tailwind projects'}
                    </CardDescription>
                </>
            );
        }
        return (
            <>
                <CardTitle>{'Project verified'}</CardTitle>
                <CardDescription>{'Your project is ready to import to Onlook'}</CardDescription>
            </>
        );
    };

    const renderLocalStatus = (expectedPort: number) => {
        if (!debouncedPath) {
            return (
                <p className="text-mini text-gray-200">
                    {'Onlook will read and edit the files in this folder directly.'}
                </p>
            );
        }
        if (isValidatingPath) {
            return (
                <div className="flex items-center gap-2">
                    <Icons.LoadingSpinner className="w-4 h-4 text-gray-200 animate-spin" />
                    <p className="text-mini text-gray-200">{'Checking folder...'}</p>
                </div>
            );
        }
        if (validateError) {
            return (
                <p className="text-mini text-red-400">
                    {'Could not verify the folder. Is the Onlook local server running?'}
                </p>
            );
        }
        if (pathValidation && !pathValidation.valid) {
            return <p className="text-mini text-red-400">{pathValidation.error}</p>;
        }
        if (pathValidation?.valid) {
            const portWarning =
                pathValidation.devPort !== undefined && pathValidation.devPort !== expectedPort;
            return (
                <div className="flex flex-col gap-1">
                    <div className="flex items-center gap-2">
                        <Icons.CheckCircled className="w-4 h-4 text-teal-200" />
                        <p className="text-mini text-teal-200">
                            {`${pathValidation.name ?? 'Next.js project'} — ${
                                pathValidation.routerType === 'app' ? 'App' : 'Pages'
                            } router detected`}
                        </p>
                    </div>
                    <p className="text-mini text-gray-200 break-all">{pathValidation.resolvedPath}</p>
                    {portWarning && (
                        <p className="text-mini text-amber-400">
                            {`Your dev script uses port ${pathValidation.devPort}. Start your app on port ${expectedPort} (e.g. "npm run dev -- -p ${expectedPort}") so the live preview works.`}
                        </p>
                    )}
                </div>
            );
        }
        return null;
    };

    const renderLocalContent = () => {
        const expectedPort = getExpectedPreviewPort();
        return (
            <motion.div
                key="localPath"
                initial={{ opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.9 }}
                className="w-full space-y-4"
            >
                <div className="flex flex-col gap-2">
                    <label
                        htmlFor="local-project-path"
                        className="text-sm font-medium text-gray-200"
                    >
                        {'Project folder on disk (absolute path)'}
                    </label>
                    <input
                        id="local-project-path"
                        type="text"
                        value={localPathInput}
                        onChange={(event) => setLocalPathInput(event.target.value)}
                        placeholder="E:\path\to\your\project"
                        autoComplete="off"
                        spellCheck={false}
                        className="w-full h-10 rounded-md bg-gray-900 border border-gray-300 px-3 text-sm text-gray-200 outline-none focus:border-blue-400"
                    />
                </div>
                {renderLocalStatus(expectedPort)}
            </motion.div>
        );
    };

    return (
        <>
            <StepHeader>{isLocalMode ? renderLocalHeader() : renderHeader()}</StepHeader>
            <StepContent>{isLocalMode ? renderLocalContent() : renderProjectInfo()}</StepContent>
            <StepFooter>
                <Button type="button" onClick={prevStep} variant="outline" className="px-3 py-2">
                    Cancel
                </Button>
                {isLocalMode ? (
                    <Button
                        type="button"
                        onClick={nextStep}
                        className="px-3 py-2"
                        disabled={!pathValidation?.valid || isValidatingPath}
                    >
                        Finish setup
                    </Button>
                ) : projectData.folderPath ? (
                    <Button
                        type="button"
                        onClick={validation?.isValid ? nextStep : reset}
                        className="px-3 py-2"
                        disabled={isUploading}
                    >
                        {validation?.isValid ? 'Finish setup' : 'Select a different folder'}
                    </Button>
                ) : (
                    <Button
                        disabled={!projectData.folderPath || !!error || isUploading}
                        type="button"
                        onClick={nextStep}
                        className="px-3 py-2"
                    >
                        Continue
                    </Button>
                )}
            </StepFooter>
        </>
    );
};
