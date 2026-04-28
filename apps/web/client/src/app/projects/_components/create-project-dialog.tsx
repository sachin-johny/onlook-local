'use client';

import { useState } from 'react';
import { Button } from '@onlook/ui/button';
import { Input } from '@onlook/ui/input';
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogFooter,
} from '@onlook/ui/dialog';

interface CreateProjectDialogProps {
    open: boolean;
    onClose: () => void;
    onSubmit: (name: string) => void;
}

export function CreateProjectDialog({ open, onClose, onSubmit }: CreateProjectDialogProps) {
    const [name, setName] = useState('My Project');

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        if (!name.trim()) return;
        onSubmit(name.trim());
        setName('My Project');
    };

    return (
        <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
            <DialogContent className="sm:max-w-md">
                <DialogHeader>
                    <DialogTitle>Name your project</DialogTitle>
                </DialogHeader>
                <form onSubmit={handleSubmit} className="flex flex-col gap-4 py-2">
                    <Input
                        autoFocus
                        placeholder="My Project"
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        onKeyDown={(e) => e.key === 'Escape' && onClose()}
                    />
                    <DialogFooter>
                        <Button type="button" variant="ghost" onClick={onClose}>
                            Cancel
                        </Button>
                        <Button type="submit" disabled={!name.trim()}>
                            Create Project
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}