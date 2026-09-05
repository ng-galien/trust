# Rendering lint review

Reviewed on 2026-09-06. The three local `noDangerouslySetInnerHtml` exceptions
in the documentation diagram and coordination Markdown renderers are approved.
Both configure Mermaid with `securityLevel: "strict"`. The installed Mermaid
renderer calls DOMPurify before returning SVG; only that returned SVG reaches
these JSX insertion sites. The public federated browser acceptance checks a
malicious HTML event handler, a JavaScript link and an attempted loose-security
directive while retaining a rendered diagram. This is bounded evidence, not a
general security guarantee.

The proposed SearchInput autofocus exception was rejected. Its justification
incorrectly attributed the Environment editor's TextInput caller to SearchInput.
SearchInput has one caller, anchor-explorer, which does not request autofocus.
The unused prop and exception were removed; the actual TextInput behavior was
not changed. UI typechecking and the targeted Biome check pass.
