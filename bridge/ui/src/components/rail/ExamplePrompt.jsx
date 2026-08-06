import { useState } from "react";
import { Check, Copy } from "lucide-react";

// Quiet inset, click-to-copy — this is copy-paste vocabulary for
// prompting the AI, not a form control. The copy icon only shows on
// hover; a brief "copied" check confirms the click.
export function ExamplePrompt({ text }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.append(ta);
      ta.select();
      try {
        document.execCommand("copy");
      } catch {
        /* give up quietly */
      }
      ta.remove();
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };

  return (
    <div
      className="group/prompt mt-1 mb-1.5 ml-5 flex cursor-pointer items-start gap-1.5 border-l-2 border-border py-0.5
                 pl-2.5 text-[12px] leading-snug italic text-muted-foreground transition-colors hover:text-foreground"
      title="Click to copy"
      onClick={copy}
    >
      <span className="min-w-0 break-words">“{text}”</span>
      {copied ? (
        <span className="flex shrink-0 items-center gap-1 not-italic text-success-foreground">
          <Check size={12} aria-hidden />
          copied
        </span>
      ) : (
        <Copy
          size={12}
          aria-hidden
          className="mt-0.5 shrink-0 opacity-0 transition-opacity group-hover/prompt:opacity-60"
        />
      )}
    </div>
  );
}
