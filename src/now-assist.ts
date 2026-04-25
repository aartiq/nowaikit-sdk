// Now Assist API wrapper
// Provides access to Now Assist skills and conversations

import type { ServiceNowClient } from './client.js';

/**
 * Client for interacting with Now Assist APIs.
 * Wraps skill execution, skill discovery, and conversation management.
 */
export class NowAssistClient {
  constructor(private client: ServiceNowClient) {}

  /**
   * Execute a Now Assist skill by sys_id with the given input parameters.
   */
  async executeSkill(skillSysId: string, input: Record<string, any>): Promise<any> {
    const baseUrl = this.client.getBaseUrl();
    const response = await (this.client as any).request(
      `${baseUrl}/api/now/now_assist/skills/${encodeURIComponent(skillSysId)}/execute`,
      {
        method: 'POST',
        body: JSON.stringify({ input }),
      }
    );
    return response;
  }

  /**
   * List available Now Assist skills, optionally filtered to active-only.
   */
  async listSkills(active?: boolean): Promise<any> {
    let query = '';
    if (active !== undefined) {
      query = `?sysparm_query=active=${active}`;
    }
    const baseUrl = this.client.getBaseUrl();
    const response = await (this.client as any).request(
      `${baseUrl}/api/now/now_assist/skills${query}`,
      { method: 'GET' }
    );
    return response;
  }

  /**
   * Create a new Now Assist conversation, optionally with a topic.
   */
  async createConversation(topic?: string): Promise<any> {
    const baseUrl = this.client.getBaseUrl();
    const body: Record<string, string> = {};
    if (topic) {
      body.topic = topic;
    }
    const response = await (this.client as any).request(
      `${baseUrl}/api/now/now_assist/conversations`,
      {
        method: 'POST',
        body: JSON.stringify(body),
      }
    );
    return response;
  }

  /**
   * Send a message within an existing Now Assist conversation.
   */
  async sendMessage(conversationId: string, message: string): Promise<any> {
    const baseUrl = this.client.getBaseUrl();
    const response = await (this.client as any).request(
      `${baseUrl}/api/now/now_assist/conversations/${encodeURIComponent(conversationId)}/messages`,
      {
        method: 'POST',
        body: JSON.stringify({ message }),
      }
    );
    return response;
  }
}
