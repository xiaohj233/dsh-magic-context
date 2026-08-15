// ../plugin/src/shared/harness.ts
var currentHarness = "opencode";
var harnessLocked = false;
function setHarness(value) {
  if (harnessLocked && currentHarness !== value) {
    throw new Error(`Magic Context: harness already locked to "${currentHarness}"; cannot change to "${value}"`);
  }
  currentHarness = value;
  harnessLocked = true;
}
function getHarness() {
  return currentHarness;
}

// src/harness.ts
var DSH_HARNESS = "dsh";
function setDshHarness() {
  setHarness(DSH_HARNESS);
}
function currentHarness2() {
  return getHarness();
}
var DSH_SESSION_KEY_PREFIX = "dsh";
var SEP = ":";
function canonicalSessionKey(homeHash, dshSessionId) {
  if (homeHash.length === 0)
    throw new Error("canonicalSessionKey: homeHash must be non-empty");
  if (dshSessionId.length === 0)
    throw new Error("canonicalSessionKey: dshSessionId must be non-empty");
  if (dshSessionId.includes(SEP)) {
    throw new Error(`canonicalSessionKey: dshSessionId must not contain "${SEP}"`);
  }
  return `${DSH_SESSION_KEY_PREFIX}${SEP}${homeHash}${SEP}${dshSessionId}`;
}
function parseDshSessionKey(key) {
  if (typeof key !== "string")
    return;
  const first = key.indexOf(SEP);
  if (first <= 0)
    return;
  if (key.slice(0, first) !== DSH_SESSION_KEY_PREFIX)
    return;
  const second = key.indexOf(SEP, first + 1);
  if (second <= first + 1 || second === key.length - 1)
    return;
  const homeHash = key.slice(first + 1, second);
  const dshSessionId = key.slice(second + 1);
  if (homeHash.length === 0 || dshSessionId.length === 0)
    return;
  return { homeHash, dshSessionId };
}
// src/model-map.ts
var CANONICAL_DEEPSEEK_PROVIDER = "deepseek";
var DSH_DEEPSEEK_PROVIDER = "deepseek-official";
var DSH_TO_CANONICAL_PROVIDER = {
  [DSH_DEEPSEEK_PROVIDER]: CANONICAL_DEEPSEEK_PROVIDER
};
var CANONICAL_TO_DSH_PROVIDER = {
  [CANONICAL_DEEPSEEK_PROVIDER]: DSH_DEEPSEEK_PROVIDER
};
function remapProviderPrefix(ref, map) {
  if (typeof ref !== "string")
    return ref;
  const slash = ref.indexOf("/");
  if (slash <= 0)
    return ref;
  const provider = ref.slice(0, slash);
  if (!Object.hasOwn(map, provider))
    return ref;
  return `${map[provider]}${ref.slice(slash)}`;
}
function dshModelRefToCanonical(ref) {
  return remapProviderPrefix(ref, DSH_TO_CANONICAL_PROVIDER);
}
function resolveModelRefForDsh(ref) {
  return remapProviderPrefix(dshModelRefToCanonical(ref), CANONICAL_TO_DSH_PROVIDER);
}
export {
  setDshHarness,
  resolveModelRefForDsh,
  parseDshSessionKey,
  dshModelRefToCanonical,
  currentHarness2 as currentHarness,
  canonicalSessionKey,
  DSH_SESSION_KEY_PREFIX,
  DSH_HARNESS,
  DSH_DEEPSEEK_PROVIDER,
  CANONICAL_DEEPSEEK_PROVIDER
};
