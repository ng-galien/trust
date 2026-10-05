# Author an interface

## Prerequisites and outcome

Read the approved Corpus thread of the screen and every page of its wireframe
before writing code. For an extension page, read [extension authoring](author-extension.md)
first. The outcome is a screen of TRUST or of a TRUST extension that follows the
interface rules of the Procedure `delegation-interface@3.0.0`, passes the interface
gate, and is shown in the light and dark themes and in English and French.

The same guide is part of the integrated documentation, in English and in French:
[Interface authoring](../../packages/trust-ui/src/docs/content/en/guides/interface-authoring.mdx).

## Where things are

| Need | Host (`packages/trust-ui/src`) | Corpus extension (`trust-extension/extensions/corpus/ui`) |
| --- | --- | --- |
| Theme token file | `packages/trust-ui/src/tokens.css`: light values on `:root`, dark values on `html.dark` | No token file: the host tokens; `shell.module.css` only aliases them as `--corpus-*` |
| Style sheet convention | Tailwind utilities mapped to the tokens by `@theme inline` in `styles.css` (`bg-surface`, `text-muted`, `border-border`); shared sheets beside their area (`shell/plan-mobile.css`) | One CSS module per component beside it: `trail.tsx` with `trail.module.css`, values through `var(--color-…)` or `var(--corpus-…)` |
| English catalogue | `packages/trust-ui/src/i18n/en/<area>.ts`, keys `area.section.name` | The English text given to `t()` is the key |
| French catalogue | `packages/trust-ui/src/i18n/fr/<area>.ts`, typed `Translation<typeof en>` | The `fr` table of `trust-extension/extensions/corpus/ui/i18n.tsx` |
| Translate | `const { t } = useTranslation()`, `t("common.actions.save")` | `const { t } = useI18n()`, `t("Save revision")`, `rich()` for a sentence with links, `context\|Text` for one English text with two French translations |

Components to reuse before writing a new one:

- Host, `packages/trust-ui/src/ui/`: `Button`, `IconButton`, `ButtonLink` (`button.tsx`);
  `Breadcrumb`, `PageHeader` (`breadcrumb.tsx`); `ConfirmDialog` (`confirm.tsx`);
  `Badge`, `StatusBadge`, `Count` (`badge.tsx`); `Menu`, `Popover` (`menu.tsx`, rendered
  in a portal above tables); `Overlay` (`overlay.tsx`); `EmptyState`, `LoadingState`,
  `ErrorBox` (`states.tsx`); `Field`, `TextInput`, `SearchInput`, `SegmentedControl`,
  `Tooltip` (`controls.tsx`); `Select` (`select.tsx`); `FilterBox` (`filter-box.tsx`);
  `InfoBadge` (`info-popover.tsx`); `Markdown`, `JsonViewer`, `SchemaForm`.
- Corpus, `trust-extension/extensions/corpus/ui/`: `RouteAnchor` (`route-link.tsx`) for
  every routed link; `Trail` (`trail.tsx`); `ReadingLayout` (`side-panel.tsx`) for a
  document with its side panel; `ConfirmDialog` (`confirm-dialog.tsx`); `Badge`
  (`badge.tsx`); `StatePill` (`visual-language.tsx`); `ReadFailure` (`read-failure.tsx`)
  for a failed read with its retry; `RichText` (`rich-text.tsx`); the form styles of
  `form-controls.module.css`.

An extension page receives `language` and the host navigation in `ExtensionPageProps`
from `@trust/extension-sdk`. It never imports a host component file: it reuses its own
components and the host tokens.

## What the interface gate measures

`node scripts/workspace-gate.mjs interface` runs the typecheck of `@trust/ui` and
`@trust/web`, Biome, and the measured interface rules.
`node scripts/workspace-gate.mjs interface-rules` runs only the measured rules, in
less than a second; every finding is also written on its own line to the error output.

- **Translation keys.** Each `i18n/en` module has the same keys as its `i18n/fr`
  module. In an extension catalogue keyed by English text, each literal text given
  to `t()` has a French entry, and each French entry is a text that the extension
  still writes. A finding names the key and the language that holds it alone.
- **Hard-coded colours.** Below `packages/*/src`, `apps/*/src` and
  `trust-extension/extensions/*/ui`, a style sheet other than
  `packages/trust-ui/src/tokens.css` must not write a colour: no hexadecimal value,
  no `rgb()`, `rgba()`, `hsl()`, `hsla()`, `hwb()`, `lab()`, `lch()`, `oklab()`,
  `oklch()`, `color()` and no named colour such as `white`, including as the fallback
  of `var()`. `var(...)`, `transparent`, `currentColor`, `inherit`, `initial`,
  `unset`, `revert` and `color-mix()` over tokens are allowed. A finding names the
  file and the line.

The reviewer keeps the rules that the gate does not measure.

## The interface rules with examples

Each rule of the Procedure has one conforming and one refused example.

### `wireframe-navigation`

Read every page of the thread wireframe and build each navigation entry, breadcrumb and page it shows.

Conforming: the wireframe shows a trail above the document, so the screen renders it.

```tsx id="wireframe-navigation-conforming"
<ReadingLayout label={t("Thread")} main={<ThreadDocument thread={thread} />} panel={<Neighbourhood thread={thread} />} />
<Trail steps={trail} navigate={navigate} />
```

Refused: a wireframe entry is left out, with a note instead of the screen.

```tsx id="wireframe-navigation-refused"
{/* The neighbourhood map of wireframe page 7 comes later. */}
<ThreadDocument thread={thread} />
```

### `translations`

Put every visible string in the English and French catalogues with identical keys.

Conforming: the text goes through `t()` and both catalogues hold the key.

```tsx id="translations-conforming"
// i18n/en/plans.ts: detail: { abandon: "Abandon the Plan" }
// i18n/fr/plans.ts: detail: { abandon: "Abandonner le Plan" }
<Button variant="danger">{t("plans.detail.abandon")}</Button>
```

Refused: a hard-coded text, and a key that only one catalogue holds.

```tsx id="translations-refused"
// i18n/en/plans.ts: detail: { abandon: "Abandon the Plan" }
// i18n/fr/plans.ts: detail: {}
<Button variant="danger">Abandon the Plan</Button>
```

### `theme-tokens`

Style only through theme tokens and check the light and dark themes.

Conforming: every colour is a token, so the dark theme follows.

```css id="theme-tokens-conforming"
.panel {
  border: 1px solid var(--color-border);
  background: var(--color-surface);
  color: var(--color-text);
  box-shadow: var(--shadow-2);
}
.panel:hover {
  background: color-mix(in srgb, var(--color-accent) 10%, transparent);
}
```

Refused: hard-coded colours, including a fallback inside `var()`; the gate names each line.

```css id="theme-tokens-refused"
.panel {
  border: 1px solid #dde2e8;
  background: var(--color-surface, #ffffff);
  color: rgb(29 36 48);
  box-shadow: 0 16px 60px #11182730;
}
```

### `routed-pages`

Open each detail, form and creation as a routed page with its URL and breadcrumb; a dialog only confirms an irreversible action.

Conforming: the creation form is a page with its own URL.

```tsx id="routed-pages-conforming"
<RouteAnchor href={`/corpus/views/new`}>{t("New view")}</RouteAnchor>
<ConfirmDialog open={confirming} title={t("Delete the view {name}?", { name })} confirmLabel={t("Delete view")} pending={pending} onConfirm={remove} onCancel={close} />
```

Refused: a form opened in a dialog, without a URL to share or reload.

```tsx id="routed-pages-refused"
<Overlay open={creating} onClose={close}>
  <NewViewForm onSaved={close} />
</Overlay>
```

### `action-feedback`

Show pending, success and failure for every action and keep the outcome visible after the data reloads.

Conforming: the button shows the pending state, and the outcome stays after the reload.

```tsx id="action-feedback-conforming"
<Button disabled={pending} onClick={save}>{t(pending ? "Saving…" : "Save revision")}</Button>
{outcome?.ok === false && <ErrorBox message={t("The revision was not saved")} details={outcome.error} />}
{outcome?.ok === true && <p role="status">{t("Revision {revision} saved", { revision: outcome.revision })}</p>}
```

Refused: the action gives no sign while it runs, and a failure is only logged.

```tsx id="action-feedback-refused"
<Button onClick={() => save().catch((error) => console.error(error))}>{t("Save revision")}</Button>
```

### `unclipped-menus`

Render menus and popovers above tables and scroll containers, listing only applicable actions with their explanation.

Conforming: the shared `Menu` renders in a portal and lists only the actions that apply.

```tsx id="unclipped-menus-conforming"
<Menu
  label={t("plans.actions.menu")}
  trigger={(props) => <IconButton {...props} label={t("plans.actions.menu")}><MoreHorizontal aria-hidden /></IconButton>}
  items={[
    ...(plan.state === "IN_PROGRESS" ? [{ label: t("plans.actions.abandon"), description: t("plans.actions.abandonHint"), onSelect: abandon }] : []),
  ]}
/>
```

Refused: an absolute menu inside a scrolling table cell, with disabled actions that never apply.

```tsx id="unclipped-menus-refused"
<td style={{ position: "relative", overflow: "auto" }}>
  <div style={{ position: "absolute" }}>
    <button disabled>{t("plans.actions.abandon")}</button>
  </div>
</td>
```

### `accessible-names`

Give every control a meaningful accessible name, never a technical identifier.

Conforming: the icon button is named by its action.

```tsx id="accessible-names-conforming"
<IconButton label={t("Hide the side panel")} onClick={collapse}>
  <PanelRightClose aria-hidden />
</IconButton>
```

Refused: no name, or a technical identifier as the name.

```tsx id="accessible-names-refused"
<IconButton label="" onClick={collapse}><PanelRightClose /></IconButton>
<button aria-label="btn-side-panel-collapse-7f3a">×</button>
```

### `responsive-layout`

Keep every page usable at 390 pixels and without horizontal overflow at 1280 pixels.

Conforming: the panel goes below the document on a narrow screen, and long values wrap.

```css id="responsive-layout-conforming"
.reading {
  display: grid;
  grid-template-columns: minmax(0, 1fr) var(--panel-width);
}
.value {
  overflow-wrap: anywhere;
}
@media (max-width: 899px) {
  .reading {
    grid-template-columns: minmax(0, 1fr);
  }
}
```

Refused: fixed widths that overflow a narrow screen.

```css id="responsive-layout-refused"
.reading {
  display: grid;
  grid-template-columns: 900px 420px;
}
.value {
  white-space: nowrap;
}
```

## Verify

1. Run `node scripts/workspace-gate.mjs interface-rules`, then the full interface gate.
2. Open each screen in a browser tab you created, in the light and dark themes and
   in English and French, at 390 and 1280 pixels wide.
3. Run the named acceptance tests of the mission, one at a time while you correct.
