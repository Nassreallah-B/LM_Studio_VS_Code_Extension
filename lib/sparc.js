'use strict';

// ── SPARC Methodology ────────────────────────────────────────────────────────
// Inspired by Ruflo's SPARC framework.
// Sense → Plan → Act → Reflect → Correct
// Provides a structured, self-correcting workflow for agent orchestration.

class SPARCWorkflow {
  constructor(options = {}) {
    this.maxCorrections = options.maxCorrections || 3;
    this.reflectionThreshold = options.reflectionThreshold || 0.7; // quality score threshold
    this.log = [];
    this.state = 'idle'; // idle | sensing | planning | acting | reflecting | correcting | completed | failed
    this.currentPhase = null;
    this.correctionCount = 0;
    this.results = {};
  }

  // ── SENSE: Gather context ──────────────────────────────────────────────
  // Analyzes the request + workspace + memory to build a complete picture.
  async sense(context) {
    this.state = 'sensing';
    this.currentPhase = 'sense';
    const startTime = Date.now();

    const senseResult = {
      phase: 'sense',
      input: {
        prompt: context.prompt || '',
        workspaceFiles: context.workspaceFiles || [],
        openFiles: context.openFiles || [],
        recentErrors: context.recentErrors || [],
        agentMemory: context.agentMemory || {}
      },
      analysis: {
        // Detect what domains are involved
        domains: this._detectDomains(context.prompt || ''),
        // Estimate complexity
        complexity: this._estimateComplexity(context),
        // Identify risks
        risks: this._identifyRisks(context),
        // Check for similar past work
        priorPatterns: context.priorPatterns || []
      },
      timestamp: Date.now(),
      durationMs: 0
    };

    senseResult.durationMs = Date.now() - startTime;
    this.results.sense = senseResult;
    this._log('sense', 'completed', senseResult.analysis);
    return senseResult;
  }

  // ── PLAN: Decompose into subtasks ──────────────────────────────────────
  // Creates an execution plan with agent assignments and dependencies.
  async plan(senseResult, options = {}) {
    this.state = 'planning';
    this.currentPhase = 'plan';
    const startTime = Date.now();

    const analysis = senseResult.analysis;
    const subtasks = [];

    // Create subtasks based on detected domains
    for (const domain of analysis.domains) {
      subtasks.push({
        id: `task_${subtasks.length + 1}`,
        domain: domain.name,
        agentType: domain.suggestedAgent,
        description: `Handle ${domain.name} aspects: ${domain.keywords.join(', ')}`,
        priority: domain.priority || 'normal',
        stepBudget: this._computeStepBudget(analysis.complexity, domain),
        dependencies: [],
        status: 'pending'
      });
    }

    // Add dependency chains (security after DB, verification after all)
    const securityTask = subtasks.find(t => t.agentType === 'security-sentinel');
    const dbTask = subtasks.find(t => t.agentType === 'database-expert');
    if (securityTask && dbTask) {
      securityTask.dependencies.push(dbTask.id);
    }

    const planResult = {
      phase: 'plan',
      subtasks,
      topology: subtasks.length > 2 ? 'hub-spoke' : 'pipeline',
      estimatedSteps: subtasks.reduce((sum, t) => sum + t.stepBudget, 0),
      riskMitigations: analysis.risks.map(r => ({
        risk: r,
        mitigation: this._suggestMitigation(r)
      })),
      timestamp: Date.now(),
      durationMs: Date.now() - startTime
    };

    this.results.plan = planResult;
    this._log('plan', 'completed', { subtaskCount: subtasks.length, topology: planResult.topology });
    return planResult;
  }

  // ── ACT: Execute the plan ──────────────────────────────────────────────
  // Delegates subtasks to agents via the provided executor function.
  async act(planResult, executor) {
    this.state = 'acting';
    this.currentPhase = 'act';
    const startTime = Date.now();

    const results = [];
    for (const subtask of planResult.subtasks) {
      // Check dependencies
      const depsMet = subtask.dependencies.every(depId => {
        const dep = results.find(r => r.taskId === depId);
        return dep && dep.status === 'completed';
      });

      if (!depsMet) {
        results.push({ taskId: subtask.id, status: 'skipped', reason: 'dependencies not met' });
        continue;
      }

      try {
        const output = await executor(subtask);
        results.push({
          taskId: subtask.id,
          agentType: subtask.agentType,
          status: 'completed',
          output,
          durationMs: Date.now() - startTime
        });
      } catch (err) {
        results.push({
          taskId: subtask.id,
          agentType: subtask.agentType,
          status: 'failed',
          error: err.message,
          durationMs: Date.now() - startTime
        });
      }
    }

    const actResult = {
      phase: 'act',
      results,
      completedCount: results.filter(r => r.status === 'completed').length,
      failedCount: results.filter(r => r.status === 'failed').length,
      timestamp: Date.now(),
      durationMs: Date.now() - startTime
    };

    this.results.act = actResult;
    this._log('act', 'completed', { completed: actResult.completedCount, failed: actResult.failedCount });
    return actResult;
  }

  // ── REFLECT: Evaluate results ──────────────────────────────────────────
  // Assesses the quality and completeness of the execution.
  async reflect(actResult) {
    this.state = 'reflecting';
    this.currentPhase = 'reflect';

    const totalTasks = actResult.results.length;
    const completed = actResult.completedCount;
    const failed = actResult.failedCount;

    // Quality score: 0-1
    const successRate = totalTasks > 0 ? completed / totalTasks : 0;
    const qualityScore = successRate;

    const issues = [];

    // Check for failures
    for (const result of actResult.results) {
      if (result.status === 'failed') {
        issues.push({
          type: 'task_failure',
          taskId: result.taskId,
          agentType: result.agentType,
          error: result.error,
          severity: 'high'
        });
      }
      if (result.status === 'skipped') {
        issues.push({
          type: 'task_skipped',
          taskId: result.taskId,
          reason: result.reason,
          severity: 'medium'
        });
      }
    }

    const needsCorrection = qualityScore < this.reflectionThreshold || issues.some(i => i.severity === 'high');

    const reflectResult = {
      phase: 'reflect',
      qualityScore,
      successRate,
      issues,
      needsCorrection,
      verdict: needsCorrection ? 'NEEDS_CORRECTION' : 'PASS',
      timestamp: Date.now()
    };

    this.results.reflect = reflectResult;
    this._log('reflect', reflectResult.verdict, { qualityScore, issueCount: issues.length });
    return reflectResult;
  }

  // ── CORRECT: Fix issues and retry ──────────────────────────────────────
  // Re-plans and re-executes failed subtasks.
  async correct(reflectResult, planResult, executor) {
    this.state = 'correcting';
    this.currentPhase = 'correct';
    this.correctionCount += 1;

    if (this.correctionCount > this.maxCorrections) {
      this.state = 'failed';
      this._log('correct', 'max_corrections_exceeded', { count: this.correctionCount });
      return { phase: 'correct', status: 'max_corrections_exceeded', correctionCount: this.correctionCount };
    }

    // Identify failed tasks to retry
    const failedTaskIds = reflectResult.issues
      .filter(i => i.type === 'task_failure')
      .map(i => i.taskId);

    const retryTasks = planResult.subtasks.filter(t => failedTaskIds.includes(t.id));

    if (retryTasks.length === 0) {
      this.state = 'completed';
      return { phase: 'correct', status: 'nothing_to_correct' };
    }

    // Increase step budget for retries
    for (const task of retryTasks) {
      task.stepBudget = Math.min(task.stepBudget * 1.5, 50);
      task.dependencies = []; // Clear deps for retry
    }

    // Re-execute
    const retryPlan = { ...planResult, subtasks: retryTasks };
    const retryActResult = await this.act(retryPlan, executor);
    const retryReflect = await this.reflect(retryActResult);

    if (retryReflect.needsCorrection) {
      return this.correct(retryReflect, retryPlan, executor);
    }

    this.state = 'completed';
    this._log('correct', 'resolved', { retriedCount: retryTasks.length, correctionRound: this.correctionCount });
    return { phase: 'correct', status: 'resolved', correctionCount: this.correctionCount };
  }

  // ── Full SPARC cycle ───────────────────────────────────────────────────
  async run(context, executor) {
    try {
      const senseResult = await this.sense(context);
      const planResult = await this.plan(senseResult);
      const actResult = await this.act(planResult, executor);
      const reflectResult = await this.reflect(actResult);

      if (reflectResult.needsCorrection) {
        await this.correct(reflectResult, planResult, executor);
      } else {
        this.state = 'completed';
      }

      return {
        state: this.state,
        phases: this.results,
        log: this.log,
        correctionCount: this.correctionCount
      };
    } catch (err) {
      this.state = 'failed';
      this._log('sparc', 'fatal_error', { error: err.message });
      return { state: 'failed', error: err.message, log: this.log };
    }
  }

  // ── Internal helpers ───────────────────────────────────────────────────
  _detectDomains(prompt) {
    const promptLower = prompt.toLowerCase();
    const domainMap = {
      database: { keywords: ['sql', 'database', 'migration', 'rls', 'schema', 'table', 'query', 'supabase', 'postgresql'], agent: 'database-expert', priority: 'high' },
      security: { keywords: ['security', 'vulnerability', 'xss', 'csrf', 'injection', 'auth', 'permission', 'owasp', 'rls'], agent: 'security-sentinel', priority: 'critical' },
      ui: { keywords: ['css', 'ui', 'layout', 'rtl', 'responsive', 'design', 'component', 'style', 'tailwind', 'animation'], agent: 'rtl-ui-auditor', priority: 'normal' },
      api: { keywords: ['api', 'endpoint', 'rest', 'webhook', 'route', 'middleware', 'edge function'], agent: 'general-purpose', priority: 'normal' },
      testing: { keywords: ['test', 'coverage', 'vitest', 'playwright', 'e2e', 'unit test'], agent: 'verification', priority: 'normal' },
      performance: { keywords: ['performance', 'optimize', 'slow', 'latency', 'bundle', 'lazy', 'cache'], agent: 'performance-monitor', priority: 'normal' },
      refactoring: { keywords: ['refactor', 'cleanup', 'technical debt', 'extract', 'split', 'modularize'], agent: 'refactoring-expert', priority: 'normal' }
    };

    const detected = [];
    for (const [name, config] of Object.entries(domainMap)) {
      const matches = config.keywords.filter(k => promptLower.includes(k));
      if (matches.length > 0) {
        detected.push({
          name,
          keywords: matches,
          suggestedAgent: config.agent,
          priority: config.priority,
          score: matches.length
        });
      }
    }

    if (detected.length === 0) {
      detected.push({ name: 'general', keywords: [], suggestedAgent: 'general-purpose', priority: 'normal', score: 0 });
    }

    return detected.sort((a, b) => b.score - a.score);
  }

  _estimateComplexity(context) {
    const prompt = context.prompt || '';
    const fileCount = (context.workspaceFiles || []).length;

    if (prompt.length > 500 || fileCount > 20) return 'high';
    if (prompt.length > 200 || fileCount > 5) return 'medium';
    return 'low';
  }

  _identifyRisks(context) {
    const risks = [];
    const prompt = (context.prompt || '').toLowerCase();

    if (prompt.includes('delete') || prompt.includes('remove') || prompt.includes('drop')) {
      risks.push('destructive_operation');
    }
    if (prompt.includes('migration') || prompt.includes('migrate') || prompt.includes('schema')) {
      risks.push('schema_change');
    }
    if (prompt.includes('deploy') || prompt.includes('production')) {
      risks.push('production_impact');
    }
    if (prompt.includes('auth') || prompt.includes('permission') || prompt.includes('rls')) {
      risks.push('security_sensitive');
    }

    return risks;
  }

  _suggestMitigation(risk) {
    const mitigations = {
      destructive_operation: 'Require explicit user confirmation before any delete/drop operation.',
      schema_change: 'Create a rollback migration alongside the new migration.',
      production_impact: 'Test in staging environment first. Require security-sentinel PASS verdict.',
      security_sensitive: 'Mandatory security-sentinel audit with PASS verdict before merge.'
    };
    return mitigations[risk] || 'Review carefully before proceeding.';
  }

  _computeStepBudget(complexity, domain) {
    const base = { low: 8, medium: 15, high: 25 }[complexity] || 15;
    const multiplier = domain.priority === 'critical' ? 1.5 : domain.priority === 'high' ? 1.2 : 1;
    return Math.round(base * multiplier);
  }

  _log(phase, status, details = {}) {
    this.log.push({
      phase,
      status,
      details,
      timestamp: Date.now()
    });
  }

  getStatus() {
    return {
      state: this.state,
      currentPhase: this.currentPhase,
      correctionCount: this.correctionCount,
      logLength: this.log.length,
      phases: Object.keys(this.results)
    };
  }
}

module.exports = { SPARCWorkflow };
