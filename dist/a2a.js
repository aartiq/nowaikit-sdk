// A2A (Agent-to-Agent) protocol client
// Implements the Google A2A protocol for inter-agent communication
export class A2AClient {
    agentUrl;
    bearerToken;
    constructor(config) {
        this.agentUrl = config.agentUrl.replace(/\/$/, '');
        this.bearerToken = config.bearerToken;
    }
    getHeaders() {
        const headers = {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
        };
        if (this.bearerToken) {
            headers['Authorization'] = `Bearer ${this.bearerToken}`;
        }
        return headers;
    }
    /** Discover the agent's capabilities via the well-known agent card endpoint. */
    async discoverAgent() {
        const response = await fetch(`${this.agentUrl}/.well-known/agent.json`, {
            method: 'GET',
            headers: this.getHeaders(),
        });
        if (!response.ok) {
            throw new Error(`A2A agent discovery failed: ${response.status} ${response.statusText}`);
        }
        return response.json();
    }
    /** Send a task to the A2A agent. Returns the created/updated task. */
    async sendTask(message, id) {
        const taskId = id ?? crypto.randomUUID();
        const response = await fetch(`${this.agentUrl}/a2a/tasks/send`, {
            method: 'POST',
            headers: this.getHeaders(),
            body: JSON.stringify({
                jsonrpc: '2.0',
                method: 'tasks/send',
                id: taskId,
                params: {
                    id: taskId,
                    message,
                },
            }),
        });
        if (!response.ok) {
            throw new Error(`A2A sendTask failed: ${response.status} ${response.statusText}`);
        }
        const body = await response.json();
        if (body.error) {
            throw new Error(`A2A sendTask error: ${body.error.message}`);
        }
        return body.result;
    }
    /** Get the current state of a task by its ID. */
    async getTask(taskId) {
        const response = await fetch(`${this.agentUrl}/a2a/tasks/${encodeURIComponent(taskId)}`, {
            method: 'GET',
            headers: this.getHeaders(),
        });
        if (!response.ok) {
            throw new Error(`A2A getTask failed: ${response.status} ${response.statusText}`);
        }
        const body = await response.json();
        if (body.error) {
            throw new Error(`A2A getTask error: ${body.error.message}`);
        }
        return body.result;
    }
    /** Cancel a running task. */
    async cancelTask(taskId) {
        const response = await fetch(`${this.agentUrl}/a2a/tasks/${encodeURIComponent(taskId)}/cancel`, {
            method: 'POST',
            headers: this.getHeaders(),
            body: JSON.stringify({
                jsonrpc: '2.0',
                method: 'tasks/cancel',
                params: { id: taskId },
            }),
        });
        if (!response.ok) {
            throw new Error(`A2A cancelTask failed: ${response.status} ${response.statusText}`);
        }
        const body = await response.json();
        if (body.error) {
            throw new Error(`A2A cancelTask error: ${body.error.message}`);
        }
        return body.result;
    }
}
//# sourceMappingURL=a2a.js.map