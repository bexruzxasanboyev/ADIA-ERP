import { useEffect, useState } from 'react';
import { Sparkles } from 'lucide-react';
import { cn } from '@/lib/utils';
import { AssistantDrawer } from '@/pages/assistant/AssistantDrawer';

/**
 * Floating AI button — bottom-right of every authenticated screen.
 *
 * Clicking opens `AssistantDrawer`. Kept as a sibling element of the
 * scrollable `<main>` rather than inside it so the button stays pinned
 * even when the page scrolls (CSS `position: fixed`).
 *
 * A11y:
 *  - `aria-label` for screen readers (no visible text by default).
 *  - The drawer itself is a Radix Dialog → handles focus trap / ESC /
 *    inert background for free.
 */
export function AssistantButton({ className }: { className?: string }) {
  const [open, setOpen] = useState(false);

  // Global Ctrl+K / ⌘K toggles the assistant. preventDefault stops the
  // browser's own Ctrl+K (focus address/search bar).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="AI yordamchini ochish (Ctrl+K)"
        title="AI yordamchi · Ctrl+K"
        aria-haspopup="dialog"
        aria-expanded={open}
        className={cn(
          'group fixed bottom-6 right-6 z-40 inline-flex items-center gap-2 rounded-full',
          'bg-primary px-4 py-3 text-sm font-medium text-primary-foreground shadow-pop',
          'ring-1 ring-primary/40 transition-all',
          'hover:translate-y-[-1px] hover:bg-primary/90',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
          className,
        )}
      >
        <Sparkles
          className="size-4 transition-transform group-hover:rotate-12"
          aria-hidden="true"
        />
        <span className="hidden sm:inline">AI yordamchi</span>
        <kbd className="hidden rounded border border-primary-foreground/30 bg-primary-foreground/10 px-1.5 py-0.5 text-[10px] font-medium leading-none text-primary-foreground/80 sm:inline-block">
          ⌘K
        </kbd>
      </button>
      <AssistantDrawer open={open} onOpenChange={setOpen} />
    </>
  );
}
