import { useEffect, useRef, useState } from "react";
import { kindLabel, statusLabel } from "./labels";
import type { Copy, Project, Summary } from "./types";

const date = (locale: string, value: string) =>
  new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(new Date(value));

function DeleteHoldButton({ label, t, open, onDelete }: { label: string; t: Copy; open: boolean; onDelete(): void }) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [holding, setHolding] = useState(false);
  const [keyboardConfirm, setKeyboardConfirm] = useState(false);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const cancel = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setHolding(false);
  };
  return (
    <button
      type="button"
      className="mobile-conversation-delete"
      data-holding={holding}
      tabIndex={open ? 0 : -1}
      aria-label={keyboardConfirm ? `${t.confirmDelete} ${label}` : `${t.holdDelete} ${label}`}
      onPointerDown={(event) => {
        if (event.pointerType !== "mouse" && event.pointerType !== "touch" && event.pointerType !== "pen") return;
        cancel();
        setHolding(true);
        timer.current = setTimeout(() => {
          timer.current = null;
          setHolding(false);
          onDelete();
        }, 1500);
      }}
      onPointerUp={cancel}
      onPointerCancel={cancel}
      onPointerLeave={cancel}
      onClick={(event) => {
        if (event.detail !== 0) return;
        if (keyboardConfirm) onDelete();
        else setKeyboardConfirm(true);
      }}
      onBlur={() => setKeyboardConfirm(false)}
    >
      <span>{keyboardConfirm ? t.confirmDelete : t.deleteConversation}</span>
      <small>{keyboardConfirm ? t.pressAgain : t.holdHint}</small>
    </button>
  );
}

export function ConversationRow({
  entry,
  preview,
  pinned,
  locale,
  t,
  onSelect,
  onPin,
  onDelete,
}: {
  entry: Project;
  preview: Summary | null;
  pinned: boolean;
  locale: string;
  t: Copy;
  onSelect(): void;
  onPin?(): void;
  onDelete?(): void;
}) {
  const [open, setOpen] = useState(false);
  const start = useRef<{ x: number; y: number } | null>(null);
  const suppressClick = useRef(false);
  const hasActions = Boolean(onPin && onDelete);
  return (
    <div
      className="mobile-conversation-item"
      data-actions-open={open}
      onPointerDown={(event) => {
        if (!hasActions || (event.target as HTMLElement).closest(".mobile-conversation-actions")) return;
        start.current = { x: event.clientX, y: event.clientY };
      }}
      onPointerUp={(event) => {
        if (!start.current) return;
        const dx = event.clientX - start.current.x;
        const dy = event.clientY - start.current.y;
        start.current = null;
        if (Math.abs(dx) > 48 && Math.abs(dx) > Math.abs(dy)) {
          setOpen(dx < 0);
          suppressClick.current = true;
        }
      }}
      onPointerCancel={() => {
        start.current = null;
      }}
    >
      {hasActions && (
        <div className="mobile-conversation-actions" aria-hidden={!open}>
          <button
            type="button"
            tabIndex={open ? 0 : -1}
            onClick={() => {
              onPin?.();
              setOpen(false);
            }}
          >
            {pinned ? t.unpinConversation : t.pinConversation}
          </button>
          <DeleteHoldButton
            label={entry.title}
            t={t}
            open={open}
            onDelete={() => {
              onDelete?.();
              setOpen(false);
            }}
          />
        </div>
      )}
      <div className="mobile-conversation-front">
        <button
          type="button"
          className="mobile-conversation-row"
          onClick={(event) => {
            if (suppressClick.current) {
              suppressClick.current = false;
              event.preventDefault();
              return;
            }
            if (open) {
              setOpen(false);
              return;
            }
            onSelect();
          }}
        >
          <span className="mobile-conversation-avatar" aria-hidden="true">
            {entry.title.slice(0, 1).toUpperCase()}
          </span>
          <span className="mobile-conversation-copy">
            <span className="mobile-conversation-top">
              <strong>
                {entry.title}
                {pinned ? " ★" : ""}
              </strong>
              {preview && <time dateTime={preview.createdAt}>{date(locale, preview.createdAt)}</time>}
            </span>
            <span className="mobile-conversation-preview">
              {preview?.summary ?? entry.description ?? t.emptyConversation}
            </span>
            <span className="mobile-conversation-bottom">
              {preview ? `${t.latest} · ${kindLabel(preview.kind, locale)}` : statusLabel(entry.status, locale)}
            </span>
          </span>
          <span className="mobile-conversation-arrow" aria-hidden="true">
            ›
          </span>
        </button>
        {hasActions && (
          <button
            type="button"
            className="mobile-conversation-actions-toggle"
            aria-expanded={open}
            aria-label={`${open ? t.closeActions : t.openActions} ${entry.title}`}
            onClick={() => setOpen((value) => !value)}
          >
            ⋯
          </button>
        )}
      </div>
    </div>
  );
}
