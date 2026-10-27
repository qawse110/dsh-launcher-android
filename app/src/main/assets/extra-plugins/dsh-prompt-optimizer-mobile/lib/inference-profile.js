// The fast profile describes preparation, not three full execution/refinement loops.
// Deprecated settings remain readable, but cannot restore a different execution path.
export const FAST_REASONING_PROFILE = Object.freeze({
  reasoningMode: 'hybrid',
  reasoningCandidates: 3,
  reasoningRounds: 3,
  reasoningPace: 'fast',
})

/** Keep caller-owned settings; replace only the deprecated profile selectors. */
export function canonicalReasoning(config = {}) {
  return { ...config, ...FAST_REASONING_PROFILE }
}

/** Three concurrent brief public directions, then the unchanged working request. */
export function fixedInferencePlan(config = {}) {
  const profile = canonicalReasoning(config)
  const maxExtraCalls = profile.reasoningCandidates
  return {
    mode: profile.reasoningMode,
    pace: profile.reasoningPace,
    workflow: 'directions-to-worker',
    requestedCandidates: profile.reasoningCandidates,
    requestedRounds: profile.reasoningRounds,
    effectiveCandidates: profile.reasoningCandidates,
    effectiveRounds: 0,
    maxCalls: maxExtraCalls + 1,
    maxExtraCalls,
    capReason: 'fast-only-profile',
    profile: 'fast-3x3',
  }
}
