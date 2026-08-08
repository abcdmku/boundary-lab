export function Toasts({ toasts }) {
  if (!toasts.length) return null;
  return (
    <div
      className="toast-stack fixed top-14 right-4 flex flex-col gap-2"
      role="status"
      aria-live="polite"
      aria-atomic="false"
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          className="max-w-80 rounded-lg border border-[color-mix(in_srgb,var(--destructive-foreground)_45%,transparent)]
                     bg-popover px-3 py-2 text-[13px] text-destructive-foreground"
        >
          {t.msg}
        </div>
      ))}
    </div>
  );
}
