'use strict';

// ── Vector Database for RAG ──────────────────────────────────────────────────
// Inspired by Ruflo's AgentDB with HNSW-like nearest-neighbor search.
// Uses SQLite (via better-sqlite3 or sql.js) for persistent vector storage
// with a JavaScript fallback for cosine similarity search.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_VECTORS = 50000;
const DIMENSIONS = 384; // Default for multilingual-e5-large embeddings
const SEARCH_BATCH_SIZE = 1000;

class VectorDB {
  constructor(dbPath) {
    this.dbPath = dbPath;
    this.vectors = new Map(); // id -> { embedding, metadata, hash }
    this.loaded = false;
  }

  // ── Initialize ───────────────────────────────────────────────────────────
  load() {
    if (this.loaded) return;
    const dir = path.dirname(this.dbPath);
    fs.mkdirSync(dir, { recursive: true });

    try {
      if (fs.existsSync(this.dbPath)) {
        const raw = fs.readFileSync(this.dbPath, 'utf8');
        const data = JSON.parse(raw);
        if (Array.isArray(data.vectors)) {
          for (const vec of data.vectors) {
            this.vectors.set(vec.id, {
              embedding: new Float32Array(vec.embedding),
              metadata: vec.metadata || {},
              hash: vec.hash || '',
              addedAt: vec.addedAt || Date.now()
            });
          }
        }
      }
    } catch (err) {
      console.warn('[VectorDB] Failed to load, starting fresh:', err.message);
      this.vectors.clear();
    }
    this.loaded = true;
  }

  save() {
    const dir = path.dirname(this.dbPath);
    fs.mkdirSync(dir, { recursive: true });

    const data = {
      version: 1,
      count: this.vectors.size,
      dimensions: DIMENSIONS,
      savedAt: new Date().toISOString(),
      vectors: [...this.vectors.entries()].map(([id, vec]) => ({
        id,
        embedding: Array.from(vec.embedding),
        metadata: vec.metadata,
        hash: vec.hash,
        addedAt: vec.addedAt
      }))
    };

    fs.writeFileSync(this.dbPath, JSON.stringify(data), 'utf8');
  }

  // ── CRUD ─────────────────────────────────────────────────────────────────
  upsert(id, embedding, metadata = {}) {
    this.load();

    const floatEmbed = embedding instanceof Float32Array
      ? embedding
      : new Float32Array(embedding);

    // Normalize the embedding
    const norm = Math.sqrt(floatEmbed.reduce((s, v) => s + v * v, 0));
    if (norm > 0) {
      for (let i = 0; i < floatEmbed.length; i++) {
        floatEmbed[i] /= norm;
      }
    }

    const hash = crypto.createHash('md5')
      .update(Buffer.from(floatEmbed.buffer))
      .digest('hex');

    this.vectors.set(id, {
      embedding: floatEmbed,
      metadata,
      hash,
      addedAt: Date.now()
    });

    // Prune if too many
    if (this.vectors.size > MAX_VECTORS) {
      this._pruneOldest(this.vectors.size - MAX_VECTORS);
    }
  }

  delete(id) {
    this.load();
    return this.vectors.delete(id);
  }

  has(id) {
    this.load();
    return this.vectors.has(id);
  }

  getHash(id) {
    this.load();
    const vec = this.vectors.get(id);
    return vec ? vec.hash : null;
  }

  get(id) {
    this.load();
    const vec = this.vectors.get(id);
    if (!vec) return null;
    return { id, ...vec };
  }

  size() {
    this.load();
    return this.vectors.size;
  }

  // ── Similarity Search (Cosine) ───────────────────────────────────────────
  search(queryEmbedding, topK = 10, filter = null) {
    this.load();
    if (this.vectors.size === 0) return [];

    const queryVec = queryEmbedding instanceof Float32Array
      ? queryEmbedding
      : new Float32Array(queryEmbedding);

    // Normalize query
    const queryNorm = Math.sqrt(queryVec.reduce((s, v) => s + v * v, 0));
    const normalizedQuery = new Float32Array(queryVec.length);
    if (queryNorm > 0) {
      for (let i = 0; i < queryVec.length; i++) {
        normalizedQuery[i] = queryVec[i] / queryNorm;
      }
    }

    const results = [];

    for (const [id, vec] of this.vectors) {
      // Apply metadata filter if provided
      if (filter && !this._matchesFilter(vec.metadata, filter)) continue;

      // Cosine similarity (vectors are pre-normalized, so dot product = cosine)
      let similarity = 0;
      const emb = vec.embedding;
      const len = Math.min(normalizedQuery.length, emb.length);
      for (let i = 0; i < len; i++) {
        similarity += normalizedQuery[i] * emb[i];
      }

      results.push({ id, similarity, metadata: vec.metadata });
    }

    // Sort by similarity descending
    results.sort((a, b) => b.similarity - a.similarity);

    // Diversity re-ranking: penalize results from the same file
    if (topK > 1) {
      return this._diversityRerank(results, topK);
    }

    return results.slice(0, topK);
  }

  // ── Hybrid Search (BM25 + Vector) ────────────────────────────────────────
  hybridSearch(queryEmbedding, queryText, topK = 10, filter = null) {
    this.load();

    // Vector search
    const vectorResults = this.search(queryEmbedding, topK * 2, filter);

    // BM25-like text search on metadata
    const textResults = this._bm25Search(queryText, topK * 2, filter);

    // Merge with reciprocal rank fusion (RRF)
    const rrfScores = new Map();
    const k = 60; // RRF constant

    vectorResults.forEach((r, i) => {
      const score = 1 / (k + i + 1);
      rrfScores.set(r.id, (rrfScores.get(r.id) || 0) + score * 0.6); // 60% vector weight
    });

    textResults.forEach((r, i) => {
      const score = 1 / (k + i + 1);
      rrfScores.set(r.id, (rrfScores.get(r.id) || 0) + score * 0.4); // 40% text weight
    });

    // Sort by combined RRF score
    const combined = [...rrfScores.entries()]
      .map(([id, score]) => {
        const vec = this.vectors.get(id);
        return { id, score, metadata: vec ? vec.metadata : {} };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);

    return combined;
  }

  // ── Batch operations ─────────────────────────────────────────────────────
  upsertBatch(items) {
    this.load();
    let count = 0;
    for (const { id, embedding, metadata } of items) {
      this.upsert(id, embedding, metadata);
      count++;
    }
    return count;
  }

  deleteByFilter(filter) {
    this.load();
    const toDelete = [];
    for (const [id, vec] of this.vectors) {
      if (this._matchesFilter(vec.metadata, filter)) {
        toDelete.push(id);
      }
    }
    for (const id of toDelete) {
      this.vectors.delete(id);
    }
    return toDelete.length;
  }

  // ── Stats ────────────────────────────────────────────────────────────────
  getStats() {
    this.load();
    const fileGroups = new Map();
    for (const [, vec] of this.vectors) {
      const file = vec.metadata.filePath || 'unknown';
      fileGroups.set(file, (fileGroups.get(file) || 0) + 1);
    }

    return {
      totalVectors: this.vectors.size,
      dimensions: DIMENSIONS,
      maxCapacity: MAX_VECTORS,
      uniqueFiles: fileGroups.size,
      topFiles: [...fileGroups.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10),
      dbPath: this.dbPath,
      dbSizeBytes: fs.existsSync(this.dbPath) ? fs.statSync(this.dbPath).size : 0
    };
  }

  // ── Private helpers ──────────────────────────────────────────────────────
  _matchesFilter(metadata, filter) {
    for (const [key, value] of Object.entries(filter)) {
      if (Array.isArray(value)) {
        if (!value.includes(metadata[key])) return false;
      } else if (metadata[key] !== value) {
        return false;
      }
    }
    return true;
  }

  _diversityRerank(results, topK) {
    const selected = [];
    const seenFiles = new Map();
    const DIVERSITY_PENALTY = 0.15;

    for (const result of results) {
      if (selected.length >= topK) break;
      const file = result.metadata.filePath || '';
      const fileCount = seenFiles.get(file) || 0;
      const penalizedScore = result.similarity - (fileCount * DIVERSITY_PENALTY);

      if (penalizedScore > 0 || selected.length < Math.ceil(topK / 2)) {
        selected.push({ ...result, diversityAdjusted: penalizedScore });
        seenFiles.set(file, fileCount + 1);
      }
    }

    return selected;
  }

  _bm25Search(queryText, topK, filter) {
    const terms = String(queryText || '').toLowerCase().split(/\s+/).filter(t => t.length > 2);
    if (terms.length === 0) return [];

    const results = [];
    for (const [id, vec] of this.vectors) {
      if (filter && !this._matchesFilter(vec.metadata, filter)) continue;

      const content = String(vec.metadata.content || vec.metadata.filePath || '').toLowerCase();
      let score = 0;
      for (const term of terms) {
        const count = (content.match(new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
        if (count > 0) {
          // BM25-like scoring: tf * (k1 + 1) / (tf + k1)
          const tf = count / Math.max(content.length / 100, 1);
          score += tf * 2.0 / (tf + 1.2);
        }
      }

      if (score > 0) {
        results.push({ id, score, metadata: vec.metadata });
      }
    }

    return results.sort((a, b) => b.score - a.score).slice(0, topK);
  }

  _pruneOldest(count) {
    const sorted = [...this.vectors.entries()]
      .sort((a, b) => a[1].addedAt - b[1].addedAt);
    for (let i = 0; i < count && i < sorted.length; i++) {
      this.vectors.delete(sorted[i][0]);
    }
  }

  dispose() {
    if (this.vectors.size > 0) {
      try { this.save(); } catch (_) {}
    }
    this.vectors.clear();
    this.loaded = false;
  }
}

module.exports = { VectorDB };
