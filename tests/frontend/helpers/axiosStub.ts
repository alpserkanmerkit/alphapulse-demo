// Minimal axios stand-in for tests that only exercise pure helpers or apiFetch (fetch-based).
// Importing the real axios costs ~190 ms per test file (measured, node 22); utils/apiClient.ts
// only calls axios.create() + interceptors.use() at module load and never does I/O there.
const noop = () => undefined;

const instance = {
    interceptors: { request: { use: noop }, response: { use: noop } },
    get: noop,
    post: noop,
    put: noop,
    delete: noop,
};

const axiosStub = {
    create: () => instance,
    isAxiosError: (error: unknown) => Boolean((error as { isAxiosError?: boolean } | null)?.isAxiosError),
};

export default axiosStub;
export const AxiosError = class AxiosError extends Error {};
