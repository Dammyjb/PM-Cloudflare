// Database operations for feedback intelligence agent

export interface Feedback {
  id: string;
  source: string;
  title: string;
  content: string;
  label?: string;
  author?: string;
  created_at: string;
  raw_metadata?: string;
}

export interface Classification {
  feedback_id: string;
  urgency: number;
  sentiment: number;
  impact: number;
  actionability: number;
  route?: string;
  confidence?: number;
  reasoning?: string;
}

export interface Signal {
  feedback_id: string;
  signal_type: string;
  signal_value: string;
  confidence?: number;
}

export class FeedbackDB {
  constructor(private db: D1Database) {}

  // Ingest feedback from any source
  async ingestFeedback(feedback: Feedback): Promise<void> {
    await this.db
      .prepare(
        `INSERT OR REPLACE INTO feedback
         (id, source, title, content, label, author, created_at, raw_metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        feedback.id,
        feedback.source,
        feedback.title,
        feedback.content,
        feedback.label || null,
        feedback.author || null,
        feedback.created_at,
        feedback.raw_metadata || null
      )
      .run();
  }

  // Batch ingest multiple feedback items
  async ingestFeedbackBatch(feedbackItems: Feedback[]): Promise<void> {
    const stmt = this.db.prepare(
      `INSERT OR REPLACE INTO feedback
       (id, source, title, content, label, author, created_at, raw_metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );

    await this.db.batch(
      feedbackItems.map((f) =>
        stmt.bind(
          f.id,
          f.source,
          f.title,
          f.content,
          f.label || null,
          f.author || null,
          f.created_at,
          f.raw_metadata || null
        )
      )
    );
  }

  // Store classification results
  async storeClassification(classification: Classification): Promise<void> {
    await this.db
      .prepare(
        `INSERT OR REPLACE INTO classifications
         (feedback_id, urgency, sentiment, impact, actionability, route, confidence, reasoning)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        classification.feedback_id,
        classification.urgency,
        classification.sentiment,
        classification.impact,
        classification.actionability,
        classification.route || null,
        classification.confidence || null,
        classification.reasoning || null
      )
      .run();
  }

  // Store extracted signals (clears old signals first to prevent duplicates)
  async storeSignals(signals: Signal[]): Promise<void> {
    if (signals.length === 0) return;

    // Get unique feedback IDs to clear old signals
    const feedbackIds = [...new Set(signals.map(s => s.feedback_id))];

    // Delete existing signals for these feedback items
    for (const feedbackId of feedbackIds) {
      await this.db
        .prepare(`DELETE FROM signals WHERE feedback_id = ?`)
        .bind(feedbackId)
        .run();
    }

    // Insert new signals
    const stmt = this.db.prepare(
      `INSERT INTO signals (feedback_id, signal_type, signal_value, confidence)
       VALUES (?, ?, ?, ?)`
    );

    await this.db.batch(
      signals.map((s) =>
        stmt.bind(s.feedback_id, s.signal_type, s.signal_value, s.confidence || null)
      )
    );
  }

  // Get unclassified feedback
  async getUnclassifiedFeedback(limit: number = 50): Promise<Feedback[]> {
    const result = await this.db
      .prepare(
        `SELECT f.* FROM feedback f
         LEFT JOIN classifications c ON f.id = c.feedback_id
         WHERE c.feedback_id IS NULL
         ORDER BY f.created_at DESC
         LIMIT ?`
      )
      .bind(limit)
      .all();

    return result.results as Feedback[];
  }

  // Get all feedback with classifications
  async getAllFeedbackWithClassifications(limit: number = 100): Promise<any[]> {
    const result = await this.db
      .prepare(
        `SELECT f.*, c.urgency, c.sentiment, c.impact, c.actionability, c.route, c.reasoning
         FROM feedback f
         LEFT JOIN classifications c ON f.id = c.feedback_id
         ORDER BY f.created_at DESC
         LIMIT ?`
      )
      .bind(limit)
      .all();

    return result.results;
  }

  // Get feedback by route for PM review
  async getFeedbackByRoute(route: string, limit: number = 20): Promise<any[]> {
    const result = await this.db
      .prepare(
        `SELECT f.*, c.urgency, c.sentiment, c.impact, c.actionability, c.reasoning
         FROM feedback f
         JOIN classifications c ON f.id = c.feedback_id
         WHERE c.route LIKE ?
         ORDER BY c.urgency DESC, c.impact DESC
         LIMIT ?`
      )
      .bind(`%${route}%`, limit)
      .all();

    return result.results;
  }

  // Get metrics for a time period
  async getMetrics(startDate: string, endDate: string): Promise<any> {
    const [totals, byRoute, bySource, avgScores] = await this.db.batch([
      this.db
        .prepare(
          `SELECT COUNT(*) as total FROM feedback
           WHERE created_at BETWEEN ? AND ?`
        )
        .bind(startDate, endDate),

      this.db
        .prepare(
          `SELECT c.route, COUNT(*) as count
           FROM classifications c
           JOIN feedback f ON c.feedback_id = f.id
           WHERE f.created_at BETWEEN ? AND ?
           GROUP BY c.route`
        )
        .bind(startDate, endDate),

      this.db
        .prepare(
          `SELECT source, COUNT(*) as count
           FROM feedback
           WHERE created_at BETWEEN ? AND ?
           GROUP BY source`
        )
        .bind(startDate, endDate),

      this.db
        .prepare(
          `SELECT
             AVG(c.urgency) as avg_urgency,
             AVG(c.sentiment) as avg_sentiment,
             AVG(c.impact) as avg_impact,
             AVG(c.actionability) as avg_actionability
           FROM classifications c
           JOIN feedback f ON c.feedback_id = f.id
           WHERE f.created_at BETWEEN ? AND ?`
        )
        .bind(startDate, endDate),
    ]);

    return {
      total: (totals.results[0] as any)?.total || 0,
      by_route: byRoute.results,
      by_source: bySource.results,
      averages: avgScores.results[0],
    };
  }

  // Store PM summary
  async storeSummary(
    periodStart: string,
    periodEnd: string,
    summaryType: string,
    content: string,
    metrics: any
  ): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO summaries (period_start, period_end, summary_type, content, metrics)
         VALUES (?, ?, ?, ?, ?)`
      )
      .bind(periodStart, periodEnd, summaryType, content, JSON.stringify(metrics))
      .run();
  }

  // Get trending signals
  async getTrendingSignals(days: number = 7, limit: number = 10): Promise<any[]> {
    const result = await this.db
      .prepare(
        `SELECT signal_type, signal_value, COUNT(*) as frequency, AVG(confidence) as avg_confidence
         FROM signals s
         JOIN feedback f ON s.feedback_id = f.id
         WHERE f.created_at >= datetime('now', '-' || ? || ' days')
         GROUP BY signal_type, signal_value
         ORDER BY frequency DESC
         LIMIT ?`
      )
      .bind(days, limit)
      .all();

    return result.results;
  }

  // Get feedback by ID
  async getFeedbackById(id: string): Promise<Feedback | null> {
    const result = await this.db
      .prepare(`SELECT * FROM feedback WHERE id = ?`)
      .bind(id)
      .first();

    return result as Feedback | null;
  }
}
