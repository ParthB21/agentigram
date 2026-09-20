'use strict';

const { MakerDeb } = require('@electron-forge/maker-deb');
const { MakerRpm } = require('@electron-forge/maker-rpm');
const { MakerZIP } = require('@electron-forge/maker-zip');

module.exports = {
  packagerConfig: {
    name: 'Agentigram',
    executableName: 'agentigram',
    asar: true,
    prune: true,
    ignore: [
      /^\/src(?:\/|$)/,
      /^\/bin(?:\/|$)/,
      /^\/node_modules(?:\/|$)/,
      /^\/coverage(?:\/|$)/,
      /^\/out(?:\/|$)/,
    ],
  },
  rebuildConfig: {},
  makers: [
    new MakerZIP({}, ['win32', 'darwin']),
    new MakerDeb(
      {
        options: {
          productName: 'Agentigram',
          genericName: 'Agent meeting room',
          categories: ['Development'],
        },
      },
      ['linux'],
    ),
    new MakerRpm({}, ['linux']),
  ],
};
