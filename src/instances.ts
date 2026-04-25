import { readFileSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { ServiceNowClient } from './client.js';
import type { ServiceNowConfig } from './types.js';

export interface InstanceEntry {
  name: string;
  url: string;
  group: string;
  environment: string;
  client: ServiceNowClient;
}

export class InstanceManager {
  private instances: Map<string, InstanceEntry> = new Map();
  private currentName: string = 'default';

  constructor() {
    this.loadInstances();
  }

  /** Create an InstanceManager from a config file path. */
  static fromConfig(configPath: string): InstanceManager {
    const manager = new InstanceManager();
    manager.instances.clear();
    if (existsSync(configPath)) {
      const raw = JSON.parse(readFileSync(configPath, 'utf8'));
      const defaultName: string = raw.defaultInstance || raw.default_instance || 'default';
      for (const [name, cfg] of Object.entries(raw.instances || {})) {
        const c = cfg as Record<string, unknown>;
        manager.registerFromRaw(name, c);
      }
      if (manager.instances.has(defaultName)) manager.currentName = defaultName;
    }
    return manager;
  }

  private loadInstances(): void {
    // 1. Try instances.json config file
    const configPath = process.env.SN_INSTANCES_CONFIG;
    if (configPath && existsSync(configPath)) {
      try {
        const raw = JSON.parse(readFileSync(configPath, 'utf8'));
        const defaultName: string = raw.default_instance || raw.default || 'default';
        for (const [name, cfg] of Object.entries(raw.instances || {})) {
          const c = cfg as any;
          this.register(name, this.buildConfig(
            c.instance_url || c.url,
            c.auth_method || c.auth || 'basic',
            c
          ), c.group || 'Default', c.environment || '');
        }
        if (this.instances.has(defaultName)) this.currentName = defaultName;
        return;
      } catch { /* fall through */ }
    }

    // 2. Try wizard config store
    const wizardConfigPath = join(homedir(), '.config', 'nowaikit', 'instances.json');
    if (existsSync(wizardConfigPath)) {
      try {
        const raw = JSON.parse(readFileSync(wizardConfigPath, 'utf8'));
        const defaultName: string = raw.defaultInstance || 'default';
        for (const [name, cfg] of Object.entries(raw.instances || {})) {
          const c = cfg as Record<string, unknown>;
          this.register(name, {
            instanceUrl: c['instanceUrl'] as string,
            authMethod: (c['authMethod'] as 'basic' | 'oauth') || 'basic',
            basic: { username: c['username'] as string | undefined, password: c['password'] as string | undefined },
            oauth: {
              clientId: c['clientId'] as string | undefined,
              clientSecret: c['clientSecret'] as string | undefined,
              username: c['username'] as string | undefined,
              password: c['password'] as string | undefined,
            },
          }, (c['group'] as string) || 'Default', (c['environment'] as string) || '');
        }
        if (this.instances.has(defaultName)) this.currentName = defaultName;
        return;
      } catch { /* fall through */ }
    }

    // 3. Try SN_INSTANCE_<NAME>_URL env var groups
    const envNames = Object.keys(process.env)
      .filter(k => /^SN_INSTANCE_[A-Z0-9_]+_URL$/.test(k))
      .map(k => k.replace(/^SN_INSTANCE_/, '').replace(/_URL$/, '').toLowerCase());

    for (const name of envNames) {
      const upper = name.toUpperCase();
      const url = process.env[`SN_INSTANCE_${upper}_URL`];
      const auth = (process.env[`SN_INSTANCE_${upper}_AUTH`] || 'basic') as 'oauth' | 'basic';
      if (!url) continue;
      this.register(name, {
        instanceUrl: url, authMethod: auth,
        basic: { username: process.env[`SN_INSTANCE_${upper}_USERNAME`], password: process.env[`SN_INSTANCE_${upper}_PASSWORD`] },
        oauth: {
          clientId: process.env[`SN_INSTANCE_${upper}_CLIENT_ID`],
          clientSecret: process.env[`SN_INSTANCE_${upper}_CLIENT_SECRET`],
          username: process.env[`SN_INSTANCE_${upper}_USERNAME`],
          password: process.env[`SN_INSTANCE_${upper}_PASSWORD`],
        },
      });
    }

    const defaultEnvName = (process.env.SN_DEFAULT_INSTANCE || '').toLowerCase();
    if (defaultEnvName && this.instances.has(defaultEnvName)) this.currentName = defaultEnvName;

    // 4. Legacy single-instance env vars
    const legacyUrl = process.env.SERVICENOW_INSTANCE_URL;
    if (legacyUrl && !this.instances.has('default')) {
      const auth = (process.env.SERVICENOW_AUTH_METHOD || 'basic') as 'oauth' | 'basic';
      this.register('default', {
        instanceUrl: legacyUrl, authMethod: auth,
        basic: { username: process.env.SERVICENOW_BASIC_USERNAME, password: process.env.SERVICENOW_BASIC_PASSWORD },
        oauth: {
          clientId: process.env.SERVICENOW_OAUTH_CLIENT_ID || process.env.SERVICENOW_CLIENT_ID,
          clientSecret: process.env.SERVICENOW_OAUTH_CLIENT_SECRET || process.env.SERVICENOW_CLIENT_SECRET,
          username: process.env.SERVICENOW_OAUTH_USERNAME || process.env.SERVICENOW_USERNAME,
          password: process.env.SERVICENOW_OAUTH_PASSWORD || process.env.SERVICENOW_PASSWORD,
        },
        maxRetries: parseInt(process.env.MAX_RETRIES || '3', 10),
        retryDelayMs: parseInt(process.env.RETRY_DELAY_MS || '1000', 10),
        requestTimeoutMs: parseInt(process.env.REQUEST_TIMEOUT_MS || '30000', 10),
      });
      if (this.instances.size === 1) this.currentName = 'default';
    }
  }

  private buildConfig(url: string, auth: 'oauth' | 'basic', c: any): ServiceNowConfig {
    return {
      instanceUrl: url, authMethod: auth,
      basic: { username: c.username, password: c.password },
      oauth: { clientId: c.client_id, clientSecret: c.client_secret, username: c.username, password: c.password },
      maxRetries: c.max_retries || parseInt(process.env.MAX_RETRIES || '3', 10),
      retryDelayMs: c.retry_delay_ms || parseInt(process.env.RETRY_DELAY_MS || '1000', 10),
      requestTimeoutMs: c.request_timeout_ms || parseInt(process.env.REQUEST_TIMEOUT_MS || '30000', 10),
    };
  }

  private registerFromRaw(name: string, c: Record<string, unknown>): void {
    this.register(name, {
      instanceUrl: (c['instanceUrl'] || c['instance_url'] || c['url']) as string,
      authMethod: ((c['authMethod'] || c['auth_method'] || c['auth']) as 'basic' | 'oauth') || 'basic',
      basic: { username: c['username'] as string | undefined, password: c['password'] as string | undefined },
      oauth: {
        clientId: (c['clientId'] || c['client_id']) as string | undefined,
        clientSecret: (c['clientSecret'] || c['client_secret']) as string | undefined,
        username: c['username'] as string | undefined,
        password: c['password'] as string | undefined,
      },
    }, (c['group'] as string) || 'Default', (c['environment'] as string) || '');
  }

  register(name: string, config: ServiceNowConfig, group = 'Default', environment = ''): void {
    this.instances.set(name, {
      name, url: config.instanceUrl, group, environment,
      client: new ServiceNowClient(config),
    });
  }

  getClient(name?: string): ServiceNowClient {
    const target = name ? name.toLowerCase() : this.currentName;
    const entry = this.instances.get(target);
    if (!entry) throw new Error(`Unknown instance "${target}". Available: ${this.listNames().join(', ')}`);
    return entry.client;
  }

  reload(): void {
    this.instances.clear();
    this.currentName = 'default';
    this.loadInstances();
  }

  switch(name: string): void {
    const lower = name.toLowerCase();
    if (!this.instances.has(lower)) throw new Error(`Unknown instance "${name}". Available: ${this.listNames().join(', ')}`);
    this.currentName = lower;
  }

  getCurrentName(): string { return this.currentName; }
  getCurrentUrl(): string { return this.instances.get(this.currentName)?.url || ''; }
  listNames(): string[] { return Array.from(this.instances.keys()); }

  listAll(): Array<{ name: string; url: string; active: boolean; group: string; environment: string }> {
    return Array.from(this.instances.values()).map(e => ({
      name: e.name, url: e.url, active: e.name === this.currentName, group: e.group, environment: e.environment,
    }));
  }
}
