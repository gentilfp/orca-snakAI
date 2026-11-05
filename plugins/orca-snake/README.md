# Orca Snake

A pixel art Snake for the Orca panel. Chase AI-themed pixel icons instead of ordinary food.

Work in progress: this scaffold only validates, builds and loads in Orca. The game arrives in the
next cards.

## Verification

Run from the repository root:

```sh
node plugins/orca-snake/scripts/build.mjs
node --test plugins/orca-snake/tests/*.test.mjs
/Applications/Orca.app/Contents/Resources/bin/orca plugin validate plugins/orca-snake
```
