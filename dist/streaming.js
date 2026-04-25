// SSE (Server-Sent Events) stream parser
// Parses text/event-stream responses into structured event/data pairs
/**
 * Parse an SSE (text/event-stream) response into an async generator of events.
 * Each yielded value contains the event type and data payload.
 */
export async function* streamSSE(url, options = {}) {
    const response = await fetch(url, {
        ...options,
        headers: {
            'Accept': 'text/event-stream',
            ...options.headers,
        },
    });
    if (!response.ok) {
        throw new Error(`SSE connection failed: ${response.status} ${response.statusText}`);
    }
    if (!response.body) {
        throw new Error('SSE response has no body');
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let currentEvent = 'message';
    let currentData = '';
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done)
                break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            // Keep the last incomplete line in the buffer
            buffer = lines.pop() ?? '';
            for (const line of lines) {
                if (line === '') {
                    // Empty line signals end of an event
                    if (currentData) {
                        yield { event: currentEvent, data: currentData };
                        currentEvent = 'message';
                        currentData = '';
                    }
                    continue;
                }
                if (line.startsWith(':')) {
                    // Comment line, skip
                    continue;
                }
                const colonIndex = line.indexOf(':');
                let field;
                let value_;
                if (colonIndex === -1) {
                    field = line;
                    value_ = '';
                }
                else {
                    field = line.slice(0, colonIndex);
                    // Skip optional single space after colon
                    value_ = line[colonIndex + 1] === ' '
                        ? line.slice(colonIndex + 2)
                        : line.slice(colonIndex + 1);
                }
                switch (field) {
                    case 'event':
                        currentEvent = value_;
                        break;
                    case 'data':
                        currentData += (currentData ? '\n' : '') + value_;
                        break;
                    case 'id':
                        // ID field — not exposed but parsed per spec
                        break;
                    case 'retry':
                        // Retry field — not exposed but parsed per spec
                        break;
                }
            }
        }
        // Flush any remaining event
        if (currentData) {
            yield { event: currentEvent, data: currentData };
        }
    }
    finally {
        reader.releaseLock();
    }
}
//# sourceMappingURL=streaming.js.map