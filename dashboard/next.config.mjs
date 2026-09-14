/** @type {import('next').NextConfig} */
export default {
  // The dashboard imports the engine's domain and application code directly,
  // so the numbers on screen come from the same functions the engine uses.
  outputFileTracingRoot: new URL('..', import.meta.url).pathname,
  eslint: { ignoreDuringBuilds: true },
}
