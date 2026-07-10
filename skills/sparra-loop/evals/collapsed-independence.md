# Collapsed evaluator independence

## Scenario

An evaluator fallback resolves to the same actual backend and model as the generator, so a passing
grade cannot count as cross-model evidence.

## Prompt

> Simulate evaluator fallback onto the generator identity. Show the returned independence fields
> and the next action even if the verdict says pass.

## Objective assertions

- The evaluator receives `crossModelBaseline` from the generator's returned `backend` and `model`.
- The simulated payload contains `sameModelGrade: true` and `fallbackFrom` naming the requested evaluator identity.
- The conductor refuses to accept the pass as cross-model evidence and re-runs with a different actual backend/model or waits for the requested backend to recover.
- No behavioral FAIL feedback is sent to the generator solely because independence collapsed.
