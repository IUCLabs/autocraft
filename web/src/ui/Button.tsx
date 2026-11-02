// Adapted from ArtCraft libs/components/button/src/lib/button.tsx (MIT OR Apache-2.0).
// Same variants and mono uppercase label; colours go through theme tokens so the
// primary (ink-filled) button works in light mode too, and a size scale was added.
import { forwardRef, type ButtonHTMLAttributes } from "react";
import type { LucideIcon } from "lucide-react";
import { LoaderCircleIcon } from "lucide-react";
import { cn } from "./cn";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon?: LucideIcon;
  iconAfter?: boolean;
  variant?: "primary" | "secondary" | "ghost" | "destructive" | "accent";
  size?: "sm" | "md" | "lg";
  loading?: boolean;
}

const variants = {
  primary: "bg-ink text-inv border-ink hover:bg-ink/90 font-bold",
  secondary: "bg-ink/5 text-ink border-line hover:bg-ink/[0.08] hover:border-line-strong",
  ghost: "bg-transparent text-ink/70 border-transparent hover:text-ink hover:bg-ink/5",
  destructive: "bg-bad text-white border-bad hover:bg-bad/90",
  accent: "bg-accent text-white border-accent hover:bg-accent/90",
};
const sizes = {
  sm: "h-7 px-2.5 gap-1.5 text-2xs",
  md: "h-9 px-3.5 gap-2 text-xs",
  lg: "h-12 px-4 gap-2.5 text-xs",
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { icon: Icon, iconAfter, variant = "secondary", size = "md", loading, className, children, disabled, ...rest },
  ref,
) {
  const icon = loading ? <LoaderCircleIcon className="animate-spin" /> : Icon ? <Icon /> : null;
  return (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={cn(
        "inline-flex shrink-0 select-none items-center justify-center whitespace-nowrap rounded border font-mono font-semibold uppercase tracking-[0.12em] transition-colors duration-fast",
        "disabled:pointer-events-none disabled:opacity-50",
        variants[variant],
        sizes[size],
        className,
      )}
      {...rest}
    >
      {!iconAfter && icon}
      {children}
      {iconAfter && icon}
    </button>
  );
});

export const IconButton = forwardRef<HTMLButtonElement, ButtonProps & { label: string }>(function IconButton(
  { label, className, size = "md", ...rest },
  ref,
) {
  const box = { sm: "size-7", md: "size-9", lg: "size-11" }[size];
  return <Button ref={ref} aria-label={label} title={label} variant="ghost" size={size} className={cn(box, "px-0", className)} {...rest} />;
});
