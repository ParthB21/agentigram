import type { NextConfig } from 'next';

const config: NextConfig = {
  // Workspace packages ship TypeScript source (see docs/decisions.md), so Next must compile them.
  transpilePackages: ['@clankergram/protocol'],
  // Our packages use NodeNext-style `./x.js` imports that point at `./x.ts`. Turbopack does not
  // map that yet, so the app builds with webpack (`next dev/build --webpack`) plus this alias.
  webpack(config) {
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      '.js': ['.ts', '.tsx', '.js'],
    };
    return config;
  },
};

export default config;
