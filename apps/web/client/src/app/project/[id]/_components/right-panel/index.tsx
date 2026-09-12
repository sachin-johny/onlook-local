'use client';

import { useEditorEngine } from '@/components/store/editor';
import { transKeys } from '@/i18n/keys';
import { Icons } from '@onlook/ui/icons/index';
import { ResizablePanel } from '@onlook/ui/resizable';
import { Tooltip, TooltipContent, TooltipTrigger } from '@onlook/ui/tooltip';
import { observer } from 'mobx-react-lite';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { ChatTab } from './chat-tab';
import { ChatControls } from './chat-tab/controls';
import { ChatHistory } from './chat-tab/history';
import { ChatPanelDropdown } from './chat-tab/panel-dropdown';

export const RightPanel = observer(() => {
    const editorEngine = useEditorEngine();
    const t = useTranslations();
    const [isChatHistoryOpen, setIsChatHistoryOpen] = useState(false);
    const currentConversation = editorEngine.chat.conversation.current;
    const editPanelWidth = 352

    if (editorEngine.state.isChatPanelMinimized) {
        return (
            <div className="flex h-full w-full justify-end">
                <Tooltip>
                    <TooltipTrigger asChild>
                        <button
                            aria-label={t(transKeys.editor.panels.edit.tabs.chat.controls.restore)}
                            className="mt-2 flex cursor-pointer flex-col items-center gap-2 rounded-l-xl border-[0.5px] bg-background/95 px-1.5 py-3 text-foreground-secondary shadow backdrop-blur-xl transition-colors hover:text-foreground-primary"
                            onClick={() => (editorEngine.state.isChatPanelMinimized = false)}
                        >
                            <Icons.Sparkles className="h-4 w-4" />
                            <span className="text-small [writing-mode:vertical-rl]">
                                {t(transKeys.editor.panels.edit.tabs.chat.name)}
                            </span>
                        </button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" hideArrow>
                        {t(transKeys.editor.panels.edit.tabs.chat.controls.restore)}
                    </TooltipContent>
                </Tooltip>
            </div>
        );
    }

    return (
        <div
            className='flex h-full w-full transition-width duration-300 bg-background/95 group/panel border-[0.5px] backdrop-blur-xl shadow rounded-tl-xl'
        >
            <ResizablePanel
                side="right"
                defaultWidth={editPanelWidth}
                forceWidth={editPanelWidth}
                minWidth={240}
                maxWidth={500}
            >
                <div className='flex flex-col h-full'>
                    <div className="flex flex-row p-1 w-full h-10 border-b border-border ">
                        <ChatPanelDropdown
                            isChatHistoryOpen={isChatHistoryOpen}
                            setIsChatHistoryOpen={setIsChatHistoryOpen}
                        >
                            <div
                                className="flex items-center gap-1.5 bg-transparent p-1 px-2 text-sm text-foreground-secondary hover:text-foreground-primary cursor-pointer group"
                            >
                                <Icons.Sparkles className="mr-0.5 mb-0.5 h-4 w-4" />
                                {t(transKeys.editor.panels.edit.tabs.chat.name)}
                                <Icons.ChevronDown className="ml-0.5 h-3 w-3 text-muted-foreground group-hover:text-foreground-primary" />
                            </div>
                        </ChatPanelDropdown>
                        <div className='ml-auto'>
                            <ChatControls />
                        </div>
                    </div>
                    <ChatHistory isOpen={isChatHistoryOpen} onOpenChange={setIsChatHistoryOpen} />

                    <div className='flex-1 overflow-y-auto'>
                        {currentConversation && (
                            <ChatTab
                                conversationId={currentConversation.id}
                                projectId={editorEngine.projectId}
                            />
                        )}
                    </div>
                </div>
            </ResizablePanel >
        </div >
    );
});
