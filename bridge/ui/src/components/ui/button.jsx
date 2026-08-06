import { cva } from "class-variance-authority";
import { cn } from "../../lib/cn";

// Simplified cousin of t3's packages/ui/src/button.tsx: same tokens, radii
// and focus-ring treatment, fewer variants — this app only ever needs a
// quiet outline button (Cancel) and a quiet destructive one (Delete).
const buttonVariants = cva(
  "inline-flex h-7 shrink-0 cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap " +
    "rounded-lg border px-3 text-[13px] font-medium outline-none transition-colors " +
    "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background " +
    "disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        outline: "border-border bg-card text-foreground hover:bg-accent",
        "destructive-outline": "border-border bg-card text-destructive-foreground hover:bg-destructive/8",
      },
    },
    defaultVariants: { variant: "outline" },
  },
);

export function Button({ className, variant, ...props }) {
  return <button className={cn(buttonVariants({ variant }), className)} {...props} />;
}
