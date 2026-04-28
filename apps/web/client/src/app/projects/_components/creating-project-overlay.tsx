'use client';

import { AnimatePresence, motion } from 'motion/react';
import { Icons } from '@onlook/ui/icons';

export function CreatingProjectOverlay({ isVisible }: { isVisible: boolean }) {
    return (
        <AnimatePresence>
            {isVisible && (
                <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-background/90 backdrop-blur-sm gap-6"
                >
                    <Icons.Shadow className="w-12 h-12 animate-spin text-foreground-secondary" />
                    <div className="flex flex-col items-center gap-1 text-center">
                        <p className="text-lg font-medium">Creating your project</p>
                        <p className="text-sm text-foreground-secondary">
                            This takes about 30 seconds…
                        </p>
                    </div>
                </motion.div>
            )}
        </AnimatePresence>
    );
}