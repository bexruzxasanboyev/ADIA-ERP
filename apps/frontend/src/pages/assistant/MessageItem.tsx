import { Bot, User as UserIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { formatDateTime } from '@/lib/format';
import type { AssistantMessage } from '@/lib/types';
import { Markdown } from './markdown';
import { ToolCallList } from './ToolCallBadge';

/**
 * A single chat row.
 *
 * Visual contract:
 *  - `user`      → right-aligned bubble (cobalt primary tint).
 *  - `assistant` → full-width on the left, no bubble, with markdown body and
 *                  a wrapped row of tool-call chips underneath.
 *  - `tool`      → not rendered as a standalone row; tool activity is shown
 *                  attached to the assistant message that triggered it.
 *                  This branch is here only so the type is exhaustive in
 *                  case session history surfaces a stray tool row.
 */
export function MessageItem({ message }: { message: AssistantMessage }) {
  if (message.role === 'user') {
    return (
      <div className="flex justify-end" data-role="user">
        <div className="flex max-w-[85%] flex-col items-end gap-1">
          <div className="rounded-2xl rounded-tr-sm bg-primary/15 px-4 py-2.5 text-sm text-foreground ring-1 ring-primary/20">
            <span className="whitespace-pre-wrap break-words">
              {message.content}
            </span>
          </div>
          <time
            className="px-1 text-[10px] uppercase tracking-wider text-muted-foreground"
            dateTime={message.created_at}
          >
            {formatDateTime(message.created_at)}
          </time>
        </div>
      </div>
    );
  }

  if (message.role === 'tool') {
    // Tool rows surface only when reconstructing history; we render them as
    // a thin diagnostic strip so the timeline stays auditable.
    return (
      <div className="flex justify-start" data-role="tool">
        <ToolCallList calls={message.tool_calls ?? []} />
      </div>
    );
  }

  // assistant
  return (
    <div className="flex gap-3" data-role="assistant">
      <span
        aria-hidden="true"
        className="mt-1 inline-flex size-7 shrink-0 items-center justify-center rounded-full bg-info/15 text-info ring-1 ring-info/30"
      >
        <Bot className="size-4" />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        {message.content.length > 0 ? (
          <Markdown text={message.content} />
        ) : (
          <p className="text-sm text-muted-foreground italic">
            (Javob bo‘sh)
          </p>
        )}
        {message.tool_calls && message.tool_calls.length > 0 && (
          <ToolCallList calls={message.tool_calls} />
        )}
        <time
          className="text-[10px] uppercase tracking-wider text-muted-foreground"
          dateTime={message.created_at}
        >
          {formatDateTime(message.created_at)}
        </time>
      </div>
    </div>
  );
}

/** Decorative icon variant used in empty-state / branding spots. */
export function AssistantAvatar({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'inline-flex size-9 items-center justify-center rounded-full bg-info/15 text-info ring-1 ring-info/30',
        className,
      )}
    >
      <Bot className="size-5" />
    </span>
  );
}

/** Decorative user avatar (currently unused inline but exported for symmetry). */
export function UserAvatar({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'inline-flex size-7 items-center justify-center rounded-full bg-primary/15 text-primary ring-1 ring-primary/20',
        className,
      )}
    >
      <UserIcon className="size-4" />
    </span>
  );
}
