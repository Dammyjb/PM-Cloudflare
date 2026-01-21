/**
 * Feedback Intelligence Agent
 * Aggregates and analyzes user feedback from multiple sources
 * using LLMs to extract structured signals and produce actionable PM summaries.
 */

import { FeedbackDB, Feedback } from "./db";
import { ConfigStore } from "./kv";
import { FeedbackClassifier } from "./ai";

export interface Env {
  AI: Ai;
  DB: D1Database;
  KV: KVNamespace;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // Initialize services
    const db = new FeedbackDB(env.DB);
    const config = new ConfigStore(env.KV);
    const classifier = new FeedbackClassifier(env.AI);

    // CORS headers for API access
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    // Handle CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      // ============ FEEDBACK INGESTION ============

      // POST /api/ingest - Ingest feedback from any source
      if (path === "/api/ingest" && request.method === "POST") {
        const body = await request.json() as Feedback | Feedback[];
        const feedbackItems = Array.isArray(body) ? body : [body];

        for (const item of feedbackItems) {
          await db.ingestFeedback(item);
        }

        return Response.json(
          { success: true, ingested: feedbackItems.length },
          { headers: corsHeaders }
        );
      }

      // ============ CLASSIFICATION ============

      // POST /api/classify - Classify pending feedback using AI
      if (path === "/api/classify" && request.method === "POST") {
        const rules = await config.getClassificationRules();
        const limitParam = url.searchParams.get("limit");
        const limit = limitParam ? parseInt(limitParam) : 10;
        const unclassified = await db.getUnclassifiedFeedback(limit);

        if (unclassified.length === 0) {
          return Response.json(
            { success: true, message: "No unclassified feedback", classified: [] },
            { headers: corsHeaders }
          );
        }

        const results = [];
        for (const feedback of unclassified) {
          // Check cache first
          const cached = await config.getCachedClassification(feedback.id);
          if (cached) {
            results.push({ id: feedback.id, cached: true, ...cached });
            continue;
          }

          // Classify with AI
          const { classification, signals } = await classifier.classifyFeedback(
            feedback,
            rules
          );

          // Store results
          await db.storeClassification(classification);
          if (signals.length > 0) {
            await db.storeSignals(signals);
          }

          // Cache result
          await config.cacheClassification(feedback.id, classification);

          results.push({ id: feedback.id, cached: false, ...classification });
        }

        return Response.json(
          { success: true, classified: results },
          { headers: corsHeaders }
        );
      }

      // GET /api/feedback - Get all feedback with classifications
      if (path === "/api/feedback" && request.method === "GET") {
        const limitParam = url.searchParams.get("limit");
        const limit = limitParam ? parseInt(limitParam) : 100;
        const feedback = await db.getAllFeedbackWithClassifications(limit);

        return Response.json({ feedback }, { headers: corsHeaders });
      }

      // ============ PM DASHBOARD ============

      // GET /api/dashboard - Get PM dashboard data
      if (path === "/api/dashboard" && request.method === "GET") {
        const days = parseInt(url.searchParams.get("days") || "7");
        const endDate = new Date().toISOString();
        const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

        const [metrics, immediate, trustRisk, quickWins, trends] = await Promise.all([
          db.getMetrics(startDate, endDate),
          db.getFeedbackByRoute("immediate_engineering", 10),
          db.getFeedbackByRoute("trust_risk", 10),
          db.getFeedbackByRoute("quick_win_backlog", 10),
          db.getTrendingSignals(days, 10),
        ]);

        return Response.json(
          {
            period: { start: startDate, end: endDate, days },
            metrics,
            queues: {
              immediate_engineering: immediate,
              trust_risk: trustRisk,
              quick_wins: quickWins,
            },
            trending_signals: trends,
          },
          { headers: corsHeaders }
        );
      }

      // POST /api/summary - Generate AI-powered PM summary
      if (path === "/api/summary" && request.method === "POST") {
        const body = await request.json() as { days?: number };
        const days = body.days || 7;
        const endDate = new Date().toISOString();
        const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

        const metrics = await db.getMetrics(startDate, endDate);
        const allFeedback = await Promise.all([
          db.getFeedbackByRoute("immediate_engineering", 20),
          db.getFeedbackByRoute("trust_risk", 20),
          db.getFeedbackByRoute("quick_win_backlog", 20),
          db.getFeedbackByRoute("standard_backlog", 20),
        ]);

        const feedbackItems = allFeedback.flat();
        const summary = await classifier.generatePMSummary(
          feedbackItems,
          metrics,
          `Last ${days} days`
        );

        await db.storeSummary(startDate, endDate, "weekly", summary, metrics);

        return Response.json(
          { success: true, summary, metrics },
          { headers: corsHeaders }
        );
      }

      // ============ CONFIGURATION ============

      // GET /api/config/rules - Get classification rules
      if (path === "/api/config/rules" && request.method === "GET") {
        const rules = await config.getClassificationRules();
        return Response.json(rules, { headers: corsHeaders });
      }

      // PUT /api/config/rules - Update classification rules
      if (path === "/api/config/rules" && request.method === "PUT") {
        const updates = await request.json();
        await config.updateClassificationRules(updates);
        return Response.json({ success: true }, { headers: corsHeaders });
      }

      // GET /api/config/sources - Get source configurations
      if (path === "/api/config/sources" && request.method === "GET") {
        const sources = await config.getSourceConfigs();
        return Response.json(sources, { headers: corsHeaders });
      }

      // ============ SEED DATA ============

      // POST /api/seed - Seed sample data for testing
      if (path === "/api/seed" && request.method === "POST") {
        const sampleData = getSampleCloudflaredData();
        for (const item of sampleData) {
          await db.ingestFeedback(item);
        }
        return Response.json(
          { success: true, seeded: sampleData.length },
          { headers: corsHeaders }
        );
      }

      // ============ HEALTH CHECK ============

      if (path === "/api/health" || path === "/health") {
        return Response.json(
          {
            status: "healthy",
            timestamp: new Date().toISOString(),
            bindings: {
              ai: !!env.AI,
              db: !!env.DB,
              kv: !!env.KV,
            },
          },
          { headers: corsHeaders }
        );
      }

      // ============ API DOCUMENTATION ============

      // /api returns JSON documentation (root "/" serves static HTML dashboard)
      if (path === "/api") {
        return Response.json(
          {
            name: "Feedback Intelligence Agent",
            version: "1.0.0",
            description:
              "Aggregates and analyzes user feedback using LLMs to produce actionable PM summaries",
            endpoints: {
              "POST /api/ingest": "Ingest feedback from any source",
              "POST /api/classify": "Classify pending feedback using AI",
              "GET /api/feedback": "Get all feedback with classifications",
              "GET /api/dashboard": "Get PM dashboard data with metrics",
              "POST /api/summary": "Generate AI-powered PM summary",
              "GET /api/config/rules": "Get classification rules",
              "PUT /api/config/rules": "Update classification rules",
              "POST /api/seed": "Seed sample cloudflared data for testing",
              "GET /api/health": "Health check",
            },
            classification_framework: {
              urgency: "1 (Low) to 5 (Critical)",
              sentiment: "-2 (Frustrated) to +2 (Enthusiastic)",
              impact: "1 (Minimal) to 5 (Severe)",
              actionability: "1 (Unclear) to 5 (Immediately Actionable)",
            },
            routing_rules: {
              immediate_engineering: "Urgency >= 4 AND Impact >= 4",
              quick_win_backlog: "Urgency <= 2 AND Actionability >= 4",
              trust_risk: "Sentiment < 0 AND Impact >= 3",
            },
          },
          { headers: corsHeaders }
        );
      }

      // For unmatched paths, return 404 (root "/" will be handled by static assets)
      return Response.json(
        { error: "Not found", path },
        { status: 404, headers: corsHeaders }
      );
    } catch (error) {
      console.error("Worker error:", error);
      return Response.json(
        {
          error: error instanceof Error ? error.message : "Unknown error",
          stack: error instanceof Error ? error.stack : undefined,
        },
        { status: 500, headers: corsHeaders }
      );
    }
  },

  // Scheduled handler for automated classification
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    const db = new FeedbackDB(env.DB);
    const config = new ConfigStore(env.KV);
    const classifier = new FeedbackClassifier(env.AI);

    console.log("Running scheduled classification...");

    const rules = await config.getClassificationRules();
    const unclassified = await db.getUnclassifiedFeedback(25);

    let classified = 0;
    for (const feedback of unclassified) {
      try {
        const { classification, signals } = await classifier.classifyFeedback(
          feedback,
          rules
        );
        await db.storeClassification(classification);
        if (signals.length > 0) {
          await db.storeSignals(signals);
        }
        classified++;
      } catch (e) {
        console.error(`Failed to classify ${feedback.id}:`, e);
      }
    }

    console.log(`Classified ${classified} feedback items`);
  },
};

// Sample data from the cloudflare/cloudflared repository
function getSampleCloudflaredData(): Feedback[] {
  return [
    {
      id: "gh-001",
      source: "github",
      title: "Question regarding Cloudflare WARP VPN client usage",
      content:
        "I would value your opinion on whether it is safe to use the consumer version of the Cloudflare WARP client within the organization. I am specifically concerned about the security of the tunnels.",
      label: "Question",
      author: "enterprise-user",
      created_at: new Date().toISOString(),
    },
    {
      id: "gh-002",
      source: "github",
      title: "After fallback to http2 cloudflared never attempts quic again",
      content:
        "Our networking was down for a bit. An instance of cloudflared started, and was unable to connect to quic (as networking was down). cloudflared started trying http2 instead (which failed, as we only allow cloudflared to talk quic in our firewall). Networking came up. QUIC was never tried again; and hence cloudflared sat there retrying http2 forever.",
      label: "bug",
      author: "production-user",
      created_at: new Date().toISOString(),
    },
    {
      id: "gh-003",
      source: "github",
      title:
        "Cloudflare Tunnel subdomain intermittently fails when parent domain is hosted on Active Directory DNS",
      content:
        "We are using Cloudflare Tunnel (cloudflared) to expose an internal application using HTTPS for a small project. The tunnel works correctly for external / non-domain devices, but fails for Windows domain-joined machines when the parent domain is hosted on Active Directory integrated DNS. The setup worked for about a week and then started failing consistently.",
      label: null,
      author: "ad-admin",
      created_at: new Date().toISOString(),
    },
    {
      id: "gh-004",
      source: "github",
      title: "NEED HELP - Firewall - Docker - Allow cloudflared only connect to Cloudflare",
      content:
        "Thank for you for great product. I installed cloudflared for proxing request to my Frigate NVR running inside Docker under Ubuntu. So now I'm guessing how to setup ufw to allow cloudflared to connect to Cloudflare and block everything else.",
      label: "Question",
      author: "home-user",
      created_at: new Date().toISOString(),
    },
    {
      id: "gh-005",
      source: "github",
      title: "Please publish containers also on ghcr inside this repo",
      content:
        "Please also publish the container images to ghcr it is for free and not have any pull limits like docker.io which are a pain",
      label: "Feature Request",
      author: "devops-user",
      created_at: new Date().toISOString(),
    },
    {
      id: "gh-006",
      source: "github",
      title: "The cloudflared package cannot be installed via apt and deb packages",
      content:
        "Installation of the cloudflared package is not possible, the download speed is 2.6 PB/sec. Packets are ignored.",
      label: "Bug",
      author: "linux-user",
      created_at: new Date().toISOString(),
    },
    // Adding the hypothetical issues we generated earlier
    {
      id: "gh-007",
      source: "github",
      title: "Documentation for access policies is outdated and misleading",
      content:
        "I've been trying to configure access policies for our tunnel for three days now. The documentation says to use `cloudflared access` commands but half the flags mentioned don't exist in the current version. I followed the official guide step-by-step and it just doesn't work. This is really frustrating. We chose Cloudflare Tunnel specifically because of the promised simplicity, but I've spent more time debugging docs than actually building. Our team is starting to question whether we should just go back to a traditional VPN setup. Can someone please update the docs or at least add a version disclaimer?",
      label: "Documentation",
      author: "frustrated-team-lead",
      created_at: new Date().toISOString(),
    },
    {
      id: "gh-008",
      source: "github",
      title: "Tunnel disconnects silently under memory pressure, no reconnect attempt",
      content:
        "Environment: Ubuntu 22.04, cloudflared 2024.1.5, running as systemd service. When the host system experiences memory pressure (OOM killer activated for other processes), cloudflared loses its connection to the edge but does not attempt to reconnect. The process remains running with no errors in logs. The tunnel appears healthy in the dashboard but no traffic passes through. Steps to reproduce: 1. Run cloudflared tunnel with default config 2. Simulate memory pressure 3. Wait for OOM killer to free memory 4. Observe tunnel status. Expected behavior: cloudflared should detect connection loss and reconnect automatically. Workaround: Manual service restart recovers the tunnel. This is affecting three production nodes in our cluster.",
      label: "Bug",
      author: "sre-engineer",
      created_at: new Date().toISOString(),
    },
    {
      id: "gh-009",
      source: "github",
      title: "WHY is there no GUI?? This is ridiculous in 2024",
      content:
        "Seriously, why do I have to use the command line for everything? Not everyone is a Linux sysadmin. I just want to click a button to start my tunnel like a normal application. I tried to set this up for my home server to access my Plex remotely and I had to watch THREE YouTube videos just to understand what a config.yml even is. This is absolutely unacceptable for a company the size of Cloudflare. Other tunnel solutions have nice desktop apps. Why can't you just make a simple GUI wrapper? How hard can it be??? I'm mad that I wasted my entire Saturday on this. Terrible UX. Zero stars.",
      label: "Feature Request",
      author: "home-plex-user",
      created_at: new Date().toISOString(),
    },
  ];
}
