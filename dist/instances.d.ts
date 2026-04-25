import { ServiceNowClient } from './client.js';
import type { ServiceNowConfig } from './types.js';
export interface InstanceEntry {
    name: string;
    url: string;
    group: string;
    environment: string;
    client: ServiceNowClient;
}
export declare class InstanceManager {
    private instances;
    private currentName;
    constructor();
    /** Create an InstanceManager from a config file path. */
    static fromConfig(configPath: string): InstanceManager;
    private loadInstances;
    private buildConfig;
    private registerFromRaw;
    register(name: string, config: ServiceNowConfig, group?: string, environment?: string): void;
    getClient(name?: string): ServiceNowClient;
    reload(): void;
    switch(name: string): void;
    getCurrentName(): string;
    getCurrentUrl(): string;
    listNames(): string[];
    listAll(): Array<{
        name: string;
        url: string;
        active: boolean;
        group: string;
        environment: string;
    }>;
}
//# sourceMappingURL=instances.d.ts.map