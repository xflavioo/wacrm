import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    tsconfigPaths: true,
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    // Dummy secrets — encryption.ts / webhook-signature.ts read these
    // at module load. Tests never hit a real Meta/Supabase service, so
    // any 32-byte hex / non-empty string will do; keep them lexically
    // identical to the CI build env so behaviour matches.
    env: {
      ENCRYPTION_KEY:
        "0000000000000000000000000000000000000000000000000000000000000000",
      META_APP_SECRET: "test-meta-app-secret",
      // Pin the machine-dependent bits so the suite is deterministic on any
      // box (a pt-BR / UTC-3 Windows laptop used to fail 5 formatting and
      // weekday tests that assume en-US + UTC). `en-US` here is read by
      // src/lib/locale.ts as the Intl locale; no messages/en-US.json exists,
      // which the i18n loader tolerates (falls back to en).
      NEXT_PUBLIC_APP_LOCALE: "en-US",
      TZ: "UTC",
    },
    clearMocks: true,
  },
});
