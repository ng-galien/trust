# Maintenance findings

Each analysis axis writes one findings file, `maintenance/findings/<axis>.json`. The following command checks it from the repository root:

```sh
node scripts/maintenance-findings.mjs check maintenance/findings/<axis>.json
```

## Format

A findings file is a JSON object with exactly these keys:

- `axis`: the axis name, in kebab-case.
- `findings`: the list of findings. It may be empty.

A finding has exactly these keys. `related` is optional. `stateReason` follows the state.

| Key | Value |
| --- | --- |
| `id` | kebab-case, unique in the file |
| `title` | one line saying what is dead, duplicated, left over or inconsistent |
| `kind` | `dead-code`, `duplication`, `leftover` or `inconsistency` |
| `location` | `{ "file", "lines": [first, last], "text" }`: the cited code |
| `related` | a non-empty list of locations of the same shape (for example, the other copies of a duplication) |
| `evidence` | how the analyst knows it: what was searched, and what was found or not found |
| `action` | the proposed fix |
| `touches` | the files the fix changes; it contains `location.file` |
| `risk` | `low`, `medium` or `high` |
| `riskReason` | why the fix has that risk |
| `state` | `open`, `fixed` or `declined` |
| `stateReason` | required when the state is `fixed` or `declined`, and not allowed when it is `open` |

A location has exactly three keys:

- `file`: a repository-relative path with forward slashes. It has no leading `/` and no `.`, `..` or empty segment. A path inside the `trust-extension` submodule is allowed.
- `lines`: 1-based and inclusive, with `first <= last`.
- `text`: the exact content of those lines. A multi-line text joins its lines with `\n`.

The coordinator groups findings into fix missions by `touches`.

## Checks

The form check is strict: an unknown key, a missing key, a value outside a closed list or a duplicate `id` is refused. The location check depends on the state of the finding:

- **`open` and `declined`**: `location` and every `related` entry must exist, the line range must be within the file, and `text` must equal those lines.
- **`fixed`**: the `location.text` must no longer appear anywhere in `location.file` as consecutive lines. If the fix deleted the file, the finding is accepted. `lines` keeps the original range and is not checked. `related` is not checked.

In every text comparison, CRLF counts as LF and the trailing whitespace of each line is ignored.

## Output

The command prints one JSON object:

```json
{"accepted": false, "axis": "example", "findings": 4, "open": 1, "fixed": 2, "declined": 1,
 "refusals": [{"finding": "legacy-pricing-flag", "reason": "location.text differs from lines 11-12 of 'maintenance/examples/cited-source.txt'"}]}
```

- `refusals` follows the file order.
- `finding` is the finding's `id`. It is `findings[<index>]` when the finding has no valid id, and `null` for a fault of the file itself, such as invalid JSON, a missing `axis` or an unknown top-level key.
- The exit code is 0 when the check ran, whether the file is accepted or refused. It is 2 on a usage error or when the findings file cannot be read.

## Example

`maintenance/examples/findings.json` cites `maintenance/examples/cited-source.txt` and is accepted. It contains one finding in each state, and a fixed finding whose file was deleted. Here is its first finding:

```json
{
  "axis": "example",
  "findings": [
    {
      "id": "duplicate-amount-formatter",
      "title": "formatTotal and formatPrice format an amount the same way",
      "kind": "duplication",
      "location": {
        "file": "maintenance/examples/cited-source.txt",
        "lines": [3, 5],
        "text": "export const formatTotal = (amount) => {\n  return `${amount.toFixed(2)} EUR`;\n};"
      },
      "related": [
        {
          "file": "maintenance/examples/cited-source.txt",
          "lines": [7, 9],
          "text": "export const formatPrice = (amount) => {\n  return `${amount.toFixed(2)} EUR`;\n};"
        }
      ],
      "evidence": "Both bodies are identical; searched the repository for formatTotal and formatPrice: each has callers.",
      "action": "Keep formatPrice, make formatTotal call it.",
      "touches": ["maintenance/examples/cited-source.txt"],
      "risk": "low",
      "riskReason": "Same output for every input; covered by the formatter tests.",
      "state": "open"
    }
  ]
}
```
