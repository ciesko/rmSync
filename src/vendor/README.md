# Vendored dependencies

## pdf.js (`pdf.min.mjs`, `pdf.worker.min.mjs`)

[PDF.js](https://github.com/mozilla/pdf.js) by the Mozilla Foundation, licensed
under the **Apache License 2.0** (see [`LICENSE`](./LICENSE)).

These prebuilt ESM bundles are committed directly so the renderer can import
them as same-origin modules under the app's `default-src 'self'` Content
Security Policy. They render the original page content of PDF-backed documents
beneath the handwritten annotation strokes.

`pdfRender.mjs` is rmSync's own thin wrapper around pdf.js (MIT, part of this
project), not vendored code.

### Refreshing

The matching version is pinned as a devDependency in `../package.json`. To
update:

```bash
npm install pdfjs-dist@latest --save-dev
cp node_modules/pdfjs-dist/build/pdf.min.mjs vendor/
cp node_modules/pdfjs-dist/build/pdf.worker.min.mjs vendor/
cp node_modules/pdfjs-dist/LICENSE vendor/
```
