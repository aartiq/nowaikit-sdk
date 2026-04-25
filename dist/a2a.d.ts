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
    skills?: Array<{
        id: string;
        name: string;
        description?: string;
    }>;
    [key: string]: unknown;
}
export interface A2ATask {
    id: string;
    status: {
        state: 'submitted' | 'working' | 'input-required' | 'completed' | 'canceled' | 'failed';
        message?: A2AMessage;
    };
    artifacts?: Array<{
        parts: A2APart[];
    }>;
    [key: string]: unknown;
}
export declare class A2AClient {
    private agentUrl;
    private bearerToken?;
    constructor(config: A2AClientConfig);
    private getHeaders;
    /** Discover the agent's capabilities via the well-known agent card endpoint. */
    discoverAgent(): Promise<A2AAgentCard>;
    /** Send a task to the A2A agent. Returns the created/updated task. */
    sendTask(message: A2AMessage, id?: string): Promise<A2ATask>;
    /** Get the current state of a task by its ID. */
    getTask(taskId: string): Promise<A2ATask>;
    /** Cancel a running task. */
    cancelTask(taskId: string): Promise<A2ATask>;
}
//# sourceMappingURL=a2a.d.ts.map