# create-software-factory

npm package that installs the Software Factory workflow into a project. `template/` is what gets copied; `bin/create-software-factory.js` is the installer. `plan.md` is the design; `features.md` is the running feature list.

## Layout
- `template/` — AI Blueprint 1.9.0 files (unchanged) + our skills. `.claude/skills/` and `.agents/skills/` must stay byte-identical except Blueprint's `disable-model-invocation` frontmatter line.
- `bin/` — installer. Plain Node ESM, no dependencies. Keep it that way.
- `plan.md`, `features.md` — design docs, root only.

## Rules
- Never edit Blueprint's own files in `template/` to change behaviour; add new skills/scripts beside them so an upstream update can be re-applied.
- A new skill goes into BOTH `template/.claude/skills/<name>/` and `template/.agents/skills/<name>/`.
- Test the installer with `node bin/create-software-factory.js <scratch-dir> --dry-run` before committing.
- No AI attribution lines in commits.

## Lab notes
- Blueprint's stock `manifest.json` is not shipped; the installer regenerates it with our own schema.
- The npm name `create-sf` is taken; this package is `create-software-factory`.
