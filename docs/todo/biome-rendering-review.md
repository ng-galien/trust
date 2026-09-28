# Rendering safety boundaries

Keep Mermaid configured with `securityLevel: "strict"`. A bounded
`noDangerouslySetInnerHtml` exception may insert the SVG returned by the sanitized
Mermaid renderer; it does not authorize arbitrary HTML insertion. Public browser
acceptances must exercise malicious event handlers, JavaScript links and attempted
loose-security directives while retaining a rendered diagram. Passing those
cases is bounded evidence, not a general security guarantee.

Justify autofocus exceptions against the actual component and its callers.
Do not retain an unused autofocus prop or attribute another component's behavior
to it. Typechecking and lint checks supplement public interaction acceptance.
