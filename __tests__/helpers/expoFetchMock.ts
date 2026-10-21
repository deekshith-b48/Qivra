/** Test stand-in for expo/fetch: the global fetch (tests inject their own streaming fakes). */
export const fetch = (...args: Parameters<typeof globalThis.fetch>) => globalThis.fetch(...args);
