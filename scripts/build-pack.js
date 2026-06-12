'use strict';
// Clean portable build via @electron/packager API (avoids CLI shell-escaping and
// lets us exclude build output / dev junk from the bundled app).
const path = require('path');
const packager = require('@electron/packager');

const root = path.join(__dirname, '..');

packager({
  dir: root,
  name: 'AI Usage Dashboard',
  platform: 'win32',
  arch: 'x64',
  out: path.join(root, 'dist-pack'),
  overwrite: true,
  icon: path.join(root, 'assets', 'icon.ico'),
  prune: true, // strips devDependencies from the bundle
  ignore: [
    /^\/dist($|\/)/,
    /^\/dist-pack($|\/)/,
    /^\/marks($|\/)/,
    /^\/scripts($|\/)/,
    /^\/\.git($|\/)/,
    /\.(log|map)$/,
  ],
}).then((paths) => {
  console.log('PACKED_OK ->', paths.join(', '));
}).catch((err) => {
  console.error('PACK_FAILED', err);
  process.exit(1);
});
