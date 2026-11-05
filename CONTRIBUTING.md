# Contributing

Thanks for helping. Issues and pull requests are welcome, small ones especially.

## Setup

```bash
git clone https://github.com/ivala2081/lwc-drawing-tools.git
cd lwc-drawing-tools
npm test
```

No install step: the library has no dependencies, and the tests run on Node's built-in test runner (Node 18+).

To try changes in a browser, serve the repo root and open the demo:

```bash
python -m http.server 8000
# then open http://localhost:8000/example/
```

## Ground rules

- **Keep the core pure.** `src/*.js` must not touch the DOM beyond the canvas context it is handed, and must not import React.
- **The renderer and the hit-test share geometry.** If you add a shape, put its geometry in `chartMath.js` and call it from both `drawers.js` and `useMarkupTools.js`, so what users see is exactly what they can click.
- **Compute prices first, pixels second.** Never interpolate between two y-coordinates; that breaks logarithmic price scales.
- **Add a test** in `test/` for any new math.
- **Update the types** in `src/index.d.ts` / `src/react/index.d.ts` when you change an export.

## Adding a drawing tool

1. Add the geometry and handle specs to `chartMath.js`.
2. Render it in `paintMarkup` in `drawers.js`.
3. Teach `useMarkupTools.js` how to create, hit-test, move and resize it.
4. Add the tool to the demo toolbar in `example/index.html`.

## Reporting bugs

Include your `lightweight-charts` version, the price-scale mode (normal, logarithmic, percentage), and a minimal markup object that reproduces the problem.
