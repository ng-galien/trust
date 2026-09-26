import type { ExtensionPageProps } from "@trust/extension-sdk";
import { useEffect, useState } from "react";

interface Artifact {
  id: string;
  version: string;
  source: string;
}
interface Rule {
  move: string;
  operation: string;
  procedure: string;
  choices: string[];
  prerequisites: string[];
  die: string;
  tutorialAlarm: boolean;
  description?: string;
}
interface Catalog {
  sourceKind: string;
  concessionPenalty: number;
  procedures: Artifact[];
  operations: Artifact[];
  rules: Rule[];
}
const words = (value: string) => value.replaceAll("-", " ");
export function Learning({ apiBase, transport }: { apiBase: string; transport: ExtensionPageProps["transport"] }) {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [failed, setFailed] = useState(false);
  const [tab, setTab] = useState("Rules");
  useEffect(() => {
    let active = true;
    void transport
      .fetch(`${apiBase}/catalog`)
      .then(async (response) => {
        if (!response.ok) throw new Error();
        const value = await response.json();
        if (active) setCatalog(value);
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
    };
  }, [transport, apiBase]);
  return (
    <details className="heist-learning">
      <summary>
        <span>
          <small className="heist-eyebrow">Behind the adventure</small>
          <strong>How it works</strong>
        </span>
        <span aria-hidden="true">+</span>
      </summary>
      <div className="heist-learning-body">
        <p>
          A party enters the vault while a companion distracts its dragon. Choose your tools, turn the runes, take the
          hoard and escape. The game records what happened; TRUST decides whether each Check is satisfied.
        </p>
        <div className="heist-learning-tabs" role="tablist" aria-label="Learning view">
          {["Rules", "Procedures", "Operations"].map((name) => (
            <button
              type="button"
              key={name}
              role="tab"
              aria-selected={tab === name}
              aria-controls="heist-learning-content"
              id={`heist-tab-${name}`}
              onClick={() => setTab(name)}
            >
              {name}
            </button>
          ))}
        </div>
        <section id="heist-learning-content" role="tabpanel" aria-labelledby={`heist-tab-${tab}`}>
          {!catalog ? (
            <p>
              {failed
                ? "Bundled sources are unavailable. No catalog has been inferred."
                : "Reading the bundled catalog…"}
            </p>
          ) : tab === "Rules" ? (
            <>
              <p className="heist-learning-note">
                These move rules come from the game’s executable catalog. A die is an observation, never a
                qualification.
              </p>
              <ol className="heist-rule-list">
                {catalog.rules.map((rule) => (
                  <li key={rule.move}>
                    <h3>{words(rule.move)}</h3>
                    {rule.description && <p>{rule.description}</p>}
                    <p>
                      {rule.choices.length > 0 && `Choose ${rule.choices.join(" or ")}. `}
                      {rule.prerequisites.length > 0
                        ? `After ${rule.prerequisites.map(words).join(" and ")}. `
                        : "No preceding game move required. "}
                      {rule.die === "d6" && "Roll one six-sided die; retries keep the recorded result. "}
                      {rule.tutorialAlarm &&
                        `The first observation raises the tutorial alarm and is not ready. A genuine TRUST escalation and explicit operator resume are required; the concession costs ${catalog.concessionPenalty} points.`}
                    </p>
                    <small>
                      <code>{rule.operation}</code>
                      <span aria-hidden="true"> → </span>
                      <code>{rule.procedure}</code>
                    </small>
                  </li>
                ))}
              </ol>
            </>
          ) : (
            <>
              <p className="heist-learning-note">
                Actual bundled {tab.toLowerCase()} sources, not a claim about the version engaged by a live Plan.
                Inspect that Plan for its governing version.
              </p>
              <div className="heist-source-list">
                {(tab === "Procedures" ? catalog.procedures : catalog.operations).map((artifact) => (
                  <details key={artifact.id}>
                    <summary>
                      <code>{artifact.id}</code>
                      <span>v{artifact.version}</span>
                    </summary>
                    <pre>
                      <code>{artifact.source}</code>
                    </pre>
                  </details>
                ))}
              </div>
            </>
          )}
        </section>
      </div>
    </details>
  );
}
