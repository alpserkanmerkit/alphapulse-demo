export enum CircuitState {
    CLOSED,
    OPEN,
    HALF_OPEN,
}

interface CircuitBreakerOptions {
    failureThreshold: number;
    cooldownMs: number;
    requestTimeoutMs: number;
    probeTimeoutMs: number;
}

export class CircuitBreaker {
    private state = CircuitState.CLOSED;
    private failureCount = 0;
    private nextAttemptTime = 0;
    private readonly options: CircuitBreakerOptions;

    constructor(options?: Partial<CircuitBreakerOptions>) {
        this.options = {
            failureThreshold: 3,
            cooldownMs: 15000,
            requestTimeoutMs: 30000,
            probeTimeoutMs: 25000,
            ...options,
        };
    }

    async execute<T>(action: (signal: AbortSignal) => Promise<T>): Promise<T> {
        this.checkState();
        if (this.state === CircuitState.OPEN) {
            throw new Error('CircuitBreaker is OPEN');
        }

        const controller = new AbortController();
        const timeoutId = setTimeout(
            () => controller.abort(),
            this.state === CircuitState.HALF_OPEN ? this.options.probeTimeoutMs : this.options.requestTimeoutMs
        );

        try {
            const result = await action(controller.signal);
            clearTimeout(timeoutId);
            this.onSuccess();
            return result;
        } catch (error) {
            clearTimeout(timeoutId);
            this.onFailure();
            throw error;
        }
    }

    private checkState() {
        if (this.state === CircuitState.OPEN && Date.now() > this.nextAttemptTime) {
            this.state = CircuitState.HALF_OPEN;
        }
    }

    private onSuccess() {
        this.state = CircuitState.CLOSED;
        this.failureCount = 0;
    }

    private onFailure() {
        this.failureCount++;
        if (this.state === CircuitState.HALF_OPEN || this.failureCount >= this.options.failureThreshold) {
            this.state = CircuitState.OPEN;
            this.nextAttemptTime = Date.now() + this.options.cooldownMs;
        }
    }
}

export const quantCircuitBreaker = new CircuitBreaker();
