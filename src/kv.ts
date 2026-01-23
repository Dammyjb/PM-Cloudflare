// KV storage for configuration, caching, and rules

export interface ClassificationRules {
  routing_rules: {
    immediate_engineering: { urgency_min: number; impact_min: number };
    quick_win_backlog: { urgency_max: number; actionability_min: number };
    trust_risk: { sentiment_max: number; impact_min: number };
  };
  urgency_keywords: {
    critical: string[];
    high: string[];
    low: string[];
  };
  impact_signals: {
    enterprise: string[];
    production: string[];
    single_user: string[];
  };
}

export interface SourceConfig {
  name: string;
  type: "github" | "discord" | "zendesk" | "survey" | "custom";
  enabled: boolean;
  api_endpoint?: string;
  polling_interval_minutes?: number;
}

export class ConfigStore {
  constructor(private kv: KVNamespace) {}

  // Get classification rules
  async getClassificationRules(): Promise<ClassificationRules> {
    const cached = await this.kv.get("classification_rules", "json");
    if (cached) return cached as ClassificationRules;

    // Default rules based on our PM framework
    const defaultRules: ClassificationRules = {
      routing_rules: {
        immediate_engineering: { urgency_min: 4, impact_min: 4 },
        quick_win_backlog: { urgency_max: 2, actionability_min: 4 },
        trust_risk: { sentiment_max: -1, impact_min: 3 },
      },
      urgency_keywords: {
        critical: [
          "security",
          "vulnerability",
          "cannot install",
          "data loss",
          "outage",
          "production down",
          "breach",
          "exploit",
        ],
        high: [
          "production",
          "enterprise",
          "fails consistently",
          "no workaround",
          "blocked",
          "critical",
          "urgent",
          "forever",
          "never recovers",
        ],
        low: [
          "feature request",
          "nice to have",
          "suggestion",
          "question",
          "wondering",
          "curious",
          "would be nice",
        ],
      },
      impact_signals: {
        enterprise: [
          "our organization",
          "our team",
          "enterprise",
          "active directory",
          "domain-joined",
          "cluster",
          "our company",
          "multiple users",
        ],
        production: [
          "production",
          "live",
          "customers affected",
          "revenue",
          "sla",
          "downtime",
          "outage",
        ],
        single_user: [
          "my home",
          "personal",
          "hobby",
          "just me",
          "learning",
          "testing",
          "playing around",
        ],
      },
    };

    await this.kv.put("classification_rules", JSON.stringify(defaultRules), {
      expirationTtl: 86400, // 24 hours
    });

    return defaultRules;
  }

  // Update classification rules
  async updateClassificationRules(rules: Partial<ClassificationRules>): Promise<void> {
    const current = await this.getClassificationRules();
    const updated = { ...current, ...rules };
    await this.kv.put("classification_rules", JSON.stringify(updated));
  }

  // Get source configurations
  async getSourceConfigs(): Promise<SourceConfig[]> {
    const configs = await this.kv.get("source_configs", "json");
    if (configs) return configs as SourceConfig[];

    // Default source configuration
    const defaultConfigs: SourceConfig[] = [
      {
        name: "github-issues",
        type: "github",
        enabled: true,
        api_endpoint: "https://api.github.com/repos/cloudflare/cloudflared/issues",
        polling_interval_minutes: 15,
      },
      {
        name: "discord-feedback",
        type: "discord",
        enabled: false,
      },
      {
        name: "support-tickets",
        type: "zendesk",
        enabled: false,
      },
    ];

    await this.kv.put("source_configs", JSON.stringify(defaultConfigs));
    return defaultConfigs;
  }

  // Update source configurations
  async updateSourceConfigs(configs: SourceConfig[]): Promise<void> {
    await this.kv.put("source_configs", JSON.stringify(configs));
  }

  // Cache classification result for deduplication (short TTL for demo)
  async cacheClassification(
    feedbackId: string,
    classification: any,
    ttlSeconds: number = 300  // 5 minutes for demo (was 1 hour)
  ): Promise<void> {
    await this.kv.put(`classification:${feedbackId}`, JSON.stringify(classification), {
      expirationTtl: ttlSeconds,
    });
  }

  // Clear classification cache for a feedback item (used on reclassification)
  async clearClassificationCache(feedbackId: string): Promise<void> {
    await this.kv.delete(`classification:${feedbackId}`);
  }

  // Get cached classification
  async getCachedClassification(feedbackId: string): Promise<any | null> {
    return await this.kv.get(`classification:${feedbackId}`, "json");
  }

  // Store prompt templates
  async getPromptTemplate(templateName: string): Promise<string | null> {
    return await this.kv.get(`prompt:${templateName}`);
  }

  async setPromptTemplate(templateName: string, template: string): Promise<void> {
    await this.kv.put(`prompt:${templateName}`, template);
  }

  // Rate limiting for API calls
  async checkRateLimit(
    key: string,
    maxRequests: number,
    windowSeconds: number
  ): Promise<boolean> {
    const current = (await this.kv.get(`ratelimit:${key}`, "json")) as {
      count: number;
      reset: number;
    } | null;
    const now = Date.now();

    if (!current || now > current.reset) {
      await this.kv.put(
        `ratelimit:${key}`,
        JSON.stringify({ count: 1, reset: now + windowSeconds * 1000 }),
        { expirationTtl: windowSeconds }
      );
      return true;
    }

    if (current.count >= maxRequests) {
      return false;
    }

    await this.kv.put(
      `ratelimit:${key}`,
      JSON.stringify({ count: current.count + 1, reset: current.reset }),
      { expirationTtl: windowSeconds }
    );
    return true;
  }

  // Store last sync timestamp per source
  async getLastSyncTime(source: string): Promise<string | null> {
    return await this.kv.get(`sync:${source}`);
  }

  async setLastSyncTime(source: string, timestamp: string): Promise<void> {
    await this.kv.put(`sync:${source}`, timestamp);
  }
}
