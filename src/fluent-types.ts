// Fluent / now-sdk TypeScript type definitions
// Types for ServiceNow UX Framework application configuration

/** Top-level configuration for a Fluent / now-sdk application. */
export interface NowConfig {
  name: string;
  version: string;
  scope: string;
  description?: string;
  components?: FluentComponent[];
  routes?: UxAppRoute[];
}

/** A component definition within a Fluent application. */
export interface FluentComponent {
  name: string;
  type: 'page' | 'macroponent' | 'data_resource';
  properties?: Record<string, any>;
}

/** A route mapping for a UX application. */
export interface UxAppRoute {
  path: string;
  component: string;
  title?: string;
}

/** A data broker configuration for Fluent components. */
export interface FluentDataBroker {
  name: string;
  source: string;
  mapping?: Record<string, string>;
}
