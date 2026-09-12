import { useEditorEngine } from '@/components/store/editor';
import { transKeys } from '@/i18n/keys';
import { Button } from '@onlook/ui/button';
import { Icons } from '@onlook/ui/icons';
import { Tooltip, TooltipContent, TooltipTrigger } from '@onlook/ui/tooltip';
import { observer } from 'mobx-react-lite';
import { useTranslations } from 'next-intl';

export const ChatControls = observer(() => {
    const editorEngine = useEditorEngine();
    const t = useTranslations();

    const isStartingNewConversation = editorEngine.chat.conversation.creatingConversation;
    const isDisabled = editorEngine.chat.isStreaming || isStartingNewConversation;

    const handleNewChat = () => {
        editorEngine.chat.conversation.startNewConversation();
        editorEngine.chat.focusChatInput();
    };

    const handleMinimize = () => {
        editorEngine.state.isChatPanelMinimized = true;
    };

    return (
        <div className="flex flex-row">
            <Tooltip>
                <TooltipTrigger asChild>
                    <span className="inline-block">
                        <Button
                            variant={'ghost'}
                            size={'icon'}
                            className="py-1 px-2 w-fit h-fit bg-transparent hover:!bg-transparent cursor-pointer group text-foreground-secondary hover:text-foreground-primary"
                            onClick={handleNewChat}
                            disabled={isDisabled}
                        >
                            {isStartingNewConversation ? (
                                <>
                                    <Icons.LoadingSpinner className="h-4 w-4 animate-spin" />
                                    <span className="text-small">New Chat</span>
                                </>
                            ) : (
                                <>
                                    <Icons.Edit className="h-4 w-4" />
                                    <span className="text-small">New Chat</span>
                                </>
                            )}
                        </Button>
                    </span>
                </TooltipTrigger>
                {isDisabled && (
                    <TooltipContent side="bottom" hideArrow>
                        AI is still loading
                    </TooltipContent>
                )}
            </Tooltip>
            <Tooltip>
                <TooltipTrigger asChild>
                    <Button
                        variant={'ghost'}
                        size={'icon'}
                        aria-label={t(transKeys.editor.panels.edit.tabs.chat.controls.minimize)}
                        className="py-1 px-2 w-fit h-fit bg-transparent hover:!bg-transparent cursor-pointer text-foreground-secondary hover:text-foreground-primary"
                        onClick={handleMinimize}
                    >
                        <Icons.PinRight className="h-4 w-4" />
                    </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom" hideArrow>
                    {t(transKeys.editor.panels.edit.tabs.chat.controls.minimize)}
                </TooltipContent>
            </Tooltip>
        </div>
    );
});
