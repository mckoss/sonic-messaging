# Sonic Messaging repository rules

These instructions apply to the entire repository.

## Product and scope

- The product and site title is **Sonic Messaging**.
- The current application is a modulation and protocol test bed that will later support nearby messaging.
- Keep the application a static, installable PWA. Do not introduce an application server or required backend without explicit approval.
- Preserve desktop and mobile browser support. Microphone features must work in secure contexts and fail with useful user-facing errors when unavailable.
- Treat `PLAN.md` as the living development sequence. Update its decisions, ordering, current marker, and completed checkboxes whenever project direction or implementation status changes.

## Architecture

- Use Svelte and TypeScript for application UI and orchestration.
- Keep reusable modem and channel algorithms browser-safe and independent of the UI.
- Perform computationally intensive DSP, simulation, encoding, and decoding in Web Workers.
- Use AudioWorklet processors for real-time microphone capture and speaker playback. Worklet code must be deployable JavaScript with a browser-supported MIME type; verify emitted production assets.
- Keep protocol layers modular so FSK, CSS, DSSS, coding, framing, synchronization, and channel models can be tested independently.
- Retain soft confidence metrics wherever practical rather than prematurely reducing detector output to hard decisions.

## Dependencies

- Favor fewer runtime dependencies. Add one only when it replaces commodity infrastructure, is browser-compatible, has an acceptable license, and provides measurable value over local code.
- `fft.js` is the approved FFT dependency.
- ggwave, Quiet, external FEC packages, and SharedArrayBuffer ring-buffer packages are deferred; do not add them without explicit discussion and approval.
- Do not add Node-native packages to browser runtime code.

## Runtime and package management

- Use the exact Node version pinned in `.nvmrc`; run `nvm use` before installing, testing, or building.
- Keep `package.json`, `package-lock.json`, `.nvmrc`, and the Pages workflow consistent.
- npm engine enforcement must remain enabled.

## Versioning

- `package.json` is the single source of truth for the application version.
- Every push or merge reaching `main` must increase the semantic version. Use patch, minor, or major according to compatibility and scope.
- Keep the root version in `package-lock.json` synchronized with `package.json`.
- The UI must display the build-injected version as `vMAJOR.MINOR.PATCH` beneath the header brand.
- Do not bypass `npm run check:version` or remove the CI version gate.

## Git and deployment

- All repository work must be tracked in Git. Make focused, reviewable commits and preserve unrelated user changes.
- Commit and push each feature change as soon as the local test suite passes; do not batch multiple completed features into one commit or leave verified work unpushed.
- Treat side conversations as discussion and read-only investigation by default because they share the main thread's workspace and Git branch.
- A side conversation may modify code only when the user explicitly requests it after the side-conversation boundary. Before editing, verify that the worktree is clean and that the change will not overlap known main-thread work. If coordination is uncertain, leave the implementation to the main thread.
- Keep side-conversation edits narrowly scoped. Recheck the worktree before committing or pushing, and do not overwrite, bundle, or publish unrelated main-thread changes.
- Do not force-push or rewrite published `main` history.
- Push completed, verified changes to `origin/main` unless the user requests a branch or pull-request workflow.
- GitHub Pages is deployed by `.github/workflows/pages.yml`. Keep the Vite base path, manifest, service worker, workers, and worklets compatible with `/sonic-messaging/`.
- A change is not deployed until the Pages workflow succeeds. For production fixes, verify the relevant public URL and asset content type.

## Testing and quality

- Add deterministic unit tests for modem algorithms and channel behavior, including clean and noisy waveform round trips.
- Multiuser DSSS changes must test intended-user detection and competing-user rejection.
- DSP tests should use fixed random seeds and assert decoded payloads and meaningful signal metrics.
- Before committing or pushing, run:

  ```sh
  npm run check:version
  npm test
  npm run check
  GITHUB_ACTIONS=true npm run build
  git diff --check
  ```

- Verify that production builds contain loadable JavaScript AudioWorklet assets and correctly based worker/assets URLs.
- Do not claim live microphone packet decoding where only spectrum acquisition or simulated decoding is implemented; document current limitations accurately.
