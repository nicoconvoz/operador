/** @type {import('next').NextConfig} */
export default {
  // The dashboard imports the engine's domain and application code directly,
  // so the numbers on screen come from the same functions the engine runs.
  outputFileTracingRoot: new URL('..', import.meta.url).pathname,

  // `next build` writes to the same directory a running `next dev` serves
  // from, so verifying the build pulls the chunks out from under the open
  // browser ("__webpack_modules__[moduleId] is not a function"). Dev gets its
  // own directory; build and start keep the conventional `.next`, so Vercel
  // and `next start` are untouched.
  //
  // NODE_ENV and not process.argv: Next renders in CHILD processes whose argv
  // no longer says `dev`, so an argv check makes the router resolve
  // `.next-dev` while the worker looks in `.next` — which fails as a missing
  // chunk ("Cannot find module './873.js'") rather than as a config mistake.
  // The environment is inherited; the command line is not.
  distDir: process.env.NODE_ENV === 'development' ? '.next-dev' : '.next',
  eslint: { ignoreDuringBuilds: true },
  typescript: { ignoreBuildErrors: false },

  webpack: (config) => {
    // The engine is NodeNext ESM: its imports end in `.js` while the files on
    // disk are `.ts`. Node resolves that natively; webpack needs telling.
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      '.js': ['.ts', '.tsx', '.js'],
    }
    return config
  },
}
