/** @type {import('next').NextConfig} */
export default {
  // The dashboard imports the engine's domain and application code directly,
  // so the numbers on screen come from the same functions the engine runs.
  outputFileTracingRoot: new URL('..', import.meta.url).pathname,
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
