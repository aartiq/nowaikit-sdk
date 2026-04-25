import { readFileSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { ServiceNowClient } from './client.js';
export class InstanceManager {
    instances = new Map();
    currentName = 'default';
    constructor() {
        this.loadInstances();
    }
    /** Create an InstanceManager from a config file path. */
    static fromConfig(configPath) {
        const manager = new InstanceManager();
        manager.instances.clear();
        if (existsSync(configPath)) {
            const raw = JSON.parse(readFileSync(configPath, 'utf8'));
            const defaultName = raw.defaultInstance || raw.default_instance || 'default';
            for (const [name, cfg] of Object.entries(raw.instances || {})) {
                const c = cfg;
                manager.registerFromRaw(name, c);
            }
            if (manager.instances.has(defaultName))
                manager.currentName = defaultName;
        }
        return manager;
    }
    loadInstances() {
        // 1. Try instances.json config file
        const configPath = process.env.SN_INSTANCES_CONFIG;
        if (configPath && existsSync(configPath)) {
            try {
                const raw = JSON.parse(readFileSync(configPath, 'utf8'));
                const defaultName = raw.default_instance || raw.default || 'default';
                for (const [name, cfg] of Object.entries(raw.instances || {})) {
                    const c = cfg;
                    this.register(name, this.buildConfig(c.instance_url || c.url, c.auth_method || c.auth || 'basic', c), c.group || 'Default', c.environment || '');
                }
                if (this.instances.has(defaultName))
                    this.currentName = defaultName;
                return;
            }
            catch { /* fall through */ }
        }
        // 2. Try wizard config store
        const wizardConfigPath = join(homedir(), '.config', 'nowaikit', 'instances.json');
        if (existsSync(wizardConfigPath)) {
            try {
                const raw = JSON.parse(readFileSync(wizardConfigPath, 'utf8'));
                const defaultName = raw.defaultInstance || 'default';
                for (const [name, cfg] of Object.entries(raw.instances || {})) {
                    const c = cfg;
                    this.register(name, {
                        instanceUrl: c['instanceUrl'],
                        authMethod: c['authMethod'] || 'basic',
                        basic: { username: c['username'], password: c['password'] },
                        oauth: {
                            clientId: c['clientId'],
                            clientSecret: c['clientSecret'],
                            username: c['username'],
                            password: c['password'],
                        },
                    }, c['group'] || 'Default', c['environment'] || '');
                }
                if (this.instances.has(defaultName))
                    this.currentName = defaultName;
                return;
            }
            catch { /* fall through */ }
        }
        // 3. Try SN_INSTANCE_<NAME>_URL env var groups
        const envNames = Object.keys(process.env)
            .filter(k => /^SN_INSTANCE_[A-Z0-9_]+_URL$/.test(k))
            .map(k => k.replace(/^SN_INSTANCE_/, '').replace(/_URL$/, '').toLowerCase());
        for (const name of envNames) {
            const upper = name.toUpperCase();
            const url = process.env[`SN_INSTANCE_${upper}_URL`];
            const auth = (process.env[`SN_INSTANCE_${upper}_AUTH`] || 'basic');
            if (!url)
                continue;
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
        if (defaultEnvName && this.instances.has(defaultEnvName))
            this.currentName = defaultEnvName;
        // 4. Legacy single-instance env vars
        const legacyUrl = process.env.SERVICENOW_INSTANCE_URL;
        if (legacyUrl && !this.instances.has('default')) {
            const auth = (process.env.SERVICENOW_AUTH_METHOD || 'basic');
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
            if (this.instances.size === 1)
                this.currentName = 'default';
        }
    }
    buildConfig(url, auth, c) {
        return {
            instanceUrl: url, authMethod: auth,
            basic: { username: c.username, password: c.password },
            oauth: { clientId: c.client_id, clientSecret: c.client_secret, username: c.username, password: c.password },
            maxRetries: c.max_retries || parseInt(process.env.MAX_RETRIES || '3', 10),
            retryDelayMs: c.retry_delay_ms || parseInt(process.env.RETRY_DELAY_MS || '1000', 10),
            requestTimeoutMs: c.request_timeout_ms || parseInt(process.env.REQUEST_TIMEOUT_MS || '30000', 10),
        };
    }
    registerFromRaw(name, c) {
        this.register(name, {
            instanceUrl: (c['instanceUrl'] || c['instance_url'] || c['url']),
            authMethod: (c['authMethod'] || c['auth_method'] || c['auth']) || 'basic',
            basic: { username: c['username'], password: c['password'] },
            oauth: {
                clientId: (c['clientId'] || c['client_id']),
                clientSecret: (c['clientSecret'] || c['client_secret']),
                username: c['username'],
                password: c['password'],
            },
        }, c['group'] || 'Default', c['environment'] || '');
    }
    register(name, config, group = 'Default', environment = '') {
        this.instances.set(name, {
            name, url: config.instanceUrl, group, environment,
            client: new ServiceNowClient(config),
        });
    }
    getClient(name) {
        const target = name ? name.toLowerCase() : this.currentName;
        const entry = this.instances.get(target);
        if (!entry)
            throw new Error(`Unknown instance "${target}". Available: ${this.listNames().join(', ')}`);
        return entry.client;
    }
    reload() {
        this.instances.clear();
        this.currentName = 'default';
        this.loadInstances();
    }
    switch(name) {
        const lower = name.toLowerCase();
        if (!this.instances.has(lower))
            throw new Error(`Unknown instance "${name}". Available: ${this.listNames().join(', ')}`);
        this.currentName = lower;
    }
    getCurrentName() { return this.currentName; }
    getCurrentUrl() { return this.instances.get(this.currentName)?.url || ''; }
    listNames() { return Array.from(this.instances.keys()); }
    listAll() {
        return Array.from(this.instances.values()).map(e => ({
            name: e.name, url: e.url, active: e.name === this.currentName, group: e.group, environment: e.environment,
        }));
    }
}
//# sourceMappingURL=instances.js.map