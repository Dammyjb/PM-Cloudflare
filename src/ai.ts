// AI-powered classification and summarization

import { Classification, Feedback, Signal } from "./db";
import { ClassificationRules } from "./kv";

export class FeedbackClassifier {
  constructor(private ai: Ai) {}

  // Main classification function
  async classifyFeedback(
    feedback: Feedback,
    rules: ClassificationRules
  ): Promise<{ classification: Classification; signals: Signal[] }> {
    const prompt = this.buildClassificationPrompt(feedback, rules);

    const response = await this.ai.run("@cf/meta/llama-3.1-70b-instruct", {
      messages: [
        {
          role: "system",
          content: `You are a product analyst for cloudflare/cloudflared, an infrastructure tool where reliability and security are critical. Analyze user feedback and return structured JSON only. No explanations outside the JSON.`,
        },
        {
          role: "user",
          content: prompt,
        },
      ],
    });

    const result = this.parseAIResponse((response as any).response);

    // Apply routing rules
    const route = this.determineRoute(result.classification, rules);

    return {
      classification: {
        feedback_id: feedback.id,
        ...result.classification,
        route,
        confidence: result.confidence,
        reasoning: result.reasoning,
      },
      signals: result.signals.map((s: any) => ({
        feedback_id: feedback.id,
        ...s,
      })),
    };
  }

  private buildClassificationPrompt(
    feedback: Feedback,
    rules: ClassificationRules
  ): string {
    return `
Analyze this feedback and classify it according to our framework.

## Feedback
- **Source**: ${feedback.source}
- **Title**: ${feedback.title}
- **Label**: ${feedback.label || "None"}
- **Content**: ${feedback.content}

## Classification Framework

### Urgency (1-5)
- 1: Low - General questions, nice-to-haves
- 2: Moderate - Minor friction, workarounds exist
- 3: High - Functionality degraded, needs attention
- 4: Severe - Production affected, no workaround (even if reported calmly)
- 5: Critical - Security risk, installation blocked, complete outage

**Critical keywords**: ${rules.urgency_keywords.critical.join(", ")}
**High keywords**: ${rules.urgency_keywords.high.join(", ")}
**Low keywords**: ${rules.urgency_keywords.low.join(", ")}

IMPORTANT: Security concerns should be minimum Urgency 3. Installation failures should be minimum Urgency 4. Calm tone does NOT reduce urgency - score based on technical severity.

### Sentiment (-2 to +2)
- -2: Frustrated (explicit frustration, strong negative language, ALL CAPS, "ridiculous", "unacceptable")
- -1: Dissatisfied (pain points, mild complaints, "a pain", "frustrating")
- 0: Neutral (factual reporting, no emotional indicators)
- +1: Appreciative (thanks, acknowledges good work, "great product")
- +2: Enthusiastic (strong praise, advocacy)

### Impact (1-5)
- 1: Minimal - Single user curiosity
- 2: Low - Individual inconvenience, easy workaround
- 3: Moderate - Team/environment affected, painful workaround
- 4: High - Production degraded, enterprise environment, blocks adoption
- 5: Severe - Complete breakage, affects all users, security/data risk

**Enterprise signals**: ${rules.impact_signals.enterprise.join(", ")}
**Production signals**: ${rules.impact_signals.production.join(", ")}
**Single user signals**: ${rules.impact_signals.single_user.join(", ")}

### Actionability (1-5)
- 1: Unclear - Vague, missing context
- 2: Needs Info - Some detail but requires follow-up
- 3: Partially Actionable - Clear problem, uncertain solution
- 4: Actionable - Clear problem + environment + steps
- 5: Immediately Actionable - Clear bug with repro steps, obvious fix path

## Response Format
Return ONLY valid JSON (no markdown, no explanation):
{
  "classification": {
    "urgency": <1-5>,
    "sentiment": <-2 to 2>,
    "impact": <1-5>,
    "actionability": <1-5>
  },
  "signals": [
    {"signal_type": "feature_area", "signal_value": "<area like tunnels, installation, authentication>", "confidence": <0-1>},
    {"signal_type": "user_segment", "signal_value": "<segment like enterprise, hobbyist, developer>", "confidence": <0-1>},
    {"signal_type": "issue_category", "signal_value": "<category like bug, feature_request, question, documentation>", "confidence": <0-1>}
  ],
  "confidence": <0-1>,
  "reasoning": "<1-2 sentence explanation of scores>"
}
`;
  }

  private parseAIResponse(response: string): any {
    try {
      // Try to extract JSON from response
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error("No JSON found in response");

      const parsed = JSON.parse(jsonMatch[0]);

      // Validate required fields
      if (!parsed.classification || typeof parsed.classification.urgency !== "number") {
        throw new Error("Invalid classification structure");
      }

      return parsed;
    } catch (e) {
      console.error("Failed to parse AI response:", e, "Response:", response);
      // Return default conservative classification on parse failure
      return {
        classification: {
          urgency: 3,
          sentiment: 0,
          impact: 3,
          actionability: 2,
        },
        signals: [],
        confidence: 0.3,
        reasoning: "Failed to parse AI response, using conservative defaults",
      };
    }
  }

  private determineRoute(
    classification: {
      urgency: number;
      sentiment: number;
      impact: number;
      actionability: number;
    },
    rules: ClassificationRules
  ): string {
    const routes: string[] = [];

    // Check immediate engineering: Urgency >= 4 AND Impact >= 4
    if (
      classification.urgency >= rules.routing_rules.immediate_engineering.urgency_min &&
      classification.impact >= rules.routing_rules.immediate_engineering.impact_min
    ) {
      routes.push("immediate_engineering");
    }

    // Check quick win: Urgency <= 2 AND Actionability >= 4
    if (
      classification.urgency <= rules.routing_rules.quick_win_backlog.urgency_max &&
      classification.actionability >= rules.routing_rules.quick_win_backlog.actionability_min
    ) {
      routes.push("quick_win_backlog");
    }

    // Check trust risk: Sentiment < 0 AND Impact >= 3
    if (
      classification.sentiment <= rules.routing_rules.trust_risk.sentiment_max &&
      classification.impact >= rules.routing_rules.trust_risk.impact_min
    ) {
      routes.push("trust_risk");
    }

    return routes.length > 0 ? routes.join(",") : "standard_backlog";
  }

  // Generate PM summary
  async generatePMSummary(
    feedbackItems: any[],
    metrics: any,
    periodDescription: string
  ): Promise<string> {
    const immediateEngineering = feedbackItems
      .filter((f) => f.route?.includes("immediate_engineering"))
      .slice(0, 5);
    const trustRisks = feedbackItems
      .filter((f) => f.route?.includes("trust_risk"))
      .slice(0, 5);
    const quickWins = feedbackItems
      .filter((f) => f.route?.includes("quick_win_backlog"))
      .slice(0, 5);

    const prompt = `
You are a senior product analyst. Generate a concise, actionable PM summary.

## Period: ${periodDescription}

## Metrics
- Total feedback items: ${metrics.total}
- By route: ${JSON.stringify(metrics.by_route)}
- By source: ${JSON.stringify(metrics.by_source)}
- Averages: Urgency ${metrics.averages?.avg_urgency?.toFixed(1) || "N/A"}, Sentiment ${metrics.averages?.avg_sentiment?.toFixed(1) || "N/A"}, Impact ${metrics.averages?.avg_impact?.toFixed(1) || "N/A"}

## High Priority Items (Immediate Engineering)
${
  immediateEngineering.length > 0
    ? immediateEngineering
        .map((f) => `- [${f.source}] ${f.title} (Urgency:${f.urgency} Impact:${f.impact})`)
        .join("\n")
    : "None"
}

## Trust Risks (Frustrated users with significant impact)
${
  trustRisks.length > 0
    ? trustRisks
        .map((f) => `- [${f.source}] ${f.title} (Sentiment:${f.sentiment} Impact:${f.impact})`)
        .join("\n")
    : "None"
}

## Quick Wins (Low urgency, high actionability)
${
  quickWins.length > 0
    ? quickWins.map((f) => `- [${f.source}] ${f.title} (Actionability:${f.actionability})`).join("\n")
    : "None"
}

Generate a summary with these sections:
1. **Executive Summary** (2-3 sentences)
2. **Key Themes** (2-3 bullet points)
3. **Recommended Actions** (prioritized numbered list)
4. **Risk Assessment** (any trust or reliability concerns)

Keep it concise and actionable. Focus on insights, not just data repetition.
`;

    const response = await this.ai.run("@cf/meta/llama-3.1-70b-instruct", {
      messages: [
        {
          role: "system",
          content: "You are a senior product analyst creating executive summaries.",
        },
        { role: "user", content: prompt },
      ],
    });

    return (response as any).response;
  }

  // Extract key themes from multiple feedback items
  async extractThemes(feedbackItems: Feedback[], limit: number = 5): Promise<string[]> {
    if (feedbackItems.length === 0) return [];

    const feedbackSummary = feedbackItems
      .slice(0, 20)
      .map((f) => `- ${f.title}: ${f.content.slice(0, 200)}`)
      .join("\n");

    const prompt = `
Analyze these feedback items and extract the ${limit} most common themes or topics.

Feedback:
${feedbackSummary}

Return ONLY a JSON array of theme strings, e.g.: ["theme1", "theme2", "theme3"]
`;

    const response = await this.ai.run("@cf/meta/llama-3.1-8b-instruct", {
      messages: [
        { role: "system", content: "Extract themes from feedback. Return only JSON array." },
        { role: "user", content: prompt },
      ],
    });

    try {
      const match = (response as any).response.match(/\[[\s\S]*\]/);
      if (match) {
        return JSON.parse(match[0]);
      }
    } catch (e) {
      console.error("Failed to parse themes:", e);
    }

    return [];
  }
}
