# Completed features

Finished feature specs are immutable records of each build. The first keeps
`NN-name.md`; rebuilds use `NN-name--build-2.md`, `NN-name--build-3.md`, and so on.
For example, `12a-export-reports.md` and `12a-download-reports--build-2.md` retain
the same build-plan ID `12a` after a rollback and title change.

New specs record `**Build attempt:**` before review. Complete reuses that attempt
and never overwrites an older build. The installed Feature skill's
`reference/build-history.md` defines identity and Git proof; older or ambiguous
records need explicit repair, not an automatic rename or guessed number.

_Empty until you complete your first feature._
