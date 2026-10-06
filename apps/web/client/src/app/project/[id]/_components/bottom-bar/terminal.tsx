"use client";

import "@xterm/xterm/css/xterm.css";

import { useEditorEngine } from "@/components/store/editor";
import { cn } from "@onlook/ui/utils";
import { type ITheme } from "@xterm/xterm";
import { observer } from "mobx-react-lite";
import { useTheme } from "next-themes";
import { memo, useCallback, useEffect, useRef } from "react";

interface TerminalProps {
  hidden: boolean;
  terminalSessionId: string;
  branchId?: string;
  isActive?: boolean;
}

const TERMINAL_THEME: Record<"LIGHT" | "DARK", ITheme> = {
  LIGHT: {
    background: "#ffffff",
    foreground: "#2d2d2d",
    cursor: "#333333",
    cursorAccent: "#ffffff",
    black: "#2d2d2d",
    red: "#d64646",
    green: "#4e9a06",
    yellow: "#c4a000",
    blue: "#3465a4",
    magenta: "#75507b",
    cyan: "#06989a",
    white: "#d3d7cf",
    brightBlack: "#555753",
    brightRed: "#ef2929",
    brightGreen: "#8ae234",
    brightYellow: "#fce94f",
    brightBlue: "#729fcf",
    brightMagenta: "#ad7fa8",
    brightCyan: "#34e2e2",
    brightWhite: "#eeeeec",
    selectionBackground: "#bfbfbf",
  },
  DARK: {},
};

/**
 * Terminal React component — renders an xterm.js instance attached to a
 * CLISessionImpl-managed terminal session.
 *
 * Key design decisions:
 * 1. The xterm instance is owned by CLISessionImpl, NOT by this component.
 *    This component only attaches/detaches the xterm DOM element into its
 *    container div. This prevents React re-renders from destroying the
 *    terminal session.
 *
 * 2. On unmount, we detach the xterm element but do NOT dispose the session.
 *    On remount, we reattach the same xterm. This handles the case where
 *    browser resize or HMR causes the component to unmount and remount.
 *
 * 3. ResizeObserver triggers fitAddon.fit() which recalculates the terminal
 *    grid dimensions. If the terminal is reconnecting, resize messages are
 *    silently dropped by the PtyClient (it buffers or ignores sends when
 *    not connected), and re-sent once reconnected via the onResize handler.
 */
export const Terminal = memo(
  observer(
    ({
      hidden = false,
      terminalSessionId,
      branchId,
      isActive = true,
    }: TerminalProps) => {
      const editorEngine = useEditorEngine();

      const terminalSession = branchId
        ? editorEngine.branches
            .getSandboxById(branchId)
            ?.session?.getTerminalSession(terminalSessionId)
        : editorEngine.activeSandbox?.session?.getTerminalSession(
            terminalSessionId,
          );

      const containerRef = useRef<HTMLDivElement | null>(null);
      const { theme } = useTheme();
      const isOpenedRef = useRef(false);
      const rafRef = useRef<number | null>(null);
      const timerRef = useRef<number | null>(null);

      const clearScheduledFit = useCallback(() => {
        if (rafRef.current != null) {
          cancelAnimationFrame(rafRef.current);
          rafRef.current = null;
        }
        if (timerRef.current != null) {
          window.clearTimeout(timerRef.current);
          timerRef.current = null;
        }
      }, []);

      const scheduleFit = useCallback(
        (focus = false) => {
          clearScheduledFit();

          rafRef.current = requestAnimationFrame(() => {
            timerRef.current = window.setTimeout(() => {
              const container = containerRef.current;
              const session = terminalSession;
              if (
                !container ||
                !session?.fitAddon ||
                !session.xterm ||
                hidden ||
                !isActive ||
                !isOpenedRef.current
              ) {
                return;
              }

              const { width, height } = container.getBoundingClientRect();
              if (width < 20 || height < 20) return;

              try {
                session.fitAddon.fit();
                session.xterm.refresh(0, Math.max(session.xterm.rows - 1, 0));
                if (focus) session.xterm.focus();
              } catch (err) {
                // fitAddon.fit() can throw if the terminal is in a transitional
                // state (e.g., just disposed or reconnected). Log and move on.
                console.warn("[terminal] fitAddon.fit() failed:", err);
              }
            }, 16);
          });
        },
        [clearScheduledFit, hidden, isActive, terminalSession],
      );

      // ─── Attach/detach xterm to/from the DOM ──────────────────────────
      //
      // Critical: We only move the xterm DOM element in/out of our container.
      // We do NOT create or destroy the xterm instance here — that's owned by
      // CLISessionImpl. This means React re-renders and remounts are safe.
      useEffect(() => {
        if (!isActive || !containerRef.current || !terminalSession?.xterm)
          return;

        // Already attached to this container — just refit
        if (
          terminalSession.xterm.element?.parentElement === containerRef.current
        ) {
          scheduleFit(false);
          return;
        }

        // If xterm is currently attached to a different container (e.g., from
        // a previous mount), detach it first
        if (terminalSession.xterm.element?.parentElement) {
          try {
            terminalSession.xterm.element.parentElement.removeChild(terminalSession.xterm.element);
          } catch {
            // Element may have already been removed by a concurrent unmount
          }
        }

        // Attach xterm into our container.
        // NOTE: xterm.open() is a no-op for already-opened terminals (returns
        // early at _element?.ownerDocument.defaultView check).  We must use
        // appendChild so that a previously-detached element gets re-attached.
        if (!terminalSession.xterm.element) {
          terminalSession.xterm.open(containerRef.current);
        } else {
          containerRef.current.appendChild(terminalSession.xterm.element);
        }
        isOpenedRef.current = true;
        scheduleFit(false);

        return () => {
          clearScheduledFit();

          // Detach xterm from our container, but do NOT dispose it.
          // The session (CLISessionImpl) owns the xterm lifecycle.
          // On remount, we'll reattach the same xterm instance.
          if (
            terminalSession?.xterm?.element &&
            containerRef.current &&
            terminalSession.xterm.element.parentElement === containerRef.current
          ) {
            try {
              containerRef.current.removeChild(terminalSession.xterm.element);
            } catch {
              // Already removed — concurrent unmount race
            }
          }

          isOpenedRef.current = false;
        };
      }, [
        terminalSessionId,
        terminalSession,
        branchId,
        isActive,
        scheduleFit,
        clearScheduledFit,
      ]);

      // ─── Theme switching ────────────────────────────────────────────────
      useEffect(() => {
        if (terminalSession?.xterm) {
          terminalSession.xterm.options.theme =
            theme === "light" ? TERMINAL_THEME.LIGHT : TERMINAL_THEME.DARK;
        }
      }, [theme, terminalSession]);

      // ─── Refit on visibility changes ────────────────────────────────────
      useEffect(() => {
        if (!hidden && isActive) {
          scheduleFit(true);
        }
      }, [hidden, isActive, scheduleFit]);

      // ─── Resize handling with debounce ──────────────────────────────────
      useEffect(() => {
        const container = containerRef.current;
        if (!container || !terminalSession?.fitAddon || !isActive) return;

        const onVisible = () => {
          if (!document.hidden) scheduleFit(false);
        };

        // Debounce resize events to avoid flooding the PTY with resize messages.
        // Browser resize can fire dozens of events per second during a drag.
        let resizeTimer: ReturnType<typeof setTimeout> | null = null;
        const RESIZE_DEBOUNCE_MS = 50;

        const observer = new ResizeObserver(() => {
          if (resizeTimer) clearTimeout(resizeTimer);
          resizeTimer = setTimeout(() => {
            resizeTimer = null;
            scheduleFit(false);
          }, RESIZE_DEBOUNCE_MS);
        });

        observer.observe(container);
        window.addEventListener("resize", onVisible);
        window.addEventListener("focus", onVisible);
        document.addEventListener("visibilitychange", onVisible);

        // Fullscreen transitions can cause xterm.js canvas rendering to go
        // stale (DPR rounding, WebGL context shift, compositing change).
        // The fullscreenchange event fires AFTER the transition settles, so
        // a delayed refit here reliably recovers the renderer.
        const onFullscreenChange = () => {
          setTimeout(() => scheduleFit(false), 100);
        };
        document.addEventListener("fullscreenchange", onFullscreenChange);

        return () => {
          if (resizeTimer) clearTimeout(resizeTimer);
          observer.disconnect();
          window.removeEventListener("resize", onVisible);
          window.removeEventListener("focus", onVisible);
          document.removeEventListener("visibilitychange", onVisible);
          document.removeEventListener("fullscreenchange", onFullscreenChange);
          clearScheduledFit();
        };
      }, [terminalSession, isActive, scheduleFit, clearScheduledFit]);

      return (
        <div
          ref={containerRef}
          className={cn("h-full w-full overflow-hidden", hidden && "invisible")}
        />
      );
    },
  ),
);
