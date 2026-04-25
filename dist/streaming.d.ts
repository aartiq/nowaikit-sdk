export interface SSEEvent {
    event: string;
    data: string;
}
/**
 * Parse an SSE (text/event-stream) response into an async generator of events.
 * Each yielded value contains the event type and data payload.
 */
export declare function streamSSE(url: string, options?: RequestInit): AsyncGenerator<SSEEvent>;
//# sourceMappingURL=streaming.d.ts.map