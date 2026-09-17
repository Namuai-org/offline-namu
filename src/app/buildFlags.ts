/**
 * Build-time switches. None of these is reachable from production UI
 * (PRD-002: no runtime selector).
 */
export const BUILD_FLAGS = {
  /**
   * DEV-001: simulators/emulators are for functional UI journeys only, so
   * internal simulator builds use the scripted fake engine. Set to true to try
   * the real runtime on a simulator during development.
   */
  realEngineOnSimulator: false,
  /**
   * S09: shown only after ownership of the address is verified in release
   * setup. Never invent an address here.
   */
  supportEmail: null as string | null,
  upstreamModelUrl: 'https://huggingface.co/CohereLabs/tiny-aya-global',
} as const;
