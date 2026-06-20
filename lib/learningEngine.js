'use strict';

// ── Self-Learning Module ─────────────────────────────────────────────────────
// Inspired by Ruflo's SONA (Self-Organizing Neural Architecture) and
// ReasoningBank. Records successful tool sequences (trajectories) and
// retrieves them for similar future tasks.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_TRAJECTORIES = 500;
const MAX_TRAJECTORY_STEPS = 50;
const DECAY_FACTOR = 0.95; // Score decays each day
const MIN_SCORE_THRESHOLD = 0.1;

class LearningEngine {
  constructor(stateRoot) {
    this.stateRoot = stateRoot;
    this.learningDir = path.join(stateRoot, 'agent-runtime', 'learning');
    this.trajectoriesPath = path.join(this.learningDir, 'trajectories.json');
    this.patternsPath = path.join(this.learningDir, 'patterns.json');
    this.statsPath = path.join(this.learningDir, 'stats.json');
    this.trajectories = [];
    this.patterns = {};
    this.stats = { totalRecorded: 0, totalSuccesses: 0, totalFailures: 0, lastUpdated: null };
    this._loaded = false;
  }

  _ensureDir() {
    fs.mkdirSync(this.learningDir, { recursive: true });
  }

  load() {
    if (this._loaded) return;
    this._ensureDir();
    try {
      if (fs.existsSync(this.trajectoriesPath)) {
        this.trajectories = JSON.parse(fs.readFileSync(this.trajectoriesPath, 'utf8'));
      }
    } catch (_) { this.trajectories = []; }
    try {
      if (fs.existsSync(this.patternsPath)) {
        this.patterns = JSON.parse(fs.readFileSync(this.patternsPath, 'utf8'));
      }
    } catch (_) { this.patterns = {}; }
    try {
      if (fs.existsSync(this.statsPath)) {
        this.stats = JSON.parse(fs.readFileSync(this.statsPath, 'utf8'));
      }
    } catch (_) {}
    this._loaded = true;
  }

  save() {
    this._ensureDir();
    this.stats.lastUpdated = new Date().toISOString();
    fs.writeFileSync(this.trajectoriesPath, JSON.stringify(this.trajectories, null, 2), 'utf8');
    fs.writeFileSync(this.patternsPath, JSON.stringify(this.patterns, null, 2), 'utf8');
    fs.writeFileSync(this.statsPath, JSON.stringify(this.stats, null, 2), 'utf8');
  }

  // ── Record a completed task trajectory ───────────────────────────────────
  recordTrajectory(taskInfo) {
    this.load();
    const { taskId, title, prompt, agentType, toolSequence, outcome, patchAccepted, duration } = taskInfo;

    // Compute success score
    let score = 0;
    if (outcome === 'completed') {
      if (patchAccepted === true) score = 1.0;
      else if (patchAccepted === false) score = 0.0;
      else score = 0.5; // Completed but no patch review
    } else if (outcome === 'failed') {
      score = -0.5;
    }

    const trajectory = {
      id: `traj_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
      taskId,
      title: String(title || '').slice(0, 200),
      promptHash: crypto.createHash('sha256').update(String(prompt || '')).digest('hex').slice(0, 16),
      promptKeywords: this._extractKeywords(prompt),
      agentType: agentType || 'general-purpose',
      toolSequence: (toolSequence || []).slice(0, MAX_TRAJECTORY_STEPS).map(t => ({
        tool: t.tool || t.name,
        ok: t.ok !== false,
        durationMs: t.durationMs || 0
      })),
      toolCount: (toolSequence || []).length,
      outcome,
      score,
      patchAccepted,
      duration: duration || 0,
      recordedAt: new Date().toISOString()
    };

    this.trajectories.push(trajectory);
    this.stats.totalRecorded++;
    if (score > 0) this.stats.totalSuccesses++;
    if (score < 0) this.stats.totalFailures++;

    // Update patterns
    this._updatePatterns(trajectory);

    // Prune old low-score trajectories
    this._prune();
    this.save();

    return trajectory;
  }

  // ── Find similar past trajectories ───────────────────────────────────────
  findSimilar(prompt, agentType, topK = 5) {
    this.load();
    const queryKeywords = this._extractKeywords(prompt);
    if (queryKeywords.length === 0) return [];

    const scored = this.trajectories
      .filter(t => t.score > MIN_SCORE_THRESHOLD)
      .map(t => {
        // Keyword overlap scoring
        const overlap = t.promptKeywords.filter(k => queryKeywords.includes(k)).length;
        const keywordScore = queryKeywords.length > 0 ? overlap / queryKeywords.length : 0;

        // Agent type match bonus
        const typeBonus = (agentType && t.agentType === agentType) ? 0.2 : 0;

        // Recency decay
        const ageMs = Date.now() - new Date(t.recordedAt).getTime();
        const ageDays = ageMs / (1000 * 60 * 60 * 24);
        const recencyFactor = Math.pow(DECAY_FACTOR, ageDays);

        // Combined score
        const combinedScore = (keywordScore * 0.5 + t.score * 0.3 + typeBonus) * recencyFactor;

        return { trajectory: t, combinedScore };
      })
      .filter(s => s.combinedScore > 0.1)
      .sort((a, b) => b.combinedScore - a.combinedScore)
      .slice(0, topK);

    return scored.map(s => ({
      ...s.trajectory,
      relevanceScore: Math.round(s.combinedScore * 100) / 100
    }));
  }

  // ── Get recommended tool sequence for a task ─────────────────────────────
  recommendToolSequence(prompt, agentType) {
    const similar = this.findSimilar(prompt, agentType, 3);
    if (similar.length === 0) return null;

    // Find the most common tool sequence pattern among top matches
    const best = similar[0];
    return {
      confidence: best.relevanceScore,
      suggestedTools: best.toolSequence.filter(t => t.ok).map(t => t.tool),
      basedOn: {
        trajectoryId: best.id,
        title: best.title,
        outcome: best.outcome,
        score: best.score
      }
    };
  }

  // ── Reinforce/penalize a trajectory ──────────────────────────────────────
  reinforceTrajectory(trajectoryId, delta) {
    this.load();
    const traj = this.trajectories.find(t => t.id === trajectoryId);
    if (traj) {
      traj.score = Math.max(-1, Math.min(1, traj.score + delta));
      this.save();
    }
  }

  // ── Get learning statistics ──────────────────────────────────────────────
  getStats() {
    this.load();
    const successRate = this.stats.totalRecorded > 0
      ? Math.round((this.stats.totalSuccesses / this.stats.totalRecorded) * 100)
      : 0;

    const toolFrequency = {};
    for (const traj of this.trajectories) {
      for (const step of traj.toolSequence || []) {
        toolFrequency[step.tool] = (toolFrequency[step.tool] || 0) + 1;
      }
    }

    const agentFrequency = {};
    for (const traj of this.trajectories) {
      agentFrequency[traj.agentType] = (agentFrequency[traj.agentType] || 0) + 1;
    }

    return {
      ...this.stats,
      trajectoryCount: this.trajectories.length,
      successRate: `${successRate}%`,
      topTools: Object.entries(toolFrequency).sort((a, b) => b[1] - a[1]).slice(0, 10),
      topAgents: Object.entries(agentFrequency).sort((a, b) => b[1] - a[1]).slice(0, 5)
    };
  }

  // ── Build context for agent system prompt ────────────────────────────────
  buildLearningContext(prompt, agentType) {
    const similar = this.findSimilar(prompt, agentType, 3);
    if (similar.length === 0) return '';

    const lines = ['[Learning context from past successful tasks]'];
    for (const traj of similar) {
      const tools = traj.toolSequence.filter(t => t.ok).map(t => t.tool).join(' → ');
      lines.push(`- "${traj.title}" (score: ${traj.score}, tools: ${tools})`);
    }
    lines.push('Consider these successful patterns when planning your approach.');
    return lines.join('\n');
  }

  // ── Private helpers ──────────────────────────────────────────────────────
  _extractKeywords(text) {
    const value = String(text || '').toLowerCase();
    // Remove common stop words and extract meaningful tokens
    const stopWords = new Set([
      'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
      'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
      'should', 'may', 'might', 'shall', 'can', 'to', 'of', 'in', 'for',
      'on', 'with', 'at', 'by', 'from', 'as', 'into', 'through', 'during',
      'before', 'after', 'above', 'below', 'and', 'but', 'or', 'not',
      'this', 'that', 'these', 'those', 'it', 'its', 'my', 'your',
      'le', 'la', 'les', 'un', 'une', 'des', 'du', 'de', 'et', 'ou',
      'je', 'tu', 'il', 'elle', 'nous', 'vous', 'ils', 'dans', 'pour',
      'sur', 'avec', 'par', 'ce', 'cette', 'qui', 'que', 'est', 'sont'
    ]);
    return value
      .replace(/[^a-z0-9àâäéèêëïîôùûüÿç_-]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 2 && !stopWords.has(w))
      .slice(0, 20);
  }

  _updatePatterns(trajectory) {
    const key = trajectory.agentType;
    if (!this.patterns[key]) {
      this.patterns[key] = { totalTasks: 0, successfulTools: {}, failedTools: {} };
    }
    const pattern = this.patterns[key];
    pattern.totalTasks++;

    for (const step of trajectory.toolSequence) {
      const bucket = step.ok ? pattern.successfulTools : pattern.failedTools;
      bucket[step.tool] = (bucket[step.tool] || 0) + 1;
    }
  }

  _prune() {
    if (this.trajectories.length <= MAX_TRAJECTORIES) return;
    // Sort by score * recency, keep best
    this.trajectories.sort((a, b) => {
      const ageA = Date.now() - new Date(a.recordedAt).getTime();
      const ageB = Date.now() - new Date(b.recordedAt).getTime();
      const scoreA = a.score * Math.pow(DECAY_FACTOR, ageA / 86400000);
      const scoreB = b.score * Math.pow(DECAY_FACTOR, ageB / 86400000);
      return scoreB - scoreA;
    });
    this.trajectories = this.trajectories.slice(0, MAX_TRAJECTORIES);
  }
}

module.exports = { LearningEngine };
