# Plan: eh — a tiny CLI calculator

## Intent
`eh` is a small, dependency-free command-line calculator implemented as a single
Node.js file (`eh.js`). It's the "hello world" of the Sparra build loop: small enough to
build and adversarially exercise in one pass, real enough to have edge cases worth
catching.

## Constraints
- Node.js, **single file `eh.js`**, **no external dependencies**.
- Invoked as `node eh.js <op> <a> <b>`.
- Integer-friendly: operands are parsed as numbers; reject non-numeric operands.

## Approach
Parse `process.argv`: first arg is the operation, the next two are operands.
Support four operations: `add`, `sub`, `mul`, `div`.
Print the result to stdout and exit 0 on success. On any misuse, print a helpful usage
message to stderr and exit with a non-zero code.

## Risks & unknowns
- Division by zero must be handled gracefully (error, not `Infinity`).
- Non-numeric or missing operands must be rejected, not silently coerced.
- Unknown operations must produce a clear error.

## Success criteria
- `node eh.js add 2 3` → prints `5`, exit 0.
- `node eh.js sub 10 4` → prints `6`, exit 0.
- `node eh.js mul 4 5` → prints `20`, exit 0.
- `node eh.js div 20 5` → prints `4`, exit 0.
- `node eh.js div 10 0` → error to stderr, **non-zero** exit.
- `node eh.js add 2` (missing operand) → usage to stderr, non-zero exit.
- `node eh.js pow 2 3` (unknown op) → error to stderr, non-zero exit.
- `node eh.js add x 3` (non-numeric) → error to stderr, non-zero exit.
