const compatUrl = new URL('./fs-promises-compat.mjs', import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'node:fs/promises' && context.parentURL !== compatUrl) {
    return { url: compatUrl, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}