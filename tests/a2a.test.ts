import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { A2AClient } from '../src/a2a.js';
import type { A2AMessage } from '../src/a2a.js';

const AGENT_URL = 'https://agent.example.com';

function mockFetchResponse(body: unknown, status = 200) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  });
}

describe('A2AClient', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe('discoverAgent', () => {
    it('returns parsed agent card from well-known endpoint', async () => {
      const agentCard = {
        name: 'Test Agent',
        description: 'A test agent',
        url: AGENT_URL,
        version: '1.0.0',
        skills: [{ id: 'skill-1', name: 'Test Skill' }],
      };

      globalThis.fetch = mockFetchResponse(agentCard);

      const client = new A2AClient({ agentUrl: AGENT_URL });
      const result = await client.discoverAgent();

      expect(result).toEqual(agentCard);
      expect(globalThis.fetch).toHaveBeenCalledWith(
        `${AGENT_URL}/.well-known/agent.json`,
        expect.objectContaining({ method: 'GET' })
      );
    });

    it('throws on non-OK response', async () => {
      globalThis.fetch = mockFetchResponse({}, 404);

      const client = new A2AClient({ agentUrl: AGENT_URL });
      await expect(client.discoverAgent()).rejects.toThrow('A2A agent discovery failed');
    });

    it('includes bearer token in headers when configured', async () => {
      const agentCard = { name: 'Agent', url: AGENT_URL };
      globalThis.fetch = mockFetchResponse(agentCard);

      const client = new A2AClient({ agentUrl: AGENT_URL, bearerToken: 'secret-token' });
      await client.discoverAgent();

      expect(globalThis.fetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer secret-token',
          }),
        })
      );
    });
  });

  describe('sendTask', () => {
    it('sends correct POST with message payload', async () => {
      const task = {
        id: 'task-123',
        status: { state: 'submitted' },
      };

      globalThis.fetch = mockFetchResponse({ result: task });

      const client = new A2AClient({ agentUrl: AGENT_URL });
      const message: A2AMessage = {
        role: 'user',
        parts: [{ type: 'text', text: 'Hello agent' }],
      };

      const result = await client.sendTask(message, 'task-123');

      expect(result).toEqual(task);
      expect(globalThis.fetch).toHaveBeenCalledWith(
        `${AGENT_URL}/a2a/tasks/send`,
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('"tasks/send"'),
        })
      );
    });

    it('generates a task ID when none provided', async () => {
      const task = { id: 'generated-id', status: { state: 'submitted' } };
      globalThis.fetch = mockFetchResponse({ result: task });

      const client = new A2AClient({ agentUrl: AGENT_URL });
      const message: A2AMessage = {
        role: 'user',
        parts: [{ type: 'text', text: 'Test' }],
      };

      await client.sendTask(message);

      const callArgs = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      const body = JSON.parse(callArgs[1].body);
      expect(body.params.id).toBeDefined();
      expect(typeof body.params.id).toBe('string');
    });

    it('throws on JSON-RPC error response', async () => {
      globalThis.fetch = mockFetchResponse({
        error: { message: 'Task rejected' },
      });

      const client = new A2AClient({ agentUrl: AGENT_URL });
      const message: A2AMessage = {
        role: 'user',
        parts: [{ type: 'text', text: 'Test' }],
      };

      await expect(client.sendTask(message, 'task-1')).rejects.toThrow('Task rejected');
    });
  });

  describe('getTask', () => {
    it('fetches task by ID', async () => {
      const task = {
        id: 'task-456',
        status: { state: 'completed' },
        artifacts: [{ parts: [{ type: 'text', text: 'Done' }] }],
      };

      globalThis.fetch = mockFetchResponse({ result: task });

      const client = new A2AClient({ agentUrl: AGENT_URL });
      const result = await client.getTask('task-456');

      expect(result).toEqual(task);
      expect(globalThis.fetch).toHaveBeenCalledWith(
        `${AGENT_URL}/a2a/tasks/task-456`,
        expect.objectContaining({ method: 'GET' })
      );
    });

    it('throws on error response', async () => {
      globalThis.fetch = mockFetchResponse({ error: { message: 'Not found' } });

      const client = new A2AClient({ agentUrl: AGENT_URL });
      await expect(client.getTask('nonexistent')).rejects.toThrow('Not found');
    });
  });

  describe('cancelTask', () => {
    it('sends cancel request and returns task', async () => {
      const task = {
        id: 'task-789',
        status: { state: 'canceled' },
      };

      globalThis.fetch = mockFetchResponse({ result: task });

      const client = new A2AClient({ agentUrl: AGENT_URL });
      const result = await client.cancelTask('task-789');

      expect(result).toEqual(task);
      expect(globalThis.fetch).toHaveBeenCalledWith(
        `${AGENT_URL}/a2a/tasks/task-789/cancel`,
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('"tasks/cancel"'),
        })
      );
    });

    it('throws on HTTP failure', async () => {
      globalThis.fetch = mockFetchResponse({}, 500);

      const client = new A2AClient({ agentUrl: AGENT_URL });
      await expect(client.cancelTask('task-1')).rejects.toThrow('A2A cancelTask failed');
    });
  });
});
