import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

/* Hand-drawn principle figures — SVG on the interface tokens (theme-aware) with translated labels.
   Kept deliberately few: the model and the architecture; everything else is a Mermaid diagram in the page. */

function Box({ x, y, w, h, title, sub, tone = "surface" }: { x: number; y: number; w: number; h: number; title: string; sub?: string | undefined; tone?: "surface" | "accent" | "success" | "warning" }) {
  const fill = tone === "accent" ? "fill-accent-soft stroke-accent" : tone === "success" ? "fill-success-soft stroke-success" : tone === "warning" ? "fill-warning-soft stroke-warning" : "fill-surface-2 stroke-border-strong";
  return (
    <g>
      <rect x={x} y={y} width={w} height={h} rx={8} className={fill} strokeWidth={1.2} />
      <text x={x + w / 2} y={y + (sub ? h / 2 - 4 : h / 2 + 4)} textAnchor="middle" className="fill-text" fontSize={12.5} fontWeight={600}>{title}</text>
      {sub ? <text x={x + w / 2} y={y + h / 2 + 12} textAnchor="middle" className="fill-muted" fontSize={10.5}>{sub}</text> : null}
    </g>
  );
}

function Arrow({ d, label, dashed = false, labelAt }: { d: string; label?: string; dashed?: boolean; labelAt?: [number, number] }) {
  return (
    <g>
      <path d={d} className="stroke-muted" fill="none" strokeWidth={1.3} markerEnd="url(#docs-arrow)" strokeDasharray={dashed ? "4 3" : undefined} />
      {label && labelAt ? (
        <text x={labelAt[0]} y={labelAt[1]} textAnchor="middle" className="fill-muted" fontSize={10.5} paintOrder="stroke" stroke="var(--color-surface)" strokeWidth={4} strokeLinejoin="round">{label}</text>
      ) : null}
    </g>
  );
}

function Lane({ x, y, w, h, label, children }: { x: number; y: number; w: number; h: number; label: string; children: ReactNode }) {
  return (
    <g>
      <rect x={x} y={y} width={w} height={h} rx={12} className="fill-surface stroke-border" strokeWidth={1} strokeDasharray="5 4" />
      <text x={x + 12} y={y + 18} className="fill-faint" fontSize={10.5} fontWeight={600} letterSpacing={1}>{label.toUpperCase()}</text>
      {children}
    </g>
  );
}

function Defs() {
  return (
    <defs>
      <marker id="docs-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
        <path d="M 0 0 L 10 5 L 0 10 z" className="fill-muted" />
      </marker>
    </defs>
  );
}

/** The product model: authored, immutable objects (design lane) and what happens when a Plan runs (run lane). */
export function ModelFigure() {
  const { t } = useTranslation();
  return (
    <svg viewBox="0 0 780 260" preserveAspectRatio="xMidYMid meet" role="img" aria-label={t("docs.figures.model.alt")} className="mx-auto block h-auto min-w-0 max-w-full font-sans">
      <Defs />
      <Lane x={8} y={8} w={764} h={100} label={t("docs.figures.model.design")}>
        <Box x={28} y={40} w={140} h={48} title={t("docs.figures.model.operation")} tone="accent" />
        <Box x={230} y={28} w={522} h={68} title="" />
        <text x={244} y={48} className="fill-text" fontSize={12.5} fontWeight={600}>{t("docs.figures.model.procedure")}</text>
        <Box x={244} y={54} w={220} h={34} title={t("docs.figures.model.scenario")} />
        <Box x={492} y={54} w={242} h={34} title={t("docs.figures.model.check")} tone="accent" />
        <Arrow d="M 168 64 L 228 64" label={t("docs.figures.model.usedBy")} labelAt={[198, 56]} />
      </Lane>
      <Lane x={8} y={126} w={764} h={118} label={t("docs.figures.model.run")}>
        <Box x={28} y={166} w={120} h={48} title={t("docs.figures.model.plan")} tone="accent" />
        <Box x={178} y={166} w={120} h={48} title={t("docs.figures.model.attempt")} />
        <Box x={328} y={166} w={100} h={48} title={t("docs.figures.model.facts")} />
        <Box x={458} y={166} w={130} h={48} title={t("docs.figures.model.verdict")} tone="success" />
        <Box x={618} y={166} w={120} h={48} title={t("docs.figures.model.revision")} />
        <Arrow d="M 148 190 L 176 190" />
        <Arrow d="M 298 190 L 326 190" />
        <Arrow d="M 428 190 L 456 190" />
        <Arrow d="M 588 190 L 616 190" />
      </Lane>
      {/* Design → run: a Procedure is engaged as a Plan; a Check is what an Attempt executes. */}
      <Arrow d="M 270 96 C 270 126 88 120 88 164" label={t("docs.figures.model.engagedAs")} labelAt={[196, 122]} />
      <Arrow d="M 613 88 C 613 124 238 122 238 164" dashed />
      {/* Cascade: a new revision reopens dependent Checks. */}
      <Arrow d="M 678 164 C 678 126 652 112 628 90" dashed label={t("docs.figures.model.cascade")} labelAt={[704, 126]} />
    </svg>
  );
}

/** Who talks to whom: agent, skill/Runner, TRUST runtime, interface, external systems. */
export function ArchitectureFigure() {
  const { t } = useTranslation();
  return (
    <svg viewBox="0 0 780 260" preserveAspectRatio="xMidYMid meet" role="img" aria-label={t("docs.figures.architecture.alt")} className="mx-auto block h-auto min-w-0 max-w-full font-sans">
      <Defs />
      <Lane x={8} y={8} w={210} h={244} label={t("docs.figures.architecture.agentSystem")}>
        <Box x={28} y={40} w={170} h={48} title={t("docs.figures.architecture.agent")} tone="warning" />
        <Box x={28} y={176} w={170} h={48} title={t("docs.figures.architecture.skill")} tone="warning" />
        <Arrow d="M 113 88 L 113 174" label={t("docs.figures.architecture.checkUri")} labelAt={[113, 136]} />
      </Lane>
      <Box x={310} y={104} w={200} h={56} title={t("docs.figures.architecture.runtime")} tone="accent" />
      <Box x={590} y={24} w={170} h={48} title={t("docs.figures.architecture.interface")} />
      <Box x={590} y={182} w={170} h={48} title={t("docs.figures.architecture.external")} />
      {/* agent → runtime: reads Plans and Checks over MCP */}
      <Arrow d="M 198 64 C 250 64 260 116 308 122" label={t("docs.figures.architecture.mcpRead")} labelAt={[250, 52]} />
      {/* skill → runtime: admission RPC, then Facts over OTLP */}
      <Arrow d="M 198 192 C 250 192 260 154 308 146" label={t("docs.figures.architecture.admission")} labelAt={[238, 166]} />
      <Arrow d="M 198 212 C 270 212 300 170 340 160" label={t("docs.figures.architecture.facts")} labelAt={[266, 208]} />
      {/* skill → external systems: the action itself */}
      <Arrow d="M 198 222 C 380 258 460 244 588 210" label={t("docs.figures.architecture.execute")} labelAt={[400, 248]} />
      {/* interface ↔ runtime */}
      <Arrow d="M 590 48 C 540 48 520 88 508 112" label={t("docs.figures.architecture.rpc")} labelAt={[556, 72]} />
    </svg>
  );
}
