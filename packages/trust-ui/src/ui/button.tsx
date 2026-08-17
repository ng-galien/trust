import type { ButtonHTMLAttributes, ReactNode, Ref } from "react";

import { cx } from "../lib/format.js";

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md";

const base =
  "inline-flex items-center justify-center gap-1.5 rounded-(--radius-2) font-medium whitespace-nowrap select-none transition-colors disabled:opacity-50";

const variants: Record<Variant, string> = {
  primary: "bg-accent text-accent-contrast hover:bg-accent-hover",
  secondary: "border border-border bg-surface text-text hover:bg-surface-2 hover:border-border-strong",
  ghost: "text-muted hover:bg-surface-3 hover:text-text",
  danger: "border border-border bg-surface text-danger hover:bg-danger-soft",
};

const sizes: Record<Size, string> = {
  sm: "h-7 px-2.5 text-body",
  md: "h-8 px-3 text-ui",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  icon?: ReactNode;
  /** React 19: ref is a plain prop, forwarded to the button element. */
  ref?: Ref<HTMLButtonElement>;
}

export function Button({ variant = "secondary", size = "md", icon, className, children, type = "button", ...rest }: ButtonProps) {
  return (
    <button type={type} className={cx(base, variants[variant], sizes[size], className)} {...rest}>
      {icon}
      {children}
    </button>
  );
}

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  size?: Size;
  active?: boolean;
}

export function IconButton({ label, size = "md", active, className, children, type = "button", ...rest }: IconButtonProps) {
  return (
    <button
      type={type}
      aria-label={label}
      title={label}
      className={cx(
        "inline-flex items-center justify-center rounded-(--radius-2) text-muted transition-colors hover:bg-surface-3 hover:text-text disabled:opacity-50",
        size === "sm" ? "h-7 w-7" : "h-8 w-8",
        active && "bg-surface-3 text-text",
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}
