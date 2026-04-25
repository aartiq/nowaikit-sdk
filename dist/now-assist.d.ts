import type { ServiceNowClient } from './client.js';
/**
 * Client for interacting with Now Assist APIs.
 * Wraps skill execution, skill discovery, and conversation management.
 */
export declare class NowAssistClient {
    private client;
    constructor(client: ServiceNowClient);
    /**
     * Execute a Now Assist skill by sys_id with the given input parameters.
     */
    executeSkill(skillSysId: string, input: Record<string, any>): Promise<any>;
    /**
     * List available Now Assist skills, optionally filtered to active-only.
     */
    listSkills(active?: boolean): Promise<any>;
    /**
     * Create a new Now Assist conversation, optionally with a topic.
     */
    createConversation(topic?: string): Promise<any>;
    /**
     * Send a message within an existing Now Assist conversation.
     */
    sendMessage(conversationId: string, message: string): Promise<any>;
}
//# sourceMappingURL=now-assist.d.ts.map