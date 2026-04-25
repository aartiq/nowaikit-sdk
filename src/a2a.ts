// A2A (Agent-to-Agent) protocol client
// Implements the Google A2A protocol for inter-agent communication

export interface A2AClientConfig {
  agentUrl: string;
  bearerToken?: string;
}

export type A2APart = {
  type: 'text';
  text: string;
} | {
  type: 'data';
  data: Record<string, unknown>;
};

export interface A2AMessage {
  role: 'user';
  parts: A2APart[];
}

export interface A2AAgentCard {
  name: string;
  description?: string;
  url: string;
  version?: string;
  capabilities?: Record<string, unknown>;
  skills?: Array<{ id: string; name: string; description?: string }>;
  [key: string]: unknown;
}

export interface A2ATask {
  id: string;
  status: {
    state: 'submitted' | 'working' | 'input-required' | 'completed' | 'canceled' | 'failed';
    message?: A2AMessage;
  };
  artifacts?: Array<{ parts: A2APart[] }>;
  [key: string]: unknown;
}

export class A2AClient {
  private agentUrl: string;
  private bearerToken?: string;

  constructor(config: A2AClientConfig) {
    this.agentUrl = config.agentUrl.replace(/\/$/, '');
    this.bearerToken = config.bearerToken;
  }

  private getHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    };
    if (this.bearerToken) {
      headers['Authorization'] = `Bearer ${this.bearerToken}`;
    }
    return headers;
  }

  /** Discover the agent's capabilities via the well-known agent card endpoint. */
  async discoverAgent(): Promise<A2AAgentCard> {
    const response = await fetch(`${this.agentUrl}/.well-known/agent.json`, {
      method: 'GET',
      headers: this.getHeaders(),
    });

    if (!response.ok) {
      throw new Error(`A2A agent discovery failed: ${response.status} ${response.statusText}`);
    }

    return response.json() as Promise<A2AAgentCard>;
  }

  /** Send a task to the A2A agent. Returns the created/updated task. */
  async sendTask(message: A2AMessage, id?: string): Promise<A2ATask> {
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

    const body = await response.json() as { result?: A2ATask; error?: { message: string } };
    if (body.error) {
      throw new Error(`A2A sendTask error: ${body.error.message}`);
    }
    return body.result as A2ATask;
  }

  /** Get the current state of a task by its ID. */
  async getTask(taskId: string): Promise<A2ATask> {
    const response = await fetch(`${this.agentUrl}/a2a/tasks/${encodeURIComponent(taskId)}`, {
      method: 'GET',
      headers: this.getHeaders(),
    });

    if (!response.ok) {
      throw new Error(`A2A getTask failed: ${response.status} ${response.statusText}`);
    }

    const body = await response.json() as { result?: A2ATask; error?: { message: string } };
    if (body.error) {
      throw new Error(`A2A getTask error: ${body.error.message}`);
    }
    return body.result as A2ATask;
  }

  /** Cancel a running task. */
  async cancelTask(taskId: string): Promise<A2ATask> {
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

    const body = await response.json() as { result?: A2ATask; error?: { message: string } };
    if (body.error) {
      throw new Error(`A2A cancelTask error: ${body.error.message}`);
    }
    return body.result as A2ATask;
  }
}
