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
    <svg viewBox="0 0 780 330" role="img" aria-label={t("docs.figures.model.alt")} className="mx-auto block h-auto w-full max-w-[780px] font-sans">
      <Defs />
      <Lane x={8} y={8} w={764} h={128} label={t("docs.figures.model.design")}>
        <Box x={28} y={44} w={150} h={70} title={t("docs.figures.model.operation")} sub={t("docs.figures.model.operationSub")} tone="accent" />
        <Box x={262} y={36} w={490} h={88} title="" />
        <text x={276} y={54} className="fill-text" fontSize={12.5} fontWeight={600}>{t("docs.figures.model.procedure")}</text>
        <text x={276} y={68} className="fill-muted" fontSize={10.5}>{t("docs.figures.model.procedureSub")}</text>
        <Box x={276} y={76} w={220} h={40} title={t("docs.figures.model.scenario")} sub={t("docs.figures.model.scenarioSub")} />
        <Box x={512} y={76} w={222} h={40} title={t("docs.figures.model.check")} sub={t("docs.figures.model.checkSub")} tone="accent" />
        <Arrow d="M 178 79 L 260 79" label={t("docs.figures.model.usedBy")} labelAt={[219, 72]} />
      </Lane>
      <Lane x={8} y={156} w={764} h={166} label={t("docs.figures.model.run")}>
        <Box x={28} y={196} w={150} h={70} title={t("docs.figures.model.plan")} sub={t("docs.figures.model.planSub")} tone="accent" />
        <Box x={218} y={196} w={140} h={70} title={t("docs.figures.model.attempt")} sub={t("docs.figures.model.attemptSub")} />
        <Box x={398} y={196} w={120} h={70} title={t("docs.figures.model.facts")} sub={t("docs.figures.model.factsSub")} />
        <Box x={558} y={196} w={92} h={70} title={t("docs.figures.model.verdict")} sub={t("docs.figures.model.verdictSub")} tone="success" />
        <Box x={666} y={196} w={92} h={70} title={t("docs.figures.model.revision")} sub={t("docs.figures.model.revisionSub")} />
        <Arrow d="M 178 231 L 216 231" />
        <Arrow d="M 358 231 L 396 231" />
        <Arrow d="M 518 231 L 556 231" label={t("docs.figures.model.qualifies")} labelAt={[537, 188]} />
        <Arrow d="M 650 231 L 664 231" />
        <text x={286} y={290} textAnchor="middle" className="fill-muted" fontSize={10.5}>{t("docs.figures.model.attemptBy")}</text>
        <text x={458} y={290} textAnchor="middle" className="fill-muted" fontSize={10.5}>{t("docs.figures.model.factsVia")}</text>
      </Lane>
      {/* Design → run: a Procedure is engaged as a Plan; a Check is what an Attempt executes. */}
      <Arrow d="M 300 124 C 300 160 103 150 103 194" label={t("docs.figures.model.engagedAs")} labelAt={[220, 158]} />
      <Arrow d="M 623 116 C 623 150 288 150 288 194" dashed />
      {/* Cascade: a new revision reopens dependent Checks. */}
      <Arrow d="M 712 196 C 712 150 660 140 640 116" dashed label={t("docs.figures.model.cascade")} labelAt={[712, 158]} />
    </svg>
  );
}

/** Who talks to whom: agent, skill/Runner, TRUST runtime, interface, external systems. */
export function ArchitectureFigure() {
  const { t } = useTranslation();
  return (
    <svg viewBox="0 0 780 300" role="img" aria-label={t("docs.figures.architecture.alt")} className="mx-auto block h-auto w-full max-w-[780px] font-sans">
      <Defs />
      <Box x={20} y={30} w={170} h={70} title={t("docs.figures.architecture.agent")} sub={t("docs.figures.architecture.agentSub")} tone="warning" />
      <Box x={20} y={190} w={170} h={70} title={t("docs.figures.architecture.skill")} sub={t("docs.figures.architecture.skillSub")} tone="warning" />
      <Box x={310} y={110} w={200} h={90} title={t("docs.figures.architecture.runtime")} sub={t("docs.figures.architecture.runtimeSub")} tone="accent" />
      <Box x={590} y={30} w={170} h={70} title={t("docs.figures.architecture.interface")} sub={t("docs.figures.architecture.interfaceSub")} />
      <Box x={590} y={190} w={170} h={70} title={t("docs.figures.architecture.external")} sub={t("docs.figures.architecture.externalSub")} />
      {/* agent → runtime: reads Plans and Checks over MCP */}
      <Arrow d="M 190 62 C 250 62 260 130 308 138" label={t("docs.figures.architecture.mcpRead")} labelAt={[250, 54]} />
      {/* agent → skill: one Check URI */}
      <Arrow d="M 105 100 L 105 188" label={t("docs.figures.architecture.checkUri")} labelAt={[105, 148]} />
      {/* skill → runtime: admission RPC, then Facts over OTLP */}
      <Arrow d="M 190 215 C 250 215 260 175 308 168" label={t("docs.figures.architecture.admission")} labelAt={[232, 176]} />
      <Arrow d="M 190 240 C 270 240 300 200 340 200" label={t("docs.figures.architecture.facts")} labelAt={[262, 232]} />
      {/* skill → external systems: the action itself */}
      <Arrow d="M 190 258 C 380 290 460 270 588 236" label={t("docs.figures.architecture.execute")} labelAt={[400, 282]} />
      {/* interface ↔ runtime */}
      <Arrow d="M 590 62 C 540 62 520 100 508 122" label={t("docs.figures.architecture.rpc")} labelAt={[556, 84]} />
      <Arrow d="M 508 175 C 540 190 560 200 588 210" dashed label={t("docs.figures.architecture.runFromInterface")} labelAt={[556, 178]} />
    </svg>
  );
}
