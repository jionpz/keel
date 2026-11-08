# Domain Docs

How the engineering skills should consume keel's domain documentation.

## Before exploring, read these

- **`docs/02-glossary.md`** — the canonical glossary. `GLOSSARY.md` at the repo root is only a pointer to it.
- **`docs/adr/`** — read ADRs that touch the area you're about to work in.
- For architecture context, **`docs/01-overview.md`** and **`docs/03-domain-model.md`**.

If a file doesn't exist, **proceed silently**. Don't flag its absence. The `/domain-modeling` skill creates docs lazily when terms or decisions are actually resolved; in this repo the glossary already exists, so edit `docs/02-glossary.md` rather than the root pointer.

## File structure

Single-context repo:

```
/
├── GLOSSARY.md → docs/02-glossary.md (pointer)
├── docs/
│   ├── 02-glossary.md
│   ├── adr/
│   └── ...
└── src/
```

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in `docs/02-glossary.md`. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal: either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0003 (workflow engine), but worth reopening because…_
